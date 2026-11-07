#!/usr/bin/env node
// Golden twin of the count of an owner's busy agent jobs, as the workspace guard computes it:
// `assertLeadIdle` (`session-runtime/workspace/activity-guards.mjs`) filters the status's
// `agentJobs` (the `surface: 'agent'` rows of `listBackgroundTasks` for the Lead's scope) by
// `BUSY_JOB_STATES` and refuses with the count in `details.jobs`. Each scenario drives the real
// background-task table and asks the real guard, so the count is Node's own, not a reimplementation.
//
//   node benchmarks/rust-core/recorders/record-job-busy-count.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const START = Date.parse('2026-03-01T10:00:00.000Z');
let clock = START;
Date.now = () => clock;

const sandbox = mkdtempSync(join(tmpdir(), 'job-busy-count-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const tree = resolveTree(parseArgs());
const bg = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');
const { createActivityGuards } = await importFrom(tree, 'src/session-runtime/workspace/activity-guards.mjs');
const { createJobRender } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/job-render.mjs');
const { liveAgentStatusRow } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/session-progress.mjs');

const ctxOf = (scope) => ({ callerSessionId: scope?.session || undefined, clientHostPid: scope?.pid || undefined });

/** The guard's own verdict for the rows the job view lists in `scope`: the busy-job count. */
async function busyJobs(scope, sessions) {
  // The job view as the status pulse reads it (`listJobs`: scope, then the worker session's own
  // `clientHostPid` against the scope's process); only the worker sessions' pids are given.
  const progress = {
    jobWorkerSnapshot: (sessionId) => (Object.hasOwn(sessions, sessionId) ? { clientHostPid: sessions[sessionId] } : null),
    sessionProgressExtras: () => ({}),
    memorySession: () => null,
  };
  const rows = createJobRender({ progress }).listJobs(ctxOf(scope), { memoryOnly: true }).map(liveAgentStatusRow);
  const guards = createActivityGuards({
    getActiveTurnCount: () => 0,
    agentStatusState: () => ({ agentWorkers: [], agentJobs: rows }),
    countOwnShellJobs: async () => 0,
    listLiveSessions: () => [],
    sessionManager: null,
    listWorkspaceConsumers: async () => [],
    listWorkspaceJobs: async () => [],
  });
  try {
    await guards.assertLeadIdle({ id: scope?.session || 'lead' }, { shellJobs: false });
    return { listed: rows.length, busy: 0 };
  } catch (error) {
    if (error?.code !== 'WORKTREE_BUSY_JOBS' || error.details?.reason !== 'workers') throw error;
    return { listed: rows.length, busy: error.details.jobs };
  }
}

const reg = (id, extra = {}) => ({ op: 'register', id, caller: 's1', pid: 11, ...extra });
const SCENARIOS = [
  {
    name: 'several-clients-share-the-daemon',
    // The worker sessions' own pids: a job whose worker runs under another client is not this client's.
    sessions: { w11: 11, w12: 12, wfloat: 12.7, wzero: 0, wnull: null },
    ops: [
      reg('a', { caller: null, pid: 11, sessionId: 'w11' }),
      reg('b', { caller: null, pid: 11, sessionId: 'w12' }),
      reg('c', { caller: null, pid: 11, sessionId: 'wnull' }),
      reg('d', { caller: null, pid: 11, sessionId: 'unknown-session' }),
      reg('e', { caller: null, pid: 11 }),
      reg('f', { caller: null, pid: 12, sessionId: 'w12' }),
      reg('g', { caller: null, pid: 11, sessionId: 'wfloat' }),
      reg('h', { caller: null, pid: 11, sessionId: 'wzero' }),
      reg('i', { caller: 's1', pid: 11, sessionId: 'w12' }),
      reg('j', { caller: 's1', pid: 12, sessionId: 'w11' }),
      { op: 'busy', scope: { pid: 11 } },
      { op: 'busy', scope: { pid: 12 } },
      { op: 'busy', scope: { pid: 999 } },
      { op: 'busy', scope: { session: 's1' } },
      { op: 'busy', scope: { session: 's1', pid: 11 } },
      { op: 'busy', scope: { session: 's1', pid: 12 } },
      { op: 'busy' },
      { op: 'complete', id: 'b', status: 'completed' },
      { op: 'complete', id: 'a', status: 'queued' },
      { op: 'busy', scope: { pid: 11 } },
      { op: 'busy', scope: { pid: 12 } },
    ],
  },
  { name: 'empty', ops: [{ op: 'busy', scope: { session: 's1' } }, { op: 'busy' }] },
  {
    name: 'running-and-finished',
    ops: [
      reg('a'),
      reg('b'),
      reg('c'),
      reg('d'),
      { op: 'busy', scope: { session: 's1' } },
      { op: 'complete', id: 'a', status: 'completed' },
      { op: 'busy', scope: { session: 's1' } },
      { op: 'complete', id: 'b', status: 'failed' },
      { op: 'complete', id: 'c', status: 'cancelled' },
      { op: 'busy', scope: { session: 's1' } },
      { op: 'complete', id: 'd', status: 'done' },
      { op: 'busy', scope: { session: 's1' } },
    ],
  },
  {
    name: 'other-states-and-spellings',
    ops: [
      reg('q'),
      reg('p'),
      reg('s'),
      reg('x'),
      reg('e'),
      { op: 'complete', id: 'q', status: 'Queued' },
      { op: 'complete', id: 'p', status: ' pending ' },
      { op: 'complete', id: 's', status: 'starting' },
      { op: 'complete', id: 'x', status: 'spawning' },
      { op: 'complete', id: 'e', status: 'error' },
      { op: 'busy', scope: { session: 's1' } },
    ],
  },
  {
    name: 'scoped-by-session-and-process',
    ops: [
      reg('t1', { caller: 's1', pid: 11 }),
      reg('t2', { caller: 's1', pid: 12 }),
      reg('t3', { caller: 's2', pid: 11 }),
      reg('t4', { caller: null, owner: 's3', pid: 13 }),
      reg('t5', { caller: null, owner: null, pid: 11 }),
      reg('t6', { caller: null, owner: null, pid: null }),
      { op: 'busy', scope: { session: 's1' } },
      { op: 'busy', scope: { session: 's2' } },
      { op: 'busy', scope: { session: 's3' } },
      { op: 'busy', scope: { session: 's4' } },
      { op: 'busy', scope: { session: 's1', pid: 11 } },
      { op: 'busy', scope: { session: 's4', pid: 11 } },
      { op: 'busy', scope: { pid: 11 } },
      { op: 'busy', scope: { pid: 13 } },
      { op: 'busy' },
    ],
  },
  {
    name: 'a-finished-job-leaves-after-its-retention',
    ops: [reg('a'), reg('b'), { op: 'complete', id: 'a', status: 'completed' }, { op: 'busy', scope: { session: 's1' } }, { op: 'advance', ms: 31 * 60_000 }, { op: 'busy', scope: { session: 's1' } }],
  },
];

const recorded = [];
for (const scenario of SCENARIOS) {
  clock = START;
  bg.cleanupBackgroundTasks({ surface: 'agent', force: true });
  const results = [];
  for (const op of scenario.ops) {
    const out = {};
    switch (op.op) {
      case 'register':
        bg.registerBackgroundTask({
          taskId: op.id,
          surface: 'agent',
          operation: 'spawn',
          label: op.id,
          input: { tag: op.id },
          context: { callerSessionId: op.caller || undefined, ownerSessionId: op.owner || undefined, clientHostPid: op.pid || undefined },
          meta: { tag: op.id, sessionId: op.sessionId },
          resultType: 'agent_task_result',
        });
        break;
      case 'complete':
        bg.completeBackgroundTask(op.id, { status: op.status, notify: false });
        break;
      case 'advance':
        clock += op.ms;
        break;
      case 'busy':
        Object.assign(out, await busyJobs(op.scope, scenario.sessions || {}));
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
    results.push(out);
  }
  recorded.push({ name: scenario.name, start: START, sessions: scenario.sessions || {}, ops: scenario.ops, results });
}

writeFileSync(
  `${FIXTURES_ROOT}/agent/jobs/busy-count.json`,
  `${JSON.stringify({ domain: 'agent-job-busy-count', recorder: 'benchmarks/rust-core/recorders/record-job-busy-count.mjs', scenarios: recorded }, null, 1)}\n`
);
console.log(`recorded ${recorded.length} scenarios`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
