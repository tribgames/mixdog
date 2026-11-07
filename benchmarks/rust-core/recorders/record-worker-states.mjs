#!/usr/bin/env node
// Golden twin of the worker status view the workspace guard reads: each worker session's
// `status` and `stage` as the agent list shows them (`job-views/agent-list.mjs` `rowState`, with
// its default filter `isActiveWorkerRow`), and how many of them `assertLeadIdle`
// (`workspace/activity-guards.mjs`) counts as busy workers (`BUSY_WORKER_STATES`).
//
// Every case is a set of worker-index rows and the runtime stage of each session. They go through
// Node's own pipeline: `normalizeWorkerRows`, `workerRowToSession`, the real `createAgentList`
// (only the registry reads and the progress extras, which carry no status, are stubbed) and the
// real `createActivityGuards`. The record is the listed rows' (sessionId, status, stage) and the
// guard's busy-workers count.
//
//   node benchmarks/rust-core/recorders/record-worker-states.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const NOW = Date.parse('2026-11-06T00:00:00.000Z');
Date.now = () => NOW;

const sandbox = mkdtempSync(join(tmpdir(), 'worker-states-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const tree = resolveTree(parseArgs());
const { createAgentList } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/agent-list.mjs');
const { workerRowToSession } = await importFrom(tree, 'src/session-runtime/services/agent-tool/worker-rows.mjs');
const { normalizeWorkerRows } = await importFrom(tree, 'src/session-runtime/services/agent-tool/worker-index/row-shape.mjs');
const { createActivityGuards } = await importFrom(tree, 'src/session-runtime/workspace/activity-guards.mjs');

const AT = new Date(NOW).toISOString();
const worker = (n, extra = {}) => ({
  tag: `w${n}`,
  sessionId: `sess_w${n}`,
  parentSessionId: 'lead-a',
  ownerSessionId: 'lead-a',
  agent: 'worker',
  clientHostPid: 4242,
  status: 'running',
  stage: 'running',
  updatedAt: AT,
  ...extra,
});

async function play(rows, runtimeStages) {
  const entries = normalizeWorkerRows({ workers: rows }).map((row) => ({ tag: row.tag, session: workerRowToSession(row), indexRow: row, loaded: false }));
  const list = createAgentList({
    mgr: { getSessionRuntime: (id) => (runtimeStages[id] === undefined ? undefined : { stage: runtimeStages[id] }) },
    refreshTagsFromSessions: () => {},
    agentSessionEntries: () => entries,
    progress: { sessionProgressExtras: () => ({}), memorySession: () => null },
  });
  const listed = list({ scanSessions: false, context: {}, memoryOnly: true });
  const guards = createActivityGuards({
    getActiveTurnCount: () => 0,
    agentStatusState: () => ({ agentWorkers: listed, agentJobs: [] }),
    countOwnShellJobs: async () => 0,
    listLiveSessions: () => [],
    sessionManager: null,
    listWorkspaceConsumers: async () => [],
    listWorkspaceJobs: async () => [],
  });
  let busy = 0;
  try {
    await guards.assertLeadIdle({ id: 'lead-a' }, { shellJobs: false });
  } catch (error) {
    if (error?.code !== 'WORKTREE_BUSY_JOBS' || error.details?.reason !== 'workers') throw error;
    busy = error.details.workers;
  }
  return { listed: listed.map((row) => ({ sessionId: row.sessionId, status: row.status, stage: row.stage })), busy };
}

const STATUSES = [
  undefined, '', ' ', 'idle', 'running', 'Running', ' running ', 'connecting', 'requesting', 'streaming', 'tool_running', 'tool-running', 'tool', 'starting', 'spawning', 'queued', 'Queued', 'pending',
  'cancelling', 'cancelled', 'canceled', 'killed', 'cancel-pending', 'cancel_unconfirmed', 'cancel pending', 'cancelpending', 'error', 'failed', 'closed', 'done', 'timeout', 'unknown', 'resource_wait', 'weird',
];
const STAGES = [undefined, '', 'idle', 'running', 'Streaming', ' streaming ', 'connecting', 'tool_running', 'starting', 'queued', 'pending', 'cancelling', 'cancelled', 'cancel-pending', 'error', 'closed', 'unknown', 'resource_wait', 'weird'];
const RUNTIME_STAGES = [undefined, '', 'streaming', 'tool_running', 'queued', 'weird'];

const cases = [];
let n = 0;
for (const status of STATUSES) {
  for (const stage of STAGES) {
    n += 1;
    const row = worker(n);
    if (status !== undefined) row.status = status;
    else delete row.status;
    if (stage !== undefined) row.stage = stage;
    else delete row.stage;
    cases.push({ name: `status=${JSON.stringify(status)} stage=${JSON.stringify(stage)}`, rows: [row], runtime: {} });
  }
}
// A row with no stage of its own takes the runtime's, unless it is idle, errored or closed.
for (const status of ['running', 'idle', 'error', 'closed', 'queued', 'done', 'weird', '']) {
  for (const runtime of RUNTIME_STAGES) {
    n += 1;
    const row = worker(n, { status });
    delete row.stage;
    cases.push({ name: `runtime ${JSON.stringify(runtime)} under status ${JSON.stringify(status)}`, rows: [row], runtime: { [row.sessionId]: runtime } });
  }
}
// Several workers at once, and rows the index drops.
const several = [worker(901), worker(902, { status: 'idle', stage: 'idle' }), worker(903, { status: 'queued', stage: 'queued' }), worker(904, { status: 'cancelled', stage: 'cancelling' }), worker(905, { status: 'Starting', stage: 'weird' }), worker(906, { status: 'tool_running', stage: ' tool_running ' })];
cases.push({ name: 'six workers', rows: several, runtime: {} });
cases.push({ name: 'no workers', rows: [], runtime: {} });
cases.push({ name: 'rows the index drops', rows: [worker(910, { tag: '' }), worker(911, { sessionId: '' }), worker(912, { agent: 'lead' })], runtime: {} });

const recorded = [];
for (const c of cases) recorded.push({ ...c, ...(await play(c.rows, c.runtime)) });

writeFileSync(
  `${FIXTURES_ROOT}/agent/jobs/worker-states.json`,
  `${JSON.stringify({ domain: 'agent-worker-states', now: NOW, recorder: 'benchmarks/rust-core/recorders/record-worker-states.mjs', cases: recorded }, null, 1)}\n`
);
console.log(`recorded ${recorded.length} cases, ${recorded.filter((c) => c.busy > 0).length} busy, ${recorded.filter((c) => c.listed.length).length} listed`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
