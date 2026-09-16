import { randomBytes } from 'node:crypto';
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, providerTimeoutError, streamStalledError } from '../stall-policy.mjs';

// Shared lifecycle and replay boundaries for both OpenAI-compatible protocols.
export function synthLeakedOpenAICall(recovered) {
  let args = recovered?.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) args = {};
  return {
    id: `call_leaked_${randomBytes(8).toString('hex')}`,
    name: recovered.name,
    arguments: args,
  };
}

export function firstByteCompatStreamError(label) {
  const err = providerTimeoutError(`${label} first byte`, PROVIDER_FIRST_BYTE_TIMEOUT_MS);
  err.firstByteTimeout = true;
  return err;
}

export function closeCompatStream(stream, iterator) {
  // return() queues behind a pending next(); abort its SDK-owned request first.
  try {
    stream.controller?.abort();
  } catch {
    /* retain the stream failure */
  }
  try {
    const closing = iterator.return?.();
    if (closing && typeof closing.catch === 'function') closing.catch(() => {});
  } catch {
    /* cleanup cannot replace cancellation or a provider error */
  }
}

export async function nextAsyncWithWatchdog(
  iterator,
  { signal, idleMs, idleDeadlineAt, idleEnabled, idleLabel, emittedToolCall } = {}
) {
  let idleTimer = null;
  let idleReject = null;
  let idleTimedOut = false;
  let onAbort = null;
  // A stall after dispatched tools must never replay their side effects.
  const didEmitToolCall = () => {
    try {
      return typeof emittedToolCall === 'function' ? !!emittedToolCall() : !!emittedToolCall;
    } catch {
      return false;
    }
  };
  const armIdle = () => {
    if (!idleEnabled || !(idleMs > 0)) return;
    if (idleTimer) clearTimeout(idleTimer);
    const deadline = Number(idleDeadlineAt);
    const delayMs = Number.isFinite(deadline) && deadline > 0 ? Math.max(0, deadline - Date.now()) : idleMs;
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      // SDK-filtered keepalives do not count as semantic progress.
      const e = streamStalledError(idleLabel || 'compat SSE', idleMs, { emittedToolCall: didEmitToolCall() });
      if (idleReject) {
        const r = idleReject;
        idleReject = null;
        r(e);
      }
    }, delayMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };
  armIdle();
  try {
    const result = await new Promise((resolve, reject) => {
      idleReject = reject;
      if (signal?.aborted) {
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : new Error('compat stream aborted'));
        return;
      }
      if (signal) {
        onAbort = () => {
          const reason = signal.reason;
          reject(reason instanceof Error ? reason : new Error('compat stream aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      iterator.next().then(resolve, reject);
    });
    return result;
  } catch (err) {
    if (idleTimedOut)
      throw streamStalledError(idleLabel || 'compat SSE', idleMs, { emittedToolCall: didEmitToolCall() });
    throw err;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    idleReject = null;
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function emitCompatToolCallOnce(state, call, onToolCall) {
  if (typeof onToolCall !== 'function' || !call?.id || !call?.name) return false;
  const key = `id:${call.id}`;
  if (!state.emittedToolCallKeys) state.emittedToolCallKeys = new Set();
  if (state.emittedToolCallKeys.has(key)) return false;
  // Cross-path dedupe prevents one native and one recovered call from
  // dispatching identical name/arguments twice.
  if (state._toolDedupe && !state._toolDedupe.shouldDispatch(call.name, call.arguments, call.id)) {
    state.emittedToolCallKeys.add(key);
    return false;
  }
  state.emittedToolCallKeys.add(key);
  state.emittedToolCall = true;
  const { _pendingItemId, ...cleanCall } = call;
  try {
    onToolCall(cleanCall);
  } catch {}
  return true;
}

export function markUnsafeRetryIfToolEmitted(err, state) {
  if (!err) return err;
  if (state?.emittedToolCall) {
    try {
      err.emittedToolCall = true;
      err.unsafeToRetry = true;
    } catch {}
  }
  if (state?.emittedText) markErrorLiveTextEmitted(err);
  return err;
}

export function markErrorLiveTextEmitted(err) {
  if (!err) return err;
  try {
    err.liveTextEmitted = true;
    err.unsafeToRetry = true;
  } catch {}
  return err;
}
