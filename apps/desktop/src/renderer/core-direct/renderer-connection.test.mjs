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
      subscribe: (l) => {
        storeListeners.add(l);
        return () => storeListeners.delete(l);
      },
    },
    async call(method, params) {
      calls.push({ method, params });
      return answer(method, params);
    },
    notify: (method, params) => calls.push({ notify: method, params }),
    subscribeApp: async () => undefined,
    resumeThread: async (threadId, win) => {
      calls.push({ method: 'thread/resume', params: { threadId, window: win } });
      return {};
    },
    unsubscribeThread: async (threadId) => void calls.push({ method: 'thread/unsubscribe', params: { threadId } }),
    respond: () => undefined,
    pendingServerRequests: () => [],
    on: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    close: async () => undefined,
    emit: (event) =>
      listeners.forEach((l) => {
        l(event);
      }),
  };
}
async function opened(answer) {
  const client = fakeClient(answer);
  const connection = createRendererConnection({ open: async () => client });
  await connection.start();
  return { client, connection };
}
const win = () => ({
  seen: [],
  lost: [],
  pushes: [],
  push(p) {
    this.pushes.push(p);
  },
  notification(m, p) {
    this.seen.push([m, p]);
  },
  loginFeedLost(f) {
    this.lost.push(f);
  },
});

test('capability_lane_runs', async () => {
  const { client, connection } = await opened(async (method) =>
    method === 'thread/start' ? { thread: { id: 't1' } } : { ok: true }
  );
  const lane = createCapabilityLane({ protocol: connection });
  await lane.stopShellJob('s1', 'task1').catch(() => undefined);
  assert.ok(client.calls.length > 0, 'the lane sent its requests through the connection');
  assert.equal(connection.snapshot().status, 'ready');
  assert.equal(connection.snapshot().epoch, 'e1');
});

test('service_lane_resume_unsubscribe', async () => {
  const { client, connection } = await opened();
  const lane = createServiceLane({ protocol: connection, snapshot: () => ({}) });
  assert.equal(await lane.call('setVisibleSessions', [['a', 'b']]), true);
  assert.equal(await lane.call('setVisibleSessions', [['b']]), true);
  // Acceptance answers the call; the lane brings each thread there after it, so the unsubscribe follows the reply.
  const sent = () =>
    client.calls
      .filter((c) => /^thread\/(resume|unsubscribe)$/.test(c.method))
      .map((c) => [c.method, c.params.threadId]);
  for (let turn = 0; turn < 50 && sent().length < 3; turn++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent(), [
    ['thread/resume', 'a'],
    ['thread/resume', 'b'],
    ['thread/unsubscribe', 'a'],
  ]);
  lane.dispose();
});

