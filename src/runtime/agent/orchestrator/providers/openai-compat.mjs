import { createRequire } from 'node:module';
import { createHash } from 'crypto';
import { loadConfig } from '../config.mjs';
import { shouldFallbackTransport, withRetry } from './retry-classifier.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import {
    consumeCompatChatCompletionStream,
    consumeCompatResponsesStream,
    parseCompletedToolCallArgumentsJson,
} from './openai-compat-stream.mjs';
import { enrichModels, getModelMetadataSync } from './model-catalog.mjs';
import { appendAgentTrace, traceAgentUsage } from '../agent-trace.mjs';
import {
    resolveProviderCacheKey,
    resolveProviderPromptCacheLane,
} from '../agent-runtime/cache-strategy.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_GENERATE_TOTAL_TIMEOUT_MS,
    createTimeoutSignal,
    createPassthroughSignal,
    resolveTimeoutMs,
} from '../stall-policy.mjs';
import { traceHash, stableTraceStringify, summarizeTraceTools, traceTextShape } from './trace-utils.mjs';
import {
    normalizeContentForOpenAIChat,
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIChat,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';
import {
    customToolCallFromResponseItem,
} from './custom-tool-wire.mjs';
import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';

const requireOpenAI = createRequire(import.meta.url);
let _OpenAI = null;

function loadOpenAI() {
    if (!_OpenAI) {
        const mod = requireOpenAI('openai');
        _OpenAI = mod.default || mod.OpenAI || mod;
    }
    return _OpenAI;
}
export { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
const PRESETS = OPENAI_COMPAT_PRESETS;
const MODEL_LIST_TIMEOUT_MS = resolveTimeoutMs(
    'MIXDOG_COMPAT_MODEL_LIST_TIMEOUT_MS',
    10_000,
    { minMs: 1_000, maxMs: PROVIDER_GENERATE_TOTAL_TIMEOUT_MS },
);

// SSRF guard for provider baseURL. config.baseURL comes from user JSON;
// reject non-http(s) schemes (file:/data:/ftp:/etc.) and require https for
// any non-localhost host. Localhost-only presets (ollama, lmstudio) and
// loopback hosts may use http. Throws a clear config error — no silent
// fallback — so misconfig surfaces immediately instead of leaking apiKey.
function assertSafeBaseURL(rawURL, providerName) {
    let parsed;
    try {
        parsed = new URL(String(rawURL));
    } catch {
        throw new Error(`[provider:${providerName}] invalid baseURL: ${rawURL}`);
    }
    const scheme = parsed.protocol.toLowerCase();
    if (scheme !== 'https:' && scheme !== 'http:') {
        throw new Error(`[provider:${providerName}] baseURL scheme not allowed: ${parsed.protocol} (only http/https)`);
    }
    if (scheme === 'http:') {
        const host = parsed.hostname.toLowerCase();
        const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        if (!isLocal) {
            throw new Error(`[provider:${providerName}] baseURL must use https for non-localhost host (got ${parsed.protocol}//${parsed.hostname})`);
        }
    }
    return rawURL;
}


function summarizeTraceMessages(messages) {
    const summaries = (messages || []).map((m, index) => {
        const content = typeof m?.content === 'string'
            ? { type: 'text', ...traceTextShape(m.content) }
            : { type: m?.content == null ? 'null' : typeof m.content, hash: traceHash(stableTraceStringify(m?.content ?? null)) };
        const toolCalls = Array.isArray(m?.tool_calls)
            ? m.tool_calls.map(tc => ({
                name: tc?.function?.name || null,
                argsHash: traceHash(tc?.function?.arguments || ''),
            }))
            : [];
        return {
            index,
            role: m?.role || null,
            content,
            ...(typeof m?.reasoning_content === 'string'
                ? { reasoningContent: traceTextShape(m.reasoning_content) }
                : {}),
            toolCallCount: toolCalls.length,
            ...(toolCalls.length ? { toolCalls } : {}),
        };
    });
    if (summaries.length <= 12) return summaries;
    return [
        ...summaries.slice(0, 8),
        { omittedTurns: summaries.length - 12 },
        ...summaries.slice(-4),
    ];
}


function extractCompatCachedTokens(usage) {
    const candidates = [
        usage?.prompt_tokens_details?.cached_tokens,
        usage?.input_tokens_details?.cached_tokens,
        usage?.prompt_cache_hit_tokens,
        usage?.cached_prompt_text_tokens,
    ];
    for (const v of candidates) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) return n;
    }
    for (const v of candidates) {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return 0;
}

function positiveTokenInt(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function resolveCompatMaxOutputTokens(opts = {}) {
    return positiveTokenInt(
        opts.maxOutputTokens
        ?? opts.outputTokens
        ?? opts.max_output_tokens
        ?? opts.maxTokens
        ?? opts.max_tokens,
    );
}

function xaiPrefixSeed({ opts, params, rawTools, model }) {
    const providerKey = resolveProviderCacheKey(opts, 'xai');
    const systemMessages = (params?.messages || [])
        .filter(m => m?.role === 'system')
        .map(m => String(m?.content ?? ''));
    return stableTraceStringify({
        scope: 'xai-prefix-model-system-tools',
        providerKey: String(providerKey),
        model: model || null,
        systemMessages,
        tools: summarizeTraceTools(rawTools),
    });
}

function xaiCacheRouting(opts, params, rawTools, model) {
    const sessionId = String(opts?.sessionId || opts?.session?.id || '').trim();
    const providerKey = resolveProviderCacheKey(opts, 'xai');
    const prefixSeed = xaiPrefixSeed({ opts, params, rawTools, model });
    const prefixHash = traceHash(prefixSeed);
    const routingSeed = stableTraceStringify({
        scope: 'xai-chat-session-v1',
        providerKey: String(providerKey),
        model: model || null,
        sessionId: sessionId || `ephemeral:${process.pid}`,
    });
    return {
        key: deterministicUuidFromKey(routingSeed),
        mode: sessionId ? 'session' : 'ephemeral',
        seedHash: traceHash(routingSeed),
        prefixHash,
        ownerSessionHash: sessionId ? traceHash(sessionId) : null,
    };
}

function xaiResponsesCacheRouting(opts, params, rawTools, model) {
    // Default to 'prefix' so parallel workers sharing the same model + system
    // + tools land on a common prompt_cache_key, letting xAI's server-side
    // prefix cache hit across sessions instead of cold-starting per worker.
    // Override with 'session' (env or opts) for legacy session-isolated lanes.
    const scope = String(opts?.xaiResponsesCacheScope || process.env.MIXDOG_XAI_RESPONSES_CACHE_SCOPE || 'prefix')
        .trim()
        .toLowerCase();
    if (scope !== 'prefix') {
        return xaiCacheRouting(opts, params, rawTools, model);
    }
    const sessionId = String(opts?.sessionId || opts?.session?.id || '').trim();
    const providerKey = resolveProviderCacheKey(opts, 'xai');
    const prefixSeed = xaiPrefixSeed({ opts, params, rawTools, model });
    const prefixHash = traceHash(prefixSeed);
    const routingSeed = stableTraceStringify({
        scope: 'xai-responses-prefix-v1',
        providerKey: String(providerKey),
        model: model || null,
        prefixHash,
    });
    return {
        key: deterministicUuidFromKey(routingSeed),
        mode: 'prefix',
        seedHash: traceHash(routingSeed),
        prefixHash,
        ownerSessionHash: sessionId ? traceHash(sessionId) : null,
    };
}

function normalizeXaiReasoningEffort(value) {
    const effort = String(value || '').trim().toLowerCase();
    return ['none', 'low', 'medium', 'high'].includes(effort) ? effort : null;
}

function opencodeGoReasoningEffortValues(modelInfo) {
    const effort = (modelInfo?.reasoningOptions || []).find((option) => option?.type === 'effort');
    return Array.isArray(effort?.values)
        ? effort.values.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
        : [];
}

function normalizeOpencodeGoReasoningEffort(value, modelInfo) {
    const allowed = opencodeGoReasoningEffortValues(modelInfo);
    if (!allowed.length) return null;
    const effort = String(value || '').trim().toLowerCase();
    if (allowed.includes(effort)) return effort;
    if ((effort === 'max' || effort === 'xhigh') && allowed.includes('max')) return 'max';
    if (['high', 'medium', 'low'].includes(effort) && allowed.includes('high')) return 'high';
    return null;
}

function useXaiResponsesApi(opts, config) {
    const raw = opts?.xaiApiMode
        ?? config?.apiMode
        ?? config?.xaiApiMode
        ?? process.env.MIXDOG_XAI_API_MODE
        ?? process.env.MIXDOG_XAI_RESPONSES;
    if (raw == null || raw === '') return true;
    const mode = String(raw).trim().toLowerCase();
    return !['0', 'false', 'off', 'chat', 'chat-completions', 'chat_completions'].includes(mode);
}

function useXaiResponsesWebSocket(opts, config) {
    const raw = opts?.xaiResponsesTransport
        ?? opts?.xaiTransport
        ?? config?.responsesTransport
        ?? config?.transport
        ?? process.env.MIXDOG_XAI_RESPONSES_TRANSPORT
        ?? process.env.MIXDOG_XAI_TRANSPORT;
    if (raw == null || raw === '') return true;
    const transport = String(raw).trim().toLowerCase();
    return !['0', 'false', 'off', 'http', 'https', 'responses-http', 'sdk'].includes(transport);
}

function _envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

// xAI WS→HTTP transport fallback → shared shouldFallbackTransport
// (retry-classifier.mjs). Identical deny-order + allow-list; the per-provider
// env flag is computed here and passed via `enabled`.
function _shouldFallbackXaiWsToHttp(err, signal) {
    return shouldFallbackTransport(err, {
        signal,
        enabled: _envFlag('MIXDOG_XAI_WS_HTTP_FALLBACK', true),
    });
}

function useXaiResponsesWebSocketWarmup(opts, config, { previousResponseId, instructions, rawTools }) {
    if (previousResponseId) return false;
    const raw = opts?.xaiResponsesWarmup
        ?? opts?.xaiWsWarmup
        ?? config?.responsesWarmup
        ?? config?.wsWarmup
        ?? process.env.MIXDOG_XAI_RESPONSES_WARMUP
        ?? process.env.MIXDOG_XAI_WS_WARMUP;
    if (raw != null && raw !== '') {
        const mode = String(raw).trim().toLowerCase();
        if (['0', 'false', 'off', 'none', 'disabled'].includes(mode)) return false;
        if (['1', 'true', 'on', 'always', 'force'].includes(mode)) return true;
    }
    return String(instructions || '').length >= 2048 || (Array.isArray(rawTools) && rawTools.length >= 10);
}

// Match OpenAI OAuth/API cache-lane semantics: default to 12 stable shards (via
// resolveProviderPromptCacheLane) and serialize each final shard. This gives
// Grok/xAI 10+ worker fanout without concurrent same-key cache contention.
const XAI_RESPONSES_CACHE_LANE_DEFAULT_MAX_IN_FLIGHT = 1;
const xaiResponsesCacheLanes = new Map();

function parseXaiPositiveInt(value, fallback) {
    if (value == null || value === '') return fallback;
    const text = String(value).trim().toLowerCase();
    if (['0', 'false', 'off', 'none', 'disabled', 'unlimited', 'unbounded', 'auto'].includes(text)) return 0;
    const n = Number(text);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.floor(n));
}

function xaiResponsesCacheLaneMaxInFlight(opts, config) {
    return parseXaiPositiveInt(
        opts?.xaiCacheMaxInFlight
            ?? opts?.xaiResponsesCacheMaxInFlight
            ?? opts?.grokCacheMaxInFlight
            ?? opts?.grokResponsesCacheMaxInFlight
            ?? config?.xaiCacheMaxInFlight
            ?? config?.xaiResponsesCacheMaxInFlight
            ?? config?.grokCacheMaxInFlight
            ?? config?.grokResponsesCacheMaxInFlight
            ?? process.env.MIXDOG_XAI_CACHE_MAX_INFLIGHT
            ?? process.env.MIXDOG_XAI_RESPONSES_CACHE_MAX_INFLIGHT
            ?? process.env.MIXDOG_GROK_CACHE_MAX_INFLIGHT
            ?? process.env.MIXDOG_GROK_RESPONSES_CACHE_MAX_INFLIGHT
            ?? process.env.MIXDOG_GROK_OAUTH_CACHE_MAX_INFLIGHT
            ?? process.env.MIXDOG_GROK_OAUTH_RESPONSES_CACHE_MAX_INFLIGHT,
        XAI_RESPONSES_CACHE_LANE_DEFAULT_MAX_IN_FLIGHT,
    );
}

function xaiResponsesCacheLaneQueueTimeoutMs(opts, config) {
    return parseXaiPositiveInt(
        opts?.xaiCacheQueueTimeoutMs
            ?? opts?.xaiResponsesCacheQueueTimeoutMs
            ?? opts?.grokCacheQueueTimeoutMs
            ?? opts?.grokResponsesCacheQueueTimeoutMs
            ?? config?.xaiCacheQueueTimeoutMs
            ?? config?.xaiResponsesCacheQueueTimeoutMs
            ?? config?.grokCacheQueueTimeoutMs
            ?? config?.grokResponsesCacheQueueTimeoutMs
            ?? process.env.MIXDOG_XAI_CACHE_QUEUE_TIMEOUT_MS
            ?? process.env.MIXDOG_XAI_RESPONSES_CACHE_QUEUE_TIMEOUT_MS
            ?? process.env.MIXDOG_GROK_CACHE_QUEUE_TIMEOUT_MS
            ?? process.env.MIXDOG_GROK_RESPONSES_CACHE_QUEUE_TIMEOUT_MS
            ?? process.env.MIXDOG_GROK_OAUTH_CACHE_QUEUE_TIMEOUT_MS
            ?? process.env.MIXDOG_GROK_OAUTH_RESPONSES_CACHE_QUEUE_TIMEOUT_MS,
        0,
    );
}

function xaiResponsesPromptCacheLane(opts, config, cacheRouting) {
    const shardOverride =
        opts?.xaiCacheLaneShards
            ?? opts?.xaiResponsesCacheLaneShards
            ?? opts?.xaiCacheMaxParallel
            ?? opts?.xaiResponsesCacheMaxParallel
            ?? opts?.grokCacheLaneShards
            ?? opts?.grokResponsesCacheLaneShards
            ?? opts?.grokCacheMaxParallel
            ?? opts?.grokResponsesCacheMaxParallel
            ?? config?.xaiCacheLaneShards
            ?? config?.xaiResponsesCacheLaneShards
            ?? config?.xaiCacheMaxParallel
            ?? config?.xaiResponsesCacheMaxParallel
            ?? config?.grokCacheLaneShards
            ?? config?.grokResponsesCacheLaneShards
            ?? config?.grokCacheMaxParallel
            ?? config?.grokResponsesCacheMaxParallel
            ?? process.env.MIXDOG_XAI_RESPONSES_CACHE_MAX_PARALLEL
            ?? process.env.MIXDOG_XAI_RESPONSES_CACHE_LANE_SHARDS
            ?? process.env.MIXDOG_GROK_CACHE_MAX_PARALLEL
            ?? process.env.MIXDOG_GROK_CACHE_LANE_SHARDS
            ?? process.env.MIXDOG_GROK_RESPONSES_CACHE_MAX_PARALLEL
            ?? process.env.MIXDOG_GROK_RESPONSES_CACHE_LANE_SHARDS
            ?? process.env.MIXDOG_GROK_OAUTH_CACHE_MAX_PARALLEL
            ?? process.env.MIXDOG_GROK_OAUTH_CACHE_LANE_SHARDS
            ?? process.env.MIXDOG_GROK_OAUTH_RESPONSES_CACHE_MAX_PARALLEL
            ?? process.env.MIXDOG_GROK_OAUTH_RESPONSES_CACHE_LANE_SHARDS;
    const autoOverride =
        opts?.xaiCacheLaneAuto
            ?? opts?.xaiResponsesCacheLaneAuto
            ?? opts?.grokCacheLaneAuto
            ?? opts?.grokResponsesCacheLaneAuto
            ?? config?.xaiCacheLaneAuto
            ?? config?.xaiResponsesCacheLaneAuto
            ?? config?.grokCacheLaneAuto
            ?? config?.grokResponsesCacheLaneAuto
            ?? process.env.MIXDOG_XAI_RESPONSES_CACHE_LANE_AUTO
            ?? process.env.MIXDOG_GROK_CACHE_LANE_AUTO
            ?? process.env.MIXDOG_GROK_RESPONSES_CACHE_LANE_AUTO
            ?? process.env.MIXDOG_GROK_OAUTH_CACHE_LANE_AUTO
            ?? process.env.MIXDOG_GROK_OAUTH_RESPONSES_CACHE_LANE_AUTO;
    const slotOverride =
        opts?.xaiCacheLaneSlot
            ?? opts?.xaiResponsesCacheLaneSlot
            ?? opts?.grokCacheLaneSlot
            ?? opts?.grokResponsesCacheLaneSlot;
    const seed = String(
        opts?.xaiCacheLaneSeed
            ?? opts?.xaiResponsesCacheLaneSeed
            ?? opts?.grokCacheLaneSeed
            ?? opts?.grokResponsesCacheLaneSeed
            ?? opts?.promptCacheLaneSeed
            ?? opts?.sessionId
            ?? opts?.session?.id
            ?? cacheRouting?.ownerSessionHash
            ?? cacheRouting?.key
            ?? '',
    );
    return resolveProviderPromptCacheLane('xai', {
        ...opts,
        ...(shardOverride !== undefined ? { promptCacheLaneShards: shardOverride } : {}),
        ...(autoOverride !== undefined ? { promptCacheLaneAuto: autoOverride } : {}),
        ...(slotOverride !== undefined ? { promptCacheLaneSlot: slotOverride } : {}),
        promptCacheLaneSeed: seed || 'xai-cache-lane',
    }, config);
}

function xaiResponsesCacheLaneKey({ model, cacheRouting, opts, config }) {
    const prefix = cacheRouting?.prefixHash || cacheRouting?.seedHash || cacheRouting?.key || 'unknown-prefix';
    const lane = xaiResponsesPromptCacheLane(opts, config, cacheRouting);
    const shard = Number.isFinite(Number(lane?.slot)) ? Number(lane.slot) : 0;
    return {
        key: `xai-responses:${model || 'default'}:${prefix}:shard-${shard}`,
        shard,
        lane,
    };
}

function getXaiResponsesCacheLaneState(key, maxInFlight) {
    let state = xaiResponsesCacheLanes.get(key);
    if (!state) {
        state = { key, active: 0, queue: [], maxInFlight, nextId: 0 };
        xaiResponsesCacheLanes.set(key, state);
    }
    state.maxInFlight = maxInFlight;
    return state;
}

function cleanupXaiResponsesCacheLane(state) {
    if (state.active === 0 && state.queue.length === 0) {
        xaiResponsesCacheLanes.delete(state.key);
    }
}

function removeQueuedXaiCacheLaneRequest(state, request) {
    const index = state.queue.indexOf(request);
    if (index >= 0) state.queue.splice(index, 1);
    cleanupXaiResponsesCacheLane(state);
}

function makeXaiCacheLaneHandle(state, requestId, enqueuedAt) {
    let released = false;
    return {
        requestId,
        waitedMs: Date.now() - enqueuedAt,
        activeCount: state.active,
        queueDepth: state.queue.length,
        release() {
            if (released) return;
            released = true;
            releaseXaiResponsesCacheLane(state);
        },
    };
}

function releaseXaiResponsesCacheLane(state) {
    state.active = Math.max(0, state.active - 1);
    while (state.queue.length > 0 && state.active < state.maxInFlight) {
        const next = state.queue.shift();
        next.cleanup?.();
        state.active += 1;
        next.resolve(makeXaiCacheLaneHandle(state, next.requestId, next.enqueuedAt));
    }
    cleanupXaiResponsesCacheLane(state);
}

function acquireXaiResponsesCacheLane({ key, maxInFlight, signal, timeoutMs }) {
    const state = getXaiResponsesCacheLaneState(key, maxInFlight);
    const requestId = ++state.nextId;
    const enqueuedAt = Date.now();
    if (state.active < state.maxInFlight) {
        state.active += 1;
        return Promise.resolve(makeXaiCacheLaneHandle(state, requestId, enqueuedAt));
    }
    return new Promise((resolve, reject) => {
        const request = {
            requestId,
            enqueuedAt,
            resolve,
            reject,
            cleanup: null,
        };
        const cleanup = () => {
            if (request.timer) clearTimeout(request.timer);
            if (signal && request.abortListener) signal.removeEventListener('abort', request.abortListener);
        };
        request.cleanup = cleanup;
        request.abortListener = () => {
            cleanup();
            removeQueuedXaiCacheLaneRequest(state, request);
            const reason = signal?.reason;
            reject(reason instanceof Error ? reason : new Error('xAI cache lane wait aborted'));
        };
        if (signal?.aborted) {
            request.abortListener();
            return;
        }
        if (signal) signal.addEventListener('abort', request.abortListener, { once: true });
        if (timeoutMs > 0) {
            request.timer = setTimeout(() => {
                cleanup();
                removeQueuedXaiCacheLaneRequest(state, request);
                reject(new Error(`xAI cache lane wait timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            request.timer.unref?.();
        }
        state.queue.push(request);
    });
}

function traceXaiCacheLane(opts, payload) {
    if (!compatCacheTraceEnabled('xai')) return;
    try {
        appendAgentTrace({
            sessionId: opts?.sessionId || opts?.session?.id || null,
            iteration: Number.isFinite(Number(opts?.iteration)) ? Number(opts.iteration) : null,
            kind: 'cache_lane',
            ...payload,
            payload,
        });
    } catch {}
}

async function withXaiResponsesCacheLane({ opts, config, cacheRouting, model, transport, previousResponseId, inputCount, signal }, fn) {
    const maxInFlight = xaiResponsesCacheLaneMaxInFlight(opts, config);
    if (maxInFlight <= 0) {
        const laneMeta = { enabled: false, maxInFlight: 0 };
        return { value: await fn(laneMeta), laneMeta };
    }
    const { key: laneKey, shard, lane } = xaiResponsesCacheLaneKey({ model, cacheRouting, opts, config });
    const timeoutMs = xaiResponsesCacheLaneQueueTimeoutMs(opts, config);
    const state = getXaiResponsesCacheLaneState(laneKey, maxInFlight);
    const queued = state.active >= state.maxInFlight;
    if (queued) {
        traceXaiCacheLane(opts, {
            provider: 'xai',
            api: 'responses',
            transport,
            event: 'queued',
            lane_key_hash: traceHash(laneKey),
            lane_shard: shard,
            lane_shards: Number.isFinite(Number(lane?.shards)) ? Number(lane.shards) : null,
            lane_auto: lane?.auto === true,
            lane_seed_hash: lane?.seedHash || null,
            max_in_flight: maxInFlight,
            active: state.active,
            queue_depth: state.queue.length,
            previous_response_used: !!previousResponseId,
            input_count: inputCount,
        });
    }
    const handle = await acquireXaiResponsesCacheLane({ key: laneKey, maxInFlight, signal, timeoutMs });
    const laneMeta = {
        enabled: true,
        laneKeyHash: traceHash(laneKey),
        shard,
        shards: Number.isFinite(Number(lane?.shards)) ? Number(lane.shards) : null,
        auto: lane?.auto === true,
        seedHash: lane?.seedHash || null,
        maxInFlight,
        queued,
        waitMs: handle.waitedMs,
        activeAfterAcquire: handle.activeCount,
        queueDepthAfterAcquire: handle.queueDepth,
    };
    traceXaiCacheLane(opts, {
        provider: 'xai',
        api: 'responses',
        transport,
        event: 'acquired',
        lane_key_hash: laneMeta.laneKeyHash,
        lane_shard: shard,
        lane_shards: laneMeta.shards,
        lane_auto: laneMeta.auto,
        lane_seed_hash: laneMeta.seedHash,
        max_in_flight: maxInFlight,
        wait_ms: laneMeta.waitMs,
        active: laneMeta.activeAfterAcquire,
        queue_depth: laneMeta.queueDepthAfterAcquire,
        previous_response_used: !!previousResponseId,
        input_count: inputCount,
    });
    const startedAt = Date.now();
    try {
        return { value: await fn(laneMeta), laneMeta };
    } finally {
        handle.release();
        traceXaiCacheLane(opts, {
            provider: 'xai',
            api: 'responses',
            transport,
            event: 'released',
            lane_key_hash: laneMeta.laneKeyHash,
            lane_shard: shard,
            lane_shards: laneMeta.shards,
            lane_auto: laneMeta.auto,
            lane_seed_hash: laneMeta.seedHash,
            max_in_flight: maxInFlight,
            held_ms: Date.now() - startedAt,
            previous_response_used: !!previousResponseId,
            input_count: inputCount,
        });
    }
}

function deterministicUuidFromKey(key) {
    const hex = createHash('sha256').update(String(key ?? '')).digest('hex');
    const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        '4' + hex.slice(13, 16),
        variant + hex.slice(17, 20),
        hex.slice(20, 32),
    ].join('-');
}

function compatCacheTraceEnabled(provider) {
    return process.env.MIXDOG_COMPAT_CACHE_TRACE === '1'
        || process.env.MIXDOG_PROVIDER_CACHE_TRACE === '1'
        || (provider === 'xai' && process.env.MIXDOG_XAI_CACHE_TRACE === '1');
}

function writeCompatCacheTrace({ provider, model, opts, params, rawTools, response, cacheRoutingKey, cacheRouting }) {
    if (!compatCacheTraceEnabled(provider)) return;
    try {
        const usage = response?.usage || {};
        const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
        const cachedTokens = extractCompatCachedTokens(usage);
        const toolShape = summarizeTraceTools(rawTools);
        const traceMessages = Array.isArray(params?.messages) ? params.messages : [];
        const trace = {
            event: 'chat.completions',
            provider,
            model,
            responseModel: response?.model || null,
            owner: opts?.session?.owner || null,
            role: opts?.session?.role || opts?.role || null,
            permission: opts?.session?.permission || null,
            toolPermission: opts?.session?.toolPermission || null,
            profileId: opts?.session?.profileId || null,
            sourceType: opts?.session?.sourceType || null,
            sourceName: opts?.session?.sourceName || null,
            sessionIdHash: opts?.sessionId ? traceHash(opts.sessionId) : null,
            providerCacheKeyHash: opts?.providerCacheKey ? traceHash(opts.providerCacheKey) : null,
            promptCacheKeyHash: opts?.promptCacheKey ? traceHash(opts.promptCacheKey) : null,
            xGrokConvIdHash: provider === 'xai' && cacheRoutingKey ? traceHash(cacheRoutingKey) : null,
            xGrokConvIdSeedHash: provider === 'xai' ? cacheRouting?.seedHash || null : null,
            xGrokPromptPrefixHash: provider === 'xai' ? cacheRouting?.prefixHash || null : null,
            xGrokConvIdMode: provider === 'xai' ? cacheRouting?.mode || null : null,
            xGrokConvIdLaneIndex: provider === 'xai' ? cacheRouting?.laneIndex ?? null : null,
            xGrokConvIdActiveLanes: provider === 'xai' ? cacheRouting?.activeLanes ?? null : null,
            xGrokConvIdIdleLanes: provider === 'xai' ? cacheRouting?.idleLanes ?? null : null,
            xGrokConvIdOwnerSessionHash: provider === 'xai' ? cacheRouting?.ownerSessionHash || null : null,
            xaiReasoningEffort: provider === 'xai' ? params?.reasoning_effort || null : null,
            messageCount: traceMessages.length,
            messageFullHash: traceHash(stableTraceStringify(traceMessages)),
            messagePrefixHash: traceHash(stableTraceStringify(traceMessages.slice(0, -1))),
            lastMessageHash: traceMessages.length ? traceHash(stableTraceStringify(traceMessages.at(-1))) : null,
            messages: summarizeTraceMessages(traceMessages),
            toolCount: Array.isArray(rawTools) ? rawTools.length : 0,
            toolSchemaHash: traceHash(stableTraceStringify(toolShape)),
            usageKeys: Object.keys(usage || {}).sort(),
            promptTokenDetailsKeys: Object.keys(usage?.prompt_tokens_details || {}).sort(),
            inputTokenDetailsKeys: Object.keys(usage?.input_tokens_details || {}).sort(),
            choiceMessageKeys: Object.keys(response?.choices?.[0]?.message || {}).sort(),
            responseReasoningContent: typeof response?.choices?.[0]?.message?.reasoning_content === 'string'
                ? traceTextShape(response.choices[0].message.reasoning_content)
                : null,
            responseReasoningTokens: Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0),
            inputTokens,
            outputTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0),
            cachedTokens,
            cacheHitRate: inputTokens > 0 ? Number((cachedTokens / inputTokens).toFixed(6)) : null,
            costInUsdTicks: typeof usage.cost_in_usd_ticks === 'number' ? usage.cost_in_usd_ticks : null,
        };
        process.stderr.write(`[compat-cache-trace] ${JSON.stringify(trace)}\n`);
    } catch (err) {
        process.stderr.write(`[compat-cache-trace] failed: ${err?.message || err}\n`);
    }
}

function summarizeResponsesInput(input) {
    return (input || []).map((item, index) => ({
        index,
        type: item?.type || null,
        role: item?.role || null,
        callIdHash: item?.call_id ? traceHash(item.call_id) : null,
        name: item?.name || null,
        content: typeof item?.content === 'string'
            ? { type: 'text', ...traceTextShape(item.content) }
            : { type: item?.content == null ? 'null' : typeof item.content, hash: traceHash(stableTraceStringify(item?.content ?? null)) },
        output: typeof item?.output === 'string' ? traceTextShape(item.output) : null,
    }));
}

function xaiUsageStats(usage) {
    const inputTokens = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
    const outputTokens = Number(usage?.output_tokens ?? usage?.completion_tokens ?? 0);
    const cachedTokens = extractCompatCachedTokens(usage);
    const hitRate = inputTokens > 0 ? Number((cachedTokens / inputTokens).toFixed(6)) : null;
    return { inputTokens, outputTokens, cachedTokens, hitRate };
}

function xaiSanitizedRequestSansInput(params) {
    const { input: _input, ...rest } = params || {};
    const out = { ...rest };
    if (out.prompt_cache_key) out.prompt_cache_key = traceHash(out.prompt_cache_key);
    if (out.previous_response_id) out.previous_response_id = traceHash(out.previous_response_id);
    if (typeof out.instructions === 'string') out.instructions = traceHash(out.instructions);
    return out;
}

function xaiResponsesFingerprintPayload({ model, opts, params, rawTools, response, cacheRouting, previousResponseId, inputStartIndex, continuationResetReason, transport, cacheLane }) {
    const usage = response?.usage || {};
    const { inputTokens, outputTokens, cachedTokens, hitRate } = xaiUsageStats(usage);
    const toolShape = summarizeTraceTools(rawTools);
    const instructions = typeof params?.instructions === 'string' ? params.instructions : '';
    const requestSansInput = xaiSanitizedRequestSansInput(params);
    const contextShape = {
        provider: 'xai',
        api: 'responses',
        model: model || null,
        promptCacheKeyHash: params?.prompt_cache_key ? traceHash(params.prompt_cache_key) : null,
        instructions,
        tools: toolShape,
        reasoning: params?.reasoning || null,
        store: params?.store ?? null,
    };
    const previousResponseUsed = Boolean(previousResponseId);
    const midTurnCold = previousResponseUsed
        && inputTokens >= 1024
        && (cachedTokens <= 512 || (hitRate != null && hitRate < 0.1));
    return {
        provider: 'xai',
        api: 'responses',
        transport: transport || null,
        model: model || null,
        response_model: response?.model || null,
        session_id_hash: opts?.sessionId ? traceHash(opts.sessionId) : null,
        provider_cache_key_hash: opts?.providerCacheKey ? traceHash(opts.providerCacheKey) : null,
        prompt_cache_key_option_hash: opts?.promptCacheKey ? traceHash(opts.promptCacheKey) : null,
        prompt_cache_key_hash: params?.prompt_cache_key ? traceHash(params.prompt_cache_key) : null,
        xai_prompt_prefix_hash: cacheRouting?.prefixHash || null,
        xai_cache_mode: cacheRouting?.mode || null,
        xai_cache_seed_hash: cacheRouting?.seedHash || null,
        owner_session_hash: cacheRouting?.ownerSessionHash || null,
        response_id_hash: response?.id ? traceHash(response.id) : null,
        previous_response_id_hash: previousResponseId ? traceHash(previousResponseId) : null,
        previous_response_used: previousResponseUsed,
        continuation_reset_reason: continuationResetReason || null,
        input_start_index: inputStartIndex,
        input_count: Array.isArray(params?.input) ? params.input.length : 0,
        input_hash: traceHash(stableTraceStringify(params?.input || [])),
        request_sans_input_hash: traceHash(stableTraceStringify(requestSansInput)),
        context_prefix_hash: traceHash(stableTraceStringify(contextShape)),
        has_instructions: instructions.length > 0,
        instructions_chars: instructions.length,
        instructions_hash: instructions ? traceHash(instructions) : null,
        reasoning_effort: params?.reasoning?.effort || null,
        tool_count: Array.isArray(rawTools) ? rawTools.length : 0,
        tool_schema_hash: traceHash(stableTraceStringify(toolShape)),
        tool_names_hash: traceHash(stableTraceStringify(toolShape.map(t => t?.name || null))),
        xai_cache_lane_enabled: cacheLane?.enabled === true,
        xai_cache_lane_hash: cacheLane?.laneKeyHash || null,
        xai_cache_lane_shard: Number.isFinite(Number(cacheLane?.shard)) ? Number(cacheLane.shard) : null,
        xai_cache_lane_shards: Number.isFinite(Number(cacheLane?.shards)) ? Number(cacheLane.shards) : null,
        xai_cache_lane_auto: cacheLane?.auto === true,
        xai_cache_lane_seed_hash: cacheLane?.seedHash || null,
        xai_cache_lane_max_in_flight: Number.isFinite(Number(cacheLane?.maxInFlight)) ? Number(cacheLane.maxInFlight) : null,
        xai_cache_lane_wait_ms: Number.isFinite(Number(cacheLane?.waitMs)) ? Number(cacheLane.waitMs) : null,
        xai_cache_lane_queued: cacheLane?.queued === true,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cached_tokens: cachedTokens,
        cache_hit_rate: hitRate,
        mid_turn_cold: midTurnCold,
    };
}

function traceXaiResponsesCacheContext(args) {
    if (!compatCacheTraceEnabled('xai')) return;
    try {
        const payload = xaiResponsesFingerprintPayload(args);
        const sessionId = args?.opts?.sessionId || args?.opts?.session?.id || null;
        const iteration = Number.isFinite(Number(args?.opts?.iteration)) ? Number(args.opts.iteration) : null;
        appendAgentTrace({
            sessionId,
            iteration,
            kind: 'cache_context',
            ...payload,
            payload,
        });
        if (payload.mid_turn_cold) {
            const anomalyPayload = {
                ...payload,
                anomaly: 'xai_mid_turn_cold_cache',
                reason: 'previous_response_id_present_but_cached_tokens_low',
            };
            appendAgentTrace({
                sessionId,
                iteration,
                kind: 'cache_anomaly',
                ...anomalyPayload,
                payload: anomalyPayload,
            });
        }
    } catch (err) {
        process.stderr.write(`[compat-cache-trace] xai context trace failed: ${err?.message || err}\n`);
    }
}

function writeXaiResponsesCacheTrace({ model, opts, params, rawTools, response, cacheRouting, previousResponseId, inputStartIndex, continuationResetReason, transport, cacheLane }) {
    if (!compatCacheTraceEnabled('xai')) return;
    try {
        const usage = response?.usage || {};
        const fingerprint = xaiResponsesFingerprintPayload({
            model,
            opts,
            params,
            rawTools,
            response,
            cacheRouting,
            previousResponseId,
            inputStartIndex,
            continuationResetReason,
            transport,
            cacheLane,
        });
        const inputTokens = fingerprint.input_tokens;
        const cachedTokens = fingerprint.cached_tokens;
        const toolShape = summarizeTraceTools(rawTools);
        const trace = {
            event: 'responses',
            provider: 'xai',
            transport: transport || null,
            model,
            responseModel: response?.model || null,
            responseIdHash: response?.id ? traceHash(response.id) : null,
            previousResponseIdHash: previousResponseId ? traceHash(previousResponseId) : null,
            owner: opts?.session?.owner || null,
            role: opts?.session?.role || opts?.role || null,
            permission: opts?.session?.permission || null,
            toolPermission: opts?.session?.toolPermission || null,
            profileId: opts?.session?.profileId || null,
            sourceType: opts?.session?.sourceType || null,
            sourceName: opts?.session?.sourceName || null,
            sessionIdHash: opts?.sessionId ? traceHash(opts.sessionId) : null,
            promptCacheKeyHash: params?.prompt_cache_key ? traceHash(params.prompt_cache_key) : null,
            xGrokPromptPrefixHash: cacheRouting?.prefixHash || null,
            xGrokConvIdMode: cacheRouting?.mode || null,
            xaiReasoningEffort: params?.reasoning?.effort || null,
            previousResponseUsed: Boolean(previousResponseId),
            inputStartIndex,
            inputCount: Array.isArray(params?.input) ? params.input.length : 0,
            cacheLaneEnabled: fingerprint.xai_cache_lane_enabled,
            cacheLaneHash: fingerprint.xai_cache_lane_hash,
            cacheLaneShard: fingerprint.xai_cache_lane_shard,
            cacheLaneMaxInFlight: fingerprint.xai_cache_lane_max_in_flight,
            cacheLaneWaitMs: fingerprint.xai_cache_lane_wait_ms,
            cacheLaneQueued: fingerprint.xai_cache_lane_queued,
            input: summarizeResponsesInput(params?.input || []),
            toolCount: Array.isArray(rawTools) ? rawTools.length : 0,
            toolSchemaHash: traceHash(stableTraceStringify(toolShape)),
            toolNamesHash: fingerprint.tool_names_hash,
            requestSansInputHash: fingerprint.request_sans_input_hash,
            contextPrefixHash: fingerprint.context_prefix_hash,
            instructionsHash: fingerprint.instructions_hash,
            instructionsChars: fingerprint.instructions_chars,
            usageKeys: Object.keys(usage || {}).sort(),
            inputTokenDetailsKeys: Object.keys(usage?.input_tokens_details || {}).sort(),
            outputTokenDetailsKeys: Object.keys(usage?.output_tokens_details || {}).sort(),
            outputTypes: (response?.output || []).map(item => item?.type || null),
            inputTokens,
            outputTokens: fingerprint.output_tokens,
            cachedTokens,
            cacheHitRate: fingerprint.cache_hit_rate,
            midTurnCold: fingerprint.mid_turn_cold,
            costInUsdTicks: typeof usage.cost_in_usd_ticks === 'number' ? usage.cost_in_usd_ticks : null,
        };
        process.stderr.write(`[compat-cache-trace] ${JSON.stringify(trace)}\n`);
    } catch (err) {
        process.stderr.write(`[compat-cache-trace] failed: ${err?.message || err}\n`);
    }
}

function toOpenAIMessages(messages, providerName, options = {}) {
    // NOTE: chat.completions has no equivalent slot for replaying reasoning
    // encrypted_content the way the Responses API does (no `type:'reasoning'`
    // input item). Whatever reasoningItems may be attached to assistant
    // messages by the openai-oauth provider is intentionally dropped here —
    // strict providers (xai) reject unknown roles/types and would 400 the
    // request. Documented in v0.1.160 (GPT reasoning replay).
    //
    // DeepSeek thinking models require the prior turn's `reasoning_content`
    // string to be echoed back inside the assistant message, otherwise the API
    // returns 400. xAI reasoning models also preserve their official multi-turn
    // shape and cache prefix stability when prior assistant reasoning_content
    // is replayed; reasoning_effort itself remains caller/user-selected.
    const replaysReasoningContent = options.replaysReasoningContent === true
        || providerName === 'deepseek'
        || providerName === 'xai';
    const out = [];
    const pendingToolMedia = [];
    const flushToolMedia = () => {
        if (!pendingToolMedia.length) return;
        out.push({ role: 'user', content: pendingToolMedia.splice(0) });
    };
    for (const m of messages) {
        if (m.role === 'tool') {
            const { output, mediaContent } = splitToolContentForOpenAIChat(m.content);
            out.push({
                role: 'tool',
                tool_call_id: m.toolCallId || '',
                content: output,
            });
            if (mediaContent) pendingToolMedia.push(...mediaContent);
            continue;
        }
        flushToolMedia();
        if (m.role === 'assistant' && m.toolCalls?.length) {
            const msg = {
                role: 'assistant',
                content: normalizeContentForOpenAIChat(m.content, { role: 'assistant' }) || null,
                tool_calls: m.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
            };
            if (replaysReasoningContent && m.reasoningContent) msg.reasoning_content = m.reasoningContent;
            out.push(msg);
            continue;
        }
        if (m.role === 'assistant' && replaysReasoningContent && m.reasoningContent) {
            out.push({ role: m.role, content: normalizeContentForOpenAIChat(m.content, { role: 'assistant' }), reasoning_content: m.reasoningContent });
            continue;
        }
        out.push({ role: m.role, content: normalizeContentForOpenAIChat(m.content, { role: m.role }) });
    }
    flushToolMedia();
    return out;
}

function toOpenAITools(tools) {
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        },
    }));
}
function toResponsesTools(tools) {
    return tools.map((t) => {
        if (t?.name === 'tool_search') {
            return {
                type: 'tool_search',
                execution: 'client',
                description: t.description,
                parameters: t.inputSchema,
            };
        }
        // xAI/Grok Responses rejects the OpenAI-only `type:'custom'` freeform
        // variant ("unknown variant 'custom'"). Serialize freeform/grammar
        // tools (e.g. apply_patch) as ordinary function tools instead. Grammar
        // tools may carry no usable inputSchema, so fall back to a permissive
        // object schema so grok still registers a valid function tool.
        return {
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema || { type: 'object', additionalProperties: true },
        };
    });
}
function nativeResponsesTools(opts) {
    return Array.isArray(opts?.nativeTools)
        ? opts.nativeTools.filter(t => t && typeof t === 'object')
        : [];
}
// Known tool-name sets for the leaked-tool-call guard, derived from the exact
// request body so a recovered leaked call is only synthesized when it names a
// tool the model was actually offered. Chat tools nest the name under
// `function.name`; Responses tools carry a top-level `name`.
function knownToolNamesFromOpenAITools(tools) {
    return new Set(
        (Array.isArray(tools) ? tools : [])
            .map((t) => (typeof t?.function?.name === 'string' ? t.function.name
                : typeof t?.name === 'string' ? t.name : null))
            .filter(Boolean),
    );
}
function knownToolNamesFromResponsesTools(tools) {
    return new Set(
        (Array.isArray(tools) ? tools : [])
            .map((t) => (typeof t?.name === 'string' ? t.name : null))
            .filter(Boolean),
    );
}
export function parseToolCalls(choice, label) {
    const calls = choice.message?.tool_calls;
    if (!calls?.length)
        return undefined;
    // finish_reason present ⇒ the turn completed; a JSON.parse failure on the
    // arguments is deterministic bad JSON (permanent), not stream truncation.
    const finishReason = choice.finish_reason || null;
    return calls
        .filter((tc) => tc.type === 'function')
        .map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseCompletedToolCallArgumentsJson(tc.function.arguments, label, { id: tc.id, name: tc.function.name, finishReason }),
    }));
}
export function parseResponsesToolCalls(response, label) {
    const out = [];
    // A Responses tool call is only parsed off a completed/done item, so any
    // malformed-JSON failure here is deterministic, not mid-stream truncation.
    const finishReason = response?.status || 'completed';
    for (const item of response?.output || []) {
        if (item?.type === 'function_call') {
            out.push({
                id: item.call_id || item.id,
                name: item.name,
                arguments: parseCompletedToolCallArgumentsJson(item.arguments, label, { id: item.call_id || item.id, name: item.name, finishReason }),
            });
        } else if (item?.type === 'custom_tool_call') {
            const call = customToolCallFromResponseItem(item);
            if (call) out.push(call);
        } else if (item?.type === 'tool_search_call') {
            out.push({
                id: item.call_id || item.id,
                name: 'tool_search',
                arguments: item.arguments && typeof item.arguments === 'object'
                    ? item.arguments
                    : parseCompletedToolCallArgumentsJson(item.arguments || '{}', label, { id: item.call_id || item.id, name: 'tool_search', finishReason }),
                nativeType: 'tool_search_call',
            });
        }
    }
    return out.length ? out : undefined;
}
function responseOutputText(response) {
    if (typeof response?.output_text === 'string') return response.output_text;
    const chunks = [];
    for (const item of response?.output || []) {
        if (item?.type !== 'message' || !Array.isArray(item.content)) continue;
        for (const part of item.content) {
            if (part?.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text);
        }
    }
    return chunks.join('');
}
function collectCompatResponseSearchSources(response) {
    const citations = [];
    const webSearchCalls = [];
    const seen = new Set();
    const addCitation = (source, fallback = {}) => {
        if (!source) return;
        if (typeof source === 'string') {
            const url = source.trim();
            if (!url || seen.has(url)) return;
            seen.add(url);
            citations.push({ title: url, url, snippet: '', source: fallback.source || 'citation', provider: 'xai' });
            return;
        }
        if (typeof source !== 'object') return;
        const url = String(
            source.url
            || source.uri
            || source.href
            || source.source_url
            || source.url_citation?.url
            || '',
        ).trim();
        if (!url || seen.has(url)) return;
        seen.add(url);
        citations.push({
            title: String(source.title || source.name || source.query || source.url_citation?.title || fallback.title || url).trim(),
            url,
            snippet: String(source.snippet || source.text || source.description || '').trim(),
            source: source.source || fallback.source || 'citation',
            provider: source.provider || 'xai',
        });
    };
    for (const citation of Array.isArray(response?.citations) ? response.citations : []) addCitation(citation);
    for (const item of Array.isArray(response?.output) ? response.output : []) {
        if (item?.type === 'web_search_call') {
            webSearchCalls.push({ id: item.id || '', status: item.status || '', action: item.action || null });
            const action = item.action || {};
            for (const source of Array.isArray(action.sources) ? action.sources : []) addCitation(source, { title: action.query || '', source: 'web_search_call' });
            if (action.url) addCitation({ url: action.url, title: action.query || '' }, { source: 'web_search_call' });
            for (const url of Array.isArray(action.urls) ? action.urls : []) addCitation({ url, title: action.query || '' }, { source: 'web_search_call' });
        }
        for (const citation of Array.isArray(item?.citations) ? item.citations : []) addCitation(citation);
        for (const part of Array.isArray(item?.content) ? item.content : []) {
            for (const annotation of Array.isArray(part?.annotations) ? part.annotations : []) {
                addCitation(annotation, { source: 'annotation' });
            }
        }
    }
    return { citations, webSearchCalls };
}
function toResponsesInputMessage(m, pendingToolMedia = null, customToolCallNameById = null) {
    if (m.role === 'tool') {
        if (Array.isArray(m.nativeToolSearch?.openaiTools)) {
            return {
                type: 'tool_search_output',
                call_id: m.toolCallId || '',
                status: 'completed',
                execution: 'client',
                tools: m.nativeToolSearch.openaiTools,
            };
        }
        const { output, mediaContent } = splitToolContentForOpenAIResponses(m.content);
        // xai path: never emit `custom_tool_call_output` (the `custom` variant
        // is rejected by grok). Replay prior tool outputs as the standard
        // `function_call_output` item regardless of original native type.
        const item = {
            type: 'function_call_output',
            call_id: m.toolCallId || '',
            output: output,
        };
        if (mediaContent && pendingToolMedia) pendingToolMedia.push(...mediaContent);
        return item;
    }
    if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
        const items = [];
        if (m.content) items.push({ role: 'assistant', content: normalizeContentForOpenAIResponses(m.content, { role: 'assistant' }) });
        for (const tc of m.toolCalls) {
            if (tc.nativeType === 'tool_search_call' || tc.name === 'tool_search') {
                items.push({
                    type: 'tool_search_call',
                    call_id: tc.id,
                    execution: 'client',
                    arguments: tc.arguments || {},
                });
            } else {
                // xai path: prior native `custom_tool_call` history is replayed
                // as a standard `function_call` (grok rejects the `custom`
                // variant). tc.arguments already holds the recovered object
                // form, so the same stringify path as regular calls applies.
                items.push({
                    type: 'function_call',
                    call_id: tc.id,
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments || {}),
                });
            }
        }
        return items;
    }
    return { role: m.role, content: normalizeContentForOpenAIResponses(m.content || '', { role: m.role }) };
}
function xaiSystemInstructions(messages) {
    const instructions = (messages || [])
        .filter(m => m?.role === 'system')
        .map(m => String(m.content || ''))
        .filter(Boolean)
        .join('\n\n');
    return instructions || undefined;
}
function toXaiResponsesInput(messages, providerState, options = {}) {
    const includeSystem = options.includeSystem !== false;
    const state = providerState?.xaiResponses || null;
    let startIndex = 0;
    let resetReason = null;
    let previousResponseId = typeof state?.previousResponseId === 'string' ? state.previousResponseId : null;
    const expectedModel = options.model ? String(options.model) : '';
    const stateModel = state?.model ? String(state.model) : '';
    const seen = Number.isInteger(state?.seenMessageCount) ? state.seenMessageCount : null;
    if (previousResponseId && expectedModel && stateModel && stateModel !== expectedModel) {
        previousResponseId = null;
        resetReason = 'model_changed';
    }
    if (previousResponseId && (seen == null || seen < 0 || seen > messages.length)) {
        previousResponseId = null;
        resetReason = seen == null ? 'missing_seen_message_count' : 'seen_message_count_out_of_range';
    }
    if (previousResponseId) {
        startIndex = Math.max(0, Math.min(seen, messages.length));
        if (messages[startIndex]?.role === 'assistant') startIndex += 1;
    }
    const input = [];
    const pendingToolMedia = [];
    const customToolCallNameById = new Map();
    const flushToolMedia = () => {
        if (!pendingToolMedia.length) return;
        input.push({ role: 'user', content: pendingToolMedia.splice(0) });
    };
    for (const m of messages.slice(startIndex)) {
        if (!includeSystem && m.role === 'system') continue;
        if (m.role !== 'tool') flushToolMedia();
        const converted = toResponsesInputMessage(m, pendingToolMedia, customToolCallNameById);
        if (Array.isArray(converted)) input.push(...converted);
        else input.push(converted);
    }
    flushToolMedia();
    return { input, previousResponseId, startIndex, continuationResetReason: resetReason };
}
export class OpenAICompatProvider {
    // Chat Completions prompt_tokens is already the total (includes cached).
    // Covers grok-oauth and all OPENAI_COMPAT_PRESETS. See registry.mjs.
    static inputExcludesCache = false;
    name;
    client;
    defaultModel;
    config;
    baseURL;
    apiKey;
    defaultHeaders;
    /** @type {Array<{id:string,contextWindow:number,provider:string}>|null} */
    _enrichedModels;
    constructor(name, config) {
        const preset = PRESETS[name];
        const baseURL = assertSafeBaseURL(config.baseURL || preset?.baseURL || 'http://localhost:8080/v1', name);
        const apiKey = config.apiKey || 'no-key';
        this.name = name;
        this.config = config;
        this.baseURL = baseURL;
        this.apiKey = apiKey;
        // Merge caller-supplied headers (config.extraHeaders) over the preset's.
        // Used e.g. by grok-oauth to inject the Grok CLI client headers for the
        // grok-build proxy. Backward-compatible: providers that pass no
        // extraHeaders behave exactly as before.
        this.defaultHeaders = { ...(preset?.extraHeaders || {}), ...(config.extraHeaders || {}) };
        this.defaultModel = preset?.defaultModel || 'default';
        this.client = new (loadOpenAI())({
            baseURL,
            apiKey,
            defaultHeaders: this.defaultHeaders,
            // The SDK's own retry loop (default 2) would nest underneath our
            // withRetry wrapper and multiply tail latency on a transient
            // backend. We own retry/backoff via withRetry, so disable the SDK's.
            maxRetries: 0,
            // Force the shared long-keepalive undici dispatcher to be installed
            // globally (setGlobalDispatcher) so the SDK's global fetch rides a
            // warm socket pool instead of Node's short-keepalive default. The
            // return value is undefined once installed globally; the option is
            // a harmless no-op then.
            fetchOptions: { dispatcher: getLlmDispatcher() },
        });
    }
    reloadApiKey() {
        try {
            const freshConfig = loadConfig();
            const cfg = freshConfig.providers?.[this.name];
            const preset = PRESETS[this.name];
            const newKey = cfg?.apiKey || this.config.apiKey;
            const baseURL = assertSafeBaseURL(cfg?.baseURL || this.config.baseURL || preset?.baseURL || 'http://localhost:8080/v1', this.name);
            if (newKey) {
                this.config = { ...(this.config || {}), ...(cfg || {}), apiKey: newKey, baseURL };
                this.baseURL = baseURL;
                this.apiKey = newKey;
                this.defaultHeaders = { ...(preset?.extraHeaders || {}), ...(this.config.extraHeaders || {}) };
                this.client = new (loadOpenAI())({
                    baseURL,
                    apiKey: newKey,
                    defaultHeaders: this.defaultHeaders,
                    maxRetries: 0,
                    fetchOptions: { dispatcher: getLlmDispatcher() },
                });
            }
        } catch { /* best effort */ }
    }
    async send(messages, model, tools, sendOpts) {
        try {
            return await this._doSend(messages, model, tools, sendOpts);
        } catch (err) {
            if (err.message && (err.message.includes('401') || err.message.includes('403'))) {
                process.stderr.write(`[provider] Auth error, re-reading config...\n`);
                this.reloadApiKey();
                return await this._doSend(messages, model, tools, sendOpts);
            }
            throw err;
        }
    }
    async _doSend(messages, model, tools, sendOpts) {
        const useModel = model || this.defaultModel;
        const opts = sendOpts || {};
        // Re-warm a kept-alive socket to the provider origin before the turn so
        // the request hot path lands on a live socket instead of paying a cold
        // TLS handshake after an idle gap. Fire-and-forget; never awaited. This
        // mirrors anthropic-oauth's send()-start preconnect.
        preconnect(this.baseURL);
        if (this.name === 'xai' && useXaiResponsesApi(opts, this.config)) {
            if (useXaiResponsesWebSocket(opts, this.config)) {
                try {
                    return await this._doSendXaiResponsesWebSocket(messages, useModel, tools, opts);
                } catch (err) {
                    if (_shouldFallbackXaiWsToHttp(err, opts.signal)) {
                        const reason = err?.midstreamClassifier || err?.retryClassifier || err?.code || err?.message || 'ws_failed';
                        process.stderr.write(`[xai:responses] WebSocket unhealthy (${reason}); falling back to HTTP/SSE\n`);
                        try {
                            appendAgentTrace({
                                sessionId: opts?.sessionId || opts?.session?.id || null,
                                iteration: Number.isFinite(Number(opts?.iteration)) ? Number(opts.iteration) : null,
                                kind: 'transport_fallback',
                                provider: 'xai',
                                model: useModel,
                                transport: 'http',
                                payload: {
                                    from: 'websocket',
                                    to: 'http',
                                    reason,
                                    error_code: err?.code || null,
                                    error_http_status: Number(err?.httpStatus || 0) || null,
                                    error_classifier: err?.retryClassifier || err?.midstreamClassifier || null,
                                },
                            });
                        } catch {}
                        return await this._doSendXaiResponses(messages, useModel, tools, opts);
                    }
                    throw err;
                }
            }
            return await this._doSendXaiResponses(messages, useModel, tools, opts);
        }
        const signal = opts.signal || null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('OpenAI-compat request aborted by session close');
        }
        const modelInfo = this.name === 'opencode-go'
            ? (this.getCachedModelInfo(useModel) || getModelMetadataSync(useModel, this.name))
            : null;
        const replaysReasoningContent = modelInfo?.reasoningContentField === 'reasoning_content';
        const params = {
            model: useModel,
            messages: toOpenAIMessages(messages, this.name, { replaysReasoningContent }),
        };
        const maxOutputTokens = resolveCompatMaxOutputTokens(opts);
        if (maxOutputTokens) params.max_tokens = maxOutputTokens;
        if (tools?.length) {
            params.tools = toOpenAITools(tools);
        }
        if (this.name === 'xai') {
            const reasoningEffort = normalizeXaiReasoningEffort(opts.xaiReasoningEffort
                ?? opts.effort
                ?? this.config?.reasoningEffort
                ?? process.env.MIXDOG_XAI_REASONING_EFFORT);
            if (reasoningEffort) params.reasoning_effort = reasoningEffort;
        }
        if (this.name === 'opencode-go') {
            const reasoningEffort = normalizeOpencodeGoReasoningEffort(opts.effort ?? this.config?.reasoningEffort, modelInfo);
            if (reasoningEffort) {
                params.reasoning_effort = reasoningEffort;
                params.thinking = { type: 'enabled' };
            }
        }
        // Streaming (params.stream = true is always set below): no absolute
        // wall-clock cap on a healthy stream. A fixed total-lifetime timer
        // false-aborts live long-reasoning turns that are still emitting SSE
        // deltas. Mirror the OAuth passthrough pattern (anthropic-oauth) —
        // totalSignal is a pure pass-through of the external signal with no
        // timer. The stream is bounded instead by the per-attempt first-byte
        // timeout (PROVIDER_FIRST_BYTE_TIMEOUT_MS) for a wedged socket, the
        // external signal (client disconnect / replaced request), and the SSE
        // idle watchdog for a stream that goes dead mid-flight.
        const totalSignal = createPassthroughSignal(signal);
        const cacheRouting = this.name === 'xai'
            ? xaiCacheRouting(opts, params, tools || [], useModel)
            : null;
        const cacheRoutingKey = cacheRouting?.key || null;
        // Note: x-grok-conv-id is documented as a routing hint, but in our
        // measured parallel-worker traffic it caused alternating cold caches
        // (server-side per-conv shard isolation). Vercel ai-sdk and other
        // reference clients omit it entirely and rely on xAI's automatic
        // prompt-prefix caching, which holds up to 95%+ hit even across
        // parallel workers. Keep the header off by default.
        // Shared retry: deepseek / xai / other compat backends all sit behind
        // their own load balancers and emit 5xx / "overloaded" under burst
        // traffic. The withRetry wrapper preserves abort behavior via
        // mergedSignal and only retries when classifyError() says transient.
        params.stream = true;
        params.stream_options = { include_usage: true };
        let assembled;
        try {
            assembled = await withRetry(
                async ({ signal: attemptSignal }) => {
                    try { opts.onStageChange?.('requesting'); } catch { /* heartbeat best-effort */ }
                    const stream = await withRetry(
                        ({ signal: openSignal }) => this.client.chat.completions.create(params, { signal: openSignal }),
                        {
                            signal: attemptSignal,
                            // Single attempt: this inner wrapper exists only to
                            // apply the first-byte per-attempt timeout. Retry is
                            // owned by the outer withRetry — nesting retry loops
                            // here multiplied tail latency (5x5).
                            maxAttempts: 1,
                            perAttemptTimeoutMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS,
                            perAttemptLabel: `${this.name} first byte`,
                        },
                    );
                    try { opts.onStageChange?.('streaming'); } catch { /* heartbeat best-effort */ }
                    return consumeCompatChatCompletionStream(stream, {
                        signal: attemptSignal,
                        label: this.name,
                        onStreamDelta: opts.onStreamDelta,
                        onToolCall: opts.onToolCall,
                        onTextDelta: opts.onTextDelta,
                        parseToolCalls,
                        // Known tool names for the leaked-tool-call guard:
                        // recovered leaked calls only synthesize when they name
                        // a tool actually offered to this request.
                        knownToolNames: knownToolNamesFromOpenAITools(params.tools),
                    });
                },
                {
                    signal: totalSignal.signal,
                    onRetry: ({ attempt, lastErr, delayMs, delayReason }) => {
                        const delayLabel = Number.isFinite(Number(delayMs)) ? `, delay ${delayMs}ms${delayReason ? ` (${delayReason})` : ''}` : '';
                        process.stderr.write(`[${this.name}] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`);
                    },
                },
            );
        } finally {
            totalSignal.cleanup();
        }
        const response = assembled.response;
        const choice = response.choices[0];
        const toolCalls = assembled.toolCalls;
        // Capture finish_reason early so we can refuse to return an
        // incomplete completion as final content. OpenAI-compat backends use
        // `length` (max_tokens / model context overflow) and `content_filter`
        // (moderation cutoff) to flag responses that were terminated before
        // the model finished its turn — treating those as success silently
        // surfaces truncated text and lets the loop accept a partial answer.
        const stopReason = choice?.finish_reason || null;
        if ((stopReason === 'length' && Array.isArray(toolCalls) && toolCalls.length > 0)
            || stopReason === 'content_filter') {
            const err = Object.assign(
                new Error(`${this.name} response incomplete: finish_reason=${stopReason}`),
                {
                    name: 'ProviderIncompleteError',
                    code: 'PROVIDER_INCOMPLETE',
                    providerIncomplete: true,
                    finishReason: stopReason,
                    partialContent: choice?.message?.content || '',
                    partialToolCalls: toolCalls,
                    model: response.model || useModel,
                    responseId: response.id || null,
                    rawUsage: response.usage || null,
                },
            );
            throw err;
        }
        writeCompatCacheTrace({
            provider: this.name,
            model: useModel,
            opts,
            params,
            rawTools: tools || [],
            response,
            cacheRoutingKey,
            cacheRouting,
        });
        if (response.usage) {
            const inputTokens = Number(response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0);
            const cachedTokens = extractCompatCachedTokens(response.usage);
            traceAgentUsage({
                sessionId: opts.sessionId || opts.session?.id || null,
                iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                inputTokens,
                outputTokens: Number(response.usage.completion_tokens ?? response.usage.output_tokens ?? 0),
                cachedTokens,
                cacheWriteTokens: 0,
                promptTokens: inputTokens,
                model: response.model || useModel,
                modelDisplay: response.model || useModel,
                responseId: response.id || null,
                rawUsage: response.usage,
                provider: this.name,
            });
        }
        // Capture provider reasoning_content so loop.mjs can attach it to the
        // assistant message and echo it back next turn for providers that
        // require or benefit from that official multi-turn shape.
        const capturesReasoningContent = this.name === 'deepseek' || this.name === 'xai' || replaysReasoningContent;
        const reasoningContent = (capturesReasoningContent && typeof assembled.reasoningContent === 'string')
            ? assembled.reasoningContent
            : null;
        return {
            content: assembled.content || '',
            // Streamed chunks can omit `model`; fall back to the requested
            // model so callers never receive a null model identifier.
            model: response.model || useModel,
            toolCalls,
            stopReason,
            ...(reasoningContent ? { reasoningContent } : {}),
            usage: response.usage ? (() => {
                const input = response.usage.prompt_tokens ?? response.usage.input_tokens ?? 0;
                const cached = extractCompatCachedTokens(response.usage);
                // xAI Grok returns the actual billed amount in `cost_in_usd_ticks`
                // (1 tick = $1e-10, per docs.x.ai). Surface it as costUsd so the
                // session manager skips the catalog-rate fallback and records the
                // provider-billed value verbatim.
                const ticks = response.usage.cost_in_usd_ticks;
                const costUsd = typeof ticks === 'number' && ticks >= 0
                    ? Number((ticks * 1e-10).toFixed(8))
                    : undefined;
                return {
                    inputTokens: input,
                    outputTokens: response.usage.completion_tokens ?? response.usage.output_tokens ?? 0,
                    cachedTokens: cached,
                    // Chat Completions prompt_tokens is already the total prompt
                    // the model ingested (cached is a subset) — alias directly.
                    promptTokens: input,
                    raw: { ...response.usage },
                    ...(costUsd != null ? { costUsd } : {}),
                };
            })() : undefined,
        };
    }
    async _doSendXaiResponses(messages, useModel, tools, opts) {
        const signal = opts.signal || null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('xAI Responses request aborted by session close');
        }
        const chatMessagesForTrace = toOpenAIMessages(messages, this.name);
        const cacheRouting = xaiResponsesCacheRouting(opts, { messages: chatMessagesForTrace }, tools || [], useModel);
        const { input, previousResponseId, startIndex, continuationResetReason } = toXaiResponsesInput(
            messages,
            opts.providerState,
            { model: useModel },
        );
        const params = {
            model: useModel,
            input,
            store: true,
            prompt_cache_key: cacheRouting.key,
        };
        if (previousResponseId) params.previous_response_id = previousResponseId;
        const nativeTools = nativeResponsesTools(opts);
        if (tools?.length || nativeTools.length) params.tools = [...nativeTools, ...toResponsesTools(tools || [])];
        // SSE transport: report 'requesting' until the stream opens, then
        // per-chunk onStreamDelta feeds the agent stall watchdog.
        try { opts.onStageChange?.('requesting'); } catch { /* heartbeat best-effort */ }
        const reasoningEffort = normalizeXaiReasoningEffort(opts.xaiReasoningEffort
            ?? opts.effort
            ?? this.config?.reasoningEffort
            ?? process.env.MIXDOG_XAI_REASONING_EFFORT);
        if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
        params.stream = true;
        let response;
        let cacheLane = null;
        const scheduled = await withXaiResponsesCacheLane({
            opts,
            config: this.config,
            cacheRouting,
            model: useModel,
            transport: 'http',
            previousResponseId,
            inputCount: Array.isArray(input) ? input.length : 0,
            signal,
        }, async (laneMeta) => {
            cacheLane = laneMeta;
            // Streaming (params.stream = true above): pass-through external
            // signal with no absolute wall-clock cap — see _doSend. The stream
            // is bounded by the per-attempt first-byte timeout, the external
            // signal, and the SSE idle watchdog, never a fixed total timer that
            // would false-abort a healthy long-reasoning stream.
            const totalSignal = createPassthroughSignal(signal);
            try {
                return await withRetry(
                    async ({ signal: attemptSignal }) => {
                        const stream = await withRetry(
                            ({ signal: openSignal }) => this.client.responses.create(params, { signal: openSignal }),
                            {
                                signal: attemptSignal,
                                // Single attempt: first-byte timeout only; retry
                                // is owned by the outer withRetry (see chat path).
                                maxAttempts: 1,
                                perAttemptTimeoutMs: PROVIDER_FIRST_BYTE_TIMEOUT_MS,
                                perAttemptLabel: 'xai responses first byte',
                            },
                        );
                        try { opts.onStageChange?.('streaming'); } catch { /* heartbeat best-effort */ }
                        return consumeCompatResponsesStream(stream, {
                            signal: attemptSignal,
                            label: 'xai:responses',
                            onStreamDelta: opts.onStreamDelta,
                            onToolCall: opts.onToolCall,
                            onTextDelta: opts.onTextDelta,
                            parseResponsesToolCalls,
                            responseOutputText,
                            knownToolNames: knownToolNamesFromResponsesTools(params.tools),
                        });
                    },
                    {
                        signal: totalSignal.signal,
                        onRetry: ({ attempt, lastErr, delayMs, delayReason }) => {
                            const delayLabel = Number.isFinite(Number(delayMs)) ? `, delay ${delayMs}ms${delayReason ? ` (${delayReason})` : ''}` : '';
                            process.stderr.write(`[xai:responses] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`);
                        },
                    },
                );
            } finally {
                totalSignal.cleanup();
            }
        });
        const streamed = scheduled.value;
        response = streamed.response;
        cacheLane = cacheLane || scheduled.laneMeta;
        const toolCalls = streamed.toolCalls;
        writeXaiResponsesCacheTrace({
            model: useModel,
            opts,
            params,
            rawTools: tools || [],
            response,
            cacheRouting,
            previousResponseId,
            inputStartIndex: startIndex,
            continuationResetReason,
            transport: 'http',
            cacheLane,
        });
        traceXaiResponsesCacheContext({
            model: useModel,
            opts,
            params,
            rawTools: tools || [],
            response,
            cacheRouting,
            previousResponseId,
            inputStartIndex: startIndex,
            continuationResetReason,
            transport: 'http',
            cacheLane,
        });
        if (response.usage) {
            const inputTokens = Number(response.usage.input_tokens ?? response.usage.prompt_tokens ?? 0);
            const cachedTokens = extractCompatCachedTokens(response.usage);
            traceAgentUsage({
                sessionId: opts.sessionId || opts.session?.id || null,
                iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                inputTokens,
                outputTokens: Number(response.usage.output_tokens ?? response.usage.completion_tokens ?? 0),
                cachedTokens,
                cacheWriteTokens: 0,
                promptTokens: inputTokens,
                model: response.model || useModel,
                modelDisplay: response.model || useModel,
                responseId: response.id || null,
                rawUsage: response.usage,
                provider: 'xai',
            });
        }
        const nextPreviousResponseId = streamed.stopReason === 'length' ? null : response.id;
        const searchSources = collectCompatResponseSearchSources(response);
        return {
            content: streamed.content,
            model: response.model || useModel,
            toolCalls,
            stopReason: streamed.stopReason || null,
            citations: searchSources.citations.length ? searchSources.citations : undefined,
            webSearchCalls: searchSources.webSearchCalls.length ? searchSources.webSearchCalls : undefined,
            providerState: {
                ...(opts.providerState || {}),
                xaiResponses: {
                    previousResponseId: nextPreviousResponseId,
                    seenMessageCount: Array.isArray(messages) ? messages.length : 0,
                    model: response.model || useModel,
                    updatedAt: Date.now(),
                },
            },
            usage: response.usage ? (() => {
                const inputTokens = response.usage.input_tokens ?? response.usage.prompt_tokens ?? 0;
                const ticks = response.usage.cost_in_usd_ticks;
                const costUsd = typeof ticks === 'number' && ticks >= 0
                    ? Number((ticks * 1e-10).toFixed(8))
                    : undefined;
                return {
                    inputTokens,
                    outputTokens: response.usage.output_tokens ?? response.usage.completion_tokens ?? 0,
                    cachedTokens: extractCompatCachedTokens(response.usage),
                    promptTokens: inputTokens,
                    raw: { ...response.usage },
                    ...(costUsd != null ? { costUsd } : {}),
                };
            })() : undefined,
        };
    }
    async _doSendXaiResponsesWebSocket(messages, useModel, tools, opts) {
        const signal = opts.signal || null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('xAI Responses WebSocket request aborted by session close');
        }
        const apiKey = this.config?.apiKey || process.env.XAI_API_KEY;
        if (!apiKey) throw new Error('xAI API key not configured');
        const chatMessagesForTrace = toOpenAIMessages(messages, this.name);
        const cacheRouting = xaiResponsesCacheRouting(opts, { messages: chatMessagesForTrace }, tools || [], useModel);
        const { input, previousResponseId, startIndex, continuationResetReason } = toXaiResponsesInput(
            messages,
            opts.providerState,
            { includeSystem: false, model: useModel },
        );
        const params = {
            model: useModel,
            input,
            // xAI's WebSocket continuation is documented for store=false, but
            // the public endpoint currently returns previous_response_not_found
            // in our live probes unless the chain is stored.
            store: true,
            prompt_cache_key: cacheRouting.key,
        };
        const instructions = xaiSystemInstructions(messages);
        if (previousResponseId) params.previous_response_id = previousResponseId;
        // xAI rejects instructions together with previous_response_id; the
        // first response already anchors instructions for the continuation.
        else if (instructions) params.instructions = instructions;
        const nativeTools = nativeResponsesTools(opts);
        if (tools?.length || nativeTools.length) params.tools = [...nativeTools, ...toResponsesTools(tools || [])];
        const reasoningEffort = normalizeXaiReasoningEffort(opts.xaiReasoningEffort
            ?? opts.effort
            ?? this.config?.reasoningEffort
            ?? process.env.MIXDOG_XAI_REASONING_EFFORT);
        if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
        const warmupBody = useXaiResponsesWebSocketWarmup(opts, this.config, {
            previousResponseId,
            instructions,
            rawTools: tools || [],
        })
            ? { ...params, generate: false, input: [] }
            : null;
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        let cacheLane = null;
        const scheduled = await withXaiResponsesCacheLane({
            opts,
            config: this.config,
            cacheRouting,
            model: useModel,
            transport: 'websocket',
            previousResponseId,
            inputCount: Array.isArray(input) ? input.length : 0,
            signal,
        }, async (laneMeta) => {
            cacheLane = laneMeta;
            return await sendViaWebSocket({
                auth: { type: 'xai', apiKey },
                body: params,
                sendOpts: opts,
                onStreamDelta: typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null,
                onToolCall: typeof opts.onToolCall === 'function' ? opts.onToolCall : null,
                onTextDelta: typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null,
                onStageChange: typeof opts.onStageChange === 'function' ? opts.onStageChange : null,
                externalSignal: signal,
                poolKey: opts.sessionId || opts.session?.id || null,
                cacheKey: cacheRouting.key,
                iteration,
                useModel,
                displayModel: (id) => id,
                includeResponseId: true,
                traceProvider: 'xai',
                logSuppressedReasoningDeltas: false,
                warmupBody,
            });
        });
        const result = scheduled.value;
        cacheLane = cacheLane || scheduled.laneMeta;
        const responseId = result.responseId || previousResponseId || null;
        const nextPreviousResponseId = result.stopReason === 'length' ? null : responseId;
        const rawUsage = result.usage?.raw || result.usage || null;
        const traceParams = result.__warmup?.requestBody || params;
        writeXaiResponsesCacheTrace({
            model: useModel,
            opts,
            params: traceParams,
            rawTools: tools || [],
            response: {
                id: responseId,
                model: result.model || useModel,
                output: [],
                usage: rawUsage,
            },
            cacheRouting,
            previousResponseId,
            inputStartIndex: startIndex,
            continuationResetReason,
            transport: 'websocket',
            cacheLane,
        });
        traceXaiResponsesCacheContext({
            model: useModel,
            opts,
            params: traceParams,
            rawTools: tools || [],
            response: {
                id: responseId,
                model: result.model || useModel,
                output: [],
                usage: rawUsage,
            },
            cacheRouting,
            previousResponseId,
            inputStartIndex: startIndex,
            continuationResetReason,
            transport: 'websocket',
            cacheLane,
        });
        const ticks = rawUsage?.cost_in_usd_ticks;
        const costUsd = typeof ticks === 'number' && ticks >= 0
            ? Number((ticks * 1e-10).toFixed(8))
            : undefined;
        return {
            content: result.content || '',
            model: result.model || useModel,
            toolCalls: result.toolCalls,
            stopReason: result.stopReason || null,
            providerState: {
                ...(opts.providerState || {}),
                xaiResponses: {
                    previousResponseId: nextPreviousResponseId,
                    seenMessageCount: Array.isArray(messages) ? messages.length : 0,
                    model: result.model || useModel,
                    updatedAt: Date.now(),
                    transport: 'websocket',
                },
            },
            usage: result.usage ? {
                ...result.usage,
                ...(costUsd != null ? { costUsd } : {}),
            } : undefined,
            citations: Array.isArray(result.citations) && result.citations.length ? result.citations : undefined,
            webSearchCalls: Array.isArray(result.webSearchCalls) && result.webSearchCalls.length ? result.webSearchCalls : undefined,
        };
    }
    async _fetchModelItems() {
        const timeout = createTimeoutSignal(null, MODEL_LIST_TIMEOUT_MS, `${this.name} model list`);
        try {
            const res = await fetch(`${String(this.baseURL || '').replace(/\/+$/, '')}/models`, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.apiKey || 'no-key'}`,
                    ...(this.defaultHeaders || {}),
                },
                signal: timeout.signal,
            });
            if (!res.ok) throw new Error(`${this.name} models ${res.status}`);
            const data = await res.json();
            if (Array.isArray(data?.data)) return data.data;
            if (Array.isArray(data)) return data;
            return [];
        } finally {
            timeout.cleanup();
        }
    }
    async listModels() {
        try {
            const list = await this._fetchModelItems();
            const models = [];
            for (const m of list) {
                const contextWindow = Number(
                    m?.context_window
                    ?? m?.max_context_window
                    ?? m?.max_input_tokens
                    ?? m?.max_model_len
                    ?? m?.context_length
                    ?? m?.contextWindow
                    ?? 0,
                );
                const outputTokens = Number(
                    m?.max_output_tokens
                    ?? m?.output_tokens
                    ?? m?.maxOutputTokens
                    ?? 0,
                );
                models.push({
                    id: m?.id,
                    name: m?.id,
                    provider: this.name,
                    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 0,
                    outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : null,
                    created: typeof m?.created === 'number' ? m.created : null,
                });
            }
            const filtered = models.filter(m => m.id);
            const enriched = await enrichModels(filtered);
            this._enrichedModels = enriched;
            return enriched;
        }
        catch {
            return [];
        }
    }
    async isAvailable() {
        try {
            await this._fetchModelItems();
            return true;
        }
        catch {
            return false;
        }
    }
    /** @param {string} model */
    getCachedModelInfo(model) {
        if (Array.isArray(this._enrichedModels)) {
            return this._enrichedModels.find(m => m.id === model) || null;
        }
        return null;
    }
}

export const _toResponsesToolsForTest = toResponsesTools;
export const _toXaiResponsesInputForTest = toXaiResponsesInput;
