// Records the goldens of a worker's turn: `createSpawnRunner().runSpawn` and the send flow's
// `runSend` (reached through `dispatchToExistingSession`), each under a real job starter and
// the real background-task table, and `createWorkerTurns`' row bookkeeping.
//
//   node native/core/fixtures/agent/record-turns.mjs [--tree <node checkout with node_modules>]
//
// turns/runner.json       scenarios: a scripted turn (tool results, assistant rows, terminal result,
//                         cancel, return/throw) and what the runner did around it.
// turns/worker-turns.json scenarios over claim/observe/settle and the worker row they write.
// `tests/turns.rs` replays both. Fakes stand where the session manager and the review live;
// the turn review collector is the real one's logic, written over a logging handle.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installFlowHooks } from './flow-hooks.mjs';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const stage = stageSet(here, ['turns']);
installFlowHooks();
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-turns-'));

const START = Date.parse('2026-03-01T10:00:00.000Z');
let clock = START;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [clock]));
  }
  static now() {
    return clock;
  }
};

const load = (path) => import(pathToFileURL(join(nodeRoot, path)).href);
const bg = await load('src/runtime/shared/background-tasks.mjs');
const { createSpawnRunner } = await load('src/session-runtime/services/agent-tool/spawn-flow/spawn-run.mjs');
const { createJobStarter } = await load('src/session-runtime/services/agent-tool/spawn-flow/job-start.mjs');
const { createSendFlow } = await load('src/session-runtime/services/agent-tool/send-flow.mjs');
const { createWorkerTurns } = await load('src/session-runtime/services/agent-tool/worker-turns.mjs');
const { createTurnReviewCollector } = await load('src/session-runtime/services/agent-tool/turn-review.mjs');
const { _resetTurnSnapshotForTest } = await load('src/runtime/shared/turn-snapshot.mjs');

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await tick();
};

// ---- the runner -----------------------------------------------------------------------------

const PRESET = { provider: 'openai', model: 'gpt-x', effort: 'high', fast: false };

function newWorld(scenario) {
  _resetTurnSnapshotForTest();
  const calls = [];
  const notices = [];
  const session = {
    id: 'sess_w1',
    agent: scenario.agent ?? 'worker',
    provider: 'openai',
    model: 'gpt-x',
    cwd: '/work',
    messages: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'before the turn' }],
  };
  let job = null;
  const mgr = {
    getSession: () => session,
    unloadSessionRuntime: (id, reason) => void calls.push(`unload:${reason}`),
    closeSession: async () => {},
    askSession: async (id, prompt, context, _a, cwd, _b, hooks) => {
      calls.push(`ask:${prompt}@${cwd}`);
      for (const step of scenario.steps) {
        if (step.tool) hooks.onToolResult({ uiDiff: step.tool });
        else if (step.assistant !== undefined) {
          session.messages.push(
            step.replay ? { role: 'assistant', content: '', providerReplay: { items: [{ type: 'text', text: step.replay }] } } : { role: 'assistant', content: step.assistant }
          );
        } else if (step.terminal) hooks.onTerminalResult?.(turnResult(step.terminal));
        else if (step.cancel) bg.cancelBackgroundTask(job.taskId, 'agent close');
        else if (step.return) return turnResult(step.return);
        else if (step.throw) {
          const error = new Error(step.throw.message);
          if (step.throw.carriedReport !== undefined) error.carriedReport = step.throw.carriedReport;
          if (step.throw.partialHandoff !== undefined) error.partialHandoff = step.throw.partialHandoff;
          throw error;
        }
      }
      return turnResult({ content: '' });
    },
  };
  const workerTurns = {
    claim: () => {
      calls.push('claim');
      return { submissionId: 'sub-1', release: (status) => void calls.push(`release:${status}`) };
    },
    observe: () => null,
  };
  const notifySessionCompletion = (owner, text, meta) => {
    notices.push({ session: owner, text, ...(meta?.model_visible === false ? { meta } : {}) });
    return true;
  };
  // The REAL review collector and review store run; the loader hook reports their calls.
  globalThis.__flowStub = {
    review: (kind, args, result) => {
      if (kind === 'begin') calls.push(['reviewBegin', args[0], args[1], { tag: args[2]?.tag, agent: args[2]?.agent }]);
      else if (result === true) calls.push(['reviewComplete', args[1]]);
    },
  };
  const startJob = createJobStarter({ mgr, notifyStatusChange: () => {}, notifySessionCompletion });
  return {
    calls,
    notices,
    session,
    mgr,
    workerTurns,
    notifySessionCompletion,
    createTurnReviewCollector,
    startJob,
    setJob: (j) => void (job = j),
  };
}