test('watch_per_connection', async () => {
  const { client, connection } = await opened();
  const w = win();
  const detach = connection.attach(w);
  await connection.watchFiles(w, { watchId: 'w1', path: '/x' });
  assert.deepEqual(
    client.calls.at(-1),
    { method: 'fs/watch', params: { watchId: 'w1', path: '/x' } },
    'the id is sent as the caller chose it'
  );
  client.emit({
    type: 'notification',
    notification: { method: 'fs/changed', params: { watchId: 'w1', changedPaths: ['/x/a'] } },
  });
  assert.equal(w.seen[0][0], 'fs/changed');
  await connection.viewPorts(w, true);
  await connection.viewPorts(win(), true);
  assert.equal(
    client.calls.filter((c) => c.method === 'system/ports/subscribe').length,
    1,
    'the first viewer subscribes'
  );
  detach();
  await new Promise((r) => setImmediate(r));
  assert.ok(
    client.calls.some((c) => c.method === 'fs/unwatch' && c.params.watchId === 'w1'),
    'closing the window releases its watch'
  );
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

test('a watch whose restore the connection dropped again is restored at the next ready; one the core refused is let go', async () => {
  let failRestore = null;
  const { client, connection } = await opened(async (method, params) => {
    if (method === 'fs/watch' && failRestore) throw failRestore(params.watchId);
    return {};
  });
  const w = win();
  connection.attach(w);
  await connection.watchFiles(w, { watchId: 'w1', path: '/a' });
  await connection.watchFiles(w, { watchId: 'w2', path: '/b' });
  failRestore = (watchId) =>
    Object.assign(new Error(watchId), {
      detail:
        watchId === 'w1'
          ? { kind: 'connectionLost' }
          : { kind: 'rpc', code: -32603, reason: undefined, message: 'ENOENT', data: undefined },
    });
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  await new Promise((r) => setImmediate(r));
  failRestore = null;
  client.calls.length = 0;
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  assert.deepEqual(
    client.calls.filter((c) => c.method === 'fs/watch').map((c) => c.params.watchId),
    ['w1']
  );
});

test('restore_line_separates_attempted_from_settled', async () => {
  const lines = [];
  const client = fakeClient(async (method, params) => {
    if (method === 'fs/watch' && params.watchId === 'w2') throw new Error('refused');
    return {};
  });
  const connection = createRendererConnection({
    open: async () => client,
    log: (event, fields) => lines.push({ event, ...fields }),
  });
  await connection.start();
  const w = win();
  connection.attach(w);
  await connection.watchFiles(w, { watchId: 'w1' }).catch(() => undefined);
  await connection.watchFiles(w, { watchId: 'w2' }).catch(() => undefined);
  lines.length = 0;
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(
    lines.map((l) => l.event),
    ['core-scoped-feeds-restore-started', 'core-scoped-feeds-restore-settled'],
    'the attempt first, its outcome after'
  );
  const [started, settled] = lines;
  assert.equal('restored' in started, false, 'the attempt carries no outcome');
  assert.equal(
    settled.restored + settled.lost + settled.failed,
    started.attempted.fsWatches + started.attempted.feeds + started.attempted.ports
  );
  assert.ok(settled.restored >= 1);
});

test('errors_mapped', async () => {
  const rpc = Object.assign(new Error('x'), {
    detail: {
      kind: 'rpc',
      code: -32602,
      data: { reason: 'invalidParams', path: 'p', expected: 'path must be a string' },
    },
  });
  const { connection } = await opened(async () => {
    throw rpc;
  });
  await assert.rejects(
    connection.call('project/list', {}),
    (e) => e instanceof TypeError && e.message === 'path must be a string'
  );
  await assert.rejects(connection.watchFiles(win(), { watchId: 'w' }), TypeError);
});

test('login_feed_followed_and_lost', async () => {
  const { client, connection } = await opened(async (method) =>
    method === 'github/login/start' ? { flowId: 'f1' } : {}
  );
  const w = win();
  connection.attach(w);
  await connection.call('github/login/start', {});
  assert.ok(client.calls.some((c) => c.method === 'feed/subscribe' && c.params.feedId === 'login:f1'));
  client.emit({
    type: 'notification',
    notification: { method: 'login/updated', params: { flowId: 'f1', state: { state: 'complete' } } },
  });
  assert.deepEqual(connection.loginFeed('f1'), { state: { state: 'complete' }, lost: false });
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  assert.deepEqual(w.lost, ['f1']);
  assert.equal(connection.loginFeed('unknown').lost, true);
});

test('sender_hook_and_reopen', async () => {
  const clients = [];
  const connection = createRendererConnection({
    open: async () => {
      clients.push(fakeClient());
      return clients.at(-1);
    },
  });
  await connection.start();
  const ctx = createDirectContext(connection);
  const seen = [];
  ctx.setSender(async (c, method, params) => {
    seen.push([c === clients[0], method, params]);
    return 'sent';
  });
  assert.equal(await ctx.call('a/b', { n: 1 }), 'sent');
  assert.deepEqual(seen, [[true, 'a/b', { n: 1 }]]);
  let replaced = 0;
  connection.onReplaced(() => replaced++);
  const reopening = [];
  connection.onReopening(() => reopening.push(connection.status));
  await connection.reopen();
  assert.equal(replaced, 1);
  assert.deepEqual(reopening, ['reconnecting']);
  assert.equal(connection.protocolClient(), clients[1]);
});

test('activity_rate_limited', async () => {
  const { client, connection } = await opened();
  connection.noteUserInput(0);
  connection.noteUserInput(30_000);
  connection.noteUserInput(61_000);
  assert.equal(client.calls.filter((c) => c.notify === 'client/activity').length, 2);
});

const absent = Object.assign(new Error('x'), {
  detail: { kind: 'rpc', code: -32602, data: { reason: 'invalidParams' } },
});
const mediaUpdate = (value) => ({
  method: 'job/section',
  params: { section: 'mediaJobs', key: 'j1', revision: 1, value },
  feed: { id: 'media:j1' },
});

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
  assert.ok(
    connection.snapshot().entries.some((e) => e.section === 'mediaJobs' && e.key === 'j1'),
    'a replaced mirror keeps the held sections'
  );
  assert.equal(client.calls.filter((c) => c.method === 'feed/subscribe').length, 1, 'the first watcher subscribes');
  await connection.unwatchFeed(a, 'media:j1');
  assert.equal(a.pushes.at(-1).changes[0].entry, null, 'leaving removes the held sections from its mirror');
  assert.ok(!client.calls.some((c) => c.method === 'feed/unsubscribe'), 'another watcher remains');
  await connection.unwatchFeed(b, 'media:j1');
  assert.ok(
    client.calls.some((c) => c.method === 'feed/unsubscribe'),
    'the last one leaving unsubscribes'
  );
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

test('a first open that fails is opened again by the next call, once for the callers waiting', async () => {
  let opens = 0;
  const client = fakeClient();
  const connection = createRendererConnection({
    open: async () => {
      opens += 1;
      if (opens === 1) throw new Error('the port did not arrive');
      return client;
    },
  });
  await assert.rejects(connection.start(), /port did not arrive/);
  assert.equal(connection.status, 'closed');
  assert.equal(connection.link().closed?.cause, 'failed');
  assert.match(connection.link().closed?.message ?? '', /port did not arrive/);
  const [a, b] = await Promise.all([
    connection.call('thread/read', { threadId: 't' }),
    connection.call('thread/read', { threadId: 't' }),
  ]);
  assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
  assert.equal(opens, 2, 'one new open served both calls');
  assert.equal(connection.status, 'ready');
  assert.equal(connection.link().closed, null);
});

test('a connection the core refused for its version says why, and a call or a reconnect opens it anew', async () => {
  let opens = 0;
  const clients = [fakeClient(), fakeClient()];
  const connection = createRendererConnection({ open: async () => clients[opens++] });
  await connection.start();
  clients[0].emit({
    type: 'status',
    status: {
      state: 'closed',
      reason: { kind: 'versionRefused', reason: 'clientOutdated', serverVersion: '2', clientVersion: '1' },
    },
  });
  assert.equal(connection.status, 'closed');
  assert.equal(connection.link().closed?.cause, 'clientOutdated');
  await connection.reopen();
  assert.equal(connection.status, 'ready');
  assert.equal(connection.link().closed, null);
  clients[1].emit({ type: 'status', status: { state: 'reconnecting', attempt: 3 } });
  assert.deepEqual(connection.link(), { attempt: 3, closed: null });
  assert.equal(opens, 2);
});

test('ports_viewed_before_the_first_open_subscribe_once_it_opens', async () => {
  const client = fakeClient();
  let release;
  const connection = createRendererConnection({
    open: () => new Promise((resolve) => (release = () => resolve(client))),
  });
  const starting = connection.start();
  const viewing = connection.viewPorts(win(), true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(client.calls, []);
  release();
  await starting;
  await viewing;
  assert.deepEqual(
    client.calls.map((c) => c.method),
    ['system/ports/subscribe']
  );
});

test('rejected stale watchFeed does not delete a replacement route for the same feedId', async () => {
  const first = Promise.withResolvers();
  let calls = 0;
  const { client, connection } = await opened(async (method, params) => {
    if (method === 'feed/subscribe' && params.feedId === 'lsp:/proj') {
      calls += 1;
      if (calls === 1) return first.promise;
    }
    return { ok: true };
  });
  const w = win();
  connection.attach(w);

  const staleWatch = connection.watchFeed(w, 'lsp:/proj');
  await new Promise((r) => setImmediate(r));
  await connection.unwatchFeed(w, 'lsp:/proj');
  assert.deepEqual(await connection.watchFeed(w, 'lsp:/proj'), { absent: false });

  first.reject(new Error('stale failure'));
  await assert.rejects(staleWatch, /stale failure/);

  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:/proj' },
      params: { section: 'lspDiagnostics', key: 'file:///proj/a.ts', revision: 1, value: { uri: 'file:///proj/a.ts' } },
    },
  });
  assert.equal(w.pushes.at(-1)?.changes?.[0]?.key, 'file:///proj/a.ts', 'replacement route still delivers updates');
});

