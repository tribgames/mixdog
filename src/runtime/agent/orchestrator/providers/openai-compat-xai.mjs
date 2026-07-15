/**
 * openai-compat-xai.mjs — xAI/Grok Responses-API routing, prompt-cache lanes
 * and cache tracing for the OpenAI-compat provider.
 *
 * Extracted from openai-compat.mjs. Owns the xAI cache-lane singletons
 * (xaiResponsesCacheLanes) plus cache routing/fingerprint/trace helpers and
 * the compat cache trace writer shared by chat-completions and Responses
 * paths. openai-compat.mjs imports the routing/lane/trace entry points.
 */
import { createHash } from 'crypto';
import { appendAgentTrace } from '../agent-trace.mjs';
import {
    resolveProviderCacheKey,
    resolveProviderPromptCacheLane,
} from '../agent-runtime/cache-strategy.mjs';
import { shouldFallbackTransport } from './retry-classifier.mjs';
import { traceHash, stableTraceStringify, summarizeTraceTools, traceTextShape } from './trace-utils.mjs';
import { summarizeTraceMessages, extractCompatCachedTokens } from './openai-compat-trace.mjs';

export function xaiPrefixSeed({ opts, params, rawTools, model }) {
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

export function xaiCacheRouting(opts, params, rawTools, model) {
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

export function xaiResponsesCacheRouting(opts, params, rawTools, model) {
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
    // Optional lane sharding (OpenAI prompt-caching guidance: keep each
    // prefix+prompt_cache_key combo under ~15 RPM). When lane shards are
    // enabled (MIXDOG_XAI_RESPONSES_CACHE_LANE_SHARDS=N or lane auto), mix the
    // assigned slot into the routing seed so sessions spread across N server
    // cache keys instead of overflowing one. Slot is derived from a hash of
    // the session id (NOT in-process round-robin: headless workers run one
    // session per process, where round-robin degenerates to slot 0 for
    // everyone). Default stays a single shared key (lane disabled) —
    // identical seed/key to before.
    const lane = xaiResponsesPromptCacheLane(opts, null, { prefixHash, ownerSessionHash: sessionId ? traceHash(sessionId) : null });
    const laneEnabled = lane?.enabled === true;
    const laneShards = Number.isFinite(Number(lane?.shards)) && Number(lane.shards) > 0 ? Number(lane.shards) : 0;
    const explicitSlot = Number(opts?.promptCacheLaneSlot ?? opts?.xaiCacheLaneSlot);
    const laneSlot = Number.isFinite(explicitSlot) && explicitSlot >= 0
        ? (laneShards > 0 ? Math.floor(explicitSlot) % laneShards : Math.floor(explicitSlot))
        : (laneShards > 0
            ? createHash('sha256').update(sessionId || String(process.pid)).digest().readUInt32BE(0) % laneShards
            : Number.isFinite(Number(lane?.slot)) ? Number(lane.slot) : 0);
    const routingSeed = stableTraceStringify({
        scope: 'xai-responses-prefix-v1',
        providerKey: String(providerKey),
        model: model || null,
        prefixHash,
        ...(laneEnabled ? { laneSlot } : {}),
    });
    return {
        key: deterministicUuidFromKey(routingSeed),
        mode: 'prefix',
        seedHash: traceHash(routingSeed),
        prefixHash,
        ownerSessionHash: sessionId ? traceHash(sessionId) : null,
        ...(laneEnabled ? {
            laneIndex: laneSlot,
            activeLanes: Number.isFinite(Number(lane?.shards)) && Number(lane.shards) > 0 ? Number(lane.shards) : null,
        } : {}),
    };
}

export function normalizeXaiReasoningEffort(value) {
    const effort = String(value || '').trim().toLowerCase();
    // Grok 4.5 accepts low/medium/high. Omit unsupported values (notably
    // `none`) to retain xAI's authoritative model default rather than sending
    // a value the API rejects.
    return ['low', 'medium', 'high'].includes(effort) ? effort : null;
}

export function opencodeGoReasoningEffortValues(modelInfo) {
    const effort = (modelInfo?.reasoningOptions || []).find((option) => option?.type === 'effort');
    return Array.isArray(effort?.values)
        ? effort.values.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
        : [];
}

export function normalizeOpencodeGoReasoningEffort(value, modelInfo) {
    const allowed = opencodeGoReasoningEffortValues(modelInfo);
    if (!allowed.length) return null;
    const effort = String(value || '').trim().toLowerCase();
    if (allowed.includes(effort)) return effort;
    if ((effort === 'max' || effort === 'xhigh') && allowed.includes('max')) return 'max';
    if (['high', 'medium', 'low'].includes(effort) && allowed.includes('high')) return 'high';
    return null;
}

export function useXaiResponsesApi(opts, config) {
    const raw = opts?.xaiApiMode
        ?? config?.apiMode
        ?? config?.xaiApiMode
        ?? process.env.MIXDOG_XAI_API_MODE
        ?? process.env.MIXDOG_XAI_RESPONSES;
    if (raw == null || raw === '') return true;
    const mode = String(raw).trim().toLowerCase();
    return !['0', 'false', 'off', 'chat', 'chat-completions', 'chat_completions'].includes(mode);
}

export function useXaiResponsesWebSocket(opts, config) {
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

export function _envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

// xAI WS→HTTP transport fallback → shared shouldFallbackTransport
// (retry-classifier.mjs). Identical deny-order + allow-list; the per-provider
// env flag is computed here and passed via `enabled`.
export function _shouldFallbackXaiWsToHttp(err, signal) {
    return shouldFallbackTransport(err, {
        signal,
        enabled: _envFlag('MIXDOG_XAI_WS_HTTP_FALLBACK', true),
    });
}

export function useXaiResponsesWebSocketWarmup(opts, config, { previousResponseId, instructions, rawTools }) {
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

// Codex-aligned default: no compat cache lane/serialization. Keep the override
// knobs so live probes can opt back into a bounded lane if a provider needs it.
const XAI_RESPONSES_CACHE_LANE_DEFAULT_MAX_IN_FLIGHT = 0;
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

export async function withXaiResponsesCacheLane({ opts, config, cacheRouting, model, transport, previousResponseId, inputCount, signal }, fn) {
    // Historical prompt-cache lanes formed a second admission queue and could
    // time out while waiting. xAI is now governed exclusively by the common
    // fixed-64 provider/account scheduler, regardless of legacy env/option
    // knobs. Keep this wrapper only as a call-shape compatibility boundary.
    const laneMeta = { enabled: false, maxInFlight: 0 };
    return { value: await fn(laneMeta), laneMeta };
}

export function deterministicUuidFromKey(key) {
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

export function compatCacheTraceEnabled(provider) {
    return process.env.MIXDOG_COMPAT_CACHE_TRACE === '1'
        || process.env.MIXDOG_PROVIDER_CACHE_TRACE === '1'
        || (provider === 'xai' && process.env.MIXDOG_XAI_CACHE_TRACE === '1');
}

export function writeCompatCacheTrace({ provider, model, opts, params, rawTools, response, cacheRoutingKey, cacheRouting }) {
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

export function traceXaiResponsesCacheContext(args) {
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

export function writeXaiResponsesCacheTrace({ model, opts, params, rawTools, response, cacheRouting, previousResponseId, inputStartIndex, continuationResetReason, transport, cacheLane }) {
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
