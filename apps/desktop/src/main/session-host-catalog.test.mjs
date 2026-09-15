import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COLD_VIEW_REFRESH_MS,
  STORE_REFRESH_DEBOUNCE_MS,
  STORE_REFRESH_MIN_GAP_MS,
  SessionHostCatalog,
  catalogRelevantStoreEntry,
} from './session-host-catalog.ts';

function catalogRefreshDelay(refreshedAt = 0) {
  return Math.max(
    STORE_REFRESH_DEBOUNCE_MS,
    STORE_REFRESH_MIN_GAP_MS - (Date.now() - refreshedAt),
  );
}

function catalogOwner(overrides = {}) {
  let disposed = false;
  const published = { sessions: [], agents: [] };
  const sessionWaiters = [];
  const reads = [];
  let cold = [];
  let sessions = [{ id: 'lead' }];
  let agents = [{ id: 'worker' }];
  let failSessions = false;
  let failAgents = false;
  const held = [];
  return {
    isDisposed: () => disposed,
    async listSessions() {
      if (failSessions) throw new Error('listing failed');
      return sessions;
    },
    async listAgentPool() {
      if (failAgents) throw new Error('pool failed');
      return agents;
    },
    publishSessions(value) {
      published.sessions.push(value);
      for (const waiter of sessionWaiters.splice(0)) {
        if (published.sessions.length >= waiter.count) waiter.resolve();
        else sessionWaiters.push(waiter);
      }
    },
    publishAgents(value) { published.agents.push(value); },
    whenSessionCount(count) {
      if (published.sessions.length >= count) return Promise.resolve();
      const waiter = Promise.withResolvers();
      sessionWaiters.push({ count, resolve: waiter.resolve });
      return waiter.promise;
    },
    coldSessionIds: () => cold,
    async readSession(sessionId) {
      reads.push(sessionId);
      if (held.length) {
        const pending = held.shift();
        pending.captured.resolve();
        await pending.release.promise;
      }
    },
    dispose() { disposed = true; },
    published,
    reads,
    setCold(ids) { cold = ids; },
    failSessions() { failSessions = true; },
    failAgents() { failAgents = true; },
    setSessions(value) { sessions = value; },
    holdRead() {
      const captured = Promise.withResolvers();
      const release = Promise.withResolvers();
      held.push({ captured, release });
      return { captured: captured.promise, release: release.resolve };
    },
    ...overrides,
  };
}

function fakeWatch() {
  let callback;
  const watcher = {
    closed: false,
    on(event, fn) {
      if (event === 'error') watcher.onError = fn;
      return watcher;
    },
    close() { watcher.closed = true; },
  };
  return {
    watch(directory, options, cb) {
      callback = cb;
      watcher.directory = directory;
      watcher.options = options;
      return watcher;
    },
    emit(filename) { callback('change', filename); },
    watcher,
  };
}

test('failed listings keep the last catalog and still publish a successful agent pool', async () => {
  const lane = catalogOwner();
  const catalog = new SessionHostCatalog(lane, { directory: () => 'data' });
  lane.failSessions();
  await catalog.publishCatalogs();
  assert.deepEqual(lane.published.sessions, []);
  assert.deepEqual(lane.published.agents, [[{ id: 'worker' }]]);
});

test('store events coalesce and never refresh more often than the minimum gap', async (t) => {
  t.mock.timers.enable({
    apis: ['Date', 'setInterval', 'setTimeout'],
    now: 1_800_000_000_000,
  });
  const lane = catalogOwner();
  const watch = fakeWatch();
  const catalog = new SessionHostCatalog(lane, { directory: () => 'data', watch: watch.watch });
  catalog.ensureStoreWatcher();
  watch.emit('sessions');
  watch.emit('session-summaries.json');
  // storeRefreshedAt starts at 0; delay is max(400, 2000 - (now - 0)), so a
  // mocked epoch of 0 waits the min gap, not the 400ms debounce.
  const firstDelay = catalogRefreshDelay(0);
  t.mock.timers.tick(firstDelay - 1);
  assert.equal(lane.published.sessions.length, 0);
  const first = lane.whenSessionCount(1);
  t.mock.timers.tick(1);
  await first;
  assert.equal(lane.published.sessions.length, 1);
  const refreshedAt = Date.now();
  const second = lane.whenSessionCount(2);
  watch.emit('sessions');
  const secondDelay = catalogRefreshDelay(refreshedAt);
  t.mock.timers.tick(Math.min(STORE_REFRESH_DEBOUNCE_MS, secondDelay - 1));
  await Promise.resolve();
  assert.equal(lane.published.sessions.length, 1, 'debounce after a refresh still waits the min gap');
  t.mock.timers.tick(secondDelay - Math.min(STORE_REFRESH_DEBOUNCE_MS, secondDelay - 1));
  await second;
  assert.equal(lane.published.sessions.length, 2);
});

test('irrelevant store names do not start a catalog refresh', async (t) => {
  t.mock.timers.enable({
    apis: ['Date', 'setInterval', 'setTimeout'],
    now: 1_800_000_000_000,
  });
  const lane = catalogOwner();
  const watch = fakeWatch();
  const catalog = new SessionHostCatalog(lane, { directory: () => 'data', watch: watch.watch });
  catalog.ensureStoreWatcher();
  watch.emit('shell-jobs');
  t.mock.timers.tick(STORE_REFRESH_DEBOUNCE_MS);
  await Promise.resolve();
  assert.equal(lane.published.sessions.length, 0);
  assert.equal(catalogRelevantStoreEntry('shell-jobs'), false);
});

test('cold-view refresh skips an in-flight session and stops when none remain cold', async (t) => {
  t.mock.timers.enable({
    apis: ['Date', 'setInterval', 'setTimeout'],
    now: 1_800_000_000_000,
  });
  const lane = catalogOwner();
  lane.setCold(['agent']);
  const catalog = new SessionHostCatalog(lane, { directory: () => 'data' });
  const held = lane.holdRead();
  catalog.ensureColdViewRefresh();
  t.mock.timers.tick(COLD_VIEW_REFRESH_MS);
  await held.captured;
  t.mock.timers.tick(COLD_VIEW_REFRESH_MS);
  assert.deepEqual(lane.reads, ['agent']);
  held.release();
  await Promise.resolve();
  lane.setCold([]);
  await catalog.refreshColdViews();
  catalog.ensureColdViewRefresh();
  t.mock.timers.tick(COLD_VIEW_REFRESH_MS);
  await Promise.resolve();
  assert.equal(lane.reads.length, 1, 'an empty cold set clears the timer');
});

test('dispose closes the watcher and pending refresh timers', async (t) => {
  t.mock.timers.enable({
    apis: ['Date', 'setInterval', 'setTimeout'],
    now: 1_800_000_000_000,
  });
  const lane = catalogOwner();
  const watch = fakeWatch();
  const catalog = new SessionHostCatalog(lane, { directory: () => 'data', watch: watch.watch });
  catalog.ensureStoreWatcher();
  catalog.ensureColdViewRefresh();
  watch.emit('sessions');
  lane.dispose();
  catalog.close();
  assert.equal(watch.watcher.closed, true);
  t.mock.timers.tick(STORE_REFRESH_MIN_GAP_MS);
  t.mock.timers.tick(COLD_VIEW_REFRESH_MS);
  await Promise.resolve();
  assert.equal(lane.published.sessions.length, 0);
});
