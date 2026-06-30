/**
 * OpenAI OAuth subscription — WebSocket transport.
 *
 * Single dispatch path for the openai-oauth provider (SSE removed in
 * v0.6.117). Uses the `responses_websockets=2026-02-06` beta WebSocket
 * upgrade on chatgpt.com/backend-api/codex/responses. Per-session
 * connections are pooled (5 min idle TTL, up to 8 parallel sockets per
 * key) so subsequent tool-loop iterations can send only the incremental
 * `input` delta plus `previous_response_id`, skipping the full
 * tools/system/history prefix each turn.
 *
 * References:
 * - pi-mono packages/ai/src/providers/openai-codex-responses.ts
 *   (acquireWebSocket/release, get_incremental_items delta logic).
 * - openai/codex codex-rs/core/src/client.rs (turn-state echo header).
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
import WebSocket from 'ws';
import { errText } from '../../../shared/err-text.mjs';
import { createHash, randomBytes } from 'crypto';
import {
    extractCachedTokens,
    traceAgentFetch,
    traceAgentSse,
    traceAgentUsage,
    appendAgentTrace,
} from '../agent-trace.mjs';
import {
    classifyHandshakeError,
    classifyMidstreamError,
    createStreamSafetyStamps,
    jitterDelayMs,
    MIDSTREAM_RETRY_POLICY,
    populateHttpStatusFromMessage,
    sleepWithAbort,
} from './retry-classifier.mjs';
import { makeInvalidToolArgsMarker } from './openai-compat-stream.mjs';
import {
    PROVIDER_RETRY_MAX_ATTEMPTS,
    PROVIDER_WS_ACQUIRE_TIMEOUT_MS,
    PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS,
    PROVIDER_WS_HANDSHAKE_TIMEOUT_MS,
    PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS,
} from '../stall-policy.mjs';
import { customToolCallFromResponseItem } from './custom-tool-wire.mjs';

globalThis.__mixdogOpenaiWsRuntimeLoaded = true;

const CODEX_WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
const CODEX_OAUTH_ORIGINATOR = 'codex_cli_rs';
const OPENAI_WS_URL = 'wss://api.openai.com/v1/responses';
const XAI_WS_URL = 'wss://api.x.ai/v1/responses';
const WS_IDLE_MS = 5 * 60_000;
const WS_HANDSHAKE_TIMEOUT_MS = PROVIDER_WS_HANDSHAKE_TIMEOUT_MS;
const WS_ACQUIRE_TIMEOUT_MS = PROVIDER_WS_ACQUIRE_TIMEOUT_MS;
// Pre-stream watchdog uses the shared provider deadline so it fails before
// the 5-minute session slow warning.
const WS_FIRST_MEANINGFUL_MS = PROVIDER_WS_FIRST_MEANINGFUL_TIMEOUT_MS;
// Pre-`response.created` deadline. Once the socket is open and the
// response.create frame is sent, a healthy server emits response.created
// within seconds. If it stalls past this short bound the socket has wedged
// post-upgrade with zero server events — treat it as a fast, retryable
// first-byte timeout rather than waiting the longer first-meaningful window.
// Only this short window is shortened; the post-`response.created`
// inter-chunk / reasoning span keeps the longer deadlines below.
const WS_PRE_RESPONSE_CREATED_MS = (() => {
    const raw = process.env.MIXDOG_PROVIDER_WS_PRE_RESPONSE_CREATED_TIMEOUT_MS;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(n, 1_000), 120_000);
    return 10_000;
})();
// Inter-chunk inactivity after first meaningful output.
const WS_INTER_CHUNK_MS = PROVIDER_WS_INTER_CHUNK_TIMEOUT_MS;
// Mid-stream retry budgets + backoff now live in the shared MIDSTREAM_RETRY_POLICY
// table (retry-classifier.mjs). These aliases keep the local call sites readable
// and ensure the numbers exist in exactly ONE place.
const MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT = MIDSTREAM_RETRY_POLICY.ws.transientCloseRetries;
const MIDSTREAM_DEFAULT_RETRY_LIMIT = MIDSTREAM_RETRY_POLICY.ws.defaultRetries;
const MIDSTREAM_BACKOFF_MS = MIDSTREAM_RETRY_POLICY.ws.backoff;
// Policy object passed to the shared classifyMidstreamError for the WS path.
const WS_MIDSTREAM_POLICY = {
    mode: 'ws',
    transientCloseRetries: MIDSTREAM_RETRY_POLICY.ws.transientCloseRetries,
    defaultRetries: MIDSTREAM_RETRY_POLICY.ws.defaultRetries,
};

// Handshake retry policy. The `ws` library surfaces a bare
// `Opening handshake has timed out` Error after handshakeTimeout; transient
// network blips (DNS, reset, 5xx) similarly produce single-shot failures that
// waste the caller's turn when they'd succeed on retry. We wrap the acquire
// step with bounded exponential backoff. Permanent auth/quota (4xx) must NOT
// retry because a second attempt will hit the same deterministic server
// decision and just double the user-visible latency.
// Aligned to the cross-provider default (retry-classifier DEFAULT_MAX_ATTEMPTS=5,
// anthropic-oauth MAX_ATTEMPTS=5, withRetry-using providers all default to 5).
// Previously 3 — bumped for parity so every provider exhausts the same number
// of transient-5xx attempts before surfacing failure to the caller.
const HANDSHAKE_MAX_ATTEMPTS = PROVIDER_RETRY_MAX_ATTEMPTS;
const HANDSHAKE_BACKOFF_BASE_MS = 500;
const HANDSHAKE_BACKOFF_CAP_MS = 5000;
// WS socket pool buckets are keyed by `poolKey` (the per-call sessionId)
// to isolate parallel agent invocations — each gets its own socket so
// a second caller cannot grab a sibling's mid-turn entry (openai-oauth would
// otherwise reject the new response.create with "No tool output found
// for function call ..."). The handshake `session_id` header/URL
// uses `cacheKey` — a prefix-scoped cache key derived from the configured
// provider namespace plus model/system/tools hash. Same-prefix sessions share
// server-side prompt cache, while unrelated main/worker prefixes no longer
// evict each other inside one static provider lane. The backend dedupes cache by
// handshake session_id, not by body.prompt_cache_key alone (measured
// 2026-04-19 after the v0.6.151 regression).
const MAX_POOLED_SOCKETS_PER_KEY = 8;

// poolKey -> Entry[]
// Entry: { socket, busy, idleTimer, lastResponseId, lastRequestSansInput,
//          lastRequestInput, lastResponseItems, lastInputLen, turnState,
//          closing, ephemeral }
const _wsPool = new Map();

// Final prompt_cache_key/session_id lane guard for OpenAI OAuth transports.
// The provider code may shard one logical prefix into N cache keys for 10+
// total parallelism; inside each final key we still serialize requests because
// Live probes show same-key concurrent WebSockets can randomly miss the
// server prompt cache even after warm-up.
const _openAiPromptCacheLanes = new Map();
const _openAiPromptCacheLaneRates = new Map();
const OPENAI_PROMPT_CACHE_LANE_RATE_WINDOW_MS = 60_000;
const OPENAI_PROMPT_CACHE_LANE_RATE_MAX_KEYS = 4096;

function _positiveInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function _nonNegativeInt(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function _cacheLaneHash(value) {
    return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function _openAiPromptCacheLaneMaxInFlight(sendOpts = {}) {
    return _positiveInt(
        sendOpts?.openaiCacheLaneMaxInFlight
            ?? sendOpts?.promptCacheLaneMaxInFlight
            ?? process.env.MIXDOG_OPENAI_CACHE_LANE_MAX_INFLIGHT
            ?? process.env.MIXDOG_OPENAI_CACHE_MAX_INFLIGHT,
        1,
    );
}

function _openAiPromptCacheLaneQueueTimeoutMs(sendOpts = {}) {
    return _positiveInt(
        sendOpts?.openaiCacheLaneQueueTimeoutMs
            ?? sendOpts?.promptCacheLaneQueueTimeoutMs
            ?? process.env.MIXDOG_OPENAI_CACHE_LANE_QUEUE_TIMEOUT_MS
            ?? process.env.MIXDOG_OPENAI_CACHE_QUEUE_TIMEOUT_MS,
        0,
    );
}

function _openAiPromptCacheLaneRateLimitPerMin(sendOpts = {}) {
    return _nonNegativeInt(
        sendOpts?.openaiCacheLaneRateLimitPerMin
            ?? sendOpts?.promptCacheLaneRateLimitPerMin
            ?? process.env.MIXDOG_OPENAI_CACHE_LANE_RPM
            ?? process.env.MIXDOG_OPENAI_CACHE_KEY_RPM,
        12,
    );
}

function _openAiPromptCacheLaneDeltaRateLimitPerMin(sendOpts = {}) {
    return _nonNegativeInt(
        sendOpts?.openaiCacheLaneDeltaRateLimitPerMin
            ?? sendOpts?.promptCacheLaneDeltaRateLimitPerMin
            ?? process.env.MIXDOG_OPENAI_CACHE_LANE_DELTA_RPM
            ?? process.env.MIXDOG_OPENAI_CACHE_DELTA_RPM,
        60,
    );
}

function _openAiPromptCacheLaneDeltaMaxItems(sendOpts = {}) {
    return _nonNegativeInt(
        sendOpts?.openaiCacheLaneDeltaMaxItems
            ?? sendOpts?.promptCacheLaneDeltaMaxItems
            ?? process.env.MIXDOG_OPENAI_CACHE_LANE_DELTA_MAX_ITEMS
            ?? process.env.MIXDOG_OPENAI_CACHE_DELTA_MAX_ITEMS,
        8,
    );
}

function _openAiPromptCacheLaneDeltaMaxTokens(sendOpts = {}) {
    return _nonNegativeInt(
        sendOpts?.openaiCacheLaneDeltaMaxTokens
            ?? sendOpts?.promptCacheLaneDeltaMaxTokens
            ?? process.env.MIXDOG_OPENAI_CACHE_LANE_DELTA_MAX_TOKENS
            ?? process.env.MIXDOG_OPENAI_CACHE_DELTA_MAX_TOKENS,
        20_000,
    );
}

function _openAiPromptCacheLaneSlowTraceMs(sendOpts = {}) {
    return _positiveInt(
        sendOpts?.openaiCacheLaneSlowTraceMs
            ?? sendOpts?.promptCacheLaneSlowTraceMs
            ?? process.env.MIXDOG_OPENAI_CACHE_LANE_SLOW_MS,
        3000,
    );
}

function _isOpenAiPromptCacheLaneAuth(auth) {
    return auth?.type !== 'xai';
}

function _getOpenAiPromptCacheLaneState(key, maxInFlight) {
    let state = _openAiPromptCacheLanes.get(key);
    if (!state) {
        state = { key, active: 0, queue: [], maxInFlight, nextId: 0 };
        _openAiPromptCacheLanes.set(key, state);
    }
    state.maxInFlight = maxInFlight;
    return state;
}

function _cleanupOpenAiPromptCacheLane(state) {
    if (state.active === 0 && state.queue.length === 0) {
        _openAiPromptCacheLanes.delete(state.key);
    }
}

function _getOpenAiPromptCacheLaneRateState(key) {
    let state = _openAiPromptCacheLaneRates.get(key);
    if (!state) {
        state = { key, starts: [], lastUsedAt: Date.now() };
        _openAiPromptCacheLaneRates.set(key, state);
    }
    state.lastUsedAt = Date.now();
    if (_openAiPromptCacheLaneRates.size > OPENAI_PROMPT_CACHE_LANE_RATE_MAX_KEYS) {
        let oldestKey = null;
        let oldestAt = Infinity;
        for (const [k, v] of _openAiPromptCacheLaneRates) {
            if ((v?.lastUsedAt || 0) < oldestAt) {
                oldestAt = v.lastUsedAt || 0;
                oldestKey = k;
            }
        }
        if (oldestKey) _openAiPromptCacheLaneRates.delete(oldestKey);
    }
    return state;
}

function _pruneOpenAiPromptCacheLaneRateState(state, now = Date.now()) {
    const cutoff = now - OPENAI_PROMPT_CACHE_LANE_RATE_WINDOW_MS;
    while (state.starts.length > 0 && state.starts[0] <= cutoff) state.starts.shift();
    state.lastUsedAt = now;
}

function _sleepWithSignal(ms, signal) {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let timer = null;
        let abortListener = null;
        const cleanup = () => {
            if (timer) clearTimeout(timer);
            if (signal && abortListener) signal.removeEventListener('abort', abortListener);
        };
        abortListener = () => {
            cleanup();
            const reason = signal?.reason;
            reject(reason instanceof Error ? reason : new Error('OpenAI prompt cache lane rate wait aborted'));
        };
        if (signal?.aborted) {
            abortListener();
            return;
        }
        if (signal) signal.addEventListener('abort', abortListener, { once: true });
        timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        timer.unref?.();
    });
}

async function _reserveOpenAiPromptCacheLaneRate({ key, limitPerMin, signal, beforeWait }) {
    if (!limitPerMin || limitPerMin <= 0) {
        return { rateLimitPerMin: 0, rateWaitMs: 0, rateWindowCount: 0 };
    }
    const state = _getOpenAiPromptCacheLaneRateState(key);
    const startedAt = Date.now();
    let beforeWaitCalled = false;
    while (true) {
        const now = Date.now();
        _pruneOpenAiPromptCacheLaneRateState(state, now);
        if (state.starts.length < limitPerMin) {
            state.starts.push(now);
            return {
                rateLimitPerMin: limitPerMin,
                rateWaitMs: now - startedAt,
                rateWindowCount: state.starts.length,
            };
        }
        const waitMs = Math.max(25, state.starts[0] + OPENAI_PROMPT_CACHE_LANE_RATE_WINDOW_MS - now);
        if (!beforeWaitCalled && typeof beforeWait === 'function') {
            beforeWaitCalled = true;
            await beforeWait({
                waitMs,
                rateLimitPerMin: limitPerMin,
                rateWindowCount: state.starts.length,
            });
        }
        await _sleepWithSignal(waitMs, signal);
    }
}

export function _resolveOpenAiPromptCacheRatePolicy(sendOpts = {}, info = {}) {
    const mode = String(info?.mode || '').toLowerCase();
    const frameInputItems = Number(info?.frameInputItems);
    const deltaTokens = Number(info?.deltaTokens);
    const hasPreviousResponseId = info?.hasPreviousResponseId === true;
    const fullLimitPerMin = _openAiPromptCacheLaneRateLimitPerMin(sendOpts);
    const deltaLimitPerMin = _openAiPromptCacheLaneDeltaRateLimitPerMin(sendOpts);
    const deltaMaxItems = _openAiPromptCacheLaneDeltaMaxItems(sendOpts);
    const deltaMaxTokens = _openAiPromptCacheLaneDeltaMaxTokens(sendOpts);
    const itemCount = Number.isFinite(frameInputItems) ? frameInputItems : null;
    const tokenCount = Number.isFinite(deltaTokens) ? deltaTokens : null;
    const smallDeltaItems = itemCount == null || deltaMaxItems <= 0 || itemCount <= deltaMaxItems;
    const smallDeltaTokens = tokenCount == null || deltaMaxTokens <= 0 || tokenCount <= deltaMaxTokens;

    if (mode === 'delta' && hasPreviousResponseId && smallDeltaItems && smallDeltaTokens) {
        return {
            policy: deltaLimitPerMin > 0 ? 'delta_relaxed' : 'delta_unlimited',
            limitPerMin: deltaLimitPerMin,
            fullLimitPerMin,
            deltaLimitPerMin,
            deltaMaxItems,
            deltaMaxTokens,
            frameInputItems: itemCount,
            deltaTokens: tokenCount,
        };
    }

    return {
        policy: mode === 'delta' ? 'delta_guarded' : 'full_guard',
        limitPerMin: fullLimitPerMin,
        fullLimitPerMin,
        deltaLimitPerMin,
        deltaMaxItems,
        deltaMaxTokens,
        frameInputItems: itemCount,
        deltaTokens: tokenCount,
    };
}

function _removeQueuedOpenAiPromptCacheLaneRequest(state, request) {
    const index = state.queue.indexOf(request);
    if (index >= 0) state.queue.splice(index, 1);
    _cleanupOpenAiPromptCacheLane(state);
}

function _releaseOpenAiPromptCacheLane(state) {
    state.active = Math.max(0, state.active - 1);
    while (state.queue.length > 0 && state.active < state.maxInFlight) {
        const next = state.queue.shift();
        next.cleanup?.();
        state.active += 1;
        next.resolve(_makeOpenAiPromptCacheLaneHandle(state, next.requestId, next.enqueuedAt, true));
    }
    _cleanupOpenAiPromptCacheLane(state);
}

function _makeOpenAiPromptCacheLaneHandle(state, requestId, enqueuedAt, queued) {
    let released = false;
    return {
        requestId,
        queued,
        waitedMs: Date.now() - enqueuedAt,
        activeCount: state.active,
        queueDepth: state.queue.length,
        release() {
            if (released) return;
            released = true;
            _releaseOpenAiPromptCacheLane(state);
        },
    };
}

function _acquireOpenAiPromptCacheLane({ key, maxInFlight, signal, timeoutMs }) {
    const state = _getOpenAiPromptCacheLaneState(key, maxInFlight);
    const requestId = ++state.nextId;
    const enqueuedAt = Date.now();
    if (state.active < state.maxInFlight) {
        state.active += 1;
        return Promise.resolve(_makeOpenAiPromptCacheLaneHandle(state, requestId, enqueuedAt, false));
    }
    return new Promise((resolve, reject) => {
        const request = { requestId, enqueuedAt, resolve, reject, cleanup: null, timer: null, abortListener: null };
        const cleanup = () => {
            if (request.timer) clearTimeout(request.timer);
            if (signal && request.abortListener) signal.removeEventListener('abort', request.abortListener);
        };
        request.cleanup = cleanup;
        request.abortListener = () => {
            cleanup();
            _removeQueuedOpenAiPromptCacheLaneRequest(state, request);
            const reason = signal?.reason;
            reject(reason instanceof Error ? reason : new Error('OpenAI prompt cache lane wait aborted'));
        };
        if (signal?.aborted) {
            request.abortListener();
            return;
        }
        if (signal) signal.addEventListener('abort', request.abortListener, { once: true });
        if (timeoutMs > 0) {
            request.timer = setTimeout(() => {
                cleanup();
                _removeQueuedOpenAiPromptCacheLaneRequest(state, request);
                reject(new Error(`OpenAI prompt cache lane wait timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            request.timer.unref?.();
        }
        state.queue.push(request);
    });
}

async function _withOpenAiPromptCacheLane({ auth, cacheKey, sendOpts, poolKey, iteration, traceProvider, useModel, externalSignal }, fn) {
    if (!_isOpenAiPromptCacheLaneAuth(auth) || !cacheKey) {
        return await fn({ enabled: false, maxInFlight: 0 });
    }
    const maxInFlight = _openAiPromptCacheLaneMaxInFlight(sendOpts);
    if (maxInFlight <= 0) {
        return await fn({ enabled: false, maxInFlight: 0 });
    }
    const laneKey = `openai-prompt:${traceProvider || 'openai'}:${useModel || 'default'}:${cacheKey}`;
    const laneKeyHash = _cacheLaneHash(laneKey);
    const state = _getOpenAiPromptCacheLaneState(laneKey, maxInFlight);
    const queued = state.active >= state.maxInFlight;
    if (queued) {
        appendAgentTrace({
            sessionId: poolKey,
            iteration,
            kind: 'cache_lane',
            provider: traceProvider,
            model: useModel,
            event: 'queued',
            lane_key_hash: laneKeyHash,
            max_in_flight: maxInFlight,
            active: state.active,
            queue_depth: state.queue.length,
        });
    }
    const timeoutMs = _openAiPromptCacheLaneQueueTimeoutMs(sendOpts);
    let handle = await _acquireOpenAiPromptCacheLane({ key: laneKey, maxInFlight, signal: externalSignal, timeoutMs });
    let handleActive = true;
    const laneMeta = {
        enabled: true,
        laneKeyHash,
        maxInFlight,
        ratePolicy: 'pending',
        rateLimitPerMin: 0,
        rateWaitMs: 0,
        rateWindowCount: 0,
        rateReleasedForWait: false,
        rateReacquireWaitMs: 0,
        queued: queued || handle.queued === true,
        waitMs: handle.waitedMs,
        activeAfterAcquire: handle.activeCount,
        queueDepthAfterAcquire: handle.queueDepth,
        async reserveRate(info = {}) {
            if (laneMeta.ratePolicy !== 'pending') return laneMeta;
            const policy = _resolveOpenAiPromptCacheRatePolicy(sendOpts, info);
            let releasedForRateWait = false;
            const rateMeta = await _reserveOpenAiPromptCacheLaneRate({
                key: laneKey,
                limitPerMin: policy.limitPerMin,
                signal: externalSignal,
                beforeWait: () => {
                    if (!handleActive) return;
                    handle.release();
                    handleActive = false;
                    releasedForRateWait = true;
                },
            });
            let reacquireWaitMs = 0;
            if (releasedForRateWait) {
                const reacquired = await _acquireOpenAiPromptCacheLane({
                    key: laneKey,
                    maxInFlight,
                    signal: externalSignal,
                    timeoutMs,
                });
                handle = reacquired;
                handleActive = true;
                reacquireWaitMs = reacquired.waitedMs;
                laneMeta.queued = laneMeta.queued || reacquired.queued === true;
                laneMeta.waitMs = (Number(laneMeta.waitMs) || 0) + reacquireWaitMs;
                laneMeta.activeAfterAcquire = reacquired.activeCount;
                laneMeta.queueDepthAfterAcquire = reacquired.queueDepth;
            }
            Object.assign(laneMeta, {
                ratePolicy: policy.policy,
                rateLimitPerMin: rateMeta.rateLimitPerMin,
                rateWaitMs: rateMeta.rateWaitMs,
                rateWindowCount: rateMeta.rateWindowCount,
                rateReleasedForWait: releasedForRateWait,
                rateReacquireWaitMs: reacquireWaitMs,
                rateFullLimitPerMin: policy.fullLimitPerMin,
                rateDeltaLimitPerMin: policy.deltaLimitPerMin,
                rateDeltaMaxItems: policy.deltaMaxItems,
                rateDeltaMaxTokens: policy.deltaMaxTokens,
                ratePolicyFrameInputItems: policy.frameInputItems,
                ratePolicyDeltaTokens: policy.deltaTokens,
            });
            if (rateMeta.rateWaitMs > 0) {
                appendAgentTrace({
                    sessionId: poolKey,
                    iteration,
                    kind: 'cache_lane',
                    provider: traceProvider,
                    model: useModel,
                    event: 'rate_wait',
                    lane_key_hash: laneKeyHash,
                    rate_policy: laneMeta.ratePolicy,
                    rate_limit_per_min: rateMeta.rateLimitPerMin,
                    rate_wait_ms: rateMeta.rateWaitMs,
                    rate_window_count: rateMeta.rateWindowCount,
                    released_for_rate_wait: releasedForRateWait,
                    reacquire_wait_ms: reacquireWaitMs,
                    frame_input_items: policy.frameInputItems,
                    delta_tokens: policy.deltaTokens,
                });
            }
            return laneMeta;
        },
    };
    try {
        return await fn(laneMeta);
    } finally {
        const slowTraceMs = _openAiPromptCacheLaneSlowTraceMs(sendOpts);
        const slowWaitMs = Math.max(Number(laneMeta.rateWaitMs) || 0, Number(laneMeta.waitMs) || 0);
        if (slowTraceMs > 0 && slowWaitMs >= slowTraceMs) {
            appendAgentTrace({
                sessionId: poolKey,
                iteration,
                kind: 'cache_lane_slow',
                provider: traceProvider,
                model: useModel,
                event: laneMeta.rateWaitMs > 0 && laneMeta.waitMs > 0
                    ? 'rate_and_queue_wait'
                    : laneMeta.rateWaitMs > 0
                        ? 'rate_wait'
                        : 'queue_wait',
                lane_key_hash: laneKeyHash,
                payload: {
                    event: laneMeta.rateWaitMs > 0 && laneMeta.waitMs > 0
                        ? 'rate_and_queue_wait'
                        : laneMeta.rateWaitMs > 0
                            ? 'rate_wait'
                            : 'queue_wait',
                    provider: traceProvider,
                    model: useModel,
                    lane_key_hash: laneKeyHash,
                    threshold_ms: slowTraceMs,
                    max_wait_ms: slowWaitMs,
                    rate_policy: laneMeta.ratePolicy,
                    rate_limit_per_min: laneMeta.rateLimitPerMin,
                    rate_wait_ms: laneMeta.rateWaitMs,
                    rate_window_count: laneMeta.rateWindowCount,
                    released_for_rate_wait: laneMeta.rateReleasedForWait,
                    reacquire_wait_ms: laneMeta.rateReacquireWaitMs,
                    rate_full_limit_per_min: laneMeta.rateFullLimitPerMin,
                    rate_delta_limit_per_min: laneMeta.rateDeltaLimitPerMin,
                    rate_delta_max_items: laneMeta.rateDeltaMaxItems,
                    rate_delta_max_tokens: laneMeta.rateDeltaMaxTokens,
                    rate_policy_frame_input_items: laneMeta.ratePolicyFrameInputItems,
                    rate_policy_delta_tokens: laneMeta.ratePolicyDeltaTokens,
                    max_in_flight: laneMeta.maxInFlight,
                    queued: laneMeta.queued,
                    wait_ms: laneMeta.waitMs,
                    active_after_acquire: laneMeta.activeAfterAcquire,
                    queue_depth_after_acquire: laneMeta.queueDepthAfterAcquire,
                },
            });
        }
        if (handleActive) handle.release();
    }
}

function _getPoolArr(poolKey) {
    if (!poolKey) return null;
    let arr = _wsPool.get(poolKey);
    if (!arr) {
        arr = [];
        _wsPool.set(poolKey, arr);
    }
    return arr;
}

function _removeFromPool(poolKey, entry) {
    if (!poolKey) return;
    const arr = _wsPool.get(poolKey);
    if (!arr) return;
    const idx = arr.indexOf(entry);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) _wsPool.delete(poolKey);
}

function _scheduleIdleClose(poolKey, entry) {
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
        if (entry.busy) return;
        try { entry.socket.close(1000, 'idle_timeout'); } catch {}
        _removeFromPool(poolKey, entry);
    }, WS_IDLE_MS);
    try { entry.idleTimer.unref?.(); } catch {}
}

function _clearIdle(entry) {
    if (entry?.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
    }
}

function _isOpen(entry) {
    return entry?.socket?.readyState === WebSocket.OPEN;
}

// Awaited frame send. Asserts the socket is OPEN and resolves only after
// the underlying transport reports the buffered write succeeded (or fails)
// via the WebSocket send callback. Raw `socket.send(JSON.stringify(...))`
// is fire-and-forget — a wedged or half-closed socket silently queues the
// payload and the caller assumes it landed, then later times out waiting
// for a server event that will never arrive. Tag any failure with
// `wsSendFailed=true` so _classifyMidstreamError routes the next attempt
// through a fresh socket.
function _sendFrame(entry, frame) {
    return new Promise((resolve, reject) => {
        const socket = entry?.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            const err = new Error(`WS send: socket not OPEN (readyState=${socket?.readyState ?? 'n/a'})`);
            err.wsSendFailed = true;
            reject(err);
            return;
        }
        let payload;
        try { payload = JSON.stringify(frame); }
        catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            err.wsSendFailed = true;
            reject(err);
            return;
        }
        try {
            // Do NOT await the send callback: on a wedged-but-OPEN socket the
            // ws write callback may never fire, which would hang this Promise
            // before _streamResponse arms its first-byte watchdog. Fire and
            // resolve immediately; transport failures surface via the socket
            // 'error'/'close' handlers and the first-byte watchdog.
            socket.send(payload, () => {});
            resolve();
        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            err.wsSendFailed = true;
            reject(err);
        }
    });
}

function _buildHandshakeHeaders({ auth, sessionToken, turnState, cacheKey: _cacheKey }) {
    // xAI WS: do NOT pin x-grok-conv-id. Measured parallel runs show that
    // forcing a routing shard via that header alternates cold caches across
    // parallel workers; the automatic prompt-prefix cache holds up better
    // when each handshake is unpinned. Reference: vercel/ai xai provider.
    const headers = auth.type === 'xai'
        ? {
            'Authorization': `Bearer ${auth.apiKey}`,
        }
        : auth.type === 'openai-direct'
        ? {
            'Authorization': `Bearer ${auth.apiKey}`,
            'OpenAI-Beta': 'responses_websockets=2026-02-06',
        }
        : {
            'Authorization': `Bearer ${auth.access_token}`,
            'chatgpt-account-id': auth.account_id || '',
            'originator': CODEX_OAUTH_ORIGINATOR,
            'OpenAI-Beta': 'responses_websockets=2026-02-06',
        };
    if (sessionToken) {
        const sid = String(sessionToken);
        headers['session_id'] = sid;
    }
    // x-client-request-id must be a per-request value so server-side request
    // traces stay distinguishable across retries / reconnects sharing the same
    // session_id. Reusing sessionToken (= cacheKey) collapsed every request
    // for the same conversation onto one trace bucket.
    headers['x-client-request-id'] = randomBytes(16).toString('hex');
    if (turnState) headers['x-codex-turn-state'] = turnState;
    return headers;
}

// handshake session_id is the conversation slot openai-oauth uses for in-memory
// prefix state. All orchestrator-internal dispatches for this provider share
// the same cacheKey (built in manager.mjs via providerCacheKey()), so they
// share the server-side prefix-cache shard across roles/sources.
function _mintSessionToken(cacheKey, auth) {
    // xAI's public WebSocket endpoint uses the open connection plus
    // response ids for continuation; unlike openai-oauth, it does not need the
    // OAuth-specific session_id handshake shard.
    if (auth?.type === 'xai') return null;
    return cacheKey || 'mixdog-default';
}

function _openSocket({ auth, sessionToken, turnState, externalSignal, cacheKey }) {
    const headers = _buildHandshakeHeaders({ auth, sessionToken, turnState, cacheKey });
    const baseUrl = auth.type === 'xai'
        ? XAI_WS_URL
        : auth.type === 'openai-direct'
            ? OPENAI_WS_URL
            : CODEX_WS_URL;
    const _wsOpenStart = Date.now();
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] ws-open-start url=${baseUrl} tokenHash=${createHash('sha256').update(String(sessionToken)).digest('hex').slice(0, 8)} ts=${_wsOpenStart}\n`);
    }
    const url = baseUrl + (sessionToken ? `?session_id=${encodeURIComponent(String(sessionToken))}` : '');
    return new Promise((resolve, reject) => {
        let settled = false;
        let abortListener = null;
        let acquireTimer = null;
        const settle = (ok, val) => {
            if (settled) return;
            settled = true;
            if (acquireTimer) {
                clearTimeout(acquireTimer);
                acquireTimer = null;
            }
            if (abortListener && externalSignal) {
                try { externalSignal.removeEventListener('abort', abortListener); } catch {}
            }
            (ok ? resolve : reject)(val);
        };
        const socket = new WebSocket(url, { headers, handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS });
        acquireTimer = setTimeout(() => {
            if (settled) return;
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-open-fail kind=acquire_timeout timeoutMs=${WS_ACQUIRE_TIMEOUT_MS} elapsed=${Date.now() - _wsOpenStart}ms\n`);
            }
            try { socket.terminate(); } catch {}
            settle(false, Object.assign(
                new Error(`${_wsErrLabel(auth?.type === 'xai' ? 'xai' : auth?.type === 'openai-direct' ? 'openai-direct' : 'openai-oauth')} acquire timed out before open (${WS_ACQUIRE_TIMEOUT_MS}ms)`),
                { code: 'EWSACQUIRETIMEOUT', acquireTimeoutMs: WS_ACQUIRE_TIMEOUT_MS },
            ));
        }, WS_ACQUIRE_TIMEOUT_MS);
        try { acquireTimer.unref?.(); } catch {}
        const capturedHeaders = { turnState: null };
        socket.once('upgrade', (res) => {
            try {
                const ts = res?.headers?.['x-codex-turn-state'];
                if (typeof ts === 'string' && ts.length) capturedHeaders.turnState = ts;
            } catch {}
        });
        socket.once('open', () => {
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-open-ok elapsed=${Date.now() - _wsOpenStart}ms\n`);
            }
            settle(true, { socket, turnState: capturedHeaders.turnState });
        });
        socket.once('error', (err) => {
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-open-fail kind=error msg=${String(err?.message || err).slice(0, 120)} elapsed=${Date.now() - _wsOpenStart}ms\n`);
            }
            try { socket.terminate(); } catch {}
            settle(false, err instanceof Error ? err : Object.assign(new Error(errText(err) || 'openai-oauth WS error'), { wsErrorEvent: true, original: err }));
        });
        socket.once('close', (code, reason) => {
            // Half-open handshake: the peer closed before 'open'/'error' fired
            // (TCP RST / TLS edge). Without this the connect Promise never
            // settles and only the 600s outer watchdog can break the stall
            // (observed stage=requesting 601s hang). Open-path closes are
            // no-ops here because settle() has already flipped `settled`.
            if (settled) return;
            try { socket.terminate(); } catch {}
            settle(false, Object.assign(
                new Error(`${_wsErrLabel(auth?.type === 'xai' ? 'xai' : auth?.type === 'openai-direct' ? 'openai-direct' : 'openai-oauth')} handshake closed before open (code=${code})`),
                { wsCloseCode: code, wsCloseReason: (reason && reason.toString) ? reason.toString('utf-8') : '' }));
        });
        socket.once('unexpected-response', (_req, res) => {
            if (settled) return;
            const status = res?.statusCode || 0;
            let body = '';
            res.on('data', c => { if (body.length < 2048) body += c.toString('utf-8'); });
            res.on('end', () => {
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-open-fail kind=http status=${status} body=${body.slice(0, 120)} elapsed=${Date.now() - _wsOpenStart}ms\n`);
                }
                try { socket.terminate(); } catch {}
                settle(false, Object.assign(new Error(`${_wsErrLabel(auth?.type === 'xai' ? 'xai' : auth?.type === 'openai-direct' ? 'openai-direct' : 'openai-oauth')} handshake ${status}: ${body.slice(0, 200)}`), { httpStatus: status, httpBody: body }));
            });
        });
        if (externalSignal) {
            const onAbort = () => {
                try { socket.terminate(); } catch {}
                const reason = externalSignal.reason;
                settle(false, reason instanceof Error ? reason : new Error(`${_wsErrLabel(auth?.type === 'xai' ? 'xai' : auth?.type === 'openai-direct' ? 'openai-direct' : 'openai-oauth')} handshake aborted`));
            };
            if (externalSignal.aborted) { onAbort(); return; }
            abortListener = onAbort;
            externalSignal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

async function acquireWebSocket({ auth, poolKey, cacheKey, forceFresh, externalSignal }) {
    const _acqStart = Date.now();
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] acquire-start poolKey=${poolKey} cacheKey=${cacheKey} forceFresh=${forceFresh} externalAborted=${!!externalSignal?.aborted} ts=${_acqStart}\n`);
    }
    if (externalSignal?.aborted) {
        const reason = externalSignal.reason;
        throw reason instanceof Error ? reason : new Error('OpenAI OAuth WS acquire aborted');
    }
    if (poolKey && !forceFresh) {
        const arr = _wsPool.get(poolKey) || [];
        // Prune dead entries first.
        for (let i = arr.length - 1; i >= 0; i--) {
            if (!_isOpen(arr[i]) || arr[i].closing) {
                _clearIdle(arr[i]);
                arr.splice(i, 1);
            }
        }
        if (arr.length === 0) _wsPool.delete(poolKey);
        // Reuse any idle open entry (cache-warm path).
        const idle = arr.find(e => !e.busy);
        if (idle) {
            _clearIdle(idle);
            idle.busy = true;
            // Defensive: pre-existing pooled entries created before the
            // prefix-hash field was introduced may not have it set. Normalize
            // to null so the first delta check reads a deterministic value
            // (and falls back to full-create instead of silently passing).
            if (idle.lastInputPrefixHash === undefined) idle.lastInputPrefixHash = null;
            if (idle.lastRequestInput === undefined) idle.lastRequestInput = null;
            if (idle.lastResponseItems === undefined) idle.lastResponseItems = null;
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] acquire-reuse poolKey=${poolKey} openSockets=${arr.length} elapsed=${Date.now() - _acqStart}ms\n`);
            }
            return { entry: idle, reused: true };
        }
        // All entries busy and bucket at cap: fall through to ephemeral socket.
        if (arr.length >= MAX_POOLED_SOCKETS_PER_KEY) {
            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] acquire-ephemeral cacheKey=${cacheKey} reason=cap elapsed=${Date.now() - _acqStart}ms\n`);
            }
            const ephSessionToken = _mintSessionToken(cacheKey, auth);
            const { socket, turnState } = await _openSocket({ auth, sessionToken: ephSessionToken, turnState: null, externalSignal, cacheKey });
            // Drain-complete fence: same invariant as the normal acquire path —
            // if drain fired during the await, do NOT push an ephemeral entry
            // back into the pool.
            if (_drainComplete) {
                try { socket.close(1000, 'drain-complete'); } catch {}
                throw new Error('WS pool drained — process exiting');
            }
            const entry = {
                socket,
                busy: true,
                idleTimer: null,
                lastResponseId: null,
                lastRequestSansInput: null,
                lastRequestInput: null,
                lastResponseItems: null,
                lastInputLen: 0,
                lastInputPrefixHash: null,
                turnState: turnState || null,
                closing: false,
                ephemeral: true,
                sessionToken: ephSessionToken,
            };
            socket.on('close', () => { entry.closing = true; });
            return { entry, reused: false };
        }
    }
    // Parallel sockets must not inherit sibling turnState or the openai-oauth server
    // treats the new request as a continuation of another in-flight turn and
    // returns "No tool output found for function call …". turnState only
    // propagates within a single entry across its own iterations.
    const sessionToken = _mintSessionToken(cacheKey, auth);
    if (process.env.MIXDOG_DEBUG_AGENT) {
        process.stderr.write(`[agent-trace] acquire-new tokenHash=${createHash('sha256').update(String(sessionToken)).digest('hex').slice(0, 8)} elapsed=${Date.now() - _acqStart}ms\n`);
    }
    const { socket, turnState } = await _openSocket({ auth, sessionToken, turnState: null, externalSignal, cacheKey });
    const entry = {
        socket,
        busy: true,
        idleTimer: null,
        lastResponseId: null,
        lastRequestSansInput: null,
        lastRequestInput: null,
        lastResponseItems: null,
        lastInputLen: 0,
        lastInputPrefixHash: null,
        turnState: turnState || null,
        closing: false,
        ephemeral: false,
        sessionToken,
    };
    if (poolKey && !forceFresh) _getPoolArr(poolKey).push(entry);
    socket.on('close', () => {
        entry.closing = true;
        _removeFromPool(poolKey, entry);
    });
    return { entry, reused: false };
}

function releaseWebSocket({ entry, poolKey, keep }) {
    if (!entry) return;
    entry.busy = false;
    if (!keep || !_isOpen(entry) || !poolKey || entry.ephemeral) {
        try { entry.socket.close(1000, keep ? 'no_session' : 'release_no_keep'); } catch {}
        _removeFromPool(poolKey, entry);
        return;
    }
    _scheduleIdleClose(poolKey, entry);
}

// Port of pi-mono get_incremental_items: if the cached request (sans input)
// matches the current one and the current input starts with the cached input,
// return only the tail. Otherwise return the full input (fresh turn).
function _sansInput(body) {
    const { input: _ignored, previous_response_id: _prevIgnored, ...rest } = body;
    return rest;
}

function _stableStringify(obj) {
    // Shallow stable-ish: JSON.stringify with sorted top-level keys. Nested
    // arrays (tools, include) are order-sensitive and reflect intent, so we
    // do not sort them.
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return JSON.stringify(obj);
    const keys = Object.keys(obj).sort();
    const parts = [];
    for (const k of keys) parts.push(JSON.stringify(k) + ':' + _stableStringify(obj[k]));
    return '{' + parts.join(',') + '}';
}

function _cloneJson(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function _responseItemKey(item, fallbackIndex = 0) {
    if (!item || typeof item !== 'object') return `primitive:${fallbackIndex}`;
    if (item.id) return `${item.type || 'item'}:id:${item.id}`;
    if (item.call_id) return `${item.type || 'item'}:call:${item.call_id}`;
    try { return `${item.type || 'item'}:json:${_stableStringify(item)}`; } catch {}
    return `${item.type || 'item'}:${fallbackIndex}`;
}

function _normalizeArguments(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
        const trimmed = value.trim();
        try { return _stableStringify(JSON.parse(trimmed || '{}')); } catch { return trimmed; }
    }
    return _stableStringify(value);
}

function _normalizeContentPart(part) {
    if (!part || typeof part !== 'object') return part;
    const type = part.type === 'input_text' ? 'output_text' : part.type;
    if (type === 'output_text') return { type, text: part.text || '' };
    return part;
}

function _contentPartsEqual(a, b) {
    const aa = Array.isArray(a) ? a.map(_normalizeContentPart) : [];
    const bb = Array.isArray(b) ? b.map(_normalizeContentPart) : [];
    return _stableStringify(aa) === _stableStringify(bb);
}

export function _logicalResponseItemMatch(inputItem, responseItem) {
    if (!inputItem || !responseItem) return false;
    const inputType = inputItem.type || (inputItem.role === 'assistant' ? 'message' : '');
    const responseType = responseItem.type || '';
    if (responseType === 'function_call') {
        if (inputType !== 'function_call') return false;
        const inputCallId = String(inputItem.call_id || '');
        const responseCallId = String(responseItem.call_id || '');
        const inputName = String(inputItem.name || '');
        const responseName = String(responseItem.name || '');
        if (inputCallId && responseCallId) {
            // call_id is the server-side anchor. The replayed history may carry
            // locally compacted arguments, but previous_response_id already
            // points at the canonical output item.
            return inputCallId === responseCallId && inputName === responseName;
        }
        return inputName === responseName
            && _normalizeArguments(inputItem.arguments) === _normalizeArguments(responseItem.arguments);
    }
    if (responseType === 'tool_search_call') {
        if (inputType !== 'tool_search_call') return false;
        const inputCallId = String(inputItem.call_id || '');
        const responseCallId = String(responseItem.call_id || '');
        if (inputCallId && responseCallId) return inputCallId === responseCallId;
        return _normalizeArguments(inputItem.arguments) === _normalizeArguments(responseItem.arguments);
    }
    if (responseType === 'custom_tool_call') {
        if (inputType !== 'custom_tool_call') return false;
        const inputCallId = String(inputItem.call_id || '');
        const responseCallId = String(responseItem.call_id || '');
        const inputName = String(inputItem.name || '');
        const responseName = String(responseItem.name || '');
        if (inputCallId && responseCallId) return inputCallId === responseCallId && inputName === responseName;
        return inputName === responseName && String(inputItem.input || '') === String(responseItem.input || '');
    }
    if (responseType === 'message') {
        const inputRole = inputItem.role || (inputType === 'message' ? 'assistant' : '');
        const responseRole = responseItem.role || 'assistant';
        return inputType === 'message'
            && inputRole === responseRole
            && _contentPartsEqual(inputItem.content, responseItem.content);
    }
    if (responseType === 'reasoning') {
        return inputType === 'reasoning'
            && (!!responseItem.id ? inputItem.id === responseItem.id : true)
            && (!!responseItem.encrypted_content
                ? inputItem.encrypted_content === responseItem.encrypted_content
                : true);
    }
    if (responseType === 'web_search_call') {
        return inputType === 'web_search_call'
            && (!!responseItem.id ? inputItem.id === responseItem.id : true)
            && _stableStringify(inputItem.action || null) === _stableStringify(responseItem.action || null);
    }
    if (inputType !== responseType) return false;
    const stripVolatile = (item) => {
        if (!item || typeof item !== 'object') return item;
        const { id: _id, status: _status, ...rest } = item;
        return rest;
    };
    return _stableStringify(stripVolatile(inputItem)) === _stableStringify(stripVolatile(responseItem));
}

function _requestInputItemsMatch(a, b) {
    return _stableStringify(a) === _stableStringify(b);
}

function _stripRequestPrefix(curInput, prevInput) {
    const current = Array.isArray(curInput) ? curInput : [];
    const previous = Array.isArray(prevInput) ? prevInput : [];
    if (current.length < previous.length) return null;
    for (let i = 0; i < previous.length; i += 1) {
        if (!_requestInputItemsMatch(current[i], previous[i])) return null;
    }
    return current.slice(previous.length);
}

function _isReplayLikeHead(item, responseItem) {
    if (!item || !responseItem) return false;
    const inputType = item.type || (item.role === 'assistant' ? 'message' : '');
    const responseType = responseItem.type || '';
    if (responseType === 'message') return inputType === 'message';
    if (responseType === 'function_call') return inputType === 'function_call';
    if (responseType === 'tool_search_call') return inputType === 'tool_search_call';
    return inputType === responseType;
}

function _stripResponseItemsFromHead(items, responseItems) {
    const tail = Array.isArray(items) ? items : [];
    const outputs = Array.isArray(responseItems) ? responseItems : [];
    let cursor = 0;
    let stripped = 0;
    let skipped = 0;
    for (const output of outputs) {
        if (cursor >= tail.length) break;
        if (_logicalResponseItemMatch(tail[cursor], output)) {
            cursor += 1;
            stripped += 1;
            continue;
        }
        if (_isReplayLikeHead(tail[cursor], output)) {
            return {
                ok: false,
                reason: `response_output_mismatch:${output?.type || 'unknown'}`,
                tail,
                stripped,
                skipped,
            };
        }
        skipped += 1;
    }
    return { ok: true, reason: null, tail: tail.slice(cursor), stripped, skipped };
}

function _computeDelta({ entry, body }) {
    if (!entry || !entry.lastRequestSansInput || !entry.lastResponseId) {
        return { mode: 'full', reason: 'no_anchor', frame: { type: 'response.create', ...body } };
    }
    if (!Array.isArray(entry.lastRequestInput)) {
        return { mode: 'full', reason: 'no_input_snapshot', frame: { type: 'response.create', ...body } };
    }
    const curSans = _stableStringify(_sansInput(body));
    if (curSans !== entry.lastRequestSansInput) {
        return { mode: 'full', reason: 'request_properties_changed', frame: { type: 'response.create', ...body } };
    }
    const curInput = Array.isArray(body.input) ? body.input : [];
    const afterPreviousInput = _stripRequestPrefix(curInput, entry.lastRequestInput);
    if (!afterPreviousInput) {
        return { mode: 'full', reason: 'input_prefix_mismatch', frame: { type: 'response.create', ...body } };
    }
    const stripped = _stripResponseItemsFromHead(afterPreviousInput, entry.lastResponseItems);
    if (!stripped.ok) {
        return { mode: 'full', reason: stripped.reason, frame: { type: 'response.create', ...body } };
    }
    return {
        mode: 'delta',
        reason: null,
        strippedResponseItems: stripped.stripped,
        skippedResponseItems: stripped.skipped,
        frame: {
            ...body,
            type: 'response.create',
            previous_response_id: entry.lastResponseId,
            input: stripped.tail,
        },
    };
}

function _estimateFrameTokens(frame) {
    try {
        const s = JSON.stringify(frame);
        return Math.ceil(s.length / 4);
    } catch { return 0; }
}

function _usageNum(value) {
    const n = Number(value || 0);
    return Number.isFinite(n) ? n : 0;
}

function _combineUsageWithWarmup(actual, warmup) {
    if (!warmup) return actual;
    if (!actual) return warmup;
    const actualRaw = actual.raw || {};
    const warmupRaw = warmup.raw || {};
    const actualTicks = _usageNum(actualRaw.cost_in_usd_ticks);
    const warmupTicks = _usageNum(warmupRaw.cost_in_usd_ticks);
    return {
        ...actual,
        inputTokens: _usageNum(actual.inputTokens) + _usageNum(warmup.inputTokens),
        outputTokens: _usageNum(actual.outputTokens) + _usageNum(warmup.outputTokens),
        cachedTokens: _usageNum(actual.cachedTokens) + _usageNum(warmup.cachedTokens),
        promptTokens: _usageNum(actual.promptTokens) + _usageNum(warmup.promptTokens),
        warmupInputTokens: _usageNum(warmup.inputTokens),
        warmupCachedTokens: _usageNum(warmup.cachedTokens),
        warmupOutputTokens: _usageNum(warmup.outputTokens),
        raw: {
            ...actualRaw,
            warmup_usage: warmupRaw,
            ...(actualTicks || warmupTicks ? { cost_in_usd_ticks: actualTicks + warmupTicks } : {}),
        },
    };
}

function _parseEvent(raw) {
    try { return JSON.parse(raw); } catch { return null; }
}

function _incompleteReasonFromEvent(event) {
    const reasonObj = event?.response?.incomplete_details
        || event?.incomplete_details
        || event?.response?.status_details
        || null;
    return String(reasonObj?.reason || event?.response?.status || 'incomplete');
}

function _isMaxOutputIncompleteReason(reason) {
    return /^(?:max_output_tokens|max_tokens|length|output_token_limit)$/i.test(String(reason || '').trim());
}

function _httpStatusFromWsClose(code, reason) {
    const n = Number(code || 0);
    const r = String(reason || '').toLowerCase();
    if (n === 4401
        || /\b(?:unauthorized|unauthorised|authentication|auth(?:enticated?)?|not authenticated|token expired|access token)\b/.test(r)) {
        return 401;
    }
    if (n === 4403 || /\b(?:forbidden|policy|permission denied)\b/.test(r)) return 403;
    if (n === 4429 || /\b(?:rate limit|quota)\b/.test(r)) return 429;
    return 0;
}

function _wsErrLabel(p) {
    if (p === 'xai') return 'xAI WS';
    if (p === 'openai-direct' || p === 'openai') return 'OpenAI WS';
    return 'OpenAI OAuth WS';
}
// tool_search_call.arguments parse. Module-scope (exported) for direct test
// coverage. Native convergence (openai-oauth / anthropic-oauth / opencode): same policy
// as the function_call_arguments.done path and openai-oauth _parseJsonObject —
// object passes through; null/non-string/empty/whitespace → {} (no args); a
// non-empty string that fails JSON.parse is deterministic bad JSON, surfaced
// as an invalid-args MARKER (not silently swallowed to {}) so the dispatch
// loop returns an is_error tool_result and the model self-corrects in the same
// turn.
export function parseToolSearchArgs(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string' || !value.trim()) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
        return makeInvalidToolArgsMarker(value, err instanceof Error ? err.message : String(err));
    }
}
export async function _streamResponse({
    entry,
    externalSignal,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    state,
    logSuppressedReasoningDeltas = true,
    traceProvider = 'openai-oauth',
    _timeouts = null,
}) {
    const errLabel = _wsErrLabel(traceProvider);
    const socket = entry.socket;
    const preResponseCreatedMs = _positiveInt(_timeouts?.preResponseCreatedMs, WS_PRE_RESPONSE_CREATED_MS);
    const firstMeaningfulMs = _positiveInt(_timeouts?.firstMeaningfulMs, WS_FIRST_MEANINGFUL_MS);
    const interChunkMs = _positiveInt(_timeouts?.interChunkMs, WS_INTER_CHUNK_MS);
    const _streamingStart = Date.now();
    let _firstDeltaEmitted = false;
    let content = '';
    let model = '';
    let responseId = '';
    let responseServiceTier = '';
    const toolCalls = [];
    const webSearchCalls = [];
    const webSearchCallKeys = new Set();
    const responseItemsAdded = [];
    const responseItemKeys = new Set();
    const citations = [];
    const citationKeys = new Set();
    const pendingCalls = new Map();
    // Reasoning items collected from response.output_item.done (or salvaged
    // from response.completed.response.output). The request still includes
    // `reasoning.encrypted_content` so the server keeps emitting the blobs,
    // but explicit input-side replay is INTENTIONALLY OMITTED in
    // convertMessagesToResponsesInput (openai-oauth.mjs:233-238) — openai-oauth
    // rejects the same `rs_*` id twice in one handshake session_id with a
    // "Duplicate item" error. Server-side conversation state already carries
    // the prefix forward across the WS_IDLE_MS window. The collected
    // reasoningItems below are surfaced for trace/debugging only; they do
    // not feed back into the next request body.
    const reasoningItems = [];
    let reasoningTextDeltaCount = 0;
    let reasoningSummaryTextDeltaCount = 0;
    let reasoningOtherDeltaCount = 0;
    let reasoningDeltaLogEmitted = false;
    const pushReasoningItem = (item) => {
        if (!item || item.type !== 'reasoning') return;
        if (!item.encrypted_content) return;
        reasoningItems.push({
            id: item.id || '',
            encrypted_content: item.encrypted_content,
            summary: Array.isArray(item.summary) ? item.summary : [],
        });
    };
    const pushResponseItem = (item) => {
        if (!item || typeof item !== 'object') return;
        const key = _responseItemKey(item, responseItemsAdded.length);
        if (responseItemKeys.has(key)) {
            const existing = responseItemsAdded.find((candidate, index) => _responseItemKey(candidate, index) === key);
            if (existing?.type === 'function_call' && item.type === 'function_call') {
                if (!existing.call_id && item.call_id) existing.call_id = item.call_id;
                if (!existing.name && item.name) existing.name = item.name;
                if ((existing.arguments == null || existing.arguments === '') && item.arguments != null) existing.arguments = item.arguments;
            }
            return;
        }
        responseItemKeys.add(key);
        responseItemsAdded.push(_cloneJson(item));
    };
    const enrichFunctionCallResponseItem = ({ itemId = '', callId = '', name = '', argumentsText = '' } = {}) => {
        for (const item of responseItemsAdded) {
            if (item?.type !== 'function_call') continue;
            if (itemId && item.id && item.id !== itemId) continue;
            if (callId && item.call_id && item.call_id !== callId) continue;
            if (!item.call_id && callId) item.call_id = callId;
            if (!item.name && name) item.name = name;
            if ((item.arguments == null || item.arguments === '') && argumentsText) item.arguments = argumentsText;
        }
    };
    const pushCitation = (raw, fallbackTitle = '') => {
        const url = raw?.url || raw?.uri || raw?.href || '';
        if (!url || citationKeys.has(url)) return;
        citationKeys.add(url);
        citations.push({
            title: raw?.title || fallbackTitle || '',
            url,
            snippet: raw?.snippet || raw?.text || raw?.description || '',
            source: 'openai-oauth',
        });
    };
    const pushOutputTextAnnotations = (contentPart) => {
        const annotations = Array.isArray(contentPart?.annotations) ? contentPart.annotations : [];
        for (const annotation of annotations) pushCitation(annotation);
    };
    const pushWebSearchCall = (item) => {
        if (!item || item.type !== 'web_search_call') return;
        let key = item.id || '';
        if (!key) {
            try { key = JSON.stringify(item.action || item); } catch { key = `${webSearchCalls.length}`; }
        }
        if (webSearchCallKeys.has(key)) return;
        webSearchCallKeys.add(key);
        webSearchCalls.push({
            id: item.id || '',
            status: item.status || '',
            action: item.action || null,
        });
        const action = item.action || {};
        if (action.url) pushCitation({ url: action.url, title: action.query || '' });
        if (Array.isArray(action.urls)) {
            for (const url of action.urls) pushCitation({ url, title: action.query || '' });
        }
    };
    const pushCustomToolCall = (item) => {
        const call = customToolCallFromResponseItem(item);
        if (!call || toolCalls.some((existing) => existing.id === call.id)) return;
        toolCalls.push(call);
        midState.emittedToolCall = true;
        try { onToolCall?.(call); } catch {}
    };
    const pushToolSearchCall = (item) => {
        if (!item || item.type !== 'tool_search_call') return;
        const callId = item.call_id || item.id || '';
        if (!callId || toolCalls.some((call) => call.id === callId)) return;
        const call = {
            id: callId,
            name: 'tool_search',
            arguments: parseToolSearchArgs(item.arguments),
            nativeType: 'tool_search_call',
        };
        toolCalls.push(call);
        midState.emittedToolCall = true;
        try { onToolCall?.(call); } catch {}
    };
    const logReasoningDeltaSuppression = () => {
        if (!logSuppressedReasoningDeltas) return;
        const total = reasoningTextDeltaCount + reasoningSummaryTextDeltaCount + reasoningOtherDeltaCount;
        if (reasoningDeltaLogEmitted || total === 0) return;
        reasoningDeltaLogEmitted = true;
        process.stderr.write(`[openai-oauth-ws] suppressed reasoning text deltas from user content count=${total} text=${reasoningTextDeltaCount} summary=${reasoningSummaryTextDeltaCount} other=${reasoningOtherDeltaCount}\n`);
    };
    let usage;
    let stopReason = null;
    let incompleteReason = null;
    let done = false;
    let terminalError = null;
    // Mid-stream retry classifier needs to distinguish "stream died before we
    // even saw response.created" from "stream died after we had a partial
    // response but before completion". Mutate the shared state object so the
    // caller can inspect flags on the error path without us having to attach
    // them manually at every reject site.
    const midState = state || {};
    midState.sawResponseCreated = midState.sawResponseCreated || false;
    midState.sawCompleted = midState.sawCompleted || false;
    midState.wsCloseCode = null;
    midState.responseFailedPayload = null;
    let idleTimer = null;
    let keepaliveTimer = null;
    let abortHandler = null;
    let messageHandler = null;
    let closeHandler = null;
    let errorHandler = null;

    return new Promise((resolve, reject) => {
        // Pre-stream watchdog: the timer fires if the server never sends a
        // first event (response.created) within preResponseCreatedMs
        // after our last frame. The socket is open and the response.create
        // frame was sent, but no server event has come back — a wedged
        // post-upgrade socket. Healthy servers ack within seconds, so this
        // window is intentionally short (~25s). Once response.created (or
        // any other meaningful event) arrives, the timer is cancelled and
        // the longer inter-chunk inactivity watchdog takes over — silent
        // gaps mid-reasoning (openai-oauth spending 50s+ producing reasoning
        // tokens) are normal and should not abort the turn.
        const armPreStreamWatchdog = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-timeout kind=first-byte afterMs=${preResponseCreatedMs}\n`);
                }
                traceWsTimeout('first_byte_timeout', preResponseCreatedMs);
                const err = new Error(`WS stream: no first server event within ${preResponseCreatedMs}ms`);
                // Tag the close code so _classifyMidstreamError sees a 4000
                // (our local pre-stream watchdog code) and routes through
                // the post-upgrade-no-first-event retryable bucket.
                err.wsCloseCode = 4000;
                // Tag the error object itself (not just midState): the warmup
                // path streams under a separate warmupState and rethrows on
                // timeout BEFORE it can copy flags to the outer midState, so the
                // outer catch's _classifyMidstreamError would otherwise see
                // sawResponseCreated=false + close 4000 and hit the pre-created
                // deny gate. err.firstByteTimeout makes both paths retryable.
                err.firstByteTimeout = true;
                midState.firstByteTimeout = true;
                terminalError = err;
                try { socket.close(4000, 'first_byte_timeout'); } catch {}
                // socket.close() may not settle a half-open WS (closeHandler never
                // fires) — reject directly so the turn retries instead of hanging
                // until the 600s watchdog. finish() is idempotent (Promise settles
                // once; cleanup is null-safe).
                finish();
            }, preResponseCreatedMs);
        };
        let interChunkTimer = null;
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
                    elapsed_ms: Date.now() - _streamingStart,
                    model: midState.model || model || null,
                    attempt_index: Number.isFinite(attemptIndex) ? attemptIndex : null,
                    warmup: midState.warmup === true,
                    saw_response_created: midState.sawResponseCreated === true,
                    first_meaningful_seen: firstMeaningfulSeen === true,
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
        const clearPreStreamWatchdog = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }
        };
        const clearFirstMeaningfulWatchdog = () => {
            if (firstMeaningfulTimer) {
                clearTimeout(firstMeaningfulTimer);
                firstMeaningfulTimer = null;
            }
        };
        const armFirstMeaningfulWatchdog = () => {
            if (firstMeaningfulSeen || firstMeaningfulMs <= 0) return;
            clearFirstMeaningfulWatchdog();
            firstMeaningfulTimer = setTimeout(() => {
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-timeout kind=first-meaningful afterMs=${firstMeaningfulMs}\n`);
                }
                traceWsTimeout('first_meaningful_timeout', firstMeaningfulMs);
                const err = new Error(`WS stream: no meaningful output within ${firstMeaningfulMs}ms after response.created`);
                err.wsCloseCode = 4000;
                err.firstMeaningfulTimeout = true;
                midState.firstMeaningfulTimeout = true;
                terminalError = err;
                try { socket.close(4000, 'first_meaningful_timeout'); } catch {}
                finish();
            }, firstMeaningfulMs);
        };
        const resetInterChunk = () => {
            if (interChunkTimer) clearTimeout(interChunkTimer);
            interChunkTimer = setTimeout(() => {
                if (process.env.MIXDOG_DEBUG_AGENT) {
                    process.stderr.write(`[agent-trace] ws-timeout kind=inter-chunk afterMs=${interChunkMs}\n`);
                }
                traceWsTimeout('inter_chunk_timeout', interChunkMs);
                terminalError = new Error(`WS stream: inter-chunk inactivity for ${interChunkMs}ms`);
                try { socket.close(4000, 'inter_chunk_timeout'); } catch {}
                // Same half-open guard as the pre-stream watchdog: reject directly
                // so a stuck socket.close() cannot leave the Promise pending.
                finish();
            }, interChunkMs);
        };
        const onResponseCreated = () => {
            clearPreStreamWatchdog();
            if (!firstMeaningfulSeen) armFirstMeaningfulWatchdog();
            else resetInterChunk();
        };
        // Called on every event that carries real output tokens or tool
        // progress. `response.created` is only an ACK and must not count here:
        // a wedged openai-oauth stream can ACK immediately and then never produce
        // text/reasoning/tool deltas, holding the prompt-cache lane for the
        // full inter-chunk window.
        const onMeaningfulOutput = () => {
            if (!firstMeaningfulSeen) {
                firstMeaningfulSeen = true;
                clearPreStreamWatchdog();
                clearFirstMeaningfulWatchdog();
            }
            resetInterChunk();
        };
        // resetIdle kept for compat; metadata frames no longer disarm pre-stream watchdog.
        const resetIdle = () => { /* noop — only onMeaningfulOutput() disarms */ };
        const cleanup = () => {
            if (idleTimer) clearTimeout(idleTimer);
            clearFirstMeaningfulWatchdog();
            if (interChunkTimer) { clearTimeout(interChunkTimer); interChunkTimer = null; }
            if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
            if (messageHandler) socket.off('message', messageHandler);
            if (closeHandler) socket.off('close', closeHandler);
            if (errorHandler) socket.off('error', errorHandler);
            if (abortHandler && externalSignal) externalSignal.removeEventListener('abort', abortHandler);
        };
        const finish = () => {
            logReasoningDeltaSuppression();
            cleanup();
            if (terminalError) { reject(terminalError); return; }
            resolve({
                content,
                model,
                reasoningItems: reasoningItems.length ? reasoningItems : undefined,
                responseItems: responseItemsAdded.length ? responseItemsAdded : undefined,
                toolCalls: toolCalls.length ? toolCalls : undefined,
                citations: citations.length ? citations : undefined,
                webSearchCalls: webSearchCalls.length ? webSearchCalls : undefined,
                usage,
                stopReason: stopReason || undefined,
                incompleteReason: incompleteReason || undefined,
                responseId: responseId || undefined,
                serviceTier: responseServiceTier || undefined,
            });
        };

        messageHandler = (data) => {
            resetIdle();
            // Do NOT call onStreamDelta for every frame — metadata/keepalive frames
            // must not reset the agent stall watchdog's lastStreamDeltaAt. Only
            // meaningful output (text delta / tool call) updates that timestamp.
            const text = typeof data === 'string' ? data : data.toString('utf-8');
            const event = _parseEvent(text);
            if (!event) return;
            if (event.error) {
                const err = new Error(event.error.message || 'Responses WS error');
                try {
                    err.payload = event.error;
                    populateHttpStatusFromMessage(err);
                } catch {}
                terminalError = err;
                finish();
                return;
            }
            if (typeof event.type !== 'string') return;
            switch (event.type) {
                case 'response.created':
                    midState.sawResponseCreated = true;
                    if (event.response?.model) model = event.response.model;
                    if (event.response?.id) responseId = event.response.id;
                    // Server ack: cancel only the pre-created watchdog. Keep
                    // a separate first-meaningful watchdog armed until real
                    // model progress arrives.
                    onResponseCreated();
                    break;
                case 'response.output_text.delta':
                    content += event.delta || '';
                    try {
                        if (!_firstDeltaEmitted) {
                            _firstDeltaEmitted = true;
                            if (process.env.MIXDOG_DEBUG_AGENT) {
                                process.stderr.write(`[agent-trace] ws-first-delta sinceStreaming=${Date.now() - _streamingStart}ms\n`);
                            }
                        }
                        onStreamDelta?.();
                    } catch {}
                    // Live text relay (gateway): forward the raw text chunk so
                    // the client renders first tokens before the final replay.
                    // Tool-call/argument deltas intentionally stay off this path.
                    // Invariant: once a non-empty chunk has been relayed live it
                    // cannot be withdrawn, so flag the attempt so a later
                    // mid-stream/truncated failure is NOT retried (retry would
                    // concatenate a second attempt onto rendered text).
                    if (event.delta && onTextDelta) {
                        if (state) state.emittedText = true;
                        try { onTextDelta(event.delta); } catch {}
                    }
                    onMeaningfulOutput();
                    break;
                case 'response.reasoning_text.delta':
                case 'response.reasoning_summary_text.delta':
                    if (event.type === 'response.reasoning_text.delta') reasoningTextDeltaCount += 1;
                    else reasoningSummaryTextDeltaCount += 1;
                    // Reasoning text is live model progress — refresh
                    // lastStreamDeltaAt so stream-watchdog does not flag a
                    // long reasoning span as a stall. It also counts as
                    // liveness for the local pre-stream / inter-chunk
                    // watchdogs: a long reasoning span without any
                    // output_text delta would otherwise trip the
                    // first-meaningful timer and abort an otherwise healthy
                    // stream. Reasoning is still suppressed from user
                    // content (no `content +=` here) — only the watchdog
                    // timers are reset.
                    try { onStreamDelta?.(); } catch {}
                    onMeaningfulOutput();
                    break;
                case 'response.output_item.added':
                    if (event.item?.type === 'function_call') {
                        pendingCalls.set(event.item.id || '', {
                            name: event.item.name || '',
                            callId: event.item.call_id || '',
                        });
                        onMeaningfulOutput();
                    }
                    break;
                case 'response.function_call_arguments.delta':
                    try { onStreamDelta?.(); } catch {}
                    onMeaningfulOutput();
                    break;
                case 'response.custom_tool_call_input.delta':
                    try { onStreamDelta?.(); } catch {}
                    onMeaningfulOutput();
                    break;
                case 'response.function_call_arguments.done': {
                    const itemId = event.item_id || '';
                    const pending = pendingCalls.get(itemId);
                    // function_call_arguments.done is a completion signal:
                    // empty/whitespace → no args ({}); a non-empty string that
                    // fails JSON.parse is deterministic bad JSON. Native
                    // convergence: surface an invalid-args MARKER (not silent
                    // {}) so the dispatch loop returns an is_error tool_result
                    // and the model re-issues valid JSON in the same turn.
                    let args = {};
                    {
                        const _argText = typeof event.arguments === 'string' ? event.arguments : '';
                        if (_argText.trim() !== '') {
                            try {
                                args = JSON.parse(_argText);
                            } catch (err) {
                                args = makeInvalidToolArgsMarker(_argText, err instanceof Error ? err.message : String(err));
                            }
                        }
                    }
                    enrichFunctionCallResponseItem({
                        itemId,
                        callId: pending?.callId || event.call_id || '',
                        name: pending?.name || event.name || '',
                        argumentsText: event.arguments || JSON.stringify(args),
                    });
                    if (pending?.callId && pending?.name) {
                        const call = { id: pending.callId, name: pending.name, arguments: args };
                        toolCalls.push(call);
                        midState.emittedToolCall = true;
                        try { onToolCall?.(call); } catch {}
                    } else {
                        // Synthesizing a `tc_${Date.now()}` callId here would
                        // make the next turn fail to match the model's
                        // function_call_output reference. Defer instead and
                        // salvage call_id/name from the final
                        // response.completed.output bundle below. If salvage
                        // also fails we fail the stream explicitly — masking
                        // the gap with a synthetic id just shifts the failure
                        // one turn later under a confusing "No tool output
                        // found for function call" error.
                        toolCalls.push({
                            id: pending?.callId || '',
                            name: pending?.name || '',
                            arguments: args,
                            _pendingItemId: itemId,
                            _deferred: true,
                        });
                    }
                    try { onStreamDelta?.(); } catch {}
                    onMeaningfulOutput();
                    break;
                }
                case 'response.output_item.done':
                    pushResponseItem(event.item);
                    // function_call / output_text already captured via their
                    // dedicated streaming events. The one shape we still need
                    // here is `reasoning` — carries encrypted_content that
                    // must be replayed on the next input to keep the openai-oauth
                    // server-side prompt cache prefix warm.
                    if (event.item?.type === 'reasoning') pushReasoningItem(event.item);
                    if (event.item?.type === 'web_search_call') pushWebSearchCall(event.item);
                    if (event.item?.type === 'tool_search_call') {
                        pushToolSearchCall(event.item);
                        onMeaningfulOutput();
                    }
                    if (event.item?.type === 'custom_tool_call') {
                        pushCustomToolCall(event.item);
                        onMeaningfulOutput();
                    }
                    break;
                case 'response.completed': {
                    const completedServiceTier = event.response?.service_tier || event.response?.serviceTier || '';
                    if (completedServiceTier) responseServiceTier = String(completedServiceTier);
                    if (event.response?.usage) {
                        const u = event.response.usage;
                        const rawUsage = responseServiceTier
                            ? { ...u, service_tier: responseServiceTier }
                            : u;
                        usage = {
                            inputTokens: u.input_tokens || 0,
                            outputTokens: u.output_tokens || 0,
                            cachedTokens: extractCachedTokens(u),
                            // openai-oauth reports input_tokens as the total
                            // prompt volume (cached portion is a subset, not
                            // additive). Alias into the cross-provider
                            // `promptTokens` field so downstream loggers have
                            // uniform semantics.
                            promptTokens: u.input_tokens || 0,
                            raw: rawUsage,
                        };
                    }
                    if (!model && event.response?.model) model = event.response.model;
                    if (!responseId && event.response?.id) responseId = event.response.id;
                    if (event.response?.output) {
                        for (const item of event.response.output) {
                            pushResponseItem(item);
                            if (!content && item.type === 'message') {
                                for (const c of item.content || []) {
                                    if (c.type === 'output_text') {
                                        content += c.text || '';
                                        pushOutputTextAnnotations(c);
                                    }
                                }
                            }
                            if (item.type === 'message') {
                                for (const c of item.content || []) {
                                    if (c.type === 'output_text') pushOutputTextAnnotations(c);
                                }
                            }
                            if (item.type === 'web_search_call') pushWebSearchCall(item);
                            if (item.type === 'tool_search_call') pushToolSearchCall(item);
                            if (item.type === 'custom_tool_call') pushCustomToolCall(item);
                            // Salvage path: some streams emit reasoning only
                            // inside the final response.completed.output
                            // bundle (no per-item .done event). Dedup by id.
                            if (item.type === 'reasoning'
                                && !reasoningItems.some(r => r.id === item.id)) {
                                pushReasoningItem(item);
                            }
                            // Salvage path for function_call: when
                            // arguments.done fired before (or without) a
                            // matching output_item.added, the deferred tool
                            // call placeholder has empty id/name. The
                            // completed.output bundle carries the canonical
                            // call_id/name; fill them in and emit onToolCall.
                            if (item.type === 'function_call') {
                                const tc = toolCalls.find(
                                    (t) => t._deferred && t._pendingItemId === (item.id || ''),
                                );
                                if (tc) {
                                    if (!tc.id && item.call_id) tc.id = item.call_id;
                                    if (!tc.name && item.name) tc.name = item.name;
                                    if (tc.id && tc.name) {
                                        delete tc._deferred;
                                        delete tc._pendingItemId;
                                        midState.emittedToolCall = true;
                                        try { onToolCall?.(tc); } catch {}
                                    }
                                }
                            }
                        }
                    }
                    // Salvage validation. Any deferred call still missing
                    // id/name would propagate to the next turn as a
                    // function_call_output the server can't anchor. Fail the
                    // stream now so the caller sees a deterministic error
                    // instead of a cryptic mismatch one turn later.
                    const unresolved = toolCalls.find((t) => t._deferred);
                    if (unresolved) {
                        terminalError = new Error(
                            `${errLabel} function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`,
                        );
                        finish();
                        break;
                    }
                    midState.sawCompleted = true;
                    done = true;
                    finish();
                    break;
                }
                case 'response.done': {
                    // response.done is the terminal frame for some openai-oauth
                    // streams that never emit a separate response.completed.
                    // Route through the same completed/failed/incomplete
                    // normalization based on event.response.status so a
                    // server-side abort (incomplete / failed) does not slip
                    // through as success. status === 'completed' falls
                    // through to the success path with sawCompleted set;
                    // anything else is converted into a terminal error.
                    const status = event.response?.status || '';
                    if (status === 'failed') {
                        midState.responseFailedPayload = event;
                        const msg = event.response?.error?.message
                            || event.error?.message
                            || event.message
                            || 'response.done failed';
                        terminalError = Object.assign(
                            new Error(`${errLabel} response.done failed: ${msg}`),
                            { responseFailed: event },
                        );
                        populateHttpStatusFromMessage(terminalError, msg);
                        done = true;
                        finish();
                        break;
                    }
                    if (status === 'incomplete') {
                        const reasonStr = _incompleteReasonFromEvent(event);
                        if (_isMaxOutputIncompleteReason(reasonStr)) {
                            incompleteReason = reasonStr;
                            stopReason = 'length';
                            midState.sawCompleted = true;
                            done = true;
                            finish();
                            break;
                        }
                        terminalError = Object.assign(
                            new Error(`${errLabel} response.done incomplete: ${reasonStr}`),
                            { responseIncomplete: event, incompleteReason: reasonStr },
                        );
                        done = true;
                        finish();
                        break;
                    }
                    if (status && status !== 'completed') {
                        terminalError = Object.assign(
                            new Error(`${errLabel} response.done unexpected status: ${status}`),
                            { responseDoneStatus: status },
                        );
                        done = true;
                        finish();
                        break;
                    }
                    midState.sawCompleted = true;
                    done = true;
                    finish();
                    break;
                }
                case 'response.incomplete': {
                    // Most incomplete reasons are real failures. max_output_tokens
                    // maps cleanly to Anthropic's stop_reason=max_tokens; treating
                    // it as an error makes Claude retry the same over-budget turn.
                    const reasonStr = _incompleteReasonFromEvent(event);
                    if (_isMaxOutputIncompleteReason(reasonStr)) {
                        incompleteReason = reasonStr;
                        stopReason = 'length';
                        midState.sawCompleted = true;
                        done = true;
                        finish();
                        break;
                    }
                    terminalError = Object.assign(
                        new Error(`${errLabel} response.incomplete: ${reasonStr}`),
                        { responseIncomplete: event, incompleteReason: reasonStr },
                    );
                    finish();
                    break;
                }
                case 'response.failed': {
                    // Stash the payload so the mid-stream classifier can sniff
                    // network_error / stream_disconnected without re-parsing.
                    midState.responseFailedPayload = event;
                    const msg = event.response?.error?.message
                        || event.error?.message
                        || event.message
                        || 'response.failed';
                    terminalError = Object.assign(new Error(`${errLabel} response.failed: ${msg}`), {
                        responseFailed: event,
                    });
                    // Sniff the server message for transient/auth/permanent
                    // hints so the handshake / mid-stream retry classifiers
                    // can route by httpStatus. Without this, server-side
                    // events like "Our servers are currently overloaded"
                    // surfaced as unclassified errors and skipped the
                    // 5xx retry bucket entirely.
                    populateHttpStatusFromMessage(terminalError, msg);
                    finish();
                    break;
                }
                case 'error': {
                    const errMsg = String(event.message || event.error?.message || 'unknown');
                    terminalError = new Error(`${errLabel} error: ${errMsg}`);
                    populateHttpStatusFromMessage(terminalError, errMsg);
                    finish();
                    break;
                }
                default:
                    // Catch any other reasoning-delta variants (e.g.
                    // `response.reasoning.<sub>.delta`) so they are counted
                    // and suppressed, never reaching the user content buffer.
                    if (typeof event.type === 'string'
                        && event.type.startsWith('response.reasoning')
                        && event.type.endsWith('.delta')) {
                        reasoningOtherDeltaCount += 1;
                    }
                    // Trace-only events (response.in_progress, etc.)
                    break;
            }
        };
        closeHandler = (code, reason) => {
            if (done) return;
            midState.wsCloseCode = code;
            if (!terminalError) {
                const r = reason?.toString?.('utf-8') || '';
                const httpStatus = _httpStatusFromWsClose(code, r);
                terminalError = Object.assign(
                    new Error(`OpenAI OAuth WS closed before response.completed (code=${code}${r ? `, reason=${r}` : ''})`),
                    { wsCloseCode: code, wsCloseReason: r, ...(httpStatus ? { httpStatus } : {}) },
                );
            } else if (terminalError && !terminalError.wsCloseCode) {
                try { terminalError.wsCloseCode = code; } catch {}
                try { terminalError.httpStatus = terminalError.httpStatus || _httpStatusFromWsClose(code, reason?.toString?.('utf-8') || ''); } catch {}
            }
            finish();
        };
        errorHandler = (err) => {
            if (done) return;
            const wrapped = err instanceof Error ? err : new Error(String(err));
            if (terminalError) {
                // Preserve the first terminalError; chain the later socket
                // error in via `cause` (or `suppressed` if cause already set)
                // so diagnostics keep the original failure visible.
                try {
                    if (!terminalError.cause) terminalError.cause = wrapped;
                    else {
                        const list = Array.isArray(terminalError.suppressed)
                            ? terminalError.suppressed
                            : [];
                        list.push(wrapped);
                        terminalError.suppressed = list;
                    }
                } catch {}
            } else {
                terminalError = wrapped;
            }
            try { socket.close(4001, 'stream_error'); } catch {}
            finish();
        };
        if (externalSignal) {
            abortHandler = () => {
                if (done) return;
                const reason = externalSignal.reason;
                terminalError = reason instanceof Error ? reason : new Error('OpenAI OAuth WS aborted by session close');
                // Tag: was this a user/caller abort, or a watchdog abort?
                // Mid-stream retry must skip user aborts but may retry watchdog
                // aborts. The caller-owned AbortController surfaces through
                // externalSignal; the agent stall watchdog signals via a reason
                // object whose name === 'AgentStallAbortError'. stream-watchdog
                // uses StreamStalledAbortError. Anything else → treat as user.
                const reasonName = reason?.name || '';
                if (reasonName === 'AgentStallAbortError'
                    || reasonName === 'StreamStalledAbortError') {
                    midState.watchdogAbort = reasonName;
                } else {
                    midState.userAbort = true;
                }
                try { socket.close(4002, 'aborted'); } catch {}
                finish();
            };
            if (externalSignal.aborted) { abortHandler(); return; }
            externalSignal.addEventListener('abort', abortHandler, { once: true });
        }
        socket.on('message', messageHandler);
        socket.on('close', closeHandler);
        socket.on('error', errorHandler);
        armPreStreamWatchdog();
        // Periodic client-side WS ping while the stream is active. The server's
        // server closes with 1011 "keepalive ping timeout" when it thinks the
        // peer is silent during long reasoning windows where no data frames
        // flow. Sending a ping every 10s from our side keeps the socket warm.
        // The interval is unref'd so it never holds the event loop open, and
        // cleanup() clears it on every terminal path (completed / close /
        // error / abort / mid-stream retry teardown).
        keepaliveTimer = setInterval(() => {
            try {
                if (socket.readyState !== WebSocket.OPEN) return;
                socket.ping();
            } catch {}
        }, 10_000);
        try { keepaliveTimer.unref?.(); } catch {}
    });
}

