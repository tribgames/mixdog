/**
 * openai-ws-watchdogs.mjs — the four timers that bound one Responses WS
 * stream, and what each one proves when it fires:
 *
 *   pre-stream      — no server event at all after response.create (a wedged
 *                     post-upgrade socket); cleared by ANY frame.
 *   first-meaningful — no response.created / content / tool-arg delta, even
 *                     while keepalive frames keep arriving; cleared once.
 *   inter-chunk     — byte silence mid-stream; reset by EVERY frame.
 *   semantic idle   — deltas then silence (keepalives only); reset only by
 *                     meaningful output and item lifecycle.
 *
 * Every expiry hands a tagged error to `fail`, which owns terminalError, the
 * socket close and the settle; the timers never touch the Promise.
 */
import { appendAgentTrace } from '../agent-trace.mjs';
import { streamStalledError } from '../stall-policy.mjs';

/**
 * @param {object} deps
 * @param {object} deps.midState
 * @param {string} deps.traceProvider
 * @param {number} deps.streamingStart
 * @param {() => string} deps.currentModel
 * @param {{ preResponseCreatedMs: number, firstMeaningfulMs: number, interChunkMs: number, semanticIdleMs: number, semanticIdleEnabled: boolean }} deps.timeouts
 * @param {(err: Error) => Error} deps.attachPartialState
 * @param {(err: Error, closeReason: string) => void} deps.fail
 */
