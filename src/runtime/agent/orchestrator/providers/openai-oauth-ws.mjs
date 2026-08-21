/**
 * OpenAI OAuth subscription — WebSocket transport.
 *
 * Single dispatch path for the openai-oauth provider (SSE removed in
 * v0.6.117). Uses the `responses_websockets=2026-02-06` beta WebSocket
 * upgrade on chatgpt.com/backend-api/codex/responses. Per-session
 * connections are pooled (configurable idle TTL, up to 8 parallel sockets per
 * key) so subsequent tool-loop iterations can send only the incremental
 * `input` delta plus `previous_response_id`, skipping the full
 * tools/system/history prefix each turn.
 *
 * Incremental-input reuse is decided by diffing against the cached request
 * the socket last sent (see _sansInput below), and requests carry a
 * turn-state echo header so the backend can correlate WS frames to the
 * in-flight turn.
 *
 * Exposes:
 *   sendViaWebSocket({ auth, body, sendOpts, onStreamDelta, onToolCall,
 *                      onStageChange, externalSignal, poolKey, cacheKey, iteration,
 *                      useModel, traceCtx })
 *
 * The caller (openai-oauth.mjs) supplies a fully built request body and the
 * auth bundle; this module handles connection caching, delta framing, event
 * parsing, and tracing.
 */
import { createHash } from 'crypto';
import { performance } from 'node:perf_hooks';
import {
    traceAgentFetch,
    traceAgentSse,
    traceAgentUsage,
    grokCacheChainTraceFields,
    appendAgentTrace,
} from '../agent-trace.mjs';
import {
    classifyHandshakeError,
    classifyMidstreamError,
    createStreamSafetyStamps,
    createStallRetryBudget,
    jitterDelayMs,
    MIDSTREAM_RETRY_POLICY,
    sleepWithAbort,
    STREAM_STALL_RETRY_BUDGET_MS,
    shouldDropPreviousResponseId,
} from './retry-classifier.mjs';
import { stampStreamOutcome, STREAM_TRANSPORTS } from './lib/stream-outcome.mjs';
import {
    WS_IDLE_MS,
    acquireWebSocket,
    releaseWebSocket,
    _sendFrame,
    _closeAllPooledSockets,
    drainOpenaiWsPool,
} from './openai-ws-pool.mjs';
import {
    WS_PRE_RESPONSE_CREATED_MS,
    WS_INTER_CHUNK_MS,
    _sansInput,
    _stableStringify,
    _cloneJson,
    _estimateFrameTokens,
    _combineUsageWithWarmup,
    _computeDelta,
    _logicalResponseItemMatch,
    parseToolSearchArgs,
    _streamResponse,
} from './openai-ws-stream.mjs';
import { _buildResponseCreateFrame } from './openai-ws-delta.mjs';
import { resolveOpenAiTransportPolicy } from './openai-transport-policy.mjs';
import { envPositiveInt } from './lib/env-utils.mjs';

// Legacy import paths for scripts/tool-smoke.mjs, mixdog-session-runtime.mjs
// (drainOpenaiWsPool), scripts/provider-toolcall-test.mjs (parseToolSearchArgs,
// _logicalResponseItemMatch, _streamResponse) and other external callers.
export {
    _closeAllPooledSockets,
    drainOpenaiWsPool,
    _logicalResponseItemMatch,
    parseToolSearchArgs,
    _streamResponse,
    _cacheObservation as _cacheObservationForTest,
    _cacheContinuityResetReason as _cacheContinuityResetReasonForTest,
    _warmupContinuityTrace as _warmupContinuityTraceForTest,
};

globalThis.__mixdogOpenaiWsRuntimeLoaded = true;

// The official Codex Responses policy has one five-retry stream budget shared
// by connect/handshake and pre-output stream failures.
const MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT = MIDSTREAM_RETRY_POLICY.ws.transientCloseRetries;
const MIDSTREAM_DEFAULT_RETRY_LIMIT = MIDSTREAM_RETRY_POLICY.ws.defaultRetries;
// The reference client uses a 200ms base, factor 2, and symmetric ±10%
// jitter for each of its five stream retries.
const MIDSTREAM_BACKOFF_MS = Object.freeze([200, 400, 800, 1600, 3200]);
const CODEX_RETRY_JITTER_RATIO = 0.1;
// Policy object passed to the shared classifyMidstreamError for the WS path.
const WS_MIDSTREAM_POLICY = {
    mode: 'ws',
    transientCloseRetries: MIDSTREAM_RETRY_POLICY.ws.transientCloseRetries,
    defaultRetries: MIDSTREAM_RETRY_POLICY.ws.defaultRetries,
};

// Kept for the exported _acquireWithRetry test seam and non-Codex callers.
// sendViaWebSocket deliberately invokes it with maxAttempts:1 so handshake
// failures consume the same stream budget as pre-output disconnects.
const HANDSHAKE_MAX_ATTEMPTS = MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT + 1;
const HANDSHAKE_BACKOFF_BASE_MS = 200;
const HANDSHAKE_BACKOFF_CAP_MS = 3200;
// These statuses are decisions made by the CURRENT attempt. They must never
// be replaced by a stale transient from an earlier retry: auth recovery,
// transport fallback, and Retry-After handling all depend on the live error.
const CURRENT_ATTEMPT_DECISION_STATUSES = new Set([401, 403, 426, 429]);

function _mustSurfaceCurrentAttempt(err, externalSignal) {
    return CURRENT_ATTEMPT_DECISION_STATUSES.has(Number(err?.httpStatus || 0))
        || externalSignal?.aborted
        || err?.unsafeToRetry === true;
}

function _classifyHandshakeError(err, { retry429 = true } = {}) {
    return classifyHandshakeError(err, { retry429 });
}

/**
 * Classify a mid-stream error for bounded retry eligibility.
 *
 * Only fires AFTER `response.created` is observed and BEFORE
 * `response.completed`. The window is narrow on purpose: retrying a handshake
 * or a pre-create connect failure is owned by _acquireWithRetry; retrying
 * after completion would replay a finished turn.
 *
 * Retry buckets:
 *   'agent_stall'        — AgentStallAbortError from agent stall watchdog
 *   'stream_stalled'     — StreamStalledAbortError from stream-watchdog
 *   'ws_1006'            — abnormal close (connection lost)
 *   'ws_1011'            — server unexpected condition
 *   'ws_1012'            — service restart
 *   'ws_4000'            — our armPreStreamWatchdog close with idle_timeout
 *   'ws_1000'            — server-side normal close fired after response.created
 *                          but before response.completed (truncated stream)
 *   'first_byte_timeout' — post-upgrade-no-first-event: socket opened, our
 *                          response.create frame sent, but the server never
 *                          emitted response.created within the short
 *                          pre-stream deadline. Fast-fail retryable.
 *   'response_failed_network'       — response.failed with network_error
 *   'response_failed_disconnected'  — response.failed with stream_disconnected
 *
 * Deny buckets (return null):
 *   - externalSignal aborted by user (state.userAbort)
 *   - state.sawCompleted === true (already done)
 *   - state.sawResponseCreated === false (still pre-stream; handshake retry
 *     owns that window) — EXCEPT for WS close 1011/1012, which can fire
 *     after the 101 upgrade but before the first response.created event,
 *     AND the pre-`response.created` first-byte timeout
 *     (state.firstByteTimeout), which is permitted a bounded retry here
 *   - HTTP 401 / 403 / 429 surfaced after the WS handshake
 *   - state.attemptIndex has reached the classifier-specific retry budget
 */
// Thin wrapper: the full WS mid-stream decision tree now lives in the shared
// classifyMidstreamError (retry-classifier.mjs, policy.mode='ws'). Kept as a
// named export so internal call sites and any external importer keep resolving
// the same symbol. The per-classifier gates both use the official five-retry
// stream budget.
export function _classifyMidstreamError(err, state) {
    return classifyMidstreamError(err, state, WS_MIDSTREAM_POLICY);
}

// Per-classifier retry budget, used by the sendViaWebSocket loop to bound the
// attempt count once classifyMidstreamError returns a bucket. Mirrors the
// shared _midstreamLimitFor(ws) — both values are the same unified budget.
function _midstreamRetryLimit(classifier) {
    return classifier === 'ws_1006' || classifier === 'ws_1011'
        ? MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT
        : MIDSTREAM_DEFAULT_RETRY_LIMIT;
}