/**
 * Classify a handshake error for retry eligibility.
 *
 * Default-deny: anything we don't recognize as transient returns null (treat
 * as permanent). Permanent buckets (401/403/404/429) also return null — the
 * server has made a deterministic decision that a retry can't change.
 *
 * Returns one of:
 *   'timeout' — `ws` handshakeTimeout fired
 *   'reset'   — ECONNRESET / socket hang up
 *   'dns'     — EAI_AGAIN / ENOTFOUND / EAI_NODATA
 *   'refused' — ECONNREFUSED
 *   'network' — ENETUNREACH / EHOSTUNREACH / EPIPE
 *   'acquire_timeout' — hard client-side open/acquire deadline fired
 *   'http_5xx' (with specific status e.g. 'http_503') — server overload
 *   null      — not retryable
 */
// Thin re-export wrapper: handshake classification now lives in the shared
// retry-classifier (classifyHandshakeError). Kept here as a named export so
// internal call sites (_acquireWithRetry) and any external importer keep
// resolving the same symbol.
export function _classifyHandshakeError(err) {
    return classifyHandshakeError(err);
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
 *   'first_meaningful_timeout' — server ACKed response.created, then emitted
 *                          no real text/reasoning/tool progress before the
 *                          first-meaningful deadline.
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
 *   - HTTP 401 / 403 / 429 surfaced on the error
 *   - state.attemptIndex has reached the classifier-specific retry budget
 */
// Thin wrapper: the full WS mid-stream decision tree now lives in the shared
// classifyMidstreamError (retry-classifier.mjs, policy.mode='ws'). Kept as a
// named export so internal call sites and any external importer keep resolving
// the same symbol. Behavior is byte-identical — the shared function is the
// relocated original, with the per-classifier budget gating supplied by
// WS_MIDSTREAM_POLICY (transientCloseRetries=4, defaultRetries=2).
export function _classifyMidstreamError(err, state) {
    return classifyMidstreamError(err, state, WS_MIDSTREAM_POLICY);
}

// Per-classifier retry budget, used by the sendViaWebSocket loop to bound the
// attempt count once classifyMidstreamError returns a bucket. Mirrors the
// shared _midstreamLimitFor(ws) — the numbers come from MIDSTREAM_RETRY_POLICY.
function _midstreamRetryLimit(classifier) {
    return classifier === 'ws_1006' || classifier === 'ws_1011'
        ? MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT
        : MIDSTREAM_DEFAULT_RETRY_LIMIT;
}

function _midstreamBackoffFor(retryNumber) {
    const raw = MIDSTREAM_BACKOFF_MS[Math.min(Math.max(retryNumber, 1), MIDSTREAM_BACKOFF_MS.length) - 1];
    return jitterDelayMs(raw);
}

function _backoffFor(attempt) {
    // attempt is 1-based. retry 1 → 500, retry 2 → 1000, retry 3 → 2000 … capped.
    const raw = HANDSHAKE_BACKOFF_BASE_MS * (1 << (attempt - 1));
    return jitterDelayMs(Math.min(raw, HANDSHAKE_BACKOFF_CAP_MS));
}

const _defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Abort-aware backoff sleep → shared sleepWithAbort (retry-classifier.mjs). The
// abortMessage preserves the prior fallback text when the abort reason is not an
// Error; _sleepFn (test seam) is threaded through as the no-signal sleep impl.
function _sleepWithAbort(ms, externalSignal, sleepFn = _defaultSleep) {
    return sleepWithAbort(ms, externalSignal, sleepFn, 'OpenAI OAuth WS retry backoff aborted');
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
export async function _acquireWithRetry({
    auth,
    poolKey,
    cacheKey,
    forceFresh,
    onRetry,
    externalSignal,
    _acquire = acquireWebSocket,
    _sleepFn = _defaultSleep,
} = {}) {
    let lastErr = null;
    let lastClassifier = null;
    for (let attempt = 1; attempt <= HANDSHAKE_MAX_ATTEMPTS; attempt++) {
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
            return await _acquire({ auth, poolKey, cacheKey, forceFresh, externalSignal });
        } catch (err) {
            lastErr = err;
            const classifier = _classifyHandshakeError(err);
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
            if (attempt >= HANDSHAKE_MAX_ATTEMPTS) {
                if (err && typeof err === 'object') {
                    try { err.attempts = attempt; } catch {}
                    try { err.retryClassifier = classifier; } catch {}
                }
                try {
                    process.stderr.write(
                        `[openai-oauth-ws] handshake failed after ${attempt}/${HANDSHAKE_MAX_ATTEMPTS} attempts: ${err?.message || err}\n`,
                    );
                } catch {}
                throw err;
            }
            // Schedule backoff and emit progress.
            const backoff = _backoffFor(attempt);
            try {
                process.stderr.write(
                    `[openai-oauth-ws] worker retry ${attempt}/${HANDSHAKE_MAX_ATTEMPTS} (transient: ${classifier}, backoff ${backoff}ms)\n`,
                );
            } catch {}
            try {
                onRetry?.({
                    attempt,
                    max: HANDSHAKE_MAX_ATTEMPTS,
                    classifier,
                    backoffMs: backoff,
                    error: err,
                });
            } catch {}
            // Sleep is abort-aware: an abort during backoff rejects immediately
            // instead of burning the remaining wait.
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
    // Test seams (undefined in production). Let the unit test drive the
    // retry state machine without opening real sockets or touching the
    // handshake-retry layer.
    _acquireWithRetryFn = _acquireWithRetry,
    _streamFn = _streamResponse,
    _sendFrameFn = _sendFrame,
    _sleepFn = _defaultSleep,
}) {
    // Bounded mid-stream retry: if an attempt's stream dies after
    // response.created but before response.completed from a transient cause
    // (watchdog abort / ws 1006/1011/1012/4000 / response.failed with network
    // error), tear down the socket and reissue the full request from scratch
    // with a classifier-specific budget. ws_1006/ws_1011 get two retries with
    // 250ms/1s backoff; other legacy transient buckets keep the prior one retry.
    // No delta resume — content restarts, which is the accepted tradeoff for
    // reviewer/worker flows that need the complete answer.
    // Retries are layered ABOVE the handshake retry loop (_acquireWithRetry
    // owns connect-level transience); the two never interleave because we
    // force a brand-new acquire for the retry attempt.
    const MAX_MIDSTREAM_RETRIES = MIDSTREAM_WS_TRANSIENT_RETRY_LIMIT;
    let firstAttemptError = null;
    let firstAttemptClassifier = null;
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
    const emittedProgress = [];

    return await _withOpenAiPromptCacheLane({
        auth,
        cacheKey,
        sendOpts,
        poolKey,
        iteration,
        traceProvider,
        useModel,
        externalSignal,
    }, async (promptCacheLane) => {
    for (let attemptIndex = 0; attemptIndex <= MAX_MIDSTREAM_RETRIES; attemptIndex++) {
        const handshakeStart = Date.now();
        let acquired;
        let handshakeRetries = 0;
        const handshakeRetryClassifiers = [];
        try { onStageChange?.('requesting'); } catch {}
        try {
            acquired = await _acquireWithRetryFn({
                auth,
                poolKey,
                cacheKey,
                // Retry attempt must not reuse a pooled socket — the prior
                // one is either torn down or in an unknown state.
                forceFresh: forceFresh || attemptIndex > 0,
                externalSignal,
                onRetry: (info) => {
                    handshakeRetries += 1;
                    if (info?.classifier) handshakeRetryClassifiers.push(info.classifier);
                },
            });
        } catch (err) {
            const classifier = err?.retryClassifier || (err?.code === 'EWSACQUIRETIMEOUT' ? 'acquire_timeout' : null);
            const classifiers = [...handshakeRetryClassifiers];
            if (classifier && !classifiers.includes(classifier)) classifiers.push(classifier);
            if (err?.httpStatus != null || classifier || handshakeRetries > 0 || classifiers.length > 0) {
                traceAgentFetch({
                    sessionId: poolKey,
                    headersMs: Date.now() - handshakeStart,
                    httpStatus: Number(err?.httpStatus || 0),
                    provider: traceProvider,
                    model: useModel,
                    transport: 'websocket',
                    handshakeRetries: err?.attempts ? Math.max(Number(err.attempts) - 1, 0) : handshakeRetries,
                    handshakeRetryClassifiers: classifiers,
                });
            }
            // Handshake-layer failure. Don't double-wrap: if this is the retry
            // attempt, surface the ORIGINAL first-attempt error (which is what
            // the caller's turn actually tripped on).
            if (attemptIndex > 0 && firstAttemptError) {
                try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                throw _stampTool(_stampLiveText(firstAttemptError));
            }
            throw _stampTool(_stampLiveText(err));
        }
        const { entry, reused } = acquired;
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
            headersMs: Date.now() - handshakeStart,
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
        let result;
        const streamTimeouts = null;
        try {
            if (warmupBody && typeof warmupBody === 'object' && attemptIndex === 0) {
                await promptCacheLane?.reserveRate?.({
                    mode: 'full',
                    frameInputItems: Array.isArray(warmupBody.input) ? warmupBody.input.length : null,
                    deltaTokens: _estimateFrameTokens({ type: 'response.create', ...warmupBody }),
                    hasPreviousResponseId: false,
                });
                const warmupFrame = { type: 'response.create', ...warmupBody };
                await _sendFrameFn(entry, warmupFrame);
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
                entry.lastResponseId = warmupResult.responseId;
                entry.lastRequestSansInput = _stableStringify(_sansInput(warmupBody));
                const warmupInputArr = Array.isArray(warmupBody.input) ? warmupBody.input : [];
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
                    appendAgentTrace({
                        sessionId: poolKey,
                        iteration,
                        kind: 'cache_warmup',
                        ...warmupPayload,
                        payload: warmupPayload,
                    });
                } catch {}
                requestBody = { ...body, previous_response_id: warmupResult.responseId };
                delete requestBody.instructions;
                delete requestBody.generate;
                entry.lastRequestSansInput = _stableStringify(_sansInput({
                    ...requestBody,
                    input: warmupInputArr,
                }));
            }

            const delta = _computeDelta({ entry, body: requestBody });
            ({ mode, frame } = delta);
            deltaReason = delta.reason || null;
            strippedResponseItems = delta.strippedResponseItems || 0;
            skippedResponseItems = delta.skippedResponseItems || 0;
            deltaTokens = _estimateFrameTokens(frame);
            await promptCacheLane?.reserveRate?.({
                mode,
                frameInputItems: Array.isArray(frame.input) ? frame.input.length : null,
                deltaTokens,
                hasPreviousResponseId: typeof frame.previous_response_id === 'string' && frame.previous_response_id.length > 0,
            });

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
            await _sendFrameFn(entry, frame);

            if (process.env.MIXDOG_DEBUG_AGENT) {
                process.stderr.write(`[agent-trace] ws-streaming-start sinceAcquire=${Date.now() - handshakeStart}ms\n`);
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
            });
        } catch (err) {
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
            _stampLiveText(err);
            _stampTool(err);
            const classifier = _classifyMidstreamError(err, midState);
            const retryLimit = classifier ? _midstreamRetryLimit(classifier) : 0;
            if (classifier && attemptIndex < retryLimit) {
                // Retry-eligible: stash the first-attempt error, emit progress,
                // and loop. The subsequent acquire uses forceFresh so no socket
                // is shared between attempts.
                firstAttemptError = err;
                firstAttemptClassifier = classifier;
                try { err.midstreamClassifier = classifier; } catch {}
                const retryNumber = attemptIndex + 1;
                const backoff = _midstreamBackoffFor(retryNumber);
                try {
                    const line = `[openai-oauth-ws] mid-stream recovered: retry ${retryNumber}/${retryLimit} (cause: ${classifier}, backoff ${backoff}ms)\n`;
                    process.stderr.write(line);
                    emittedProgress.push(line);
                } catch {}
                await _sleepWithAbort(backoff, externalSignal, _sleepFn);
                continue;
            }
            // Not retryable, OR we've already exhausted the retry budget.
            if (attemptIndex > 0 && firstAttemptError) {
                // Exhausted path: surface the first-attempt error (the one
                // the user's turn actually tripped on), tag actual retry count.
                try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
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
                throw _stampTool(_stampLiveText(firstAttemptError));
            }
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
        const keepSocket = true;

        // Update cache state for the next iteration in this session. openai-oauth
        // keeps the previous response anchor even when the model emitted tool
        // calls: the next request is previous input + server output items
        // + tool results, and _computeDelta strips the first two parts so the
        // WebSocket frame only sends the true new tail.
        if (result.responseId && keepResponseChain) {
            entry.lastResponseId = result.responseId;
            entry.lastRequestSansInput = _stableStringify(_sansInput(requestBody));
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

        if (warmupResult?.usage) {
            result.usage = _combineUsageWithWarmup(result.usage, warmupResult.usage);
        }

        const requestedServiceTier = body?.service_tier || null;
        const responseServiceTier = result.serviceTier || result.usage?.raw?.service_tier || null;
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
        });
        // Extra WS-specific observability: transport + per-iteration delta bytes.
        try {
            const transportCacheKeyHash = cacheKey
                ? createHash('sha256').update(String(cacheKey)).digest('hex').slice(0, 12)
                : null;
            const transportPayload = {
                provider: traceProvider,
                transport: 'websocket',
                ws_mode: mode,
                ws_pre_response_created_timeout_ms: WS_PRE_RESPONSE_CREATED_MS,
                ws_first_meaningful_timeout_ms: WS_FIRST_MEANINGFUL_MS,
                ws_inter_chunk_timeout_ms: WS_INTER_CHUNK_MS,
                iteration_delta_tokens: deltaTokens,
                reused_connection: reused,
                requested_service_tier: requestedServiceTier,
                response_service_tier: responseServiceTier,
                handshake_retries: handshakeRetries,
                handshake_retry_classifiers: handshakeRetryClassifiers,
                midstream_retries: attemptIndex,
                response_id: result.responseId || null,
                cache_key_hash: transportCacheKeyHash,
                cache_lane_enabled: promptCacheLane?.enabled === true,
                cache_lane_key_hash: promptCacheLane?.laneKeyHash || null,
                cache_lane_rate_policy: promptCacheLane?.ratePolicy || null,
                cache_lane_max_in_flight: Number.isFinite(Number(promptCacheLane?.maxInFlight)) ? Number(promptCacheLane.maxInFlight) : null,
                cache_lane_rate_limit_per_min: Number.isFinite(Number(promptCacheLane?.rateLimitPerMin)) ? Number(promptCacheLane.rateLimitPerMin) : null,
                cache_lane_rate_full_limit_per_min: Number.isFinite(Number(promptCacheLane?.rateFullLimitPerMin)) ? Number(promptCacheLane.rateFullLimitPerMin) : null,
                cache_lane_rate_delta_limit_per_min: Number.isFinite(Number(promptCacheLane?.rateDeltaLimitPerMin)) ? Number(promptCacheLane.rateDeltaLimitPerMin) : null,
                cache_lane_rate_wait_ms: Number.isFinite(Number(promptCacheLane?.rateWaitMs)) ? Number(promptCacheLane.rateWaitMs) : null,
                cache_lane_rate_window_count: Number.isFinite(Number(promptCacheLane?.rateWindowCount)) ? Number(promptCacheLane.rateWindowCount) : null,
                cache_lane_rate_released_for_wait: promptCacheLane?.rateReleasedForWait === true,
                cache_lane_rate_reacquire_wait_ms: Number.isFinite(Number(promptCacheLane?.rateReacquireWaitMs)) ? Number(promptCacheLane.rateReacquireWaitMs) : null,
                cache_lane_wait_ms: Number.isFinite(Number(promptCacheLane?.waitMs)) ? Number(promptCacheLane.waitMs) : null,
                cache_lane_queued: promptCacheLane?.queued === true,
                cache_lane_active: Number.isFinite(Number(promptCacheLane?.activeAfterAcquire)) ? Number(promptCacheLane.activeAfterAcquire) : null,
                cache_lane_queue_depth: Number.isFinite(Number(promptCacheLane?.queueDepthAfterAcquire)) ? Number(promptCacheLane.queueDepthAfterAcquire) : null,
                request_has_previous_response_id: typeof frame.previous_response_id === 'string' && frame.previous_response_id.length > 0,
                chain_delta_reason: mode === 'delta' ? null : deltaReason,
                chain_stripped_response_items: strippedResponseItems,
                chain_skipped_response_items: skippedResponseItems,
                chain_response_items: Array.isArray(result.responseItems) ? result.responseItems.length : 0,
                body_input_items: Array.isArray(requestBody.input) ? requestBody.input.length : null,
                frame_input_items: Array.isArray(frame.input) ? frame.input.length : null,
                frame_has_instructions: typeof frame.instructions === 'string' && frame.instructions.length > 0,
                warmup_used: !!warmupResult,
                warmup_response_id: warmupResult?.responseId || null,
                tool_call_count: resultToolCallCount,
                keep_socket: keepSocket,
                keep_response_chain: keepResponseChain,
            };
            appendAgentTrace({
                sessionId: poolKey,
                iteration,
                kind: 'transport',
                ...transportPayload,
                payload: transportPayload,
            });
            if (mode !== 'delta' || deltaReason) {
                appendAgentTrace({
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
                        cache_key_hash: transportCacheKeyHash,
                        cache_lane_key_hash: promptCacheLane?.laneKeyHash || null,
                        request_has_previous_response_id: transportPayload.request_has_previous_response_id,
                        chain_stripped_response_items: strippedResponseItems,
                        chain_skipped_response_items: skippedResponseItems,
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
        const { responseId: _ignored, responseItems: _responseItemsIgnored, ...out } = result;
        if (includeResponseId && result.responseId) out.responseId = result.responseId;
        if (warmupResult) {
            try {
                Object.defineProperty(out, '__warmup', {
                    value: {
                        requestBody,
                        responseId: warmupResult.responseId,
                        usage: warmupResult.usage,
                    },
                    enumerable: false,
                });
            } catch {}
        }
        // Leave a breadcrumb on the result so downstream callers can observe
        // that a retry was used (0 = first-try success, up to 2 for ws_1006/1011).
        try { Object.defineProperty(out, '__midstreamRetries', { value: attemptIndex, enumerable: false }); } catch {}
        return out;
    }
    // Unreachable — the loop either returns or throws above.
    throw _stampTool(_stampLiveText(firstAttemptError || new Error('sendViaWebSocket: unreachable')));
    });
}

// Drain-complete fence — set true once _closeAllPooledSockets runs so any
// in-flight acquire that resumes after drain throws instead of pushing a
// fresh socket into the cleared pool. Single-set, process-lifetime invariant.
let _drainComplete = false;

// Drain hook — self-registered exit drain.
// Force-closes pooled sockets and fences subsequent acquires.
// `drainOpenaiWsPool` alias matches the registry's `drain*` naming convention;
// `_closeAllPooledSockets` kept for backward compat with existing call sites.
export function _closeAllPooledSockets(reason = 'shutdown') {
    _drainComplete = true;
    for (const arr of _wsPool.values()) {
        for (const entry of arr) {
            try { entry.socket.close(1000, reason); } catch {}
        }
    }
    _wsPool.clear();
}
export const drainOpenaiWsPool = _closeAllPooledSockets;
process.on('exit', drainOpenaiWsPool);
