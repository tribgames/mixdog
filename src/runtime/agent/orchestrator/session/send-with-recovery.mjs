// provider.send wrapper with stall/overflow recovery.
// Returns { action } so the loop keeps control of the
// while-loop: proceed carries the response, retry signals a reactive
// context-overflow compact retry (caller re-enters the pre-send compact
// pass), and unrecoverable errors throw.
import { appendAgentTrace } from '../agent-trace.mjs';
import {
  classifyError,
  isConnectFailure,
  isContextOverflowError,
  isCursorTransientTransportError,
  isRetryableWireErrorEvent,
  isRetryableStreamErrorEvent,
  isProviderRecoveryExhausted,
  isServerUnavailable,
  isStreamCut,
  isToolInputCut,
  emitProviderRetryStage,
  jitterDelayMs,
  resetStallRetryBudget,
  resolveStallRetryBudget,
  retryAfterMsFromError,
} from '../providers/retry-classifier.mjs';
import {
  persistsConfirmedImageRejection,
  promptHasInlineImages,
  shouldStripImagesForRetry,
  isImagePreparationFailed,
  stripFailingImage,
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
import { instrumentSendCallbacks } from './send-instrumentation.mjs';

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
// recovery owner — and for a connect failure, which only proves the network is
// still down (see CONNECTION_RETRY_BACKOFF_MS).
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

// An unreachable NETWORK (the connection cannot be established) is not a
// provider fault, so it gets its own far longer ladder: exponential to a
// one-minute ceiling, ~10 minutes of total cover. Failing the turn early
// discarded real work for an outage the user often never noticed (a lift, a
// sleeping laptop, a router reboot), while the identical request succeeds the
// moment the link returns. Comparable runtimes retry this class until the
// network comes back, so it also outlives a provider's own spent ladder; the
// cap is what keeps a parked background session from waiting forever with
// nobody watching. A stream that dropped MID-RESPONSE keeps the ordinary
// ladder: each replay regenerates the whole response, and a path that cuts
// long responses would cut every replay the same way.
const CONNECTION_RETRY_BACKOFF_MS = retryLadderFromEnv('MIXDOG_CONNECTION_RETRY_BACKOFF_MS', [
  5_000,
  10_000,
  20_000,
  40_000,
  ...Array(9).fill(60_000),
]);

// After a provider has spent its own ladder on a server that is temporarily
// unavailable (5xx, overload, a response that never came), the turn is not
// ended while nothing has reached the user: it parks on these bounded recovery
// cycles, and each cycle re-enters the provider's ordinary retries (reference:
// bounded post-exhaustion auto-recovery on a jittered 15/30/60/60/60 s
// schedule).
const RECOVERY_RETRY_BACKOFF_MS = retryLadderFromEnv(
  'MIXDOG_RECOVERY_RETRY_BACKOFF_MS',
  [15_000, 30_000, 60_000, 60_000, 60_000]
);

// A server-advised wait (Retry-After) replaces the ladder step: a provider that
// names its own cooldown knows better, within reason — one loop-level wait
// never parks longer than this.
const LOOP_RETRY_AFTER_CAP_MS = 120_000;

// Jittering every backoff by 0.9–1.1 means parallel workers that lose the
// same uplink do not resume in lockstep; our provider layers already jitter
// (10% WS / 20% shared), this brings the loop ladder in line.
const TRANSPORT_RETRY_JITTER_RATIO = 0.1;

/** The ladder this failure class is entitled to: an unreachable network, a
 *  provider still unavailable after its own retries, or an ordinary fault. */
function retryLadderFor(error) {
  if (isConnectFailure(error)) return CONNECTION_RETRY_BACKOFF_MS;
  if (isProviderRecoveryExhausted(error) && isServerUnavailable(error)) return RECOVERY_RETRY_BACKOFF_MS;
  return TRANSPORT_RETRY_BACKOFF_MS;
}

function retryBudgetFor(error) {
  return retryLadderFor(error).length;
}

// A provider ladder spent on a connect failure has only shown that the network
// is still down (outage ladder); one spent on a server that is temporarily
// unavailable parks on the recovery cycles, but only while nothing has reached
// the user — a replay would otherwise re-show output or re-run a tool. Every
// other exhausted failure surfaces as-is.
function providerRecoveryEnded(error, outcome) {
  if (!isProviderRecoveryExhausted(error) || isConnectFailure(error)) return false;
  return !(outcome.replaySafe === true && isServerUnavailable(error));
}

function transportRetryWaitMs(attemptIndex, error) {
  const advisedMs = retryAfterMsFromError(error);
  if (advisedMs != null) return Math.min(advisedMs, LOOP_RETRY_AFTER_CAP_MS);
  const ladder = retryLadderFor(error);
  const base = ladder[Math.min(Math.max(attemptIndex, 0), ladder.length - 1)];
  return jitterDelayMs(base, TRANSPORT_RETRY_JITTER_RATIO);
}

// Every loop-level replay is a NEW request, so it opens a new stall window.
// Inheriting the spent one aborted healthy replacement responses mid-flight.
// A replay may carry a runtime notice the loop adds to the next request.
function beginFreshTransportAttempt(opts, retryMax, notice = null) {
  resetStallRetryBudget(opts);
  return { action: 'retry_transport', transportRetryMax: retryMax, ...(notice ? { notice } : {}) };
}

// Runtime notice for the model after a stream was cut while a tool call's
// arguments were still streaming: that call never ran, and the same large
// arguments would likely be cut again (reference: a chunked-retry nudge
// instead of repeating the identical call). The [mixdog-runtime] prefix keeps
// it out of the transcript view.
const TOOL_INPUT_CUT_NOTICE =
  "[mixdog-runtime] The previous response was cut off in transit while a tool call's arguments were still " +
  'streaming, so that call never ran. This was a network interruption, not a tool failure; tools remain ' +
  'available. Do not resend the same large arguments in one call: split the content across several smaller ' +
  'tool calls (for example, write the first part, then append or patch the rest), keeping each call well ' +
  'under about 8K tokens of arguments.';

function toolInputCutNotice() {
  return { role: 'user', content: TOOL_INPUT_CUT_NOTICE, meta: { source: 'stream-cut-recovery' } };
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
  emitProviderRetryStage(opts?.onStageChange, {
    attempt,
    maxAttempts,
    lastErr: error,
    delayMs: waitMs,
    classifier,
    extra: {
      wsCloseCode: error?.wsCloseCode ?? null,
      httpStatus: error?.httpStatus ?? error?.status ?? null,
    },
  });
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
async function retractExposedTextForReplay({ outcome, opts, relayWitness }) {
  if (outcome.terminalObserved === true) return false;
  if (outcome.sideEffectDispatched === true) return false;
  if (outcome.dispatchAmbiguous === true) return false;
  if (Number(outcome.toolCallsDispatched) > 0) return false;
  if (Number(outcome.toolCallsComplete) > 0) return false;
  if (relayWitness.toolCallsDispatched > 0) return false;
  // Exactly what THIS send put on screen. A provider's own count can miss it
  // (a socket error that carries no partial) or overshoot it (text buffered
  // but never relayed); retracting the wrong length would leave stale text or
  // cut into earlier output.
  const chars = relayWitness.text.length;
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
  const retract = () => retractExposedTextForReplay({ outcome, opts, relayWitness });
  if (isPromotableIncomplete(sendErr, outcome)) {
    return { action: 'proceed', response: promotedIncompleteResponse(sendErr, model, opts) };
  }
  const recoverableCalls = recoverableToolCalls(sendErr, outcome, relayWitness);
  if (isCompleteToolCallStall(sendErr, recoverableCalls)) {
    return recoverPartialToolCalls(sendErr, state, recoverableCalls, outcome);
  }
  if (isToolInputCut(sendErr)) {
    return recoverToolInputCut(sendErr, outcome, state, retract);
  }
  if (isUnretractableTextCut(sendErr, outcome, opts, relayWitness)) {
    return continueFromShownText(sendErr, state, relayWitness);
  }
  if (isExposedNoToolStall(sendErr, outcome)) {
    return recoverExposedStall(sendErr, outcome, state, retract);
  }
  // Clean transient transport failure with zero exposure: replay the send
  // after a bounded wait instead of failing the turn.
  if (
    transportRetriesUsed < retryBudgetFor(sendErr) &&
    !providerRecoveryEnded(sendErr, outcome) &&
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
    imageStripEligible(sendErr, outcome, {
      recoveryMessages,
      imageStripUsed,
      transportRetriesUsed,
      relayWitness,
      isGrok: (sessionRef?.provider || state.provider?.name) === 'grok-oauth',
    }) &&
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
async function scheduleTransportReplay(sendErr, state, { budget, note, trace, classifier, notice = null }) {
  const { opts, signal, transportRetriesUsed = 0 } = state;
  const attempt = transportRetriesUsed + 1;
  const waitMs = transportRetryWaitMs(transportRetriesUsed, sendErr);
  logLoop(`${note}; transport retry ${attempt}/${budget} after ${waitMs}ms`);
  const { kind, ...fields } = trace;
  traceLoop(state, kind, { attempt, waitMs, ...fields });
  emitLoopReconnectProgress(opts, { attempt, maxAttempts: budget, waitMs, classifier, error: sendErr });
  await sleepMs(waitMs, undefined, signal ? { signal } : undefined);
  return beginFreshTransportAttempt(opts, budget, notice);
}

// Text already on screen that the owner offers no way to withdraw (no
// retraction channel) is kept rather than lost with a failed turn: the cut
// response becomes a truncated turn that the output-limit ladder resumes with
// a network-cut notice (reference: a partial stream is resumed where it died).
// Tool work of any kind has its own paths above and stays out of this one.
function isUnretractableTextCut(sendErr, outcome, opts, relayWitness) {
  return (
    typeof opts?.onTextReset !== 'function' &&
    relayWitness.text.trim().length > 0 &&
    isStreamCut(sendErr) &&
    outcome.toolCallsStarted !== true &&
    outcome.sideEffectDispatched !== true &&
    Number(outcome.toolCallsComplete) === 0
  );
}

function continueFromShownText(sendErr, state, relayWitness) {
  const shown = relayWitness.text;
  logLoop(
    `[loop] stream cut after ${shown.length} visible chars with no retraction channel (${loopTag(state)}); continuing from the shown text`
  );
  traceLoop(state, 'stream_cut_continuation', { shownLen: shown.length });
  return {
    action: 'proceed',
    response: {
      content: shown,
      model: sendErr.partialModel || state.model,
      usage: sendErr.partialUsage || undefined,
      truncated: true,
      streamCut: true,
      providerState: state.opts?.providerState,
    },
  };
}

// A cut while a tool call's arguments were still streaming (isToolInputCut):
// replay with the split-call notice, retracting exposed text first. The notice
// changes the request, so this is not the same attempt repeated and a
// provider that already spent its ladder does not end it; the loop's own
// budget still bounds it.
async function recoverToolInputCut(sendErr, outcome, state, retract) {
  const { transportRetriesUsed = 0 } = state;
  const budget = retryBudgetFor(sendErr);
  if (transportRetriesUsed < budget && (outcome.replaySafe === true || (await retract()))) {
    return scheduleTransportReplay(sendErr, state, {
      budget,
      note: `[loop] stream cut while tool arguments were streaming (${loopTag(state)}); replaying with a split-call notice`,
      trace: { kind: 'tool_input_cut_retry' },
      classifier: 'tool_input_cut',
      notice: toolInputCutNotice(),
    });
  }
  throw sendErr;
}

// Partial tool-call recovery (agent-hang fix): a stream that ends AFTER
// fully-parsed tool calls were emitted used to lose the whole turn —
// unsafeToRetry blocks the mid-stream replay (correct: a replay would re-run
// side-effecting tools) and the loop gave up, discarding tool work that had
// ALREADY completed via eager dispatch. ANY non-terminal end qualifies, not
// just a watchdog stall: continuing is not replaying — the parsed calls
// resolve from the pending map without re-running, their results commit to
// history, and the NEXT request carries them forward. Half-streamed
// arguments are never a tool call: see recoverableToolCalls. Named
// TRANSPORT symptoms only: a typed refusal (context overflow, policy, quota)
// also arrives without a terminal frame, but nothing was generated there and
// continuing would paper over the refusal.
function isCompleteToolCallStall(sendErr, recoverableCalls) {
  return isStreamCut(sendErr) && recoverableCalls.length > 0;
}

// The calls a cut-off turn may continue with. An unresolved placeholder
// (`_pendingItemId`: its call id/name never arrived) is never one of them.
// When a tool input was still streaming at the cut, the turn continues only if
// every complete call was dispatched by this send: no transport dispatches
// half-streamed arguments, so the in-flight call is simply dropped unrun (the
// model can reissue it), and nothing committed references an undispatched
// call. The reference client likewise keeps finished items and drops the
// in-flight one when it retries a dropped stream.
function recoverableToolCalls(sendErr, outcome, relayWitness) {
  const calls = Array.isArray(sendErr.partialToolCalls)
    ? sendErr.partialToolCalls.filter((call) => call && !call._pendingItemId)
    : [];
  if (outcome.pendingToolInput !== true) return calls;
  const dispatched = calls.filter((call) => call.id && relayWitness.dispatchedToolCallIds.has(String(call.id)));
  return dispatched.length === calls.length ? dispatched : [];
}

// The recovered partial as a normal tool-call turn: eager-dispatched
// (read-only) calls resolve from the pending map without re-running,
// side-effecting calls were never started during streaming and execute
// exactly once. providerState stays undefined so the next iteration resends
// a full frame on a fresh stream.
function recoveredToolCallResponse(sendErr, model, toolCalls, outcome) {
  const partialProviderReplay = cloneProviderReplay(sendErr.partialProviderReplay);
  return {
    // A dropped in-flight call earns the same split-call notice, delivered
    // after this turn's tool results.
    ...(outcome.pendingToolInput === true ? { recoveryNotice: toolInputCutNotice() } : {}),
    content: typeof sendErr.partialContent === 'string' ? sendErr.partialContent : '',
    model: sendErr.partialModel || model,
    toolCalls: toolCalls.slice(),
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

function recoverPartialToolCalls(sendErr, state, toolCalls, outcome) {
  const droppedInput = outcome.pendingToolInput === true;
  logLoop(
    `[loop] stream ended after ${toolCalls.length} complete tool call(s) (${loopTag(state)}` +
      `${droppedInput ? '; incomplete tool input dropped' : ''}); recovering as tool-call turn instead of failing`
  );
  traceLoop(state, 'partial_tool_recovery', {
    toolCalls: toolCalls.length,
    droppedIncompleteInput: droppedInput,
    partialContentLen: typeof sendErr.partialContent === 'string' ? sendErr.partialContent.length : 0,
  });
  return { action: 'proceed', response: recoveredToolCallResponse(sendErr, state.model, toolCalls, outcome) };
}

// Zero-exposure transient failures replay outright. classifyError reports
// 'permanent' the moment anything was exposed, so an exposed disconnect
// could never reach the retraction path: name the transport symptoms
// directly — stall, truncated stream (anthropic
// message_start-without-message_stop, gemini/compat EOF), retryable wire /
// stream error events (response.failed server_error & co.), Cursor
// continuation streams that carry a typed transport code even when
// reasoning/text exposure makes classifyError() intentionally permanent,
// non-terminal close, or a dropped connection (undici `terminated`, socket
// reset) — then retract the exposed text and replay.
async function transportReplayPermitted(sendErr, outcome, retract) {
  if (outcome.replaySafe === true && classifyError(sendErr) === 'transient') return true;
  const transportSymptom =
    classifyError(sendErr) === 'transient' ||
    isStreamCut(sendErr) ||
    isRetryableWireErrorEvent(sendErr) ||
    isRetryableStreamErrorEvent(sendErr) ||
    isCursorTransientTransportError(sendErr);
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
  { recoveryMessages, imageStripUsed, transportRetriesUsed, relayWitness, isGrok }
) {
  return (
    transportRetriesUsed < TRANSPORT_RETRY_MAX &&
    (shouldStripImagesForRetry(sendErr, {
      hasImages: promptHasInlineImages(recoveryMessages),
      alreadyStripped: imageStripUsed === true,
    }) ||
      // Grok Build RetryWithImageStrip only: a bare stream error on a Grok
      // upload may be the image body being rejected. Other providers' transient
      // stream errors are not evidence about images and use normal transport retry.
      (isGrok &&
        imageStripUsed !== true &&
        promptHasInlineImages(recoveryMessages) &&
        isRetryableStreamErrorEvent(sendErr))) &&
    outcome.sideEffectDispatched !== true &&
    Number(outcome.toolCallsDispatched) === 0 &&
    Number(outcome.toolCallsComplete) === 0 &&
    relayWitness.toolCallsDispatched === 0
  );
}

function retryWithImageStrip(sendErr, recoveryMessages, state) {
  const { opts, transportRetriesUsed = 0 } = state;
  const stripped = isImagePreparationFailed(sendErr)
    ? stripFailingImage(recoveryMessages, sendErr)
    : stripInlineImagesFromLatestTurn(recoveryMessages);
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
    imageIds: stripped.imageIds,
    persist: persistsConfirmedImageRejection(sendErr, stripped),
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
