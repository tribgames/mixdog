// Terminal agent jobs must stay frozen history: same-tag reuse re-points a tag
// at a NEW live session, and the old completed rows used to re-read that live
// session and report streaming/model-active. Covers completed A + running B
// sharing one session/tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  completeBackgroundTask,
  registerBackgroundTask,
} from '../src/runtime/shared/background-tasks.mjs';
import { createJobViews, isActiveWorkerRow, isTerminalJobStatus } from '../src/standalone/agent-tool/job-views.mjs';

const NOW = Date.now();
const LIVE_SESSION_ID = 'sess_live_reuse';
const REAPED_SESSION_ID = 'sess_reaped_history';

const liveSession = {
  id: LIVE_SESSION_ID,
  agent: 'worker',
  status: 'streaming',
  stage: 'streaming',
  provider: 'anthropic-oauth',
  model: 'sonnet',
  clientHostPid: null,
  messages: [],
  tools: [],
};
const reapedSession = {
  id: REAPED_SESSION_ID,
  agent: 'worker',
  status: 'idle',
  provider: 'anthropic-oauth',
  model: 'sonnet',
  messages: [],
  tools: [],
};
const liveRuntime = {
  stage: 'streaming',
  lastStreamDeltaAt: NOW - 3_000,
  lastProgressAt: NOW - 3_000,
};
const sessions = new Map([
  [LIVE_SESSION_ID, liveSession],
  [REAPED_SESSION_ID, reapedSession],
]);
const runtimes = new Map([[LIVE_SESSION_ID, liveRuntime]]);

const mgr = {
  getSession: (id) => sessions.get(id) || null,
  getSessionRuntime: (id) => runtimes.get(id) || null,
  getSessionProgressSnapshot: (id) => (id === LIVE_SESSION_ID
    ? {
      stage: 'streaming',
      lastStreamDeltaAt: NOW - 3_000,
      lastProgressAt: NOW - 3_000,
      hasFirstSemantic: true,
      lastSemanticKind: 'text',
    }
    : null),
  getSessionPendingMessageDepth: () => 0,
};

const views = createJobViews({
  mgr,
  getLiveSession: (id) => sessions.get(id) || null,
  reg: {},
  DEFAULT_SPAWN_PREP_TIMEOUT_MS: 60_000,
  refreshTagsFromSessions: () => {},
  agentSessionEntries: () => [
    { tag: 'scope', session: liveSession },
    { tag: 'scope-old', session: reapedSession },
  ],
  tags: new Map([['scope', LIVE_SESSION_ID]]),
  cfgMod: { loadConfig: () => ({}) },
});

function makeTask(meta, { complete = null } = {}) {
  const task = registerBackgroundTask({ surface: 'agent', operation: 'spawn', meta });
  if (complete) completeBackgroundTask(task.taskId, { ...complete, notify: false });
  return task;
}

// A: finished earlier under tag "scope"; B: the same tag reused, now running.
const jobA = makeTask(
  { tag: 'scope', sessionId: LIVE_SESSION_ID, agent: 'worker' },
  { complete: { status: 'completed', result: 'A handoff text' } },
);
const jobB = makeTask({ tag: 'scope', sessionId: LIVE_SESSION_ID, agent: 'worker' });

test('fixture sanity: A is terminal, B is still running', () => {
  assert.equal(jobA.status, 'completed');
  assert.equal(jobA.result, 'A handoff text');
  assert.equal(jobB.status, 'running');
});

test('terminal job status classification', () => {
  assert.equal(isTerminalJobStatus('completed'), true);
  assert.equal(isTerminalJobStatus('failed'), true);
  assert.equal(isTerminalJobStatus('cancelled'), true);
  assert.equal(isTerminalJobStatus('running'), false);
});

test('completed job A never inherits the reused live session progress', () => {
  const rendered = views.renderJob(jobA, true);
  assert.equal(rendered.status, 'completed');
  assert.equal(rendered.worker_stage, 'completed');
  assert.equal(rendered.stage, 'completed');
  assert.equal(rendered.workerStatus, 'completed');
  assert.equal(rendered.diagnostic, 'task completed; worker idle');
  assert.equal('silent_for' in rendered, false);
  assert.equal('watchdog' in rendered, false);
  assert.equal('queued_followups' in rendered, false);
  assert.equal(rendered.lastStreamDeltaAt, null);
  assert.equal(/streaming|model active|tool running/i.test(String(rendered.last_progress)), false);
  // Terminal result stays reachable through read.
  assert.equal(rendered.result, 'A handoff text');
});

