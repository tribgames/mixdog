/**
 * OpenAI Direct API — WebSocket transport via Responses API.
 *
 * Uses the same `sendViaWebSocket` plumbing as openai-oauth, with two
 * differences encoded in the `auth.type === 'openai-direct'` branch inside
 * openai-oauth-ws.mjs:
 *   1. Authorization header: Bearer <OPENAI_API_KEY> (no account_id, no
 *      originator).
 *   2. Endpoint: wss://api.openai.com/v1/responses.
 *
 * The Responses API request body is reused from openai-oauth (`buildRequestBody`)
 * so prompt_cache_key, reasoning effort, and tool wiring stay byte-identical
 * across the two providers — only the transport endpoint and auth header change.
 */
import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import { buildRequestBody } from './openai-oauth.mjs';
import { enrichModels } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { sendViaHttpSse, _envFlag } from './openai-oauth-http-sse.mjs';
import { shouldFallbackTransport } from './retry-classifier.mjs';
import { resolveOpenAiTransportPolicy } from './openai-transport-policy.mjs';
import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import {
    resolveProviderCacheKey,
    resolveProviderPromptCacheLane,
} from '../agent-runtime/cache-strategy.mjs';

const OPENAI_DIRECT_PRIORITY_MODEL_PATTERNS = Object.freeze([
    /^gpt-5\.5(?:-\d{4}|$)/,
    /^gpt-5\.4(?:-\d{4}|$)/,
    /^gpt-5\.4-mini(?:-\d{4}|$)/,
]);

function openAiDirectSupportsPriority(model) {
    const id = String(model || '').trim();
    return OPENAI_DIRECT_PRIORITY_MODEL_PATTERNS.some(re => re.test(id));
}

function applyOpenAIDirectFastTier(body, model, opts) {
    if (opts?.fast === true && openAiDirectSupportsPriority(model)) {
        body.service_tier = 'priority';
    }
    return body;
}

function shouldFallbackDirectTransport(err, options) {
    const status = Number(err?.httpStatus || err?.status || 0);
    const unsafeToRetry = err?.liveTextEmitted === true
        || err?.emittedToolCall === true
        || err?.unsafeToRetry === true;
    if (unsafeToRetry || options?.signal?.aborted || options?.enabled === false) return false;
    // Public OpenAI can reject the WebSocket upgrade while still supporting
    // the same request over HTTP/SSE. Only the shared transport's explicit
    // handshake marker may turn these application-looking statuses into a
    // one-shot transport fallback.
    if (err?.wsFailurePhase === 'handshake'
        && err?.wsHttpFallbackEligible === true
        && [403, 404, 429].includes(status)) {
        return true;
    }
    // These are application/auth/quota outcomes from the public Responses API,
    // not evidence that WebSocket transport is unhealthy. Reissuing them over
    // HTTP cannot recover and can duplicate an accepted throttled request.
    if (status >= 400 && status < 500) return false;
    return shouldFallbackTransport(err, options);
}

function directOpenAiHandshakeErrorPolicy({ status }) {
    if ([403, 404, 429].includes(Number(status))) {
        return { retry: false, httpFallback: true };
    }
    return null;
}

const DIRECT_WS_TEST_SEAM_KEYS = Object.freeze([
    '_acquireWithRetryFn',
    '_streamFn',
    '_sendFrameFn',
    '_sleepFn',
    '_sendSpanTraceFn',
    '_agentTraceFn',
]);

function directWebSocketTestSeams(value) {
    if (!value || typeof value !== 'object') return {};
    const out = {};
    for (const key of DIRECT_WS_TEST_SEAM_KEYS) {
        if (typeof value[key] === 'function') out[key] = value[key];
    }
    return out;
}

