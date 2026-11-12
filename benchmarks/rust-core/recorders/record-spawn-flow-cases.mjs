#!/usr/bin/env node
// Records Node's spawn flow for the k1 UNTESTED spawn-flow.test.mjs (gaps-rest.md section 3, mixdog-agent
// `agent_tool/flow/job_starter.rs`, `flow/turn.rs`, `flow/reconcile.rs`, `dispatch.rs` close). Each case runs the test's
// steps through Node's real `createSpawnFlow` (`startJob`, `runSpawn`), `createCloseFlow` and the background task table,
// over the test's fake session manager, and records what the test reads: job statuses, status publications, every
// delivery to the owner (session, whole text, meta), the turn's skill selection, the closes the manager saw and the
// close result. The clock is fixed; task ids are masked as `<task>`.
//
//   node benchmarks/rust-core/recorders/record-spawn-flow-cases.mjs --tree <exact export of b6f10295a with node_modules>
//
// Writes native/core/fixtures/spawn-flow-cases/{golden.json,MANIFEST.json}.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { recorderProvenance } from './lib/provenance.mjs';

const NODE_COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const RECORDER = 'benchmarks/rust-core/recorders/record-spawn-flow-cases.mjs';
const TEST = 'src/session-runtime/services/agent-tool/spawn-flow.test.mjs';
const NOW = Date.parse('2026-03-01T10:00:00.000Z');

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, NODE_COMMIT);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-spawn-flow-cases-'));
Date.now = () => NOW;

const { cleanupBackgroundTasks } = await importFrom(tree, 'src/runtime/shared/background-tasks.mjs');
const { createSpawnFlow } = await importFrom(tree, 'src/session-runtime/services/agent-tool/spawn-flow.mjs');
const { createCloseFlow } = await importFrom(tree, 'src/session-runtime/services/agent-tool/close-flow.mjs');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const masked = (value, ids) => {
  let text = JSON.stringify(value);
  for (const id of ids) text = text.split(id).join('<task>');
  return JSON.parse(text.split(`"${process.pid}"`).join('"<pid>"'));
};
const cases = [];

{
  let publications = 0;
  const flow = createSpawnFlow({ mgr: { closeSession() {} }, notifyStatusChange: () => (publications += 1) });
  const job = flow.startJob('spawn', { tag: 'status-test' }, async () => ({ content: 'done' }), { callerSessionId: 'lead-test', clientHostPid: process.pid });
  const atStart = { status: job.status, publications };
  await job.promise;
  await tick();
  cases.push({
    case: 'agent job lifecycle publishes status immediately and after terminal settlement',
    kind: 'status',
    recorded: { atStart, settled: { status: job.status, publications } },
  });
  cleanupBackgroundTasks({ surface: 'agent', force: true });
}

{
  const deliveries = [];
  let staleCalls = 0;
  const flow = createSpawnFlow({
    mgr: { closeSession() {} },
    notifySessionCompletion(sessionId, text, meta) {
      deliveries.push({ sessionId, text, meta });
      return true;
    },
  });
  const job = flow.startJob('spawn', { tag: 'owner-test' }, async () => ({ content: 'owner handoff' }), {
    callerSessionId: 'lead-owner',
    routingSessionId: 'wrong-lead',
    clientHostPid: process.pid,
    notifyFn() {
      staleCalls += 1;
      return true;
    },
  });
  await job.promise;
  await tick();
  cases.push({
    case: 'agent job completion uses immutable caller owner and never invokes stale notify context',
    kind: 'owner',
    recorded: masked({ status: job.status, staleCalls, deliveries }, [job.taskId]),
  });
  cleanupBackgroundTasks({ surface: 'agent', force: true });
}

{
  const prepared = (spawnArgs) => ({
    args: spawnArgs,
    tag: 'sel-worker',
    session: { id: 'sess_sel_worker' },
    agent: 'worker',
    preset: { provider: 'test-provider', model: 'test-model' },
    presetName: 'worker-route',
    workerCwd: 'C:\\Project\\tree',
    prompt: 'task with $payload-skill',
  });
  const common = { upsertWorkerSessionDeferred() {}, emitSubagentEvent() {}, createTurnReviewCollector: () => ({ onToolResult() {}, complete() {} }) };
  const seen = (opts) => ({ present: Object.hasOwn(opts, 'skillSelection'), value: opts.skillSelection ?? null });
  const turns = [];
  const surfaceFlow = createSpawnFlow({
    ...common,
    mgr: { getSession: () => ({ messages: [] }) },
    sessionSurface: {
      canonical: true,
      canRun: () => true,
      async runTurn(turn) {
        turns.push({ canonical: true, ...seen(turn) });
        return { content: 'ok' };
      },
    },
  });
  const managerFlow = createSpawnFlow({
    ...common,
    mgr: {
      getSession: () => ({ messages: [] }),
      async askSession(...argv) {
        turns.push({ canonical: false, ...seen(argv.at(-1)) });
        return { content: 'ok' };
      },
    },
  });
  const runs = [
    [surfaceFlow, true, { skillSelection: 'trusted $a' }],
    [surfaceFlow, true, {}],
    [managerFlow, false, { skillSelection: '' }],
    [managerFlow, false, {}],
  ];
  for (const [flow, , spawnArgs] of runs) await flow.runSpawn(prepared(spawnArgs), { callerSessionId: 'x' }, null);
  cases.push({
    case: "a spawn's host-set skill selection reaches the worker's turn on both runtimes; none is invented",
    kind: 'skills',
    runs: runs.map(([, canonical, spawnArgs]) => ({ canonical, args: spawnArgs })),
    recorded: { turns },
  });
  cleanupBackgroundTasks({ surface: 'agent', force: true });
}

