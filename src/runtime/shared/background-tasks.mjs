import {
  TOOL_ASYNC_EXECUTION_CONTRACT,
  TOOL_MANUAL_CONTROL_CONTRACT,
  TOOL_SYNC_EXECUTION_CONTRACT,
  normalizeToolNotifyContext,
  notifyToolCompletion,
} from './tool-execution-contract.mjs';
import { presentErrorText } from './err-text.mjs';
import { clean } from './clean.mjs';
import { emitSessionActivityChange } from './session-activity-signal.mjs';
import {
  parseTaskNotification,
  renderTaskCompletionEnvelope,
  renderShellCompletionNotice,
} from './task-notification-envelope.mjs';

export { TOOL_ASYNC_EXECUTION_CONTRACT, TOOL_MANUAL_CONTROL_CONTRACT, TOOL_SYNC_EXECUTION_CONTRACT };

const TASK_TTL_MS = 30 * 60_000;
const MAX_TASKS = 300;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
// A `notifyOnCancel` task reports its cancellation to the owner once, after its
// run settles, so the notification can carry what the run produced before it
// stopped. A run that never settles still reports, header-only, after this grace.
const CANCEL_NOTIFY_GRACE_MS = 10_000;
const tasks = new Map();
let seq = 0;

function compactText(value, max = 32_000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n\n[background task output truncated]` : text;
}

export function taskIdFromArgs(args = {}) {
  return clean(args.task_id);
}

function nextTaskId(surface) {
  seq += 1;
  const safe =
    clean(surface)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_') || 'tool';
  return `task_${safe}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function normalizeStatus(status) {
  const value = clean(status).toLowerCase();
  if (value === 'done' || value === 'success') return 'completed';
  if (value === 'error') return 'failed';
  if (value === 'cancelled' || value === 'canceled' || value === 'killed') return 'cancelled';
  return value || 'running';
}

function normalizeTaskScope(options = {}) {
  const source = options.context && typeof options.context === 'object' ? { ...options.context, ...options } : options;
  const ctx = normalizeToolNotifyContext(source);
  return {
    callerSessionId: ctx.callerSessionId || null,
    routingSessionId: ctx.routingSessionId || null,
    clientHostPid: ctx.clientHostPid || null,
  };
}

const RENDER_META_OMIT_KEYS = new Set([
  // Internal watchdog/control knobs are intentionally not part of the public
  // task notification surface. They may appear on legacy/in-flight task meta
  // from older callers, but rendering them teaches the model/user to set them.
  'firstResponseTimeoutMs',
  'idleTimeoutMs',
  'spawnPrepTimeoutMs',
  'watchdogPolicy',
]);

function isInternalTaskMetaKey(key) {
  const name = clean(key);
  if (!name) return true;
  if (RENDER_META_OMIT_KEYS.has(name)) return true;
  if (/timeoutms$/i.test(name)) return true;
  return false;
}

/** Drop internal control knobs from meta before persisting on a task row. */
export function sanitizeTaskMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(meta)) {
    if (isInternalTaskMetaKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function publicTaskMeta(meta = {}) {
  const out = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value == null || value === '') continue;
    if (isInternalTaskMetaKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function hasScopeCriteria(scope) {
  return Boolean(scope?.callerSessionId || scope?.routingSessionId || scope?.clientHostPid);
}

function taskSessionIdOf(task) {
  return task.ownerSessionId || task.notifyContext?.callerSessionId || task.notifyContext?.routingSessionId || null;
}

// `scope` is normalizeTaskScope(options), normalized once per scan by the
// caller: a scan is O(tasks), and the daemon runs one per session per
// busy-count, so per-task normalization multiplied into seconds under load.
function taskMatchesScope(task, scope, { includeUnattributed = true } = {}) {
  if (!task) return false;
  if (!hasScopeCriteria(scope)) return true;
  const taskSessionId = taskSessionIdOf(task);
  const taskClientHostPid = task.clientHostPid || task.notifyContext?.clientHostPid || null;
  // Legacy/unattributed tasks remain visible so old async jobs are still recoverable.
  if (!taskSessionId && !taskClientHostPid) return includeUnattributed;
  // Session identity dominates: tasks are session-owned, and one host process
  // (shard/desktop) can run many sessions on the same clientHostPid — a pid
  // match must never leak a sibling session's task into a session-scoped view.
  if ((scope.callerSessionId || scope.routingSessionId) && taskSessionId) {
    return taskSessionId === scope.callerSessionId || taskSessionId === scope.routingSessionId;
  }
  if (scope.clientHostPid && taskClientHostPid === scope.clientHostPid) return true;
  return false;
}

function pruneTasks(options = {}) {
  const { force = false, surface } = options;
  const now = Date.now();
  const wanted = clean(surface);
  const scope = normalizeTaskScope(options);
  // Deleting the entry being visited is safe during Map iteration.
  for (const [taskId, task] of tasks) {
    if (wanted && task.surface !== wanted) continue;
    const finishedAt = task.finishedAtMs || 0;
    if (!force && !(finishedAt > 0 && now - finishedAt > TASK_TTL_MS)) continue;
    if (taskMatchesScope(task, scope)) tasks.delete(taskId);
  }
  if (tasks.size <= MAX_TASKS) return;
  const removable = [...tasks.values()]
    .filter((task) => TERMINAL_STATUSES.has(task.status))
    .sort((a, b) => (a.finishedAtMs || a.startedAtMs) - (b.finishedAtMs || b.startedAtMs));
  while (tasks.size > MAX_TASKS && removable.length > 0) {
    const task = removable.shift();
    tasks.delete(task.taskId);
  }
}

export function registerBackgroundTask({
  taskId,
  startedAtMs,
  surface,
  operation = 'run',
  label,
  input,
  context,
  meta,
  resultType,
  renderResult,
  cancel,
  notifyOnCancel = false,
} = {}) {
  pruneTasks();
  const explicitId = clean(taskId);
  let id = explicitId || nextTaskId(surface);
  if (tasks.has(id)) {
    if (explicitId) throw new Error(`background task already exists: ${id}`);
    while (tasks.has(id)) id = nextTaskId(surface);
  }
  const registeredAt = Date.now();
  const requestedStart = Number(startedAtMs);
  const now =
    Number.isFinite(requestedStart) && requestedStart > 0
      ? Math.min(registeredAt, Math.floor(requestedStart))
      : registeredAt;
  const notifyContext = normalizeToolNotifyContext(context);
  const task = {
    taskId: id,
    surface: clean(surface) || 'tool',
    operation: clean(operation) || 'run',
    label: clean(label) || null,
    input: input || null,
    status: 'running',
    startedAtMs: now,
    startedAt: new Date(now).toISOString(),
    finishedAtMs: null,
    finishedAt: null,
    result: undefined,
    resultText: null,
    error: null,
    notified: false,
    notifyContext,
    ownerSessionId: notifyContext.callerSessionId || notifyContext.routingSessionId || null,
    routingSessionId: notifyContext.routingSessionId || notifyContext.callerSessionId || null,
    clientHostPid: notifyContext.clientHostPid || null,
    meta: sanitizeTaskMeta(meta && typeof meta === 'object' ? meta : {}),
    resultType: clean(resultType) || null,
    renderResult: typeof renderResult === 'function' ? renderResult : null,
    cancel: typeof cancel === 'function' ? cancel : null,
    notifyOnCancel: notifyOnCancel === true,
  };
  tasks.set(id, task);
  emitSessionActivityChange(task.ownerSessionId || '');
  return task;
}

export function startBackgroundTask(options = {}) {
  const task = registerBackgroundTask(options);
  task.promise = Promise.resolve()
    .then(() => options.run?.())
    .then((result) => {
      completeBackgroundTask(task.taskId, { status: 'completed', result, terminalReason: 'run-resolved' });
      deliverCancelledNotification(task);
      return result;
    })
    .catch((error) => {
      if (task.status === 'cancelled') {
        deliverCancelledNotification(task);
        return null;
      }
      completeBackgroundTask(task.taskId, {
        status: 'failed',
        error,
        terminalReason: 'run-rejected',
      });
      return null;
    });
  return task;
}

export function getBackgroundTask(taskId, options = {}) {
  pruneTasks();
  const task = tasks.get(clean(taskId)) || null;
  if (!task) return null;
  const wanted = clean(options.surface);
  if (wanted && task.surface !== wanted) return null;
  if (!taskMatchesScope(task, normalizeTaskScope(options))) return null;
  return task;
}

function countsAsActive(task, wanted, awaitedOnly) {
  return task.status === 'running' && !(awaitedOnly && task.detached === true) && (!wanted || task.surface === wanted);
}

/** Lifetime signal: a session-owned background task remains live
 * work even while the interactive turn is idle and every view is detached.
 * `awaitedOnly` leaves out `detached` tasks: processes a finished command
 * deliberately left running (an app or server it launched), which nothing is
 * waiting on and which may outlive the session's work by days.
 * A read: pruning only ever drops finished tasks, which never count here. */
export function hasActiveBackgroundTasks(options = {}) {
  const wanted = clean(options.surface);
  const awaitedOnly = options.awaitedOnly === true;
  const scope = normalizeTaskScope(options);
  for (const task of tasks.values()) {
    if (countsAsActive(task, wanted, awaitedOnly) && taskMatchesScope(task, scope, { includeUnattributed: false })) {
      return true;
    }
  }
  return false;
}

/** Every owner session `hasActiveBackgroundTasks({ callerSessionId, surface,
 *  awaitedOnly })` answers true for, from ONE pass over the tasks: a caller
 *  asking for every session (busy counts, pool rows) scans once instead of
 *  once per session. */
export function activeBackgroundTaskSessionIds(options = {}) {
  const wanted = clean(options.surface);
  const awaitedOnly = options.awaitedOnly === true;
  const ids = new Set();
  for (const task of tasks.values()) {
    if (!countsAsActive(task, wanted, awaitedOnly)) continue;
    const sessionId = taskSessionIdOf(task);
    if (sessionId) ids.add(sessionId);
  }
  return ids;
}

export function listBackgroundTasks(options = {}) {
  const { surface } = options;
  pruneTasks(options);
  const wanted = clean(surface);
  const scope = normalizeTaskScope(options);
  return [...tasks.values()]
    .filter((task) => !wanted || task.surface === wanted)
    .filter((task) => taskMatchesScope(task, scope))
    .map((task) => taskSummary(task));
}

export function cleanupBackgroundTasks(options = {}) {
  const wanted = clean(options.surface);
  const scope = normalizeTaskScope(options);
  const countForSurface = () =>
    [...tasks.values()].filter((task) => (!wanted || task.surface === wanted) && taskMatchesScope(task, scope)).length;
  const before = countForSurface();
  pruneTasks(options);
  const after = countForSurface();
  return { removed: before - after, tasks: after };
}

// `notify`: true notifies immediately, false never notifies (owner teardown).
// Left unset, a `notifyOnCancel` task defers its single `cancelled`
// notification until its run settles (see settleCancelledBackgroundTask); any
// other task stays silent. `terminalReason` records why it was cancelled.
function cancelRunningTask(task, reason, notify, terminalReason = null) {
  try {
    task.cancel?.();
  } catch {}
  completeBackgroundTask(task.taskId, { status: 'cancelled', error: reason, notify: notify === true, terminalReason });
  if (task.notifyOnCancel !== true || notify === true || task.status !== 'cancelled' || task.cancelNotify) return;
  if (notify === false) {
    task.cancelNotify = 'silent';
    return;
  }
  task.cancelNotify = 'pending';
  task.cancelNotifyTimer = setTimeout(() => deliverCancelledNotification(task), CANCEL_NOTIFY_GRACE_MS);
  task.cancelNotifyTimer.unref?.();
}

// Owner teardown/delete (`notify: false`) also silences a cancellation that is
// still waiting for its run to settle.
function resolvePendingCancelNotify(task, next) {
  if (task.cancelNotify !== 'pending') return false;
  clearTimeout(task.cancelNotifyTimer);
  task.cancelNotifyTimer = null;
  task.cancelNotify = next;
  return true;
}

function silenceCancelledNotification(task) {
  resolvePendingCancelNotify(task, 'silent');
}

function deliverCancelledNotification(task) {
  if (!resolvePendingCancelNotify(task, 'delivered')) return false;
  if (tasks.get(task.taskId) !== task) return false;
  task.meta = sanitizeTaskMeta(task.meta);
  return notifyTaskCompletion(task, task.notificationInstruction);
}

export function cancelBackgroundTask(taskId, reason = 'cancelled', { notify } = {}) {
  const task = getBackgroundTask(taskId);
  if (!task) return null;
  if (!TERMINAL_STATUSES.has(task.status)) cancelRunningTask(task, reason, notify);
  else if (notify === false) silenceCancelledNotification(task);
  return task;
}

/** The cancelled run has stopped: attach what it produced before stopping (if
 *  any) and deliver the task's single deferred `cancelled` notification. A
 *  no-op unless that notification is still pending. */
export function settleCancelledBackgroundTask(taskId, { result } = {}) {
  const task = getBackgroundTask(taskId);
  if (task?.status !== 'cancelled' || task.cancelNotify !== 'pending') return null;
  if (result !== undefined) task.result = result;
  deliverCancelledNotification(task);
  return task;
}

/** Cancel the running tasks `options` selects. `terminalReason` (optional) is
 *  stamped on each one cancelled, so its run's settlement can tell why. */
export function cancelBackgroundTasks(options = {}) {
  const reason = clean(options.reason) || 'cancelled';
  const terminalReason = clean(options.terminalReason) || null;
  const wanted = clean(options.surface);
  const executionSessionId = clean(options.executionSessionId);
  const scope = normalizeTaskScope(options);
  let cancelled = 0;
  for (const task of [...tasks.values()]) {
    if (wanted && task.surface !== wanted) continue;
    // Scoped teardown must be exact. Legacy tasks without ownership stay
    // visible/recoverable, but may not be claimed by whichever session happens
    // to close first.
    if (executionSessionId) {
      // Delegated work executes in its bound session; before binding it still
      // belongs to the registering session. Notification ownership is separate.
      if ((clean(task.meta?.sessionId) || task.ownerSessionId) !== executionSessionId) continue;
    } else if (!taskMatchesScope(task, scope, { includeUnattributed: false })) continue;
    if (TERMINAL_STATUSES.has(task.status)) {
      if (options.notify === false) silenceCancelledNotification(task);
      continue;
    }
    cancelRunningTask(task, reason, options.notify, terminalReason);
    cancelled += 1;
  }
  return { cancelled };
}

export function acknowledgeBackgroundTaskCompletion(taskId, options = {}) {
  const task = getBackgroundTask(taskId, options);
  if (!task || !TERMINAL_STATUSES.has(task.status)) return null;
  // A terminal task read is an explicit consumer ACK. It wins over a racing
  // async notify settlement and prevents any later reconcile from re-firing
  // the same completion.
  task.completionAcknowledged = true;
  task.notified = true;
  task.notifiedWithBody = true;
  return task;
}

function resultTextForTask(task) {
  if (task.resultText) return task.resultText;
  if (task.result !== undefined) {
    if (typeof task.renderResult === 'function') {
      try {
        const rendered = String(task.renderResult(task.result, task) || '');
        if (rendered) return rendered;
      } catch (err) {
        // Don't silently swallow a renderer throw: fall through to the JSON
        // fallback below so the completion notification still carries a body.
        try {
          process.stderr.write(`[background-${task.surface}] renderResult failed: ${err?.message || err}\n`);
        } catch {}
      }
    }
    if (typeof task.result === 'string') return task.result;
    try {
      return JSON.stringify(task.result, null, 2);
    } catch {}
  }
  return '';
}

export function completeBackgroundTask(
  taskId,
  {
    status = 'completed',
    result,
    resultText,
    error,
    resultType,
    instruction,
    notify = true,
    terminalReason = null,
  } = {}
) {
  const task = getBackgroundTask(taskId);
  if (!task) return null;
  if (TERMINAL_STATUSES.has(task.status)) return task;
  const now = Date.now();
  task.status = normalizeStatus(status);
  task.finishedAtMs = now;
  task.finishedAt = new Date(now).toISOString();
  if (terminalReason) task.terminalReason = terminalReason;
  if (result !== undefined) task.result = result;
  if (resultText != null) task.resultText = String(resultText);
  if (error != null) task.error = presentErrorText(error, { surface: task.surface });
  if (resultType) task.resultType = resultType;
  if (instruction) task.notificationInstruction = compactText(instruction, 1_000);
  emitSessionActivityChange(task.ownerSessionId || '');
  if (notify) {
    task.meta = sanitizeTaskMeta(task.meta);
    notifyTaskCompletion(task, instruction);
  }
  return task;
}

// Surfaces whose later reads consume the structured result object itself:
// shell `task read` re-reads output via result paths and renders exit_code /
// timed_out / signal; agent job views return `job.result`. They keep it for the
// TTL; every other surface keeps only resultText + metadata once delivered.
const RESULT_KEPT_SURFACES = new Set(['shell', 'agent']);

function releaseDeliveredResult(task, body) {
  if (task.result === undefined || RESULT_KEPT_SURFACES.has(task.surface)) return;
  // Pin the rendered body first so re-renders and retries stay identical.
  if (!task.resultText) task.resultText = body;
  task.result = undefined;
}

export function notifyTaskCompletion(task, instruction) {
  if (!task) return false;
  if (!TERMINAL_STATUSES.has(task.status)) return false;
  if (task.completionAcknowledged === true) return false;
  // A deferred cancellation is delivered only by deliverCancelledNotification;
  // a silent (owner-teardown) cancellation never notifies.
  if (task.cancelNotify === 'pending' || task.cancelNotify === 'silent') return false;
  // `notified` tracks whether *any* completion notification was sent (e.g. an
  // early header-only preview from the agent surface). A later call that can
  // finally include the result body must still fire once, otherwise the owner
  // only ever sees the bodyless preview. Gate on `notifiedWithBody` so the
  // body-carrying notification is delivered exactly once.
  const body = resultTextForTask(task);
  const hasBody = Boolean(body);
  if (task.notifiedWithBody === true) return false;
  if (task.notified === true && !hasBody) return false;
  const text = renderBackgroundTaskNotification(task);
  const sent = notifyToolCompletion({
    surface: task.surface,
    id: task.taskId,
    status: task.status,
    text,
    resultType: task.resultType || `${task.surface}_task_result`,
    instruction,
    context: task.notifyContext,
    logPrefix: `background-${task.surface}`,
    // Async notifyFn: `sent` is reported optimistically while the delivery
    // promise is still in flight, so mark delivered now but let settlement
    // confirm it. If the notifyFn rejects/declines AND the fallback rescue also
    // fails, un-mark so a later reconcile can retry rather than leaving the
    // completion silently unsent. A successful/rescued async delivery keeps the
    // marks, preserving exact-once.
    onSettled: (delivered) => {
      if (delivered) return;
      if (task.completionAcknowledged === true) return;
      task.notified = false;
      task.notifiedWithBody = false;
    },
  });
  if (sent) {
    task.notified = true;
    if (hasBody) {
      task.notifiedWithBody = true;
      releaseDeliveredResult(task, body);
    }
  }
  return sent;
}

// Safety net for the "task stuck in running" failure mode: when an upstream
// owner (e.g. the agent surface) knows a job has reached a terminal state but
// the normal run-resolved path did not mark the task — typically because a
// post-result step (session save) hung or threw before the task promise could
// settle — this forces the task to a terminal state and fires the completion
// notification. Idempotent: a no-op once the task is already terminal.
export function reconcileBackgroundTask(
  taskId,
  { status = 'completed', result, resultText, error, instruction, terminalReason = 'reconciled' } = {}
) {
  const task = getBackgroundTask(taskId);
  if (!task) return null;
  if (TERMINAL_STATUSES.has(task.status)) {
    // Already terminal, but a prior async completion notify may have un-marked
    // itself after a reject/decline whose fallback rescue also missed
    // (notifyTaskCompletion's onSettled clears notified/notifiedWithBody). The
    // task never leaves its terminal status, so without retrying here the
    // body-carrying completion stays silently unsent. Re-fire the notification;
    // it is idempotent once notifiedWithBody is set, preserving exact-once.
    if (task.notifiedWithBody !== true) notifyTaskCompletion(task, instruction);
    return task;
  }
  return completeBackgroundTask(task.taskId, {
    status,
    result,
    resultText,
    error,
    instruction,
    terminalReason,
  });
}

export function renderBackgroundTaskNotification(task) {
  if (!task) return '';
  const result =
    task.surface === 'agent' && typeof task.result?.content === 'string'
      ? task.result.content
      : resultTextForTask(task);
  if (task.surface === 'shell') {
    const parsed = parseTaskNotification(result);
    // The completion envelope already carries the result (exit code,
    // duration, output or its summary): deliver it as is.
    if (parsed?.result) return result;
    return renderShellCompletionNotice({
      jobId: task.taskId,
      status: task.status,
      exitCode: parsed?.exitCode ?? task.result?.exit_code ?? null,
      command: task.input?.command || task.label,
      outputFile: parsed?.outputFile || task.result?.stdout_path || task.meta?.stdout,
      error: parsed?.error || task.error,
    });
  }
  return renderTaskCompletionEnvelope({
    surface: task.surface,
    id: task.taskId,
    tag: task.meta?.tag || task.label,
    status: task.status,
    result,
    error: task.error,
    // A cancelled Agent's header names the cancel reason.
    detail: task.surface === 'agent' && task.status === 'cancelled' ? task.error : null,
  });
}

function taskSummary(task) {
  if (!task) return null;
  return {
    task_id: task.taskId,
    surface: task.surface,
    operation: task.operation,
    label: task.label,
    status: task.status,
    notified: task.notified === true,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    ...publicTaskMeta(task.meta),
  };
}

// `ownerTool`: the block is the result of the very tool that owns the surface
// (the shell's own start notice), so the tool name already says the surface and
// the caller already knows the cwd it ran in.
export function renderBackgroundTask(taskOrId, { includeResult = false, ownerTool = false } = {}) {
  const task = typeof taskOrId === 'string' ? getBackgroundTask(taskOrId) : taskOrId;
  if (!task) return 'Error: background task not found';
  const body = includeResult ? resultTextForTask(task) : '';
  const envelope = task.surface === 'shell' ? parseTaskNotification(body) : null;
  const exitCode = task.surface === 'shell' ? (envelope?.exitCode ?? task.result?.exit_code) : null;
  const visibleMeta = publicTaskMeta(sanitizeTaskMeta(task.meta));
  const lines = [
    'background task',
    `task_id: ${task.taskId}`,
    ownerTool ? null : `surface: ${task.surface}`,
    task.operation && task.operation !== task.surface ? `operation: ${task.operation}` : null,
    // A result read follows the start notice, which already showed the label.
    task.label && !(includeResult && task.surface === 'shell') ? `label: ${task.label}` : null,
    `status: ${task.status}`,
    exitCode != null ? `exit_code: ${exitCode}` : null,
    task.result?.timed_out === true ? 'timed_out: true' : null,
    task.result?.signal ? `signal: ${task.result.signal}` : null,
    `started: ${task.startedAt}`,
    task.finishedAt ? `finished: ${task.finishedAt}` : null,
    task.error || envelope?.error ? `error: ${task.error || envelope.error}` : null,
  ];
  // stdout/stderr log paths differ only by suffix (`.stdout`/`.stderr`,
  // optionally followed by `.log`) — collapse to one line.
  const stdoutLog = typeof visibleMeta.stdout === 'string' ? visibleMeta.stdout : null;
  const stderrLog = typeof visibleMeta.stderr === 'string' ? visibleMeta.stderr : null;
  const stdoutParts = stdoutLog ? /^(.*)\.stdout(\.log)?$/.exec(stdoutLog) : null;
  const logs =
    stdoutParts && stderrLog === `${stdoutParts[1]}.stderr${stdoutParts[2] || ''}`
      ? `${stdoutParts[1]}.{stdout,stderr}${stdoutParts[2] || ''}`
      : null;
  for (const [key, value] of Object.entries(visibleMeta)) {
    if (key === 'task_id' || key === 'surface' || key === 'operation') continue;
    if (logs && (key === 'stdout' || key === 'stderr')) continue;
    if (key === 'cwd' && (ownerTool || (includeResult && task.surface === 'shell'))) continue;
    lines.push(`${key}: ${value}`);
  }
  if (logs) lines.push(`logs: ${logs}`);
  if (includeResult) {
    if (body) {
      lines.push('', envelope ? envelope.result : body);
    } else if (task.status === 'completed' && !task.error) {
      // Terminal-completed task with no extractable body: surface a placeholder
      // instead of silently omitting the result so the owner isn't left with a
      // header-only card that looks truncated.
      lines.push('', '(no result body — use read for full output)');
    }
  }
  return lines.filter((line) => line !== null).join('\n');
}

export function renderBackgroundTaskList(options = {}) {
  const rows = listBackgroundTasks(options);
  if (!rows.length) return 'background tasks: 0';
  return [
    `background tasks: ${rows.length}`,
    ...rows.map(
      (task) =>
        `- ${task.task_id} ${task.surface}/${task.operation} ${task.status}${task.label ? ` label=${task.label}` : ''}${task.error ? ` error=${task.error}` : ''}`
    ),
  ].join('\n');
}
