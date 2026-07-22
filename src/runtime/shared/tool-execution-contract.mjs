export const TOOL_SYNC_EXECUTION_CONTRACT =
  'Runs synchronously in this tool call.';

export const TOOL_ASYNC_EXECUTION_CONTRACT =
  'Runs sync inline; no default auto-background. async forces a background task_id + completion notification. status/read/wait are recovery/blocking only.';

export const TOOL_MANUAL_CONTROL_CONTRACT =
  'wait/read/status/cancel are for explicit blocking or recovery only.';

function clean(value) {
  return String(value ?? '').trim();
}

function positivePid(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const NON_PERSISTENT_TOOL_STATUSES = new Set(['running', 'pending', 'queued']);
const TERMINAL_TOOL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'error',
  'timeout',
  'done',
  'success',
]);

function notificationResultBody(text) {
  const match = /\n\s*\n([\s\S]*)$/.exec(String(text || ''));
  return match ? String(match[1] || '').trim() : '';
}

export function backgroundTaskHeaderStatus(text) {
  const match = /^status:\s*(\S+)/mi.exec(String(text || ''));
  return clean(match?.[1]).toLowerCase();
}

function notificationHead(text) {
  const value = String(text || '').trim();
  const match = /\n\s*\n/.exec(value);
  if (!match) return value;
  return value.slice(0, match.index).trim();
}

function isInternalTaskNotificationEnvelope(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  if (/^background task\b/i.test(value)) return false;
  if (/^<task-notification\b/i.test(value)) return true;
  const head = notificationHead(value);
  return /^<task-notification\b/i.test(head);
}

export function shouldPersistModelVisibleToolCompletion(text, meta = {}) {
  const message = String(text || '').trim();
  if (!message) return false;
  if (isInternalTaskNotificationEnvelope(message)) return false;

  const metaStatus = clean(meta?.status).toLowerCase();
  if (NON_PERSISTENT_TOOL_STATUSES.has(metaStatus)) return false;

  if (/^background task\b/i.test(message)) {
    const headerStatus = backgroundTaskHeaderStatus(message) || metaStatus;
    if (NON_PERSISTENT_TOOL_STATUSES.has(headerStatus)) return false;
    if (!TERMINAL_TOOL_STATUSES.has(headerStatus) && !TERMINAL_TOOL_STATUSES.has(metaStatus)) return false;
    return Boolean(notificationResultBody(message));
  }

  if (meta?.execution_id || meta?.execution_surface) {
    if (NON_PERSISTENT_TOOL_STATUSES.has(metaStatus)) return false;
    if (!TERMINAL_TOOL_STATUSES.has(metaStatus)) return false;
    return Boolean(notificationResultBody(message));
  }

  if (/^(?:agent task:|task_id:)/mi.test(message)) {
    if (NON_PERSISTENT_TOOL_STATUSES.has(metaStatus)) return false;
    if (!TERMINAL_TOOL_STATUSES.has(metaStatus)) return false;
    return Boolean(notificationResultBody(message));
  }

  return false;
}

const BRACKETED_SHELL_STATUS_RE = /^\[status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled|error|timeout|done|success)\]/im;

export function isBracketedShellNotificationEnvelope(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (!/^\[task_id:\s*\S+\]/im.test(value)) return false;
  return BRACKETED_SHELL_STATUS_RE.test(value);
}

export function isInternalRuntimeNotificationText(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (isInternalTaskNotificationEnvelope(value)) return true;
  if (isBracketedShellNotificationEnvelope(value)) return true;
  if (/^background task\b/i.test(value)
    && /^task_id:\s*\S+/mi.test(value)
    && /^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)\b/mi.test(value)) {
    return true;
  }
  if (/^task_id:\s*\S+/mi.test(value)
    && /^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)\b/mi.test(value)
    && /^(?:surface|operation|type|target|role|agent|preset|model|effort|fast|notification):\s*/mi.test(value)) {
    return true;
  }
  return false;
}

export function normalizeToolNotifyContext(context = {}) {
  const explicitCallerSessionId = clean(context.callerSessionId || context.sessionId);
  const explicitRoutingSessionId = clean(context.routingSessionId);
  const callerSessionId = explicitCallerSessionId || explicitRoutingSessionId;
  const routingSessionId = explicitRoutingSessionId || callerSessionId;
  const clientHostPid = positivePid(context.clientHostPid);
  return {
    notifyFn: typeof context.notifyFn === 'function' ? context.notifyFn : null,
    callerSessionId: callerSessionId || null,
    routingSessionId: routingSessionId || null,
    clientHostPid,
  };
}

