/**
 * cursor-wire-stream-bridge.mjs — the live Cursor bridge behind one SSE
 * response: frame parsing, tool-batch hand-off to the run registry, the
 * close verdict and the bounded in-place restart.
 */
import {
  MAX_CONNECT_FRAME_BYTES,
  isCursorAuthError,
  isCursorThrottleError,
  isRetryableCursorStreamError,
  withCursorFailureHint,
} from './cursor-wire-guards.mjs';
import { emitProviderRetryStage, markProviderRecoveryExhausted, retryAfterMsFromError } from './retry-classifier.mjs';
import { createFrameParser, cursorError, parseEndStream } from './cursor-wire-transport.mjs';
import { processServerMessage } from './cursor-wire-stream-messages.mjs';

// A parked HTTP/2 run can still receive parallel execs. Keep their raw chunks
// with the transport until the next SSE consumer attaches.
const parkedInputs = new WeakMap();

// Resolves after `ms`, or early when the stream is cancelled.
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * @param {object} ctx
 * @param {{ bridge, heartbeat }} ctx.live  the bridge currently feeding the stream (mutated on restart)
 * @param {object} ctx.run  { key, conversation, tools, cloudRule, modelParameters, maxMode, sessionId }
 * @param {{ get(key), store(key, active), forget(key, active) }} ctx.runs  the pending-batch registry
 */
