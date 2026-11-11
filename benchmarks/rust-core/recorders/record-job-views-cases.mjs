#!/usr/bin/env node
// Records Node's job views for the k1 UNTESTED job-views.test.mjs (gaps-rest.md section 3, mixdog-agent
// `agent_tool/views.rs` and `flow/preset.rs`). The test's sessions, entries and tasks go through Node's real
// `createJobViews` (over the test's fake session manager) and the agent tool's real `renderResult`, so each result is
// the text the agent tool shows: the roster of `list`/`listJobs`, the status card of each `getJob` lookup, and the
// lookup errors. The spawn meta builders are recorded as the meta objects Node returns. The clock is fixed and the
// task ids are explicit, so the texts are stable.
//
//   node benchmarks/rust-core/recorders/record-job-views-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/job-views-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-job-views-cases.mjs';
const TEST = 'src/session-runtime/services/agent-tool/job-views.test.mjs';
const NOW = Date.parse('2026-03-01T10:00:00.000Z');

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-job-views-cases-'));
Date.now = () => NOW;

const bt = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');
const { createJobViews } = await importFrom(tree, 'src/session-runtime/services/agent-tool/job-views.mjs');
const { renderResult } = await importFrom(tree, 'src/session-runtime/services/agent-tool/render.mjs');

// The test's fake session manager and `views`.
function fakeMgr(sessions) {
  return {
    getSession: (id) => sessions.get(id) || null,
    getSessionRuntime: (id) => sessions.get(id)?.runtime || null,
    getSessionProgressSnapshot: (id) => sessions.get(id)?.snapshot || null,
    getSessionPendingMessageDepth: (id) => sessions.get(id)?.pendingDepth ?? null,
  };
}
function views({ sessions = new Map(), tags = new Map(), entries = [] } = {}) {
  const refreshes = [];
  const api = createJobViews({
    mgr: fakeMgr(sessions),
    getLiveSession: (id) => sessions.get(id) || null,
    reg: { getProvider: () => null },
    DEFAULT_SPAWN_PREP_TIMEOUT_MS: 1000,
    refreshTagsFromSessions: (options) => refreshes.push(options),
    agentSessionEntries: () => entries,
    tags,
    cfgMod: { loadConfig: () => ({}) },
  });
  return { api, refreshes };
}
const session = (id, overrides = {}) => ({
  id,
  agent: 'worker',
  provider: 'openai',
  model: 'gpt-5',
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: [{ role: 'user', content: 'go' }],
  tools: [],
  ...overrides,
});
const errorOf = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
};

const cases = [];

{
  const streaming = session('s-streaming', { status: 'streaming', runtime: { stage: 'streaming', lastStreamDeltaAt: NOW - 2000 } });
  const idle = session('s-idle', { status: 'idle' });
  const closed = session('s-closed', { closed: true, status: 'streaming' });
  const sessions = [streaming, idle, closed];
  const entries = [
    { tag: 'a', session: 's-streaming' },
    { tag: 'b', session: 's-idle' },
    { tag: 'c', session: 's-closed' },
  ];
  const { api, refreshes } = views({
    sessions: new Map(sessions.map((s) => [s.id, s])),
    entries: entries.map((e) => ({ tag: e.tag, session: sessions.find((s) => s.id === e.session) })),
  });
  const active = api.list({ scanSessions: true, context: { callerSessionId: 'lead' } });
  // The includeTerminal list is called for its refresh; its text is the named difference.
  api.list({ includeTerminal: true });
  cases.push({
    case: 'list projects agent sessions and keeps only rows that can still do work unless terminal rows are asked for',
    kind: 'list',
    sessions,
    entries,
    recorded: {
      refreshScans: refreshes.map((r) => r.scanSessions === true),
      active: renderResult({ workers: active, jobs: [] }),
    },
  });
}

