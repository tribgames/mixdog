import { clean } from './clean.mjs';
import { hopOf } from './bot-hops.mjs';
import {
  parseTaskNotification,
  renderTaskCompletionEnvelope,
  renderShellCompletionEnvelope,
  taskCompletionSummary,
} from './task-notification-envelope.mjs';

export const TOOL_SYNC_EXECUTION_CONTRACT = 'Returns final results in this call.';

export const TOOL_ASYNC_EXECUTION_CONTRACT =
  'Runs sync inline by default; async returns a background task_id and delivers a completion notification.';

export const TOOL_MANUAL_CONTROL_CONTRACT =
  'read returns one current output snapshot; cancel is for manual recovery, while normal completion arrives by notification.';

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
  const notification = parseTaskNotification(text);
  if (notification) return notification.status;
  const match = /^status:\s*(\S+)/im.exec(String(text || ''));
  return clean(match?.[1]).toLowerCase();
}

export function shouldPersistModelVisibleToolCompletion(text, meta = {}) {
  const message = String(text || '').trim();
  if (!message || meta?.model_visible === false) return false;

  const metaStatus = clean(meta?.status).toLowerCase();
  if (NON_PERSISTENT_TOOL_STATUSES.has(metaStatus)) return false;
  if (parseTaskNotification(message)) return true;
  if (isModelVisibleToolCompletionWrapper(message)) return true;

  if (/^background task\b/i.test(message)) {
    const headerStatus = backgroundTaskHeaderStatus(message) || metaStatus;
    if (NON_PERSISTENT_TOOL_STATUSES.has(headerStatus)) return false;
    if (!TERMINAL_TOOL_STATUSES.has(headerStatus) && !TERMINAL_TOOL_STATUSES.has(metaStatus)) return false;
    return Boolean(notificationResultBody(message));
  }

  // Execution-tagged or legacy task-header completions persist only once the
  // metadata reports a terminal status and a result body follows the header.
  if (meta?.execution_id || meta?.execution_surface || /^(?:agent task:|task_id:)/im.test(message)) {
    if (!TERMINAL_TOOL_STATUSES.has(metaStatus)) return false;
    return Boolean(notificationResultBody(message));
  }

  return false;
}

const BRACKETED_SHELL_STATUS_RE =
  /^\[status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled|error|timeout|done|success)\]/im;

export function isBracketedShellNotificationEnvelope(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (parseTaskNotification(value)?.surface === 'shell') return true;
  if (!/^\[task_id:\s*\S+\]/im.test(value)) return false;
  return BRACKETED_SHELL_STATUS_RE.test(value);
}

export function isInternalRuntimeNotificationText(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (parseTaskNotification(value)) return true;
  if (isBracketedShellNotificationEnvelope(value)) return true;
  if (
    /^background task\b/i.test(value) &&
    /^task_id:\s*\S+/im.test(value) &&
    /^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)\b/im.test(value)
  ) {
    return true;
  }
  if (
    /^task_id:\s*\S+/im.test(value) &&
    /^status:\s*(?:running|pending|queued|completed|failed|cancelled|canceled)\b/im.test(value) &&
    /^(?:surface|operation|type|target|role|agent|preset|model|effort|fast|notification):\s*/im.test(value)
  ) {
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
    // The bot-chain hop of the turn that launched the work (bot-hops.mjs).
    ...(hopOf(context.hop) ? { hop: context.hop } : {}),
  };
}

export function toolCompletionInstruction({ surface = 'tool', id, tag, status, error, detail } = {}) {
  return taskCompletionSummary({ surface, id, tag, status, error, detail });
}

function toolCompletionMeta({ surface = 'tool', id, status, resultType, instruction, context } = {}) {
  const ctx = normalizeToolNotifyContext(context);
  return {
    type: resultType || `${surface}_completion`,
    execution_surface: surface,
    execution_id: id || null,
    status: status || null,
    instruction: instruction || toolCompletionInstruction({ surface, id, status }),
    ...(ctx.callerSessionId ? { caller_session_id: ctx.callerSessionId } : {}),
    ...(ctx.routingSessionId && ctx.routingSessionId !== ctx.callerSessionId
      ? { routing_session_id: ctx.routingSessionId }
      : {}),
    ...(ctx.clientHostPid ? { client_host_pid: String(ctx.clientHostPid) } : {}),
    ...(ctx.hop ? { hop: ctx.hop } : {}),
  };
}

const MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE = /^Async .+ finished\./i;