export function createBridgeController(ctx) {
  const { live, state, filter, watchdog, sink, tuning, run, runs, restart, isCancelled } = ctx;
  const { sleep = abortableSleep, cancelSignal = null, onStageChange = null } = ctx;
  let retryCount = 0;
  let throttleCount = 0;
  let authCount = 0;

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
      ownerSessionId: run.ownerSessionId,
      pending: state.pending,
      executions: state.executions,
      sawTurnEnded: state.sawTurnEnded,
    });
    sink.finish('tool_calls');
  };

  // Exponential backoff with +-20% jitter for in-place retries.
  const backoffMs = (attempt) => {
    const ceiling = Math.min(tuning.retryMaxDelayMs, tuning.retryBaseDelayMs * 2 ** (attempt - 1));
    return Math.floor(ceiling * (0.8 + Math.random() * 0.4));
  };

  const recoverOrFail = (error) => {
    const retryable = isRetryableCursorStreamError(error);
    // A throttle retries within the bounded throttle retry count; otherwise
    // the error surfaces with retryAfterMs for the outer layer.
    const throttled = !retryable && isCursorThrottleError(error);
    // Rejected credentials get a forced token refresh before the retry.
    const authFailure = !retryable && !throttled && isCursorAuthError(error);
    // A throttle retry rotates the conversation and drops the checkpoint
    // so unlike other recoveries it can only replay a run that
    // has shown nothing; the rest may also continue from a checkpoint.
    const recoveryEligible =
      !isCancelled() &&
      typeof restart === 'function' &&
      (!state.visibleOutput || (!throttled && Boolean(run.conversation.checkpoint)));
    const serverDelay = retryAfterMsFromError(error);
    // Server advice is honored in full for every retryable kind; local
    // backoff applies only when the server gave none.
    const backoffAttempt = (throttled ? throttleCount : retryCount) + 1;
    const delayMs = Number.isFinite(serverDelay) ? serverDelay : backoffMs(backoffAttempt);
    const throttleOk = throttled && throttleCount < tuning.maxThrottleRetries;
    const authOk = authFailure && authCount < tuning.maxAuthRetries;
    const canRetry = retryCount < tuning.maxRetries && recoveryEligible && (retryable || throttleOk || authOk);
    if (!canRetry) {
      // A fresh Cursor run owns its bounded in-place retries. Mark
      // exhaustion so the outer loop does not multiply that budget.
      // Resumed tool-result streams have no restart closure; those
      // intentionally fall through unmarked so the outer loop can
      // rebuild from the committed assistant/tool-result history.
      // A throttle that spent its bounded retries is final for the turn too.
      if (
        recoveryEligible &&
        ((retryable && retryCount >= tuning.maxRetries) || (throttled && throttleCount >= tuning.maxThrottleRetries))
      ) {
        markProviderRecoveryExhausted(error, { owner: 'cursor-wire', attempts: retryCount + 1 });
      }
      sink.fail(withCursorFailureHint(error));
      return;
    }
    retryCount += 1;
    if (throttled) throttleCount += 1;
    if (authFailure) authCount += 1;
    state.sawEnd = false;
    state.batchBoundaryReady = false;
    state.batchBoundaryChunkSeq = -1;
    // The wait is intentional, not stream silence; attach() re-arms on restart.
    watchdog.pause();
    emitProviderRetryStage(onStageChange, {
      attempt: retryCount + 1,
      maxAttempts: tuning.maxRetries + 1,
      lastErr: error,
      delayMs,
    });
    let restartReason = 'transient';
    if (throttled) restartReason = 'throttle';
    else if (authFailure) restartReason = 'auth';
    void sleep(delayMs, cancelSignal).then(async () => {
      if (isCancelled() || state.closed) return;
      try {
        // restart() may refresh credentials first, so it can be async.
        const next = await restart({
          attempt: retryCount,
          fromCheckpoint: !throttled && Boolean(run.conversation.checkpoint),
          visibleOutput: state.visibleOutput,
          reason: restartReason,
          error,
        });
        if (isCancelled() || state.closed) {
          clearInterval(next.heartbeat);
          next.bridge.close();
          return;
        }
        attach(next.bridge, next.heartbeat);
        try {
          onStageChange?.('streaming');
        } catch {}
      } catch (restartError) {
        sink.fail(withCursorFailureHint(restartError));
      }
    });
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
    // Tool calls already emitted to the caller remain actionable even if
    // the parked transport vanished. The next request rebuilds/resumes.
    // Checked before turnEnded: a close that follows turnEnded only ends a
    // completed turn when no exec is still waiting (turn ended
    // with no MCP exec outstanding), never by dropping a tool call.
    if (state.pending.length > 0) {
      sink.finish('tool_calls');
      return;
    }
    // Cursor commonly closes HTTP/2 immediately after turnEnded, with or
    // without an end-stream error. The turn is already complete.
    if (state.sawTurnEnded) {
      sink.finish();
      return;
    }
    if (!closeError && !state.sawEnd) {
      closeError = cursorError('Cursor stream closed before its end frame', { code: 'incomplete_stream' });
    }
    if (closeError) recoverOrFail(closeError);
    else sink.finish();
  };

  const attach = (ownedBridge, nextHeartbeat) => {
    live.bridge = ownedBridge;
    live.heartbeat = nextHeartbeat;
    let inbox = parkedInputs.get(ownedBridge);
    if (!inbox) {
      inbox = { chunks: [], bytes: 0 };
      parkedInputs.set(ownedBridge, inbox);
    }
    const messageCtx = {
      state,
      filter,
      emit: sink.emit,
      conversation: run.conversation,
      tools: run.tools,
      cloudRule: run.cloudRule,
      sessionId: run.sessionId,
      ownerSessionId: run.ownerSessionId,
    };
    const frameParser = createFrameParser(
      // Server requests answer on whichever bridge is live when they arrive.
      (bytes) => watchdog.progress(processServerMessage(bytes, { ...messageCtx, bridge: live.bridge })),
      (bytes) => onEndStream(ownedBridge, bytes)
    );
    const receive = (chunk) => {
      if (live.bridge !== ownedBridge || isCancelled()) return;
      if (state.closed) {
        if (inbox.bytes + chunk.byteLength > MAX_CONNECT_FRAME_BYTES) {
          ownedBridge.close(
            cursorError('Cursor parked input exceeds the buffer limit', { code: 'stream_buffer_limit' })
          );
          return;
        }
        inbox.chunks.push(chunk);
        inbox.bytes += chunk.byteLength;
        return;
      }
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
    };
    ownedBridge.onData(receive);
    ownedBridge.onClose((error) => onBridgeClose(ownedBridge, nextHeartbeat, frameParser, error));
    watchdog.start();
    while (!state.closed && !isCancelled() && inbox.chunks.length) {
      const chunk = inbox.chunks.shift();
      inbox.bytes -= chunk.byteLength;
      receive(chunk);
    }
  };

  return { attach };
}