const turnResult = (r) => ({
  content: r.content,
  ...(r.reportContent !== undefined ? { reportContent: r.reportContent } : {}),
  ...(r.termination ? { terminationReason: r.termination } : {}),
  iterations: r.iterations ?? 1,
  toolCallsTotal: r.toolCallsTotal ?? 0,
  ...(r.stopReason !== undefined ? { stopReason: r.stopReason } : {}),
});

const idOf = (text, id) => (text == null ? text : String(text).split(id).join('job'));

async function runScenario(scenario) {
  clock = START;
  const w = newWorld(scenario);
  const notifyContext = scenario.job ? { callerSessionId: 'lead', clientHostPid: 4242 } : null;
  let returned;
  let outcome;
  let task = null;
  const finished = new Promise((resolve) => {
    returned = resolve;
  });
  const done = async (promise) => {
    try {
      outcome = { value: await promise };
    } catch (error) {
      outcome = { error: error.message };
    }
    returned();
  };
  if (scenario.kind === 'spawn') {
    const runner = createSpawnRunner({
      mgr: w.mgr,
      workerTurns: w.workerTurns,
      notifySessionCompletion: w.notifySessionCompletion,
      emitSubagentEvent: (kind, agent, payload) => void w.calls.push(`emit:${kind}${payload.status ? `:${payload.status}` : ''}`),
      sessionSurface: scenario.canonical ? { canonical: true } : null,
      createTurnReviewCollector: w.createTurnReviewCollector,
    });
    const prepared = {
      args: {},
      tag: 'scout',
      session: w.session,
      agent: w.session.agent,
      preset: PRESET,
      presetName: 'worker-preset',
      prompt: 'do it',
      workerCwd: '/work',
    };
    if (scenario.job) {
      task = w.startJob('spawn', { tag: 'scout', sessionId: w.session.id, agent: w.session.agent, preset: 'worker-preset', provider: 'openai', model: 'gpt-x', effort: 'high', fast: false }, (job, ownerCtx) => {
        w.setJob(job);
        const promise = runner.runSpawn(prepared, ownerCtx, job);
        void done(promise);
        return promise;
      }, notifyContext);
    } else void done(runner.runSpawn(prepared, null, null));
  } else {
    const flow = createSendFlow({
      mgr: w.mgr,
      defaultCwd: '/work',
      sessionSurface: scenario.canonical ? { canonical: true } : null,
      canUseSessionSurface: () => false,
      registry: { tagForSession: () => 'scout' },
      views: { isSessionBusy: () => false, renderJob: () => ({}) },
      spawnFlow: {
        workerTurns: w.workerTurns,
        workerNotifyFn: () => () => false,
        notifyOwnerAgentCompletionEarly: (job, value, ctx) => {
          const ownerEarly = createEarly(w.notifySessionCompletion);
          return ownerEarly(job, value, ctx);
        },
        startJob: (type, meta, run, ctx) =>
          w.startJob(type, meta, (job, ownerCtx) => {
            w.setJob(job);
            const promise = run(job, ownerCtx);
            void done(promise);
            return promise;
          }, ctx),
      },
    });
    if (scenario.job) {
      await flow.dispatchToExistingSession({ args: {}, session: w.session, sessionId: w.session.id, prompt: 'do it' }, notifyContext);
      task = bg.listBackgroundTasks({ surface: 'agent' }).at(-1);
    } else throw new Error('send is always a job');
  }
  await finished;
  await settle();
  const taskId = task?.taskId ?? task?.task_id ?? null;
  const live = taskId ? bg.getBackgroundTask(taskId) : null;
  const norm = (value) => (taskId ? JSON.parse(idOf(JSON.stringify(value), taskId)) : value);
  return {
    name: scenario.name,
    ...scenario,
    result: norm({
      outcome,
      calls: w.calls,
      notices: w.notices,
      row: live && { status: live.status, error: live.error ?? null, terminalReason: live.terminalReason ?? null, notified: live.notified === true },
    }),
  };
}