test('running job B keeps live worker diagnostics', () => {
  const rendered = views.renderJob(jobB, false);
  assert.equal(rendered.status, 'running');
  assert.equal(rendered.worker_stage, 'streaming');
  assert.equal(Number.isFinite(rendered.silent_for), true);
});

test('job list freezes A and keeps only B active', () => {
  const rows = views.listJobs({});
  const rowA = rows.find((row) => row.task_id === jobA.taskId);
  const rowB = rows.find((row) => row.task_id === jobB.taskId);
  assert.ok(rowA && rowB, 'both jobs remain listed as task history');
  assert.equal(rowA.status, 'completed');
  assert.equal(rowA.worker_stage, 'completed');
  assert.equal('silent_for' in rowA, false);
  assert.equal(rowB.worker_stage, 'streaming');
});

test('default worker section hides idle/terminal rows', () => {
  const workers = views.list({});
  assert.deepEqual(workers.map((row) => row.sessionId), [LIVE_SESSION_ID]);
  assert.equal(views.list({ includeTerminal: true }).length, 2);
  assert.equal(isActiveWorkerRow({ status: 'idle', stage: 'idle' }), false);
  assert.equal(isActiveWorkerRow({ status: 'idle', stage: 'unknown' }), false);
  assert.equal(isActiveWorkerRow({ status: 'closed', stage: 'closed' }), false);
  assert.equal(isActiveWorkerRow({ status: 'idle', stage: 'streaming' }), true);
  assert.equal(isActiveWorkerRow({ status: 'running', stage: 'tool_running' }), true);
});

// ---------------------------------------------------------------------------
// Integration: the same fix seen through createStandaloneAgent().execute, so
// list/status/read/cleanup wiring, PID scoping and same-tag reuse are covered
// end to end (no network: sessions/tasks are injected fixtures).
// ---------------------------------------------------------------------------
process.env.MIXDOG_AGENT_TRACE_DISABLE = '1';

const OWNER_PID = 690_001;
const FOREIGN_PID = 690_002;
const INT_LIVE_ID = 'sess_int_live';
const INT_IDLE_ID = 'sess_int_idle';

const root = mkdtempSync(join(tmpdir(), 'mixdog-agent-job-views-'));
const dataDir = join(root, '.mixdog-data');
mkdirSync(dataDir, { recursive: true });

const intLive = {
  id: INT_LIVE_ID,
  owner: 'agent',
  agentTag: 'scope',
  agent: 'worker',
  status: 'streaming',
  stage: 'streaming',
  provider: 'openai-oauth',
  model: 'gpt-5.5',
  clientHostPid: OWNER_PID,
  cwd: root,
  messages: [],
};
const intIdle = {
  id: INT_IDLE_ID,
  owner: 'agent',
  agentTag: 'scope-old',
  agent: 'worker',
  status: 'idle',
  stage: 'idle',
  provider: 'openai-oauth',
  model: 'gpt-5.5',
  clientHostPid: OWNER_PID,
  cwd: root,
  messages: [],
};
const intSessions = new Map([[INT_LIVE_ID, intLive], [INT_IDLE_ID, intIdle]]);
const intRuntimes = new Map([[INT_LIVE_ID, { stage: 'streaming', lastStreamDeltaAt: Date.now() - 2_000, lastProgressAt: Date.now() - 2_000 }]]);
const intMgr = {
  getSession: (id) => intSessions.get(id) || null,
  listSessions: () => [...intSessions.values()],
  getSessionRuntime: (id) => intRuntimes.get(id) || null,
  getSessionProgressSnapshot: (id) => (id === INT_LIVE_ID
    ? { stage: 'streaming', lastStreamDeltaAt: Date.now() - 2_000, hasFirstSemantic: true, lastSemanticKind: 'text' }
    : null),
  getSessionPendingMessageDepth: () => 0,
  closeSession: () => true,
  enqueuePendingMessage: () => 1,
  askSession: async () => ({ content: 'unused' }),
};

