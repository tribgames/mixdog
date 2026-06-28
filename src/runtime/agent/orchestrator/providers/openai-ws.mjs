/**
 * OpenAI Direct API — WebSocket transport via Responses API.
 *
 * Uses the same `sendViaWebSocket` plumbing as openai-oauth (Codex), with two
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
import {
    resolveProviderCacheKey,
    resolveProviderPromptCacheLane,
} from '../agent-runtime/cache-strategy.mjs';

const OPENAI_DIRECT_PRIORITY_MODEL_PATTERNS = Object.freeze([
    /^gpt-5\.5(?:-\d{4}|$)/,
    /^gpt-5\.4(?:-\d{4}|$)/,
    /^gpt-5\.4-mini(?:-\d{4}|$)/,
]);

export function openAiDirectSupportsPriority(model) {
    const id = String(model || '').trim();
    return OPENAI_DIRECT_PRIORITY_MODEL_PATTERNS.some(re => re.test(id));
}

export function applyOpenAIDirectFastTier(body, model, opts) {
    if (opts?.fast === true && openAiDirectSupportsPriority(model)) {
        body.service_tier = 'priority';
    }
    return body;
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
        // Codex OAuth catalog. Keep this provider's service-tier decision local
        // so gpt-5.4-mini can opt into Priority even when the Codex catalog does
        // not advertise a Fast tier for its OAuth endpoint.
        applyOpenAIDirectFastTier(body, useModel, opts);
        // Public Responses API supports prompt_cache_retention='24h' at no
        // extra cost (same cached_input_tokens billing as the default 5–10
        // min in-memory cache). Codex/oauth rejects the parameter, so it's
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
        // model/system/tools hash, mirroring the Codex OAuth path while keeping
        // public OpenAI's 24h retention below.
        const cacheKey = body.prompt_cache_key || resolveProviderCacheKey(opts, 'openai');
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        const auth = { type: 'openai-direct', apiKey };
        return sendViaWebSocket({
            auth,
            body,
            sendOpts: opts,
            onStreamDelta,
            onToolCall,
            onTextDelta,
            onStageChange,
            externalSignal,
            poolKey,
            cacheKey,
            iteration,
            useModel,
            displayModel: (id) => id,
        });
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
            return await enrichModels(models);
        } catch {
            return [];
        }
    }
    async isAvailable() {
        return !!this.config.apiKey;
    }
}