export class OpenAIDirectProvider {
    // input_tokens INCLUDES cached tokens (OpenAI convention). See registry.mjs.
    static inputExcludesCache = false;
    name = 'openai';
    config;
    constructor(config) {
        this.config = config || {};
    }
    _ensureKey() {
        const k = this.config.apiKey;
        if (!k) throw new Error('OPENAI_API_KEY not configured (providers.openai.apiKey)');
        return k;
    }
    // Auth-recovery mirror of openai-compat.reloadApiKey: on a 401 the key
    // was likely rotated after this provider instance was built, so re-read
    // only OpenAI's environment/keychain sources before the single retry.
    // Returns the fresh key (or null if none) — no client to rebuild here since
    // the WS/HTTP transports take the key per-call via the `auth` object.
    reloadApiKey() {
        try {
            const newKey = getAgentApiKey('openai') || this.config.apiKey;
            if (newKey) {
                this.config = { ...(this.config || {}), apiKey: newKey };
                return newKey;
            }
        } catch { /* best effort */ }
        return null;
    }
    async send(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        const externalSignal = opts.signal || null;
        const apiKey = this._ensureKey();
        const useModel = model || 'gpt-5.5';
        const promptCacheLane = resolveProviderPromptCacheLane('openai', opts, this.config);
        const body = buildRequestBody(messages, useModel, tools, {
            ...sendOpts,
            promptCacheProvider: 'openai',
            promptCacheLane,
        });
        // Public OpenAI API priority support is documented separately from the
        // openai-oauth catalog. Keep this provider's service-tier decision local
        // so gpt-5.4-mini can opt into Priority even when the OAuth catalog does
        // not advertise a Fast tier for its OAuth endpoint.
        applyOpenAIDirectFastTier(body, useModel, opts);
        // P0 audit fix: buildRequestBody (openai-oauth.mjs) defaults
        // store:false (env-gated, MIXDOG_OAI_STORE), which is correct for
        // the openai-oauth ChatGPT-subscription backend — that backend keeps
        // its own conversation state via the WS handshake session_id
        // (see openai-oauth-ws.mjs "conversation slot ... in-memory prefix
        // state"), independent of the public Responses API `store` field.
        // The public OpenAI direct WS path below, however, talks to the real
        // api.openai.com Responses API, where `previous_response_id`
        // continuation is only valid when the anchored response was actually
        // stored — store:false + previous_response_id is a broken
        // combination there (the server has nothing to look up). This
        // provider's WS transport always injects previous_response_id via
        // openai-oauth-ws.mjs's delta path once a response id is cached, so
        // force store:true here — same override xAI's Responses path takes
        // (see openai-compat.mjs _doSendXaiResponses/_doSendXaiResponsesWebSocket:
        // "the public endpoint currently returns previous_response_not_found
        // ... unless the chain is stored").
        body.store = true;
        // Public Responses API supports prompt_cache_retention='24h' at no
        // extra cost (same cached_input_tokens billing as the default 5–10
        // min in-memory cache). openai-oauth rejects the parameter, so it's
        // injected only on the direct path. See openai-oauth.mjs:290-294
        // for the rationale.
        body.prompt_cache_retention = '24h';
        // poolKey MUST be sessionId-only. Falling back to promptCacheKey would
        // let unrelated raw sessions sharing the same provider-scoped cache
        // bucket reuse each other's pooled socket and inherit lastResponseId
        // delta state, producing cross-session prompt corruption.
        const poolKey  = opts.sessionId || null;
        // cacheKey (prompt_cache_key) only groups the server-side prefix-cache
        // shard — safe to share across sessions, unlike the sessionId poolKey
        // above. buildRequestBody derives it from the base namespace plus a
        // model/system/tools hash, mirroring the openai-oauth path while keeping
        // public OpenAI's 24h retention below.
        const cacheKey = body.prompt_cache_key || resolveProviderCacheKey(opts, 'openai');
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        const auth = { type: 'openai-direct', apiKey };
        const common = {
            body,
            onStreamDelta,
            onToolCall,
            onTextDelta,
            onStageChange,
            externalSignal,
            poolKey,
            cacheKey,
            iteration,
            useModel,
        };
        // Keep the same deterministic transport seams as openai-oauth. Besides
        // making the direct path regression-testable without a live request,
        // this lets embedded callers supply their already-instrumented
        // Responses transports without changing the public request envelope.
        const sendWs = typeof opts._sendViaWebSocketFn === 'function'
            ? opts._sendViaWebSocketFn
            : sendViaWebSocket;
        const sendHttp = typeof opts._sendViaHttpSseFn === 'function'
            ? opts._sendViaHttpSseFn
            : sendViaHttpSse;
        const wsTestSeams = directWebSocketTestSeams(opts._webSocketTestSeams);
        const dispatchWs = (a) => sendWs({
            ...common,
            auth: a,
            sendOpts: opts,
            displayModel: (id) => id,
            // Public direct WS must not inherit the openai-oauth trace provider:
            // that key drives the Codex WS client-metadata path
            // (useCodexWsClientMetadata = traceProvider === 'openai-oauth') and
            // the OAuth/Codex handshake headers. Direct API-key auth pins its own
            // provider so it stays on the public (non-Codex) envelope.
            traceProvider: 'openai-direct',
            // Narrow deterministic seams for transport-policy regression tests.
            // Production callers never set this object.
            ...wsTestSeams,
            // Mandatory and deliberately applied AFTER sanitized test seams:
            // no caller can disable or invert direct handshake provenance.
            handshakeErrorPolicy: directOpenAiHandshakeErrorPolicy,
        });
        // WS→HTTP/SSE fallback mirrors the openai-oauth wrapper: the shared
        // HTTP transport now accepts auth.type==='openai-direct' (public
        // Responses endpoint + Bearer <apiKey>), so the api-key provider gets
        // the same envelope. The direct gate denies every application 4xx and
        // any liveTextEmitted/emittedToolCall/unsafeToRetry outcome.
        const transportPolicy = resolveOpenAiTransportPolicy();
        const httpFallbackEnabled = transportPolicy.allowHttpFallback
            && _envFlag('MIXDOG_OPENAI_HTTP_FALLBACK', true);
        const dispatchHttp = (a) => {
            if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) {
                process.stderr.write('[openai-ws] WebSocket unhealthy; falling back to HTTP/SSE\n');
            }
            return sendHttp({ ...common, auth: a, opts, fetchFn: opts._fetchFn });
        };
        // Transport-policy switch (MIXDOG_OAI_TRANSPORT). 'http-sse' forces the
        // HTTP/SSE transport directly — no WS attempt, so skip the fallback log
        // that dispatchHttp emits (it is not a fallback here). All other modes
        // ('auto'/'ws-full'/'ws-delta') keep the WS-first path below; ws-full vs
        // ws-delta only affects the delta gate inside openai-ws-delta.mjs.
        if (transportPolicy.transport === 'http') {
            return await sendHttp({ ...common, auth, opts, fetchFn: opts._fetchFn });
        }
        try {
            return await dispatchWs(auth);
        } catch (err) {
            const status = err?.httpStatus;
            // Live-text/tool invariant: never reissue a turn that already
            // relayed visible output or dispatched a tool call.
            const unsafeToRetry = err?.liveTextEmitted === true
                || err?.emittedToolCall === true
                || err?.unsafeToRetry === true;
            // (1) 401 → reload only OpenAI auth and retry once over WS.
            // Ordinary 403 is a permission/policy decision, not evidence that
            // an API key rotated. Match the OAuth path and keep it terminal.
            // The direct fallback guard denies auth statuses, so this branch
            // owns the single credential-reload replay.
            if (status === 401 && err?.wsFailurePhase !== 'stream' && !unsafeToRetry) {
                process.stderr.write(`[openai-ws] ${status} — reloading apiKey and retrying once\n`);
                const freshKey = this.reloadApiKey();
                if (freshKey) {
                    const retryAuth = { type: 'openai-direct', apiKey: freshKey };
                    try {
                        return await dispatchWs(retryAuth);
                    } catch (retryErr) {
                        if (shouldFallbackDirectTransport(retryErr, { signal: externalSignal, enabled: httpFallbackEnabled })) {
                            return await dispatchHttp(retryAuth);
                        }
                        throw retryErr;
                    }
                }
                throw err;
            }
            // (2) WS transport failure → HTTP/SSE fallback (predicate handles
            //     the safety denies).
            if (shouldFallbackDirectTransport(err, { signal: externalSignal, enabled: httpFallbackEnabled })) {
                return await dispatchHttp(auth);
            }
            throw err;
        }
    }
    async listModels() {
        try {
            const apiKey = this._ensureKey();
            const res = await fetch('https://api.openai.com/v1/models', {
                signal: AbortSignal.timeout(10_000),
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            if (!res.ok) return [];
            const j = await res.json();
            const models = (j.data || []).map((m) => ({
                id: m.id,
                name: m.id,
                provider: 'openai',
                contextWindow: 0,
                // Preserve release timestamp from OpenAI so downstream
                // freshness filters (e.g. setup UI's 6-month coding-model
                // cutoff) can drop deprecated generations.
                created: typeof m.created === 'number' ? m.created : null,
            }));
            return sanitizeModelList(await enrichModels(models), { provider: 'openai' });
        } catch {
            return [];
        }
    }
    async isAvailable() {
        return !!this.config.apiKey;
    }
}