// The test's `closeRunningWorker`: a running worker whose turn appends `partial` (if any) and then blocks until its
// session is closed, owned by a Lead that records every delivery.
async function closeRunningWorker(partial) {
  const deliveries = [];
  const closures = [];
  const session = { id: 'sess_close_worker', messages: [{ role: 'user', content: 'earlier turn' }] };
  let rejectTurn = null;
  let turnStarted;
  const started = new Promise((resolve) => (turnStarted = resolve));
  const mgr = {
    getSession: () => session,
    askSession: () =>
      new Promise((_resolve, reject) => {
        if (partial) session.messages.push({ role: 'assistant', content: partial });
        rejectTurn = reject;
        turnStarted();
      }),
    closeSession(...closeArgs) {
      closures.push(closeArgs);
      rejectTurn?.(new Error('Session closed: closeSession'));
      return true;
    },
  };
  const flow = createSpawnFlow({
    mgr,
    notifySessionCompletion(sessionId, text, meta) {
      deliveries.push({ sessionId, text, meta });
      return true;
    },
    upsertWorkerSessionDeferred() {},
    emitSubagentEvent() {},
    scheduleReap() {},
    createTurnReviewCollector: () => ({ onToolResult() {}, complete() {} }),
  });
  const preparedSpawn = {
    args: {},
    tag: 'close-worker',
    session,
    agent: 'worker',
    preset: { provider: 'test-provider', model: 'test-model' },
    presetName: 'worker-route',
    workerCwd: 'C:\\Project\\tree',
    prompt: 'work',
  };
  const lead = { callerSessionId: 'sess_close_lead', clientHostPid: process.pid };
  const job = flow.startJob(
    'spawn',
    { tag: 'close-worker', sessionId: session.id },
    (task, ownerNotifyContext) => flow.runSpawn(preparedSpawn, ownerNotifyContext, task),
    lead
  );
  await started;
  const closeFlow = createCloseFlow({
    mgr,
    registry: {
      tags: new Map(),
      tagAgents: new Map(),
      tagCwds: new Map(),
      refreshTagsFromSessions() {},
      wantsSessionScan: () => false,
      resolveTag: () => session.id,
      getLiveSession: () => ({ agent: 'worker' }),
      cancelReap() {},
      tagForSession: () => 'close-worker',
      forgetTerminalSession() {},
      removeWorkerRow() {},
      markReleased() {},
    },
    views: {},
  });
  const closed = await closeFlow.close({ tag: 'close-worker' }, lead);
  await job.promise;
  await tick();
  return masked({ closed, status: job.status, closures, deliveries }, [job.taskId]);
}

cases.push({
  case: 'agent close of a running agent notifies the owner once, as cancelled, with the partial output',
  kind: 'close',
  partial: 'half of the review',
  recorded: await closeRunningWorker('half of the review'),
});
cleanupBackgroundTasks({ surface: 'agent', force: true });
cases.push({
  case: 'agent close of a running agent without output sends the header-only cancelled notification',
  kind: 'close',
  partial: '',
  recorded: await closeRunningWorker(''),
});
cleanupBackgroundTasks({ surface: 'agent', force: true });

const excluded = {
  'agent-tree cancel of a running agent reports its own task to the owner once, as cancelled with partial output':
    "the agent tree (`createAgentTree`, the desktop session service) is mixdog-core-session's AgentSessions and its turn " +
    'adapter in the core, not mixdog-agent: replayed with that crate',
};

const finalDir = join(FIXTURES_ROOT, 'spawn-flow-cases');
const stage = stageSet(finalDir);
writeJson(join(stage, 'golden.json'), { note: `Node's spawn flow at ${NODE_COMMIT}, per case of ${RECORDER}`, test: TEST, cases });
writeSetManifest(stage, {
  set: 'spawn-flow-cases',
  recorder: RECORDER,
  command: `node ${RECORDER} --tree <exact export of ${NODE_COMMIT}>`,
  identity,
  extra: {
    ...recorderProvenance(import.meta.url),
    compared:
      "status: the job status and publication count at start and once settled; owner: the job status, the stale notify count and every delivery (session and whole text; of the meta, the fields the core's task notifier carries: surface, task id, status, caller); skills: each turn's skill selection (present, value); close: the close result, the job status, every close the manager saw (as a set: DIFFERENCE, the core sends the cancel-time 'agent-task-cancel' close from a spawned task, after the 'cli-agent-close' one, where Node sends it first) and every delivery",
    masked: "task ids as <task>, the recorder's pid as <pid>; the clock is fixed at 2026-03-01T10:00:00.000Z",
    excluded,
  },
});
commitStage(stage, finalDir);
console.log(`spawn-flow-cases: ${cases.length} case(s), ${Object.keys(excluded).length} named exclusion(s)`);
process.exit(0);
