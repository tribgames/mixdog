import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createBrowserBridgeForward, forwardBrowserCommand } from './bridge-forward.ts';

function fakeCore(handlers) {
  const calls = [];
  const request = async (method, params) => {
    calls.push({ method, params });
    return handlers[method](params);
  };
  return { calls, request };
}

async function post(dataDirectory, body) {
  const discovery = JSON.parse(readFileSync(join(dataDirectory, 'browser-bridge.json'), 'utf8'));
  return fetch(`http://127.0.0.1:${discovery.port}/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withBridge(handlers, run) {
  const dataDirectory = mkdtempSync(join(tmpdir(), 'mixdog-bridge-forward-'));
  const core = fakeCore(handlers);
  const events = [];
  const { promise: ready, resolve } = Promise.withResolvers();
  const bridge = createBrowserBridgeForward({
    request: core.request,
    dataDirectory,
    redactError: String,
    lifecycle: {
      begin: () => events.push('begin'),
      ready: () => {
        events.push('ready');
        resolve();
      },
      inactive: () => events.push('inactive'),
      end: () => events.push('end'),
    },
  });
  try {
    bridge.start();
    await ready;
    await run({ core, events, dataDirectory });
  } finally {
    await bridge.stop();
    rmSync(dataDirectory, { recursive: true, force: true });
  }
}

test('a command is run by the core and its value, timing and failure reach the runtime unchanged', async () => {
  const value = { text: 'ok', outcome: 'blocked', timing: { commandMs: 3 } };
  await withBridge(
    {
      'browser/bridge/run': ({ command }) =>
        command.action === 'fail'
          ? { ok: false, error: 'boom', timing: { commandMs: 9 } }
          : command.action === 'busy'
            ? { ok: false, error: 'too many concurrent browser commands', status: 429 }
            : { ok: true, value },
    },
    async ({ core, events, dataDirectory }) => {
      const ok = await post(dataDirectory, { action: 'read', session_id: 's1', turn_id: 2 });
      assert.deepEqual(await ok.json(), { ok: true, value });
      assert.equal(core.calls[0].method, 'browser/bridge/run');
      assert.deepEqual(core.calls[0].params.command, { action: 'read', session_id: 's1', turn_id: 2 });
      assert.match(core.calls[0].params.signalId, /^browser-bridge-/);

      const failed = await post(dataDirectory, { action: 'fail' });
      assert.equal(failed.status, 200);
      assert.deepEqual(await failed.json(), { ok: false, error: 'boom', timing: { commandMs: 9 } });

      const busy = await post(dataDirectory, { action: 'busy' });
      assert.equal(busy.status, 429);
      assert.match((await busy.json()).error, /too many concurrent/);
      assert.deepEqual(events, ['begin', 'ready']);
    }
  );
});

test('begin_turn and finish_turn go to the turn method; a bad cleanup context is refused before the core', async () => {
  await withBridge(
    { 'browser/bridge/turn': () => ({ ok: true, value: { text: 'Browser turn started.' } }) },
    async ({ core, dataDirectory }) => {
      const began = await post(dataDirectory, { action: 'begin_turn', session_id: 's1', turn_id: 4 });
      assert.deepEqual(await began.json(), { ok: true, value: { text: 'Browser turn started.' } });
      await post(dataDirectory, { action: 'finish_turn', session_id: 's1', turn_id: 4, aborted: true });
      assert.deepEqual(core.calls.map((call) => call.params), [
        { phase: 'begin', sessionId: 's1', turnId: 4 },
        { phase: 'finish', sessionId: 's1', turnId: 4, aborted: true },
      ]);
      for (const bad of [{ turn_id: 4 }, { session_id: 's1', turn_id: 0 }, { session_id: 's1', turn_id: 1.5 }, { session_id: 's1', turn_id: 1, url: 'x' }]) {
        const reply = await (await post(dataDirectory, { action: 'finish_turn', ...bad })).json();
        assert.equal(reply.error, 'Invalid browser task cleanup context.');
      }
      assert.equal(core.calls.length, 2);
    }
  );
});

test('a dropped caller aborts the core call by its signal id', async () => {
  const { calls, request } = fakeCore({
    'browser/bridge/run': () => new Promise(() => undefined),
    'browser/bridge/abort': () => ({ cancelled: 1 }),
  });
  const controller = new AbortController();
  const running = forwardBrowserCommand(request, { action: 'read' }, controller.signal);
  controller.abort(new Error('browser bridge client disconnected'));
  await assert.rejects(running, /client disconnected/);
  assert.equal(calls[1].method, 'browser/bridge/abort');
  assert.equal(calls[1].params.signalId, calls[0].params.signalId);
});

test('an unreachable core answers the runtime with its reason', async () => {
  const request = async () => {
    throw new Error('core is not connected');
  };
  await assert.rejects(forwardBrowserCommand(request, { action: 'read' }, new AbortController().signal), /core is not connected/);
});
