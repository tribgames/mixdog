#!/usr/bin/env node
// How long Node's snapshot cleanups wait between attempts when the snapshot stays busy: the REAL
// `removeTurnSnapshots` (session-runtime/workspace/side-checkouts.mjs, reached through the real
// `createWorkspaceTransitions` with its own default bounds, `snapshotRetryMs = 2_000` and
// `snapshotRetryLimit = 20`) and the REAL `releaseWorkerSnapshots`
// (runtime/shared/worktrees/worker-snapshots.mjs, its own `RETRY_MS` / `RETRY_LIMIT`). The managed-
// worktree backend is a stub whose `removeSessionSnapshots` always reports the snapshot `in-use`.
// Time is node:test's mock clock (setTimeout, with node:timers/promises routed onto it, and Date), ticked 1 ms
// at a time, so each wait is read off the clock the attempts themselves ran on. Rust
// `mixdog_scm::worktree::snapshots` (`Retry::TURN`, `Retry::WORKER`) must wait the same.
//
//   node benchmarks/rust-core/recorders/record-snapshot-cleanup-schedule.mjs [--tree <dir>]
//
// Output: native/core/fixtures/snapshot-cleanup-schedule/golden.json.
process.env.TZ = 'UTC';
process.env.MIXDOG_SKIP_USER_DATA_BACKUP = '1';
import { registerHooks } from 'node:module';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

// node:test's mock clock does not cover node:timers/promises, which both cleanups wait on. Their
// `setTimeout(ms, value, { signal })` is replaced, for the modules loaded below, by the same call
// over the global `setTimeout` (which the mock does cover). Nothing else of the product changes.
const aborted = "Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })";
const FAKE_TIMERS_PROMISES = `
export const setTimeout = (ms, value, { signal } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(${aborted});
  const timer = globalThis.setTimeout(() => resolve(value), ms);
  signal?.addEventListener('abort', () => {
    globalThis.clearTimeout(timer);
    reject(${aborted});
  }, { once: true });
});
export const setImmediate = (value) => new Promise((resolve) => globalThis.setImmediate(() => resolve(value)));
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:timers/promises' || specifier === 'timers/promises') {
      return { url: 'data:text/javascript,' + encodeURIComponent(FAKE_TIMERS_PROMISES), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const tree = resolveTree(parseArgs());const finalDir = join(FIXTURES_ROOT, 'snapshot-cleanup-schedule');
const stage = stageSet(finalDir);
const recorder = 'benchmarks/rust-core/recorders/record-snapshot-cleanup-schedule.mjs';
const at = (path) => importFrom(tree, path);
const { createWorkspaceTransitions } = await at('src/session-runtime/workspace/transitions.mjs');
const { createWorkerSnapshot, releaseWorkerSnapshots } = await at('src/runtime/shared/worktrees/worker-snapshots.mjs');

const BASE = 'a'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'snapshot-schedule-'));
const project = join(root, 'project');
mkdirSync(join(project, '.mixdog'), { recursive: true });
writeFileSync(join(project, '.mixdog', 'project.id'), 'pid-snapshot-schedule');

/** The stub backend: every removal finds the snapshot busy. Each call is stamped on the mock clock. */
function busyBackend() {
  const stamps = [];
  const made = new Map();
  return {
    stamps,
    manager: {
      async createSnapshotWorktree(input) {
        made.set(input.txId, `snapshot-${made.size + 1}`);
        return { id: made.get(input.txId), kind: 'snapshot', path: join(root, 'snap'), baseCommit: BASE };
      },
      async removeSessionSnapshots(_id, { txIds }) {
        stamps.push(Date.now());
        return { removed: [], kept: txIds.map((tx) => ({ id: made.get(tx), txId: tx, reason: 'in-use' })) };
      },
    },
  };
}

const settle = () => new Promise((done) => setImmediate(done));
/** Ticks the mock clock 1 ms at a time, letting every ready continuation run after each tick. */
async function run(ms) {
  // The first attempt and the timer for the second are both set before the clock moves.
  for (let i = 0; i < 10; i += 1) await settle();
  for (let i = 0; i < ms; i += 1) {
    mock.timers.tick(1);
    await settle();
  }
}
const report = (stamps, start, firstDelayMs) => ({
  firstDelayMs,
  attempts: stamps.length,
  waitsMs: stamps.slice(1).map((stamp, i) => stamp - stamps[i]),
  firstAttemptAtMs: stamps[0] - start,
});

mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });

async function turn(snapshotRetryMs, horizonMs) {
  const backend = busyBackend();
  const session = { id: 'sess_snapshot_schedule', cwd: project, desktopSession: { classification: 'project', projectPath: project }, messages: [] };
  let n = 0;
  const api = createWorkspaceTransitions({
    getSession: () => session,
    getCurrentCwd: () => project,
    getDesktopSession: () => session.desktopSession,
    getConfig: () => null,
    applyResolvedCwd: () => {},
    setDesktopSession: () => {},
    persistSession: async () => {},
    refreshWorkspaceContext: async () => {},
    getActiveTurnCount: () => 0,
    agentStatusState: () => ({ agentWorkers: [], agentJobs: [] }),
    countOwnShellJobs: async () => 0,
    listLiveSessions: () => [],
    findRegisteredProject: async (path) => (path === project ? project : null),
    listStoredSessionIds: async () => [],
    sessionManager: { getSessionRuntime: () => null },
    manager: backend.manager,
    inspectProject: async (path) => ({ projectPath: path, repoCommonDir: join(project, '.git'), headCommit: BASE, currentBranch: 'main' }),
    newTxId: () => `tx-${(n += 1)}`,
    ...(snapshotRetryMs === undefined ? {} : { snapshotRetryMs }),
  });
  const leave = await api.admitTurnWorkspace({});
  await api.createSnapshot({ commit: BASE, repoCommonDir: join(project, '.git') });
  const start = Date.now();
  leave();
  await run(horizonMs);
  api.dispose();
  return report(backend.stamps, start, snapshotRetryMs ?? 'default');
}

async function worker(retryMs, horizonMs) {
  const backend = busyBackend();
  const sessionId = `worker-schedule-${retryMs ?? 'default'}`;
  await createWorkerSnapshot({ sessionId, projectPath: project, commit: BASE, manager: backend.manager });
  const start = Date.now();
  let done = null;
  const release = releaseWorkerSnapshots(sessionId, { manager: backend.manager, ...(retryMs === undefined ? {} : { retryMs }) }).then((result) => {
    done = Date.now() - start;
    return result;
  });
  await run(horizonMs);
  const result = await release;
  return { ...report(backend.stamps, start, retryMs ?? 'default'), finishedAtMs: done, kept: result.kept.map((row) => row.reason) };
}

// The horizon is past the last wait: the default turn schedule ends at 958 s.
const golden = {
  turn: { default: await turn(undefined, 1_000_000), firstDelay10: await turn(10, 20_000) },
  worker: { default: await worker(undefined, 40_000), firstDelay1: await worker(1, 100) },
};
mock.timers.reset();

writeJson(join(stage, 'golden.json'), golden);
writeSetManifest(stage, { set: 'snapshot-cleanup-schedule', recorder, command: 'node ' + recorder + ' --tree <tree>', identityTree: tree });
commitStage(stage, finalDir);
