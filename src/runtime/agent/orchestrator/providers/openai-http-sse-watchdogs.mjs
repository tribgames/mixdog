/**
 * openai-http-sse-watchdogs.mjs — liveness gates of one HTTP/SSE fallback
 * stream: the total/external abort relay, the fixed first-server-event
 * deadline, the SEMANTIC idle watchdog, and the cancellable reader.read().
 *
 * After headerTimeout.cleanup() the in-flight fetch no longer carries a live
 * signal, so a totalTimeout / external abort that fires during a pending
 * reader.read() would otherwise leave the pooled request hanging. Keep the
 * reader tied to totalTimeout for the whole stream: on abort, cancel the
 * reader so the awaited read() unblocks and the socket is released back to
 * the shared pool instead of leaking. reader.cancel() may resolve the pending
 * read() as {done:true} rather than rejecting, which would let a partial
 * response surface as success — so the abort reason is recorded and the
 * stream loop re-throws it once the loop unblocks.
 */
import {
  PROVIDER_FIRST_BYTE_TIMEOUT_MS,
  PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
  PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
  streamStalledError,
} from '../stall-policy.mjs';

const LABEL = 'OpenAI OAuth HTTP fallback';

function positiveOverride(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * @param {object} deps
 * @param {object} [deps.opts]  send options carrying the test overrides
 * @param {ReadableStreamDefaultReader} deps.reader
 * @param {{ signal?: AbortSignal, cleanup(): void }} deps.totalTimeout
 * @param {() => object} deps.stallPartial  streamed partial state attached to a semantic-idle stall
 */
export function createHttpSseWatchdogs({ opts, reader, totalTimeout, stallPartial }) {
  let abortReason = null;
  let pendingReadReject = null;
  const rejectPendingRead = (err) => {
    if (!pendingReadReject) return;
    const reject = pendingReadReject;
    pendingReadReject = null;
    reject(err);
  };
  const abortStream = (err) => {
    abortReason = err;
    try {
      reader.cancel(err).catch(() => {});
    } catch {}
    rejectPendingRead(err);
  };
  let onTotalAbort = null;
  if (totalTimeout.signal) {
    onTotalAbort = () => {
      const reason = totalTimeout.signal.reason;
      abortStream(reason instanceof Error ? reason : new Error(`${LABEL} aborted`));
    };
    if (totalTimeout.signal.aborted) onTotalAbort();
    else totalTimeout.signal.addEventListener('abort', onTotalAbort, { once: true });
  }

  // Initial wait is governed only by the fixed first-server-event policy.
  // Semantic idle begins after a parsed server event, so a lower
  // semantic-idle override cannot shorten this first-event wait.
  let firstServerEventTimer = null;
  const firstServerEventMs = positiveOverride(opts?._firstServerEventTimeoutMs) || PROVIDER_FIRST_BYTE_TIMEOUT_MS;
  const clearFirstServerEvent = () => {
    if (firstServerEventTimer) {
      clearTimeout(firstServerEventTimer);
      firstServerEventTimer = null;
    }
  };
  const armFirstServerEvent = () => {
    if (!(firstServerEventMs > 0)) return;
    clearFirstServerEvent();
    firstServerEventTimer = setTimeout(() => {
      const err = new Error(`${LABEL} first server event timed out after ${firstServerEventMs}ms`);
      err.code = 'EPROVIDERTIMEOUT';
      err.firstByteTimeout = true;
      abortStream(err);
    }, firstServerEventMs);
    try {
      firstServerEventTimer.unref?.();
    } catch {}
  };

  // SEMANTIC idle watchdog: reset ONLY on meaningful() (text/reasoning/tool
  // deltas), never on raw bytes/keepalive frames, so a stream that emits some
  // deltas then goes silent trips a short, named terminal failure instead of
  // hanging until the 30-min agent watchdog. Disablable via the shared env.
  let semanticIdleTimer = null;
  const semanticIdleOverrideMs = positiveOverride(opts?._semanticIdleTimeoutMs);
  const semanticIdleMs = semanticIdleOverrideMs || PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
  const semanticIdleEnabled = semanticIdleOverrideMs > 0 || PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
  const clearSemanticIdle = () => {
    if (semanticIdleTimer) {
      clearTimeout(semanticIdleTimer);
      semanticIdleTimer = null;
    }
  };
  const armSemanticIdle = () => {
    if (!semanticIdleEnabled || !(semanticIdleMs > 0)) return;
    clearSemanticIdle();
    semanticIdleTimer = setTimeout(() => {
      const partial = stallPartial();
      const err = streamStalledError(LABEL, semanticIdleMs, { emittedToolCall: partial.emittedToolCall });
      // Partial-final recovery: attach the streamed partial state so the
      // agent loop can accept a wedged FINAL no-tool summary as a successful
      // partial-final instead of dropping the result. pendingToolUse gates
      // out any mid-flight tool call.
      try {
        err.partialContent = partial.content;
        err.partialToolCalls = partial.toolCalls;
        err.pendingToolUse = partial.pendingToolUse;
        err.partialModel = partial.model;
      } catch {
        /* best-effort enrichment */
      }
      abortStream(err);
    }, semanticIdleMs);
    try {
      semanticIdleTimer.unref?.();
    } catch {}
  };
  // One-shot latch for the first-server-event → semantic-idle handover. Once
  // the FIRST real SSE server event arrives, the fixed initial deadline is
  // satisfied and semantic-idle ownership begins. Arming on every parsed event
  // let a metadata-only stream (repeated response.in_progress, keepalive/ping
  // frames, unknown event types) refresh the watchdog forever without
  // producing a single token. Only meaningful progress re-arms it from then on.
  let semanticIdleArmed = false;
  const noteServerEvent = () => {
    clearFirstServerEvent();
    if (!semanticIdleArmed) {
      semanticIdleArmed = true;
      armSemanticIdle();
    }
  };
  const noteMeaningful = () => {
    semanticIdleArmed = true;
    armSemanticIdle();
  };

  const read = async () => {
    const result = await new Promise((resolve, reject) => {
      pendingReadReject = reject;
      reader.read().then(resolve, reject);
    });
    pendingReadReject = null;
    return result;
  };
  const dispose = () => {
    pendingReadReject = null;
    clearFirstServerEvent();
    clearSemanticIdle();
    try {
      reader.releaseLock?.();
    } catch {}
    if (onTotalAbort && totalTimeout.signal) {
      try {
        totalTimeout.signal.removeEventListener('abort', onTotalAbort);
      } catch {}
    }
    totalTimeout.cleanup();
  };
  return {
    abortReason: () => abortReason,
    armFirstServerEvent,
    clearSemanticIdle,
    noteServerEvent,
    noteMeaningful,
    read,
    dispose,
  };
}
