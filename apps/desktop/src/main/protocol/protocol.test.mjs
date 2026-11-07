import assert from 'node:assert/strict';
import test from 'node:test';

import { SECTIONS_IPC } from '../../shared/contract-sections.ts';
import { createProtocolConnection, SECTION_NAMES } from './connection.ts';
import { parseDiscovery, resolveTunnelEndpoint } from './discovery.ts';
import { createHostConnection } from './host-connection.ts';
import { createSectionRelay, REPLACE_CHUNK_ENTRIES } from './section-relay.ts';
import { registerProtocolWindowIpc } from './window-ipc.ts';

/** A fold store like the client library's: sections by name and key, listeners per change. */
function fakeStore() {
  const map = new Map();
  const listeners = new Set();
  return {
    set(section, key, revision, value) {
      const bucket = map.get(section) ?? new Map();
      map.set(section, bucket);
      bucket.set(key ?? '', { section, key, revision, value });
      for (const l of [...listeners]) l({ type: 'section', section, key });
    },
    remove(section, key) {
      map.get(section)?.delete(key ?? '');
      for (const l of [...listeners]) l({ type: 'section', section, key });
    },
    clear: () => map.clear(),
    emit: (change) => listeners.forEach((l) => l(change)),
    section: (section, key = null) => map.get(section)?.get(key ?? ''),
    sections: (section) => [...(map.get(section)?.values() ?? [])],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function fakeClient() {
  const store = fakeStore();
  const handlers = new Set();
  const calls = [];
  const notes = [];
  const answers = [];
  return {
    store,
    calls,
    notes,
    answers,
    status: { state: 'ready' },
    call: async (method, params) => {
      calls.push({ method, params });
      return {};
    },
    notify: (method, params) => notes.push({ method, params }),
    subscribeApp: async () => {},
    respond: (id, answer) => answers.push({ id, answer }),
    on: (listener) => {
      handlers.add(listener);
      return () => handlers.delete(listener);
    },
    emit: (event) => handlers.forEach((h) => h(event)),
    close: async () => {},
  };
}

const manual = () => {
  const queue = [];
  // 
  // run() drains the loop: work deferred while running (the chunks of a replace) runs too.
  return {
    defer: (flush) => queue.push(flush),
    run: () => {
      while (queue.length > 0) queue.shift()();
    },
  };
};

test('whenSynced settles with the connect handshake: after the app subscription, or with its failure', async () => {
  const client = fakeClient();
  let finishSubscribe;
  client.subscribeApp = () => new Promise((resolve) => (finishSubscribe = resolve));
  const connection = createProtocolConnection({ open: async () => client });
  let synced = false;
  const waiting = connection.whenSynced().then(() => (synced = true));
  const starting = connection.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(synced, false, 'opened and initialized, but the first snapshot is not folded yet');
  finishSubscribe();
  await starting;
  await waiting;
  assert.equal(synced, true);

  const failing = createProtocolConnection({
    open: async () => {
      throw new Error('initialize refused');
    },
  });
  const failedRead = failing.whenSynced();
  await assert.rejects(failing.start(), /initialize refused/);
  await assert.rejects(failedRead, /initialize refused/);
});

test('a burst of section changes leaves one flush with each pair at its current entry', () => {
  const store = fakeStore();
  const pushes = [];
  const loop = manual();
  createSectionRelay({ store, sectionNames: SECTION_NAMES, send: (p) => pushes.push(p), defer: loop.defer });
  store.set('usage', 'day', 1, { rows: 1 });
  store.set('usage', 'day', 2, { rows: 2 });
  store.set('agentPool', null, 1, []);
  store.remove('usage', 'week');
  assert.equal(pushes.length, 0, 'nothing is sent inside the synchronous run');
  loop.run();
  assert.equal(pushes.length, 1);
  const { changes } = pushes[0];
  assert.deepEqual(
    changes.map((c) => [c.section, c.key, c.entry?.revision ?? null]),
    [['usage', 'day', 2], ['agentPool', null, 1], ['usage', 'week', null]]
  );
});

test('a reconnect sends the whole store in budgeted chunks between a begin and a commit; changes made meanwhile follow the commit', () => {
  const store = fakeStore();
  const pushes = [];
  const queue = [];
  const relay = createSectionRelay({ store, sectionNames: SECTION_NAMES, send: (p) => pushes.push(p), defer: (f) => queue.push(f) });
  const turn = () => queue.shift()();
  const total = REPLACE_CHUNK_ENTRIES * 2 + 5;
  for (let i = 0; i < total; i++) store.set('notice', `n${i}`, 1, i);
  while (queue.length > 0) turn();
  pushes.length = 0;

  relay.reconnected();
  turn();
  assert.deepEqual(pushes.map((p) => p.stage), ['begin'], 'the flush starts the replace; no chunk shares its turn');
  turn();
  assert.equal(pushes.at(-1).entries.length, REPLACE_CHUNK_ENTRIES, 'a chunk is bounded');
  store.set('config', null, 3, 'made mid-replace');
  store.remove('notice', 'n0');
  while (queue.length > 0) turn();

  assert.deepEqual(pushes.map((p) => `${p.kind}:${p.stage ?? ''}`), [
    'replace:begin',
    'replace:chunk',
    'replace:chunk',
    'replace:chunk',
    'replace:commit',
    'sections:',
  ]);
  assert.equal(replacedEntries(pushes).length, total, 'every entry of the point-in-time view is sent once');
  assert.deepEqual(
    pushes.at(-1).changes.map((c) => [c.section, c.key, c.entry?.revision ?? null]),
    [['config', null, 3], ['notice', 'n0', null]],
    'what changed during the replace follows its commit'
  );
});

test('a second reconnect supersedes a replace still sending: the old chunks are dropped', () => {
  const store = fakeStore();
  const pushes = [];
  const queue = [];
  const relay = createSectionRelay({ store, sectionNames: SECTION_NAMES, send: (p) => pushes.push(p), defer: (f) => queue.push(f) });
  for (let i = 0; i < REPLACE_CHUNK_ENTRIES * 2; i++) store.set('notice', `n${i}`, 1, i);
  while (queue.length > 0) queue.shift()();
  pushes.length = 0;
  relay.reconnected();
  queue.shift()();
  queue.shift()();
  relay.reconnected();
  while (queue.length > 0) queue.shift()();
  const stages = pushes.map((p) => p.stage);
  assert.equal(stages.filter((s) => s === 'begin').length, 2);
  assert.equal(stages.filter((s) => s === 'commit').length, 1, 'only the last replace commits');
  assert.equal(stages.at(-1), 'commit');
});
test('a window gets the snapshot and pushes; only listed methods are callable; a watch is namespaced to its window', async () => {
  const client = fakeClient();
  const connection = createProtocolConnection({ open: async () => client, defer: (f) => f() });
  await connection.start();
  client.store.set('config', null, 1, { a: 1 });

  const sent = [];
  const handlers = new Map();
  const dispose = registerProtocolWindowIpc({
    connection,
    handle: (channel, listener) => handlers.set(channel, listener),
    send: (channel, value) => (sent.push({ channel, value }), true),
    removeHandler: (channel) => handlers.delete(channel),
  });
  const snapshot = handlers.get(SECTIONS_IPC.snapshot)({});
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.entries[0].section, 'config');

  client.store.set('config', null, 2, { a: 2 });
  assert.equal(sent.at(-1).channel, SECTIONS_IPC.push);
  assert.equal(sent.at(-1).value.changes[0].entry.revision, 2);

  await assert.rejects(handlers.get(SECTIONS_IPC.call)({}, 'thread/delete', {}), /not available/);
  await handlers.get(SECTIONS_IPC.call)({}, 'fs/watch', { watchId: 'x', path: '/p', recursive: true });
  const owned = client.calls.at(-1).params.watchId;
  assert.notEqual(owned, 'x');
  client.emit({ type: 'notification', notification: { method: 'fs/changed', params: { watchId: owned, changedPaths: ['/p/a'], kind: 'modified' } } });
  client.emit({ type: 'notification', notification: { method: 'fs/changed', params: { watchId: 'someone-else', changedPaths: [], kind: 'modified' } } });
  const fs = sent.filter((s) => s.channel === SECTIONS_IPC.fsChanged);
  assert.equal(fs.length, 1);
  assert.equal(fs[0].value.watchId, 'x');

  dispose();
  assert.equal(client.calls.at(-1).method, 'fs/unwatch', 'closing the window releases its watch');
  assert.equal(handlers.size, 0);
});

const isReplace = (p) => p.kind === 'replace';
/** The store a window would hold after the replaces among pushes: the entries of the chunks of the last one. */
const replacedEntries = (pushes) => pushes.filter((p) => p.kind === 'replace' && p.stage === 'chunk').flatMap((p) => p.entries);

/** A connection with one attached window that records what it was sent; flushes are driven by the test. */
async function connectedWindow(client) {
  const loop = manual();
  const connection = createProtocolConnection({ open: async () => client, defer: loop.defer });
  await connection.start();
  const pushes = [];
  const window = { push: (p) => pushes.push(p), notification() {} };
  connection.attach(window);
  return { connection, window, pushes, loop };
}

test('after a reconnect the windows are replaced only once the restored app snapshot has been folded', async () => {
  const client = fakeClient();
  const { pushes, loop } = await connectedWindow(client);
  client.store.set('config', null, 7, { theme: 'old' });
  client.store.set('notice', 'a', 1, 'removed on the core meanwhile');
  loop.run();
  pushes.length = 0;

  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  loop.run();
  assert.equal(pushes.some(isReplace), false, 'ready alone does not replace anything');

  // The restored subscription's snapshot swaps in whole: the changes before appSnapshot announce the removed sections too.
  client.store.remove('notice', 'a');
  client.store.set('config', null, 9, { theme: 'new' });
  loop.run();
  const announced = pushes.filter((p) => p.kind === 'sections').flatMap((p) => p.changes);
  assert.deepEqual(announced.map((c) => [c.section, c.key, c.entry?.revision ?? null]), [['notice', 'a', null], ['config', null, 9]]);
  assert.equal(pushes.some(isReplace), false, 'not replaced before the snapshot is complete');
  client.store.emit({ type: 'appSnapshot' });
  loop.run();
  assert.deepEqual(pushes.filter(isReplace).map((p) => p.stage), ['begin', 'chunk', 'commit']);
  assert.deepEqual(replacedEntries(pushes).map((e) => [e.section, e.revision]), [['config', 9]], 'the removed notice is gone');

  client.store.emit({ type: 'appSnapshot' });
  loop.run();
  assert.equal(pushes.filter((p) => isReplace(p) && p.stage === 'begin').length, 1, 'only the restore after a reconnect replaces');
});

test('a refused app restore leaves the windows as they are and awaits no snapshot', async () => {
  const client = fakeClient();
  const { pushes, loop } = await connectedWindow(client);
  client.store.set('config', null, 7, { theme: 'old' });
  loop.run();
  pushes.length = 0;
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  client.store.emit({ type: 'subscription', feedId: 'app', state: 'lost', error: { kind: 'rpc' } });
  loop.run();
  client.store.emit({ type: 'appSnapshot' });
  loop.run();
  assert.equal(pushes.some(isReplace), false, 'the store kept the previous app state, whole');
});
test('a reconnect sends the live file watches and the ports subscription again, and not those of closed windows', async () => {
  const client = fakeClient();
  const { connection, window } = await connectedWindow(client);
  const closed = { push() {}, notification() {} };
  const detachClosed = connection.attach(closed);
  await connection.watchFiles(window, { watchId: 'w1:a', path: '/p', recursive: true });
  await connection.watchFiles(closed, { watchId: 'w2:b', path: '/q', recursive: false });
  await connection.viewPorts(window, true);
  detachClosed();
  client.calls.length = 0;

  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  assert.deepEqual(client.calls, []);
  client.emit({ type: 'status', status: { state: 'ready' } });
  assert.deepEqual(client.calls, [
    { method: 'fs/watch', params: { watchId: 'w1:a', path: '/p', recursive: true } },
    { method: 'system/ports/subscribe', params: {} },
  ]);
});

test('a watch answered after its window closed is still released, and is not restored later', async () => {
  const client = fakeClient();
  const answers = [];
  const call = client.call;
  client.call = (method, params) => {
    if (method !== 'fs/watch') return call(method, params);
    client.calls.push({ method, params });
    return new Promise((resolve) => answers.push(resolve));
  };
  const { connection } = await connectedWindow(client);
  const handlers = new Map();
  const dispose = registerProtocolWindowIpc({
    connection,
    handle: (channel, listener) => handlers.set(channel, listener),
    send: () => true,
    removeHandler: () => {},
  });
  const watching = handlers.get(SECTIONS_IPC.call)({}, 'fs/watch', { watchId: 'x', path: '/p', recursive: true });
  const owned = client.calls.at(-1).params.watchId;
  dispose();
  answers[0]({});
  await watching;
  assert.deepEqual(client.calls.filter((c) => c.method === 'fs/unwatch').map((c) => c.params.watchId), [owned]);

  client.calls.length = 0;
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  assert.deepEqual(client.calls, [], 'nothing of the closed window is watched again');
});

test('ports are sampled only while a window views them: first viewer subscribes, last one leaving unsubscribes', async () => {
  const client = fakeClient();
  const connection = createProtocolConnection({ open: async () => client });
  await connection.start();
  const a = { push() {}, notification() {} };
  const b = { push() {}, notification() {} };
  connection.attach(a);
  connection.attach(b);
  await connection.viewPorts(a, true);
  await connection.viewPorts(b, true);
  await connection.viewPorts(a, false);
  assert.deepEqual(client.calls.map((c) => c.method), ['system/ports/subscribe']);
  await connection.viewPorts(b, false);
  assert.deepEqual(client.calls.map((c) => c.method), ['system/ports/subscribe', 'system/ports/unsubscribe']);
});

test('host connection answers core requests, aborts abandoned ones and reports a drop to onClose', async () => {
  const client = fakeClient();
  const connection = createProtocolConnection({ open: async () => client });
  const host = createHostConnection(connection);
  await connection.start();
  const aborted = [];
  host.handleRequest('host/systemProxy/resolve', async (params, signal) => {
    if (params.slow) {
      await new Promise((r) => signal.addEventListener('abort', r));
      aborted.push(true);
      return 'late';
    }
    return { rules: 'DIRECT' };
  });
  let closed = 0;
  host.onClose(() => closed++);
  client.emit({ type: 'serverRequest', request: { id: 7, method: 'host/systemProxy/resolve', params: {} } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(client.answers, [{ id: 7, answer: { result: { rules: 'DIRECT' } } }]);
  client.emit({ type: 'serverRequest', request: { id: 8, method: 'host/systemProxy/resolve', params: { slow: true } } });
  client.emit({ type: 'serverRequestResolved', params: { requestId: 8 } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(aborted, [true]);
  assert.equal(client.answers.length, 1, 'an abandoned request is not answered');
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  assert.equal(closed, 1);
});

test('discovery names the rpc endpoint only while the core serves', () => {
  assert.deepEqual(
    parseDiscovery(JSON.stringify({ endpoints: { session: { port: 1, token: 't' } }, core: { state: 'serving', rpc: { port: 4711 } } })),
    { url: 'ws://127.0.0.1:4711/rpc', token: 't' }
  );
  assert.throws(
    () => parseDiscovery(JSON.stringify({ endpoints: { session: { token: 't' } }, core: { state: 'booting' } })),
    /not serving/
  );
});

test('a server core is reached through its SSH tunnel: the live attachment as is, else a fresh connect', async () => {
  let discovery = { port: 41000, token: 'tok', pid: 7 };
  let connects = 0;
  const connector = {
    currentDiscovery: () => discovery,
    connect: async () => {
      connects += 1;
      discovery = { port: 41001, token: 'next', pid: 7 };
      return { discovery };
    },
  };
  assert.deepEqual(await resolveTunnelEndpoint(connector), { url: 'ws://127.0.0.1:41000/rpc', token: 'tok' });
  assert.equal(connects, 0);
  discovery = null;
  assert.deepEqual(await resolveTunnelEndpoint(connector), { url: 'ws://127.0.0.1:41001/rpc', token: 'next' });
  assert.equal(connects, 1);
});