// Shared shape of both wrapper detectors below: an async-completion preamble,
// the `Result:` separator, and a non-empty quoted body. Returns the body lines
// so each detector only has to decide how strictly to judge them.
function completionWrapperQuotedLines(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const resultSplit = /\n\nResult:\n/.exec(value);
  if (!resultSplit) return null;
  const preamble = value.slice(0, resultSplit.index).trim();
  if (!preamble) return null;
  if (!MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(preamble)) return null;
  const quotedSection = value.slice(resultSplit.index + resultSplit[0].length);
  const quotedLines = quotedSection.split(/\r?\n/).filter((line) => line.length > 0);
  return quotedLines.length > 0 ? quotedLines : null;
}

export function isModelVisibleToolCompletionWrapper(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (parseTaskNotification(value)) return true;
  const quotedLines = completionWrapperQuotedLines(value);
  if (!quotedLines) return false;
  if (!quotedLines.every((line) => /^> /.test(line))) return false;
  const unquoted = quotedLines.map((line) => line.slice(2)).join('\n');
  return isInternalRuntimeNotificationText(unquoted);
}

function isLikelyToolCompletionWrapper(text) {
  const quotedLines = completionWrapperQuotedLines(text);
  if (!quotedLines) return false;
  const quotedCount = quotedLines.filter((line) => /^> /.test(line)).length;
  return quotedCount / quotedLines.length >= 0.8;
}

const INTERNAL_TRANSCRIPT_CONTEXT_RE =
  /^<(?:system-reminder|skill|memory-context|mcp-instructions|available-deferred-tools|event)\b/i;
const INTERNAL_TRANSCRIPT_SYNTHETIC_RE =
  /^(?:\[mixdog-runtime\]|A previous model worked on this task and produced the compacted handoff summary below\b|Re-attached after compaction\b|Reference files:\s)/i;
const TRANSCRIPT_HIDDEN_CONTROL_TOOL_NAMES = new Set([
  'goal',
  'create_goal',
  'get_goal',
  'set_goal_tasks',
  'update_goal',
  // The step list shows in its own composer panel, not as transcript cards.
  'todo',
  'load_tool',
  'tool_search',
  // A bot's reaction shows as its emoji under the user's message, not as a card.
  'react',
]);
const TRANSCRIPT_SKILL_TOOL_RE = /^(?:skill|skill_view|use_skill|skill_execute)$/;
const BUILTIN_SKILL_RESULT_RE = /^Loaded built-in skill:/i;

function normalizeTranscriptToolName(name) {
  return clean(name)
    .toLowerCase()
    .replace(/^functions\./, '');
}

export function isTranscriptHiddenControlToolName(name) {
  return TRANSCRIPT_HIDDEN_CONTROL_TOOL_NAMES.has(normalizeTranscriptToolName(name));
}

export function isTranscriptSkillToolName(name) {
  return TRANSCRIPT_SKILL_TOOL_RE.test(normalizeTranscriptToolName(name));
}

function isBuiltinSkillToolResult(result) {
  return BUILTIN_SKILL_RESULT_RE.test(String(result ?? '').trim());
}

/** Settled tool item (name + result) that the transcript must not show. */
export function isTranscriptHiddenToolItem(item) {
  if (!item) return false;
  if (isTranscriptHiddenControlToolName(item.name)) return true;
  return isTranscriptSkillToolName(item.name) && isBuiltinSkillToolResult(item.result);
}

const INTERNAL_TRANSCRIPT_INTERRUPT_RE = /^\[request interrupted by user(?: for tool use)?\]$/i;
export const CONTROL_MARKER_RE =
  /^\[(?:truncated|request interrupted(?: by user(?: for tool use)?| by process restart)?)\]$/i;
const TRANSCRIPT_CANCELLED_STATUS_RE = /^\[request interrupted(?: by process restart)?\]$/i;

export function isTranscriptCancelledStatusText(text) {
  return TRANSCRIPT_CANCELLED_STATUS_RE.test(String(text ?? '').trim());
}

// The crash-recovery marker is a cut turn, not a cancel the user asked for: its row reads "Interrupted".
export function isProcessRestartStatusText(text) {
  return /^\[request interrupted by process restart\]$/i.test(String(text ?? '').trim());
}

