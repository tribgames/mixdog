// provider.send wrapper with stall/overflow recovery.
// Returns { action } so the loop keeps control of the
// while-loop: proceed carries the response, retry signals a reactive
// context-overflow compact retry (caller re-enters the pre-send compact
// pass), and unrecoverable errors throw.
import { appendAgentTrace } from '../agent-trace.mjs';
import {
  classifyError,
  isConnectionFailure,
  isContextOverflowError,
  isCursorTransientTransportError,
  isNonTerminalStreamClose,
  isRetryableWireErrorEvent,
  isRetryableStreamErrorEvent,
  isProviderRecoveryExhausted,
  jitterDelayMs,
  resetStallRetryBudget,
  resolveStallRetryBudget,
} from '../providers/retry-classifier.mjs';
import {
  persistenceMessagesForConfirmedImageRejection,
  promptHasInlineImages,
  shouldStripImagesForRetry,
  stripInlineImagesFromLatestTurn,
} from './image-strip-recovery.mjs';
import {
  canRepairThinkingReplay,
  isThinkingReplayRejection,
  repairThinkingReplayInPlace,
} from './thinking-replay-recovery.mjs';
import { setTimeout as sleepMs } from 'node:timers/promises';
import { readStreamOutcome } from '../providers/lib/stream-outcome.mjs';
import { cloneProviderReplay } from '../providers/lib/provider-replay.mjs';
import { resolveWorkerCompactPolicy } from './loop/compact-policy.mjs';
import { agentContextOverflowError } from './loop/context-overflow.mjs';
import { estimateMessagesTokensSafe } from './loop/compact-debug.mjs';
import { isOutputLimitStopReason } from './loop/termination.mjs';
import { isVisibleStreamProgress } from '../../../shared/stream-progress.mjs';
import { providerRetryStatusText } from '../../../shared/err-text.mjs';

function normalizedIncompleteUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const directInputTokens =
    Number(raw.promptTokenCount ?? raw.prompt_token_count ?? raw.input_tokens ?? raw.prompt_tokens ?? 0) || 0;
  const candidateTokens = Number(raw.candidatesTokenCount ?? raw.candidates_token_count ?? 0) || 0;
  const thoughtTokens = Number(raw.thoughtsTokenCount ?? raw.thoughts_token_count ?? 0) || 0;
  const totalTokens = Number(raw.totalTokenCount ?? raw.total_token_count ?? 0) || 0;
  const hasExplicitGeminiPromptTokens =
    Object.hasOwn(raw, 'promptTokenCount') || Object.hasOwn(raw, 'prompt_token_count');
  const inputTokens =
    hasExplicitGeminiPromptTokens || directInputTokens > 0
      ? directInputTokens
      : Math.max(0, totalTokens - candidateTokens - thoughtTokens);
  const outputFallback = Number(raw.output_tokens ?? raw.completion_tokens ?? 0) || 0;
  const cachedTokens =
    Number(raw.cachedContentTokenCount ?? raw.cached_content_token_count ?? raw.cached_tokens ?? 0) || 0;
  return {
    inputTokens,
    outputTokens: candidateTokens + thoughtTokens || outputFallback,
    cachedTokens,
    cacheWriteTokens: 0,
    promptTokens: inputTokens,
    raw,
  };
}

// Loop-level transport replay. Providers that own a retry/fallback ladder stamp
// providerRecoveryExhausted when that ladder is spent; those failures surface
// immediately instead of multiplying the provider budget here. This ladder is
// retained for one-shot transports that expose no output and have no provider
// recovery owner.
// Env-overridable (comma-separated ms) so tests can drive the ladder without
// real waits and an operator can widen the window for a flaky uplink; the
// LENGTH of the list is the retry budget, like a conventional
// stream-max-retries + backoff table.
function retryLadderFromEnv(envName, fallback) {
  const raw = process.env[envName];
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (parsed.length) return Object.freeze(parsed);
  }
  return Object.freeze(fallback);
}