function _midstreamBackoffFor(retryNumber) {
    const raw = MIDSTREAM_BACKOFF_MS[Math.min(Math.max(retryNumber, 1), MIDSTREAM_BACKOFF_MS.length) - 1];
    return jitterDelayMs(raw, CODEX_RETRY_JITTER_RATIO);
}

function _backoffFor(attempt) {
    // attempt is 1-based. retry 1 → 500, retry 2 → 1000, retry 3 → 2000 … capped.
    const raw = HANDSHAKE_BACKOFF_BASE_MS * (1 << (attempt - 1));
    return jitterDelayMs(Math.min(raw, HANDSHAKE_BACKOFF_CAP_MS), CODEX_RETRY_JITTER_RATIO);
}

const _defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Abort-aware backoff sleep → shared sleepWithAbort (retry-classifier.mjs). The
// abortMessage preserves the prior fallback text when the abort reason is not an
// Error; _sleepFn (test seam) is threaded through as the no-signal sleep impl.
function _sleepWithAbort(ms, externalSignal, sleepFn = _defaultSleep) {
    return sleepWithAbort(ms, externalSignal, sleepFn, 'OpenAI OAuth WS retry backoff aborted');
}

function _num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function _envRatio(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

// Codex client metadata (identity block, handshake headers, per-turn
// turn-state guard) lives in openai-codex-metadata.mjs.
import {
    _codexWsCompatibilityHeaders,
    _hashText,
    _metadataTrace,
    _withCodexWsClientMetadata,
} from './openai-codex-metadata.mjs';

function _cacheObservation({ entry, result, continuityResetReason = null }) {
    const inputTokens = _num(result?.usage?.inputTokens, 0);
    const promptTokens = _num(result?.usage?.promptTokens, 0) || inputTokens;
    const cachedTokens = _num(result?.usage?.cachedTokens, 0);
    const previousMaxCached = _num(entry?.promptCacheMaxCachedTokens, 0);
    const warmThreshold = envPositiveInt('MIXDOG_OAI_CACHE_MISS_WARM_TOKENS', 2048);
    const promptThreshold = envPositiveInt('MIXDOG_OAI_CACHE_MISS_PROMPT_TOKENS', 4096);
    const dropRatio = _envRatio('MIXDOG_OAI_CACHE_MISS_DROP_RATIO', 0.6);
    const dropThreshold = Math.floor(previousMaxCached * dropRatio);
    // A full-frame chain break (most commonly compaction/input-prefix rewrite)
    // starts a new prompt shape. Comparing its small new prompt against the
    // old shape's lifetime high-water creates a "cache drop" on every following
    // iteration until the new transcript grows past 60% of the old one.
    const wasWarm = !continuityResetReason && previousMaxCached >= warmThreshold;
    const cacheRatio = promptTokens > 0 ? cachedTokens / promptTokens : null;
    const zeroMiss = wasWarm && promptTokens >= promptThreshold && cachedTokens === 0;
    const partialDrop = wasWarm
        && promptTokens >= promptThreshold
        && cachedTokens > 0
        && previousMaxCached > 0
        && cachedTokens < dropThreshold;
    const actualMiss = zeroMiss || partialDrop;
    return {
        inputTokens,
        promptTokens,
        cachedTokens,
        uncachedTokens: Math.max(0, promptTokens - cachedTokens),
        previousMaxCached,
        wasWarm,
        warmThreshold,
        promptThreshold,
        dropRatio,
        dropThreshold,
        cacheRatio,
        actualMiss,
        continuityResetReason,
        missReason: zeroMiss
            ? 'warm_session_zero_cached_tokens'
            : partialDrop
                ? 'warm_session_cached_tokens_dropped'
                : null,
    };
}

function _requestInputExtends(previousInput, currentInput) {
    if (!Array.isArray(previousInput) || !Array.isArray(currentInput)) return false;
    if (currentInput.length < previousInput.length) return false;
    return previousInput.every(
        (item, index) => _stableStringify(item) === _stableStringify(currentInput[index]),
    );
}

function _cacheContinuityResetReason({ mode, deltaReason, entry, body, traceProvider }) {
    if (mode === 'delta') return null;
    if (deltaReason && !['no_anchor', 'full_forced', 'full_default'].includes(deltaReason)) {
        return deltaReason;
    }
    // ws-full bypasses _computeDelta's structural comparisons and reports only
    // full_default. Re-run the two cheap snapshot checks so compaction or any
    // other prompt rewrite still retires the old prompt's cache high-water.
    if (deltaReason !== 'full_default' || !entry?.lastResponseId) return null;
    const currentSansInput = _stableStringify(_sansInput(body, {
        normalizeWarmupGenerate: traceProvider === 'openai-oauth',
    }));
    if (entry.lastRequestSansInput && currentSansInput !== entry.lastRequestSansInput) {
        return 'request_properties_changed';
    }
    if (Array.isArray(entry.lastRequestInput)
        && !_requestInputExtends(entry.lastRequestInput, Array.isArray(body?.input) ? body.input : [])) {
        return 'input_prefix_mismatch';
    }
    return null;
}

// Warmup→first-real continuity trace (Codex prewarm_websocket parity
// observability). Pure/deterministic so it unit-tests without a live socket.
// The R23 finding forbids the post-warmup request rewrite, so parity is
// asserted via metrics instead of behavior: does the warmup's response_id
// become the anchor the FIRST real request chains from, and what is the
// hit/miss outcome of the first up-to-3 real requests on the socket.
function _warmupContinuityTrace({
    warmupUsed,
    warmupResponseId,
    priorEntryResponseId,
    sentPrevResponseId,
    earlyCacheMisses,
} = {}) {
    const misses = Array.isArray(earlyCacheMisses) ? earlyCacheMisses.slice(0, 3) : [];
    // The first real request is a full frame (no prev_id, per R23), so its
    // anchor is what the entry held at build time — which the warmup wrote.
    const firstRealPrevId = sentPrevResponseId || priorEntryResponseId || null;
    return {
        warmup_first_real_prev_id: firstRealPrevId,
        warmup_chain_continuous: !!warmupUsed
            && !!warmupResponseId
            && firstRealPrevId === warmupResponseId,
        early_cache_misses: misses,
        early_cache_miss_count: misses.filter(Boolean).length,
    };
}

/**
 * Run `_acquire({auth, poolKey, cacheKey})` with bounded exponential-backoff
 * retry on transient handshake failures. The injection seams (`_acquire`,
 * `_sleepFn`, `onRetry`) let unit tests drive the state machine without
 * opening real sockets.
 *
 * On exhaustion the thrown error is tagged with:
 *   err.attempts         — 1..HANDSHAKE_MAX_ATTEMPTS
 *   err.retryClassifier  — final classifier string, or null for permanent
 */
/**
 * Recovery-only encrypted-reasoning replay policy (codex full-frame parity).
 *
 * The request body may carry retained `reasoning` items
 * (opts.replayEncryptedReasoning; default ON for openai-oauth, kill switch
 * MIXDOG_OAI_DISABLE_REASONING_REPLAY=1).
 * Whether they actually go on the wire is decided PER SOCKET ENTRY, once, at
 * the first frame that entry sends, and stays sticky for its lifetime so the
 * append-only prefix bookkeeping (entry.lastRequestInput) never mixes
 * conventions:
 *
 *  - fresh entry + reasoning items present  → mid-session reconnect/recovery:
 *    KEEP them. This is the codex behavior on a broken delta chain — the full
 *    frame replays retained reasoning so the model does not re-reason the
 *    whole transcript (client.rs full-request path).
 *  - fresh entry + no reasoning items       → virgin session: nothing to
 *    replay; the chain locks to today's wire (subsequent frames strip).
 *  - entry with prior chain state (pooled reuse / completed warmup) → STRIP:
 *    re-sending an rs_* item a live server chain already saw is rejected as a
 *    duplicate.
 *
 * `suppress` (rejection safety net) forces the strip convention for the rest
 * of the send. Returns the body unchanged when nothing needs stripping.
 */
export function _applyReasoningReplayPolicy(entry, body, { suppress = false } = {}) {
    const input = Array.isArray(body?.input) ? body.input : null;
    if (!entry || !input) return body;
    const hasReasoning = input.some((item) => item?.type === 'reasoning');
    if (suppress) {
        entry.replayReasoning = false;
    } else if (entry.replayReasoning == null) {
        entry.replayReasoning = hasReasoning
            && entry.lastResponseId == null
            && entry.lastRequestInput == null;
    }
    if (!hasReasoning || entry.replayReasoning === true) return body;
    return { ...body, input: input.filter((item) => item?.type !== 'reasoning') };
}

/**
 * Server rejection of a replayed reasoning item (duplicate rs_* inside a
 * stateful chain). Deliberately narrow: generic transport/5xx errors must not
 * trip the replay-suppression retry.
 */
export function _isReasoningReplayRejection(err) {
    const msg = String(err?.payload?.message || err?.message || '');
    if (!msg) return false;
    if (/\brs_[A-Za-z0-9]/i.test(msg) && /duplicate|already|exists|repeated/i.test(msg)) return true;
    return /reasoning/i.test(msg) && /duplicate|already exists|repeated|invalid item/i.test(msg);
}

export async function _acquireWithRetry({
    auth,
    poolKey,
    cacheKey,
    codexHeaders,
    forceFresh,
    onRetry,
    onBackoffSlept,
    externalSignal,
    _acquire = acquireWebSocket,
    _sleepFn = _defaultSleep,
    maxAttempts = HANDSHAKE_MAX_ATTEMPTS,
    retry429 = true,
} = {}) {
    let lastErr = null;
    let lastClassifier = null;
    const attemptCap = Number.isFinite(maxAttempts) && maxAttempts > 0
        ? Math.min(maxAttempts, HANDSHAKE_MAX_ATTEMPTS)
        : HANDSHAKE_MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= attemptCap; attempt++) {
        if (externalSignal?.aborted) {
            const reason = externalSignal.reason;
            throw reason instanceof Error ? reason : new Error('OpenAI OAuth WS acquire aborted');
        }
        try {
            if (attempt > 1) {
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-handshake-attempt n=${attempt}\n`);
                }
            }
            return await _acquire({ auth, poolKey, cacheKey, codexHeaders, forceFresh, externalSignal });
        } catch (err) {
            lastErr = err;
            const classifier = _classifyHandshakeError(err, { retry429 });
            lastClassifier = classifier;
            // Permanent (or unknown → default-deny): stop immediately.
            if (!classifier) {
                if (err && typeof err === 'object') {
                    try { err.attempts = attempt; } catch {}
                    try { err.retryClassifier = null; } catch {}
                }
                throw err;
            }
            // Transient but exhausted: surface with tagging.
            if (attempt >= attemptCap) {
                if (err && typeof err === 'object') {
                    try { err.attempts = attempt; } catch {}
                    try { err.retryClassifier = classifier; } catch {}
                    try { err.wsRetriesExhausted = true; } catch {}
                }
                try {
                    if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(
                        `[openai-oauth-ws] handshake failed after ${attempt}/${attemptCap} attempts: ${err?.message || err}\n`,
                    );
                } catch {}
                throw err;
            }
            // Schedule backoff and emit progress.
            const backoff = _backoffFor(attempt);
            try {
                onRetry?.({
                    attempt,
                    max: attemptCap - 1,
                    classifier,
                    backoffMs: backoff,
                    error: err,
                });
            } catch {}
            // Sleep is abort-aware: an abort during backoff rejects immediately
            // instead of burning the remaining wait.
            const sleepStart = performance.now();
            try {
                if (externalSignal) {
                    await new Promise((resolve, reject) => {
                    const t = setTimeout(() => {
                        externalSignal.removeEventListener('abort', onAbort);
                        resolve();
                    }, backoff);
                    const onAbort = () => {
                        clearTimeout(t);
                        const reason = externalSignal.reason;
                        reject(reason instanceof Error ? reason : new Error('OpenAI OAuth WS acquire aborted'));
                    };
                    if (externalSignal.aborted) { onAbort(); return; }
                    externalSignal.addEventListener('abort', onAbort, { once: true });
                    });
                } else {
                    await _sleepFn(backoff);
                }
            } finally {
                try { onBackoffSlept?.(performance.now() - sleepStart); } catch {}
            }
        }
    }
    // Unreachable — the loop either returns or throws above — but keep the
    // typing honest.
    if (lastErr && typeof lastErr === 'object') {
        try { lastErr.attempts = HANDSHAKE_MAX_ATTEMPTS; } catch {}
        try { lastErr.retryClassifier = lastClassifier; } catch {}
    }
    throw lastErr || new Error('acquireWithRetry: unreachable');
}

/**
 * Dispatch one tool-loop iteration over a per-session cached WebSocket.
 * Returns the same shape as the SSE path: { content, model, toolCalls, usage }.
 */
export async function sendViaWebSocket({
    auth,
    body,
    sendOpts,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    onStageChange,
    externalSignal,
    poolKey,
    cacheKey,
    iteration,
    useModel,
    displayModel,
    forceFresh = false,
    includeResponseId = false,
    traceProvider = 'openai-oauth',
    logSuppressedReasoningDeltas = true,
    warmupBody = null,
    // Provider-specific handshake policy seam. OAuth leaves this null and
    // retains the Codex retry budget. Direct OpenAI uses it to surface
    // unsupported-WS handshake statuses immediately so its wrapper can make
    // the single WS→HTTP decision without nested WS retries.
    handshakeErrorPolicy = null,
    // Test seams (undefined in production). Let the unit test drive the
    // retry state machine without opening real sockets or touching the
    // handshake-retry layer.
    _acquireWithRetryFn = _acquireWithRetry,
    _streamFn = _streamResponse,
    _sendFrameFn = _sendFrame,
    _sleepFn = _defaultSleep,
    _sendSpanTraceFn = appendAgentTrace,
    _agentTraceFn = appendAgentTrace,
    _carriedWarmup = null,
}) {
    // One bounded Codex stream retry budget covers transient handshake and
    // pre-output stream failures. Every retry acquires a fresh connection.
    // No replay is permitted after live text or an emitted tool call.
    const MAX_MIDSTREAM_RETRIES = MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT;
    let firstAttemptError = null;
    let firstAttemptClassifier = null;
    // Send-scoped stall window: in-place stall retries share one wall clock
    // starting at the first stall (see createStallRetryBudget).
    const stallRetryBudget = createStallRetryBudget();
    // A generate:false prewarm is billable even if its main request later
    // retries on a fresh socket or falls back to HTTP. Retain one completed
    // result across the whole logical send and attach it to terminal errors.
    let completedWarmup = _carriedWarmup?.usage ? _carriedWarmup : null;
    const _stampWarmup = (err) => {
        if (!err || !completedWarmup?.usage) return err;
        try {
            Object.defineProperty(err, '__warmup', {
                value: completedWarmup,
                configurable: true,
                enumerable: false,
            });
        } catch {}
        return err;
    };
    // Known tool names for the leaked-tool-call guard in _streamResponse.
    // Derived from the exact request body so a recovered leaked call only
    // synthesizes when it names a tool actually offered to this request.
    const knownToolNames = new Set(
        (Array.isArray(body?.tools) ? body.tools : [])
            .map((t) => (typeof t?.name === 'string' ? t.name : null))
            .filter(Boolean),
    );
    // Live-text invariant across attempts: once ANY attempt has relayed a
    // non-empty text chunk to the client, no error thrown out of this function
    // may omit the liveTextEmitted/unsafeToRetry markers — otherwise an
    // upstream gate (auth-refresh retry, HTTP fallback, shared withRetry)
    // could reissue the turn and concatenate a second attempt onto
    // already-rendered output. A text-emitting attempt is never retry-eligible
    // (_classifyMidstreamError returns null on emittedText), so the surfaced
    // error is frequently an EARLIER attempt's firstAttemptError that never saw
    // the marker; stampText re-applies it on every throw path. The latch state
    // + stamp semantics now come from the shared createStreamSafetyStamps()
    // factory (retry-classifier.mjs) — identical to the former _stampLiveText /
    // _stampTool closures. markText()/markTool() set the latch (replacing the
    // liveTextEmittedAcrossAttempts / toolEmittedAcrossAttempts booleans);
    // stampText/stampTool re-apply the markers on every throw.
    const _safetyStamps = createStreamSafetyStamps();
    const _stampLiveText = _safetyStamps.stampText;
    const _stampTool = _safetyStamps.stampTool;
    // Server-side xAI conversation anchor preserved across mid-stream
    // retries. xAI keys its conversation by previous_response_id alone
    // (sessionToken is null for xAI in _mintSessionToken); a forceFresh
    // socket on retry would otherwise drop prev_id and cold-start a new
    // server-side conversation, evicting every prefix the prior attempts
    // warmed. openai-oauth / openai-direct anchor by per-socket session_id, where
    // this carry-forward would not help and is therefore gated to xAI.
    let carryForwardCache = null;
    const useCodexWsClientMetadata = traceProvider === 'openai-oauth';
    const codexMetadataContext = { poolKey, cacheKey, sendOpts };
    const codexHandshakeHeaders = useCodexWsClientMetadata
        ? _codexWsCompatibilityHeaders({ ...codexMetadataContext, handshake: true })
        : null;
    // One compact row per logical iteration. Values aggregate all handshake
    // and mid-stream attempts, including warmup, without retaining request data.
    const sendSpan = {
        poolAcquireMs: 0,
        requestBuildSerializationMs: 0,
        preResponseCreatedMs: 0,
        firstEventMs: 0,
        retryBackoffMs: 0,
        handshakeRetries: 0,
        acquireAttempts: 0,
        acquireMode: null,
        emitted: false,
    };
    const emitSendSpan = (outcome) => {
        if (sendSpan.emitted) return;
        sendSpan.emitted = true;
        const payload = {
            provider: traceProvider,
            model: useModel,
            transport: 'websocket',
            acquire_mode: sendSpan.acquireMode || 'failed',
            acquire_attempts: sendSpan.acquireAttempts,
            handshake_retries: sendSpan.handshakeRetries,
            pool_acquire_ms: sendSpan.poolAcquireMs,
            request_build_serialization_ms: sendSpan.requestBuildSerializationMs,
            pre_response_created_ms: sendSpan.preResponseCreatedMs,
            first_event_ms: sendSpan.firstEventMs,
            retry_backoff_ms: sendSpan.retryBackoffMs,
            outcome,
        };
        try {
            _sendSpanTraceFn({
                sessionId: poolKey,
                iteration,
                kind: 'send_spans',
                ...payload,
                payload,
            });
        } catch {}
    };
    // Single caller-visible recovery path for both handshake/acquire retries
    // and retryable stream failures. The session/TUI stage bridge renders this
    // as non-terminal reconnect progress; transport code must not also print it
    // to stderr.
    const emitReconnectProgress = ({ attempt, max, classifier }) => {
        const retryAttempt = Number(attempt) || 1;
        const retryMax = Number(max) || 1;
        try {
            onStageChange?.('reconnecting', {
                attempt: retryAttempt,
                max: retryMax,
                classifier: classifier || null,
                message: `Reconnecting... ${retryAttempt}/${retryMax}`,
            });
        } catch {}
    };
    // Only Codex OAuth follows retry_429:false. This shared transport also
    // backs xAI, whose existing 429 handshake retry behavior must remain.
    const retry429 = traceProvider !== 'openai-oauth';

    // Armed by the rejection safety net below: once a server rejects a
    // replayed reasoning item, every later attempt of THIS send strips them.
    let suppressReasoningReplay = false;

    for (let attemptIndex = 0; attemptIndex <= MAX_MIDSTREAM_RETRIES; attemptIndex++) {
        const handshakeStart = performance.now();
        let acquired;
        let handshakeRetries = 0;
        const handshakeRetryClassifiers = [];
        sendSpan.acquireAttempts += 1;
        try { onStageChange?.('requesting'); } catch {}
        try {
            acquired = await _acquireWithRetryFn({
                auth,
                poolKey,
                cacheKey,
                codexHeaders: codexHandshakeHeaders,
                // Retry attempt must not reuse a pooled socket — the prior
                // one is either torn down or in an unknown state.
                forceFresh: forceFresh || attemptIndex > 0,
                externalSignal,
                // No nested connect retry budget: the outer stream loop owns
                // all retries for this logical request.
                maxAttempts: 1,
                retry429,
                onRetry: (info) => {
                    handshakeRetries += 1;
                    sendSpan.handshakeRetries += 1;
                    if (info?.classifier) handshakeRetryClassifiers.push(info.classifier);
                    const attempt = Number(info?.attempt) || handshakeRetries;
                    const max = Number(info?.max) || MAX_MIDSTREAM_RETRIES;
                    emitReconnectProgress({ attempt, max, classifier: info?.classifier });
                },
                onBackoffSlept: (ms) => { sendSpan.retryBackoffMs += ms; },
            });
        } catch (err) {
            _stampWarmup(err);
            sendSpan.poolAcquireMs += performance.now() - handshakeStart;
            // Provenance only; policy remains provider-owned below. This lets
            // the direct wrapper distinguish an upgrade rejection from an
            // application error carrying the same HTTP status.
            try { err.wsFailurePhase = 'handshake'; } catch {}
            const classifier = err?.retryClassifier
                || _classifyHandshakeError(err, { retry429 })
                || (err?.code === 'EWSACQUIRETIMEOUT' ? 'acquire_timeout' : null);
            const classifiers = [...handshakeRetryClassifiers];
            if (classifier && !classifiers.includes(classifier)) classifiers.push(classifier);
            if (err?.httpStatus != null || classifier || handshakeRetries > 0 || classifiers.length > 0) {
                traceAgentFetch({
                    sessionId: poolKey,
                    headersMs: performance.now() - handshakeStart,
                    httpStatus: Number(err?.httpStatus || 0),
                    provider: traceProvider,
                    model: useModel,
                    transport: 'websocket',
                    handshakeRetries: err?.attempts ? Math.max(Number(err.attempts) - 1, 0) : handshakeRetries,
                    handshakeRetryClassifiers: classifiers,
                });
            }
            const handshakeDecision = typeof handshakeErrorPolicy === 'function'
                ? handshakeErrorPolicy({
                    error: err,
                    status: Number(err?.httpStatus || 0),
                    classifier,
                    attempt: attemptIndex + 1,
                    maxAttempts: MAX_MIDSTREAM_RETRIES + 1,
                })
                : null;
            if (handshakeDecision?.retry === false) {
                try {
                    err.wsFailurePhase = 'handshake';
                    err.wsHttpFallbackEligible = handshakeDecision.httpFallback === true;
                    if (classifier) err.retryClassifier = classifier;
                } catch {}
                emitSendSpan('error');
                throw _stampTool(_stampLiveText(err));
            }
            // HTTP 401 is reserved for caller-owned auth refresh. HTTP 426 is
            // caller-owned immediate HTTPS fallback. Every other recognized
            // transport failure spends the shared stream retry budget.
            const retryable = classifier
                && Number(err?.httpStatus || 0) !== 401
                && Number(err?.httpStatus || 0) !== 426
                && !externalSignal?.aborted;
            if (retryable && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                if (!firstAttemptError) {
                    firstAttemptError = err;
                    firstAttemptClassifier = classifier;
                }
                try { err.midstreamClassifier = classifier; } catch {}
                const retryNumber = attemptIndex + 1;
                emitReconnectProgress({
                    attempt: retryNumber,
                    max: MAX_MIDSTREAM_RETRIES,
                    classifier,
                });
                const sleepStart = performance.now();
                try {
                    await _sleepWithAbort(_midstreamBackoffFor(retryNumber), externalSignal, _sleepFn);
                } catch (sleepErr) {
                    sendSpan.retryBackoffMs += performance.now() - sleepStart;
                    emitSendSpan('error');
                    throw _stampWarmup(sleepErr);
                }
                sendSpan.retryBackoffMs += performance.now() - sleepStart;
                continue;
            }
            // A later auth/upgrade decision must win over an earlier transient
            // failure so the caller can refresh or switch transport. Likewise,
            // never replace a current cancellation with stale retry history.
            if (_mustSurfaceCurrentAttempt(err, externalSignal)) {
                if (retryable && attemptIndex >= MAX_MIDSTREAM_RETRIES) {
                    try { err.midstreamRetries = attemptIndex; } catch {}
                    try { err.midstreamClassifier = classifier; } catch {}
                    try { err.wsRetriesExhausted = true; } catch {}
                }
                emitSendSpan('error');
                throw _stampTool(_stampLiveText(err));
            }
            if (attemptIndex > 0 && firstAttemptError) {
                try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                if (attemptIndex >= MAX_MIDSTREAM_RETRIES) {
                    try { firstAttemptError.wsRetriesExhausted = true; } catch {}
                }
                emitSendSpan('error');
                throw _stampTool(_stampLiveText(firstAttemptError));
            }
            emitSendSpan('error');
            throw _stampTool(_stampLiveText(err));
        }
        const { entry, reused } = acquired;
        sendSpan.poolAcquireMs += performance.now() - handshakeStart;
        sendSpan.acquireMode = entry?.ephemeral ? 'ephemeral' : (reused ? 'reused' : 'new');
        // Re-seed the retry attempt's fresh entry with the prior attempt's
        // last successful anchor so _computeDelta sees a non-null
        // lastInputPrefixHash and prev_response_id, keeping the same xAI
        // conversation slot warm instead of cold-starting one per retry.
        if (carryForwardCache && auth?.type === 'xai' && !reused) {
            entry.lastResponseId = carryForwardCache.lastResponseId;
            entry.lastInputPrefixHash = carryForwardCache.lastInputPrefixHash;
            entry.lastInputLen = carryForwardCache.lastInputLen;
            entry.lastRequestSansInput = carryForwardCache.lastRequestSansInput;
            entry.lastRequestInput = carryForwardCache.lastRequestInput;
            entry.lastResponseItems = carryForwardCache.lastResponseItems;
        }
        traceAgentFetch({
            sessionId: poolKey,
            headersMs: performance.now() - handshakeStart,
            httpStatus: reused ? 0 : 101,
            provider: traceProvider,
            model: useModel,
            transport: 'websocket',
            handshakeRetries,
            handshakeRetryClassifiers,
        });

        let requestBody = body;
        // Mid-stream retry: pin prev_id in the body so _computeDelta's
        // mode='full' fallback (triggered when the carried prefix hash no
        // longer matches the current input) still carries the conversation
        // anchor. The delta path overwrites this from entry.lastResponseId,
        // which equals the carried value, so the two paths agree.
        if (carryForwardCache && auth?.type === 'xai' && attemptIndex > 0 && !body.previous_response_id) {
            requestBody = { ...body, previous_response_id: carryForwardCache.lastResponseId };
        }
        // Recovery-only reasoning replay: decide per entry whether retained
        // reasoning items ride this chain (see _applyReasoningReplayPolicy).
        // Must run BEFORE _computeDelta and the post-send bookkeeping so
        // entry.lastRequestInput always records the post-policy input.
        requestBody = _applyReasoningReplayPolicy(entry, requestBody, { suppress: suppressReasoningReplay });
        let warmupResult = null;
        // midState is shared between warmup and the main stream so warmup
        // failures (first-byte timeout, send-failure, ws_4000) flow through
        // the SAME mid-stream classifier as the main send. A wedged warmup
        // socket must not bypass the retry loop and surface raw to the
        // caller — release the entry, force a fresh acquire, and retry.
        const midState = {
            attemptIndex,
            sawResponseCreated: false,
            sawCompleted: false,
            // Gateway live-text relay invariant (see _streamResponse): set once
            // a non-empty text chunk has been forwarded to the client.
            emittedText: false,
            sessionId: poolKey,
            iteration,
            model: useModel,
            traceProvider,
        };
        const sseStart = Date.now();
        let mode = 'full';
        let frame = null;
        let deltaTokens = 0;
        let deltaReason = null;
        let strippedResponseItems = 0;
        let skippedResponseItems = 0;
        let responseOutputMismatch = null;
        let wireFrameHadTurnState = false;
        let wireFrameMetadataTrace = _metadataTrace(null);
        let framePrefixHash = null;
        let framePrefixHeadHash = null;
        let framePrefixPrevMatch = null;
        let result;
        const streamTimeouts = null;
        try {
            // Prewarm gate: only when the session
            // has no prior request state. A reused pooled socket with a live
            // chain must go straight to the real request.
            if (warmupBody && typeof warmupBody === 'object' && !completedWarmup
                && attemptIndex === 0 && !entry.lastResponseId) {
                const warmupBuildStart = performance.now();
                // Codex startup prewarm contains stable instructions/tools but
                // no live user/transcript input. Enforce that at the transport
                // boundary as well as in the OAuth caller so a future caller
                // cannot accidentally duplicate the transcript. WS-only fields
                // are omitted exactly as in Codex's prewarm request.
                const parityWarmupBody = { ...warmupBody, input: [], generate: false };
                const warmupFrame = _buildResponseCreateFrame(parityWarmupBody, { omitTransportFields: true });
                const warmupMetadataContext = {
                    ...codexMetadataContext,
                    sendOpts: {
                        ...(codexMetadataContext?.sendOpts || {}),
                        requestKind: 'prewarm',
                        codexRequestKind: 'prewarm',
                    },
                };
                const wireWarmupFrame = _withCodexWsClientMetadata(warmupFrame, entry, useCodexWsClientMetadata, warmupMetadataContext);
                wireFrameHadTurnState = !!wireWarmupFrame?.client_metadata?.['x-codex-turn-state'];
                wireFrameMetadataTrace = _metadataTrace(wireWarmupFrame?.client_metadata);
                sendSpan.requestBuildSerializationMs += performance.now() - warmupBuildStart;
                await _sendFrameFn(entry, wireWarmupFrame, sendSpan);
                const warmupStart = Date.now();
                const warmupState = {
                    attemptIndex,
                    sawResponseCreated: false,
                    sawCompleted: false,
                    sessionId: poolKey,
                    iteration,
                    model: useModel,
                    traceProvider,
                    warmup: true,
                    sendSpan,
                    sendStartedAt: performance.now(),
                };
                warmupResult = await _streamFn({
                    entry,
                    externalSignal,
                    onStreamDelta: null,
                    onToolCall: null,
                    state: warmupState,
                    logSuppressedReasoningDeltas,
                    traceProvider,
                    _timeouts: streamTimeouts,
                });
                // Surface warmup-time first-event timeout / send-failure
                // flags onto the shared midState so the outer catch's
                // classifier sees them. (warmupResult itself only resolves
                // on success; failures throw and skip this block.)
                if (warmupState.firstByteTimeout) midState.firstByteTimeout = true;
                if (warmupState.wsSendFailed) midState.wsSendFailed = true;
                if (!warmupResult?.responseId) {
                    throw new Error('Responses WS warmup completed without response id');
                }
                completedWarmup = {
                    requestBody: parityWarmupBody,
                    responseId: warmupResult.responseId,
                    usage: warmupResult.usage,
                };
                entry.lastResponseId = warmupResult.responseId;
                entry.lastRequestSansInput = _stableStringify(_sansInput(parityWarmupBody, {
                    normalizeWarmupGenerate: useCodexWsClientMetadata,
                }));
                const warmupInputArr = Array.isArray(parityWarmupBody.input) ? parityWarmupBody.input : [];
                entry.lastRequestInput = _cloneJson(warmupInputArr);
                entry.lastResponseItems = _cloneJson(Array.isArray(warmupResult.responseItems) ? warmupResult.responseItems : []);
                entry.lastInputLen = warmupInputArr.length;
                entry.lastInputPrefixHash = createHash('sha256')
                    .update(JSON.stringify(warmupInputArr))
                    .digest('hex');
                try {
                    const warmupPayload = {
                        provider: traceProvider,
                        transport: 'websocket',
                        event: 'warmup_completed',
                        response_id: warmupResult.responseId,
                        elapsed_ms: Date.now() - warmupStart,
                        input_tokens: warmupResult.usage?.inputTokens || 0,
                        cached_tokens: warmupResult.usage?.cachedTokens || 0,
                        output_tokens: warmupResult.usage?.outputTokens || 0,
                        prompt_tokens: warmupResult.usage?.promptTokens || 0,
                    };
                    _agentTraceFn({
                        sessionId: poolKey,
                        iteration,
                        kind: 'cache_warmup',
                        ...warmupPayload,
                        payload: warmupPayload,
                    });
                } catch {}
            }

            // A completed generate:false prewarm is a valid continuation
            // anchor. Compute against its retained empty-input snapshot so the
            // first real request sends previous_response_id plus exactly the
            // real incremental input. _computeDelta still retreats to a full
            // frame on every missing anchor/property/prefix/output mismatch.
            const requestBuildStart = performance.now();
            const delta = _computeDelta({ entry, body: requestBody, traceProvider });
            ({ mode, frame } = delta);
            deltaReason = delta.reason || null;
            strippedResponseItems = delta.strippedResponseItems || 0;
            skippedResponseItems = delta.skippedResponseItems || 0;
            responseOutputMismatch = delta.responseOutputMismatch || null;
            const wireFrame = _withCodexWsClientMetadata(frame, entry, useCodexWsClientMetadata, codexMetadataContext);
            wireFrameHadTurnState = !!wireFrame?.client_metadata?.['x-codex-turn-state'];
            wireFrameMetadataTrace = _metadataTrace(wireFrame?.client_metadata);
            deltaTokens = _estimateFrameTokens(wireFrame);
            // Prefix-consistency probe (item-level). Serialized-JSON byte
            // prefixes can never match across appends (the shorter frame ends
            // in "]}" where the longer has ","), so compare what the server's
            // prefix cache actually sees: the non-input request header and the
            // per-item content of the input array. prev_match=true means the
            // current call's header is identical and its first N input items
            // equal the previous call's N items (append-only history).
            try {
                const { client_metadata: _cm, input: frameInput, ...frameHeader } = frame;
                const headerHash = _hashText(JSON.stringify(frameHeader), 16);
                const itemHashes = (Array.isArray(frameInput) ? frameInput : [])
                    .map((item) => _hashText(JSON.stringify(item), 12));
                framePrefixHash = headerHash;
                framePrefixHeadHash = _hashText(itemHashes.join(','), 16);
                const prevHeader = entry.lastFrameHeaderHash;
                const prevItems = entry.lastFrameItemHashes;
                if (prevHeader && Array.isArray(prevItems)) {
                    framePrefixPrevMatch = headerHash === prevHeader
                        && itemHashes.length >= prevItems.length
                        && prevItems.every((h, i) => itemHashes[i] === h);
                }
                entry.lastFrameHeaderHash = headerHash;
                entry.lastFrameItemHashes = itemHashes;
            } catch {}

            // Re-check abort after acquire/warmup — narrow window where
            // externalSignal could fire between successful acquire and
            // send(). Without this gate an aborted request could still
            // emit one frame to the provider.
            if (externalSignal?.aborted) {
                // Preserve the abort reason (Error) so downstream
                // classification (userAbort vs. generic) survives — a bare
                // new Error('Aborted') would erase that signal.
                const reason = externalSignal.reason;
                throw reason instanceof Error ? reason : new Error('Aborted');
            }
            sendSpan.requestBuildSerializationMs += performance.now() - requestBuildStart;
            await _sendFrameFn(entry, wireFrame, sendSpan);
            midState.sendSpan = sendSpan;
            midState.sendStartedAt = performance.now();

            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-streaming-start sinceAcquire=${Math.round(performance.now() - handshakeStart)}ms\n`);
            }
            try { onStageChange?.('streaming'); } catch {}
            result = await _streamFn({
                entry,
                externalSignal,
                onStreamDelta,
                onToolCall,
                onTextDelta,
                state: midState,
                logSuppressedReasoningDeltas,
                traceProvider,
                _timeouts: streamTimeouts,
                knownToolNames,
            });
        } catch (err) {
            _stampWarmup(err);
            // Preserve failure provenance for the direct provider. This marker
            // is observational for OAuth and does not change its classifier or
            // retry budget.
            try { err.wsFailurePhase = 'stream'; } catch {}
            // Snapshot the xAI conversation anchor BEFORE releasing the
            // entry. release closes the socket but leaves state fields
            // intact; the next forceFresh acquire creates a new entry into
            // which we manually carry the anchor so the retry continues the
            // same conversation instead of cold-starting one.
            if (auth?.type === 'xai' && entry.lastResponseId) {
                carryForwardCache = {
                    lastResponseId: entry.lastResponseId,
                    lastInputPrefixHash: entry.lastInputPrefixHash,
                    lastInputLen: entry.lastInputLen,
                    lastRequestSansInput: entry.lastRequestSansInput,
                    lastRequestInput: entry.lastRequestInput,
                    lastResponseItems: entry.lastResponseItems,
                };
            }
            releaseWebSocket({ entry, poolKey, keep: false });
            // Mid-stream classification.
            // Live-text invariant: a non-empty chunk already relayed to the
            // client cannot be withdrawn. Tag the error so the upstream HTTP
            // fallback gate also refuses to re-issue and concatenate attempts.
            if (midState.emittedText) {
                // Latch across attempts: even though THIS error is never
                // retry-eligible once text is out, a later/earlier surfaced
                // error (firstAttemptError) must still carry the marker.
                _safetyStamps.markText();
            }
            if (midState.emittedToolCall) {
                _safetyStamps.markTool();
            }
            // Reasoning deltas and an in-progress tool input are already
            // observable turn progress even though neither is final assistant
            // text nor a dispatched tool call. Reissuing from the beginning can
            // duplicate exposed thinking/tool argument streams and can make a
            // partially generated side-effecting call diverge. Keep the Codex
            // retry budget only for failures before any such model output.
            // Exposed reasoning is a visibility boundary. A tool call that only
            // STARTED assembling was never dispatched, so it is recorded but is
            // NOT a side effect and must not veto a retry.
            if (midState.emittedReasoning || midState.startedToolCall) {
                try {
                    if (midState.emittedReasoning) {
                        err.unsafeToRetry = true;
                        err.partialReasoningEmitted = true;
                    }
                    if (midState.startedToolCall) err.partialToolCallStarted = true;
                } catch {}
            }
            _stampLiveText(err);
            _stampTool(err);
            // Canonical stream-outcome record for the WS transport, merged
            // with the cross-attempt safety latches above. _streamResponse
            // already stamps its own reject paths; this covers frame-send /
            // handshake-adjacent failures that never reached the stream loop.
            try {
                stampStreamOutcome(err, midState, {
                    transport: STREAM_TRANSPORTS.WS,
                    provider: 'openai-oauth',
                    continuation: midState.sawCompleted !== true,
                });
            } catch { /* stamping is best-effort */ }
            // Reasoning-replay rejection safety net: a duplicate-rs_ rejection
            // on a frame that carried replayed reasoning gets ONE strip-and-
            // retry within the existing attempt budget instead of failing the
            // recovery turn outright. Unsafe outcomes (live text/tool output)
            // keep their normal no-replay handling.
            if (!suppressReasoningReplay
                && entry.replayReasoning === true
                && err?.unsafeToRetry !== true
                && attemptIndex < MAX_MIDSTREAM_RETRIES
                && _isReasoningReplayRejection(err)) {
                suppressReasoningReplay = true;
                firstAttemptError = err;
                firstAttemptClassifier = 'reasoning_replay_rejected';
                try { err.midstreamClassifier = 'reasoning_replay_rejected'; } catch {}
                emitReconnectProgress({
                    attempt: attemptIndex + 1,
                    max: MAX_MIDSTREAM_RETRIES,
                    classifier: 'reasoning_replay_rejected',
                });
                continue;
            }
            const classifier = err?.unsafeToRetry === true
                ? null
                : _classifyMidstreamError(err, midState);
            if (classifier === 'stream_stalled' && !stallRetryBudget.allowStallRetry()) {
                try { process.stderr.write(`[openai-oauth] stall retry budget exhausted (${STREAM_STALL_RETRY_BUDGET_MS}ms since first stall) — surfacing for fresh-request retry\n`); } catch {}
                emitSendSpan('error');
                throw _stampTool(_stampLiveText(err));
            }
            const retryLimit = classifier ? _midstreamRetryLimit(classifier) : 0;
            if (classifier && attemptIndex < retryLimit) {
                // Retry-eligible: stash the first-attempt error, emit progress,
                // and loop. The subsequent acquire uses forceFresh so no socket
                // is shared between attempts.
                if (shouldDropPreviousResponseId(err)) {
                    carryForwardCache = null;
                    try { entry.lastResponseId = null; } catch {}
                }
                firstAttemptError = err;
                firstAttemptClassifier = classifier;
                try { err.midstreamClassifier = classifier; } catch {}
                const retryNumber = attemptIndex + 1;
                const backoff = _midstreamBackoffFor(retryNumber);
                emitReconnectProgress({
                    attempt: retryNumber,
                    max: retryLimit,
                    classifier,
                });
                const sleepStart = performance.now();
                try {
                    await _sleepWithAbort(backoff, externalSignal, _sleepFn);
                } catch (sleepErr) {
                    sendSpan.retryBackoffMs += performance.now() - sleepStart;
                    emitSendSpan('error');
                    throw _stampWarmup(sleepErr);
                }
                sendSpan.retryBackoffMs += performance.now() - sleepStart;
                continue;
            }
            // Not retryable, OR we've already exhausted the retry budget.
            // Do not let stale retry history mask a current auth/upgrade
            // decision, cancellation, or newly unsafe-to-replay outcome.
            if (_mustSurfaceCurrentAttempt(err, externalSignal)) {
                emitSendSpan('error');
                throw _stampTool(_stampLiveText(err));
            }
            if (attemptIndex > 0 && firstAttemptError) {
                // Exhausted path: surface the first-attempt error (the one
                // the user's turn actually tripped on), tag actual retry count.
                try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                if (attemptIndex >= _midstreamRetryLimit(firstAttemptClassifier)) {
                    try { firstAttemptError.wsRetriesExhausted = true; } catch {}
                }
                // Attach the retry attempt's error so post-mortem diagnostics
                // can see WHY the retry also failed instead of silently
                // dropping it. Use `cause` if free, else `suppressed`.
                try {
                    if (!firstAttemptError.cause) firstAttemptError.cause = err;
                    else {
                        const list = Array.isArray(firstAttemptError.suppressed)
                            ? firstAttemptError.suppressed
                            : [];
                        list.push(err);
                        firstAttemptError.suppressed = list;
                    }
                } catch {}
                emitSendSpan('error');
                throw _stampTool(_stampLiveText(firstAttemptError));
            }
            emitSendSpan('error');
            throw _stampTool(_stampLiveText(err));
        }
        const liveModel = result.model || useModel;
        traceAgentSse({
            sessionId: poolKey,
            sseParseMs: Date.now() - sseStart,
            provider: traceProvider,
            model: liveModel,
            transport: 'websocket',
        });

        const resultToolCallCount = Array.isArray(result.toolCalls) ? result.toolCalls.length : 0;
        // Keep the conversation chain whenever the server gave us a response id.
        // `incompleteReason` is ONLY ever set for max_output_tokens-class
        // truncation (every other incomplete status throws upstream), and in
        // that case the response IS valid and the server preserves its
        // response_id as a continuation anchor. Dropping the chain here forced
        // the NEXT turn to cold-start (no_anchor → full resend), which the
        // trace logs showed repeating 50-78x in long max-output sessions. If a
        // truncated turn's response items don't line up next turn,
        // _stripResponseItemsFromHead still falls back to a full send on its
        // own, so retaining the anchor cannot corrupt the cache — it only adds
        // a delta fast-path when the items DO match.
        const keepResponseChain = !!result.responseId;
        // Normally the socket is pooled for reuse. But an early tool-call settle
        // (result.closeSocket) means the stream resolved before
        // response.completed/done arrived: the server may still emit those as
        // orphan frames, so the socket must be discarded, not reused.
        const keepSocket = !result.closeSocket;

        // Update cache state for the next iteration in this session. openai-oauth
        // keeps the previous response anchor even when the model emitted tool
        // calls: the next request is previous input + server output items
        // + tool results, and _computeDelta strips the first two parts so the
        // WebSocket frame only sends the true new tail.
        // Captured BEFORE the overwrite below: chain-continuity trace must
        // compare the request's prev_id against what the entry held when the
        // request was BUILT, not the id we just received (review Low).
        const priorEntryResponseId = typeof entry?.lastResponseId === 'string' && entry.lastResponseId.length > 0
            ? entry.lastResponseId
            : null;
        const cacheContinuityResetReason = _cacheContinuityResetReason({
            mode,
            deltaReason,
            entry,
            body: requestBody,
            traceProvider,
        });
        if (result.responseId && keepResponseChain) {
            entry.lastResponseId = result.responseId;
            entry.lastRequestSansInput = _stableStringify(_sansInput(requestBody, {
                normalizeWarmupGenerate: useCodexWsClientMetadata,
            }));
            const inputArr = Array.isArray(requestBody.input) ? requestBody.input : [];
            entry.lastRequestInput = _cloneJson(inputArr);
            entry.lastResponseItems = _cloneJson(Array.isArray(result.responseItems) ? result.responseItems : []);
            entry.lastInputLen = inputArr.length;
            // Kept for diagnostics / xAI retry carry-forward. The canonical
            // prefix guard is lastRequestInput above, not this hash.
            entry.lastInputPrefixHash = createHash('sha256')
                .update(JSON.stringify(inputArr))
                .digest('hex');
        } else if (!keepResponseChain) {
            entry.lastResponseId = null;
            entry.lastRequestSansInput = null;
            entry.lastRequestInput = null;
            entry.lastResponseItems = null;
            entry.lastInputLen = 0;
            entry.lastInputPrefixHash = null;
        }

        // Cache observation must see the MAIN request's usage only. Folding
        // warmup usage in first (R18) made prompt_tokens spike on it=1 and
        // then "shrink" on it=2, faking prefix-rewrite/cache-drop signals in
        // every warmup session (debugger 2026-07-03).
        const cacheObservation = _cacheObservation({
            entry,
            result,
            continuityResetReason: cacheContinuityResetReason,
        });
        if (completedWarmup?.usage) {
            result.usage = _combineUsageWithWarmup(result.usage, completedWarmup.usage, {
                // xAI/Grok prewarm is billable just like Codex prewarm, but it
                // is not part of the real request's context footprint. Direct
                // OpenAI intentionally retains its existing usage shape.
                separateMainContext: useCodexWsClientMetadata || traceProvider === 'xai',
            });
        }

        const requestedServiceTier = body?.service_tier || null;
        const responseServiceTier = result.serviceTier || result.usage?.raw?.service_tier || null;
        const sentPrevResponseId = typeof frame?.previous_response_id === 'string' && frame.previous_response_id.length > 0
            ? frame.previous_response_id
            : (typeof body?.previous_response_id === 'string' && body.previous_response_id.length > 0
                ? body.previous_response_id
                : null);
        // Compare against the entry's PRE-request lastResponseId (captured
        // above, before line ~979 overwrites it with the new response id):
        // the WS delta path chains from entry state, so stale providerState
        // OR the post-overwrite id would both mis-report continuity.
        const cacheChain = traceProvider === 'xai'
            ? (priorEntryResponseId
                ? {
                    requestPrevResponseId: sentPrevResponseId,
                    chainContinuous: sentPrevResponseId !== null && sentPrevResponseId === priorEntryResponseId,
                    continuationResetReason: null,
                }
                : grokCacheChainTraceFields(sendOpts?.providerState, sentPrevResponseId, null))
            : null;
        traceAgentUsage({
            sessionId: poolKey,
            iteration,
            inputTokens: result.usage?.inputTokens || 0,
            outputTokens: result.usage?.outputTokens || 0,
            cachedTokens: result.usage?.cachedTokens || 0,
            promptTokens: result.usage?.promptTokens || 0,
            model: liveModel,
            modelDisplay: displayModel ? displayModel(liveModel) : liveModel,
            responseId: result.responseId || null,
            rawUsage: result.usage?.raw || null,
            provider: traceProvider,
            serviceTier: responseServiceTier,
            ...(cacheChain ? {
                requestPrevResponseId: cacheChain.requestPrevResponseId,
                chainContinuous: cacheChain.chainContinuous,
                continuationResetReason: cacheChain.continuationResetReason,
            } : {}),
        });
        const requestHasPreviousResponseId = typeof frame.previous_response_id === 'string' && frame.previous_response_id.length > 0;
        const transportCacheKeyHash = cacheKey
            ? createHash('sha256').update(String(cacheKey)).digest('hex').slice(0, 12)
            : null;
        if (cacheObservation.actualMiss) {
            try {
                _agentTraceFn({
                    sessionId: poolKey,
                    iteration,
                    kind: 'cache_miss',
                    provider: traceProvider,
                    model: liveModel,
                    transport: 'websocket',
                    payload: {
                        provider: traceProvider,
                        model: liveModel,
                        transport: 'websocket',
                        ws_mode: mode,
                        reason: cacheObservation.missReason || 'warm_session_cache_miss',
                        cached_tokens: cacheObservation.cachedTokens,
                        prompt_tokens: cacheObservation.promptTokens,
                        input_tokens: cacheObservation.inputTokens,
                        uncached_tokens: cacheObservation.uncachedTokens,
                        cache_ratio: cacheObservation.cacheRatio,
                        previous_max_cached_tokens: cacheObservation.previousMaxCached,
                        cache_key_hash: transportCacheKeyHash,
                        warm_threshold_tokens: cacheObservation.warmThreshold,
                        prompt_threshold_tokens: cacheObservation.promptThreshold,
                        drop_ratio: cacheObservation.dropRatio,
                        drop_threshold_tokens: cacheObservation.dropThreshold,
                        request_has_previous_response_id: requestHasPreviousResponseId,
                        chain_delta_reason: mode === 'delta' ? null : deltaReason,
                        body_input_items: Array.isArray(requestBody.input) ? requestBody.input.length : null,
                        frame_input_items: Array.isArray(frame.input) ? frame.input.length : null,
                        response_id: result.responseId || null,
                    },
                });
            } catch {}
        }
        // Rebase after a genuine provider retreat so one eviction produces one
        // diagnostic instead of a long run of duplicate "dropped" rows. The
        // request that exposed the retreat has already rebuilt the prefix; its
        // observed cached count is the correct baseline for recovery.
        entry.promptCacheMaxCachedTokens = (cacheObservation.actualMiss || cacheObservation.continuityResetReason)
            ? cacheObservation.cachedTokens
            : Math.max(_num(entry.promptCacheMaxCachedTokens, 0), cacheObservation.cachedTokens);
        // Early-session cache-miss ledger (first up-to-3 real requests on this
        // socket) for the warmup→first-real continuity trace below. Warmup
        // itself is excluded — this block only runs on the real send.
        if (!Array.isArray(entry.earlyCacheMisses)) entry.earlyCacheMisses = [];
        if (entry.earlyCacheMisses.length < 3) {
            entry.earlyCacheMisses.push(
                cacheObservation.actualMiss ? (cacheObservation.missReason || 'miss') : false,
            );
        }
        const warmupContinuity = _warmupContinuityTrace({
            warmupUsed: !!warmupResult,
            warmupResponseId: warmupResult?.responseId || null,
            priorEntryResponseId,
            sentPrevResponseId,
            earlyCacheMisses: entry.earlyCacheMisses,
        });
        // Extra WS-specific observability: transport + per-iteration delta bytes.
        try {
            const transportPayload = {
                provider: traceProvider,
                transport: 'websocket',
                ws_mode: mode,
                ws_pre_response_created_timeout_ms: WS_PRE_RESPONSE_CREATED_MS,
                ws_inter_chunk_timeout_ms: WS_INTER_CHUNK_MS,
                ws_idle_ms: WS_IDLE_MS,
                iteration_delta_tokens: deltaTokens,
                reused_connection: reused,
                requested_service_tier: requestedServiceTier,
                response_service_tier: responseServiceTier,
                handshake_retries: handshakeRetries,
                handshake_retry_classifiers: handshakeRetryClassifiers,
                midstream_retries: attemptIndex,
                response_id: result.responseId || null,
                cache_key_hash: transportCacheKeyHash,
                request_has_previous_response_id: requestHasPreviousResponseId,
                cached_tokens: cacheObservation.cachedTokens,
                prompt_tokens: cacheObservation.promptTokens,
                input_tokens: cacheObservation.inputTokens,
                uncached_tokens: cacheObservation.uncachedTokens,
                cache_ratio: cacheObservation.cacheRatio,
                actual_cache_miss: cacheObservation.actualMiss,
                actual_cache_miss_reason: cacheObservation.missReason,
                previous_max_cached_tokens: cacheObservation.previousMaxCached,
                cache_drop_threshold_tokens: cacheObservation.dropThreshold,
                frame_prefix_hash: framePrefixHash,
                frame_prefix_head_hash: framePrefixHeadHash,
                frame_prefix_prev_match: framePrefixPrevMatch,
                ws_client_metadata: useCodexWsClientMetadata,
                ws_client_metadata_key_count: wireFrameMetadataTrace.count,
                ws_client_metadata_hash: wireFrameMetadataTrace.hash,
                ws_client_metadata_has_turn_metadata: wireFrameMetadataTrace.hasTurnMetadata,
                ws_client_metadata_has_thread_id: wireFrameMetadataTrace.hasThreadId,
                ws_client_metadata_has_turn_state: wireFrameHadTurnState,
                ws_entry_turn_state_available: useCodexWsClientMetadata && !!entry.turnState,
                // Fingerprint only. The token is a routing credential, so it is
                // hashed like every other handshake secret; the length still
                // distinguishes a real server token from a stub value, and the
                // hash shows whether one session keeps a single pin or is
                // re-issued (reconnect / turn rollover).
                ws_entry_turn_state_fp: typeof entry.turnState === 'string' && entry.turnState
                    ? `${createHash('sha256').update(entry.turnState).digest('hex').slice(0, 12)}:len${entry.turnState.length}`
                    : null,
                chain_delta_reason: mode === 'delta' ? null : deltaReason,
                chain_stripped_response_items: strippedResponseItems,
                chain_skipped_response_items: skippedResponseItems,
                ...(responseOutputMismatch || {}),
                chain_response_items: Array.isArray(result.responseItems) ? result.responseItems.length : 0,
                body_input_items: Array.isArray(requestBody.input) ? requestBody.input.length : null,
                frame_input_items: Array.isArray(frame.input) ? frame.input.length : null,
                frame_has_instructions: typeof frame.instructions === 'string' && frame.instructions.length > 0,
                warmup_used: !!warmupResult,
                warmup_response_id: warmupResult?.responseId || null,
                ...warmupContinuity,
                tool_call_count: resultToolCallCount,
                keep_socket: keepSocket,
                keep_response_chain: keepResponseChain,
            };
            _agentTraceFn({
                sessionId: poolKey,
                iteration,
                kind: 'transport',
                ...transportPayload,
                payload: transportPayload,
            });
            const chainFallback = mode !== 'delta'
                && deltaReason
                && !['no_anchor', 'full_forced', 'full_default', 'delta_missing_turn_state'].includes(deltaReason);
            if (chainFallback || (mode === 'delta' && deltaReason)) {
                const intentionalTransition = typeof sendOpts?.cacheBreakIntent === 'string'
                    ? sendOpts.cacheBreakIntent
                    : null;
                _agentTraceFn({
                    sessionId: poolKey,
                    iteration,
                    kind: 'cache_break',
                    provider: traceProvider,
                    model: liveModel,
                    payload: {
                        provider: traceProvider,
                        model: liveModel,
                        transport: 'websocket',
                        ws_mode: mode,
                        reason: mode === 'delta' ? deltaReason : (deltaReason || 'full_frame'),
                        intentional_transition: intentionalTransition,
                        request_tool_choice: requestBody.tool_choice ?? null,
                        cache_key_hash: transportCacheKeyHash,
                        cached_tokens: cacheObservation.cachedTokens,
                        prompt_tokens: cacheObservation.promptTokens,
                        uncached_tokens: cacheObservation.uncachedTokens,
                        cache_ratio: cacheObservation.cacheRatio,
                        actual_cache_miss: cacheObservation.actualMiss,
                        request_has_previous_response_id: transportPayload.request_has_previous_response_id,
                        chain_stripped_response_items: strippedResponseItems,
                        chain_skipped_response_items: skippedResponseItems,
                        ...(responseOutputMismatch || {}),
                        chain_response_items: Array.isArray(result.responseItems) ? result.responseItems.length : 0,
                        body_input_items: Array.isArray(requestBody.input) ? requestBody.input.length : null,
                        frame_input_items: Array.isArray(frame.input) ? frame.input.length : null,
                        frame_has_instructions: transportPayload.frame_has_instructions,
                        keep_response_chain: keepResponseChain,
                        tool_call_count: resultToolCallCount,
                    },
                });
            }
        } catch {}

        releaseWebSocket({ entry, poolKey, keep: keepSocket });
        const { responseId: _ignored, responseItems: _responseItemsIgnored, closeSocket: _closeSocketIgnored, ...out } = result;
        if (includeResponseId && result.responseId) out.responseId = result.responseId;
        if (completedWarmup) {
            try {
                Object.defineProperty(out, '__warmup', {
                    value: completedWarmup,
                    enumerable: false,
                });
            } catch {}
        }
        // Leave a breadcrumb on the result so downstream callers can observe
        // that a retry was used (0 = first-try success, up to 2 for ws_1006/1011).
        try { Object.defineProperty(out, '__midstreamRetries', { value: attemptIndex, enumerable: false }); } catch {}
        emitSendSpan('ok');
        return out;
    }
    // Unreachable — the loop either returns or throws above.
    throw _stampWarmup(_stampTool(_stampLiveText(firstAttemptError || new Error('sendViaWebSocket: unreachable'))));
}
