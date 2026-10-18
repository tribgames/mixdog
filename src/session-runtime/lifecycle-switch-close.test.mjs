// The switch paths (new session, context switch, resume) close the outgoing
// session through the manager's closeSessionAsync: a barrier rename the OS
// refuses is retried on timers, so the event loop keeps ticking, and a close
// whose barrier never lands keeps the current session in place.
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-switch-close-'));
process.env.MIXDOG_DATA_DIR = root;

const { createLifecycleApi } = await import('./lifecycle-api.mjs');
const { closeSession, closeSessionAsync } = await import(
  '../runtime/agent/orchestrator/session/manager/session-close.mjs'
);
const { saveSessionAsync } = await import('../runtime/agent/orchestrator/session/store.mjs');
const { sessionPath } = await import('../runtime/agent/orchestrator/session/store/session-paths.mjs');
const { settleSessionSummaryIndex } = await import('../runtime/agent/orchestrator/session/store/listing.mjs');
const { flushSessionCloseMetrics } = await import('../runtime/agent/orchestrator/session/store/lifecycle-barriers.mjs');

test.after(async () => {
  await settleSessionSummaryIndex();
  await flushSessionCloseMetrics();
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

/** renameSync onto `target` refused with EPERM for the first `times` calls. */
function refuseRenames(t, target, times) {
  const original = fs.renameSync;
  const state = { refused: 0 };
  fs.renameSync = function (from, to, ...rest) {
    if (String(to) === target && state.refused < times) {
      state.refused++;
      const err = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
      err.code = 'EPERM';
      throw err;
    }
    return original.call(this, from, to, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.renameSync = original;
    syncBuiltinESMExports();
  });
  return state;
}

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

// Four refusals: 25 + 50 + 100 + 200 ms of backoff, a >= 375 ms freeze for the
// synchronous barrier, against a ~30 ms worst tick gap measured for the retries.
const SYNC_FREEZE_LIMIT_MS = 300;

for (const [name, run] of [
  ['newSession', (api) => api.newSession()],
  ['switchContext', (api) => api.switchContext({ cwd: 'C:\\two' })],
]) {
  test(`${name} waits out a busy barrier rename without blocking the event loop`, async (t) => {
    const id = `sess_switch_busy_${name.toLowerCase()}`;
    await saveSessionAsync(session(id));
    const before = JSON.parse(readFileSync(sessionPath(id), 'utf8')).generation;
    const refused = refuseRenames(t, sessionPath(id), 4);
    const { api, state } = lifecycle({ closeSession, closeSessionAsync }, session(id));
    const max = await maxLoopGap(() => run(api));
    assert.equal(refused.refused, 4);
    assert.ok(max < SYNC_FREEZE_LIMIT_MS, `event loop gap ${Math.round(max)}ms during the retries`);
    assert.equal(JSON.parse(readFileSync(sessionPath(id), 'utf8')).generation, before + 1, 'the barrier landed');
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
      closeSession() {
        throw new Error('the synchronous closer must not be used');
      },
      async closeSessionAsync(id, reason, options) {
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
