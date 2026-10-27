import { randomBytes } from 'node:crypto';
import { PROVIDER_FIRST_BYTE_TIMEOUT_MS, providerTimeoutError, streamStalledError } from '../stall-policy.mjs';
import { typedStatusFrom } from './retry-classifier.mjs';
import { applyCompatErrorContract } from './openai-compat-error-contract.mjs';
import { truncatedCompatStreamError } from './lib/openai-tool-args.mjs';

// Shared lifecycle and replay boundaries for both OpenAI-compatible protocols.

/**
 * The SDK surfaces an in-band `{"error": …}` stream chunk as an APIError that
 * carries the provider's error payload but NO HTTP status. Attach the same
 * wire-error contract the Responses event handlers use so classifyError()
 * default-retries it under the bounded budgets (fatal typed codes stay
 * terminal) instead of failing the turn as 'unknown'. Nothing is synthesized
 * from message text; a typed status on the payload still outranks the marker.
 */
function markInBandWireError(err) {
  const detail = err?.error;
  if (!err || !detail || typeof detail !== 'object' || err.providerWireError === true) return err;
  try {
    err.providerWireError = true;
    err.providerError = detail;
    const typed = typedStatusFrom(err, detail);
    if (typed && !err.httpStatus) err.httpStatus = typed;
    const code = detail.code ?? detail.type ?? null;
    if (code != null && code !== '' && !err.providerErrorCode) err.providerErrorCode = String(code);
    applyCompatErrorContract(err, detail);
  } catch {}
  return err;
}

/**
 * A frame the SDK failed to JSON-decode. Raised only at the wire-decoding
 * boundary (the iterator's own next()); consumers stamp the exposure evidence
 * (partial output, replay safety) on it in their failure path.
 */
export function malformedCompatStreamError(label, cause) {
  const err = new Error(`${label || 'compat SSE'} malformed stream frame: ${cause?.message || 'invalid JSON'}`, {
    cause,
  });
  err.name = 'MalformedStreamError';
  err.code = 'malformed_stream';
  err.malformedStream = true;
  return err;
}

/**
 * A chat `finish_reason: network_error` is an interruption the gateway reports
 * in-band, never a completion. Typed as a truncated stream so the shared
 * classifier treats it as transient; exposure gates decide replay.
 */
export function networkInterruptedCompatStreamError(label) {
  const err = truncatedCompatStreamError(label, 'finish_reason=network_error');
  err.name = 'StreamInterruptedError';
  err.streamInterrupted = true;
  err.finishReason = 'network_error';
  return err;
}

export function isNetworkErrorFinishReason(finishReason) {
  return typeof finishReason === 'string' && finishReason.trim().toLowerCase() === 'network_error';
}

/**
 * A chat `finish_reason: error` means the upstream failed the generation
 * (gateways surface it as a 502 upstream_error). Typed like the network interruption, with the gateway status.
 */
export function upstreamErrorCompatStreamError(label) {
  const err = truncatedCompatStreamError(label, 'finish_reason=error');
  err.name = 'StreamInterruptedError';
  err.streamInterrupted = true;
  err.finishReason = 'error';
  err.status = 502;
  err.code = 'upstream_error';
  return err;
}

export function isErrorFinishReason(finishReason) {
  return typeof finishReason === 'string' && finishReason.trim().toLowerCase() === 'error';
}

/** The typed interruption for a failing chat finish_reason, or null for any other value. */
export function failingFinishReasonError(finishReason, label) {
  if (isNetworkErrorFinishReason(finishReason)) return networkInterruptedCompatStreamError(label);
  if (isErrorFinishReason(finishReason)) return upstreamErrorCompatStreamError(label);
  return null;
}

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
  { signal, idleMs, idleDeadlineAt, idleEnabled, idleLabel, streamLabel, emittedToolCall } = {}
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
    return await new Promise((resolve, reject) => {
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
      // The SDK JSON-decodes each frame inside next(): a SyntaxError here is a
      // malformed wire frame, typed at this boundary and nowhere else.
      iterator
        .next()
        .then(resolve, (error) =>
          reject(error instanceof SyntaxError ? malformedCompatStreamError(streamLabel || idleLabel, error) : error)
        );
    });
  } catch (err) {
    if (idleTimedOut)
      throw streamStalledError(idleLabel || 'compat SSE', idleMs, { emittedToolCall: didEmitToolCall() });
    throw markInBandWireError(err);
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