// Three steps (~50s of outage) instead of two: the provider envelope
// already covers short blips, so this ladder exists for the long ones.
const TRANSPORT_RETRY_BACKOFF_MS = retryLadderFromEnv('MIXDOG_TRANSPORT_RETRY_BACKOFF_MS', [5_000, 15_000, 30_000]);
export const TRANSPORT_RETRY_MAX = TRANSPORT_RETRY_BACKOFF_MS.length;

// A lost NETWORK is not a provider fault, so it gets its own far longer
// ladder: exponential to a one-minute ceiling, ~10 minutes of total cover.
// Failing the turn after ~50s discarded real work for an outage the user
// often never noticed (a lift, a sleeping laptop, a router reboot), while the
// identical request succeeds the moment the link returns. Comparable runtimes
// retry this class until the network comes back; the cap is what keeps a
// parked background session from waiting forever with nobody watching.
const CONNECTION_RETRY_BACKOFF_MS = retryLadderFromEnv('MIXDOG_CONNECTION_RETRY_BACKOFF_MS', [
  5_000,
  10_000,
  20_000,
  40_000,
  ...Array(9).fill(60_000),
]);

// Jittering every backoff by 0.9–1.1 keeps parallel workers that lose the
// same uplink do not resume in lockstep; our provider layers already jitter
// (10% WS / 20% shared), this brings the loop ladder in line.
const TRANSPORT_RETRY_JITTER_RATIO = 0.1;

/** The ladder this failure class is entitled to: lost uplink vs ordinary fault. */
function retryLadderFor(error) {
  return isConnectionFailure(error) ? CONNECTION_RETRY_BACKOFF_MS : TRANSPORT_RETRY_BACKOFF_MS;
}

function retryBudgetFor(error) {
  return retryLadderFor(error).length;
}

function transportRetryWaitMs(attemptIndex, error) {
  const ladder = retryLadderFor(error);
  const base = ladder[Math.min(Math.max(attemptIndex, 0), ladder.length - 1)];
  return jitterDelayMs(base, TRANSPORT_RETRY_JITTER_RATIO);
}

// Every loop-level replay is a NEW request, so it opens a new stall window.
// Inheriting the spent one aborted healthy replacement responses mid-flight.
function beginFreshTransportAttempt(opts, retryMax) {
  resetStallRetryBudget(opts);
  return { action: 'retry_transport', transportRetryMax: retryMax };
}