const { createStandaloneAgent } = await import('../src/standalone/agent-tool.mjs');
const agent = createStandaloneAgent({
  cfgMod: {
    loadConfig: () => ({ providers: { 'openai-oauth': { enabled: true } } }),
    resolveRuntimeSpec: (preset) => ({ lane: 'agent', scopeKey: 'job-views', provider: preset?.provider, model: preset?.model }),
  },
  reg: { async initProviders() { return {}; } },
  mgr: intMgr,
  dataDir,
  cwd: root,
});

const ownerCtx = { invocationSource: 'model-tool', cwd: root, clientHostPid: OWNER_PID };
const intMeta = { tag: 'scope', sessionId: INT_LIVE_ID, agent: 'worker', provider: 'openai-oauth', model: 'gpt-5.5' };

const intJobA = registerBackgroundTask({ surface: 'agent', operation: 'spawn', context: ownerCtx, meta: intMeta });
// Make A unambiguously the OLDER task so tag resolution prefers running B.
intJobA.startedAtMs = Date.now() - 60_000;
intJobA.startedAt = new Date(intJobA.startedAtMs).toISOString();
completeBackgroundTask(intJobA.taskId, { status: 'completed', result: 'integration handoff text', notify: false });
const intJobB = registerBackgroundTask({ surface: 'agent', operation: 'spawn', context: ownerCtx, meta: intMeta });
const foreignJob = registerBackgroundTask({
  surface: 'agent',
  operation: 'spawn',
  context: { clientHostPid: FOREIGN_PID, callerSessionId: 'sess_foreign_owner' },
  meta: { tag: 'other-terminal', sessionId: 'sess_foreign', agent: 'worker' },
});

function lineFor(text, needle) {
  return String(text).split('\n').find((line) => line.includes(needle)) || '';
}

test('execute(list) freezes completed A, keeps B active, honors PID scope', async () => {
  const out = await agent.execute({ type: 'list', scanSessions: true }, ownerCtx);
  // Worker section: only the live reused session, idle/terminal row hidden.
  assert.match(out, /^agents: 1$/m);
  assert.match(out, /^- scope worker streaming\/streaming /m);
  assert.equal(/^- scope-old /m.test(out), false);
  // Task section keeps both rows; the other terminal's task stays out of scope.
  const rowA = lineFor(out, intJobA.taskId);
  const rowB = lineFor(out, intJobB.taskId);
  assert.ok(rowA && rowB, `both task rows listed:\n${out}`);
  assert.equal(out.includes(foreignJob.taskId), false);
  assert.match(rowA, /completed/);
  assert.match(rowA, /stage=completed/);
  assert.equal(/silent_for|streaming|model active/.test(rowA), false);
  assert.match(rowB, /stage=streaming/);
});

test('execute(status/read) keeps terminal metadata and result for A', async () => {
  const status = await agent.execute({ type: 'status', task_id: intJobA.taskId }, ownerCtx);
  assert.match(status, /^status: completed$/m);
  assert.match(status, /^worker_stage: completed$/m);
  assert.match(status, /^diagnostic: task completed; worker idle$/m);
  assert.equal(/silent_for|watchdog|streaming/.test(status), false);
  const read = await agent.execute({ type: 'read', task_id: intJobA.taskId }, ownerCtx);
  assert.match(read, /integration handoff text/);
});

test('execute(status) by reused tag resolves the running job, not the finished one', async () => {
  const status = await agent.execute({ type: 'status', tag: 'scope' }, ownerCtx);
  assert.match(status, new RegExp(`agent task: ${intJobB.taskId}`));
  assert.match(status, /^status: running$/m);
  // Running spawn/send acks stay minimal by design (render.mjs isStartAck), so
  // only the task identity/status is asserted here; the live worker_stage is
  // covered by the list row and the unit renderJob test.
  assert.equal(status.includes('completed'), false);
  assert.equal(status.includes(intJobA.taskId), false);
});

test('execute(cleanup) still counts idle/terminal worker rows', async () => {
  const out = await agent.execute({ type: 'cleanup' }, ownerCtx);
  const summary = JSON.parse(out);
  assert.equal(summary.tasks >= 2, true, `tasks kept: ${out}`);
  assert.equal(summary.workers >= 2, true, `worker rows counted incl. idle: ${out}`);
});

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});
