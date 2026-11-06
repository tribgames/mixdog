import assert from 'node:assert/strict';
import test from 'node:test';

import { relayModelProxy } from './model-proxy-relay.ts';

function link() {
  const listeners = new Set();
  return {
    listeners,
    sent: [],
    onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    emit: (event) => listeners.forEach((listener) => listener(event)),
  };
}

function rig() {
  const server = Object.assign(link(), {
    respond(id, answer) {
      this.sent.push(['respond', id, answer]);
    },
    notify(method, params) {
      this.sent.push(['notify', method, params]);
    },
  });
  const calls = [];
  const local = Object.assign(link(), {
    call(method, params) {
      return new Promise((resolve, reject) => calls.push({ method, params, resolve, reject }));
    },
    notify(method, params) {
      this.sent.push([method, params]);
    },
  });
  const stop = relayModelProxy(server, local);
  const execute = (id, call = { kind: 'send' }) =>
    server.emit({ type: 'serverRequest', request: { id, method: 'model/proxy/execute', params: { call } } });
  const cancel = (requestId) =>
    server.emit({ type: 'notification', notification: { method: 'model/proxy/cancel', params: { requestId } } });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { server, local, calls, stop, execute, cancel, settle };
}

test('a cancel of the server relays to the local core for the run that request started', async () => {
  const { local, calls, execute, cancel, settle } = rig();
  execute(7);
  execute('b');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'modelProxy/run');
  assert.deepEqual(calls[0].params.call, { kind: 'send' });
  assert.notEqual(calls[0].params.runId, calls[1].params.runId);

  cancel('b');
  assert.deepEqual(local.sent, [['modelProxy/cancel', { runId: calls[1].params.runId }]]);
  cancel(7);
  assert.deepEqual(local.sent.at(-1), ['modelProxy/cancel', { runId: calls[0].params.runId }]);
  cancel('7');
  assert.equal(local.sent.length, 2, 'the id 7 and the id "7" are different requests');

  calls[0].resolve({ result: { result: 'route', route: null } });
  await settle();
  cancel(7);
  assert.equal(local.sent.length, 2, 'a call that is over has nothing to stop');
});

test('a cancel of a request the PC never ran is dropped', () => {
  const { local, execute, cancel } = rig();
  cancel(99);
  execute(1);
  assert.deepEqual(local.sent, []);
});

test('a stopped relay abandons its calls and relays nothing more', async () => {
  const { server, local, calls, execute, cancel, stop, settle } = rig();
  execute(1);
  stop();
  assert.deepEqual(local.sent, [['modelProxy/cancel', { runId: calls[0].params.runId }]]);
  cancel(1);
  calls[0].resolve({ result: { result: 'route', route: null } });
  await settle();
  assert.equal(local.sent.length, 1);
  assert.deepEqual(server.sent, [], 'an abandoned call is unanswered');
});

test('a lost server link stops every call in flight and leaves them unanswered, like the lease of Node', async () => {
  const { server, local, calls, execute, settle } = rig();
  execute(1);
  execute(2);
  server.emit({ type: 'status', status: { state: 'ready' } });
  assert.deepEqual(local.sent, []);
  server.emit({ type: 'status', status: { state: 'reconnecting' } });
  assert.deepEqual(
    local.sent.map(([method]) => method),
    ['modelProxy/cancel', 'modelProxy/cancel']
  );
  assert.deepEqual(new Set(local.sent.map(([, p]) => p.runId)), new Set(calls.map((c) => c.params.runId)));
  server.emit({ type: 'status', status: { state: 'closed' } });
  assert.equal(local.sent.length, 2, 'nothing left to stop');

  calls[0].resolve({ result: { result: 'route', route: null } });
  calls[1].reject(new Error('cancelled'));
  await settle();
  assert.deepEqual(server.sent, []);

  // The server's ids restart on the next link: the new call is its own run and is answered.
  execute(1);
  assert.notEqual(calls[2].params.runId, calls[0].params.runId);
  calls[2].resolve({ result: { result: 'route', route: null } });
  await settle();
  assert.equal(server.sent.length, 1);
});

test('runs of two server connections on one local core get different run ids', () => {
  const a = rig();
  const b = rig();
  a.execute(1);
  b.execute(1);
  assert.notEqual(a.calls[0].params.runId, b.calls[0].params.runId);
});

test('run events go back to the server by request id, and the answer is the response', async () => {
  const { server, local, calls, execute, settle } = rig();
  execute(3);
  const { runId } = calls[0].params;
  local.emit({ type: 'notification', notification: { method: 'modelProxy/run/event', params: { runId, event: { n: 1 } } } });
  local.emit({ type: 'notification', notification: { method: 'modelProxy/run/event', params: { runId: 'other', event: { n: 2 } } } });
  assert.deepEqual(server.sent, [['notify', 'model/proxy/event', { requestId: 3, event: { n: 1 } }]]);

  const answer = { result: { result: 'route', route: null } };
  calls[0].resolve(answer);
  await settle();
  assert.deepEqual(server.sent.at(-1), ['respond', 3, { result: answer }]);
});

test('a failed call answers as the error of the request with the failure as its data', async () => {
  const { server, calls, execute, settle } = rig();
  execute(4);
  execute(5);
  const failure = { kind: 'rateLimit', message: 'slow down' };
  calls[0].resolve({ result: { result: 'failed', failure } });
  calls[1].reject(new Error('the local core is gone'));
  await settle();
  assert.deepEqual(server.sent[0], ['respond', 4, { error: { code: -32000, message: 'slow down', data: failure } }]);
  assert.deepEqual(server.sent[1], ['respond', 5, { error: { code: -32000, message: 'the local core is gone' } }]);
});