export function toolCompletionInstruction({ surface = 'tool', id, status, detail } = {}) {
  const label = surface === 'shell'
    ? 'shell task'
    : surface === 'agent'
      ? 'agent task'
      : `${surface} execution`;
  const statusText = status ? ` (${status}${detail ? `, ${detail}` : ''})` : '';
  return `The async ${label} ${id || ''} has finished${statusText} - review this result in your next step.`;
}

function toolCompletionMeta({
  surface = 'tool',
  id,
  status,
  resultType,
  instruction,
  context,
} = {}) {
  const ctx = normalizeToolNotifyContext(context);
  return {
    type: resultType || `${surface}_completion`,
    execution_surface: surface,
    execution_id: id || null,
    status: status || null,
    instruction: instruction || toolCompletionInstruction({ surface, id, status }),
    ...(ctx.callerSessionId ? { caller_session_id: ctx.callerSessionId } : {}),
    ...(ctx.routingSessionId && ctx.routingSessionId !== ctx.callerSessionId ? { routing_session_id: ctx.routingSessionId } : {}),
    ...(ctx.clientHostPid ? { client_host_pid: String(ctx.clientHostPid) } : {}),
  };
}

const MODEL_VISIBLE_COMPLETION_INSTRUCTION_RE = /\b(async (?:agent task|shell task|\w+ execution)|Async \S+)/i;
const MODEL_VISIBLE_COMPLETION_REVIEW_RE = /has finished\b[\s\S]*review this result in your next step/i;
const MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE = /^Async .+ finished\./i;

export function isModelVisibleToolCompletionWrapper(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const resultSplit = /\n\nResult:\n/.exec(value);
  if (!resultSplit) return false;
  const preamble = value.slice(0, resultSplit.index).trim();
  if (!preamble) return false;
  const instructionLike = MODEL_VISIBLE_COMPLETION_INSTRUCTION_RE.test(preamble)
    || MODEL_VISIBLE_COMPLETION_REVIEW_RE.test(preamble)
    || MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(preamble);
  if (!instructionLike) return false;
  const quotedSection = value.slice(resultSplit.index + resultSplit[0].length);
  const quotedLines = quotedSection.split(/\r?\n/).filter((line) => line.length > 0);
  if (quotedLines.length === 0) return false;
  if (!quotedLines.every((line) => /^> /.test(line))) return false;
  const unquoted = quotedLines.map((line) => line.slice(2)).join('\n');
  return isInternalRuntimeNotificationText(unquoted);
}

// Lenient companion to isModelVisibleToolCompletionWrapper: the strict check
// additionally requires the quoted body to pass isInternalRuntimeNotificationText,
// which can miss legitimate completion wrappers whose internal body shape
// drifts (e.g. new async surfaces/status text). This shape-only variant just
// confirms "looks like an instruction preamble + Result: + quoted body" so a
// TUI transcript never leaks a raw wrapper as a plain user message when the
// strict detector misses — display-only, never used to gate persistence.
export function isLikelyToolCompletionWrapper(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const resultSplit = /\n\nResult:\n/.exec(value);
  if (!resultSplit) return false;
  const preamble = value.slice(0, resultSplit.index).trim();
  if (!preamble) return false;
  const instructionLike = MODEL_VISIBLE_COMPLETION_INSTRUCTION_RE.test(preamble)
    || MODEL_VISIBLE_COMPLETION_REVIEW_RE.test(preamble)
    || MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(preamble);
  if (!instructionLike) return false;
  const quotedSection = value.slice(resultSplit.index + resultSplit[0].length);
  const quotedLines = quotedSection.split(/\r?\n/).filter((line) => line.length > 0);
  if (quotedLines.length === 0) return false;
  const quotedCount = quotedLines.filter((line) => /^> /.test(line)).length;
  return quotedCount / quotedLines.length >= 0.8;
}