{
  const live = session('jv-s-run', { status: 'streaming', runtime: { stage: 'streaming' }, clientHostPid: 777 });
  const { api } = views({ sessions: new Map([['jv-s-run', live]]) });
  const tasks = [
    {
      taskId: 'task_jv_run',
      surface: 'agent',
      operation: 'spawn',
      meta: { tag: 'jv-run', sessionId: 'jv-s-run', agent: 'worker', provider: 'openai', model: 'gpt-5' },
      input: { tag: 'jv-run' },
    },
    { taskId: 'task_jv_done', surface: 'agent', operation: 'spawn', startedAtMs: NOW - 60_000, meta: { tag: 'jv-done', sessionId: 'jv-s-run', agent: 'worker' } },
    // The test renders these three as bare objects; here they are board rows the same way, read back by id.
    { taskId: 'task_jv_spawning', surface: 'agent', operation: 'spawn', meta: { tag: 'x' } },
    { taskId: 'task_jv_respawned', surface: 'agent', operation: 'spawn', meta: { respawned: true } },
    { taskId: 'task_jv_resumed', surface: 'agent', operation: 'send', meta: { resumed: true } },
  ];
  for (const task of tasks) bt.registerBackgroundTask(structuredClone(task));
  const completions = {
    task_jv_done: { status: 'completed', result: 'finished', notify: false },
    task_jv_respawned: { status: 'completed', notify: false },
    task_jv_resumed: { status: 'completed', notify: false },
  };
  for (const [id, completion] of Object.entries(completions)) bt.completeBackgroundTask(id, completion);
  const ours = (rows) => rows.filter((row) => tasks.some((t) => t.taskId === row.task_id));
  const card = (args) => {
    try {
      return renderResult(api.renderJob(api.getJob(args), true), { includeDiagnostics: true });
    } catch (error) {
      return { error: error.message };
    }
  };
  // The running job's card (by task id, tag or session) is the named difference.
  const lookups = [{ tag: 'jv-missing' }, {}, { task_id: 'task_jv_done' }];
  for (const id of ['task_jv_spawning', 'task_jv_respawned', 'task_jv_resumed']) lookups.push({ task_id: id });
  cases.push({
    case: 'job rows read live progress for running tasks and freeze terminal ones; lookup accepts task id, tag or session',
    kind: 'jobs',
    sessions: [live],
    tasks,
    completions,
    recorded: {
      jobs: renderResult({ workers: [], jobs: ours(api.listJobs()) }),
      jobsHost777: renderResult({ workers: [], jobs: ours(api.listJobs({ clientHostPid: 777 })) }),
      jobsHost778: renderResult({ workers: [], jobs: ours(api.listJobs({ clientHostPid: 778 })) }),
      cards: lookups.map((args) => ({ args, card: card(args) })),
    },
  });
}

{
  const { api } = views();
  const pending = [
    { args: { agent: 'worker', provider: 'openai', model: 'gpt-5', tag: ' t1 ', fast: true }, extra: { note: 'x' } },
    { args: {}, extra: {} },
  ].map(({ args, extra }) => ({ args, extra, meta: api.pendingSpawnMeta(args, extra) }));
  const preparedArgs = {
    tag: 't2',
    session: { id: 's2' },
    agent: 'worker',
    presetName: 'named',
    preset: { provider: 'anthropic', model: 'claude', effort: 'high', fast: true },
  };
  const prepared = api.preparedSpawnMeta(preparedArgs);
  cases.push({
    case: 'spawn meta builders, meta merge and the busy check',
    kind: 'meta',
    recorded: { pending, prepared: { args: preparedArgs, meta: prepared } },
  });
}

const excluded = {
  'list projects agent sessions ... unless terminal rows are asked for (includeTerminal list, closed row)':
    "difference: Node shows the closed row as `c  closed/streaming  streaming` (status/worker_stage); Rust shows `c  closed  streaming` (its WorkerRow.stage is the row stage `closed`, not the worker stage)",
  'job rows read live progress ... (the running job\'s card by task id, tag or sessionId)':
    "difference: Node's card for an unarmed running worker has `watchdog: not armed (no registered progress watchdog)` from the role's default policy; Rust's Workers::live carries no policy for an unarmed worker (run_host/progress.rs), so the card has no watchdog line",
  'list publishes the worker index turnStartedAt for a continued working row, and omits it when idle':
    "difference: Node's list row carries the worker index turnStartedAt and createdAt; the Rust list row (WorkerRow) carries neither (the Agents pane reads them from agent_registry)",
  'a worker session without a task answers read/status with a synthetic job built from its last assistant output':
    'the stand-in job reads its result from the session record (workerResultText), which the core reads in mixdog-core-session agent_registry/workers.rs; replayed with that crate',
  'worker fallback picks the last nonempty assistant output without changing message order':
    'workerResultText: mixdog-core-session agent_registry/workers.rs; replayed with that crate',
  'spawn meta builders, meta merge and the busy check (isSessionBusy)':
    "isSessionBusy is the core's send world (mixdog-core run_host/agent_send_world.rs), not the views; replayed with mixdog-core",
  'spawn meta builders, meta merge and the busy check (mergeJobMeta of a partial update)':
    "the core merges only a whole prepared meta over the pending one (merge_prepared_meta, every identity key replaced); a partial update such as the test's { tag, sessionId } has no core entry",
  'spawn meta builders, meta merge and the busy check (pendingSpawnMeta extra fields)':
    "difference: Node's pendingSpawnMeta spreads the caller's extra fields (note: 'x') into the meta; the Rust JobMeta has only the identity fields",
};

const finalDir = join(FIXTURES_ROOT, 'job-views-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's job views at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, now: NOW, cases });
writeSetManifest(stage, {
  set: 'job-views-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "list/jobs: the whole agent tool text (renderResult) of each list, job list and status card, each lookup error, and whether each refresh scanned sessions; meta: the identity fields of each meta object (the extra fields are the named difference)",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`job-views-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
