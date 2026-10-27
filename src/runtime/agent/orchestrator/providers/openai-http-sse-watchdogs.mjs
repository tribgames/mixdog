/**
 * openai-http-sse-watchdogs.mjs — liveness gates of one HTTP/SSE fallback
 * stream: the total/external abort relay, the fixed first-server-event
 * deadline, the first-OUTPUT window, the SEMANTIC idle watchdog, and the
 * cancellable reader.read().
 *
 * Until the model's first semantic output (reasoning, text, a tool call) only
 * the first-server-event deadline and the first-output window run: server
 * metadata (response.created / in_progress, an empty reasoning or message
 * item) and keepalives neither end that phase nor start the semantic-idle
 * clock, so a model may think silently longer than the idle window. From the
 * first semantic output on, the semantic idle owns the stream.
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
  providerFirstOutputTimeoutMs,
  streamStalledError,
} from '../stall-policy.mjs';
import { streamFirstOutputWindow } from './lib/first-output-window.mjs';

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
 * @param {string|null} [deps.sessionId]  the session whose logical request this stream serves
 * @param {boolean} [deps.reportsProgress]  the stream reports its progress into that session
 */
export function createHttpSseWatchdogs({
  opts,
  reader,
  totalTimeout,
  stallPartial,
  label: LABEL,
  sessionId = null,
  reportsProgress = false,
}) {
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

  // SEMANTIC idle watchdog: reset ONLY on meaningful() (text/reasoning/tool
  // deltas), never on raw bytes/keepalive frames, so a stream that emits some
  // deltas then goes silent trips a short, named terminal failure instead of
  // hanging until the 30-min agent watchdog. Disablable via the shared env.
  let semanticIdleTimer = null;
  const semanticIdleOverrideMs = positiveOverride(opts?._semanticIdleTimeoutMs);
  const semanticIdleMs = semanticIdleOverrideMs || PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS;
  const semanticIdleEnabled = semanticIdleOverrideMs > 0 || PROVIDER_SSE_IDLE_WATCHDOG_ENABLED;
  // FIRST-OUTPUT window of the logical request this stream serves, armed when
  // the stream opens for what is left of it and retired by the first semantic
  // output. Metadata-only streams (repeated response.in_progress,
  // keepalive/ping frames, unknown event types) cannot refresh it, so a wedge
  // that never produces a token still ends here — and a retry or route
  // fallback inherits the request's deadline instead of a fresh one.
  const firstOutputOverrideMs = positiveOverride(opts?._firstOutputTimeoutMs);
  const firstOutput = streamFirstOutputWindow({
    sessionId,
    reportsProgress,
    timeoutMs: firstOutputOverrideMs || providerFirstOutputTimeoutMs(semanticIdleMs),
  });
  const firstOutputMs = firstOutput.timeoutMs;
  const firstOutputEnabled = firstOutputOverrideMs > 0 || semanticIdleEnabled;
  let firstOutputTimer = null;
  // A request that already produced output runs under the semantic idle.
  let semanticSeen = firstOutput.outputSeen;

  // A stalled stream fails with the named stall error, carrying the streamed
  // partial state so the agent loop can accept a wedged FINAL no-tool summary
  // as a successful partial-final instead of dropping the result.
  // pendingToolUse gates out any mid-flight tool call.
  const abortStalled = (timeoutMs) => {
    const partial = stallPartial();
    const err = streamStalledError(LABEL, timeoutMs, { emittedToolCall: partial.emittedToolCall });
    try {
      err.partialContent = partial.content;
      err.partialToolCalls = partial.toolCalls;
      err.pendingToolUse = partial.pendingToolUse;
      err.partialModel = partial.model;
    } catch {
      /* best-effort enrichment */
    }
    abortStream(err);
  };

  // Initial wait for any server event is governed by the fixed
  // first-server-event policy; a lower semantic-idle override cannot shorten it.
  let firstServerEventTimer = null;
  const firstServerEventMs = positiveOverride(opts?._firstServerEventTimeoutMs) || PROVIDER_FIRST_BYTE_TIMEOUT_MS;
  const clearFirstServerEvent = () => {
    if (firstServerEventTimer) {
      clearTimeout(firstServerEventTimer);
      firstServerEventTimer = null;
    }
  };
  const clearFirstOutput = () => {
    if (firstOutputTimer) {
      clearTimeout(firstOutputTimer);
      firstOutputTimer = null;
    }
  };
  const armFirstServerEvent = () => {
    if (firstServerEventMs > 0) {
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
    }
    if (semanticSeen) {
      armSemanticIdle();
    } else if (firstOutputEnabled && firstOutputMs > 0) {
      clearFirstOutput();
      const remainingMs = Math.max(0, firstOutput.deadlineAt - Date.now());
      firstOutputTimer = setTimeout(() => abortStalled(firstOutputMs), remainingMs);
      try {
        firstOutputTimer.unref?.();
      } catch {}
    }
  };

  const clearSemanticIdle = () => {
    if (semanticIdleTimer) {
      clearTimeout(semanticIdleTimer);
      semanticIdleTimer = null;
    }
  };
  const armSemanticIdle = () => {
    if (!semanticIdleEnabled || !(semanticIdleMs > 0)) return;
    clearSemanticIdle();
    semanticIdleTimer = setTimeout(() => abortStalled(semanticIdleMs), semanticIdleMs);
    try {
      semanticIdleTimer.unref?.();
    } catch {}
  };
  // Any parsed server event satisfies the first-server-event deadline only.
  const noteServerEvent = () => {
    clearFirstServerEvent();
  };
  // Semantic output: the first one ends the first-output phase; every one
  // re-arms the semantic idle.
  const noteMeaningful = () => {
    semanticSeen = true;
    clearFirstOutput();
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
    clearFirstOutput();
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
    semanticSeen: () => semanticSeen,
    read,
    dispose,
  };
}