let createEarly;
{
  const { createNotify } = await load('src/session-runtime/services/agent-tool/notify.mjs');
  createEarly = (notifySessionCompletion) => createNotify({}, { notifySessionCompletion }).notifyOwnerAgentCompletionEarly;
}

const steps = {
  tool: (diff) => ({ tool: diff }),
  assistant: (text) => ({ assistant: text }),
  replay: (text) => ({ assistant: '', replay: text }),
  terminal: (result) => ({ terminal: result }),
  ret: (result) => ({ return: result }),
  throws: (message, extra = {}) => ({ throw: { message, ...extra } }),
  cancel: () => ({ cancel: true }),
};

const base = [
  {
    name: 'completes_with_a_terminal_result',
    steps: [steps.tool('diff-1'), steps.tool('diff-2'), steps.assistant('thinking'), steps.terminal({ content: 'done', iterations: 2, toolCallsTotal: 3 }), steps.ret({ content: 'done', iterations: 2, toolCallsTotal: 3 })],
  },
  { name: 'completes_with_a_report_of_earlier_answers', steps: [steps.ret({ content: 'ok', reportContent: 'earlier\n\nok' })] },
  { name: 'a_normally_empty_finish_is_a_completion', steps: [steps.ret({ content: '' })] },
  {
    name: 'an_empty_public_finish_is_a_failure',
    steps: [steps.terminal({ content: '', termination: 'empty', iterations: 3, toolCallsTotal: 2, stopReason: 'end_turn' }), steps.ret({ content: '', termination: 'empty', iterations: 3, toolCallsTotal: 2, stopReason: 'end_turn' })],
  },
  { name: 'an_empty_finish_with_no_stop_reason_reads_none', steps: [steps.ret({ content: '', termination: 'empty' })] },
  { name: 'a_truncated_finish_returned_without_a_hook_is_a_failure', steps: [steps.ret({ content: 'cut', termination: 'truncated', stopReason: 'max_tokens', iterations: 4, toolCallsTotal: 1 })] },
  { name: 'a_truncated_finish_with_no_stop_reason_reads_null', steps: [steps.ret({ content: 'cut', termination: 'truncated' })] },
  { name: 'a_refusal_is_a_failure', steps: [steps.terminal({ content: 'no', termination: 'refusal', iterations: 1 }), steps.ret({ content: 'no', termination: 'refusal', iterations: 1 })] },
  { name: 'a_throw_before_any_result_fails_the_job', steps: [steps.throws('provider exploded')] },
  { name: 'a_throw_carries_the_answers_before_it', steps: [steps.throws('then it broke', { carriedReport: 'first answer' })] },
  { name: 'a_throw_after_a_terminal_result_keeps_the_completion', steps: [steps.terminal({ content: 'done' }), steps.throws('post-result cleanup failed')] },
  { name: 'a_second_terminal_result_sends_no_second_preview', steps: [steps.terminal({ content: 'one' }), steps.terminal({ content: 'two' }), steps.ret({ content: 'two' })] },
  { name: 'a_cancel_then_a_return_reports_the_result_as_cancelled', steps: [steps.cancel(), steps.ret({ content: 'late result' })] },
  { name: 'a_cancel_then_a_terminal_result_sends_no_preview', steps: [steps.cancel(), steps.terminal({ content: 'late' }), steps.ret({ content: 'late' })] },
  { name: 'a_cancel_then_an_abnormal_finish_is_still_cancelled', steps: [steps.cancel(), steps.ret({ content: '', termination: 'empty' })] },
  { name: 'a_cancel_then_a_throw_reports_what_the_session_produced', steps: [steps.assistant('work so far'), steps.cancel(), steps.throws('aborted')] },
  { name: 'a_cancel_skips_placeholder_rows_and_reads_replay_text', steps: [steps.assistant('.'), steps.replay('from replay'), steps.assistant('  real  '), steps.cancel(), steps.throws('aborted')] },
  { name: 'a_cancel_prefers_the_error_handoff', steps: [steps.assistant('ignored'), steps.cancel(), steps.throws('aborted', { partialHandoff: 'handed' })] },
  { name: 'a_cancel_with_an_empty_handoff_falls_back_to_the_result', steps: [steps.cancel(), steps.throws('aborted', { partialHandoff: '' })] },
  { name: 'a_cancel_with_nothing_produced_is_header_only', steps: [steps.cancel(), steps.throws('aborted')] },
  { name: 'a_cancel_after_the_terminal_result_changes_nothing', steps: [steps.tool('diff-1'), steps.terminal({ content: 'done' }), steps.cancel(), steps.ret({ content: 'done' })] },
  { name: 'a_cancel_before_the_terminal_result_keeps_the_review', steps: [steps.tool('diff-9'), steps.cancel(), steps.terminal({ content: 'late' }), steps.ret({ content: 'late' })] },
];

