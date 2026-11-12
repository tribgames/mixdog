#!/usr/bin/env node
// What Node's job views answer (`createJobViews`, src/session-runtime/services/agent-tool/job-views.mjs) over the states its own tests
// (job-views.test.mjs) build: the worker list and its active filter, the job rows, task lookup by id / tag / session, the status card
// (`renderJob`) of live, frozen, spawning, respawned and resumed jobs, and the worker fallback of a session whose task is gone. The real
// views, the real session-progress derivation and the real background-task table run; the session manager's answers
// (`getSession`, `getSessionRuntime`, ...), the session entries and the tag map are the scenario's, the seams the test itself scripts.
//
//   node benchmarks/rust-core/recorders/record-job-views.mjs --tree <exact export of b6f10295a with node_modules>
// Output: native/core/fixtures/job-views/golden.json
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recorderProvenance } from './lib/provenance.mjs';
import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const recorder = 'benchmarks/rust-core/recorders/record-job-views.mjs';
// Half an hour after the sessions' `createdAt` of the Node tests: the production registry the replay runs ages a settled session
// out of its index past its retention, which the tests' stub entries (and their real clock) never meet.
const NOW = Date.parse('2026-01-01T00:30:00.000Z');
Date.now = () => NOW;

const sandbox = mkdtempSync(join(process.env.MIXDOG_RECORDER_SCRATCH ?? tmpdir(), 'rec-job-views-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'MIXDOG_HOME', 'MIXDOG_DATA_DIR', 'MIXDOG_CONFIG_DIR', 'MIXDOG_RUNTIME_ROOT', 'MIXDOG_USER_DATA_BACKUP_ROOT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) {
  const directory = join(sandbox, key);
  mkdirSync(directory);
  process.env[key] = directory;
}
const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
const bg = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');
const { createJobViews } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views.mjs');
const { isActiveWorkerRow } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/agent-list.mjs');
const { isTerminalJobStatus } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views/session-progress.mjs');

const iso = (offset) => new Date(NOW + offset).toISOString();
const session = (id, overrides = {}) => ({
  id, agent: 'worker', provider: 'openai', model: 'gpt-5', createdAt: '2026-01-01T00:00:00.000Z', messages: [{ role: 'user', content: 'go' }], tools: [], ...overrides,
});
const spawnMeta = (tag, sessionId) => ({ tag, sessionId, agent: 'worker', provider: 'openai', model: 'gpt-5' });

const scenarios = [
  {
    name: 'the list keeps the rows that can still do work unless terminal rows are asked for',
    sessions: [
      session('s-streaming', { status: 'streaming', runtime: { stage: 'streaming', lastStreamDeltaAt: NOW - 2000 } }),
      session('s-idle', { status: 'idle' }),
      session('s-closed', { closed: true, status: 'streaming' }),
    ],
    entries: [{ tag: 'a', session: 's-streaming' }, { tag: 'b', session: 's-idle' }, { tag: 'c', session: 's-closed' }],
    ops: [
      { op: 'list', opts: { scanSessions: true, context: { callerSessionId: 'lead' } } },
      { op: 'list', opts: { includeTerminal: true } },
      { op: 'list', opts: { includeIdle: true } },
      { op: 'list', opts: { includeClosed: true } },
      { op: 'list', opts: { includeIdle: true, includeClosed: true } },
    ],
  },
  {
    name: 'a continued working row carries the worker index turnStartedAt and an idle one does not',
    sessions: [
      session('s-cont', { createdAt: iso(-7.5 * 3_600_000), status: 'streaming', runtime: { stage: 'streaming' } }),
      session('s-cont-idle', { createdAt: iso(-7.5 * 3_600_000), status: 'idle' }),
    ],
    entries: [
      { tag: 'a', session: 's-cont', indexRow: { sessionId: 's-cont', generation: 2, createdAt: iso(-7.5 * 3_600_000), turnStartedAt: iso(-5000) } },
      { tag: 'b', session: 's-cont-idle', indexRow: { sessionId: 's-cont-idle', turnStartedAt: iso(-5000) } },
    ],
    ops: [{ op: 'list', opts: { includeTerminal: true } }],
  },
  {
    name: 'job rows read live progress for running tasks and freeze terminal ones; lookup accepts task id, tag or session',
    sessions: [session('jv-s-run', { status: 'streaming', runtime: { stage: 'streaming' }, clientHostPid: 777 })],
    tasks: [
      { taskId: 'task-run', operation: 'spawn', meta: spawnMeta('jv-run', 'jv-s-run'), input: { tag: 'jv-run' } },
      { taskId: 'task-done', operation: 'spawn', startedOffset: -60_000, meta: spawnMeta('jv-done', 'jv-s-run'), complete: { status: 'completed', result: 'finished' } },
      { taskId: 'task-spawning', operation: 'spawn', meta: { tag: 'x' } },
      { taskId: 'task-respawned', operation: 'spawn', meta: { respawned: true }, complete: { status: 'completed', result: 'again' } },
      { taskId: 'task-resumed', operation: 'send', meta: { resumed: true }, complete: { status: 'completed', result: 'back' } },
      { taskId: 'task-failed', operation: 'spawn', meta: spawnMeta('jv-failed', 'jv-s-run'), complete: { status: 'failed', error: 'boom' } },
    ],
    ops: [
      { op: 'listJobs', context: {} },
      { op: 'listJobs', context: { clientHostPid: 777 } },
      { op: 'listJobs', context: { clientHostPid: 778 } },
      { op: 'lookup', args: { task_id: 'task-run' } },
      { op: 'lookup', args: { tag: 'jv-run' } },
      { op: 'lookup', args: { sessionId: 'jv-s-run' } },
      { op: 'lookup', args: { task_id: 'task-done' } },
      { op: 'lookup', args: { task_id: 'task-spawning' } },
      { op: 'lookup', args: { task_id: 'task-respawned' } },
      { op: 'lookup', args: { task_id: 'task-resumed' } },
      { op: 'lookup', args: { task_id: 'task-failed' } },
      { op: 'lookup', args: { task_id: 'task-missing' } },
      { op: 'lookup', args: { tag: 'jv-missing' } },
      { op: 'lookup', args: {} },
    ],
  },
  {
    name: 'a worker session without a task answers read and status with a synthetic job built from its last assistant output',
    sessions: [
      session('jv-s-worker', { status: 'idle', presetName: 'fast', messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'done: 42' }, { role: 'assistant', content: '   ' }] }),
      session('jv-s-silent', { status: 'idle', messages: [], lastHandoff: 'handoff text' }),
    ],
    tags: { 'jv-worker': 'jv-s-worker' },
    ops: [
      { op: 'lookup', args: { tag: 'jv-worker' } },
      { op: 'fallback', target: 'jv-s-silent' },
      { op: 'patch', id: 'jv-s-silent', set: { lastHandoff: '' } },
      { op: 'fallback', target: 'jv-s-silent' },
      { op: 'fallback', target: 'nobody' },
      { op: 'lookup', args: { tag: 'nobody' } },
    ],
  },
  {
    name: 'the worker fallback picks the last nonempty assistant output without changing message order',
    sessions: [
      session('jv-s-structured', {
        messages: [
          { role: 'assistant', content: 'earlier output' },
          { role: 'assistant', content: [{ type: 'text', text: 'structured output' }] },
          null,
          { role: 'assistant', content: ' \n ' },
          { role: 'user', content: 'later question' },
        ],
        lastHandoff: 'older handoff',
      }),
    ],
    ops: [{ op: 'fallback', target: 'jv-s-structured' }],
  },
];

