// Per-send callback instrumentation for sendWithRecovery: bench-only turn
// timing, the loop-side exposure witness and the retry-visibility relay. The
// wrappers are installed on the caller's opts in place for ONE send, and the
// returned restore unwinds only our own wrappers.
import { isVisibleStreamProgress } from '../../../shared/stream-progress.mjs';
import { MODEL_THINKING_STAGE } from '../../../shared/quiet-progress.mjs';

// Bench-only turn timing (MIXDOG_TURN_TIMING=1): one stderr line per
// provider request — TTFT (first visible model progress) and total stream
// time. Transport/header and response-created acknowledgements do not count.
// Inert unless the env flag is set; used to profile harness vs model
// latency in Terminal-Bench runs.
function beginTurnTiming(opts, model) {
  const turnT0 = process.env.MIXDOG_TURN_TIMING === '1' ? Date.now() : 0;
  if (!turnT0) return { timedOpts: opts, log() {} };
  let turnFirstDelta = 0;
  const prevDelta = typeof opts?.onStreamDelta === 'function' ? opts.onStreamDelta : null;
  const timedOpts = {
    ...(opts || {}),
    onStreamDelta: (kind) => {
      if (!turnFirstDelta && isVisibleStreamProgress(kind)) turnFirstDelta = Date.now();
      if (prevDelta) prevDelta(kind);
    },
  };
  return {
    timedOpts,
    log(status) {
      const now = Date.now();
      const ttft = turnFirstDelta ? turnFirstDelta - turnT0 : -1;
      try {
        console.error(`[turn-timing] status=${status} ttft=${ttft}ms total=${now - turnT0}ms model=${model}`);
      } catch {
        /* logging must never break the send path */
      }
    },
  };
}

// Retry visibility (reference parity). codex surfaces EVERY stream retry to
// the front-end ("Reconnecting... n/max") precisely so a replayed request
// cannot read as ordinary thinking; gemini-cli requires an onRetry hook for
// the same reason. Emitting the reconnect stage only for the backoff wait
// let the replayed send report plain 'requesting'/'streaming' again, so
// three stalled retries rendered as ~20 minutes of a normal spinner with
// nothing to explain it. Hold the reconnect stage across the whole replay
// until THIS attempt shows visible progress: the replacement stream's first
// visible delta ends the reconnect display, and from that point the turn is
// healthy and must read as a normal response.
function retryVisibilityWrappers(opts, timedOpts, retryAttemptNumber, retryMaxForDisplay) {
  const prevOnStageChange = typeof opts?.onStageChange === 'function' ? opts.onStageChange : null;
  const prevOptsOnStreamDelta = typeof opts?.onStreamDelta === 'function' ? opts.onStreamDelta : null;
  const retryDeltaBase = timedOpts || opts;
  const prevOnStreamDeltaForRetry =
    typeof retryDeltaBase?.onStreamDelta === 'function' ? retryDeltaBase.onStreamDelta : null;
  const wrappers = {
    onStageChange: null,
    onStreamDelta: null,
    prevOnStageChange,
    prevOptsOnStreamDelta,
    prevOnStreamDeltaForRetry,
  };
  if (!(retryAttemptNumber > 0 && prevOnStageChange)) return wrappers;
  let progressObserved = false;
  wrappers.onStageChange = (stage, detail) => {
    if (!progressObserved && (stage === 'requesting' || stage === 'streaming' || stage === MODEL_THINKING_STAGE)) {
      return prevOnStageChange('reconnecting', {
        ...(detail && typeof detail === 'object' ? detail : {}),
        attempt: retryAttemptNumber,
        max: retryMaxForDisplay,
        message: `Reconnecting... ${retryAttemptNumber}/${retryMaxForDisplay}`,
      });
    }
    return prevOnStageChange(stage, detail);
  };
  wrappers.onStreamDelta = (kind, ...rest) => {
    if (!progressObserved && isVisibleStreamProgress(kind)) {
      progressObserved = true;
      try {
        prevOnStageChange('streaming', { recoveredAfterRetry: retryAttemptNumber });
      } catch {
        /* display-only */
      }
    }
    return prevOnStreamDeltaForRetry?.(kind, ...rest);
  };
  return wrappers;
}

