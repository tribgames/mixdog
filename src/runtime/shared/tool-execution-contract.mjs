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
    ...(ctx.routingSessionId && ctx.routingSessionId !== ctx.callerSessionId ? { routing_session_id: ctx.routingSessionId } : {}),
    ...(ctx.clientHostPid ? { client_host_pid: String(ctx.clientHostPid) } : {}),
  };
}

export function modelVisibleToolCompletionMessage(text, meta = {}) {
  const message = String(text || '').trim();
  if (!message) return '';
  const instruction = clean(meta?.instruction);
  const type = clean(meta?.type || meta?.execution_surface || 'tool_completion');
  const id = clean(meta?.execution_id);
  const status = clean(meta?.status);
  const header = `Async ${type}${id ? ` ${id}` : ''}${status ? ` ${status}` : ''} finished.`;
  const quoted = message.split(/\r?\n/).map((line) => `> ${line}`).join('\n');
  return [
    instruction || header,
    '',
    'Result:',
    quoted,
  ].join('\n');
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
    try {
      const notifyResult = ctx.notifyFn(message, meta);
      if (notifyResult === false) return false;
      Promise.resolve(notifyResult).catch((err) => {
        try {
          process.stderr.write(`[${logPrefix}] async completion notify failed: id=${id || 'unknown'} err=${err?.message || err}\n`);
        } catch {}
      });
      return true;
    } catch (err) {
      try {
        process.stderr.write(`[${logPrefix}] async completion notify failed: id=${id || 'unknown'} err=${err?.message || err}\n`);
      } catch {}
    }
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
