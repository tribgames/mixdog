import { createRequire } from 'node:module';
import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import { withRetry } from './retry-classifier.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import {
    consumeCompatChatCompletionStream,
    consumeCompatResponsesStream,
} from './openai-compat-stream.mjs';
import { enrichModels, getModelMetadataSync } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { appendAgentTrace, grokCacheChainTraceFields, traceAgentUsage } from '../agent-trace.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_GENERATE_TOTAL_TIMEOUT_MS,
    createTimeoutSignal,
    createPassthroughSignal,
    resolveTimeoutMs,
} from '../stall-policy.mjs';
import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';
import {
    resolveResponsesTransportPolicy,
    RESPONSES_TRANSPORT_CAPABILITIES,
} from './openai-transport-policy.mjs';
import {
    summarizeTraceMessages,
    extractCompatCachedTokens,
} from './openai-compat-trace.mjs';
import {
    resolveCompatMaxOutputTokens,
    toOpenAIMessages,
    toOpenAITools,
    toResponsesTools,
    nativeResponsesTools,
    knownToolNamesFromOpenAITools,
    knownToolNamesFromResponsesTools,
    parseToolCalls,
    parseResponsesToolCalls,
    responseOutputText,
    collectCompatResponseSearchSources,
    xaiSystemInstructions,
    toXaiResponsesInput,
} from './openai-compat-wire.mjs';
import {
    xaiCacheRouting,
    xaiResponsesCacheRouting,
    normalizeXaiReasoningEffort,
    normalizeOpencodeGoReasoningEffort,
    useXaiResponsesApi,
    useXaiResponsesWebSocket,
    useXaiResponsesWebSocketWarmup,
    _shouldFallbackXaiWsToHttp,
    _envFlag,
    withXaiResponsesCacheLane,
    writeCompatCacheTrace,
    traceXaiResponsesCacheContext,
    writeXaiResponsesCacheTrace,
} from './openai-compat-xai.mjs';

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


// summarizeTraceMessages / extractCompatCachedTokens → openai-compat-trace.mjs
// resolveCompatMaxOutputTokens + message/tool wire converters and response
// parsers → openai-compat-wire.mjs. Re-exported below for existing importers.
export { summarizeTraceMessages, extractCompatCachedTokens } from './openai-compat-trace.mjs';
export { parseToolCalls, parseResponsesToolCalls } from './openai-compat-wire.mjs';

function normalizeReasoningEffort(value, allowed) {
    const effort = String(value ?? '').trim().toLowerCase();
    return allowed.includes(effort) ? effort : null;
}