const clean = (value) => JSON.parse(JSON.stringify(value === undefined ? null : value));
const out = [];
for (const scenario of scenarios) {
  bg.cleanupBackgroundTasks({ surface: 'agent', force: true });
  const sessions = new Map(scenario.sessions.map((s) => [s.id, structuredClone(s)]));
  const tags = new Map(Object.entries(scenario.tags ?? {}));
  const entries = (scenario.entries ?? []).map((e) => ({ ...structuredClone(e), session: sessions.get(e.session) }));
  const refreshes = [];
  const api = createJobViews({
    mgr: {
      getSession: (id) => sessions.get(id) || null,
      getSessionRuntime: (id) => sessions.get(id)?.runtime || null,
      getSessionProgressSnapshot: (id) => sessions.get(id)?.snapshot || null,
      getSessionPendingMessageDepth: (id) => sessions.get(id)?.pendingDepth ?? null,
    },
    getLiveSession: (id) => sessions.get(id) || null,
    reg: { getProvider: () => null },
    DEFAULT_SPAWN_PREP_TIMEOUT_MS: 1000,
    refreshTagsFromSessions: (options) => refreshes.push(options),
    agentSessionEntries: () => entries,
    tags,
    cfgMod: { loadConfig: () => ({}) },
  });
  for (const task of scenario.tasks ?? []) {
    bg.registerBackgroundTask({
      taskId: task.taskId, surface: 'agent', operation: task.operation, startedAtMs: NOW + (task.startedOffset ?? 0), meta: task.meta, input: task.input,
      context: { callerSessionId: 'lead' },
    });
    if (task.complete) bg.completeBackgroundTask(task.taskId, { ...task.complete, notify: false });
  }
  const results = scenario.ops.map((op) => {
    refreshes.length = 0;
    let result;
    if (op.op === 'list') {
      const rows = api.list(structuredClone(op.opts));
      // Whether the roster counts the row as working (Node's own predicate, or a worker waiting on the user).
      result = { rows, active: rows.map((row) => isActiveWorkerRow(row) || Boolean(row.awaitingUser)) };
    } else if (op.op === 'listJobs') {
      const rows = api.listJobs(structuredClone(op.context));
      result = { rows, finished: rows.map((row) => isTerminalJobStatus(row.status)) };
    } else if (op.op === 'lookup') {
      try {
        result = { card: api.renderJob(api.getJobOrWorker(structuredClone(op.args)), true) };
      } catch (error) {
        result = { error: error.message };
      }
    } else if (op.op === 'fallback') {
      const job = api.workerFallbackJob(op.target);
      result = { job, card: job ? api.renderJob(job, true) : null };
    }
    else if (op.op === 'patch') Object.assign(sessions.get(op.id), op.set);
    return { ...clean(result), refreshes: clean(refreshes) };
  });
  out.push({ ...scenario, results });
}

