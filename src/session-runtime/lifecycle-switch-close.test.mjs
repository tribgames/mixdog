// The switch paths (new session, context switch, resume) close the outgoing
// session through the manager's closeSession: its barrier lands without
// blocking the event loop, and a close whose barrier never lands keeps the
// current session in place.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-switch-close-'));
process.env.MIXDOG_DATA_DIR = root;

const { createLifecycleApi } = await import('./lifecycle-api.mjs');
const { closeSession } = await import(
  '../runtime/agent/orchestrator/session/manager/session-close.mjs'
);
const { drainSessionStore, saveSessionAsync } = await import('../runtime/agent/orchestrator/session/store.mjs');
const { readDurableSessionRecord } = await import(
  '../runtime/agent/orchestrator/session/store/transcript-durability.mjs'
);
const { settleSessionSummaryIndex } = await import('../runtime/agent/orchestrator/session/store/listing.mjs');
const { flushSessionCloseMetrics } = await import('../runtime/agent/orchestrator/session/store/lifecycle-barriers.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  await flushSessionCloseMetrics();
  // The writer locks this process holds go before their folder does.
  drainSessionStore();
  rmSync(root, { recursive: true, force: true });
});

const session = (id) => ({
  id,
  owner: 'agent',
  agent: 'worker',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [{ role: 'user', content: 'hello' }],
});

/** Largest gap between 5 ms ticks while `run` settles. */
async function maxLoopGap(run) {
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last);
    last = now;
  }, 5);
  try {
    await run();
    return max;
  } finally {
    clearInterval(timer);
  }
}

function lifecycle(mgr, current) {
  const state = { session: current, route: {}, created: 0 };
  const api = createLifecycleApi({
    mgr,
    getSession: () => state.session,
    setSession: (next) => {
      state.session = next;
    },
    getRoute: () => state.route,
    setRoute: (next) => {
      state.route = next;
    },
    getConfig: () => ({}),
    getMode: () => 'full',
    getCurrentCwd: () => 'C:\\one',
    getMcpScopeId: () => null,
    getDesktopSession: () => null,
    setDesktopSession() {},
    getMemoryModPromise: () => null,
    statusRoutes: null,
    cancelBackgroundTasks: () => {},
    clearRoutePreparation() {},
    invalidateContextStatusCache() {},
    invalidatePreSessionToolSurface() {},
    applyResolvedCwd: async () => {},
    resolveRoute: (_config, next) => next,
    refreshRouteEffort: async () => {},
    createCurrentSession: async () => {
      state.created++;
      state.session = { id: 'fresh', messages: [] };
      return state.session;
    },
  });
  return { api, state };
}

// The barrier is a record in the session's log, written off the thread: a
// switch never freezes the loop on it.
const SYNC_FREEZE_LIMIT_MS = 300;

for (const [name, run] of [
  ['newSession', (api) => api.newSession()],
  ['switchContext', (api) => api.switchContext({ cwd: 'C:\\two' })],
]) {
  test(`${name} lands the outgoing session's barrier without blocking the event loop`, async () => {
    const id = `sess_switch_busy_${name.toLowerCase()}`;
    await saveSessionAsync(session(id));
    const before = readDurableSessionRecord(id).generation;
    const { api, state } = lifecycle({ closeSession }, session(id));
    const max = await maxLoopGap(() => run(api));
    assert.ok(max < SYNC_FREEZE_LIMIT_MS, `event loop gap ${Math.round(max)}ms during the close`);
    assert.equal(readDurableSessionRecord(id).generation, before + 1, 'the barrier landed');
    assert.notEqual(state.session?.id, id, 'the outgoing session was left');
  });
}

for (const [name, run] of [
  ['newSession', (api) => api.newSession()],
  ['switchContext', (api) => api.switchContext({ cwd: 'C:\\two' })],
  ['resume', (api) => api.resume('next')],
]) {
  test(`${name} keeps the current session when the close barrier fails`, async () => {
    const current = session('sess_keep_current');
    const closes = [];
    const resumed = { ...session('next'), cwd: 'C:\\one' };
    const mgr = {
      async closeSession(id, reason, options) {
        closes.push([id, reason, options]);
        return false;
      },
      async resumeSession() {
        return resumed;
      },
    };
    const { api, state } = lifecycle(mgr, current);
    await assert.rejects(run(api), /session close failed/);
    assert.equal(closes.length, 1);
    assert.equal(closes[0][0], 'sess_keep_current');
    assert.equal(state.session, current, 'the current session stays in place');
    assert.equal(state.created, 0, 'no replacement session was created');
  });
}