// Keep provider extensions isolated: fields accepted by one OpenAI-compatible
// backend are frequently rejected by another even when the core Chat schema is
// shared.
export function applyCompatProviderChatOptions(params, providerName, opts = {}, config = {}, modelInfo = null) {
    if (providerName === 'xai') {
        const reasoningEffort = normalizeXaiReasoningEffort(opts.xaiReasoningEffort
            ?? opts.effort
            ?? config?.reasoningEffort
            ?? process.env.MIXDOG_XAI_REASONING_EFFORT);
        if (reasoningEffort) params.reasoning_effort = reasoningEffort;
        return params;
    }
    if (providerName === 'deepseek') {
        const rawThinking = opts.deepseekThinking
            ?? opts.thinking
            ?? config?.thinking;
        const rawEffort = opts.deepseekReasoningEffort
            ?? opts.effort
            ?? config?.reasoningEffort;
        if (rawThinking !== undefined || rawEffort !== undefined) {
            const disabled = rawThinking === false
                || String(rawThinking?.type ?? rawThinking ?? rawEffort).trim().toLowerCase() === 'disabled'
                || String(rawThinking?.type ?? rawThinking ?? rawEffort).trim().toLowerCase() === 'none';
            params.thinking = { type: disabled ? 'disabled' : 'enabled' };
            if (!disabled) {
                const effort = String(rawEffort ?? '').trim().toLowerCase();
                if (effort === 'max' || effort === 'xhigh') params.reasoning_effort = 'max';
                else if (['low', 'medium', 'high'].includes(effort)) params.reasoning_effort = 'high';
            }
        }
        return params;
    }
    if (providerName === 'ollama') {
        const effort = normalizeReasoningEffort(
            opts.ollamaReasoningEffort ?? opts.effort ?? config?.reasoningEffort,
            ['none', 'low', 'medium', 'high', 'max'],
        );
        if (effort) params.reasoning_effort = effort;
        return params;
    }
    if (providerName === 'lmstudio') {
        const effort = normalizeReasoningEffort(
            opts.lmStudioReasoningEffort ?? opts.effort ?? config?.reasoningEffort,
            ['none', 'low', 'medium', 'high', 'max'],
        );
        if (effort) params.reasoning_effort = effort;
        return params;
    }
    if (providerName === 'opencode-go') {
        const reasoningEffort = normalizeOpencodeGoReasoningEffort(
            opts.effort ?? config?.reasoningEffort,
            modelInfo,
        );
        // OpenCode Go's OpenAI-compatible contract exposes reasoning_effort,
        // not DeepSeek's provider-specific `thinking` extension.
        if (reasoningEffort) params.reasoning_effort = reasoningEffort;
    }
    return params;
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
    get _preconnectFn() {
        return typeof this.config?.preconnectFn === 'function'
            ? this.config.preconnectFn
            : preconnect;
    }
    reloadApiKey() {
        try {
            const preset = PRESETS[this.name];
            const newKey = getAgentApiKey(this.name) || this.config.apiKey;
            const baseURL = assertSafeBaseURL(this.config.baseURL || preset?.baseURL || 'http://localhost:8080/v1', this.name);
            if (newKey) {
                this.config = { ...(this.config || {}), apiKey: newKey, baseURL };
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
            const structuredStatus = [err?.status, err?.httpStatus, err?.response?.status]
                .map(value => Number(value))
                .find(value => Number.isFinite(value) && value > 0) || 0;
            const status = structuredStatus > 0
                ? structuredStatus
                : (/\b401\b/.test(String(err?.message || '')) ? 401 : 0);
            if (status === 401) {
                if (err.liveTextEmitted === true || err.emittedToolCall === true || err.unsafeToRetry === true) {
                    throw err;
                }
                process.stderr.write(`[provider] Auth error, re-reading provider authentication...\n`);
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
        // TLS handshake after an idle gap. Fire-and-forget; never awaited.
        // Tests/local callers can disable this or inject a fail-closed seam;
        // production retains the shared preconnect by default.
        if (this.config?.preconnect !== false) {
            this._preconnectFn(this.baseURL);
        }
        if (this.name === 'xai' && useXaiResponsesApi(opts, this.config)) {
            // Shared Responses transport switch (MIXDOG_OAI_TRANSPORT), capability-
            // gated for xAI/Grok. Provider-local HTTP pins still win: Grok
            // proxy-only models set responsesTransport:'http' because the WS
            // connector targets api.x.ai, not cli-chat-proxy.grok.com.
            const xaiTransportPolicy = resolveResponsesTransportPolicy(
                process.env,
                RESPONSES_TRANSPORT_CAPABILITIES.xai,
            );
            const configuredPreferWebSocket = useXaiResponsesWebSocket(opts, this.config);
            const preferWebSocket = configuredPreferWebSocket === false
                ? false
                : xaiTransportPolicy.mode === 'http-sse'
                ? false
                : xaiTransportPolicy.transport === 'ws'
                    ? true
                    : configuredPreferWebSocket;
            if (preferWebSocket) {
                try {
                    return await this._doSendXaiResponsesWebSocket(messages, useModel, tools, opts);
                } catch (err) {
                    if (xaiTransportPolicy.allowHttpFallback && _shouldFallbackXaiWsToHttp(err, opts.signal)) {
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
        applyCompatProviderChatOptions(params, this.name, opts, this.config, modelInfo);
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
        const capturesReasoningContent = this.name === 'deepseek'
            || this.name === 'xai'
            || this.name === 'ollama'
            || this.name === 'lmstudio'
            || replaysReasoningContent;
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
            // P1 audit fix: a text-only completion that hit finish_reason=
            // 'length' (no tool calls, so not thrown above as
            // ProviderIncompleteError) previously returned as an ordinary
            // success with no signal that the content is a mid-sentence
            // cutoff. Flag it so loop.mjs can surface a one-line warning
            // instead of silently treating a truncated answer as complete.
            ...(stopReason === 'length' && (assembled.content || '').length > 0 ? { truncated: true } : {}),
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
        if (tools?.length || nativeTools.length) params.tools = [...nativeTools, ...toResponsesTools(tools || [], { provider: 'xai' })];
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
            const cacheChain = grokCacheChainTraceFields(
                opts.providerState,
                previousResponseId,
                continuationResetReason,
            );
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
                requestPrevResponseId: cacheChain.requestPrevResponseId,
                chainContinuous: cacheChain.chainContinuous,
                continuationResetReason: cacheChain.continuationResetReason,
            });
        }
        // Keep the response chain across `length` stops: a max-output cutoff
        // is still a committed response server-side, so chaining from its id
        // preserves prefix cache. (Previously reset to null defensively; no
        // provider requirement found — chain_continuous trace will surface
        // any rejection as a provider-side drop.)
        const nextPreviousResponseId = response.id;
        const searchSources = collectCompatResponseSearchSources(response);
        return {
            content: streamed.content,
            model: response.model || useModel,
            toolCalls,
            stopReason: streamed.stopReason || null,
            // P1 audit fix: mirror the chat-completions truncated flag for
            // the xAI Responses HTTP path — a max-output cutoff with real
            // content must not look identical to a clean stop.
            ...(streamed.stopReason === 'length' && (streamed.content || '').length > 0 ? { truncated: true } : {}),
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
        if (tools?.length || nativeTools.length) params.tools = [...nativeTools, ...toResponsesTools(tools || [], { provider: 'xai' })];
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
        // Fast-fallback only shortens the WS handshake retry budget when the
        // HTTP/SSE fallback is actually enabled for this call. With no-fallback
        // (allowHttpFallback=false) the WS path must keep its FULL retry budget,
        // mirroring openai-oauth's httpFallbackEnabled gate.
        const xaiTransportPolicy = resolveResponsesTransportPolicy(
            process.env,
            RESPONSES_TRANSPORT_CAPABILITIES.xai,
        );
        const httpFallbackEnabled = xaiTransportPolicy.allowHttpFallback
            && _envFlag('MIXDOG_XAI_WS_HTTP_FALLBACK', true);
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
                // Mirror openai-oauth fast fallback: when the HTTP fallback is
                // enabled (outer catch → _shouldFallbackXaiWsToHttp), a first
                // acquire/first-byte failure should skip remaining WS
                // handshake retries instead of burning the retry budget
                // before HTTP starts. Gated on httpFallbackEnabled so a
                // no-fallback config keeps the full WS retry budget.
                fastFallback: httpFallbackEnabled,
            });
        });
        const result = scheduled.value;
        cacheLane = cacheLane || scheduled.laneMeta;
        const responseId = result.responseId || previousResponseId || null;
        // Same rationale as the HTTP path above: `length` stop keeps the chain.
        const nextPreviousResponseId = responseId;
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
            // P1 audit fix: same truncated signal as the HTTP path (see
            // _doSendXaiResponses above) for the WebSocket transport.
            ...(result.stopReason === 'length' && (result.content || '').length > 0 ? { truncated: true } : {}),
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
            const enriched = sanitizeModelList(await enrichModels(filtered), { provider: this.name });
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