export async function sendWithRecovery(ctx) {
  const {
    provider,
    messages,
    model,
    sendTools,
    opts,
    sessionId,
    transportRetriesUsed = 0,
    transportRetryMax = 0,
  } = ctx;
  // Establishes the in-request stall window the provider layer shares through
  // opts. A fresh replay below resets it: the loop's own TRANSPORT_RETRY_MAX
  // is what bounds replays, not a window already spent detecting the stall.
  resolveStallRetryBudget(opts);
  // Reconnect chrome for THIS attempt. The ladder that actually bounds the
  // replays is picked per failure class below and carried back through the
  // loop, so "Reconnecting... n/max" reports the budget the outage is really
  // getting instead of the default one.
  const retryMaxForDisplay =
    Number(transportRetryMax) > 0 ? Math.floor(Number(transportRetryMax)) : TRANSPORT_RETRY_MAX;
  const hooks = instrumentSendCallbacks(opts, {
    model,
    retryAttemptNumber: Math.max(0, Number(transportRetriesUsed) || 0),
    retryMaxForDisplay,
  });
  try {
    let response;
    try {
      const { timedOpts } = hooks;
      const admittedOpts = timedOpts?.admissionOwner ? timedOpts : { ...(timedOpts || {}), admissionOwner: sessionId };
      response = await provider.send(messages, model, sendTools.length ? sendTools : undefined, admittedOpts);
      hooks.logTurnTiming('ok');
    } catch (sendErr) {
      hooks.logTurnTiming(`err:${sendErr?.code || sendErr?.name || 'unknown'}`);
      return await recoverFromSendError(sendErr, { ...ctx, relayWitness: hooks.relayWitness });
    }
    return { action: 'proceed', response };
  } finally {
    hooks.restore();
  }
}

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
    if (!progressObserved && (stage === 'requesting' || stage === 'streaming')) {
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
function instrumentSendCallbacks(opts, { model, retryAttemptNumber, retryMaxForDisplay }) {
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

// Wraps opts.onTextDelta / opts.onToolCall so the witness records what this
// send actually relayed; null wrappers where the caller subscribed to nothing.
function relayWitnessWrappers(opts) {
  const relayWitness = { textEmitted: false, toolCallsDispatched: 0 };
  const prevOnTextDelta = typeof opts?.onTextDelta === 'function' ? opts.onTextDelta : null;
  const prevOnToolCall = typeof opts?.onToolCall === 'function' ? opts.onToolCall : null;
  const onTextDelta = prevOnTextDelta
    ? (...args) => {
        if (typeof args[0] === 'string' && args[0].length > 0) relayWitness.textEmitted = true;
        return prevOnTextDelta(...args);
      }
    : null;
  const onToolCall = prevOnToolCall
    ? (...args) => {
        relayWitness.toolCallsDispatched += 1;
        return prevOnToolCall(...args);
      }
    : null;
  return { relayWitness, onTextDelta, onToolCall, prevOnTextDelta, prevOnToolCall };
}

// Conditional restore: only unwind our own wrappers. An intentional
// opts.onToolCall = undefined (overflow-retry branch) stays cleared.
function restoreSendCallbacks(opts, timedOpts, witness, retry) {
  if (opts) {
    if (witness.onTextDelta && opts.onTextDelta === witness.onTextDelta) opts.onTextDelta = witness.prevOnTextDelta;
    if (witness.onToolCall && opts.onToolCall === witness.onToolCall) opts.onToolCall = witness.prevOnToolCall;
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

function loopTag({ sessionId, nextIteration }) {
  return `sess=${sessionId || 'unknown'} iter=${nextIteration}`;
}

function logLoop(line) {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    /* best-effort */
  }
}

function traceLoop({ sessionId, nextIteration }, kind, fields) {
  try {
    appendAgentTrace({ kind, sessionId: sessionId || null, iteration: nextIteration, ...fields });
  } catch {
    /* best-effort */
  }
}

// Caller-visible reconnect progress for LOOP-level replays, mirroring the
// transports' own emitReconnectProgress (openai-oauth-ws). Without it the
// 5s/15s wait rendered as a frozen turn with no explanation, so the stage
// change surfaces "Reconnecting... n/max" instead of leaving the user
// staring at a stalled stream.
function emitLoopReconnectProgress(opts, { attempt, maxAttempts, waitMs, classifier, error }) {
  try {
    opts?.onStageChange?.('reconnecting', {
      attempt,
      max: maxAttempts,
      classifier: classifier || null,
      waitMs,
      wsCloseCode: error?.wsCloseCode ?? null,
      httpStatus: error?.httpStatus ?? error?.status ?? null,
      message: providerRetryStatusText(error, { attempt, maxAttempts, delayMs: waitMs }),
    });
  } catch {
    /* progress reporting must never break recovery */
  }
}

// Text-only exposure retraction (cross-provider): a stream that died after
// relaying ONLY text — no dispatched or complete tool calls, no terminal —
// is replayable IF the ask owner retracts the exposed characters
// (onTextReset ack === true: the TUI truncates its live tail, the bench
// driver truncates its accumulator). This is the loop-level analogue of
// anthropic's recoverNonStreaming for providers WITHOUT a non-streaming
// fallback (gemini, openai-compat, openai WS) and for stalls that outlived
// the provider's in-place recovery. Observed live: make-mips-interpreter
// died with 31 exposed chars + a pending never-dispatched tool input and
// burned the whole trial.
async function retractExposedTextForReplay({ outcome, sendErr, opts, relayWitness }) {
  if (outcome.terminalObserved === true) return false;
  if (outcome.sideEffectDispatched === true) return false;
  if (outcome.dispatchAmbiguous === true) return false;
  if (Number(outcome.toolCallsDispatched) > 0) return false;
  if (Number(outcome.toolCallsComplete) > 0) return false;
  if (relayWitness.toolCallsDispatched > 0) return false;
  const chars =
    Math.max(0, Number(outcome.textObservedChars) || 0) ||
    (typeof sendErr.partialContent === 'string' ? sendErr.partialContent.length : 0);
  const reasoningOnly = outcome.reasoningEmitted === true && chars <= 0;
  if (chars <= 0 && !reasoningOnly) return false;
  if (typeof opts?.onTextReset === 'function') {
    let acked = false;
    try {
      acked =
        (await opts.onTextReset({
          chars,
          reasoning: outcome.reasoningEmitted === true,
          reason: 'loop-transport-retraction',
        })) === true;
    } catch {
      acked = false;
    }
    if (!acked && !reasoningOnly) return false;
  } else if (!reasoningOnly) {
    return false;
  }
  relayWitness.textEmitted = false;
  return true;
}

// One failed provider.send. Canonical stream outcome first: ONE fail-closed
// read of what the provider stream actually produced (terminal vs
// continuation, observed text/reasoning, partial/complete/dispatched tool
// calls); every branch consumes it instead of re-inferring safety from
// provider-specific flags. Branch order is the recovery precedence.
async function recoverFromSendError(sendErr, state) {
  const {
    opts,
    model,
    messages,
    recoveryMessages = messages,
    sessionRef,
    transportRetriesUsed = 0,
    imageStripUsed = false,
    thinkingReplayRepairUsed = false,
    relayWitness,
  } = state;
  const outcome = readStreamOutcome(sendErr, relayWitness);
  const retract = () => retractExposedTextForReplay({ outcome, sendErr, opts, relayWitness });
  if (isPromotableIncomplete(sendErr, outcome)) {
    return { action: 'proceed', response: promotedIncompleteResponse(sendErr, model, opts) };
  }
  if (isExposedNoToolStall(sendErr, outcome)) {
    return recoverExposedStall(sendErr, outcome, state, retract);
  }
  if (isCompleteToolCallStall(sendErr, outcome)) {
    return recoverPartialToolCalls(sendErr, state);
  }
  // Clean transient transport failure with zero exposure: replay the send
  // after a bounded wait instead of failing the turn.
  if (
    transportRetriesUsed < retryBudgetFor(sendErr) &&
    !isProviderRecoveryExhausted(sendErr) &&
    (await transportReplayPermitted(sendErr, outcome, retract))
  ) {
    return retryTransport(sendErr, state);
  }
  // Anthropic replay-shape refusal: the latest assistant turn carries
  // thinking blocks the API will not accept back (a thinking run it did not
  // produce, or an empty text block). This is deterministic — the same body
  // fails forever and the turn is already persisted, so without this repair
  // the session is dead. No exposure guard: the request was rejected at
  // validation, before any generation.
  if (
    thinkingReplayRepairUsed !== true &&
    isThinkingReplayRejection(sendErr) &&
    canRepairThinkingReplay(recoveryMessages)
  ) {
    return repairThinkingReplay(recoveryMessages, state);
  }
  // Grok Build RetryWithImageStrip: drop inline images and replay once. Safe
  // only when no tool was dispatched. Text exposure must be retracted first;
  // reasoning-only high-effort streams can retry without a text reset.
  if (
    imageStripEligible(sendErr, outcome, { recoveryMessages, imageStripUsed, transportRetriesUsed, relayWitness }) &&
    (outcome.replaySafe === true || (await retract()))
  ) {
    const stripped = retryWithImageStrip(sendErr, recoveryMessages, state);
    if (stripped) return stripped;
  }
  // Nothing strippable (or no strip attempted): only a real context overflow
  // may continue into the reactive compaction retry.
  if (!isContextOverflowError(sendErr) || !(sessionRef && typeof sessionRef.contextWindow === 'number')) {
    throw sendErr;
  }
  return recoverContextOverflow(sendErr, outcome, state);
}

// Gemini REST/SDK reports MAX_TOKENS by throwing a typed
// ProviderIncompleteError after preserving the streamed candidate. Only that
// exact, safe no-tool output-limit shape — terminal observed (explicit finish
// reason) and no tool exposure at all — is promoted to a regular truncated
// response; moderation/OTHER/tool-bearing and unrelated errors continue
// through their existing error paths.
function isPromotableIncomplete(sendErr, outcome) {
  return (
    sendErr?.providerIncomplete === true &&
    sendErr.code === 'PROVIDER_INCOMPLETE' &&
    isOutputLimitStopReason(sendErr.finishReason) &&
    typeof sendErr.partialContent === 'string' &&
    sendErr.partialContent.trim().length > 0 &&
    outcome.successEligible === true &&
    outcome.toolCallsStarted !== true &&
    outcome.sideEffectDispatched !== true
  );
}

function promotedIncompleteResponse(sendErr, model, opts) {
  const partialProviderReplay = cloneProviderReplay(sendErr.partialProviderReplay);
  return {
    content: sendErr.partialContent,
    model: sendErr.model || model,
    toolCalls: undefined,
    usage: normalizedIncompleteUsage(sendErr.rawUsage),
    stopReason: sendErr.finishReason,
    truncated: true,
    ...(partialProviderReplay ? { providerReplay: partialProviderReplay } : {}),
    providerMetadata: sendErr.providerMetadata,
    providerState: opts.providerState,
    providerIncompleteRecovery: true,
  };
}

// Exhausted no-tool stall: NOT a success. A FINAL, no-tool stream that
// wedges (ping-only) carries streamed assistant text on the
// StreamStalledError, but the turn never completed — the model may have been
// mid-sentence, and there is no completion signal that says the work is
// done. Promoting it to a normal terminal response silently reported
// truncated/aborted turns as finished. A stall WITH complete parsed tool
// calls is a different, genuinely recoverable case (isCompleteToolCallStall).
function isExposedNoToolStall(sendErr, outcome) {
  return (
    outcome.stallObserved === true &&
    outcome.terminalObserved !== true &&
    typeof sendErr.partialContent === 'string' &&
    sendErr.partialContent.trim().length > 0 &&
    outcome.toolCallsComplete === 0
  );
}

// Retractable shape: text-only exposure with the owner's acknowledgement
// replays on a fresh request instead of failing the turn. Non-acked (or
// tool-bearing) shapes keep the explicit-failure contract: no completion
// signal means no completed turn, and the partial is persisted — the
// already-streamed text is preserved by the interruption/error persistence
// path (turn-interruption.mjs records the deltas and commits them as the
// partial assistant message alongside the error), so nothing visible is
// lost while the caller/owner-notify still sees a failed turn.
// NOTE: no classifyError gate here — an exposed stall is stamped
// unsafeToRetry, which the general classifier reads as terminal, but that
// unsafety is exactly what the retraction removes (observed live:
// make-mips-interpreter failed twice because this guard demanded
// 'transient' and never fired).
async function recoverExposedStall(sendErr, outcome, state, retract) {
  const { transportRetriesUsed = 0 } = state;
  const exposedRetryBudget = retryBudgetFor(sendErr);
  const len = sendErr.partialContent.length;
  if (transportRetriesUsed < exposedRetryBudget && !isProviderRecoveryExhausted(sendErr) && (await retract())) {
    return scheduleTransportReplay(sendErr, state, {
      budget: exposedRetryBudget,
      note: `[loop] exposed-text stall retracted (${loopTag(state)} len=${len})`,
      trace: { kind: 'exposed_text_retraction_retry', partialContentLen: len },
      classifier: outcome.stallObserved ? 'stream_stalled' : 'stream_closed',
    });
  }
  logLoop(
    `[loop] final stream stalled with partial text (${loopTag(state)} len=${len}); failing the turn (partial preserved via interrupted-turn persistence)`
  );
  traceLoop(state, 'stall_partial_final_rejected', {
    partialContentLen: len,
    pendingToolUse: outcome.pendingToolInput,
    emittedToolCall: outcome.sideEffectDispatched,
    terminalObserved: outcome.terminalObserved,
  });
  throw sendErr;
}

// Loop-level replay after a bounded wait: the stderr note, the trace entry,
// the caller-visible "Reconnecting... n/max" stage, then a fresh attempt.
async function scheduleTransportReplay(sendErr, state, { budget, note, trace, classifier }) {
  const { opts, signal, transportRetriesUsed = 0 } = state;
  const attempt = transportRetriesUsed + 1;
  const waitMs = transportRetryWaitMs(transportRetriesUsed, sendErr);
  logLoop(`${note}; transport retry ${attempt}/${budget} after ${waitMs}ms`);
  const { kind, ...fields } = trace;
  traceLoop(state, kind, { attempt, waitMs, ...fields });
  emitLoopReconnectProgress(opts, { attempt, maxAttempts: budget, waitMs, classifier, error: sendErr });
  await sleepMs(waitMs, undefined, signal ? { signal } : undefined);
  return beginFreshTransportAttempt(opts, budget);
}

// Partial tool-call recovery (agent-hang fix): a stream that ends AFTER
// fully-parsed tool calls were emitted used to lose the whole turn —
// unsafeToRetry blocks the mid-stream replay (correct: a replay would re-run
// side-effecting tools) and the loop gave up, discarding tool work that had
// ALREADY completed via eager dispatch. ANY non-terminal end qualifies, not
// just a watchdog stall: continuing is not replaying — the parsed calls
// resolve from the pending map without re-running, their results commit to
// history, and the NEXT request carries them forward. pendingToolInput stays
// the hard guard: half-streamed arguments are not a tool call. Named
// TRANSPORT symptoms only: a typed refusal (context overflow, policy, quota)
// also arrives without a terminal frame, but nothing was generated there and
// continuing would paper over the refusal.
function isCompleteToolCallStall(sendErr, outcome) {
  return (
    outcome.terminalObserved !== true &&
    (outcome.stallObserved === true ||
      outcome.truncatedStream === true ||
      isNonTerminalStreamClose(sendErr) ||
      isConnectionFailure(sendErr)) &&
    outcome.pendingToolInput !== true &&
    outcome.toolCallsComplete > 0 &&
    Array.isArray(sendErr.partialToolCalls) &&
    sendErr.partialToolCalls.length > 0
  );
}

// The recovered partial as a normal tool-call turn: eager-dispatched
// (read-only) calls resolve from the pending map without re-running,
// side-effecting calls were never started during streaming and execute
// exactly once. providerState stays undefined so the next iteration resends
// a full frame on a fresh stream.
function recoveredToolCallResponse(sendErr, model) {
  const partialProviderReplay = cloneProviderReplay(sendErr.partialProviderReplay);
  return {
    content: typeof sendErr.partialContent === 'string' ? sendErr.partialContent : '',
    model: sendErr.partialModel || model,
    toolCalls: sendErr.partialToolCalls.slice(),
    usage: sendErr.partialUsage || undefined,
    stopReason: 'tool_use',
    hasThinkingContent: sendErr.partialHasThinking === true,
    // Ordered provider block state captured before the stall. Anthropic
    // REQUIRES the verbatim thinking blocks (with their signatures) back
    // ahead of tool_use on the continuation turn, and a native
    // `server_tool_use` call is only valid immediately followed by its
    // result block — so the recovered tool turn must replay exactly what a
    // successful turn would have returned. The loop's committer already
    // drops the redundant `thinkingBlocks` copy when `assistantBlocks` is
    // present (which contains them verbatim), so blocks are neither lost
    // nor doubled.
    ...(Array.isArray(sendErr.partialThinkingBlocks) && sendErr.partialThinkingBlocks.length
      ? { thinkingBlocks: sendErr.partialThinkingBlocks }
      : {}),
    ...(Array.isArray(sendErr.partialAssistantBlocks) && sendErr.partialAssistantBlocks.length
      ? { assistantBlocks: sendErr.partialAssistantBlocks }
      : {}),
    ...(partialProviderReplay ? { providerReplay: partialProviderReplay } : {}),
    providerMetadata: sendErr.providerMetadata,
    partialToolRecovery: true,
  };
}

function recoverPartialToolCalls(sendErr, state) {
  const toolCalls = sendErr.partialToolCalls.length;
  logLoop(
    `[loop] stream ended after ${toolCalls} complete tool call(s) (${loopTag(state)}); recovering as tool-call turn instead of failing`
  );
  traceLoop(state, 'partial_tool_recovery', {
    toolCalls,
    partialContentLen: typeof sendErr.partialContent === 'string' ? sendErr.partialContent.length : 0,
  });
  return { action: 'proceed', response: recoveredToolCallResponse(sendErr, state.model) };
}

// Zero-exposure transient failures replay outright. classifyError reports
// 'permanent' the moment anything was exposed, so an exposed disconnect
// could never reach the retraction path: name the transport symptoms
// directly — stall, truncated stream (anthropic
// message_start-without-message_stop, gemini/compat EOF), retryable wire /
// stream error events (response.failed server_error & co.), Cursor
// continuation streams that carry a typed transport code even when
// reasoning/text exposure makes classifyError() intentionally permanent,
// non-terminal close — then retract the exposed text and replay.
async function transportReplayPermitted(sendErr, outcome, retract) {
  if (outcome.replaySafe === true && classifyError(sendErr) === 'transient') return true;
  const transportSymptom =
    classifyError(sendErr) === 'transient' ||
    outcome.stallObserved === true ||
    outcome.truncatedStream === true ||
    isRetryableWireErrorEvent(sendErr) ||
    isRetryableStreamErrorEvent(sendErr) ||
    isCursorTransientTransportError(sendErr) ||
    isNonTerminalStreamClose(sendErr);
  return transportSymptom && (await retract());
}

function retryTransport(sendErr, state) {
  return scheduleTransportReplay(sendErr, state, {
    budget: retryBudgetFor(sendErr),
    note:
      `[loop] transient send failure with no dispatched tools (${loopTag(state)} code=${sendErr?.code ?? 'n/a'} ` +
      `wsCloseCode=${sendErr?.wsCloseCode ?? 'n/a'} httpStatus=${sendErr?.httpStatus ?? sendErr?.status ?? 'n/a'})`,
    trace: {
      kind: 'transport_retry',
      code: sendErr?.code ?? null,
      status: sendErr?.httpStatus ?? sendErr?.status ?? null,
      ws_close_code: sendErr?.wsCloseCode ?? null,
      retry_owner: 'loop',
    },
    classifier: sendErr?.retryClassifier || sendErr?.midstreamClassifier || sendErr?.code || null,
  });
}

// Drops that turn's reasoning replay in place (its text and tool calls
// stay) and replays once.
function repairThinkingReplay(recoveryMessages, state) {
  const repairedIndex = repairThinkingReplayInPlace(recoveryMessages);
  logLoop(
    `[loop] thinking-replay repair (${loopTag(state)} message=${repairedIndex}); dropped the rejected reasoning replay and replaying once`
  );
  traceLoop(state, 'thinking_replay_repair', { messageIndex: repairedIndex });
  return { action: 'retry_replay_repair' };
}

function imageStripEligible(
  sendErr,
  outcome,
  { recoveryMessages, imageStripUsed, transportRetriesUsed, relayWitness }
) {
  return (
    transportRetriesUsed < TRANSPORT_RETRY_MAX &&
    (shouldStripImagesForRetry(sendErr, {
      hasImages: promptHasInlineImages(recoveryMessages),
      alreadyStripped: imageStripUsed === true,
    }) ||
      (imageStripUsed !== true && promptHasInlineImages(recoveryMessages) && isRetryableStreamErrorEvent(sendErr))) &&
    outcome.sideEffectDispatched !== true &&
    Number(outcome.toolCallsDispatched) === 0 &&
    Number(outcome.toolCallsComplete) === 0 &&
    relayWitness.toolCallsDispatched === 0
  );
}

function retryWithImageStrip(sendErr, recoveryMessages, state) {
  const { opts, transportRetriesUsed = 0 } = state;
  const stripped = stripInlineImagesFromLatestTurn(recoveryMessages);
  if (!(stripped.stripped > 0)) return null;
  const attempt = transportRetriesUsed + 1;
  logLoop(
    `[loop] image-strip retry (${loopTag(state)} stripped=${stripped.stripped}); transport retry ${attempt}/${TRANSPORT_RETRY_MAX}`
  );
  traceLoop(state, 'image_strip_retry', { attempt, stripped: stripped.stripped });
  emitLoopReconnectProgress(opts, {
    attempt,
    maxAttempts: TRANSPORT_RETRY_MAX,
    waitMs: 0,
    classifier: 'image_strip',
    error: null,
  });
  return {
    action: 'retry_image_strip',
    messages: stripped.messages,
    persistMessages: persistenceMessagesForConfirmedImageRejection(sendErr, recoveryMessages),
  };
}

// Context-window-exceeded is a deterministic refusal from the API. Recover
// context overflow reactively by compacting and retrying in the same active
// turn: the proactive estimator can miss a provider-specific overhead
// spike, so do one reactive retry by marking the live session
// over-threshold and looping back through the normal pre-send auto-compact
// path. If compaction/retry still fails, surface the overflow normally.
function recoverContextOverflow(sendErr, outcome, state) {
  const { opts, messages, sendTools, tools, sessionId, sessionRef, model, contextOverflowRetryUsed } = state;
  const compactPolicyForRetry = resolveWorkerCompactPolicy(sessionRef, sendTools.length ? sendTools : tools);
  // The reactive retry RE-SENDS the turn, so it is a replay: denied once
  // visible text/reasoning was relayed or a tool call was dispatched (or
  // ambiguously dispatched). A deterministic overflow refusal that exposed
  // nothing may compact and re-send.
  const replayPermitted = outcome.replaySafe === true;
  if (!contextOverflowRetryUsed && compactPolicyForRetry?.auto && replayPermitted) {
    // Mark the next pre-send compact as REACTIVE (driven by a provider
    // overflow refusal) rather than the normal proactive pressure trigger,
    // so the compact event/telemetry the loop emits on the retry is
    // distinguishable downstream.
    opts.onToolCall = undefined;
    logLoop(`[loop] context overflow on send (${loopTag(state)}); reactive compact retry messages=${messages.length}`);
    return { action: 'retry' };
  }
  logLoop(
    `[loop] context overflow on send (${loopTag(state)}); surfacing overflow (retryUsed=${contextOverflowRetryUsed === true} ` +
      `replaySafe=${outcome.replaySafe === true} replayUnsafe=${outcome.replayUnsafe === true}) messages=${messages.length}`
  );
  throw agentContextOverflowError(
    {
      stage: 'send',
      sessionId,
      sessionRef,
      model,
      budgetTokens: sessionRef.contextWindow,
      reserveTokens: compactPolicyForRetry?.reserveTokens,
      messageTokensEst: estimateMessagesTokensSafe(messages),
    },
    sendErr
  );
}
