#!/usr/bin/env node
// Golden twin of the agents-section payload of `thread/agents/updated`: what the agent tool's `getStatus`
// answers (`agent-tool.mjs statusFor`): the worker rows of `createAgentList(...)({ memoryOnly: true })` and the
// job rows of `createJobRender(...).listJobs(ctx, { memoryOnly: true })`, each through `liveAgentStatusRow`.
// The real list, render, session-progress and background-task table run over a scripted session manager;
// only the manager's answers are given. Each session's role is unique and read once, so the role-policy
// cache (filled after a first read) never changes an answer.
//
//   node benchmarks/rust-core/recorders/record-agent-status.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const NOW = Date.parse('2026-03-01T10:00:00.000Z');
Date.now = () => NOW;

const sandbox = mkdtempSync(join(tmpdir(), 'agent-status-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const tree = resolveTree(parseArgs());
const bg = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');
const { createAgentList } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/agent-list.mjs');
const { createJobRender } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/job-render.mjs');
const { createSessionProgress, liveAgentStatusRow } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/session-progress.mjs');
const { _liveSessions } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/live-state.mjs');

const ago = (s) => NOW - s * 1000;
const STAGES = ['connecting', 'requesting', 'streaming', 'tool_running', 'resource_wait', 'running', 'cancelling', 'idle', 'done', 'error', 'closed'];
const STATUSES = ['running', 'idle', 'error', 'queued', 'starting', 'cancelled', 'unknown-state'];

let counter = 0;
const worker = (patch = {}) => {
  counter += 1;
  const id = `sess_w${counter}`;
  return {
    id,
    session: {
      id,
      agent: `role-${counter}`,
      provider: 'anthropic',
      model: 'claude-x',
      presetName: counter % 3 === 0 ? 'quick' : null,
      effort: counter % 2 ? 'high' : null,
      fast: counter % 4 === 0,
      status: 'running',
      createdAt: 1_700_000_000_000 + counter,
      updatedAt: 1_700_000_100_000 + counter,
      lastUsedAt: 1_700_000_200_000 + counter,
      clientHostPid: 4000 + counter,
      totalInputTokens: 100 * counter,
      totalOutputTokens: 7 * counter,
      totalToolCalls: counter,
      lastContextTokens: 5000 + counter,
      contextWindow: 200000,
      permission: 'default',
      toolPermission: null,
      messageCount: counter,
      toolCount: 12,
      ...(patch.session || {}),
    },
    runtime: patch.runtime === undefined ? { stage: patch.stage || 'streaming', lastStreamDeltaAt: ago(3), lastProgressAt: ago(2) } : patch.runtime,
    snapshot: patch.snapshot ?? null,
    depth: patch.depth ?? null,
    tag: patch.tag || `tag${counter}`,
    indexRow: patch.indexRow ?? null,
  };
};

const workers = [];
for (const status of STATUSES) for (const stage of STAGES) workers.push(worker({ stage, session: { status, ...(stage === 'idle' || stage === 'done' ? {} : { stage }) } }));
workers.push(worker({ session: { closed: true, status: 'running' } }));
workers.push(worker({ session: { autoEffort: false, modelParameters: { context: '1m' }, fast: true } }));
workers.push(worker({ session: { modelParameters: {} } }));
workers.push(worker({ session: { messages: [{}, {}, {}], tools: [{}, {}], messageCount: undefined, toolCount: undefined } }));
workers.push(worker({ session: { totalInputTokens: undefined, totalOutputTokens: undefined, totalToolCalls: undefined } }));
workers.push(worker({ session: { totalInputTokens: 5, totalOutputTokens: undefined } }));
workers.push(worker({ session: { lastContextTokens: undefined, lastInputTokens: 321, contextWindow: undefined } }));
workers.push(worker({ session: { toolPermission: 'ask', permission: 'plan' } }));
workers.push(worker({ session: { todo: { phases: [{ name: 'p1', tasks: [{ content: 'a', status: 'completed' }, { content: 'b  b', status: 'in_progress' }, { content: 'c', status: 'abandoned' }, { content: 'd', status: 'bogus' }] }, { name: 'empty', tasks: [] }], updatedAt: 1 } } }));
workers.push(worker({ session: { todo: { phases: [{ name: 'p', tasks: [{ content: 'only', status: 'pending' }] }] } } }));
workers.push(worker({ session: { todo: { phases: [{ name: 'p', tasks: [{ content: '', status: 'pending' }, 7] }] } } }));
workers.push(worker({ runtime: { stage: 'tool_running', awaitingUser: { kind: 'approval', tool: 'bash' }, lastStreamDeltaAt: ago(40), lastToolCall: 'bash' } }));
workers.push(worker({ runtime: { stage: 'streaming', taskWaits: 0, lastStreamDeltaAt: ago(9) }, snapshot: { stage: 'streaming', waitingForTransport: true, lastProgressAt: ago(9) } }));
workers.push(worker({ runtime: { stage: 'streaming' }, snapshot: { stage: 'streaming', waitingForFirstSemantic: true, lastProgressAt: ago(5) } }));
workers.push(worker({ runtime: { stage: 'streaming' }, depth: 2 }));
workers.push(worker({ runtime: { stage: 'idle' }, depth: 1, session: { status: 'idle' } }));
workers.push(worker({ runtime: null, session: { status: 'idle' } }));
workers.push(worker({ session: { status: 'running' }, indexRow: { turnStartedAt: '2026-03-01T09:59:00.000Z' } }));
workers.push(worker({ session: { status: 'running', turnStartedAt: '2026-03-01T09:58:00.000Z' } }));
workers.push(worker({ session: { status: 'idle', turnStartedAt: '2026-03-01T09:58:00.000Z' }, runtime: { stage: 'idle' } }));

const jobsSpec = [];
let jobNo = 0;
const job = (status, extra = {}) => {
  jobNo += 1;
  const w = extra.worker === false ? null : worker({ session: { agent: null }, ...(extra.workerPatch || {}) });
  jobsSpec.push({ id: `job${jobNo}`, status, tag: `jt${jobNo}`, session: w, operation: extra.operation || 'spawn', error: extra.error || null, pid: extra.pid || null, meta: extra.meta || {} });
};
for (const status of ['running', 'queued', 'completed', 'failed', 'cancelled']) job(status);
job('running', { worker: false });
job('running', { meta: { agent: 'reviewer', preset: 'p', provider: 'openai', model: 'gpt-x', effort: 'low', fast: true } });
job('running', { meta: { fast: false } });
job('failed', { error: 'boom' });
job('running', { workerPatch: { runtime: { stage: 'tool_running', awaitingUser: { kind: 'approval' } } } });
job('running', { workerPatch: { runtime: { stage: 'tool_running', taskWaits: 1, taskWaitJobIds: [] } } });
job('running', { operation: 'send' });

// --- the scripted session manager -----------------------------------------------------------------
const byId = new Map();
for (const w of [...workers, ...jobsSpec.map((j) => j.session).filter(Boolean)]) byId.set(w.id, w);
const mgr = {
  loadSessionStatus: (id) => byId.get(id)?.session.status || null,
  getSession: (id) => byId.get(id)?.session || null,
  getSessionRuntime: (id) => byId.get(id)?.runtime || null,
  getSessionProgressSnapshot: (id) => byId.get(id)?.snapshot || null,
  getSessionPendingMessageDepth: (id) => byId.get(id)?.depth ?? null,
};
for (const w of workers) _liveSessions.set(w.id, w.session);
const progress = createSessionProgress({ mgr });

const clean = (value) => JSON.parse(JSON.stringify(value));
const list = createAgentList({
  mgr,
  refreshTagsFromSessions: () => {},
  agentSessionEntries: () => workers.map((w) => ({ tag: w.tag, session: w.session, indexRow: w.indexRow, loaded: true })),
  progress,
});
const workerRows = list({ scanSessions: false, context: {}, memoryOnly: true }).map(liveAgentStatusRow).map(clean);

bg.cleanupBackgroundTasks({ surface: 'agent', force: true });
for (const j of jobsSpec) {
  bg.registerBackgroundTask({
    taskId: j.id,
    surface: 'agent',
    operation: j.operation,
    label: j.id,
    input: { tag: j.tag },
    context: { callerSessionId: 'lead', clientHostPid: j.pid || undefined },
    meta: { tag: j.tag, sessionId: j.session?.id, agent: j.session?.session.agent || undefined, ...j.meta },
    resultType: 'agent_task_result',
  });
  if (!['running', 'queued'].includes(j.status)) bg.completeBackgroundTask(j.id, { status: j.status, notify: false, ...(j.error ? { error: j.error } : {}) });
  else if (j.status === 'queued') bg.updateBackgroundTask?.(j.id, { status: 'queued' });
}
const jobRows = createJobRender({ progress }).listJobs({ callerSessionId: 'lead' }, { memoryOnly: true }).map(liveAgentStatusRow).map(clean);

writeFileSync(
  join(FIXTURES_ROOT, 'agent-status', 'golden.json'),
  `${JSON.stringify({ domain: 'agent-status', recorder: 'benchmarks/rust-core/recorders/record-agent-status.mjs', now: NOW, workers: workers.map(({ id, session, runtime, snapshot, depth, tag, indexRow }) => clean({ id, session, runtime, snapshot, depth, tag, indexRow })), workerRows, jobs: jobsSpec.map((j) => clean({ id: j.id, status: j.status, tag: j.tag, sessionId: j.session?.id ?? null, worker: j.session ? { session: j.session.session, runtime: j.session.runtime, snapshot: j.session.snapshot, depth: j.session.depth } : null, operation: j.operation, error: j.error, meta: j.meta })), jobRows }, null, 1)}\n`
);
console.log(`recorded ${workerRows.length} worker rows, ${jobRows.length} job rows`);
rmSync(sandbox, { recursive: true, force: true });
process.exit(0);