const finalDir = join(FIXTURES_ROOT, 'job-views');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: 'the job views of real Node over the states its own tests build', now: NOW, scenarios: out });
writeSetManifest(stage, {
  set: 'job-views',
  recorder,
  command: `node ${recorder} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    cases: out.length,
    syntheticInputs: [
      'the session manager: answers getSession, getSessionRuntime, getSessionProgressSnapshot and getSessionPendingMessageDepth from the scenario\'s session records, as job-views.test.mjs\'s fake manager does',
      'the session entries and the tag map: the scenario\'s, as the test\'s agentSessionEntries stub and tags Map are',
      'the clock: Date.now is fixed',    ],
    keptWhole: 'per scenario: its sessions, entries, tags, tasks and operations, and every row, card, job and error each operation answered, with the tag-refresh calls it made',
    exclusions: {
      'worker row fields beyond the roster\'s': 'recorded whole; a replay compares the fields the core\'s roster row (WorkerRow, mixdog-tools orch/agent.rs) has: tag, status, stage, last_progress, whether the row is active, the tool-silence label and the hung diagnostic. The row\'s sort stamp (updatedAt, else lastUsedAt) is not compared: the production registry the replay runs stamps a row it scans in with its own clock, where Node\'s entries are the stub\'s sessions as given. The other fields of Node\'s row (sessionId, agent, route, usage, window, permission, message and tool counts, staleSeconds, turnStartedAt, ...) belong to the status rows (status_rows.rs worker_status_row), compared by the agent-status recording',
      'job card fields beyond the core\'s task view': 'recorded whole; a replay compares the fields of the core\'s TaskView (mixdog-tools orch/agent.rs): preset, clientHostPid and lastStreamDeltaAt of Node\'s card have no TaskView field, and the watchdog label is not compared: it states the registered progress watchdog of a worker\'s running turn, which a replay that runs no turn has none of (the derivation is compared by the progress recording, tests/it/jobs.rs). A null member is left out of both sides (an absent Option is Node\'s null)',
      'job row fields beyond the core\'s job row': 'recorded whole; a replay compares task_id, type, status, tag, error, whether the job is finished and its stamp (finishedAt, else startedAt): JobRow has no worker route or progress field (those are the status rows\')',
      'the spawn-meta case of job-views.test.mjs (pendingSpawnMeta, preparedSpawnMeta, mergeJobMeta, isSessionBusy)': 'not recorded here. The three meta builders are recorded by native/core/fixtures/agent/record-flows.mjs (pending_*, prepared_* and the merge) and replayed whole by mixdog-agent tests/it/flows.rs (merge_prepared_meta, :107). isSessionBusy reads the manager\'s runtime controller; the core has no such function: a session is busy by LiveSessions::running / has_live_work (agent_registry/mod.rs:149-153), which the stale-row recording drives',
      'the order of the worker rows': 'recorded in the stub\'s entry order; the production registry lists in its index order and the roster sorts what it is given, so a replay compares the worker rows by tag',
      'the row of a session the stub lists as closed': 'recorded; a replay leaves it out of the world and of the expected list: the core drops a worker\'s row when it closes the worker (dispatch close_resolved, agent_tool/dispatch.rs), and the production registry\'s scan does not list a closed session (agent_registry/mod.rs list_sessions), so it has no row to list',
      'the tag-refresh calls': 'recorded; the core\'s registry is the production one, which refreshes itself from the stored sessions, so the call is not a seam a replay can observe: its effect (the tag bound to the session) is what the cards compare',
    },
  },
});
commitStage(stage, finalDir);
rmSync(sandbox, { recursive: true, force: true });
console.log(`scenarios=${out.length}`);
process.exit(0);