const scenarios = [];
for (const s of base) {
  scenarios.push({ kind: 'spawn', job: true, ...s });
  scenarios.push({ ...s, name: `send_${s.name}`, kind: 'send', job: true });
}
scenarios.push(
  { kind: 'spawn', job: false, name: 'no_job_returns_the_value', steps: [steps.assistant('x'), steps.ret({ content: 'plain' })] },
  { kind: 'spawn', job: false, name: 'no_job_an_abnormal_finish_throws', steps: [steps.ret({ content: '', termination: 'empty', iterations: 2 })] },
  { kind: 'spawn', job: false, name: 'no_job_a_throw_is_rethrown', steps: [steps.throws('nope')] },
  { kind: 'spawn', job: false, name: 'no_job_a_terminal_hook_is_not_offered', steps: [steps.terminal({ content: 'x' }), steps.ret({ content: 'x' })] },
  { kind: 'spawn', job: true, canonical: true, name: 'a_canonical_surface_hands_off_only', steps: [steps.ret({ content: '<final-answer>wrapped</final-answer>' })] },
  { kind: 'send', job: true, canonical: true, name: 'send_a_canonical_surface_hands_off_only', steps: [steps.ret({ content: 'plain handoff' })] },
  { kind: 'spawn', job: true, agent: 'explorer', name: 'the_agent_name_reads_into_the_failure', steps: [steps.ret({ content: '', termination: 'truncated', stopReason: 'length' })] }
);
const runner = [];
for (const s of scenarios) runner.push(await runScenario(s));

// ---- worker turns ---------------------------------------------------------------------------

let jobSeq = 0;
async function runWorkerTurns(scenario) {
  clock = START;
  const owner = `lead-${++jobSeq}`;
  const rows = [];
  const status = [];
  const handlers = new Map();
  let unobserved = 0;
  const session = { id: 'sess_w1', agent: 'worker', provider: 'openai', model: 'gpt-x' };
  const mgr = {
    getSession: () => session,
    observeSessionTurns: (id, h) => {
      handlers.set(id, h);
      return () => void (unobserved += 1);
    },
  };
  const turns = createWorkerTurns({
    mgr,
    sessionSurface: null,
    upsertWorkerSessionDeferred: (sess, tag, patch) => void rows.push({ session: sess.id, tag, patch }),
    tagForSession: () => 'scout',
    agentWatchdogOverrides: () => ({}),
    notifyStatusChange: () => void status.push('changed'),
  });
  const claims = [];
  const jobs = [];
  const out = [];
  for (const op of scenario.ops) {
    const mark = rows.length;
    const o = {};
    switch (op.op) {
      case 'job': {
        const task = bg.registerBackgroundTask({ taskId: `j${jobSeq}-${jobs.length}`, surface: 'agent', operation: 'spawn', label: 'scout', input: {}, context: { callerSessionId: owner }, meta: {}, resultType: 'agent_task_result' });
        jobs.push(task);
        break;
      }
      case 'cancelJob':
        bg.cancelBackgroundTasks({ surface: 'agent', callerSessionId: owner, terminalReason: op.terminalReason, notify: false });
        break;
      case 'claim': {
        const c = turns.claim(session, op.job == null ? null : jobs[op.job]);
        claims.push(c);
        o.submissionPrefix = c.submissionId.startsWith('agent-turn-');
        break;
      }
      case 'release':
        claims[op.claim].release(op.status);
        break;
      case 'observe':
        o.observed = turns.observe(session) !== null;
        break;
      case 'turnStart': {
        const submissionIds = (op.claims || []).map((i) => claims[i].submissionId);
        handlers.get(session.id).onTurnStart({ turnId: op.turn, startedAt: START + (op.at || 0), submissionIds });
        break;
      }
      case 'turnSettle':
        handlers.get(session.id).onTurnSettled({ turnId: op.turn, status: op.status, result: op.result ? turnResult(op.result) : undefined });
        break;
      case 'forget':
        turns.dispose();
        o.unobserved = unobserved;
        break;
      default:
        throw new Error(op.op);
    }
    out.push({ ...o, rows: rows.slice(mark), changed: status.length });
  }
  return { name: scenario.name, ops: scenario.ops, results: out };
}

