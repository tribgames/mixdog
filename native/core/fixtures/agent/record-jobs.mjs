// Records the goldens of the agent tool's job board and progress derivation.
//
//   node native/core/fixtures/agent/record-jobs.mjs [--tree <node checkout with node_modules>]
//
// jobs/board.json    scenarios over runtime/shared/background-tasks.mjs (the `agent` surface):
//                    each op's rows, counts and the completion notices it sent.
// jobs/progress.json inputs and outputs of session-runtime/services/agent-task-status.mjs
//                    `buildAgentTaskProgressFields`.
// `tests/jobs.rs` replays both.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { commitStage, parseArgs, refreshSetManifest, resolveTree, stageSet } from '../../../../benchmarks/rust-core/recorders/lib/common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodeRoot = resolveTree(parseArgs());
const stage = stageSet(here, ['jobs']);
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-jobs-'));
const load = (path) => import(pathToFileURL(join(nodeRoot, path)).href);
const bg = await load('src/runtime/shared/background-tasks.mjs');
const { onCommandToolSettled } = await load('src/runtime/shared/turn-boundary-signal.mjs');
const { mergeJobMeta } = await load('src/session-runtime/services/agent-tool/job-views/spawn-meta.mjs');
const { buildAgentTaskProgressFields } = await load('src/session-runtime/services/agent-task-status.mjs');

// ---- the board ------------------------------------------------------------------------------

const START = Date.parse('2026-03-01T10:00:00.000Z');
let clock = START;
Date.now = () => clock;

const ctxOf = (scope) => ({ callerSessionId: scope?.session || undefined, clientHostPid: scope?.pid || undefined });
const row = (t) =>
  t && {
    task_id: t.task_id,
    operation: t.operation,
    label: t.label,
    status: t.status,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    error: t.error,
    notified: t.notified,
    tag: t.tag ?? null,
    sessionId: t.sessionId ?? null,
    terminalReason: bg.getBackgroundTask(t.task_id)?.terminalReason ?? null,
  };

