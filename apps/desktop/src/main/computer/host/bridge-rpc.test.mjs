import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createBridgeServer } from './bridge-server.ts';
import {
  answerAdmittedCommand,
  CAPACITY_REFUSAL,
  createBridgeRequestHandler,
} from './bridge-server-request.ts';
import { createBridgeServerState } from './bridge-server-contract.ts';

// The host protocol's `host/computer/capture` runs the real dispatch under the HTTP bridge's own request handling:
// these hold a capture on a gate (no timing) and look at what the bridge does around it.
const CAPTURE = { action: 'capture', screen: 0, session_id: 's' };

function heldHost() {
  const started = [];
  const aborted = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  return {
    started,
    aborted,
    release: () => release(),
    host: {
      powerShellBySession: new Map(),
      elevatedSessionIds: () => [],
      abortComputerSession: async (command) => {
        aborted.push(command);
        return { text: 'aborted' };
      },
      executeSerialized: async (command) => {
        started.push(command);
        await gate;
        return { text: 'frame' };
      },
      reapIdleSessionWorkers: () => {},
      dataDirectory: () => process.cwd(),
      isBridgeWanted: () => false,
      isDisposed: () => false,
      diagnose: () => {},
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('an abandoned capture ends its session as a dropped HTTP caller did, and a finished one does not', async () => {
  const held = heldHost();
  const answer = createBridgeServer(held.host).answerCommand;
  const gone = new AbortController();
  const abandoned = answer(CAPTURE, gone.signal);
  await settle();
  assert.equal(held.started.length, 1);
  gone.abort();
  await settle();
  assert.deepEqual(held.aborted, [CAPTURE]);
  held.release();
  await abandoned;

  const finished = heldHost();
  finished.release();
  const kept = new AbortController();
  assert.deepEqual(await createBridgeServer(finished.host).answerCommand(CAPTURE, kept.signal), {
    ok: true,
    value: { text: 'frame' },
  });
  kept.abort();
  await settle();
  assert.deepEqual(finished.aborted, []);
});

function httpRequest(command) {
  const request = Readable.from([Buffer.from(JSON.stringify(command))]);
  request.method = 'POST';
  request.url = '/command';
  request.headers = { authorization: 'Bearer t' };
  return request;
}

test('the capture request and the HTTP command spend one allowance of 32 and are refused alike', async () => {
  const held = heldHost();
  const state = createBridgeServerState();
  const replies = new Map();
  const handle = createBridgeRequestHandler(
    {
      host: held.host,
      state,
      respond: (response, status, body) => {
        response.writableEnded = true;
        replies.get(response)?.({ status, body });
      },
    },
    't',
    1
  );
  const http = () => {
    const response = new EventEmitter();
    response.writableEnded = false;
    const answered = new Promise((resolve) => replies.set(response, resolve));
    handle(httpRequest(CAPTURE), response);
    return answered;
  };
  const signal = new AbortController().signal;
  const rpc = [];
  for (let at = 0; at < 31; at++) rpc.push(answerAdmittedCommand(held.host, state, CAPTURE, signal));
  const first = http();
  await settle();
  assert.equal(state.activeRequests, 32);

  // Saturated: the host protocol is refused as HTTP is, and neither dispatches.
  assert.equal(await answerAdmittedCommand(held.host, state, CAPTURE, signal), null);
  assert.deepEqual(await http(), { status: 429, body: { ok: false, error: CAPACITY_REFUSAL } });
  const bridge = createBridgeServer(held.host);
  assert.equal(held.started.length, 32);

  held.release();
  await Promise.all([...rpc, first]);
  assert.equal(state.activeRequests, 0);
  assert.deepEqual(await bridge.answerCommand(CAPTURE, signal), { ok: true, value: { text: 'frame' } });
});

test('the host protocol answers a spent allowance as a failed request naming the refusal', async () => {
  const held = heldHost();
  const answer = createBridgeServer(held.host).answerCommand;
  const signal = new AbortController().signal;
  const running = Array.from({ length: 32 }, () => answer(CAPTURE, signal));
  await settle();
  assert.deepEqual(await answer(CAPTURE, signal), { ok: false, error: CAPACITY_REFUSAL });
  assert.equal(held.started.length, 32);
  held.release();
  await Promise.all(running);
});
