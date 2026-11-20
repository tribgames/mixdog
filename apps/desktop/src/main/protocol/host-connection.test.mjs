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
import { HostRpcError } from '../host/connection.ts';
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
const resolved = (requestId) => ({
  method: 'serverRequest/resolved',
  params: { threadId: '', requestId, resolution: { kind: 'cancelled', at: 1 } },
});

/** The scripted core's side of the handshake (`instance` is its serverInstanceId) and the app subscription. */
async function handshake(conn, instance = 's1') {
  for (;;) {
    const frame = JSON.parse(await within(conn.nextSent(), 'the handshake'));
    if (frame.method === 'initialize')
      conn.serverSend({ id: frame.id, result: { ...options.initializeResult, serverInstanceId: instance } });
    if (frame.method === 'app/subscribe') {
      conn.serverSend({
        id: frame.id,
        result: { subscription: { id: 'as', mode: 'snapshot', epoch: `ae-${instance}`, startSeq: 2 } },
      });
      conn.serverSend({
        method: 'app/snapshot',
        params: { sections: [] },
        feed: { id: 'app', epoch: `ae-${instance}`, seq: 1 },
      });
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
        if (command.action === 'big') return Promise.resolve({ text: 'x'.repeat(300_000) });
        if (command.action === 'bigerror') return Promise.reject(new Error(`evaluate threw: ${'e'.repeat(300_000)}`));
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

// The core closes a connection (1009, dropping every subscription and what the host holds) on a text frame over
// maxInboundFrameBytes (262144 here): no host message may reach the wire over it.
test('an answer or request over the inbound frame limit is never sent: the answer becomes an error, the link stays up', async () => {
  const { connection, conn } = await browserHost();
  try {
    conn.serverSend(command('host-1', 'big'));
    const answer = JSON.parse(await within(conn.nextSent(), 'the error answer'));
    assert.equal(answer.id, 'host-1');
    assert.equal(answer.result, undefined);
    assert.equal(answer.error.code, -32000);
    assert.match(
      answer.error.message,
      /host\/browser\/command answer could not be sent: .*maxInboundFrameBytes 262144/
    );
    assert.ok(JSON.stringify(answer).length < 1000);

    // An error answer is an answer too: one whose message does not fit is replaced by a small one, not dropped.
    conn.serverSend(command('host-3', 'bigerror'));
    const failed = JSON.parse(await within(conn.nextSent(), 'the replacement error'));
    assert.equal(failed.id, 'host-3');
    assert.equal(failed.error.code, -32000);
    assert.match(failed.error.message, /answer could not be sent: .*maxInboundFrameBytes 262144/);
    assert.ok(JSON.stringify(failed).length < 1000);

    await assert.rejects(
      connection.call('host/state/set', {
        key: 'visualize',
        value: [{ sessionId: 's', tabs: [], pad: 'x'.repeat(300_000) }],
      }),
      (error) => /maxInboundFrameBytes/.test(error.detail?.what ?? error.message)
    );
    assert.equal(connection.status, 'ready', 'the connection was not closed');
    conn.serverSend(command('host-2', 'snapshot'));
    assert.deepEqual(JSON.parse(await within(conn.nextSent(), 'the next answer')), {
      id: 'host-2',
      result: { text: 'ok' },
    });
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
    // An approval card is not the host role's: it is left to the window that answers it.
    conn.serverSend({ id: 'appr-1', method: 'item/tool/requestApproval', params: { threadId: 't1' } });
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

/** A host connection over a scripted core, with the failures it reports; the handlers are the test's own. */
async function plainHost() {
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
  const faults = [];
  const host = createHostConnection(connection, (where, error) => faults.push([where, error.message]));
  return { net, connection, conn, host, faults };
}

// The scripted core hands a frame to the client inside `serverSend`, as the socket's message callback does: whatever a host
// handler throws would leave through it, into the main process as an uncaught exception.
test('a handler that throws fails its own request, or is reported for a notification; the connection keeps serving', async () => {
  const { connection, conn, host, faults } = await plainHost();
  try {
    host.handleRequest('host/browser/pages/resolve', () => {
      throw new Error('The in-app browser is not open.');
    });
    host.handleRequest('host/browser/page/navigate', async () => {
      throw new HostRpcError(-32015, 'only http(s) navigation is allowed (got file:)', {
        reason: 'only http(s) navigation is allowed (got file:)',
      });
    });
    const released = [];
    host.handleNotification('host/browser/lease/release', (params) => {
      released.push(params.leaseId);
      if (params.leaseId === 'l1') throw new Error('The in-app browser is not open.');
    });
    host.handleRequest('host/browser/pages/list', async () => ({ pages: [] }));
    let waiting;
    host.handleRequest('host/browser/page/eval', (_params, signal) => {
      waiting = signal;
      return new Promise(() => {});
    });

    assert.doesNotThrow(() => conn.serverSend({ id: 'host-1', method: 'host/browser/pages/resolve', params: {} }));
    assert.deepEqual(
      JSON.parse(await within(conn.nextSent(), 'the failure of a handler that threw before its promise')),
      {
        id: 'host-1',
        error: { code: -32000, message: 'The in-app browser is not open.' },
      }
    );
    conn.serverSend({ id: 'host-2', method: 'host/browser/page/navigate', params: {} });
    assert.deepEqual(JSON.parse(await within(conn.nextSent(), 'the refusal')), {
      id: 'host-2',
      error: {
        code: -32015,
        message: 'only http(s) navigation is allowed (got file:)',
        data: { reason: 'only http(s) navigation is allowed (got file:)' },
      },
    });
    assert.doesNotThrow(() =>
      conn.serverSend({ method: 'host/browser/lease/release', params: { pageId: 'p1', leaseId: 'l1' } })
    );
    await turns();
    assert.deepEqual(faults, [['notification host/browser/lease/release', 'The in-app browser is not open.']]);
    // The client library delivers the notifications of a connection one after the other on one promise chain
    // (protocol-client client.ts onNotification): a throw into it would end the chain, and with it every later notification of
    // the connection, the `serverRequest/resolved` that ends an abandoned command among them.
    conn.serverSend({ method: 'host/browser/lease/release', params: { pageId: 'p1', leaseId: 'l2' } });
    conn.serverSend({ id: 'host-9', method: 'host/browser/page/eval', params: {} });
    conn.serverSend(resolved('host-9'));
    await turns();
    assert.deepEqual(released, ['l1', 'l2'], 'the notification after the failed one is delivered');
    assert.equal(waiting.aborted, true, 'and the core still ends a command it gave up');

    conn.serverSend({ id: 'host-3', method: 'host/browser/pages/list', params: {} });
    assert.deepEqual(JSON.parse(await within(conn.nextSent(), 'the next request')), {
      id: 'host-3',
      result: { pages: [] },
    });
    assert.equal(connection.status, 'ready', 'none of it ended the link');
  } finally {
    await connection.close();
  }
});

// desktop-host-wiring.ts claims the role at a `ready` that follows a state that was not: its listener is registered after the
// host connection's, so it sees the link end only if the host connection's listener returns.
test('a close listener that throws keeps neither the other listeners nor the next claim from the end of the link', async () => {
  const { net, connection, conn, host, faults } = await plainHost();
  try {
    const stopped = [];
    host.onClose(() => {
      throw new Error('a module failed to stop');
    });
    host.onClose(() => stopped.push('the listener after it'));
    host.handleRequest('host/browser/pages/list', async () => ({ pages: [] }));
    let wasReady = true;
    let claims = 0;
    connection.onEvent((event) => {
      if (event.type !== 'status') return;
      const ready = event.status.state === 'ready';
      if (ready && !wasReady) claims += 1;
      wasReady = ready;
    });

    assert.doesNotThrow(() => conn.serverClose(1006));
    assert.deepEqual(stopped, ['the listener after it']);
    assert.equal(wasReady, false, 'the connection listeners after the host connection heard the link end');
    assert.equal(
      faults.length >= 1 &&
        faults.every(([where, message]) => where === 'close listener' && message === 'a module failed to stop'),
      true
    );

    const next = await within(net.accept(), 'the client to reconnect');
    await handshake(next, 's2');
    await turns();
    assert.equal(claims, 1, 'the role is claimed again on the new link');
    next.serverSend({ id: 'host-1', method: 'host/browser/pages/list', params: {} });
    assert.deepEqual(JSON.parse(await within(next.nextSent(), 'a request on the new link')), {
      id: 'host-1',
      result: { pages: [] },
    });
  } finally {
    await connection.close();
  }
});

test('an answer the link can no longer carry is reported and nothing is thrown', async () => {
  const faults = [];
  let listener;
  const client = {};
  const host = createHostConnection(
    {
      call: async () => null,
      notify() {},
      respond() {
        throw new Error('The core connection is not open.');
      },
      sendBinary() {},
      onEvent: (handler) => {
        listener = handler;
      },
      client: () => client,
      onReplaced() {},
    },
    (where, error) => faults.push([where, error.message])
  );
  host.handleRequest('host/browser/pages/list', async () => ({ pages: [] }));
  listener({ type: 'serverRequest', request: { id: 'host-1', method: 'host/browser/pages/list', params: {} } });
  listener({ type: 'serverRequest', request: { id: 'host-2', method: 'host/screen/displays', params: {} } });
  await turns();
  assert.deepEqual(faults.sort(), [
    ['answer of host/browser/pages/list', 'The core connection is not open.'],
    ['answer of host/screen/displays', 'The core connection is not open.'],
  ]);
});