const settledCwds = [];
onCommandToolSettled((cwd) => void settledCwds.push(cwd));
const runs = new Map();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function play(ops) {
  const notices = [];
  const live = new Map();
  const results = [];
  for (const op of ops) {
    notices.length = 0;
    settledCwds.length = 0;
    const out = {};
    switch (op.op) {
      case 'register': {
        const handoff = op.caller || op.owner || null;
        try {
          const task = bg.registerBackgroundTask({
            taskId: op.id,
            startedAtMs: op.startedAt == null ? undefined : START + op.startedAt,
            surface: 'agent',
            operation: op.operation || 'spawn',
            label: op.tag || op.sessionId || op.operation || 'spawn',
            input: { tag: op.tag || null, ...(op.cwd ? { cwd: op.cwd } : {}) },
            context: {
              callerSessionId: op.caller || undefined,
              ownerSessionId: op.owner || undefined,
              clientHostPid: op.pid || undefined,
              notifyFn: handoff ? (text) => void notices.push({ session: handoff, text }) : undefined,
            },
            meta: { tag: op.tag, sessionId: op.sessionId, agent: op.agent },
            resultType: 'agent_task_result',
            notifyOnCancel: op.notifyOnCancel === true,
          });
          live.set(op.id, task);
        } catch (error) {
          out.error = String(error.message);
        }
        break;
      }
      case 'start': {
        const handoff = op.caller || null;
        const pending = {};
        pending.promise = new Promise((resolve, reject) => Object.assign(pending, { resolve, reject }));
        runs.set(op.id, pending);
        live.set(op.id, bg.startBackgroundTask({
          taskId: op.id,
          surface: 'agent',
          operation: 'spawn',
          label: op.tag || 'spawn',
          input: { tag: op.tag || null },
          context: { callerSessionId: op.caller || undefined, notifyFn: handoff ? (text) => void notices.push({ session: handoff, text }) : undefined },
          meta: { tag: op.tag, sessionId: op.sessionId },
          resultType: 'agent_task_result',
          notifyOnCancel: op.notifyOnCancel === true,
          run: () => pending.promise,
        }));
        break;
      }
      case 'resolveRun':
        runs.get(op.id).resolve(op.content == null ? null : { content: op.content });
        break;
      case 'rejectRun':
        runs.get(op.id).reject(new Error(op.error));
        break;
      case 'cancelAll': {
        const o = {
          reason: op.reason,
          terminalReason: op.terminalReason,
          executionSessionId: op.execution,
          callerSessionId: op.scope?.session || undefined,
          clientHostPid: op.scope?.pid || undefined,
          startedSinceMs: op.startedSince == null ? undefined : START + op.startedSince,
          ...(op.notice === 'now' ? { notify: true } : op.notice === 'never' ? { notify: false } : {}),
        };
        out.cancelled = bg.cancelBackgroundTasks({ surface: 'agent', ...o }).taskIds;
        break;
      }
      case 'complete':
        bg.completeBackgroundTask(op.id, {
          status: op.status,
          result: op.content == null ? undefined : { content: op.content },
          resultText: op.resultText,
          error: op.error,
          notify: op.notify,
        });
        break;
      case 'cancel':
        bg.cancelBackgroundTask(op.id, op.reason, op.notice === 'now' ? { notify: true } : op.notice === 'never' ? { notify: false } : {});
        break;
      case 'settle':
        bg.settleCancelledBackgroundTask(op.id, { result: op.content == null ? undefined : { content: op.content } });
        break;
      case 'reconcile':
        bg.reconcileBackgroundTask(op.id, { status: op.status, result: op.content == null ? undefined : { content: op.content }, error: op.error });
        break;
      case 'ack':
        bg.acknowledgeBackgroundTaskCompletion(op.id);
        break;
      case 'appendix':
        live.get(op.id).reportAppendix = () => op.text;
        break;
      case 'merge':
        mergeJobMeta(bg.getBackgroundTask(op.id), op.meta);
        break;
      case 'advance':
        clock += op.ms;
        break;
      case 'list':
        out.rows = bg.listBackgroundTasks({ surface: 'agent', context: ctxOf(op.scope) }).map(row);
        break;
      case 'get': {
        const t = bg.getBackgroundTask(op.id, { surface: 'agent', context: ctxOf(op.scope) });
        out.found = Boolean(t);
        out.status = t?.status ?? null;
        out.label = t?.label ?? null;
        break;
      }
      case 'cleanup':
        out.removed = bg.cleanupBackgroundTasks({ surface: 'agent', context: ctxOf(op.scope), force: op.force === true }).removed;
        break;
      case 'bulk':
        for (let i = 0; i < op.n; i += 1) {
          clock += 1;
          bg.registerBackgroundTask({ taskId: `b${i}`, surface: 'agent', operation: 'spawn', meta: {}, context: {} });
          bg.completeBackgroundTask(`b${i}`, { status: 'completed', notify: false });
        }
        out.rows = bg.listBackgroundTasks({ surface: 'agent' }).map((t) => t.task_id);
        break;
      default:
        throw new Error(`unknown op ${op.op}`);
    }
    await tick();
    out.notices = notices.map((n) => ({ ...n }));
    out.settled = [...settledCwds];
    results.push(out);
  }
  return results;
}