test('dropFeed on absent reconnect and feed/closed notifies feedLost and clears held entries', async () => {
  let missing = false;
  const { client, connection } = await opened(async (method) => {
    if (method === 'feed/subscribe' && missing) throw absent;
    return { ok: true };
  });
  const lostFeeds = [];
  const w = { ...win(), feedLost: (id) => lostFeeds.push(id) };
  connection.attach(w);

  await connection.watchFeed(w, 'lsp:/wt');
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:/wt' },
      params: { section: 'lspDiagnostics', key: 'file:///wt/a.ts', revision: 1, value: { uri: 'file:///wt/a.ts' } },
    },
  });
  missing = true;
  client.emit({ type: 'status', status: { state: 'reconnecting' } });
  client.emit({ type: 'status', status: { state: 'ready' } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(lostFeeds, ['lsp:/wt']);
  assert.equal(w.pushes.at(-1)?.changes?.[0]?.entry, null);

  missing = false;
  await connection.watchFeed(w, 'lsp:/wt');
  client.emit({
    type: 'notification',
    notification: { method: 'feed/closed', feed: { id: 'lsp:/wt' }, params: { feedId: 'lsp:/wt' } },
  });
  assert.deepEqual(lostFeeds, ['lsp:/wt', 'lsp:/wt']);
});