/** Display-only: true for runtime control rows persisted as role:user. `lenientWrapper: false` drops the shape-only wrapper guess, so a typed prompt that merely looks like a wrapper stays visible. */
export function isInternalTranscriptDisplayText(text, { lenientWrapper = true } = {}) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  if (
    INTERNAL_TRANSCRIPT_CONTEXT_RE.test(value) ||
    INTERNAL_TRANSCRIPT_SYNTHETIC_RE.test(value) ||
    INTERNAL_TRANSCRIPT_INTERRUPT_RE.test(value) ||
    isInternalRuntimeNotificationText(value) ||
    isModelVisibleToolCompletionWrapper(value) ||
    (lenientWrapper && isLikelyToolCompletionWrapper(value))
  ) {
    return true;
  }
  if (MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(value) && !/\bResult:\s*(?:\r?\n|$)/i.test(value)) {
    return true;
  }
  const resultSplit = /\r?\n(?:[ \t]*\r?\n)?Result:[ \t]*\r?\n/i.exec(value);
  if (!resultSplit) return false;
  const preamble = value.slice(0, resultSplit.index).trim();
  const instructionLike = MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(preamble);
  if (!instructionLike) return false;
  const normalizedBody = value
    .slice(resultSplit.index + resultSplit[0].length)
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
  if (parseTaskNotification(message)) return message;
  // Old in-flight producers and stored rows remain readable, but a new
  // enqueue always uses the tagged wire format, never the quoted wrapper.
  const split = /\n\nResult:\n/.exec(message);
  const unwrapped =
    split && MODEL_VISIBLE_COMPLETION_ASYNC_HEADER_RE.test(message)
      ? message.slice(split.index + split[0].length).replace(/^> ?/gm, '')
      : message;
  const separator = /\r?\n\s*\r?\n/.exec(unwrapped);
  const head = separator ? unwrapped.slice(0, separator.index) : unwrapped;
  let result = separator ? unwrapped.slice(separator.index + separator[0].length) : '';
  const fields = {};
  for (const match of head.matchAll(/^\[?([\w-]+):\s*([^\r\n]*?)\]?$/gm)) {
    fields[match[1].toLowerCase()] = match[2];
  }
  const id = clean(meta?.execution_id || fields.task_id);
  const surface = clean(meta?.execution_surface || fields.surface || (fields.exit ? 'shell' : 'tool'));
  const status = clean(meta?.status || fields.status);
  if (surface === 'shell') {
    const nested = parseTaskNotification(result);
    if (nested) return result;
    return renderShellCompletionEnvelope({
      jobId: id,
      status,
      exitCode: /^-?\d+$/.test(fields.exit || '') ? Number(fields.exit) : null,
      command: fields.command || fields.label,
      outputFile: fields.stdout || fields.logs?.replace('{stdout,stderr}', 'stdout'),
      result,
      error: fields.error,
    });
  }
  if (surface === 'agent') {
    result = result.replace(/^agent result[^\n]*(?:\n|$)/, '');
    const tagged = /<(?:final-answer|result)>\s*([\s\S]*?)\s*<\/(?:final-answer|result)>/.exec(result);
    if (tagged) result = tagged[1];
  }
  return renderTaskCompletionEnvelope({
    surface,
    id,
    tag: fields.tag || fields.label,
    status,
    result,
    error: fields.error,
  });
}

function tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id) {
  if (!ctx.callerSessionId || typeof enqueueFallback !== 'function') return false;
  try {
    const enq = enqueueFallback(ctx.callerSessionId, message, meta);
    return enq !== false && enq !== 0;
  } catch (err) {
    logNotifyFailure(logPrefix, id, err, 'fallback enqueue');
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

  const delivery = { ctx, message, meta, enqueueFallback, logPrefix, id, onSettled };
  if (typeof ctx.notifyFn === 'function') {
    try {
      const notifyResult = ctx.notifyFn(message, meta);
      if (notifyResult !== false) {
        if (notifyResult && typeof notifyResult.then === 'function') settleAsyncNotify(notifyResult, delivery);
        // A synchronous non-false result is confirmed delivered now; a promise
        // is reported delivered so the caller does not double-deliver.
        return true;
      }
    } catch (err) {
      logNotifyFailure(logPrefix, id, err);
    }
  }

  return tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id);
}

function logNotifyFailure(logPrefix, id, err, stage = 'notify') {
  try {
    process.stderr.write(
      `[${logPrefix}] async completion ${stage} failed: id=${id || 'unknown'} err=${err?.message || err}\n`
    );
  } catch {}
}

function settleAsyncNotify(notifyResult, { ctx, message, meta, enqueueFallback, logPrefix, id, onSettled }) {
  const report = (delivered) => {
    if (typeof onSettled === 'function') onSettled(delivered);
  };
  const rescue = () => report(tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id));
  Promise.resolve(notifyResult)
    .then((settled) => {
      if (settled === false || settled === 0) rescue();
      else report(true);
    })
    .catch((err) => {
      logNotifyFailure(logPrefix, id, err);
      rescue();
    });
}
