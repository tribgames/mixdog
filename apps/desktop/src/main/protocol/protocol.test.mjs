import assert from 'node:assert/strict';
import test from 'node:test';

import { isOfferedRequest } from '../../../../../packages/protocol-client/src/method-table.ts';
import { createCapabilityLane } from './capability-route.ts';
import { createProtocolConnection, MAX_FOLLOWED_LOGINS } from './connection.ts';
import { parseDiscovery } from './discovery.ts';
import { createHostConnection } from './host-connection.ts';

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
    // The app feed the store was last folded from; a test moves it to another core by assigning its epoch.
    epoch: 'core-1',
    appFeed() {
      return { epoch: this.epoch };
    },
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
  // The library client's own pending set: added when the core asks what it offers every connection (not a capability's request,
  // which its handler ends), removed when it resolves the ask, dropped with the socket.
  const pending = [];
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
    pendingServerRequests: () => pending,
    on: (listener) => {
      handlers.add(listener);
      return () => handlers.delete(listener);
    },
    emit: (event) => {
      if (event.type === 'serverRequest') {
        if (isOfferedRequest(event.request.method)) pending.push(event.request);
      } else if (event.type === 'serverRequestResolved') pending.splice(0, pending.length, ...pending.filter((r) => r.id !== event.params.requestId));
      else if (event.type === 'status' && event.status.state !== 'ready') pending.length = 0;
      handlers.forEach((h) => h(event));
    },
    close: async () => {},
  };
}

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

