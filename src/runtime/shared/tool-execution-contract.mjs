export const TOOL_SYNC_EXECUTION_CONTRACT =
  'Runs synchronously in this tool call.';

export const TOOL_ASYNC_EXECUTION_CONTRACT =
  'Async returns task_id; completion notification follows. status/read/wait are manual recovery or blocking only.';

export const TOOL_MANUAL_CONTROL_CONTRACT =
  'Manual wait/read/status/cancel only for explicit blocking or recovery.';

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
        // Optimistically report delivered (keeps this fn synchronous). But a
        // notifyFn that returns a Promise can still reject — or resolve to an
        // explicit false/0 (declined/failed) — *after* we returned. In that
        // case rescue the completion via enqueueFallback so the owner isn't
        // left without a notification. The normal success path (truthy
        // resolve) never enqueues, preserving exact-once delivery.
        Promise.resolve(notifyResult).then((settled) => {
          if (settled === false || settled === 0) {
            tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id);
          }
        }).catch((err) => {
          try {
            process.stderr.write(`[${logPrefix}] async completion notify failed: id=${id || 'unknown'} err=${err?.message || err}\n`);
          } catch {}
          tryEnqueueFallback(ctx, message, meta, enqueueFallback, logPrefix, id);
        });
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