const tw = [
  { name: 'a_release_with_no_route_to_observe_writes_nothing', ops: [{ op: 'claim' }, { op: 'release', claim: 0, status: 'idle' }] },
  { name: 'a_claim_released_before_any_turn_settles_the_row', ops: [{ op: 'claim' }, { op: 'release', claim: 0, status: 'error' }, { op: 'release', claim: 0, status: 'idle' }] },
  { name: 'a_claim_released_after_its_turn_started_leaves_the_row_to_the_turn', ops: [{ op: 'observe' }, { op: 'claim' }, { op: 'turnStart', turn: 't1', at: 5, claims: [0] }, { op: 'release', claim: 0, status: 'idle' }, { op: 'turnSettle', turn: 't1', status: 'done', result: { content: 'ok' } }] },
  { name: 'a_turn_carries_the_job_whose_claim_it_started', ops: [{ op: 'job' }, { op: 'observe' }, { op: 'claim', job: 0 }, { op: 'turnStart', turn: 't1', at: 1000, claims: [0] }] },
  { name: 'a_turn_with_no_claim_carries_no_job', ops: [{ op: 'observe' }, { op: 'turnStart', turn: 't1', claims: [] }, { op: 'turnSettle', turn: 't1', status: 'done', result: { content: 'x' } }] },
  { name: 'an_unfinished_turn_settles_as_an_error', ops: [{ op: 'observe' }, { op: 'turnStart', turn: 't1' }, { op: 'turnSettle', turn: 't1', status: 'stopped' }] },
  { name: 'an_abnormal_empty_finish_settles_as_an_error', ops: [{ op: 'observe' }, { op: 'turnStart', turn: 't1' }, { op: 'turnSettle', turn: 't1', status: 'done', result: { content: '', termination: 'empty' } }] },
  { name: 'a_cancelled_job_settles_its_turn_as_cancelled', ops: [{ op: 'job' }, { op: 'observe' }, { op: 'claim', job: 0 }, { op: 'turnStart', turn: 't1', claims: [0] }, { op: 'cancelJob' }, { op: 'turnSettle', turn: 't1', status: 'done', result: { content: 'x' } }] },
  { name: 'a_restart_cancel_settles_the_turn_as_a_restart_failure', ops: [{ op: 'job' }, { op: 'observe' }, { op: 'claim', job: 0 }, { op: 'turnStart', turn: 't1', claims: [0] }, { op: 'cancelJob', terminalReason: 'process-restart' }, { op: 'turnSettle', turn: 't1', status: 'stopped' }] },
  { name: 'a_late_settle_of_an_earlier_turn_is_ignored', ops: [{ op: 'observe' }, { op: 'turnStart', turn: 't1' }, { op: 'turnStart', turn: 't2' }, { op: 'turnSettle', turn: 't1', status: 'done', result: { content: 'x' } }, { op: 'turnSettle', turn: 't2', status: 'done', result: { content: 'y' } }, { op: 'turnSettle', turn: 't2', status: 'done', result: { content: 'y' } }] },
  { name: 'observing_twice_is_one_owner', ops: [{ op: 'observe' }, { op: 'observe' }, { op: 'forget' }] },
];
const workerTurns = [];
for (const s of tw) workerTurns.push(await runWorkerTurns(s));

const dir = join(stage, 'turns');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'runner.json'), `${JSON.stringify(runner, null, 2)}\n`);
writeFileSync(join(dir, 'worker-turns.json'), `${JSON.stringify(workerTurns, null, 2)}\n`);
refreshSetManifest(stage, nodeRoot);
commitStage(stage, here);
console.log(`runner ${runner.length} scenarios, worker-turns ${workerTurns.length}`);
process.exit(0);
