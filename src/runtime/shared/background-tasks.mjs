import {
  TOOL_ASYNC_EXECUTION_CONTRACT,
  TOOL_MANUAL_CONTROL_CONTRACT,
  TOOL_SYNC_EXECUTION_CONTRACT,
  normalizeToolNotifyContext,
  notifyToolCompletion,
} from './tool-execution-contract.mjs';
import { presentErrorText, errorLine } from './err-text.mjs';

export {
  TOOL_ASYNC_EXECUTION_CONTRACT,
  TOOL_MANUAL_CONTROL_CONTRACT,
  TOOL_SYNC_EXECUTION_CONTRACT,
};

const TASK_TTL_MS = 30 * 60_000;
const MAX_TASKS = 300;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const tasks = new Map();
let seq = 0;

// Owner-injected fallback used by notifyToolCompletion: when no notifyFn is
// available (or it declines), enqueue the completion onto the caller session so
// the owner is never left waiting on a canonical completion that never arrives.
let _enqueueFallback = null;
export function setBackgroundTaskEnqueueFallback(fn) {
  _enqueueFallback = typeof fn === 'function' ? fn : null;
}

function clean(value) {
  return String(value ?? '').trim();
}

function compactText(value, max = 32_000) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max)}\n\n[background task output truncated]` : text;
}

export function resolveExecutionMode(args = {}, defaultMode = 'sync') {
  const explicit = clean(args.mode || args.executionMode || args.execution_mode).toLowerCase();
  if (['async', 'background', 'detached'].includes(explicit)) return 'async';
  if (['sync', 'foreground', 'inline', 'wait'].includes(explicit)) return 'sync';
  if (args.async === true || args.background === true) return 'async';
  if (args.async === false || args.background === false) return 'sync';
  if (args.wait === true) return 'sync';
  if (args.wait === false) return 'async';
  return defaultMode === 'async' ? 'async' : 'sync';
}

export function executionModeSchemaDescription(defaultMode = 'sync') {
  if (defaultMode === 'async') {
    return 'sync = inline result; async = task_id + completion notification. Default async.';
  }
  return 'Runs sync (inline result); no default auto-background. async forces a background task_id + completion notification.';
}

export function taskIdFromArgs(args = {}) {
  return clean(args.task_id);
}

function nextTaskId(surface) {
  seq += 1;
  const safe = clean(surface).toLowerCase().replace(/[^a-z0-9_-]+/g, '_') || 'tool';
  return `task_${safe}_${Date.now().toString(36)}_${seq.toString(36)}`;
}

function normalizeStatus(status) {
  const value = clean(status).toLowerCase();
  if (value === 'done' || value === 'success') return 'completed';
  if (value === 'error') return 'failed';
  if (value === 'cancelled' || value === 'canceled' || value === 'killed') return 'cancelled';
  if (value === 'running') return 'running';
  return value || 'running';
}

function normalizeTaskScope(options = {}) {
  const source = options.context && typeof options.context === 'object'
    ? { ...options.context, ...options }
    : options;
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

function taskMatchesScope(task, options = {}) {
  if (!task) return false;
  const scope = normalizeTaskScope(options);
  if (!hasScopeCriteria(scope)) return true;
  const taskSessionId = task.ownerSessionId || task.notifyContext?.callerSessionId || task.notifyContext?.routingSessionId || null;
  const taskClientHostPid = task.clientHostPid || task.notifyContext?.clientHostPid || null;
  // Legacy/unattributed tasks remain visible so old async jobs are still recoverable.
  if (!taskSessionId && !taskClientHostPid) return true;
  if (scope.callerSessionId && taskSessionId === scope.callerSessionId) return true;
  if (scope.routingSessionId && taskSessionId === scope.routingSessionId) return true;
  if (scope.clientHostPid && taskClientHostPid === scope.clientHostPid) return true;
  return false;
}

function pruneTasks(options = {}) {
  const { force = false, surface } = options;
  const now = Date.now();
  const wanted = clean(surface);
  for (const [taskId, task] of [...tasks.entries()]) {
    if (wanted && task.surface !== wanted) continue;
    if (!taskMatchesScope(task, options)) continue;
    const finishedAt = task.finishedAtMs || 0;
    if (force || (finishedAt > 0 && now - finishedAt > TASK_TTL_MS)) tasks.delete(taskId);
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
  surface,
  operation = 'run',
  label,
  input,
  context,
  meta,
  resultType,
  renderResult,
  cancel,
} = {}) {
  pruneTasks();
  const explicitId = clean(taskId);
  let id = explicitId || nextTaskId(surface);
  if (tasks.has(id)) {
    if (explicitId) throw new Error(`background task already exists: ${id}`);
    while (tasks.has(id)) id = nextTaskId(surface);
  }
  const now = Date.now();
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
  };
  tasks.set(id, task);
  return task;
}

export function startBackgroundTask(options = {}) {
  const task = registerBackgroundTask(options);
  task.promise = Promise.resolve()
    .then(() => options.run?.())
    .then((result) => {
      completeBackgroundTask(task.taskId, { status: 'completed', result, terminalReason: 'run-resolved' });
      return result;
    })
    .catch((error) => {
      if (task.status === 'cancelled') return null;
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
  if (!taskMatchesScope(task, options)) return null;
  return task;
}

export function listBackgroundTasks(options = {}) {
  const { surface } = options;
  pruneTasks(options);
  const wanted = clean(surface);
  return [...tasks.values()]
    .filter((task) => !wanted || task.surface === wanted)
    .filter((task) => taskMatchesScope(task, options))
    .map((task) => taskSummary(task));
}

export function cleanupBackgroundTasks(options = {}) {
  const wanted = clean(options.surface);
  const countForSurface = () => wanted
    ? [...tasks.values()].filter((task) => task.surface === wanted && taskMatchesScope(task, options)).length
    : [...tasks.values()].filter((task) => taskMatchesScope(task, options)).length;
  const before = countForSurface();
  pruneTasks(options);
  const after = countForSurface();
  return { removed: before - after, tasks: after };
}

export function cancelBackgroundTask(taskId, reason = 'cancelled') {
  const task = getBackgroundTask(taskId);
  if (!task) return null;
  if (!TERMINAL_STATUSES.has(task.status)) {
    try { task.cancel?.(); } catch {}
    completeBackgroundTask(task.taskId, { status: 'cancelled', error: reason, notify: false });
  }
  return task;
}

export function cancelBackgroundTasks(options = {}) {
  const reason = clean(options.reason) || 'cancelled';
  const wanted = clean(options.surface);
  let cancelled = 0;
  for (const task of [...tasks.values()]) {
    if (wanted && task.surface !== wanted) continue;
    if (!taskMatchesScope(task, options)) continue;
    if (TERMINAL_STATUSES.has(task.status)) continue;
    try { task.cancel?.(); } catch {}
    completeBackgroundTask(task.taskId, { status: 'cancelled', error: reason, notify: options.notify === true });
    cancelled += 1;
  }
  return { cancelled };
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
        try { process.stderr.write(`[background-${task.surface}] renderResult failed: ${err?.message || err}\n`); } catch {}
      }
    }
    if (typeof task.result === 'string') return task.result;
    try { return JSON.stringify(task.result, null, 2); } catch {}
  }
  return '';
}

export function completeBackgroundTask(taskId, {
  status = 'completed',
  result,
  resultText,
  error,
  resultType,
  instruction,
  notify = true,
  terminalReason = null,
} = {}) {
  const task = getBackgroundTask(taskId);
  if (!task) return null;
  if (TERMINAL_STATUSES.has(task.status)) return task;
  const now = Date.now();
  task.status = normalizeStatus(status);
  task.finishedAtMs = now;
  task.finishedAt = new Date(now).toISOString();
  if (terminalReason) task.terminalReason = terminalReason;
  if (result !== undefined) task.result = result;
  if (resultText != null) task.resultText = compactText(resultText);
  if (error != null) task.error = presentErrorText(error, { surface: task.surface });
  if (resultType) task.resultType = resultType;
  if (notify) {
    task.meta = sanitizeTaskMeta(task.meta);
    notifyTaskCompletion(task, instruction);
  }
  return task;
}

export function notifyTaskCompletion(task, instruction) {
  if (!task) return false;
  if (!TERMINAL_STATUSES.has(task.status)) return false;
  // `notified` tracks whether *any* completion notification was sent (e.g. an
  // early header-only preview from the agent surface). A later call that can
  // finally include the result body must still fire once, otherwise the owner
  // only ever sees the bodyless preview. Gate on `notifiedWithBody` so the
  // body-carrying notification is delivered exactly once.
  const body = resultTextForTask(task);
  const hasBody = Boolean(body);
  if (task.notifiedWithBody === true) return false;
  if (task.notified === true && !hasBody) return false;
  const text = renderBackgroundTask(task, { includeResult: true });
  const sent = notifyToolCompletion({
    surface: task.surface,
    id: task.taskId,
    status: task.status,
    text,
    resultType: task.resultType || `${task.surface}_task_result`,
    instruction,
    context: task.notifyContext,
    enqueueFallback: _enqueueFallback || undefined,
    logPrefix: `background-${task.surface}`,
  });
  if (sent) {
    task.notified = true;
    if (hasBody) task.notifiedWithBody = true;
  }
  return sent;
}

// Safety net for the "task stuck in running" failure mode: when an upstream
// owner (e.g. the agent surface) knows a job has reached a terminal state but
// the normal run-resolved path did not mark the task — typically because a
// post-result step (session save) hung or threw before the task promise could
// settle — this forces the task to a terminal state and fires the completion
// notification. Idempotent: a no-op once the task is already terminal.
export function reconcileBackgroundTask(taskId, {
  status = 'completed',
  result,
  resultText,
  error,
  instruction,
  terminalReason = 'reconciled',
} = {}) {
  const task = getBackgroundTask(taskId);
  if (!task) return null;
  if (TERMINAL_STATUSES.has(task.status)) return task;
  return completeBackgroundTask(task.taskId, {
    status,
    result,
    resultText,
    error,
    instruction,
    terminalReason,
  });
}

export function notifyBackgroundTaskProgress(taskOrId, {
  text,
  resultText,
  resultType,
  instruction,
  key = 'progress',
  status = null,
  once = true,
} = {}) {
  const task = typeof taskOrId === 'string' ? getBackgroundTask(taskOrId) : taskOrId;
  if (!task || TERMINAL_STATUSES.has(task.status)) return false;
  const body = compactText(text ?? resultText ?? renderBackgroundTask(task, { includeResult: false }));
  if (!body) return false;
  const progressKey = clean(key || resultType || instruction || 'progress');
  if (once) {
    if (!task.progressNotifiedKeys) task.progressNotifiedKeys = new Set();
    if (task.progressNotifiedKeys.has(progressKey)) return false;
  }
  const sent = notifyToolCompletion({
    surface: task.surface,
    id: task.taskId,
    status,
    text: body,
    resultType: resultType || `${task.surface}_task_progress`,
    instruction,
    context: task.notifyContext,
    enqueueFallback: _enqueueFallback || undefined,
    logPrefix: `background-${task.surface}`,
  });
  if (sent && once) task.progressNotifiedKeys.add(progressKey);
  return sent;
}

export function taskSummary(task) {
  if (!task) return null;
  return {
    task_id: task.taskId,
    surface: task.surface,
    operation: task.operation,
    label: task.label,
    status: task.status,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    error: task.error,
    ...publicTaskMeta(task.meta),
  };
}

export function renderBackgroundTask(taskOrId, { includeResult = false } = {}) {
  const task = typeof taskOrId === 'string' ? getBackgroundTask(taskOrId) : taskOrId;
  if (!task) return 'Error: background task not found';
  const visibleMeta = publicTaskMeta(sanitizeTaskMeta(task.meta));
  const lines = [
    'background task',
    `task_id: ${task.taskId}`,
    `surface: ${task.surface}`,
    `operation: ${task.operation}`,
    task.label ? `label: ${task.label}` : null,
    `status: ${task.status}`,
    `started: ${task.startedAt}`,
    task.finishedAt ? `finished: ${task.finishedAt}` : null,
    task.error ? `error: ${task.error}` : null,
  ];
  for (const [key, value] of Object.entries(visibleMeta)) {
    lines.push(`${key}: ${value}`);
  }
  if (task.status === 'running') {
    lines.push('notification: completion will be delivered to the owner session; use status/read only for manual recovery.');
  }
  if (includeResult) {
    const body = resultTextForTask(task);
    if (body) {
      lines.push('', body);
    } else if (TERMINAL_STATUSES.has(task.status) && task.error) {
      lines.push('', errorLine(task.error, { surface: task.surface }));
    } else if (TERMINAL_STATUSES.has(task.status) && task.status === 'completed') {
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
    ...rows.map((task) => `- ${task.task_id} ${task.surface}/${task.operation} ${task.status}${task.label ? ` label=${task.label}` : ''}${task.error ? ` error=${task.error}` : ''}`),
  ].join('\n');
}