test('failed refresh watchFeed drops route so subsequent ordinary watchFeed resubscribes', async () => {
  let failNext = false;
  const { client, connection } = await opened(async (method, params) => {
    if (method === 'feed/subscribe' && params.feedId === 'lsp:/refresh-fail' && failNext) {
      failNext = false;
      throw new Error('temporary failure');
    }
    return { ok: true };
  });
  const w = win();
  connection.attach(w);

  await connection.watchFeed(w, 'lsp:/refresh-fail');
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:/refresh-fail' },
      params: {
        section: 'lspDiagnostics',
        key: 'file:///refresh-fail/a.ts',
        revision: 1,
        value: { uri: 'file:///refresh-fail/a.ts' },
      },
    },
  });
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === 'lsp:/refresh-fail').length,
    1
  );

  // Refresh fails with a non-absent error: route must be dropped and held entries cleared.
  failNext = true;
  await assert.rejects(connection.watchFeed(w, 'lsp:/refresh-fail', { refresh: true }), /temporary failure/);
  assert.equal(w.pushes.at(-1)?.changes?.[0]?.entry, null, 'failed refresh clears stale held entries');
  assert.equal(connection.snapshot().entries.filter((e) => e.section === 'lspDiagnostics').length, 0);

  // Subsequent ordinary watchFeed (without refresh) must actually send feed/subscribe again.
  await connection.watchFeed(w, 'lsp:/refresh-fail');
  assert.equal(
    client.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === 'lsp:/refresh-fail').length,
    3
  );
  client.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:/refresh-fail' },
      params: {
        section: 'lspDiagnostics',
        key: 'file:///refresh-fail/b.ts',
        revision: 1,
        value: { uri: 'file:///refresh-fail/b.ts' },
      },
    },
  });
  assert.equal(w.pushes.at(-1)?.changes?.[0]?.key, 'file:///refresh-fail/b.ts');
});

test('refresh watchFeed that fails awaiting connection reopen drops stale route so next watch resubscribes', async () => {
  let opens = 0;
  const firstClient = fakeClient();
  const thirdClient = fakeClient();
  const connection = createRendererConnection({
    open: async () => {
      opens += 1;
      if (opens === 1) return firstClient;
      if (opens === 2) throw new Error('reopen failed');
      return thirdClient;
    },
  });
  await connection.start();
  const w = win();
  connection.attach(w);

  await connection.watchFeed(w, 'lsp:/reopen-fail');
  firstClient.emit({
    type: 'notification',
    notification: {
      method: 'lsp/diagnostics/updated',
      feed: { id: 'lsp:/reopen-fail' },
      params: {
        section: 'lspDiagnostics',
        key: 'file:///reopen-fail/a.ts',
        revision: 1,
        value: { uri: 'file:///reopen-fail/a.ts' },
      },
    },
  });

  // Drop the connection so the next watchFeed must reopen via connectedAfterFirstOpen().
  firstClient.emit({ type: 'status', status: { state: 'closed' } });
  await assert.rejects(connection.watchFeed(w, 'lsp:/reopen-fail', { refresh: true }), /reopen failed/);
  assert.equal(w.pushes.at(-1)?.changes?.[0]?.entry, null, 'stale held entries cleared when refresh reopen fails');

  // When the connection succeeds later, an ordinary watchFeed (no refresh) must subscribe on the new client.
  await connection.watchFeed(w, 'lsp:/reopen-fail');
  assert.equal(
    thirdClient.calls.filter((c) => c.method === 'feed/subscribe' && c.params.feedId === 'lsp:/reopen-fail').length,
    1,
    'ordinary watchFeed resubscribes instead of hitting an orphaned route'
  );
});
