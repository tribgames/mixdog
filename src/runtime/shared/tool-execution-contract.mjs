export const TOOL_SYNC_EXECUTION_CONTRACT =
  'Runs synchronously and returns the bounded result in this tool call.';

export const TOOL_ASYNC_EXECUTION_CONTRACT =
  'Async execution returns immediately; completion is delivered as an owner-session notification. Status/read/wait tools are for manual recovery or explicit blocking control only.';

export const TOOL_MANUAL_CONTROL_CONTRACT =
  'Use manual wait/peek/read/status only when you need explicit blocking, recovery, inspection, or cancellation.';

function clean(value) {
  return String(value ?? '').trim();
}

function positivePid(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function normalizeToolNotifyContext(context = {}) {
  const callerSessionId = clean(context.callerSessionId || context.routingSessionId || context.sessionId);
  const clientHostPid = positivePid(context.clientHostPid);
  return {
    notifyFn: typeof context.notifyFn === 'function' ? context.notifyFn : null,
    callerSessionId: callerSessionId || null,
    routingSessionId: callerSessionId || null,
    clientHostPid,
  };
}

export function toolCompletionInstruction({ surface = 'tool', id, status, detail } = {}) {
  const label = surface === 'shell'
    ? 'shell task'
    : surface === 'bridge'
      ? 'bridge agent'
      : `${surface} execution`;
  const statusText = status ? ` (${status}${detail ? `, ${detail}` : ''})` : '';
  return `The async ${label} ${id || ''} has finished${statusText} - review this result in your next step.`;
}

export function toolCompletionMeta({
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
    ...(ctx.clientHostPid ? { client_host_pid: String(ctx.clientHostPid) } : {}),
  };
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

  if (typeof ctx.notifyFn === 'function') {
    Promise.resolve(ctx.notifyFn(message, meta)).catch((err) => {
      try {
        process.stderr.write(`[${logPrefix}] async completion notify failed: id=${id || 'unknown'} err=${err?.message || err}\n`);
      } catch {}
    });
    return true;
  }

  if (ctx.callerSessionId && typeof enqueueFallback === 'function') {
    try {
      enqueueFallback(ctx.callerSessionId, message, meta);
      return true;
    } catch (err) {
      try {
        process.stderr.write(`[${logPrefix}] async completion fallback enqueue failed: id=${id || 'unknown'} err=${err?.message || err}\n`);
      } catch {}
    }
  }

  return false;
}
