// RendererConnection over a fake ProtocolClient: the shared lanes run against it, the watches and the ports feed are this
// connection own, and a core failure comes out as the IPC path returned it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCapabilityLane } from '../../shared/core-lanes/capability-route.ts';
import { createServiceLane } from '../../shared/core-lanes/service-route.ts';
import { createRendererConnection } from './renderer-connection.ts';
import { createDirectContext } from './context.ts';

function fakeClient(answer = async () => ({ ok: true })) {
  const calls = [];
  const listeners = new Set();
  const storeListeners = new Set();
  return {
    calls,
    status: { state: 'ready' },
    store: {
      sections: () => [],
      section: () => undefined,
      appFeed: () => ({ epoch: 'e1' }),
      subscribe: (l) => (storeListeners.add(l), () => storeListeners.delete(l)),
    },
    async call(method, params) {
      calls.push({ method, params });
      return answer(method, params);
    },
    notify: (method, params) => calls.push({ notify: method, params }),
    subscribeApp: async () => undefined,
    resumeThread: async (threadId, win) => (calls.push({ method: 'thread/resume', params: { threadId, window: win } }), {}),
    unsubscribeThread: async (threadId) => void calls.push({ method: 'thread/unsubscribe', params: { threadId } }),
    respond: () => undefined,
    pendingServerRequests: () => [],
    on: (l) => (listeners.add(l), () => listeners.delete(l)),
    close: async () => undefined,
    emit: (event) => listeners.forEach((l) => l(event)),
  };
}
async function opened(answer) {
  const client = fakeClient(answer);
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  return { client, connection };
}
const win = () => ({ seen: [], lost: [], pushes: [], push(p) { this.pushes.push(p); }, notification(m, p) { this.seen.push([m, p]); }, loginFeedLost(f) { this.lost.push(f); } });

test('capability_lane_runs', async () => {
  const { client, connection } = await opened(async (method) => (method === 'thread/start' ? { thread: { id: 't1' } } : { ok: true }));
  const lane = createCapabilityLane({ protocol: connection });
  await lane.stopShellJob('s1', 'task1').catch(() => undefined);
  assert.ok(client.calls.length > 0, 'the lane sent its requests through the connection');
  assert.equal(connection.snapshot().status, 'ready');
  assert.equal(connection.snapshot().epoch, 'e1');
});

test('service_lane_resume_unsubscribe', async () => {
  const { client, connection } = await opened();
  const lane = createServiceLane({ protocol: connection, snapshot: () => ({}) });
  await lane.call('setVisibleSessions', [['a', 'b']]);
  await lane.call('setVisibleSessions', [['b']]);
  const sent = client.calls.filter((c) => /^thread\/(resume|unsubscribe)$/.test(c.method)).map((c) => [c.method, c.params.threadId]);
  assert.deepEqual(sent, [['thread/resume', 'a'], ['thread/resume', 'b'], ['thread/unsubscribe', 'a']]);
});

test('watch_per_connection', async () => {
  const { client, connection } = await opened();
  const w = win();
  const detach = connection.attach(w);
  await connection.watchFiles(w, { watchId: 'w1', path: '/x' });
  assert.deepEqual(client.calls.at(-1), { method: 'fs/watch', params: { watchId: 'w1', path: '/x' } }, 'the id is sent as the caller chose it');
  client.emit({ type: 'notification', notification: { method: 'fs/changed', params: { watchId: 'w1', changedPaths: ['/x/a'] } } });
  assert.equal(w.seen[0][0], 'fs/changed');
  await connection.viewPorts(w, true);
  await connection.viewPorts(win(), true);
  assert.equal(client.calls.filter((c) => c.method === 'system/ports/subscribe').length, 1, 'the first viewer subscribes');
  detach();
  await new Promise((r) => setImmediate(r));
  assert.ok(client.calls.some((c) => c.method === 'fs/unwatch' && c.params.watchId === 'w1'), 'closing the window releases its watch');
});

test('watches_restored_after_reconnect', async () => {
  const { client, connection } = await opened();
  const w = win();
  connection.attach(w);
  await connection.watchFiles(w, { watchId: 'w1' });
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  assert.equal(client.calls.filter((c) => c.method === 'fs/watch').length, 2);
});

test('errors_mapped', async () => {
  const rpc = Object.assign(new Error('x'), { detail: { kind: 'rpc', code: -32602, data: { reason: 'invalidParams', path: 'p', expected: 'path must be a string' } } });
  const { connection } = await opened(async () => {
    throw rpc;
  });
  await assert.rejects(connection.call('project/list', {}), (e) => e instanceof TypeError && e.message === 'path must be a string');
  await assert.rejects(connection.watchFiles(win(), { watchId: 'w' }), TypeError);
});

