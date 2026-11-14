// A browser command through the product's own pieces: the client library over a scripted core socket, the desktop's protocol
// connection, its host connection and the browser command host. The core ends a command it stopped waiting for (a cancelled or
// timed-out call, an ended run) with `serverRequest/resolved`, which aborts the running command here and sends no answer; an
// answered command ends with its answer. Neither is held in the client's pending set, which the approval cards are read from.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect } from '../../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../../packages/protocol-client/src/mock.ts';
import { createBrowserCommandHost } from '../host/browser-command.ts';
import { createProtocolConnection } from './connection.ts';
import { createHostConnection, HOST_METHOD_NOT_FOUND } from './host-connection.ts';

const options = JSON.parse(
  readFileSync(new URL('../../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
const DEADLINE_MS = 10_000;

const within = (promise, what) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${DEADLINE_MS} ms awaiting ${what}`)), DEADLINE_MS);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
const turns = async (count = 20) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};
const command = (id, action) => ({ id, method: 'host/browser/command', params: { threadId: 't1', action, input: {} } });
const resolved = (requestId) => ({ method: 'serverRequest/resolved', params: { threadId: '', requestId, resolution: { kind: 'cancelled', at: 1 } } });

/** The scripted core's side of the handshake (`instance` is its serverInstanceId) and the app subscription. */
async function handshake(conn, instance = 's1') {
  for (;;) {
    const frame = JSON.parse(await within(conn.nextSent(), 'the handshake'));
    if (frame.method === 'initialize') conn.serverSend({ id: frame.id, result: { ...options.initializeResult, serverInstanceId: instance } });
    if (frame.method === 'app/subscribe') {
      conn.serverSend({ id: frame.id, result: { subscription: { id: 'as', mode: 'snapshot', epoch: `ae-${instance}`, startSeq: 2 } } });
      conn.serverSend({ method: 'app/snapshot', params: { sections: [] }, feed: { id: 'app', epoch: `ae-${instance}`, seq: 1 } });
      return;
    }
  }
}

/** The desktop's host connection and browser command host over a scripted core. The runner answers `snapshot`, runs `wait`
 *  until its signal aborts, and runs `hang` until the test settles it, whatever its signal says (a command still settling). */
async function browserHost() {
  const net = new MockNetwork();
  const served = (async () => {
    const conn = await within(net.accept(), 'the client to connect');
    await handshake(conn);
    return conn;
  })();
  const connection = createProtocolConnection({
    open: () =>
      connect({
        target: { id: 'core' },
        connector: net,
        clientInfo: options.clientInfo,
        capabilities: options.capabilities,
        clock: { sleep: () => Promise.resolve() },
        random: () => options.jitterUnit,
      }),
  });
  await within(connection.start(), 'the connection to open');
  const conn = await served;
  const signals = [];
  const hanging = [];
  createBrowserCommandHost(
    createHostConnection(connection),
    {
      execute: (command, signal) => {
        signals.push(signal);
        if (command.action === 'hang') return new Promise((resolve) => hanging.push(resolve));
        if (command.action !== 'wait') return Promise.resolve({ text: 'ok' });
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      },
      begin() {},
      ready() {},
      inactive() {},
      end() {},
    },
    { remoteBrowserControl: async () => null, remote: async () => null }
  );
  return { net, connection, conn, signals, hanging };
}

test('a browser command the core gave up is aborted here and unanswered; an answered one is not held', async () => {
  const { connection, conn, signals } = await browserHost();
  try {
    conn.serverSend(command('host-1', 'snapshot'));
    assert.deepEqual(JSON.parse(await within(conn.nextSent(), 'the answer')), { id: 'host-1', result: { text: 'ok' } });
    assert.deepEqual(connection.pendingServerRequests(), [], 'an answered command is not held');

    conn.serverSend(command('host-2', 'wait'));
    await turns();
    assert.equal(signals.length, 2);
    assert.equal(signals[1].aborted, false, 'still running');
    assert.deepEqual(connection.pendingServerRequests(), [], 'a running command is not held either');
    conn.serverSend(resolved('host-2'));
    await turns();
    assert.equal(signals[1].aborted, true, 'the command the core gave up is aborted');
    assert.deepEqual(conn.sent, [], 'and not answered');
  } finally {
    await connection.close();
  }
});

// A restarted core numbers its requests from host-1 again. The old connection's command ends with it, and one still settling
// after the next connection asked under its id neither answers that connection nor takes the new command's place: the new
// core's `serverRequest/resolved` ends the new command.
test("a restarted core's resolved frame ends its own command, not the old connection's one under the same id", async () => {
  const { net, connection, conn, signals, hanging } = await browserHost();
  try {
    conn.serverSend(command('host-1', 'hang'));
    await turns();
    assert.equal(signals.length, 1);
    conn.serverClose(1006);
    const next = await within(net.accept(), 'the client to reconnect');
    await handshake(next, 's2');
    await turns();
    assert.equal(signals[0].aborted, true, 'the old command ends with its connection');

    next.serverSend(command('host-1', 'wait'));
    await turns();
    assert.equal(signals.length, 2);
    hanging[0]({ text: 'late' });
    await turns();
    assert.equal(signals[1].aborted, false, 'the old command settling leaves the new one running');
    next.serverSend(resolved('host-1'));
    await turns();
    assert.equal(signals[1].aborted, true, "the new core's resolved frame ends its own command");
    assert.deepEqual(next.sent, [], 'and neither command is answered on the new connection');
  } finally {
    await connection.close();
  }
});

test('a request nobody here serves is answered -32601; a served one is unaffected', async () => {
  const { connection, conn } = await browserHost();
  try {
    conn.serverSend({ id: 'host-1', method: 'host/screen/displays', params: {} });
    assert.deepEqual(JSON.parse(await within(conn.nextSent(), 'the refusal')), {
      id: 'host-1',
      error: { code: HOST_METHOD_NOT_FOUND, message: 'host/screen/displays is not served by this desktop' },
    });
    conn.serverSend(command('host-2', 'snapshot'));
    assert.deepEqual(JSON.parse(await within(conn.nextSent(), 'the answer')), { id: 'host-2', result: { text: 'ok' } });
  } finally {
    await connection.close();
  }
});

test('a reply is dropped when the client was replaced while the handler ran', async () => {
  const { net, connection, conn, hanging } = await browserHost();
  try {
    conn.serverSend(command('host-1', 'hang'));
    await turns();
    conn.serverClose(1006);
    const next = await within(net.accept(), 'the client to reconnect');
    await handshake(next, 's2');
    await turns();
    hanging[0]({ text: 'late' });
    await turns();
    assert.deepEqual(next.sent, [], 'the old answer does not reach the new connection');
  } finally {
    await connection.close();
  }
});

test('servedMethods lists request and notification handlers sorted; a second request handler for a method throws', () => {
  const host = createHostConnection({
    call: async () => null,
    notify() {},
    respond() {},
    sendBinary() {},
    onEvent() {},
    client: () => null,
    onReplaced() {},
  });
  assert.deepEqual(host.servedMethods(), []);
  host.handleRequest('host/b', async () => null);
  host.handleNotification('host/a', () => {});
  host.handleRequest('host/c', async () => null);
  assert.deepEqual(host.servedMethods(), ['host/a', 'host/b', 'host/c']);
  assert.throws(() => host.handleRequest('host/b', async () => null), /already served/);
});