test('a call that arrives before the first connection is open waits for it, and fails with its error when it fails', async () => {
  const client = fakeClient();
  let finishOpen;
  const connection = createProtocolConnection({ open: () => new Promise((resolve) => (finishOpen = () => resolve(client))) });
  const starting = connection.start();
  const early = connection.call('model/list', { quick: true });
  const earlyWatch = connection.watchFiles({ push() {}, notification() {}, loginFeedLost() {} }, { watchId: 'w1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.calls, [], 'nothing is sent before the connection is open');
  finishOpen();
  await starting;
  await early;
  await earlyWatch;
  assert.deepEqual(client.calls.map((c) => c.method), ['model/list', 'fs/watch']);

  const failing = createProtocolConnection({
    open: async () => {
      throw new Error('initialize refused');
    },
  });
  const failedStart = failing.start();
  const failedCall = failing.call('model/list', {});
  await assert.rejects(failedStart, /initialize refused/);
  await assert.rejects(failedCall, /initialize refused/);
});

test('closing while the first connection is still opening ends what waited for it', async () => {
  const client = fakeClient();
  let closedUnused = false;
  client.close = async () => void (closedUnused = true);
  let finishOpen;
  const connection = createProtocolConnection({ open: () => new Promise((resolve) => (finishOpen = () => resolve(client))) });
  const window = { push() {}, notification() {}, loginFeedLost() {} };
  const starting = connection.start();
  const waiting = [
    connection.call('model/list', {}),
    connection.watchFiles(window, { watchId: 'w1' }),
    connection.watchFeed(window, 'media:1'),
    connection.whenSynced(),
  ];
  // How each ended, read after the close has run: one left waiting stays `pending` here and fails the comparison.
  const ended = waiting.map(() => 'pending');
  waiting.forEach((wait, index) =>
    wait.then(
      () => (ended[index] = 'fulfilled'),
      (error) => (ended[index] = error.message)
    )
  );
  await connection.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ended, Array(4).fill('The core connection is closed.'));
  // The open that was in flight ends unused: its client is closed and nothing went out on it.
  finishOpen();
  await starting;
  assert.equal(closedUnused, true);
  assert.deepEqual(client.calls, []);
});
test('the snapshot holds every section of the open client with the epoch of its app feed', async () => {
  const client = fakeClient();
  const connection = createProtocolConnection({ open: async () => client });
  assert.deepEqual(connection.snapshot(), { status: 'reconnecting', entries: [] }, 'nothing is held before the first open');
  await connection.start();
  client.store.set('config', null, 1, { a: 1 });
  client.store.set('usage', 'day', 2, { rows: 2 });
  const snapshot = connection.snapshot();
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(snapshot.entries.map((e) => [e.section, e.key, e.revision]).sort(), [['config', null, 1], ['usage', 'day', 2]]);
  assert.equal(snapshot.epoch, 'core-1');
  client.store.epoch = 'core-2';
  assert.equal(connection.snapshot().epoch, 'core-2');
  await connection.close();
  assert.deepEqual(connection.snapshot(), { status: 'closed', entries: [] });
});

test('a watch is owned by its window: the notification reaches it, and detaching releases the watch', async () => {
  const client = fakeClient();
  const connection = createProtocolConnection({ open: async () => client });
  await connection.start();
  const seen = [];
  const window = { push() {}, notification: (method, params) => seen.push([method, params]), loginFeedLost() {} };
  const detach = connection.attach(window);
  await connection.watchFiles(window, { watchId: 'w1:x', path: '/p', recursive: true });
  client.emit({ type: 'notification', notification: { method: 'fs/changed', params: { watchId: 'w1:x', changedPaths: ['/p/a'] } } });
  assert.deepEqual(seen, [['fs/changed', { watchId: 'w1:x', changedPaths: ['/p/a'] }]]);
  detach();
  assert.equal(client.calls.at(-1).method, 'fs/unwatch', 'closing the window releases its watch');
});

/** A connected connection whose client answers `answers[method]` (default `{}`); `lost` is what its window was told. */
async function loginWindow(answers) {
  const client = fakeClient();
  client.call = async (method, params) => {
    client.calls.push({ method, params });
    const answer = answers[method] ?? {};
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const connection = createProtocolConnection({ open: async () => client });
  await connection.start();
  const lost = [];
  connection.attach({ push() {}, notification() {}, loginFeedLost: (flowId) => lost.push(flowId) });
  return { client, connection, lost };
}

const note = (method, params) => ({ type: 'notification', notification: { method, params } });

test('a started sign-in is followed on its scoped feed: the held state follows its frames', async () => {
  for (const [start, flowId] of [
    ['mcp/beginMcpOAuthLogin', 'mcp_oauth_1'],
    ['account/beginOAuthProviderLogin', 'oauth_1'],
    ['github/login/start', 'ghlogin_1'],
  ]) {
    const { client, connection, lost } = await loginWindow({ [start]: { flowId, state: 'pending' } });
    assert.deepEqual(await connection.call(start, {}), { flowId, state: 'pending' });
    assert.deepEqual(client.calls.at(-1), { method: 'feed/subscribe', params: { feedId: `login:${flowId}` } });
    const pending = { flowId, state: 'pending', step: 'browser' };
    const complete = { flowId, state: 'complete' };
    // The subscription's first frame is the feed snapshot; the later ones are the flow's updates.
    client.emit(note('feed/snapshot', { feedId: `login:${flowId}`, state: pending }));
    client.emit(note('login/updated', { flowId, state: complete }));
    assert.deepEqual(connection.loginFeed(flowId), { state: complete, lost: false });
    assert.deepEqual(lost, []);
  }
});

test('a sign-in feed that cannot be followed is lost: a failed subscription, a dropped link, a flow nobody follows', async () => {
  const refused = new Error('invalid params: the id of a live scoped feed');
  const failed = await loginWindow({ 'mcp/beginMcpOAuthLogin': { flowId: 'f1' }, 'feed/subscribe': refused });
  await failed.connection.call('mcp/beginMcpOAuthLogin', {});
  assert.deepEqual(failed.lost, ['f1']);
  assert.deepEqual(failed.connection.loginFeed('f1'), { state: null, lost: true });

  const live = await loginWindow({ 'account/beginOAuthProviderLogin': { flowId: 'f2' } });
  await live.connection.call('account/beginOAuthProviderLogin', {});
  assert.deepEqual(live.lost, []);
  live.client.emit({ type: 'status', status: { state: 'reconnecting' } });
  assert.deepEqual(live.lost, ['f2']);
  live.client.emit({ type: 'status', status: { state: 'closed' } });
  assert.equal(live.lost.length, 1, 'a feed is lost once');
  assert.deepEqual(live.connection.loginFeed('f2'), { state: null, lost: true });
  assert.deepEqual(live.connection.loginFeed('never-started'), { state: null, lost: true });
});

test('past the follow cap only ended sign-ins are let go: a pending one keeps its feed and is never silently dropped', async () => {
  const flowIds = Array.from({ length: MAX_FOLLOWED_LOGINS + 3 }, (_, index) => `f${index}`);
  let next = 0;
  const { client, connection, lost } = await loginWindow({});
  const answer = client.call;
  client.call = async (method, params) => (method === 'mcp/beginMcpOAuthLogin' ? (client.calls.push({ method, params }), { flowId: flowIds[next++] }) : answer(method, params));
  // The first flow ends before the cap is passed; every other stays pending.
  await connection.call('mcp/beginMcpOAuthLogin', {});
  client.emit(note('feed/snapshot', { feedId: 'login:f0', state: { flowId: 'f0', state: 'complete' } }));
  for (let index = 1; index < flowIds.length; index += 1) {
    await connection.call('mcp/beginMcpOAuthLogin', {});
    client.emit(note('feed/snapshot', { feedId: `login:${flowIds[index]}`, state: { flowId: flowIds[index], state: 'pending' } }));
  }
  const unsubscribed = client.calls.filter((call) => call.method === 'feed/unsubscribe').map((call) => call.params.feedId);
  assert.deepEqual(unsubscribed, ['login:f0'], 'only the ended flow is let go');
  for (const flowId of flowIds.slice(1)) {
    assert.equal(connection.loginFeed(flowId).lost, false, `${flowId} is still followed`);
  }
  assert.deepEqual(lost, []);
});

test('cancelling a sign-in ends the subscription to its feed', async () => {
  const { client, connection } = await loginWindow({ 'mcp/beginMcpOAuthLogin': { flowId: 'f3' } });
  await connection.call('mcp/beginMcpOAuthLogin', {});
  await connection.call('mcp/cancelMcpOAuthLogin', { flowId: 'f3' });
  assert.ok(client.calls.some((call) => call.method === 'feed/unsubscribe' && call.params.feedId === 'login:f3'));
  assert.equal(connection.loginFeed('f3').lost, true);
});

/** A connection with one attached window. */
async function connectedWindow(client) {
  const connection = createProtocolConnection({ open: async () => client });
  await connection.start();
  const window = { push() {}, notification() {}, loginFeedLost() {} };
  const detach = connection.attach(window);
  return { connection, window, detach };
}

test('a reconnect sends the live file watches and the ports subscription again, and not those of closed windows', async () => {
  const client = fakeClient();
  const { connection, window } = await connectedWindow(client);
  const closed = { push() {}, notification() {}, loginFeedLost() {} };
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

test('reopen replaces the client: the old one is closed and silenced, the snapshot is the new store, the feeds are sent again', async () => {
  const first = fakeClient();
  const second = fakeClient();
  second.subscribeApp = async () => {
    second.store.set('config', null, 3, { theme: 'new' });
  };
  let closedFirst = false;
  first.close = async () => void (closedFirst = true);
  const clients = [first, second];
  const connection = createProtocolConnection({ open: async () => clients.shift() });
  await connection.start();
  const window = { push() {}, notification() {}, loginFeedLost() {} };
  connection.attach(window);
  await connection.watchFiles(window, { watchId: 'w1:a', path: '/p', recursive: true });
  await connection.viewPorts(window, true);
  first.store.set('config', null, 1, { theme: 'old' });
  // The first client ended for good (a refused version): its status is the library's terminal one.
  first.emit({ type: 'status', status: { state: 'closed', reason: { kind: 'versionRefused' } } });
  assert.equal(connection.status, 'closed');

  await connection.reopen();
  assert.equal(closedFirst, true);
  assert.equal(connection.status, 'ready');
  assert.deepEqual(second.calls, [
    { method: 'fs/watch', params: { watchId: 'w1:a', path: '/p', recursive: true } },
    { method: 'system/ports/subscribe', params: {} },
  ]);
  assert.deepEqual(connection.snapshot().entries.map((e) => [e.section, e.revision]), [['config', 3]]);
  await connection.call('x/y', {});
  assert.equal(second.calls.at(-1).method, 'x/y');
  // The old client no longer reaches the connection.
  first.store.set('config', null, 99, 'stale');
  first.emit({ type: 'status', status: { state: 'ready' } });
  assert.equal(connection.status, 'ready');
  assert.deepEqual(connection.snapshot().entries.map((e) => [e.section, e.revision]), [['config', 3]]);
});

test('a reopen whose handshake fails leaves nothing half-open: the next reopen starts clean and whenSynced follows it', async () => {
  const good = fakeClient();
  const bad = fakeClient();
  bad.subscribeApp = async () => {
    throw new Error('refused');
  };
  const again = fakeClient();
  const clients = [good, bad, again];
  const connection = createProtocolConnection({ open: async () => clients.shift() });
  await connection.start();
  await assert.rejects(connection.reopen(), /refused/);
  await assert.rejects(connection.whenSynced(), /refused/);
  await assert.rejects(connection.call('x/y', {}), /not open/);
  assert.equal(connection.status, 'closed', 'nothing serves after the failed open');
  await connection.reopen();
  await connection.whenSynced();
  await connection.call('x/y', {});
  assert.equal(again.calls.at(-1).method, 'x/y');
  await connection.close();
  await assert.rejects(connection.reopen(), /closed/);
});
/** A client whose open and app subscription the test settles by hand. */
function gatedClients(count) {
  const gates = Array.from({ length: count }, () => {
    const gate = { client: fakeClient(), closed: 0 };
    gate.opened = new Promise((resolve) => (gate.open = () => resolve(gate.client)));
    gate.subscribed = new Promise((resolve) => (gate.subscribe = resolve));
    gate.client.close = async () => void (gate.closed += 1);
    return gate;
  });
  return gates;
}
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('a reopen that begins while another is in flight supersedes it: the older client is closed unused, nothing stale applies, both callers get the newest outcome', async () => {
  const [first, a, b, c, d] = gatedClients(5);
  first.open();
  first.subscribe();
  const gates = [first, a, b, c, d];
  let opens = 0;
  const connection = createProtocolConnection({
    open: () => gates[opens++].opened,
  });
  for (const gate of gates) gate.client.subscribeApp = () => gate.subscribed;
  await connection.start();
  const notes = [];
  const raw = [];
  connection.attach({ push() {}, notification: (method) => notes.push(method), loginFeedLost() {} });
  connection.onEvent((event) => raw.push(event.type));

  // The older reopen is still opening when the newer begins.
  const older = connection.reopen();
  await turn();
  assert.equal(opens, 2);
  const newer = connection.reopen();
  await turn();
  assert.equal(opens, 3);
  a.open();
  await turn();
  assert.equal(a.closed, 1, 'the superseded open is closed as soon as it arrives');
  b.subscribe();
  b.open();
  await Promise.all([older, newer]);
  assert.equal(first.closed, 1);
  assert.equal(b.closed, 0);
  assert.equal(connection.status, 'ready');
  // Events of every client but the owner are dropped.
  raw.length = 0;
  for (const stale of [first, a]) {
    stale.client.store.set('config', null, 99, 'stale');
    stale.client.emit({ type: 'status', status: { state: 'reconnecting' } });
    stale.client.emit({ type: 'notification', notification: { method: 'fs/changed', params: {} } });
  }
  assert.deepEqual([notes, raw], [[], []]);
  assert.equal(connection.status, 'ready');

  // A reopen whose app subscription is pending when the next begins: the next one closes it, and its late answer does nothing.
  const third = connection.reopen();
  await turn();
  c.open();
  await turn();
  const fourth = connection.reopen();
  await turn();
  assert.equal(c.closed, 1, 'the superseded client was bound but unfinished: it is released');
  c.subscribe();
  await turn();
  assert.equal(connection.status, 'reconnecting', 'the late answer of a superseded client does not make the connection ready');
  await connection.close();
  d.open();
  // A closed connection ends every reopen still in flight.
  await Promise.all([third, fourth]);
  assert.deepEqual([first, a, b, c, d].map((gate) => gate.closed), [1, 1, 1, 1, 1], 'every client ends closed');
});

test('a reopen superseded by close never leaves a client open', async () => {
  const [first, a] = gatedClients(2);
  first.open();
  first.subscribe();
  const gates = [first, a];
  let opens = 0;
  const connection = createProtocolConnection({ open: () => gates[opens++].opened });
  for (const gate of gates) gate.client.subscribeApp = () => gate.subscribed;
  await connection.start();
  const reopening = connection.reopen();
  await turn();
  await connection.close();
  a.open();
  await reopening;
  assert.equal(a.closed, 1);
  assert.equal(first.closed, 1);
});

test('a reopen drops the sign-in feeds it cannot carry: they are lost, and a feed of the new client starts clean', async () => {
  const first = fakeClient();
  const second = fakeClient();
  const clients = [first, second];
  const connection = createProtocolConnection({ open: async () => clients.shift() });
  await connection.start();
  const lost = [];
  connection.attach({ push() {}, notification() {}, loginFeedLost: (flowId) => lost.push(flowId) });
  first.call = async (method) => (method === 'mcp/beginMcpOAuthLogin' ? { flowId: 'f1' } : {});
  await connection.call('mcp/beginMcpOAuthLogin', {});
  assert.deepEqual(connection.loginFeed('f1'), { state: null, lost: false });
  await connection.reopen();
  assert.deepEqual(lost, ['f1'], 'told through the same path as a dropped link');
  assert.equal(connection.loginFeed('f1').lost, true);
  assert.deepEqual(second.calls, [], 'nothing of the old client\'s feeds is sent to the new one');
});

test('replaced listeners are told once the new client is attached, not for the first start', async () => {
  const clients = [fakeClient(), fakeClient()];
  const connection = createProtocolConnection({ open: async () => clients.shift() });
  const told = [];
  const remove = connection.onReplaced(() => told.push(connection.status));
  await connection.start();
  assert.deepEqual(told, []);
  await connection.reopen();
  assert.deepEqual(told, ['ready']);
  remove();
});

test('ensureOpen leaves a client the automatic recovery restored alone: no second client, no rejected call, no lost feed', async () => {
  const first = fakeClient();
  const clients = [first, fakeClient()];
  let opened = 0;
  let closed = 0;
  first.close = async () => void (closed += 1);
  const connection = createProtocolConnection({ open: async () => (opened += 1, clients.shift()) });
  await connection.start();
  const lost = [];
  connection.attach({ push() {}, notification() {}, loginFeedLost: (flowId) => lost.push(flowId) });
  // The link dropped and the library's own redial restored it, as the user's Reconnect was dialing.
  first.emit({ type: 'status', status: { state: 'reconnecting' } });
  first.emit({ type: 'status', status: { state: 'ready' } });
  first.call = async (method) => (method === 'mcp/beginMcpOAuthLogin' ? { flowId: 'f1' } : {});
  await connection.call('mcp/beginMcpOAuthLogin', {});
  let release;
  first.call = () => new Promise((resolve) => (release = resolve));
  const pending = connection.call('x/y', {});
  await connection.ensureOpen();
  release('answer');
  assert.equal(await pending, 'answer');
  assert.equal(opened, 1);
  assert.equal(closed, 0);
  assert.deepEqual(lost, []);
  assert.equal(connection.loginFeed('f1').lost, false);
});

test('ensureOpen joins a reopen in flight and reopens a client that is not ready', async () => {
  const first = fakeClient();
  const clients = [first, fakeClient(), fakeClient()];
  let opened = 0;
  const connection = createProtocolConnection({ open: async () => (opened += 1, clients.shift()) });
  await connection.start();
  first.emit({ type: 'status', status: { state: 'reconnecting' } });
  await Promise.all([connection.ensureOpen(), connection.ensureOpen()]);
  assert.equal(opened, 2, 'not ready: one reopen, which the second ensureOpen joined');
  const before = opened;
  await connection.ensureOpen();
  assert.equal(opened, before, 'ready now: nothing is opened');
});

test('an event of a client a listener has just replaced writes nothing: the reopen\'s status stands', async () => {
  const first = fakeClient();
  const clients = [first, fakeClient()];
  const connection = createProtocolConnection({ open: async () => clients.shift() });
  await connection.start();
  let reopened = null;
  connection.onEvent(() => {
    reopened ??= connection.reopen();
  });
  first.emit({ type: 'status', status: { state: 'closed' } });
  assert.equal(connection.status, 'reconnecting', 'the superseded event did not write closed over the reopen');
  await reopened;
  assert.equal(connection.status, 'ready');
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
  const { connection, window, detach } = await connectedWindow(client);
  const owned = 'w1:x';
  const watching = connection.watchFiles(window, { watchId: owned, path: '/p', recursive: true });
  detach();
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
  const a = { push() {}, notification() {}, loginFeedLost() {} };
  const b = { push() {}, notification() {}, loginFeedLost() {} };
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

// A reopen drops the old client before closing it, so the host connection hears no status of it. A request of the old client ends
// with it and is never answered on the new one, so the new core's frames under a reused id reach only the new core's request.
test('a host request belongs to the client that asked it: a reopened connection neither answers it nor lets it stand for a new one', async () => {
  const first = fakeClient();
  const second = fakeClient();
  const clients = [first, second];
  const connection = createProtocolConnection({ open: async () => clients.shift() });
  const host = createHostConnection(connection);
  await connection.start();
  const runs = [];
  host.handleRequest('host/systemProxy/resolve', (params, signal) => {
    let settle;
    const done = new Promise((resolve) => (settle = resolve));
    runs.push({ params, signal, settle });
    return done;
  });
  const settle = () => new Promise((r) => setImmediate(r));
  first.emit({ type: 'serverRequest', request: { id: 'host-1', method: 'host/systemProxy/resolve', params: { n: 1 } } });
  first.emit({ type: 'serverRequest', request: { id: 'host-2', method: 'host/systemProxy/resolve', params: { n: 2 } } });
  await connection.reopen();
  assert.deepEqual(runs.map((run) => run.signal.aborted), [true, true], "the old client's requests end with it");
  runs[0].settle({ rules: 'old' });
  await settle();
  assert.deepEqual([first.answers, second.answers], [[], []], 'and are answered nowhere');

  second.emit({ type: 'serverRequest', request: { id: 'host-2', method: 'host/systemProxy/resolve', params: { n: 3 } } });
  assert.equal(runs[2].signal.aborted, false);
  runs[1].settle({ rules: 'old' });
  await settle();
  second.emit({ type: 'serverRequestResolved', params: { requestId: 'host-2' } });
  assert.equal(runs[2].signal.aborted, true, "the new core's resolved frame ends its own request");
  assert.deepEqual(second.answers, [], 'and nothing is answered on the new client');
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

// An approval card belongs to the core connection that asked it. The connection drops its client before closing it, so the lane
// is never told the link went down: it must read the live client's pending set, not keep its own, or the card of a replaced
// client could be answered through the new one (possibly on a reused request id).
test('an approval is answered only on the client that asked it: a reopened connection offers none of the old ones', async () => {
  const first = fakeClient();
  const second = fakeClient();
  const clients = [first, second];
  const connection = createProtocolConnection({ open: async () => clients.shift() });
  await connection.start();
  const lane = createCapabilityLane({ protocol: connection });
  const ask = { id: 7, method: 'item/tool/requestApproval', params: { threadId: 'pane-1', turnId: 't', itemId: 'i', order: 1, request: { name: 'shell' } } };
  first.emit({ type: 'serverRequest', request: ask });
  await connection.reopen();
  // The new core asks again under the same id for another thread; the old card must not answer it.
  second.emit({ type: 'serverRequest', request: { ...ask, params: { ...ask.params, threadId: 'pane-2' } } });
  assert.equal(await lane.resolveToolApproval('pane-1', '7', { approved: true }), false);
  const answered = (client) => client.calls.filter((call) => call.method === 'thread/approval/answer');
  assert.deepEqual([answered(first), answered(second)], [[], []]);
  await lane.resolveToolApproval('pane-2', '7', { approved: true });
  assert.deepEqual(answered(second), [{ method: 'thread/approval/answer', params: { threadId: 'pane-2', approvalId: '7', result: { approved: true } } }]);
  assert.deepEqual(answered(first), []);
});