/**
 * cursor-wire-stream-bridge.mjs — the live Cursor bridge behind one SSE
 * response: frame parsing, tool-batch hand-off to the run registry, the
 * close verdict and the bounded in-place restart.
 */
import { isRetryableCursorStreamError } from './cursor-wire-guards.mjs';
import { markProviderRecoveryExhausted } from './retry-classifier.mjs';
import { createFrameParser, cursorError, parseEndStream } from './cursor-wire-transport.mjs';
import { processServerMessage } from './cursor-wire-stream-messages.mjs';

/**
 * @param {object} ctx
 * @param {{ bridge, heartbeat }} ctx.live  the bridge currently feeding the stream (mutated on restart)
 * @param {object} ctx.run  { key, conversation, tools, cloudRule, modelParameters, maxMode, sessionId }
 * @param {{ get(key), store(key, active), forget(key, active) }} ctx.runs  the pending-batch registry
 */
export function createBridgeController(ctx) {
  const { live, state, filter, watchdog, sink, tuning, run, runs, restart, isCancelled } = ctx;
  let retryCount = 0;

  const finishToolBatch = () => {
    if (state.closed || state.pending.length === 0) return;
    runs.store(run.key, {
      bridge: live.bridge,
      heartbeat: live.heartbeat,
      conversation: run.conversation,
      tools: run.tools,
      cloudRule: run.cloudRule,
      modelParameters: run.modelParameters,
      maxMode: run.maxMode,
      sessionId: run.sessionId,
      pending: state.pending,
      sawTurnEnded: state.sawTurnEnded,
    });
    sink.finish('tool_calls');
  };

  const recoverOrFail = (error) => {
    const retryable = isRetryableCursorStreamError(error);
    const recoveryEligible =
      !isCancelled() && typeof restart === 'function' && (!state.visibleOutput || run.conversation.checkpoint);
    const canRetry = retryCount < tuning.maxRetries && recoveryEligible && retryable;
    if (!canRetry) {
      // A fresh Cursor run owns its bounded in-place retries. Mark
      // exhaustion so the outer loop does not multiply that budget.
      // Resumed tool-result streams have no restart closure; those
      // intentionally fall through unmarked so the outer loop can
      // rebuild from the committed assistant/tool-result history.
      if (retryable && recoveryEligible && retryCount >= tuning.maxRetries) {
        markProviderRecoveryExhausted(error, { owner: 'cursor-wire', attempts: retryCount + 1 });
      }
      sink.fail(error);
      return;
    }
    retryCount += 1;
    state.sawEnd = false;
    state.batchBoundaryReady = false;
    state.batchBoundaryChunkSeq = -1;
    try {
      const next = restart({
        attempt: retryCount,
        fromCheckpoint: Boolean(run.conversation.checkpoint),
        visibleOutput: state.visibleOutput,
      });
      attach(next.bridge, next.heartbeat);
    } catch (restartError) {
      sink.fail(restartError);
    }
  };

  /** The Connect end frame: an error closes, pending tools delimit, a finished turn completes. */
  const onEndStream = (ownedBridge, bytes) => {
    state.sawEnd = true;
    const error = parseEndStream(bytes);
    if (error) {
      ownedBridge.close(error);
    } else if (state.pending.length > 0) {
      // A clean end-stream is also a final tool batch delimiter.
      state.batchBoundaryReady = true;
    } else if (!state.sawTurnEnded) {
      ownedBridge.close(cursorError('Cursor stream ended before turnEnded', { code: 'incomplete_stream' }));
    } else {
      sink.finish();
      ownedBridge.close();
    }
  };

  const onBridgeClose = (ownedBridge, ownedHeartbeat, frameParser, error) => {
    clearInterval(ownedHeartbeat);
    const active = runs.get(run.key);
    if (active?.bridge === ownedBridge) runs.forget(run.key, active);
    if (isCancelled()) return;
    if (state.closed || live.bridge !== ownedBridge) return;
    let closeError = error;
    if (!closeError) {
      try {
        frameParser.finish();
      } catch (frameError) {
        closeError = frameError;
      }
    }
    // Cursor commonly closes HTTP/2 immediately after turnEnded without
    // a separate Connect end frame. The turn is already complete.
    if (state.sawTurnEnded) {
      sink.finish();
      return;
    }
    // Tool calls already emitted to the caller remain actionable even if
    // the parked transport vanished. The next request rebuilds/resumes.
    if (state.pending.length > 0) {
      sink.finish('tool_calls');
      return;
    }
    if (!closeError && !state.sawEnd) {
      closeError = cursorError('Cursor stream closed before its end frame', { code: 'protocol_error' });
    }
    if (closeError) recoverOrFail(closeError);
    else sink.finish();
  };

  const attach = (nextBridge, nextHeartbeat) => {
    live.bridge = nextBridge;
    live.heartbeat = nextHeartbeat;
    const ownedBridge = nextBridge;
    const messageCtx = {
      state,
      filter,
      emit: sink.emit,
      conversation: run.conversation,
      tools: run.tools,
      cloudRule: run.cloudRule,
    };
    const frameParser = createFrameParser(
      // Server requests answer on whichever bridge is live when they arrive.
      (bytes) => watchdog.progress(processServerMessage(bytes, { ...messageCtx, bridge: live.bridge })),
      (bytes) => onEndStream(ownedBridge, bytes)
    );
    ownedBridge.onData((chunk) => {
      if (live.bridge !== ownedBridge || state.closed) return;
      state.chunkSeq += 1;
      try {
        frameParser(chunk);
        if (state.pending.length > 0 && state.batchBoundaryChunkSeq === state.chunkSeq) {
          state.batchBoundaryReady = true;
        }
        // Never hand a partial Connect frame to the next response parser.
        if (state.batchBoundaryReady && frameParser.bufferedBytes() === 0) finishToolBatch();
      } catch (error) {
        ownedBridge.close(error);
      }
    });
    ownedBridge.onClose((error) => onBridgeClose(ownedBridge, nextHeartbeat, frameParser, error));
    watchdog.start();
  };

  return { attach };
}