const reg = (id, extra = {}) => ({ op: 'register', id, tag: id, sessionId: `${id}-sess`, agent: 'worker', caller: 's1', pid: 11, ...extra });
const scenarios = [
  {
    name: 'completion_is_announced_once_with_its_result',
    ops: [reg('t1'), { op: 'list', scope: { session: 's1' } }, { op: 'complete', id: 't1', status: 'completed', content: 'done <ok> & more' }, { op: 'complete', id: 't1', status: 'failed', error: 'late' }, { op: 'list', scope: { session: 's1' } }],
  },
  {
    name: 'a_failed_run_names_its_error',
    ops: [reg('t1'), { op: 'complete', id: 't1', status: 'error', content: 'partial', error: 'boom <x>' }, { op: 'list' }],
  },
  {
    name: 'status_words_are_normalised',
    ops: [reg('a'), reg('b'), reg('c'), { op: 'complete', id: 'a', status: 'done', content: 'x' }, { op: 'complete', id: 'b', status: 'killed' }, { op: 'complete', id: 'c', status: 'success', content: 'y' }, { op: 'list' }],
  },
  {
    name: 'a_header_only_completion_is_announced_once',
    ops: [reg('t1'), { op: 'complete', id: 't1', status: 'completed' }, { op: 'reconcile', id: 't1', status: 'completed' }, { op: 'list' }],
  },
  {
    name: 'the_report_appendix_follows_the_body',
    ops: [reg('t1'), { op: 'appendix', id: 't1', text: 'not done: a, b' }, { op: 'complete', id: 't1', status: 'completed', content: 'body' }],
  },
  {
    name: 'an_appendix_alone_is_not_a_body',
    ops: [reg('t1'), { op: 'appendix', id: 't1', text: 'not done: a' }, { op: 'complete', id: 't1', status: 'completed' }],
  },
  {
    name: 'a_notify_on_cancel_job_reports_once_after_its_run_settles',
    ops: [reg('t1', { notifyOnCancel: true }), { op: 'cancel', id: 't1', reason: 'cancelled by agent close' }, { op: 'list' }, { op: 'settle', id: 't1', content: 'partial work' }, { op: 'settle', id: 't1', content: 'again' }, { op: 'list' }],
  },
  {
    name: 'cancel_now_reports_at_once',
    ops: [reg('t1', { notifyOnCancel: true }), { op: 'cancel', id: 't1', reason: 'stop', notice: 'now' }, { op: 'settle', id: 't1', content: 'late' }],
  },
  {
    name: 'owner_teardown_cancels_silently',
    ops: [reg('t1', { notifyOnCancel: true }), { op: 'cancel', id: 't1', reason: 'teardown', notice: 'never' }, { op: 'settle', id: 't1', content: 'late' }, { op: 'list' }],
  },
  {
    name: 'a_job_without_notify_on_cancel_cancels_silently',
    ops: [reg('t1'), { op: 'cancel', id: 't1', reason: 'stop' }, { op: 'list' }],
  },
  {
    name: 'cancelling_a_finished_job_changes_nothing',
    ops: [reg('t1'), { op: 'complete', id: 't1', status: 'completed', content: 'ok' }, { op: 'cancel', id: 't1', reason: 'late', notice: 'now' }, { op: 'list' }],
  },
  {
    name: 'scope_follows_session_identity_then_process',
    ops: [
      reg('own', { caller: 's1', pid: 11 }),
      reg('sibling', { caller: 's2', pid: 11 }),
      reg('pidonly', { caller: null, owner: 's9', pid: 11, sessionId: null }),
      reg('loose', { caller: null, owner: null, pid: null, sessionId: null }),
      { op: 'list', scope: { session: 's1' } },
      { op: 'list', scope: { session: 's2', pid: 11 } },
      { op: 'list', scope: { pid: 11 } },
      { op: 'list', scope: { pid: 12 } },
      { op: 'list' },
      { op: 'get', id: 'own', scope: { session: 's2' } },
      { op: 'get', id: 'own', scope: { session: 's1' } },
      { op: 'get', id: 'loose', scope: { session: 's2' } },
    ],
  },
  {
    name: 'finished_rows_expire_after_thirty_minutes_inside_the_scope_asked',
    ops: [
      reg('old1', { caller: 's1' }),
      reg('old2', { caller: 's2' }),
      reg('live', { caller: 's1' }),
      { op: 'complete', id: 'old1', status: 'completed', content: 'a', notify: false },
      { op: 'complete', id: 'old2', status: 'completed', content: 'b', notify: false },
      { op: 'advance', ms: 30 * 60_000 + 1 },
      { op: 'list', scope: { session: 's1' } },
      { op: 'list', scope: { session: 's2' } },
      { op: 'list' },
    ],
  },
  {
    name: 'cleanup_counts_what_it_removes_and_force_removes_running_rows_too',
    ops: [
      reg('a', { caller: 's1' }),
      reg('b', { caller: 's1' }),
      reg('c', { caller: 's2' }),
      { op: 'complete', id: 'a', status: 'completed', notify: false },
      { op: 'cleanup', scope: { session: 's1' } },
      { op: 'advance', ms: 31 * 60_000 },
      { op: 'cleanup', scope: { session: 's1' } },
      { op: 'cleanup', scope: { session: 's1' }, force: true },
      { op: 'list' },
      { op: 'cleanup', force: true },
      { op: 'list' },
    ],
  },
  {
    name: 'an_acknowledged_completion_is_never_announced',
    ops: [reg('t1'), { op: 'complete', id: 't1', status: 'completed', content: 'x', notify: false }, { op: 'ack', id: 't1' }, { op: 'reconcile', id: 't1', status: 'completed' }, { op: 'list' }],
  },
  {
    name: 'reconcile_completes_a_stuck_row_and_reannounces_an_unannounced_one',
    ops: [reg('stuck'), reg('quiet'), { op: 'reconcile', id: 'stuck', status: 'completed', content: 'recovered' }, { op: 'complete', id: 'quiet', status: 'completed', content: 'q', notify: false }, { op: 'reconcile', id: 'quiet', status: 'completed' }, { op: 'reconcile', id: 'quiet', status: 'completed' }, { op: 'list' }],
  },
  {
    name: 'a_duplicate_explicit_id_is_refused',
    ops: [reg('t1'), reg('t1')],
  },
  {
    name: 'no_session_to_tell_means_no_notice',
    ops: [reg('t1', { caller: null, owner: null }), { op: 'complete', id: 't1', status: 'completed', content: 'x' }],
  },
  {
    name: 'the_owner_session_receives_when_there_is_no_caller',
    ops: [reg('t1', { caller: null, owner: 'lead' }), { op: 'complete', id: 't1', status: 'completed', content: 'x' }],
  },
  {
    name: 'a_later_meta_update_relabels_the_row',
    ops: [reg('t1', { tag: null, sessionId: null }), { op: 'list' }, { op: 'merge', id: 't1', meta: { tag: 'ops', sessionId: 'sess-9' } }, { op: 'list' }],
  },
  {
    name: 'a_start_time_in_the_future_is_clamped_to_now',
    ops: [reg('t1', { startedAt: 5000 }), reg('t2', { startedAt: -5000 }), { op: 'list' }],
  },
  {
    name: 'the_table_keeps_the_newest_three_hundred_finished_rows',
    ops: [{ op: 'bulk', n: 310 }],
  },
  {
    name: 'cancel_all_by_execution_session_follows_the_bound_session_else_the_owner',
    ops: [
      reg('bound', { caller: 's1', sessionId: 'w1' }),
      reg('unbound', { caller: 'w1', sessionId: null }),
      reg('other', { caller: 's1', sessionId: 'w2' }),
      reg('nobody', { caller: null, owner: null, pid: null, sessionId: null }),
      { op: 'cancelAll', execution: 'w1', reason: 'session closed', terminalReason: 'closing' },
      { op: 'list' },
      { op: 'cancelAll', execution: 'w1', reason: 'again' },
    ],
  },
  {
    name: 'cancel_all_by_scope_never_claims_a_job_with_no_owner',
    ops: [
      reg('own', { caller: 's1', pid: 11 }),
      reg('sibling', { caller: 's2', pid: 11 }),
      reg('pidonly', { caller: null, owner: 's9', pid: 11, sessionId: null }),
      reg('loose', { caller: null, owner: null, pid: null, sessionId: null }),
      { op: 'cancelAll', scope: { session: 's1' } },
      { op: 'cancelAll', scope: { pid: 11 }, reason: '  stop  ' },
      { op: 'cancelAll' },
      { op: 'list' },
    ],
  },
  {
    name: 'cancel_all_selects_by_start_time',
    ops: [
      reg('early', { caller: 's1', startedAt: 0 }),
      { op: 'advance', ms: 1000 },
      reg('late', { caller: 's1' }),
      { op: 'cancelAll', scope: { session: 's1' }, startedSince: 500 },
      { op: 'list' },
    ],
  },
  {
    name: 'cancel_all_notice_modes_and_finished_rows',
    ops: [
      reg('a', { notifyOnCancel: true }),
      reg('b', { notifyOnCancel: true }),
      reg('c', { notifyOnCancel: true }),
      reg('done', { notifyOnCancel: true }),
      { op: 'complete', id: 'done', status: 'completed', content: 'x', notify: false },
      { op: 'cancelAll', execution: 'a-sess', notice: 'now' },
      { op: 'cancelAll', execution: 'b-sess', notice: 'never' },
      { op: 'cancelAll', execution: 'c-sess' },
      { op: 'cancelAll', execution: 'done-sess', notice: 'never' },
      { op: 'settle', id: 'a', content: 'late a' },
      { op: 'settle', id: 'b', content: 'late b' },
      { op: 'settle', id: 'c', content: 'late c' },
      { op: 'list' },
    ],
  },
  {
    name: 'a_finished_job_in_a_directory_marks_a_command_boundary_whichever_way_it_ends',
    ops: [
      reg('ok', { cwd: '/work/a' }),
      reg('bad', { cwd: '/work/b' }),
      reg('stop', { cwd: '/work/c' }),
      reg('stop2', { cwd: '/work/d' }),
      reg('none'),
      { op: 'complete', id: 'ok', status: 'completed', content: 'x' },
      { op: 'complete', id: 'ok', status: 'completed', content: 'again' },
      { op: 'complete', id: 'bad', status: 'failed', error: 'boom' },
      { op: 'cancel', id: 'stop', reason: 'stop' },
      { op: 'cancelAll', execution: 'stop2-sess' },
      { op: 'complete', id: 'none', status: 'completed', content: 'x' },
    ],
  },
  {
    name: 'a_started_job_completes_on_its_run_result',
    ops: [
      { op: 'start', id: 's1', tag: 's1', sessionId: 's1-sess', caller: 'lead' },
      { op: 'list' },
      { op: 'resolveRun', id: 's1', content: 'all done' },
      { op: 'list' },
    ],
  },
  {
    name: 'a_started_job_fails_on_a_rejected_run',
    ops: [
      { op: 'start', id: 's1', tag: 's1', caller: 'lead' },
      { op: 'rejectRun', id: 's1', error: 'provider  said no\n at sess_abcdef0123 end' },
      { op: 'list' },
    ],
  },
  {
    name: 'a_cancelled_started_job_reports_once_after_its_run_settles',
    ops: [
      { op: 'start', id: 's1', tag: 's1', caller: 'lead', notifyOnCancel: true },
      { op: 'cancel', id: 's1', reason: 'agent close' },
      { op: 'rejectRun', id: 's1', error: 'aborted' },
      { op: 'list' },
    ],
  },
  {
    name: 'a_cancelled_started_job_that_resolves_keeps_its_cancellation',
    ops: [
      { op: 'start', id: 's1', tag: 's1', caller: 'lead', notifyOnCancel: true },
      { op: 'cancel', id: 's1', reason: 'agent close' },
      { op: 'resolveRun', id: 's1', content: 'late result' },
      { op: 'list' },
    ],
  },
];

