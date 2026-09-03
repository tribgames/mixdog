export const TOOL_SYNC_EXECUTION_CONTRACT =
  'Runs synchronously in this tool call.';

export const TOOL_ASYNC_EXECUTION_CONTRACT =
  'Runs sync inline by default; async returns a background task_id and delivers a completion notification.';

export const TOOL_MANUAL_CONTROL_CONTRACT =
  'read returns one current output snapshot; cancel is for manual recovery, while normal completion arrives by notification.';

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

export function shouldPersistModelVisibleToolCompletion(text, meta = {}) {
  const message = String(text || '').trim();
  if (!message) return false;

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
  return `Async ${label} ${id || ''}${statusText} finished.`;
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

const MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE = /^Async .+ finished\./i;

export function isModelVisibleToolCompletionWrapper(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const resultSplit = /\n\nResult:\n/.exec(value);
  if (!resultSplit) return false;
  const preamble = value.slice(0, resultSplit.index).trim();
  if (!preamble) return false;
  const instructionLike = MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(preamble);
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
  const instructionLike = MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(preamble);
  if (!instructionLike) return false;
  const quotedSection = value.slice(resultSplit.index + resultSplit[0].length);
  const quotedLines = quotedSection.split(/\r?\n/).filter((line) => line.length > 0);
  if (quotedLines.length === 0) return false;
  const quotedCount = quotedLines.filter((line) => /^> /.test(line)).length;
  return quotedCount / quotedLines.length >= 0.8;
}

const INTERNAL_TRANSCRIPT_CONTEXT_RE =
  /^<(?:system-reminder|skill|memory-context|mcp-instructions|available-deferred-tools|event)\b/i;
const INTERNAL_TRANSCRIPT_SYNTHETIC_RE =
  /^(?:\[mixdog-runtime\]|A previous model worked on this task and produced the compacted handoff summary below\b|Re-attached after compaction\b|Reference files:\s)/i;
const INTERNAL_TRANSCRIPT_ASYNC_HEAD_RE = /^Async .+ finished\./i;
const TRANSCRIPT_HIDDEN_CONTROL_TOOL_NAMES = new Set([
  'goal',
  'create_goal',
  'get_goal',
  'set_goal_tasks',
  'update_goal',
  'load_tool',
  'tool_search',
]);
// Skill loads are visible cards EXCEPT for built-in skills: those ride a
// built-in feature whose own card (Browser Use, Document work, ...) follows
// immediately, so the skill card would only repeat it. The runtime marks a
// built-in load in the tool_result stub (collect.mjs buildSkillStub); live
// turns decide earlier from the skill source so no card flashes first.
const TRANSCRIPT_SKILL_TOOL_RE = /^(?:skill|skill_view|use_skill|skill_execute)$/;
const BUILTIN_SKILL_RESULT_RE = /^Loaded built-in skill:/i;

function normalizeTranscriptToolName(name) {
  return clean(name).toLowerCase().replace(/^functions\./, '');
}

export function isTranscriptHiddenControlToolName(name) {
  return TRANSCRIPT_HIDDEN_CONTROL_TOOL_NAMES.has(normalizeTranscriptToolName(name));
}

export function isTranscriptSkillToolName(name) {
  return TRANSCRIPT_SKILL_TOOL_RE.test(normalizeTranscriptToolName(name));
}

export function isBuiltinSkillToolResult(result) {
  return BUILTIN_SKILL_RESULT_RE.test(String(result ?? '').trim());
}

/** Settled tool item (name + result) that the transcript must not show. */
export function isTranscriptHiddenToolItem(item) {
  if (!item) return false;
  if (isTranscriptHiddenControlToolName(item.name)) return true;
  return isTranscriptSkillToolName(item.name) && isBuiltinSkillToolResult(item.result);
}

// Persisted USER cancellation control rows ("[Request interrupted by user]"
// and its tool-use variant) exist for the next model step, not for humans:
// the human already saw the cancel they typed. The live engine path already
// withholds them; history/lane snapshots deliver them as plain user rows,
// which flashed in unfocused panes until focus swapped the source (user
// report). Full-row match only — never hide real prose around them.
// "[Request interrupted by process restart]" is deliberately NOT matched: it
// is a user-visible crash-recovery marker showing where a force-killed turn
// stopped, and the restored transcript must keep that row
// (scripts/turn-checkpoint-crash-test.mjs).
const INTERNAL_TRANSCRIPT_INTERRUPT_RE =
  /^\[request interrupted by user(?: for tool use)?\]$/i;
const TRANSCRIPT_CANCELLED_STATUS_RE =
  /^\[request interrupted(?: by process restart)?\]$/i;

// Crash/implicit interruption markers remain in model-visible history for
// recovery, but every human transcript renders them as a Cancelled status row.
// Explicit user-cancel markers stay on the hidden-control-row path above
// because the live surface already emitted its cancellation status.
export function isTranscriptCancelledStatusText(text) {
  return TRANSCRIPT_CANCELLED_STATUS_RE.test(String(text ?? '').trim());
}

// One display-only policy for every transcript surface. Runtime control rows
// may be persisted as ordinary role:user messages so the next model step can
// consume them; they are never human-authored chat and must not be rendered.
// The flexible Result separator covers legacy rows and command bodies whose
// embedded newlines lost their quote prefix during persistence.
export function isInternalTranscriptDisplayText(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (INTERNAL_TRANSCRIPT_CONTEXT_RE.test(value)
    || INTERNAL_TRANSCRIPT_SYNTHETIC_RE.test(value)
    || INTERNAL_TRANSCRIPT_INTERRUPT_RE.test(value)
    || isInternalRuntimeNotificationText(value)
    || isModelVisibleToolCompletionWrapper(value)
    || isLikelyToolCompletionWrapper(value)) {
    return true;
  }
  if (INTERNAL_TRANSCRIPT_ASYNC_HEAD_RE.test(value) && !/\bResult:\s*(?:\r?\n|$)/i.test(value)) {
    return true;
  }
  const resultSplit = /\r?\n(?:[ \t]*\r?\n)?Result:[ \t]*\r?\n/i.exec(value);
  if (!resultSplit) return false;
  const preamble = value.slice(0, resultSplit.index).trim();
  const instructionLike = MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(preamble);
  if (!instructionLike) return false;
  const normalizedBody = value.slice(resultSplit.index + resultSplit[0].length)
    .split(/\r?\n/)
    .map((line) => line.replace(/^>\s?/, ''))
    .join('\n')
    .trim();
  return isInternalRuntimeNotificationText(normalizedBody);
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