export function modelVisibleToolCompletionMessage(text, meta = {}) {
  const message = String(text || '').trim();
  if (!message) return '';
  if (!shouldPersistModelVisibleToolCompletion(message, meta)) return '';
  const instruction = clean(meta?.instruction);
  const type = clean(meta?.type || meta?.execution_surface || 'tool_completion');
  const id = clean(meta?.execution_id);
  const status = clean(meta?.status);
  const header = `Async ${type}${id ? ` ${id}` : ''}${status ? ` ${status}` : ''} finished.`;
  const MODEL_VISIBLE_RESULT_BODY_MAX = 12_000;
  const bounded = message.length > MODEL_VISIBLE_RESULT_BODY_MAX
    ? `${message.slice(0, MODEL_VISIBLE_RESULT_BODY_MAX)}\n\n[result truncated for model context]`
    : message;
  const quoted = bounded.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
  return [
    instruction || header,
    '',
    'Result:',
    quoted,
  ].join('\n');
}

// Shared enqueue-fallback helper used by both the synchronous fallback path and
// the asynchronous notifyFn reject/false-resolve rescue path. Only enqueues when
// a caller session and fallback fn are present. Returns true only on a non-false,
// non-zero fallback result; logs and returns false on throw.
function tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id) {
  if (!ctx.callerSessionId || typeof enqueueFallback !== 'function') return false;
  try {
    const enq = enqueueFallback(ctx.callerSessionId, message, meta);
    return enq !== false && enq !== 0;
  } catch (err) {
    try {
      process.stderr.write(`[${logPrefix}] async completion fallback enqueue failed: id=${id || 'unknown'} err=${err?.message || err}\n`);
    } catch {}
  }
  return false;
}

export function notifyToolCompletion({
  surface = 'tool',
  id,
  status,
  text,
  resultType,
  instruction,
  context,
  enqueueFallback,
  logPrefix = 'tool-execution',
  onSettled,
} = {}) {
  const ctx = normalizeToolNotifyContext(context);
  const message = String(text || '');
  if (!message) return false;
  const meta = toolCompletionMeta({
    surface,
    id,
    status,
    resultType,
    instruction,
    context: ctx,
  });

  // Try the upstream owner notifyFn first. A `false` return means the owner
  // *declined* delivery and a throw means it failed outright — in both cases we
  // do NOT return early but fall through to the enqueueFallback path so the
  // completion can still reach the caller session. Only a successful (non-false)
  // notifyFn short-circuits as delivered.
  if (typeof ctx.notifyFn === 'function') {
    try {
      const notifyResult = ctx.notifyFn(message, meta);
      if (notifyResult !== false) {
        const isThenable = notifyResult && typeof notifyResult.then === 'function';
        if (isThenable) {
          // A Promise notifyFn has NOT delivered yet — settlement decides the
          // real outcome. Return `true` synchronously so the caller does not
          // double-deliver through the sync fallback, but signal the FINAL
          // delivered state via onSettled so the caller only *marks* the
          // completion delivered after settlement. On a reject or explicit
          // false/0 resolve, rescue via enqueueFallback; onSettled then reports
          // whether that rescue (or the notifyFn itself) actually delivered, so
          // a caller can un-mark and retry when nothing landed. The truthy
          // resolve path never enqueues, preserving exact-once delivery.
          Promise.resolve(notifyResult).then((settled) => {
            if (settled === false || settled === 0) {
              const rescued = tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id);
              if (typeof onSettled === 'function') onSettled(rescued);
            } else if (typeof onSettled === 'function') {
              onSettled(true);
            }
          }).catch((err) => {
            try {
              process.stderr.write(`[${logPrefix}] async completion notify failed: id=${id || 'unknown'} err=${err?.message || err}\n`);
            } catch {}
            const rescued = tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id);
            if (typeof onSettled === 'function') onSettled(rescued);
          });
          return true;
        }
        // Synchronous non-false result → confirmed delivered now.
        return true;
      }
    } catch (err) {
      try {
        process.stderr.write(`[${logPrefix}] async completion notify failed: id=${id || 'unknown'} err=${err?.message || err}\n`);
      } catch {}
    }
  }

  // Fallback enqueue (used when notifyFn is absent, declined, or threw). Respect
  // the fallback's own success signal: an explicit false/0 return means the
  // enqueue failed, so report failure and leave room for a retry rather than
  // marking the task notified.
  return tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id);
}
