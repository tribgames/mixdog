// provider.send wrapper with stall/overflow recovery, extracted from
// agent-loop.mjs. Returns { action } so the loop keeps control of the
// while-loop: proceed carries the response, retry signals a reactive
// context-overflow compact retry (caller re-enters the pre-send compact
// pass), and unrecoverable errors throw. Behavior identical to the inline
// try/catch it replaced.
import { appendAgentTrace } from '../agent-trace.mjs';
import {
    classifyError,
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
import { setTimeout as sleepMs } from 'timers/promises';
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
    const directInputTokens = Number(raw.promptTokenCount ?? raw.prompt_token_count ?? raw.input_tokens ?? raw.prompt_tokens ?? 0) || 0;
    const candidateTokens = Number(raw.candidatesTokenCount ?? raw.candidates_token_count ?? 0) || 0;
    const thoughtTokens = Number(raw.thoughtsTokenCount ?? raw.thoughts_token_count ?? 0) || 0;
    const totalTokens = Number(raw.totalTokenCount ?? raw.total_token_count ?? 0) || 0;
    const hasExplicitGeminiPromptTokens = Object.prototype.hasOwnProperty.call(raw, 'promptTokenCount')
        || Object.prototype.hasOwnProperty.call(raw, 'prompt_token_count');
    const inputTokens = hasExplicitGeminiPromptTokens || directInputTokens > 0
        ? directInputTokens
        : Math.max(0, totalTokens - candidateTokens - thoughtTokens);
    const outputFallback = Number(raw.output_tokens ?? raw.completion_tokens ?? 0) || 0;
    const cachedTokens = Number(raw.cachedContentTokenCount ?? raw.cached_content_token_count ?? raw.cached_tokens ?? 0) || 0;
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
const TRANSPORT_RETRY_BACKOFF_MS = Object.freeze((() => {
    const raw = process.env.MIXDOG_TRANSPORT_RETRY_BACKOFF_MS;
    if (typeof raw === 'string' && raw.trim()) {
        const parsed = raw.split(',')
            .map((value) => Number(value.trim()))
            .filter((value) => Number.isFinite(value) && value >= 0);
        if (parsed.length) return parsed;
    }
    // Three steps (~50s of outage) instead of two: the provider envelope
    // already covers short blips, so this ladder exists for the long ones.
    // Comparable runtimes allow 5-10 retries for this outage class.
    return [5_000, 15_000, 30_000];
})());
export const TRANSPORT_RETRY_MAX = TRANSPORT_RETRY_BACKOFF_MS.length;

// Jittering every backoff by 0.9–1.1 keeps parallel workers that lose the
// same uplink do not resume in lockstep; our provider layers already jitter
// (10% WS / 20% shared), this brings the loop ladder in line.
const TRANSPORT_RETRY_JITTER_RATIO = 0.1;

function transportRetryWaitMs(attemptIndex) {
    const base = TRANSPORT_RETRY_BACKOFF_MS[attemptIndex];
    return jitterDelayMs(base, TRANSPORT_RETRY_JITTER_RATIO);
}

// Every loop-level replay is a NEW request, so it opens a new stall window.
// Inheriting the spent one aborted healthy replacement responses mid-flight.
function beginFreshTransportAttempt(opts) {
    resetStallRetryBudget(opts);
    return { action: 'retry_transport' };
}

export async function sendWithRecovery(ctx) {
    const {
        provider, messages, model, sendTools, tools, opts,
        recoveryMessages = messages,
        sessionId, sessionRef, nextIteration, contextOverflowRetryUsed,
        transportRetriesUsed = 0, imageStripUsed = false,
        thinkingReplayRepairUsed = false, signal,
    } = ctx;
    // Establishes the in-request stall window the provider layer shares through
    // opts. A fresh replay below resets it: the loop's own TRANSPORT_RETRY_MAX
    // is what bounds replays, not a window already spent detecting the stall.
    resolveStallRetryBudget(opts);
    let response;
    // Bench-only turn timing (MIXDOG_TURN_TIMING=1): one stderr line per
    // provider request — TTFT (first visible model progress) and total stream
    // time. Transport/header and response-created acknowledgements do not count.
    // Inert unless the env flag is set; used to profile harness vs model
    // latency in Terminal-Bench runs.
    const turnT0 = process.env.MIXDOG_TURN_TIMING === '1' ? Date.now() : 0;
    let turnFirstDelta = 0;
    let timedOpts = opts;
    if (turnT0) {
        const prevDelta = typeof opts?.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        timedOpts = {
            ...(opts || {}),
            onStreamDelta: (kind) => {
                if (!turnFirstDelta && isVisibleStreamProgress(kind)) turnFirstDelta = Date.now();
                if (prevDelta) prevDelta(kind);
            },
        };
    }
    const logTurnTiming = (status) => {
        if (!turnT0) return;
        const now = Date.now();
        const ttft = turnFirstDelta ? turnFirstDelta - turnT0 : -1;
        try {
            console.error(`[turn-timing] status=${status} ttft=${ttft}ms total=${now - turnT0}ms model=${model}`);
        } catch { /* logging must never break the send path */ }
    };
    // Loop-side exposure witness. Some providers throw truncation/stall
    // errors that carry only partialContent — neither liveTextEmitted nor
    // unsafeToRetry — so an outcome read from the ERROR alone can report
    // replaySafe even though this very send already relayed text to the
    // client through opts.onTextDelta, or dispatched a tool call through
    // opts.onToolCall. Replaying such a send would duplicate output the user
    // already saw (or re-run a side effect), so record what THIS send
    // actually exposed and merge it into every outcome read below. The
    // callbacks are wrapped in place and restored conditionally: the
    // overflow-retry branch intentionally clears opts.onToolCall, and that
    // clear must survive the restore.
    const relayWitness = { textEmitted: false, toolCallsDispatched: 0 };
    // Caller-visible reconnect progress for LOOP-level replays, mirroring the
    // transports' own emitReconnectProgress (openai-oauth-ws). Without it the
    // 5s/15s wait rendered as a frozen turn with no explanation, so the
    // stage change surfaces "Reconnecting... n/max" instead of leaving
    // the user staring at a stalled stream.
    const emitLoopReconnectProgress = (attempt, waitMs, classifier, error) => {
        try {
            opts?.onStageChange?.('reconnecting', {
                attempt,
                max: TRANSPORT_RETRY_MAX,
                classifier: classifier || null,
                waitMs,
                message: providerRetryStatusText(error, {
                    attempt,
                    maxAttempts: TRANSPORT_RETRY_MAX,
                    delayMs: waitMs,
                }),
            });
        } catch { /* progress reporting must never break recovery */ }
    };
    // Retry visibility (reference parity). codex surfaces EVERY stream retry to
    // the front-end ("Reconnecting... n/max") precisely so a replayed request
    // cannot read as ordinary thinking; gemini-cli requires an onRetry hook for
    // the same reason. Our loop emitted the reconnect stage only for the
    // backoff wait — the replayed send then reported plain
    // 'requesting'/'streaming' again, so three stalled retries rendered as ~20
    // minutes of a normal spinner with nothing to explain it. Hold the
    // reconnect stage across the whole replay until THIS attempt shows visible
    // progress.
    const retryAttemptNumber = Math.max(0, Number(transportRetriesUsed) || 0);
    const prevOnStageChange = typeof opts?.onStageChange === 'function' ? opts.onStageChange : null;
    const retryVisibilityActive = retryAttemptNumber > 0 && !!prevOnStageChange;
    let retryProgressObserved = !retryVisibilityActive;
    const retryAwareOnStageChange = retryVisibilityActive
        ? (stage, detail) => {
            if (!retryProgressObserved && (stage === 'requesting' || stage === 'streaming')) {
                return prevOnStageChange('reconnecting', {
                    ...(detail && typeof detail === 'object' ? detail : {}),
                    attempt: retryAttemptNumber,
                    max: TRANSPORT_RETRY_MAX,
                    message: `Reconnecting... ${retryAttemptNumber}/${TRANSPORT_RETRY_MAX}`,
                });
            }
            return prevOnStageChange(stage, detail);
        }
        : null;
    // The replacement stream's first visible delta ends the reconnect display:
    // from that point the turn is healthy and must read as a normal response.
    const prevOptsOnStreamDelta = typeof opts?.onStreamDelta === 'function' ? opts.onStreamDelta : null;
    const retryDeltaBase = timedOpts || opts;
    const prevOnStreamDeltaForRetry = typeof retryDeltaBase?.onStreamDelta === 'function'
        ? retryDeltaBase.onStreamDelta
        : null;
    const retryAwareOnStreamDelta = retryVisibilityActive
        ? (kind, ...rest) => {
            if (!retryProgressObserved && isVisibleStreamProgress(kind)) {
                retryProgressObserved = true;
                try { prevOnStageChange('streaming', { recoveredAfterRetry: retryAttemptNumber }); } catch { /* display-only */ }
            }
            return prevOnStreamDeltaForRetry?.(kind, ...rest);
        }
        : null;
    const prevOnTextDelta = typeof opts?.onTextDelta === 'function' ? opts.onTextDelta : null;
    const prevOnToolCall = typeof opts?.onToolCall === 'function' ? opts.onToolCall : null;
    const witnessedOnTextDelta = prevOnTextDelta
        ? (...args) => {
            if (typeof args[0] === 'string' && args[0].length > 0) relayWitness.textEmitted = true;
            return prevOnTextDelta(...args);
        }
        : null;
    const witnessedOnToolCall = prevOnToolCall
        ? (...args) => {
            relayWitness.toolCallsDispatched += 1;
            return prevOnToolCall(...args);
        }
        : null;
    if (opts) {
        if (witnessedOnTextDelta) opts.onTextDelta = witnessedOnTextDelta;
        if (witnessedOnToolCall) opts.onToolCall = witnessedOnToolCall;
        if (retryAwareOnStageChange) opts.onStageChange = retryAwareOnStageChange;
        if (retryAwareOnStreamDelta) opts.onStreamDelta = retryAwareOnStreamDelta;
    }
    if (timedOpts !== opts && timedOpts) {
        if (witnessedOnTextDelta) timedOpts.onTextDelta = witnessedOnTextDelta;
        if (witnessedOnToolCall) timedOpts.onToolCall = witnessedOnToolCall;
        if (retryAwareOnStageChange) timedOpts.onStageChange = retryAwareOnStageChange;
        if (retryAwareOnStreamDelta) timedOpts.onStreamDelta = retryAwareOnStreamDelta;
    }
    try {
        try {
            const admittedOpts = timedOpts?.admissionOwner
                ? timedOpts
                : { ...(timedOpts || {}), admissionOwner: sessionId };
            response = await provider.send(
                messages,
                model,
                sendTools.length ? sendTools : undefined,
                admittedOpts,
            );
            logTurnTiming('ok');
        } catch (sendErr) {
            logTurnTiming(`err:${sendErr?.code || sendErr?.name || 'unknown'}`);
            // Canonical stream outcome: ONE fail-closed read of what the
            // provider stream actually produced (terminal vs continuation,
            // observed text/reasoning, partial/complete/dispatched tool calls).
            // Every branch below consumes it instead of re-inferring safety
            // from provider-specific flags.
            const outcome = readStreamOutcome(sendErr, relayWitness);
            // Text-only exposure retraction (cross-provider): a stream that
            // died after relaying ONLY text — no dispatched or complete tool
            // calls, no terminal — is replayable IF the ask owner retracts the
            // exposed characters (onTextReset ack === true: the TUI truncates
            // its live tail, the bench driver truncates its accumulator).
            // This is the loop-level analogue of anthropic's
            // recoverNonStreaming for providers WITHOUT a non-streaming
            // fallback (gemini, openai-compat, openai WS) and for stalls that
            // outlived the provider's in-place recovery. Observed live:
            // make-mips-interpreter died with 31 exposed chars + a pending
            // never-dispatched tool input and burned the whole trial.
            const retractExposedTextForReplay = async () => {
                if (outcome.terminalObserved === true) return false;
                if (outcome.sideEffectDispatched === true) return false;
                if (outcome.dispatchAmbiguous === true) return false;
                if (Number(outcome.toolCallsDispatched) > 0) return false;
                if (Number(outcome.toolCallsComplete) > 0) return false;
                if (relayWitness.toolCallsDispatched > 0) return false;
                const chars = Math.max(0, Number(outcome.textObservedChars) || 0)
                    || (typeof sendErr.partialContent === 'string' ? sendErr.partialContent.length : 0);
                const reasoningOnly = outcome.reasoningEmitted === true && chars <= 0;
                if (chars <= 0 && !reasoningOnly) return false;
                if (typeof opts?.onTextReset === 'function') {
                    let acked = false;
                    try {
                        acked = await opts.onTextReset({
                            chars,
                            reasoning: outcome.reasoningEmitted === true,
                            reason: 'loop-transport-retraction',
                        }) === true;
                    } catch { acked = false; }
                    if (!acked && !reasoningOnly) return false;
                } else if (!reasoningOnly) {
                    return false;
                }
                relayWitness.textEmitted = false;
                return true;
            };
            // Gemini REST/SDK reports MAX_TOKENS by throwing a typed
            // ProviderIncompleteError after preserving the streamed candidate.
            // Normalize only that exact, safe no-tool output-limit shape into a
            // regular truncated response; all moderation/OTHER/tool-bearing and
            // unrelated errors continue through their existing error paths.
            if (
                sendErr?.providerIncomplete === true
                && sendErr.code === 'PROVIDER_INCOMPLETE'
                && isOutputLimitStopReason(sendErr.finishReason)
                && typeof sendErr.partialContent === 'string'
                && sendErr.partialContent.trim().length > 0
                // Terminal observed (explicit finish reason) and no tool
                // exposure at all: the only shape safe to promote to success.
                && outcome.successEligible === true
                && outcome.toolCallsStarted !== true
                && outcome.sideEffectDispatched !== true
            ) {
                const partialProviderReplay = cloneProviderReplay(sendErr.partialProviderReplay);
                response = {
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
                return { action: 'proceed', response };
            } else
            // Exhausted no-tool stall: NOT a success. A FINAL, no-tool stream
            // that wedges (ping-only) carries streamed assistant text on the
            // StreamStalledError, but the turn never completed — the model may
            // have been mid-sentence, and there is no completion signal that
            // says the work is done. Promoting it to a normal terminal response
            // silently reported truncated/aborted turns as finished. Keep it an
            // explicit failure (no completion signal means no completed turn,
            // and the partial is persisted): the already-streamed text
            // is preserved by the interruption/error persistence path
            // (turn-interruption.mjs records the deltas and commits them as the
            // partial assistant message alongside the error), so nothing visible
            // is lost while the caller/owner-notify still sees a failed turn.
            // A stall WITH complete parsed tool calls is a different, genuinely
            // recoverable case and is handled by the next branch.
            if (
                outcome.stallObserved === true
                && outcome.terminalObserved !== true
                && typeof sendErr.partialContent === 'string'
                && sendErr.partialContent.trim().length > 0
                && outcome.toolCallsComplete === 0
            ) {
                // Retractable shape: text-only exposure with the owner's
                // acknowledgement replays on a fresh request instead of
                // failing the turn. Non-acked (or tool-bearing) shapes keep
                // the explicit-failure contract below unchanged.
                // NOTE: no classifyError gate here — an exposed stall is
                // stamped unsafeToRetry, which the general classifier reads as
                // terminal, but that unsafety is exactly what the retraction
                // removes (observed live: make-mips-interpreter failed twice
                // because this guard demanded 'transient' and never fired).
                if (
                    transportRetriesUsed < TRANSPORT_RETRY_MAX
                    && !isProviderRecoveryExhausted(sendErr)
                    && await retractExposedTextForReplay()
                ) {
                    const waitMs = transportRetryWaitMs(transportRetriesUsed);
                    try {
                        process.stderr.write(
                            `[loop] exposed-text stall retracted (sess=${sessionId || 'unknown'} `
                            + `iter=${nextIteration} len=${sendErr.partialContent.length}); `
                            + `transport retry ${transportRetriesUsed + 1}/${TRANSPORT_RETRY_MAX} after ${waitMs}ms\n`,
                        );
                    } catch { /* best-effort */ }
                    try {
                        appendAgentTrace({
                            kind: 'exposed_text_retraction_retry',
                            sessionId: sessionId || null,
                            iteration: nextIteration,
                            attempt: transportRetriesUsed + 1,
                            waitMs,
                            partialContentLen: sendErr.partialContent.length,
                        });
                    } catch { /* best-effort */ }
                    emitLoopReconnectProgress(
                        transportRetriesUsed + 1,
                        waitMs,
                        outcome.stallObserved ? 'stream_stalled' : 'stream_closed',
                        sendErr,
                    );
                    await sleepMs(waitMs, undefined, signal ? { signal } : undefined);
                    return beginFreshTransportAttempt(opts);
                }
                try {
                    process.stderr.write(
                        `[loop] final stream stalled with partial text (sess=${sessionId || 'unknown'} `
                        + `iter=${nextIteration} len=${sendErr.partialContent.length}); `
                        + `failing the turn (partial preserved via interrupted-turn persistence)\n`,
                    );
                } catch { /* best-effort */ }
                try {
                    appendAgentTrace({
                        kind: 'stall_partial_final_rejected',
                        sessionId: sessionId || null,
                        iteration: nextIteration,
                        partialContentLen: sendErr.partialContent.length,
                        pendingToolUse: outcome.pendingToolInput,
                        emittedToolCall: outcome.sideEffectDispatched,
                        terminalObserved: outcome.terminalObserved,
                    });
                } catch { /* best-effort */ }
                throw sendErr;
            } else
            // Partial tool-call recovery (agent-hang fix): a stream that stalls
            // AFTER fully-parsed tool calls were emitted used to lose the whole
            // turn — unsafeToRetry blocks the mid-stream replay (correct: a
            // replay would re-run side-effecting tools) and the old code threw,
            // discarding tool work that had ALREADY completed via eager dispatch.
            // But the parsed calls are complete (pendingToolUse false ⇒ no
            // half-streamed tool input), so instead of replaying the request we
            // accept the partial as a normal tool-call turn and fall through to
            // the standard execution path: eager-dispatched (read-only) calls
            // resolve from the pending map without re-running, side-effecting
            // calls were never started during streaming and execute exactly
            // once. providerState stays undefined so the next iteration resends
            // a full frame on a fresh stream.
            if (
                outcome.stallObserved === true
                && outcome.pendingToolInput !== true
                && outcome.toolCallsComplete > 0
                && Array.isArray(sendErr.partialToolCalls)
                && sendErr.partialToolCalls.length > 0
            ) {
                try {
                    process.stderr.write(
                        `[loop] stream stalled after ${sendErr.partialToolCalls.length} complete tool call(s) `
                        + `(sess=${sessionId || 'unknown'} iter=${nextIteration}); `
                        + `recovering as tool-call turn instead of failing\n`,
                    );
                } catch { /* best-effort */ }
                try {
                    appendAgentTrace({
                        kind: 'stall_tool_recovery',
                        sessionId: sessionId || null,
                        iteration: nextIteration,
                        toolCalls: sendErr.partialToolCalls.length,
                        partialContentLen: typeof sendErr.partialContent === 'string' ? sendErr.partialContent.length : 0,
                    });
                } catch { /* best-effort */ }
                const partialProviderReplay = cloneProviderReplay(sendErr.partialProviderReplay);
                response = {
                    content: typeof sendErr.partialContent === 'string' ? sendErr.partialContent : '',
                    model: sendErr.partialModel || model,
                    toolCalls: sendErr.partialToolCalls.slice(),
                    usage: sendErr.partialUsage || undefined,
                    stopReason: 'tool_use',
                    hasThinkingContent: sendErr.partialHasThinking === true,
                    // Ordered provider block state captured before the stall.
                    // Anthropic REQUIRES the verbatim thinking blocks (with
                    // their signatures) back ahead of tool_use on the
                    // continuation turn, and a native `server_tool_use` call is
                    // only valid immediately followed by its result block — so
                    // the recovered tool turn must replay exactly what a
                    // successful turn would have returned. The loop's committer
                    // already drops the redundant `thinkingBlocks` copy when
                    // `assistantBlocks` is present (which contains them
                    // verbatim), so blocks are neither lost nor doubled.
                    ...(Array.isArray(sendErr.partialThinkingBlocks) && sendErr.partialThinkingBlocks.length
                        ? { thinkingBlocks: sendErr.partialThinkingBlocks }
                        : {}),
                    ...(Array.isArray(sendErr.partialAssistantBlocks) && sendErr.partialAssistantBlocks.length
                        ? { assistantBlocks: sendErr.partialAssistantBlocks }
                        : {}),
                    ...(partialProviderReplay
                        ? { providerReplay: partialProviderReplay }
                        : {}),
                    providerMetadata: sendErr.providerMetadata,
                    partialToolRecovery: true,
                };
                return { action: 'proceed', response };
            } else
            // Clean transient transport failure with zero exposure: replay the
            // send after a bounded wait instead of failing the turn.
            if (
                transportRetriesUsed < TRANSPORT_RETRY_MAX
                && !isProviderRecoveryExhausted(sendErr)
                && (
                    (outcome.replaySafe === true && classifyError(sendErr) === 'transient')
                    || (
                        // classifyError reports 'permanent' the moment anything
                        // was exposed, so an exposed disconnect could never
                        // reach the retraction path: name the transport
                        // symptoms directly (stall OR non-terminal close).
                        (classifyError(sendErr) === 'transient'
                            || outcome.stallObserved === true
                            // Same inversion for the truncated-stream class
                            // (anthropic message_start-without-message_stop,
                            // gemini/compat EOF): classifyError calls it
                            // 'transient' only while nothing was exposed.
                            || outcome.truncatedStream === true
                            // And for retryable wire error events
                            // (response.failed server_error & co.): exposed
                            // text is retracted, then the send is replayed.
                            || isRetryableWireErrorEvent(sendErr)
                            || isRetryableStreamErrorEvent(sendErr)
                            // Cursor continuation streams carry a typed
                            // transport code even when reasoning/text exposure
                            // makes classifyError() intentionally permanent.
                            || isCursorTransientTransportError(sendErr)
                            || isNonTerminalStreamClose(sendErr))
                        && await retractExposedTextForReplay()
                    )
                )
            ) {
                const waitMs = transportRetryWaitMs(transportRetriesUsed);
                try {
                    process.stderr.write(
                        `[loop] transient send failure with no observed output (sess=${sessionId || 'unknown'} `
                        + `iter=${nextIteration} code=${sendErr?.code ?? sendErr?.status ?? 'n/a'}); `
                        + `transport retry ${transportRetriesUsed + 1}/${TRANSPORT_RETRY_MAX} after ${waitMs}ms\n`,
                    );
                } catch { /* best-effort */ }
                try {
                    appendAgentTrace({
                        kind: 'transport_retry',
                        sessionId: sessionId || null,
                        iteration: nextIteration,
                        attempt: transportRetriesUsed + 1,
                        waitMs,
                        code: sendErr?.code ?? null,
                        status: sendErr?.status ?? null,
                    });
                } catch { /* best-effort */ }
                emitLoopReconnectProgress(
                    transportRetriesUsed + 1,
                    waitMs,
                    sendErr?.retryClassifier || sendErr?.midstreamClassifier || sendErr?.code || null,
                    sendErr,
                );
                await sleepMs(waitMs, undefined, signal ? { signal } : undefined);
                return beginFreshTransportAttempt(opts);
            } else
            // Anthropic replay-shape refusal: the latest assistant turn carries
            // thinking blocks the API will not accept back (a thinking run it
            // did not produce, or an empty text block). This is deterministic —
            // the same body fails forever and the turn is already persisted, so
            // without this repair the session is dead. Drop that turn's
            // reasoning replay in place (its text and tool calls stay) and
            // replay once. No exposure guard: the request was rejected at
            // validation, before any generation.
            if (
                thinkingReplayRepairUsed !== true
                && isThinkingReplayRejection(sendErr)
                && canRepairThinkingReplay(recoveryMessages)
            ) {
                const repairedIndex = repairThinkingReplayInPlace(recoveryMessages);
                try {
                    process.stderr.write(
                        `[loop] thinking-replay repair (sess=${sessionId || 'unknown'} `
                        + `iter=${nextIteration} message=${repairedIndex}); `
                        + 'dropped the rejected reasoning replay and replaying once\n',
                    );
                } catch { /* best-effort */ }
                try {
                    appendAgentTrace({
                        kind: 'thinking_replay_repair',
                        sessionId: sessionId || null,
                        iteration: nextIteration,
                        messageIndex: repairedIndex,
                    });
                } catch { /* best-effort */ }
                return { action: 'retry_replay_repair' };
            } else
            // Grok Build RetryWithImageStrip: drop inline images and replay
            // once. Safe only when no tool was dispatched. Text exposure must
            // be retracted first; reasoning-only high-effort streams can retry
            // without a text reset.
            if (
                transportRetriesUsed < TRANSPORT_RETRY_MAX
                && (
                    shouldStripImagesForRetry(sendErr, {
                        hasImages: promptHasInlineImages(recoveryMessages),
                        alreadyStripped: imageStripUsed === true,
                    })
                    || (
                        imageStripUsed !== true
                        && promptHasInlineImages(recoveryMessages)
                        && isRetryableStreamErrorEvent(sendErr)
                    )
                )
                && outcome.sideEffectDispatched !== true
                && Number(outcome.toolCallsDispatched) === 0
                && Number(outcome.toolCallsComplete) === 0
                && relayWitness.toolCallsDispatched === 0
                && (outcome.replaySafe === true || await retractExposedTextForReplay())
            ) {
                const stripped = stripInlineImagesFromLatestTurn(recoveryMessages);
                if (stripped.stripped > 0) {
                    try {
                        process.stderr.write(
                            '[loop] image-strip retry (sess=' + String(sessionId || 'unknown')
                            + ' iter=' + String(nextIteration)
                            + ' stripped=' + String(stripped.stripped)
                            + '); transport retry ' + String(transportRetriesUsed + 1)
                            + '/' + String(TRANSPORT_RETRY_MAX) + '\n',
                        );
                    } catch { /* best-effort */ }
                    try {
                        appendAgentTrace({
                            kind: 'image_strip_retry',
                            sessionId: sessionId || null,
                            iteration: nextIteration,
                            attempt: transportRetriesUsed + 1,
                            stripped: stripped.stripped,
                        });
                    } catch { /* best-effort */ }
                    emitLoopReconnectProgress(
                        transportRetriesUsed + 1,
                        0,
                        'image_strip',
                    );
                    return {
                        action: 'retry_image_strip',
                        messages: stripped.messages,
                        persistMessages: persistenceMessagesForConfirmedImageRejection(
                            sendErr,
                            recoveryMessages,
                        ),
                    };
                }
            } else
            // Context-window-exceeded is a deterministic refusal from the API.
            // Recover context overflow reactively by compacting and retrying
            // in the same active turn. MixDog's proactive estimator can miss a
            // provider-specific overhead spike, so do one reactive retry by
            // marking the live session over-threshold and looping back through
            // the normal pre-send auto-compact path. If compaction/retry still
            // fails, surface the overflow normally.
            if (
                !isContextOverflowError(sendErr)
                || !(sessionRef && typeof sessionRef.contextWindow === 'number')
            ) {
                throw sendErr;
            }
            const compactPolicyForRetry = resolveWorkerCompactPolicy(sessionRef, sendTools.length ? sendTools : tools);
            // The reactive retry RE-SENDS the turn, so it is a replay: denied
            // once visible text/reasoning was relayed or a tool call was
            // dispatched (or ambiguously dispatched). A deterministic overflow
            // refusal that exposed nothing may compact and re-send.
            const replayPermitted = outcome.replaySafe === true;
            if (!contextOverflowRetryUsed && compactPolicyForRetry?.auto && replayPermitted) {
                // Mark the next pre-send compact as REACTIVE (driven by a
                // provider overflow refusal) rather than the normal proactive
                // pressure trigger, so the compact event/telemetry the loop
                // emits on the retry is distinguishable downstream.
                opts.onToolCall = undefined;
                try {
                    process.stderr.write(
                        `[loop] context overflow on send (sess=${sessionId || 'unknown'} iter=${nextIteration}); ` +
                        `reactive compact retry messages=${messages.length}\n`,
                    );
                } catch { /* best-effort */ }
                return { action: 'retry' };
            }
            try {
                process.stderr.write(
                    `[loop] context overflow on send (sess=${sessionId || 'unknown'} iter=${nextIteration}); ` +
                    `surfacing overflow (retryUsed=${contextOverflowRetryUsed === true} ` +
                    `replaySafe=${outcome.replaySafe === true} replayUnsafe=${outcome.replayUnsafe === true}) ` +
                    `messages=${messages.length}\n`,
                );
            } catch { /* best-effort */ }
            throw agentContextOverflowError({
                stage: 'send',
                sessionId,
                sessionRef,
                model,
                budgetTokens: sessionRef.contextWindow,
                reserveTokens: compactPolicyForRetry?.reserveTokens,
                messageTokensEst: estimateMessagesTokensSafe(messages),
            }, sendErr);
        }
    } finally {
        // Conditional restore: only unwind our own wrappers. An intentional
        // opts.onToolCall = undefined (overflow-retry branch) stays cleared.
        if (opts) {
            if (witnessedOnTextDelta && opts.onTextDelta === witnessedOnTextDelta) opts.onTextDelta = prevOnTextDelta;
            if (witnessedOnToolCall && opts.onToolCall === witnessedOnToolCall) opts.onToolCall = prevOnToolCall;
            if (retryAwareOnStageChange && opts.onStageChange === retryAwareOnStageChange) {
                opts.onStageChange = prevOnStageChange;
            }
            if (retryAwareOnStreamDelta && opts.onStreamDelta === retryAwareOnStreamDelta) {
                opts.onStreamDelta = prevOptsOnStreamDelta;
            }
        }
        if (timedOpts && timedOpts !== opts) {
            if (retryAwareOnStageChange && timedOpts.onStageChange === retryAwareOnStageChange) {
                timedOpts.onStageChange = prevOnStageChange;
            }
            if (retryAwareOnStreamDelta && timedOpts.onStreamDelta === retryAwareOnStreamDelta) {
                timedOpts.onStreamDelta = prevOnStreamDeltaForRetry;
            }
        }
    }
    return { action: 'proceed', response };
}
