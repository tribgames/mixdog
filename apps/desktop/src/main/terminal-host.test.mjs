import assert from 'node:assert/strict';
import test from 'node:test';

import { TerminalHost } from './terminal-host';

function fakeTransport() {
  const listeners = new Map();
  return {
    posted: [],
    killed: false,
    postMessage(message) { this.posted.push(message); },
    kill() {
      this.killed = true;
      this.emit('exit', 0);
      return true;
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

test('terminal host proxies ensure through the worker transport', async () => {
  const transport = fakeTransport();
  const host = new TerminalHost(() => transport);
  const pending = host.ensure(null, 'C:/work');
  assert.equal(transport.posted.length, 1);
  const request = transport.posted[0];
  assert.equal(request.kind, 'ensure');
  assert.equal(request.cwd, 'C:/work');
  transport.emit('message', {
    data: {
      kind: 'ensure-result',
      requestId: request.requestId,
      ok: true,
      value: { id: 'term_1', replay: 'replayed' },
    },
  });
  assert.deepEqual(await pending, { id: 'term_1', replay: 'replayed' });
});

test('terminal host fans worker data events out to subscribers', async () => {
  const transport = fakeTransport();
  const host = new TerminalHost(() => transport);
  await (async () => {
    const pending = host.ensure('term_9', null);
    transport.emit('message', {
      data: {
        kind: 'ensure-result',
        requestId: transport.posted[0].requestId,
        ok: true,
        value: { id: 'term_9', replay: '' },
      },
    });
    await pending;
  })();
  const events = [];
  const unsubscribe = host.subscribe((event) => events.push(event));
  transport.emit('message', { data: { kind: 'data', id: 'term_9', data: 'hello' } });
  unsubscribe();
  transport.emit('message', { data: { kind: 'data', id: 'term_9', data: 'dropped' } });
  assert.deepEqual(events, [{ id: 'term_9', data: 'hello' }]);
});

test('terminal host rejects in-flight ensures on worker exit and respawns lazily', async () => {
  const transports = [];
  const host = new TerminalHost(() => {
    const transport = fakeTransport();
    transports.push(transport);
    return transport;
  });
  const pending = host.ensure(null, null);
  transports[0].emit('exit', 1);
  await assert.rejects(pending, /terminal worker exited/i);
  const retry = host.ensure(null, null);
  assert.equal(host.workerSpawnCount, 2);
  transports[1].emit('message', {
    data: {
      kind: 'ensure-result',
      requestId: transports[1].posted[0].requestId,
      ok: true,
      value: { id: 'term_2', replay: '' },
    },
  });
  assert.equal((await retry).id, 'term_2');
});

test('terminal host disposeAll tears the worker down and refuses new work', async () => {
  const transport = fakeTransport();
  const host = new TerminalHost(() => transport);
  const pending = host.ensure(null, null);
  transport.emit('message', {
    data: {
      kind: 'ensure-result',
      requestId: transport.posted[0].requestId,
      ok: true,
      value: { id: 'term_1', replay: '' },
    },
  });
  await pending;
  host.disposeAll();
  assert.equal(transport.posted.at(-1).kind, 'dispose-all');
  host.write('term_1', 'ignored');
  assert.equal(transport.posted.at(-1).kind, 'dispose-all');
  await assert.rejects(host.ensure(null, null), /disposed/i);
});