const board = [];
for (const s of scenarios) {
  // Each scenario starts from a clean table and the same clock.
  clock = START;
  bg.cancelBackgroundTasks({ reason: 'reset', notify: false });
  bg.cleanupBackgroundTasks({ force: true });
  board.push({ name: s.name, start: START, ops: s.ops, results: await play(s.ops) });
}

// ---- progress --------------------------------------------------------------------------------

const NOW = Date.parse('2026-03-01T12:00:00.000Z');
const ago = (s) => NOW - s * 1000;
const policy = { firstTransportMs: 120000, firstSemanticMs: 600000, idleStaleMs: 600000 };
const registered = { registered: true };
const bases = [
  { name: 'no_input' },
  { name: 'idle_session', sessionStatus: 'idle', runtimeStage: 'idle' },
  { name: 'idle_empty_final', sessionStatus: 'idle', runtimeStage: 'idle', runtime: { emptyFinal: true } },
  { name: 'done', runtimeStage: 'done' },
  { name: 'error', runtimeStage: 'error' },
  { name: 'closed', runtimeStage: 'closed' },
  { name: 'cancelling', runtimeStage: 'cancelling' },
  { name: 'resource_wait', runtimeStage: 'resource_wait' },
  { name: 'connecting', runtimeStage: 'connecting' },
  { name: 'requesting', runtimeStage: 'requesting' },
  { name: 'running_stage', runtimeStage: 'running', runtime: { lastProgressAt: ago(42) } },
  { name: 'tool_running_named', runtimeStage: 'tool_running', lastToolCall: 'bash', runtime: { toolStartedAt: ago(7) } },
  { name: 'tool_running_unnamed', runtimeStage: 'tool_running', runtime: { toolStartedAt: ago(7) } },
  { name: 'tool_running_runtime_tool', runtimeStage: 'tool_running', runtime: { lastToolCall: 'read' } },
  { name: 'tool_silence', runtimeStage: 'tool_running', lastToolCall: 'task', toolSilence: { taskId: 'task_shell_1', silentMs: 725000, hung: false } },
  { name: 'tool_hung', runtimeStage: 'tool_running', lastToolCall: 'task', toolSilence: { taskId: 'task_shell_1', silentMs: 725000, hung: true } },
  { name: 'tool_silence_short', runtimeStage: 'tool_running', toolSilence: { taskId: 't', silentMs: 400, hung: false } },
  { name: 'tool_silence_idle_stage', runtimeStage: 'idle', toolSilence: { taskId: 't', silentMs: 90000, hung: true } },
  { name: 'streaming_plain', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastStreamDeltaAt: ago(2) } },
  { name: 'streaming_quiet', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastStreamDeltaAt: ago(9) } },
  { name: 'streaming_quiet_runtime', runtimeStage: 'streaming', runtime: { lastStreamDeltaAt: ago(11) } },
  { name: 'streaming_text', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastSemanticKind: 'text', lastProgressAt: ago(1) } },
  { name: 'streaming_tool', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastSemanticKind: 'tool' } },
  { name: 'streaming_reasoning_silent', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastSemanticKind: 'reasoning' } },
  { name: 'streaming_reasoning_after_text', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastSemanticKind: 'reasoning', lastVisibleTextAt: ago(30) } },
  { name: 'streaming_first_semantic', runtimeStage: 'streaming', snapshot: { stage: 'streaming', hasFirstSemantic: true } },
  { name: 'awaiting_headers', runtimeStage: 'requesting', snapshot: { stage: 'requesting', awaitingModelResponse: true, modelRequestStartedAt: ago(5) } },
  { name: 'waiting_transport', runtimeStage: 'requesting', snapshot: { stage: 'requesting', waitingForTransport: true, modelRequestStartedAt: ago(5) } },
  { name: 'waiting_first_semantic', runtimeStage: 'streaming', snapshot: { stage: 'streaming', waitingForFirstSemantic: true, modelRequestStartedAt: ago(5) } },
  { name: 'stage_from_snapshot', snapshot: { stage: 'streaming', lastProgressAt: ago(3) } },
  { name: 'stage_from_session_status', sessionStatus: 'streaming' },
  { name: 'queued_one_active', runtimeStage: 'streaming', queuedFollowups: 1 },
  { name: 'queued_two_idle', runtimeStage: 'idle', queuedFollowups: 2 },
  { name: 'queued_junk', runtimeStage: 'idle', queuedFollowups: 'x' },
  { name: 'queued_fraction', runtimeStage: 'idle', queuedFollowups: 2.7 },
  { name: 'silent_all_clocks', runtimeStage: 'streaming', snapshot: { lastProgressAt: ago(100), lastStreamDeltaAt: ago(40), toolStartedAt: ago(70), askStartedAt: ago(200) }, runtime: { lastProgressAt: ago(10) } },
  { name: 'silent_idle_hidden', runtimeStage: 'idle', runtime: { lastProgressAt: ago(100) } },
];
const taskStatuses = [undefined, 'running', 'completed', 'failed', 'cancelled', 'canceled', 'error'];
const sessionStatuses = [undefined, 'error'];
const policies = [
  { label: 'none', policy: undefined },
  { label: 'unarmed', policy, watchdogState: { registered: false } },
  { label: 'check_failed', policy, watchdogState: { registered: true, error: 'probe died' } },
  { label: 'armed', policy, watchdogState: registered },
  { label: 'inactive', policy: { firstTransportMs: 0, firstSemanticMs: 0, idleStaleMs: 0 }, watchdogState: registered },
  { label: 'idle_only', policy: { firstTransportMs: 0, firstSemanticMs: 0, idleStaleMs: 90000 }, watchdogState: registered },
];
const staleSnapshots = [
  { name: 'stale_idle', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastProgressAt: ago(700), hasFirstSemantic: true } },
  { name: 'stale_idle_keepalive_holds', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastProgressAt: ago(700), lastKeepaliveAt: ago(100), hasFirstSemantic: true } },
  { name: 'stale_idle_keepalive_past_cap', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastProgressAt: ago(2000), lastKeepaliveAt: ago(100), hasFirstSemantic: true } },
  { name: 'stale_first_transport', runtimeStage: 'requesting', snapshot: { stage: 'requesting', waitingForTransport: true, modelRequestStartedAt: ago(500) } },
  { name: 'stale_first_semantic', runtimeStage: 'streaming', snapshot: { stage: 'streaming', waitingForFirstSemantic: true, modelRequestStartedAt: ago(900) } },
  { name: 'stale_awaiting_user', runtimeStage: 'streaming', snapshot: { stage: 'streaming', lastProgressAt: ago(5000), awaitingUser: true } },
  { name: 'stale_queued_connecting', runtimeStage: 'connecting', snapshot: { stage: 'connecting', lastProgressAt: ago(5000) } },
  { name: 'stale_running_runtime_only', runtimeStage: 'running', runtime: { lastProgressAt: ago(900) } },
  { name: 'stale_first_activity', runtimeStage: 'tool_running', snapshot: { stage: 'tool_running', firstActivityAt: ago(900) } },
];
const cases = [];
for (const b of bases) {
  for (const taskStatus of taskStatuses.slice(0, b.name.startsWith('queued') || b.name === 'no_input' ? taskStatuses.length : 3)) {
    for (const sessionStatus of b.sessionStatus === undefined && b.name === 'idle_session' ? sessionStatuses : [b.sessionStatus]) {
      cases.push({ name: `${b.name}/${taskStatus ?? 'none'}/${sessionStatus ?? 'none'}`, input: { ...b, name: undefined, sessionStatus, taskStatus } });
    }
  }
}
for (const s of staleSnapshots) {
  for (const p of policies) {
    cases.push({ name: `${s.name}/${p.label}`, input: { ...s, name: undefined, policy: p.policy, watchdogState: p.watchdogState } });
  }
}
for (const b of bases.slice(0, 20)) {
  cases.push({ name: `${b.name}/armed_policy`, input: { ...b, name: undefined, policy, watchdogState: registered } });
}
const progress = cases.map((c) => {
  const input = { now: NOW, ...c.input };
  return { name: c.name, input, output: buildAgentTaskProgressFields(input) };
});

const dir = join(stage, 'jobs');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`);
writeFileSync(join(dir, 'progress.json'), `${JSON.stringify(progress, null, 2)}\n`);
refreshSetManifest(stage, nodeRoot);
commitStage(stage, here);
console.log(`board ${board.length} scenarios, progress ${progress.length} cases`);
process.exit(0);