// Wraps the caller's stream callbacks in place for ONE send — bench-only
// turn timing, the loop-side exposure witness and the retry-visibility
// relay — and hands back the restore that unwinds only our own wrappers.
export function instrumentSendCallbacks(opts, { model, retryAttemptNumber, retryMaxForDisplay }) {
  const timing = beginTurnTiming(opts, model);
  const { timedOpts } = timing;
  // Loop-side exposure witness. Some providers throw truncation/stall
  // errors that carry only partialContent — neither liveTextEmitted nor
  // unsafeToRetry — so an outcome read from the ERROR alone can report
  // replaySafe even though this very send already relayed text to the
  // client through opts.onTextDelta, or dispatched a tool call through
  // opts.onToolCall. Replaying such a send would duplicate output the user
  // already saw (or re-run a side effect), so record what THIS send
  // actually exposed and merge it into every outcome read. The callbacks
  // are wrapped in place and restored conditionally: the overflow-retry
  // branch intentionally clears opts.onToolCall, and that clear must
  // survive the restore.
  const witness = relayWitnessWrappers(opts);
  const retry = retryVisibilityWrappers(opts, timedOpts, retryAttemptNumber, retryMaxForDisplay);
  const install = (target) => {
    if (witness.onTextDelta) target.onTextDelta = witness.onTextDelta;
    if (witness.onToolCall) target.onToolCall = witness.onToolCall;
    if (witness.onTextReset) target.onTextReset = witness.onTextReset;
    if (retry.onStageChange) target.onStageChange = retry.onStageChange;
    if (retry.onStreamDelta) target.onStreamDelta = retry.onStreamDelta;
  };
  if (opts) install(opts);
  if (timedOpts !== opts && timedOpts) install(timedOpts);
  return {
    timedOpts,
    relayWitness: witness.relayWitness,
    logTurnTiming: timing.log,
    restore: () => restoreSendCallbacks(opts, timedOpts, witness, retry),
  };
}

// Wraps opts.onTextDelta / opts.onToolCall / opts.onTextReset so the witness
// records what this send actually put on screen and dispatched: the relayed
// text net of acknowledged retractions (a provider's own non-streaming
// fallback retracts through the same callback), and the ids of dispatched
// calls. Null wrappers where the caller subscribed to nothing.
function relayWitnessWrappers(opts) {
  const relayWitness = { textEmitted: false, text: '', toolCallsDispatched: 0, dispatchedToolCallIds: new Set() };
  const prevOnTextDelta = typeof opts?.onTextDelta === 'function' ? opts.onTextDelta : null;
  const prevOnToolCall = typeof opts?.onToolCall === 'function' ? opts.onToolCall : null;
  const prevOnTextReset = typeof opts?.onTextReset === 'function' ? opts.onTextReset : null;
  const onTextDelta = prevOnTextDelta
    ? (...args) => {
        if (typeof args[0] === 'string' && args[0].length > 0) {
          relayWitness.textEmitted = true;
          relayWitness.text += args[0];
        }
        return prevOnTextDelta(...args);
      }
    : null;
  const onToolCall = prevOnToolCall
    ? (...args) => {
        relayWitness.toolCallsDispatched += 1;
        if (args[0]?.id) relayWitness.dispatchedToolCallIds.add(String(args[0].id));
        return prevOnToolCall(...args);
      }
    : null;
  const onTextReset = prevOnTextReset
    ? async (...args) => {
        const acked = await prevOnTextReset(...args);
        if (acked === true) {
          const kept = relayWitness.text.length - Math.max(0, Number(args[0]?.chars) || 0);
          relayWitness.text = relayWitness.text.slice(0, Math.max(0, kept));
          if (!relayWitness.text) relayWitness.textEmitted = false;
        }
        return acked;
      }
    : null;
  return {
    relayWitness,
    onTextDelta,
    onToolCall,
    onTextReset,
    prevOnTextDelta,
    prevOnToolCall,
    prevOnTextReset,
  };
}

// Conditional restore: only unwind our own wrappers. An intentional
// opts.onToolCall = undefined (overflow-retry branch) stays cleared.
function restoreSendCallbacks(opts, timedOpts, witness, retry) {
  if (opts) {
    if (witness.onTextDelta && opts.onTextDelta === witness.onTextDelta) opts.onTextDelta = witness.prevOnTextDelta;
    if (witness.onToolCall && opts.onToolCall === witness.onToolCall) opts.onToolCall = witness.prevOnToolCall;
    if (witness.onTextReset && opts.onTextReset === witness.onTextReset) opts.onTextReset = witness.prevOnTextReset;
    if (retry.onStageChange && opts.onStageChange === retry.onStageChange) {
      opts.onStageChange = retry.prevOnStageChange;
    }
    if (retry.onStreamDelta && opts.onStreamDelta === retry.onStreamDelta) {
      opts.onStreamDelta = retry.prevOptsOnStreamDelta;
    }
  }
  if (timedOpts && timedOpts !== opts) {
    if (retry.onStageChange && timedOpts.onStageChange === retry.onStageChange) {
      timedOpts.onStageChange = retry.prevOnStageChange;
    }
    if (retry.onStreamDelta && timedOpts.onStreamDelta === retry.onStreamDelta) {
      timedOpts.onStreamDelta = retry.prevOnStreamDeltaForRetry;
    }
  }
}