export function createWsStreamWatchdogs({
  midState,
  traceProvider,
  streamingStart,
  currentModel,
  timeouts,
  attachPartialState,
  fail,
}) {
  const { preResponseCreatedMs, firstMeaningfulMs, interChunkMs, semanticIdleMs, semanticIdleEnabled } = timeouts;
  const firstMeaningfulEnabled = firstMeaningfulMs > 0;
  let idleTimer = null;
  let interChunkTimer = null;
  let semanticIdleTimer = null;
  let firstMeaningfulTimer = null;
  let firstMeaningfulSeen = false;
  const traceWsTimeout = (event, timeoutMs) => {
    try {
      const iteration = Number(midState.iteration);
      const attemptIndex = Number(midState.attemptIndex);
      const payload = {
        provider: midState.traceProvider || traceProvider,
        transport: 'websocket',
        event,
        timeout_ms: timeoutMs,
        elapsed_ms: Date.now() - streamingStart,
        model: midState.model || currentModel() || null,
        attempt_index: Number.isFinite(attemptIndex) ? attemptIndex : null,
        warmup: midState.warmup === true,
        saw_response_created: midState.sawResponseCreated === true,
      };
      appendAgentTrace({
        sessionId: midState.sessionId || null,
        iteration: Number.isFinite(iteration) ? iteration : null,
        kind: 'ws_timeout',
        ...payload,
        payload,
      });
    } catch {}
  };
  const debugTimeout = (kind, afterMs) => {
    if (process.env.MIXDOG_DEBUG_AGENT) {
      process.stderr.write(`[agent-trace] ws-timeout kind=${kind} afterMs=${afterMs}\n`);
    }
  };
  const clearPreStream = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const resetInterChunk = () => {
    if (interChunkTimer) clearTimeout(interChunkTimer);
    interChunkTimer = setTimeout(() => {
      debugTimeout('inter-chunk', interChunkMs);
      traceWsTimeout('inter_chunk_timeout', interChunkMs);
      const err = new Error(`WS stream: inter-chunk inactivity for ${interChunkMs}ms`);
      // No terminal frame arrived, so this is a CONTINUATION, never a
      // synthesized completion. Attach the streamed partial state so
      // the loop's partial/tool recovery can finalize it explicitly.
      err.streamStalled = true;
      attachPartialState(err);
      fail(err, 'inter_chunk_timeout');
    }, interChunkMs);
  };
  const resetSemanticIdle = () => {
    if (!semanticIdleEnabled) return;
    if (semanticIdleTimer) clearTimeout(semanticIdleTimer);
    semanticIdleTimer = setTimeout(() => {
      traceWsTimeout('semantic_idle_timeout', semanticIdleMs);
      const err = streamStalledError('Responses WS', semanticIdleMs, {
        emittedToolCall: !!midState?.emittedToolCall,
      });
      // Partial-final recovery: attach streamed partial state so a wedged
      // FINAL no-tool summary can be accepted as partial-final success by
      // the loop. pendingToolUse gates out mid-flight tools.
      attachPartialState(err);
      try {
        err.wsCloseCode = 4000;
      } catch {}
      fail(err, 'semantic_idle_timeout');
    }, semanticIdleMs);
    try {
      semanticIdleTimer.unref?.();
    } catch {}
  };
  const clearFirstMeaningful = () => {
    if (firstMeaningfulSeen) return;
    firstMeaningfulSeen = true;
    if (firstMeaningfulTimer) {
      clearTimeout(firstMeaningfulTimer);
      firstMeaningfulTimer = null;
    }
  };
  return {
    /** Fires if the server never sends a first event within
     *  preResponseCreatedMs of our last frame. Healthy servers ack within
     *  seconds, so the window is short (~10s). */
    armPreStream() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        debugTimeout('first-byte', preResponseCreatedMs);
        traceWsTimeout('first_byte_timeout', preResponseCreatedMs);
        const err = new Error(`WS stream: no first server event within ${preResponseCreatedMs}ms`);
        // Tag the close code so _classifyMidstreamError sees a 4000 (our
        // local pre-stream watchdog code) and routes through the
        // post-upgrade-no-first-event retryable bucket.
        err.wsCloseCode = 4000;
        // Tag the error object itself (not just midState): the warmup path
        // streams under a separate warmupState and rethrows on timeout
        // BEFORE it can copy flags to the outer midState, so the outer
        // catch's _classifyMidstreamError would otherwise see
        // sawResponseCreated=false + close 4000 and hit the pre-created
        // deny gate. err.firstByteTimeout makes both paths retryable.
        err.firstByteTimeout = true;
        midState.firstByteTimeout = true;
        fail(err, 'first_byte_timeout');
      }, preResponseCreatedMs);
    },
    /** Fires if no meaningful response event arrives within
     *  firstMeaningfulMs, even while keepalive/metadata frames keep the
     *  inter-chunk timer fresh. Expiry is a named stall so the existing
     *  mid-stream retry/fallback path handles it (before the agent's
     *  first-byte abort). */
    armFirstMeaningful() {
      if (!firstMeaningfulEnabled) return;
      if (firstMeaningfulTimer) clearTimeout(firstMeaningfulTimer);
      firstMeaningfulTimer = setTimeout(() => {
        debugTimeout('first-meaningful', firstMeaningfulMs);
        traceWsTimeout('first_meaningful_timeout', firstMeaningfulMs);
        const err = streamStalledError('Responses WS', firstMeaningfulMs, {
          emittedToolCall: !!midState?.emittedToolCall,
        });
        try {
          err.wsCloseCode = 4000;
        } catch {}
        fail(err, 'first_meaningful_timeout');
      }, firstMeaningfulMs);
      try {
        firstMeaningfulTimer.unref?.();
      } catch {}
    },
    /** Called on EVERY parsed server event: any frame proves the socket is
     *  live. Also clears the pre-stream watchdog in case the first event is
     *  not response.created. */
    resetIdle() {
      clearPreStream();
      resetInterChunk();
    },
    /** Meaningful-output progress: text/reasoning/tool-arg deltas. The
     *  first one also satisfies the first-meaningful watchdog. */
    bumpSemantic() {
      clearFirstMeaningful();
      resetSemanticIdle();
    },
    /** Item lifecycle progress (added/done) without a delta. */
    resetSemantic: resetSemanticIdle,
    /** response.created is meaningful on its own. */
    clearFirstMeaningful,
    clearAll() {
      if (idleTimer) clearTimeout(idleTimer);
      if (interChunkTimer) {
        clearTimeout(interChunkTimer);
        interChunkTimer = null;
      }
      if (semanticIdleTimer) {
        clearTimeout(semanticIdleTimer);
        semanticIdleTimer = null;
      }
      if (firstMeaningfulTimer) {
        clearTimeout(firstMeaningfulTimer);
        firstMeaningfulTimer = null;
      }
    },
  };
}