test('login_feed_followed_and_lost', async () => {
  const { client, connection } = await opened(async (method) => (method === 'github/login/start' ? { flowId: 'f1' } : {}));
  const w = win();
  connection.attach(w);
  await connection.call('github/login/start', {});
  assert.ok(client.calls.some((c) => c.method === 'feed/subscribe' && c.params.feedId === 'login:f1'));
  client.emit({ type: 'notification', notification: { method: 'login/updated', params: { flowId: 'f1', state: { state: 'complete' } } } });
  assert.deepEqual(connection.loginFeed('f1'), { state: { state: 'complete' }, lost: false });
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  assert.deepEqual(w.lost, ['f1']);
  assert.equal(connection.loginFeed('unknown').lost, true);
});

test('sender_hook_and_reopen', async () => {
  const clients = [];
  const connection = createRendererConnection({ open: async () => (clients.push(fakeClient()), clients.at(-1)) });
  await connection.start();
  const ctx = createDirectContext(connection);
  const seen = [];
  ctx.setSender(async (c, method, params) => (seen.push([c === clients[0], method, params]), 'sent'));
  assert.equal(await ctx.call('a/b', { n: 1 }), 'sent');
  assert.deepEqual(seen, [[true, 'a/b', { n: 1 }]]);
  let replaced = 0;
  connection.onReplaced(() => replaced++);
  await connection.reopen();
  assert.equal(replaced, 1);
  assert.equal(connection.protocolClient(), clients[1]);
});

test('activity_rate_limited', async () => {
  const { client, connection } = await opened();
  connection.noteUserInput(0);
  connection.noteUserInput(30_000);
  connection.noteUserInput(61_000);
  assert.equal(client.calls.filter((c) => c.notify === 'client/activity').length, 2);
});

const absent = Object.assign(new Error('x'), { detail: { kind: 'rpc', code: -32602, data: { reason: 'invalidParams' } } });
const mediaUpdate = (value) => ({ method: 'job/section', params: { section: 'mediaJobs', key: 'j1', revision: 1, value }, feed: { id: 'media:j1' } });

test('scoped_feed_held_for_late_watcher_and_removed', async () => {
  const { client, connection } = await opened();
  const a = win();
  const b = win();
  connection.attach(a);
  connection.attach(b);
  assert.deepEqual(await connection.call('feed/subscribe', { feedId: 'media:j1' }), { absent: false });
  client.emit({ type: 'notification', notification: mediaUpdate({ s: 1 }) });
  assert.equal(a.pushes[0].changes[0].entry.value.s, 1);
  await connection.watchFeed(b, 'media:j1');
  assert.equal(b.pushes[0].changes[0].entry.value.s, 1, 'a late watcher is given what the feed holds');
  assert.ok(connection.snapshot().entries.some((e) => e.section === 'mediaJobs' && e.key === 'j1'), 'a replaced mirror keeps the held sections');
  assert.equal(client.calls.filter((c) => c.method === 'feed/subscribe').length, 1, 'the first watcher subscribes');
  await connection.unwatchFeed(a, 'media:j1');
  assert.equal(a.pushes.at(-1).changes[0].entry, null, 'leaving removes the held sections from its mirror');
  assert.ok(!client.calls.some((c) => c.method === 'feed/unsubscribe'), 'another watcher remains');
  await connection.unwatchFeed(b, 'media:j1');
  assert.ok(client.calls.some((c) => c.method === 'feed/unsubscribe'), 'the last one leaving unsubscribes');
  await assert.rejects(connection.call('feed/subscribe', { feedId: 'login:x' }), /not available/);
});

test('scoped_feed_absent_and_resubscribed_after_reconnect', async () => {
  let missing = true;
  const { client, connection } = await opened(async (method) => {
    if (method === 'feed/subscribe' && missing) throw absent;
    return { ok: true };
  });
  const w = win();
  connection.attach(w);
  assert.deepEqual(await connection.watchFeed(w, 'media:j9'), { absent: true });
  missing = false;
  await connection.watchFeed(w, 'media:j1');
  client.emit({ type: 'notification', notification: mediaUpdate({ s: 1 }) });
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  assert.equal(client.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === 'media:j1').length, 2);
  missing = true;
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(w.pushes.at(-1).changes[0].entry, null, 'a feed the core no longer holds is removed');
  missing = false;
});

test('scoped_feed_restore_failure_is_a_feed_error', async () => {
  let fail = false;
  const { client, connection } = await opened(async (method) => {
    if (method === 'feed/subscribe' && fail) throw new Error('down');
    return {};
  });
  const w = win();
  await connection.watchFeed(w, 'media:j1');
  fail = true;
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.pushes.at(-1), { kind: 'feedError', feedId: 'media:j1', message: 'down' });
});
