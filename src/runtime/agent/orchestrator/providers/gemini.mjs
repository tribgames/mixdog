import { GoogleGenerativeAI } from '@google/generative-ai';
import { getAgentApiKey } from '../../../shared/provider-api-key.mjs';
import { withRetry } from './retry-classifier.mjs';
import { traceAgentUsage, appendAgentTrace } from '../agent-trace.mjs';
import {
    PROVIDER_FIRST_BYTE_TIMEOUT_MS,
    PROVIDER_MAX_BEFORE_WARN_MS,
    PROVIDER_SSE_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    PROVIDER_CACHE_CREATE_TIMEOUT_MS,
    PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS,
    providerTimeoutError,
    resolveTimeoutMs,
    createTimeoutSignal,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import {
    GEMINI_FIRST_BYTE_TIMEOUT_MS,
    geminiTimeoutError,
    createGeminiTextLeakGuard,
    consumeGeminiRestStreamResponse,
    consumeGeminiSdkStream,
} from './gemini-stream.mjs';
import {
    toGeminiTools,
    toGeminiNativeTools,
    toGeminiToolConfig,
    toGeminiContents,
    parseToolCalls,
    emitGeminiToolCalls,
    collectGeminiGroundingSources,
    parseGeminiThinkingParts,
    parseGeminiTextPartMetadata,
} from './gemini-schema.mjs';
import {
    _estimateGeminiCacheTokens,
    _geminiCacheMinTokens,
    _geminiCachePrefixCount,
    _geminiCachePrefixContents,
    _geminiCachePrefixHash,
    _geminiGlobalCacheKey,
    _getGeminiGlobalCache,
    _setGeminiGlobalCache,
    _geminiGlobalCacheNameIsLive,
    _attachGeminiCacheState,
    _resolveGeminiCacheUsage,
    writeGeminiCacheTrace,
    geminiGlobalCacheCreates,
    GEMINI_GLOBAL_CACHE_DELETE_GRACE_MS,
    _geminiCredentialFingerprint,
    _invalidateGeminiCachesForCredentialFingerprint,
    _invalidateGeminiCacheName,
} from './gemini-cache.mjs';
import {
    GEMINI_MODELS as MODELS,
    DEFAULT_GEMINI_MODEL as DEFAULT_MODEL,
    geminiModelCache as _modelCache,
    fetchGeminiModelPages,
    resolveLatestGeminiModel,
    ensureLatestGeminiModel,
    fetchAndCacheGeminiModels,
} from './lib/gemini-model-catalog.mjs';

// Legacy import path: tests + gemini-stream import these from gemini.mjs.
// Re-export the extracted symbols so existing importers resolve unchanged.
export { createGeminiTextLeakGuard };
export { parseToolCalls, emitGeminiToolCalls, collectGeminiGroundingSources, parseGeminiTextPartMetadata };
export { fetchGeminiModelPages, resolveLatestGeminiModel, ensureLatestGeminiModel };

// De-dupes concurrent force-refreshes so they share one HTTP round-trip,
// mirroring anthropic-oauth's _modelRefreshInFlight.
let _modelRefreshInFlight = null;
const GEMINI_AVAILABILITY_TIMEOUT_MS = 1_000;

function geminiRestError(res, text, label) {
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    const detail = payload?.error || payload || null;
    const err = new Error(`${label} ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.httpStatus = res.status;
    err.headers = res.headers;
    if (detail) {
        err.error = detail;
        err.data = payload;
        if (detail.status) err.geminiStatus = detail.status;
        if (Array.isArray(detail.details)) err.details = detail.details;
        const retryAfter = res.headers?.get?.('retry-after')
            ?? res.headers?.get?.('retry-after-ms');
        // RESOURCE_EXHAUSTED without a server retry window is deterministic
        // quota exhaustion. With Retry-After present, leave it request-local
        // so withRetry can honor the mandated delay.
        if (detail.status && (retryAfter == null || retryAfter === '')) {
            err.code = detail.status;
        }
    }
    return err;
}

function isGeminiCachedContentError(err, cacheName) {
    const status = Number(err?.status || err?.httpStatus || 0);
    if (status !== 400 && status !== 404) return false;
    const text = `${err?.message || ''} ${JSON.stringify(err?.data || '')}`.toLowerCase();
    return text.includes('cachedcontent')
        || text.includes('cached content')
        || (cacheName && text.includes(String(cacheName).toLowerCase()));
}

// --- Cache accounting/trace: extracted to gemini-cache.mjs ---
// --- Stream consumption/guards: extracted to gemini-stream.mjs ---
// --- Schema/content/tool-call mapping: extracted to gemini-schema.mjs ---

export class GeminiProvider {
    // promptTokenCount is the total (cachedContentTokenCount is a subset), so
    // input already includes cache. See registry.mjs.
    static inputExcludesCache = false;
    name = 'gemini';
    genAI;
    config;
    _fetch;
    _preconnect;
    _createGenAI;
    _modelCache;

    constructor(config = {}) {
        this.config = config;
        this._fetch = typeof config.fetchFn === 'function' ? config.fetchFn : fetch;
        this._preconnect = typeof config.preconnectFn === 'function' ? config.preconnectFn : preconnect;
        this._createGenAI = typeof config.createGenAI === 'function'
            ? config.createGenAI
            : (apiKey) => new GoogleGenerativeAI(apiKey);
        this._modelCache = config.modelCache || _modelCache;
        const apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
        this.genAI = config.genAI || this._createGenAI(apiKey);
        // Warm a kept-alive socket to the Gemini REST API so the first cache/
        // generateContent request skips the cold TLS handshake. Best-effort.
        this._preconnect('https://generativelanguage.googleapis.com');
    }

    reloadApiKey() {
        try {
            const newKey = getAgentApiKey('gemini')
                || this.config?.apiKey
                || process.env.GEMINI_API_KEY;
            if (newKey) {
                // Keep this.config in sync so REST/cache paths (which read the
                // key via _getApiKey() → this.config.apiKey) don't keep using
                // the stale key after a rotation; genAI alone is not enough.
                this.config = { ...(this.config || {}), apiKey: newKey };
                this.genAI = this._createGenAI(newKey);
            }
            return newKey || '';
        } catch { /* best effort */ }
        return '';
    }

    _getApiKey() {
        return this.config?.apiKey || process.env.GEMINI_API_KEY || '';
    }

    // Explicit cachedContents API. The implicit cache layer on Gemini 3.x
    // does not surface cachedContentTokenCount in usageMetadata, so the only
    // way to obtain measurable + billable cache savings is to register the
    // stable prefix (system + tools) as a CachedContent and pass its name on
    // every generateContent call. TTL is 1h so a single worker session keeps
    // one cache slot warm without re-creation overhead; storage cost (~$0.5/M
    // tokens/hour) is dwarfed by the 75% input-price discount on hits beyond
    // a few iterations.
    async _ensureGeminiCache({ apiKey, model, systemInstruction, geminiTools, toolConfig, contents, opts, skipExplicitCache = false }) {
        if (skipExplicitCache) return null;
        if (Array.isArray(opts?.nativeTools) && opts.nativeTools.length) return null;
        // Kill-switch: MIXDOG_GEMINI_EXPLICIT_CACHE=0 skips cachedContents
        // entirely and relies on Gemini's implicit prefix caching (2.5+/3.x
        // default, same 90% discount, no storage fee). A/B probe knob.
        const explicitMode = String(process.env.MIXDOG_GEMINI_EXPLICIT_CACHE || '').trim().toLowerCase();
        if (['0', 'false', 'off', 'no'].includes(explicitMode)) return null;
        const state = opts.providerState?.gemini || null;
        const credentialFingerprint = _geminiCredentialFingerprint(apiKey);
        const now = Date.now();
        const currentIter = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : 1;
        const refreshEveryN = Number(process.env.MIXDOG_GEMINI_CACHE_REFRESH_EVERY) > 0
            ? Number(process.env.MIXDOG_GEMINI_CACHE_REFRESH_EVERY)
            : 4;
        // Cache TTL (storage is billed per token-hour, so shorter is cheaper).
        // Default 5m: agent tool loops re-request within seconds, and the
        // refresh-every-4-iterations rebuild re-arms the TTL well before
        // expiry. Long-idle sessions just pay one cold rebuild on resume.
        const ttlSeconds = Number(process.env.MIXDOG_GEMINI_CACHE_TTL_SECONDS) > 0
            ? Number(process.env.MIXDOG_GEMINI_CACHE_TTL_SECONDS)
            : 300;
        // Reuse guard: require some remaining TTL headroom so we never attach
        // a cache that expires mid-request. Scale with TTL (25%, clamped to
        // 10s..6m) — the old fixed 6-minute floor silently disabled reuse for
        // any TTL <= 6m, forcing a full-price rebuild every turn.
        const reuseHeadroomMs = Math.min(6 * 60 * 1000, Math.max(10 * 1000, ttlSeconds * 250));
        const cacheLiveMs = state?.cacheExpiresAt ? state.cacheExpiresAt - now : 0;
        const itersSinceCreate = state?.cacheCreatedAtIter != null
            ? currentIter - state.cacheCreatedAtIter
            : Infinity;
        const statePrefixContentCount = Number.isFinite(Number(state?.cachePrefixContentCount))
            ? Math.max(0, Math.trunc(Number(state.cachePrefixContentCount)))
            : null;
        const currentStatePrefixHash = statePrefixContentCount != null
            ? _geminiCachePrefixHash({
                model,
                systemInstruction,
                geminiTools,
                toolConfig,
                contents,
                prefixCount: statePrefixContentCount,
            })
            : null;
        const modelMatches = !!state?.cacheName && state?.cacheModel === model;
        const credentialMatches = !!state?.cacheName
            && state?.cacheCredentialFingerprint === credentialFingerprint;
        const prefixMatches = !!state?.cacheName
            && statePrefixContentCount != null
            && statePrefixContentCount <= (Array.isArray(contents) ? contents.length : 0)
            && !!state?.cachePrefixHash
            && state.cachePrefixHash === currentStatePrefixHash;
        const canAttachState = !!state?.cacheName && cacheLiveMs > 0
            && modelMatches && credentialMatches && prefixMatches;
        const canReuseState = canAttachState && cacheLiveMs > reuseHeadroomMs && itersSinceCreate < refreshEveryN;
        try {
            appendAgentTrace({
                sessionId: opts.sessionId || opts.session?.id || null,
                iteration: currentIter,
                kind: 'gemini_cache_decision',
                payload: {
                    hasState: !!state?.cacheName,
                    stateCacheName: state?.cacheName || null,
                    stateCreatedAtIter: state?.cacheCreatedAtIter ?? null,
                    stateCacheModel: state?.cacheModel || null,
                    statePrefixContentCount,
                    statePrefixHash: state?.cachePrefixHash || null,
                    currentStatePrefixHash,
                    modelMatches,
                    credentialMatches,
                    prefixMatches,
                    canAttachState,
                    cacheLiveMs,
                    itersSinceCreate,
                    refreshEveryN,
                    decision: canReuseState ? 'reuse' : 'rebuild',
                    contentsLen: Array.isArray(contents) ? contents.length : 0,
                },
            });
        } catch {}
        if (canReuseState) {
            return state.cacheName;
        }
        if (!apiKey) return null;
        // Pre-flight invariant: cachedContents.create rejects prefixes below
        // the model-specific minimum. Skip the POST entirely when the estimate
        // is under threshold so we don't spam 400 responses turn-after-turn.
        const minTokens = _geminiCacheMinTokens(model);
        const estimatedTokens = _estimateGeminiCacheTokens(systemInstruction, geminiTools, contents);
        if (estimatedTokens < minTokens) {
            try {
                appendAgentTrace({
                    sessionId: opts.sessionId || opts.session?.id || null,
                    iteration: currentIter,
                    kind: 'gemini_cache_skip',
                    payload: {
                        reason: 'prefix_below_min',
                        estimatedTokens,
                        minTokens,
                        model,
                    },
                });
            } catch {}
            return canAttachState ? state.cacheName : null;
        }
        const cachePrefixContentCount = _geminiCachePrefixCount(contents);
        const cachePrefixHash = _geminiCachePrefixHash({
            model,
            systemInstruction,
            geminiTools,
            toolConfig,
            contents,
            prefixCount: cachePrefixContentCount,
        });
        const globalCacheKey = _geminiGlobalCacheKey({
            credentialFingerprint,
            model,
            cachePrefixHash,
            cachePrefixContentCount,
        });
        const globalCache = _getGeminiGlobalCache(globalCacheKey, now);
        if (globalCache) {
            try {
                appendAgentTrace({
                    sessionId: opts.sessionId || opts.session?.id || null,
                    iteration: currentIter,
                    kind: 'gemini_cache_global_hit',
                    payload: {
                        cacheName: globalCache.cacheName,
                        cacheTokenSize: globalCache.cacheTokenSize,
                        cachePrefixContentCount,
                        cachePrefixHash,
                    },
                });
            } catch {}
            _attachGeminiCacheState(opts, globalCache, currentIter);
            return globalCache.cacheName;
        }
        const inFlightCreate = geminiGlobalCacheCreates.get(globalCacheKey);
        if (inFlightCreate) {
            const created = await inFlightCreate.catch(() => null);
            if (created?.cacheName) {
                try {
                    appendAgentTrace({
                        sessionId: opts.sessionId || opts.session?.id || null,
                        iteration: currentIter,
                        kind: 'gemini_cache_global_wait_hit',
                        payload: {
                            cacheName: created.cacheName,
                            cacheTokenSize: created.cacheTokenSize,
                            cachePrefixContentCount,
                            cachePrefixHash,
                        },
                    });
                } catch {}
                _attachGeminiCacheState(opts, created, currentIter);
                return created.cacheName;
            }
        }
        const createTask = (async () => {
            try {
            const cachePrefixContents = _geminiCachePrefixContents(contents, cachePrefixContentCount);
            const body = {
                model: `models/${model}`,
                ttl: `${ttlSeconds}s`,
            };
            if (systemInstruction) {
                body.systemInstruction = { parts: [{ text: systemInstruction }] };
            }
            if (Array.isArray(geminiTools) && geminiTools.length) {
                body.tools = geminiTools;
            }
            if (toolConfig) body.toolConfig = toolConfig;
            // Capture conversation prefix (everything except the latest user/
            // tool input that the generateContent call will carry) inside the
            // cache. cachedContents only accepts role='user' or 'model';
            // generateContent uses role='function' for tool_result turns, so
            // collapse that to 'user' (functionResponse parts remain inside).
            if (cachePrefixContents.length) {
                body.contents = cachePrefixContents;
            }
            const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${encodeURIComponent(apiKey)}`;
            // Honor the external session abort signal during cache creation, not
            // only the 20s ceiling. Without merging opts.signal a session that is
            // aborted (stall-watchdog / closeSession) mid-cache-create leaves this
            // preflight request running until its own timeout fires.
            const createTotal = createTimeoutSignal(
                opts.signal,
                PROVIDER_CACHE_CREATE_TOTAL_TIMEOUT_MS,
                'Gemini cachedContents.create total',
            );
            let data;
            try {
                data = await withRetry(async ({ signal: attemptSignal }) => {
                    const res = await this._fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                        signal: attemptSignal,
                        dispatcher: getLlmDispatcher(),
                    });
                    if (res.ok) return await res.json();
                    const text = await res.text().catch(() => '');
                try {
                    appendAgentTrace({
                        sessionId: opts.sessionId || opts.session?.id || null,
                        iteration: currentIter,
                        kind: 'gemini_cache_create_fail',
                        payload: {
                            status: res.status,
                            body: text.slice(0, 500),
                            contentsLen: Array.isArray(contents) ? contents.length : 0,
                            cachePrefixContentCount,
                            canAttachState,
                        },
                    });
                } catch {}
                    throw geminiRestError(res, text, 'Gemini cachedContents.create');
                }, {
                    signal: createTotal.signal,
                    perAttemptTimeoutMs: PROVIDER_CACHE_CREATE_TIMEOUT_MS,
                    perAttemptLabel: 'Gemini cachedContents.create',
                });
            } finally {
                createTotal.cleanup();
            }
            const cacheName = data?.name || null;
            if (!cacheName) return null;
            const cacheTokenSize = Number(data?.usageMetadata?.totalTokenCount || 0) || 0;
            try {
                appendAgentTrace({
                    sessionId: opts.sessionId || opts.session?.id || null,
                    iteration: currentIter,
                    kind: 'gemini_cache_create_ok',
                    payload: {
                        cacheName,
                        cacheTokenSize,
                        contentsLen: Array.isArray(contents) ? contents.length : 0,
                        cachePrefixContentCount,
                        cachePrefixHash,
                    },
                });
            } catch {}
            // Best-effort cleanup of the previous cache so storage cost only
            // accrues on the live revision. Fire-and-forget; TTL expiry covers
            // any delete failures.
            //
            // Cross-session race: `_geminiGlobalCacheNameIsLive` only checks
            // whether `priorCacheName` still appears as *some* entry's live
            // cacheName in `geminiGlobalCaches`. If another session sharing the
            // same globalCacheKey already overwrote that map slot with a newer
            // cache (via `_setGeminiGlobalCache`), the check sees "not live" for
            // a name that a *different* in-flight session still holds in its own
            // `providerState.gemini.cacheName` (captured earlier via
            // `_attachGeminiCacheState` and possibly already in-flight inside a
            // `generateContent`/`streamGenerateContent` call at L1470-1473).
            // Deleting immediately can 404 that concurrent request server-side.
            //
            // Fix chosen: delay the DELETE by a grace period instead of adding
            // refcounting/last-used-session tracking. Rationale (minimal-change,
            // matches the module's existing "best-effort, TTL is the backstop"
            // posture at L1342-1343):
            //   - Any session that captured `priorCacheName` did so before this
            //     create finished, so its in-flight (or next) turn using that
            //     name almost certainly completes within a couple of minutes;
            //     a short grace window is enough for it to either finish or move
            //     on to a fresh cache attach.
            //   - The server-side cache TTL (1h) already reclaims any cache we
            //     fail to delete, so skipping/delaying deletion is safe — it
            //     only costs a little extra storage for at most the grace
            //     window, never correctness.
            //   - Refcounting/session tracking would need to plumb per-session
            //     liveness into a shared map across concurrent providers, which
            //     is a much larger change for a purely cosmetic cost saving.
            // Re-check liveness right before firing the DELETE too, in case the
            // name became live again (e.g. re-attached) during the wait.
            const priorCacheName = state?.cacheName || null;
            if (priorCacheName && priorCacheName !== cacheName) {
                setTimeout(() => {
                    if (_geminiGlobalCacheNameIsLive(priorCacheName)) return;
                    const delUrl = `https://generativelanguage.googleapis.com/v1beta/${priorCacheName}?key=${encodeURIComponent(apiKey)}`;
                    this._fetch(delUrl, { method: 'DELETE', signal: AbortSignal.timeout(10_000), dispatcher: getLlmDispatcher() })
                        .catch(() => { /* TTL expiry will reclaim it */ });
                }, GEMINI_GLOBAL_CACHE_DELETE_GRACE_MS).unref?.();
            }
            const createdAt = Date.now();
            const entry = {
                cacheName,
                cacheCreatedAt: createdAt,
                cacheExpiresAt: createdAt + ttlSeconds * 1000,
                cacheModel: model,
                cacheTokenSize,
                cachePrefixContentCount,
                cachePrefixHash,
                cacheCredentialFingerprint: credentialFingerprint,
            };
            _setGeminiGlobalCache(globalCacheKey, entry);
            return entry;
            } catch (err) {
                process.stderr.write(`[gemini] cachedContents.create error: ${err?.message || err}\n`);
                return null;
            }
        })();
        geminiGlobalCacheCreates.set(globalCacheKey, createTask);
        try {
            const created = await createTask;
            // A failed refresh must not silently retain a cache that may have
            // expired or been evicted server-side. The caller proceeds uncached.
            if (!created?.cacheName) return null;
            _attachGeminiCacheState(opts, created, currentIter);
            return created.cacheName;
        } finally {
            if (geminiGlobalCacheCreates.get(globalCacheKey) === createTask) {
                geminiGlobalCacheCreates.delete(globalCacheKey);
            }
        }
    }

    async send(messages, model, tools, sendOpts) {
        // Re-warm a kept-alive socket before the turn (TTL-gated no-op while
        // hot) so a post-idle request skips the cold TLS handshake.
        this._preconnect('https://generativelanguage.googleapis.com');
        try {
            return await this._doSend(messages, model, tools, sendOpts);
        } catch (err) {
            if (err?.status === 401 || err?.status === 403
                || (err?.message && (err.message.includes('401') || err.message.includes('403')))) {
                if (err.liveTextEmitted === true || err.emittedToolCall === true || err.unsafeToRetry === true) {
                    throw err;
                }
                process.stderr.write(`[provider] Auth error, re-reading provider authentication...\n`);
                const oldCredentialFingerprint = _geminiCredentialFingerprint(this._getApiKey());
                const newKey = this.reloadApiKey();
                _invalidateGeminiCachesForCredentialFingerprint(oldCredentialFingerprint);
                const geminiState = sendOpts?.providerState?.gemini;
                if (geminiState?.cacheName) {
                    const { gemini: _dropGemini, ...rest } = sendOpts.providerState;
                    sendOpts.providerState = rest;
                }
                if (!newKey) throw err;
                return await this._doSend(messages, model, tools, sendOpts);
            }
            throw err;
        }
    }

    async _doSend(messages, model, tools, sendOpts, internal = {}) {
        const opts = sendOpts || {};
        const signal = opts.signal || null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error('Gemini request aborted by session close');
        }

        const useModel = model || await ensureLatestGeminiModel(this);
        const systemInstruction = messages
            .filter(m => m.role === 'system')
            .map(m => m.content)
            .join('\n\n') || undefined;
        const chatMsgs = messages.filter(m => m.role !== 'system');
        const contents = toGeminiContents(chatMsgs);
        if (!contents.length)
            throw new Error('No messages to send');

        const nativeGeminiTools = toGeminiNativeTools(opts.nativeTools);
        const functionGeminiTools = tools?.length ? [toGeminiTools(tools)] : [];
        const geminiTools = nativeGeminiTools.length || functionGeminiTools.length
            ? [...nativeGeminiTools, ...functionGeminiTools]
            : undefined;
        const toolConfig = functionGeminiTools.length ? toGeminiToolConfig(opts.toolChoice) : undefined;
        try { opts.onStageChange?.('requesting'); } catch {}

        const buildTextLeakGuard = () => createGeminiTextLeakGuard({
            knownToolNames: tools?.map((t) => t.name).filter(Boolean) ?? [],
            onTextDelta,
            onToolCall,
            onStreamDelta,
        });
        let textLeakGuard = null;

        // Explicit cachedContents (system + tools + prior-turn transcript).
        // Cache system/tools/toolConfig together. Google rejects repeating
        // those fields on generateContent when cachedContent is attached.
        // The contents payload captures the accumulated prefix; refresh every
        // N iterations so recent turns also enter the cached prefix.
        const cachedContent = await this._ensureGeminiCache({
            apiKey: this._getApiKey(),
            model: useModel,
            systemInstruction,
            geminiTools,
            toolConfig,
            contents,
            opts,
            skipExplicitCache: internal.skipExplicitCache === true,
        });
        try { opts.onStageChange?.('requesting'); } catch {}

        // When cachedContent is attached we bypass @google/generative-ai
        // (deprecated; v1beta v1.x docs explicitly forbid re-sending tools or
        // systemInstruction once a cache carries them, but the bundled SDK
        // can't actually issue a tool-less generateContent call). REST direct
        // sends the v1beta payload Google's new genai client uses, so the
        // cache owns system/tools and the runtime gets a clean cache hit.
        let response;
        if (cachedContent) {
            const apiKey = this._getApiKey();
            const genUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
            const cachedPrefixContentCount = Number.isFinite(Number(opts.providerState?.gemini?.cachePrefixContentCount))
                ? Math.max(0, Math.min(contents.length, Math.trunc(Number(opts.providerState.gemini.cachePrefixContentCount))))
                : 0;
            const deltaContents = contents.slice(cachedPrefixContentCount);
            // Cache carries the recorded prefix. Send every uncached tail turn,
            // not just the last message, so reused cachedContents preserve
            // full conversation context between periodic refreshes.
            const body = {
                contents: deltaContents.length ? deltaContents : contents.slice(-1),
                cachedContent,
            };
            // cachedContent owns tools + toolConfig. The API rejects a
            // generateContent request that repeats either field.
            // Option A (mirror anthropic-oauth): no absolute wall-clock cap on a
            // live streaming turn. A stream that keeps emitting SSE deltas must
            // not be killed by a fixed total-lifetime timer — that false-aborts
            // healthy high-reasoning turns still producing tokens. The streaming
            // phase is bounded instead by the per-attempt first-byte timeout
            // (truly wedged socket), the external signal (client disconnect /
            // replaced request), and the SSE idle watchdog. totalSignal is a pure
            // pass-through of the external signal with no timer.
            const restPassthrough = createPassthroughSignal(signal);
            const totalSignal = restPassthrough.signal;
            try {
                response = await withRetry(
                    async ({ signal: attemptSignal }) => {
                        try { opts.onStageChange?.('requesting'); } catch {}
                        const openFirstByte = createTimeoutSignal(
                            attemptSignal,
                            GEMINI_FIRST_BYTE_TIMEOUT_MS,
                            'Gemini REST first byte',
                        );
                        let res;
                        try {
                            res = await this._fetch(genUrl, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(body),
                                signal: openFirstByte.signal,
                                dispatcher: getLlmDispatcher(),
                            });
                        } finally {
                            openFirstByte.cleanup();
                        }
                        if (!res.ok) {
                            const text = await res.text().catch(() => '');
                            throw geminiRestError(res, text, 'Gemini REST streamGenerateContent');
                        }
                        textLeakGuard = buildTextLeakGuard();
                        return await consumeGeminiRestStreamResponse(res, {
                            signal: attemptSignal,
                            onStreamDelta,
                            onTextDelta,
                            textLeakGuard,
                            label: 'Gemini REST streamGenerateContent',
                        });
                    },
                    {
                        signal: totalSignal,
                        onRetry: ({ attempt, lastErr }) => {
                            try { opts.onStageChange?.('requesting'); } catch {}
                            process.stderr.write(`[gemini-rest] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}\n`);
                        },
                    },
                );
            } catch (err) {
                if (!internal.skipExplicitCache
                    && err?.unsafeToRetry !== true
                    && isGeminiCachedContentError(err, cachedContent)) {
                    _invalidateGeminiCacheName(cachedContent);
                    if (opts.providerState?.gemini?.cacheName === cachedContent) {
                        const { gemini: _dropGemini, ...rest } = opts.providerState;
                        opts.providerState = rest;
                    }
                    return await this._doSend(messages, model, tools, opts, { skipExplicitCache: true });
                }
                throw err;
            } finally {
                restPassthrough.cleanup();
            }
        } else {
            const genModel = this.genAI.getGenerativeModel({
                model: useModel,
                systemInstruction,
                tools: geminiTools,
                ...(toolConfig ? { toolConfig } : {}),
            });
            // Option A (mirror anthropic-oauth): pure pass-through of the external
            // signal, no absolute streaming total cap. See the REST branch above.
            const sdkPassthrough = createPassthroughSignal(signal);
            const totalSignal = sdkPassthrough.signal;
            try {
                response = await withRetry(
                    async ({ signal: attemptSignal }) => {
                        try { opts.onStageChange?.('requesting'); } catch {}
                        // Mirror the REST branch's signal lifetime: the request
                        // controller stays linked to the parent (attemptSignal)
                        // for the FULL stream — connect AND body — so a parent /
                        // client / gateway abort after first byte still cancels
                        // the underlying SDK request (the SSE idle watchdog is off
                        // by default). The first-byte timer only bounds the
                        // connect phase and is cleared once the stream starts, so
                        // it can never kill a live, still-producing stream.
                        const reqController = new AbortController();
                        let parentAbortListener = null;
                        let firstByteTimer = null;
                        const detachParent = () => {
                            if (parentAbortListener && attemptSignal) {
                                try { attemptSignal.removeEventListener('abort', parentAbortListener); } catch {}
                                parentAbortListener = null;
                            }
                        };
                        const clearConnectTimer = () => {
                            if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
                        };
                        if (attemptSignal) {
                            if (attemptSignal.aborted) {
                                try { reqController.abort(attemptSignal.reason); } catch {}
                            } else {
                                parentAbortListener = () => { try { reqController.abort(attemptSignal.reason); } catch {} };
                                attemptSignal.addEventListener('abort', parentAbortListener, { once: true });
                            }
                        }
                        firstByteTimer = setTimeout(() => {
                            try { reqController.abort(geminiTimeoutError('Gemini SDK first byte', GEMINI_FIRST_BYTE_TIMEOUT_MS)); } catch {}
                        }, GEMINI_FIRST_BYTE_TIMEOUT_MS);
                        if (firstByteTimer.unref) firstByteTimer.unref();
                        try {
                            let streamResult;
                            try {
                                streamResult = await genModel.generateContentStream(
                                    { contents },
                                    { signal: reqController.signal },
                                );
                            } catch (err) {
                                if (reqController.signal.aborted) {
                                    throw reqController.signal.reason instanceof Error
                                        ? reqController.signal.reason
                                        : err;
                                }
                                throw err;
                            }
                            // First byte / headers received: drop the connect-phase
                            // timer but KEEP the parent link attached so a later
                            // abort during streaming still reaches the request.
                            clearConnectTimer();
                            textLeakGuard = buildTextLeakGuard();
                            return await consumeGeminiSdkStream(streamResult, {
                                signal: attemptSignal,
                                onStreamDelta,
                                onTextDelta,
                                textLeakGuard,
                                label: 'Gemini SDK streamGenerateContent',
                                cancelGeneration: (reason) => {
                                    if (!reqController.signal.aborted) reqController.abort(reason);
                                },
                            });
                        } finally {
                            clearConnectTimer();
                            detachParent();
                        }
                    },
                    {
                        signal: totalSignal,
                        onRetry: ({ attempt, lastErr }) => {
                            try { opts.onStageChange?.('requesting'); } catch {}
                            process.stderr.write(`[gemini] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}\n`);
                        },
                    },
                );
            } finally {
                sdkPassthrough.cleanup();
            }
        }
        writeGeminiCacheTrace({
            opts,
            model: useModel,
            systemInstruction,
            tools,
            contents,
            usageMetadata: response.usageMetadata,
            cachedContent,
        });
        const candidate = response.candidates?.[0] || null;
        const responseParts = candidate?.content?.parts ?? [];
        const textParts = responseParts.filter(p => p?.thought !== true && 'text' in p);
        const rawContent = textParts.map(p => 'text' in p ? p.text : '').join('');
        const providerMetadata = parseGeminiTextPartMetadata(responseParts);
        const content = textLeakGuard?.enabled
            ? textLeakGuard.scrubAssistantText(rawContent)
            : rawContent;
        const leakedToolCalls = textLeakGuard?.getLeakedToolCalls() ?? [];
        let nativeToolCalls = parseToolCalls(candidate?.content?.parts ?? []);
        if (textLeakGuard?.enabled) {
            nativeToolCalls = textLeakGuard.filterNativeToolCalls(nativeToolCalls);
        }
        let toolCalls = nativeToolCalls;
        if (leakedToolCalls.length) {
            toolCalls = toolCalls?.length ? [...toolCalls, ...leakedToolCalls] : leakedToolCalls;
        }
        const citations = collectGeminiGroundingSources(candidate);
        emitGeminiToolCalls(nativeToolCalls, onToolCall);
        // Inspect candidate.finishReason — Gemini reports terminal status here.
        // Only STOP (and the legacy "FINISH_REASON_STOP") plus tool/function-
        // call paths represent a fully delivered turn. MAX_TOKENS / SAFETY /
        // RECITATION / OTHER all mean the candidate was cut off before the
        // model finished, and surfacing the partial text as final would
        // silently accept a truncated answer. Convert those into a typed
        // provider-incomplete error so the loop can decide whether to retry,
        // nudge, or surface to the user. Missing finishReason (still
        // streaming / unknown) is left alone — existing success paths for
        // genuinely complete responses keep working.
        const promptBlockReason = response.promptFeedback?.blockReason || null;
        const finishReason = candidate?.finishReason || (promptBlockReason ? `PROMPT_${promptBlockReason}` : null);
        const normalizedFinishReason = String(finishReason || '').replace(/^FINISH_REASON_/, '');
        // STOP is the only successful terminal reason. Treat newly-added
        // safety/image/tool/malformed reasons as incomplete by default instead
        // of silently accepting partial or empty output.
        if (finishReason && normalizedFinishReason !== 'STOP') {
            const err = Object.assign(
                new Error(`Gemini response incomplete: finishReason=${finishReason}`),
                {
                    name: 'ProviderIncompleteError',
                    code: 'PROVIDER_INCOMPLETE',
                    providerIncomplete: true,
                    finishReason,
                    partialContent: content,
                    partialToolCalls: toolCalls,
                    providerMetadata,
                    model: useModel,
                    rawUsage: response.usageMetadata || null,
                },
            );
            throw err;
        }
        const um = response.usageMetadata || null;
        // Hoist cachedTokens so the returned usage block can reuse the
        // exact value the trace already recorded (including the
        // cachedFallback when cachedContentTokenCount / total_cached_tokens
        // under-reports).
        let resolvedUsage = null;
        if (um) {
            const {
                inputTokens,
                reportedCachedTokens,
                cachedFallbackTokens,
                cachedTokens,
                cacheTokenSource,
            } = _resolveGeminiCacheUsage({
                usageMetadata: um,
                cachedContent,
                providerState: opts.providerState,
            });
            const outputTokens = (um.candidatesTokenCount || um.candidates_token_count || 0)
                + (um.thoughtsTokenCount || um.thoughts_token_count || 0);
            resolvedUsage = {
                inputTokens,
                outputTokens,
                cachedTokens,
                // Gemini promptTokenCount is total (cachedContentTokenCount is
                // a subset). Alias the resolver's normalized total directly.
                promptTokens: inputTokens,
            };
            if (cachedContent && inputTokens > 0 && cachedTokens <= 0) {
                try {
                    appendAgentTrace({
                        sessionId: opts.sessionId || opts.session?.id || null,
                        iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                        kind: 'gemini_cache_anomaly',
                        payload: {
                            reason: 'cached_content_attached_but_zero_cached_tokens',
                            inputTokens,
                            reportedCachedTokens,
                            cachedFallbackTokens,
                            cacheTokenSource,
                            cacheName: opts.providerState?.gemini?.cacheName || null,
                            cachePrefixContentCount: opts.providerState?.gemini?.cachePrefixContentCount ?? null,
                        },
                    });
                } catch {}
            }
            traceAgentUsage({
                sessionId: opts.sessionId || opts.session?.id || null,
                iteration: Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null,
                inputTokens: resolvedUsage.inputTokens,
                outputTokens: resolvedUsage.outputTokens,
                cachedTokens: resolvedUsage.cachedTokens,
                cacheWriteTokens: 0,
                promptTokens: resolvedUsage.promptTokens,
                model: useModel,
                modelDisplay: useModel,
                rawUsage: um,
                provider: 'gemini',
            });
        }
        return {
            content,
            model: useModel,
            toolCalls,
            citations: citations.length ? citations : undefined,
            providerMetadata,
            providerState: opts.providerState,
            // Use the same normalized usage object traceAgentUsage recorded,
            // including snake_case SDK aliases and cache-create fallback.
            usage: resolvedUsage || undefined,
        };
    }

    async listModels() {
        const cached = this._modelCache.loadSync();
        if (cached) return cached;
        // Dynamic lookup via Gemini v1beta /models. Requires API key.
        const apiKey = this.config.apiKey || process.env.GEMINI_API_KEY;
        if (!apiKey) return MODELS; // no key — return minimal static list
        try {
            return await this._fetchAndCacheModels(apiKey);
        } catch (err) {
            process.stderr.write(`[gemini] listModels fetch failed (${err.message})\n`);
            return MODELS;
        }
    }

    // Shared fetch+normalize+enrich+write used by both listModels() (after the
    // TTL check) and _refreshModelCache() (bypassing it). Throws on failure so
    // each caller applies its own fallback/logging.
    async _fetchAndCacheModels(apiKey) {
        return fetchAndCacheGeminiModels({
            apiKey,
            fetchFn: this._fetch,
            modelCache: this._modelCache,
            catalogForceRefresh: this.config.catalogForceRefresh,
        });
    }

    // Force a catalog refresh (ignores the 24h disk TTL). De-duped via
    // _modelRefreshInFlight so concurrent callers share one HTTP round-trip.
    // Fire-and-forget context: failures are caught/logged, returning null.
    async _refreshModelCache() {
        if (_modelRefreshInFlight) return _modelRefreshInFlight;
        _modelRefreshInFlight = (async () => {
            try {
                const apiKey = this.config.apiKey || process.env.GEMINI_API_KEY;
                if (!apiKey) return null; // no key — nothing to refresh
                const enriched = await this._fetchAndCacheModels(apiKey);
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[gemini] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[gemini] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _modelRefreshInFlight = null;
            }
        })();
        return _modelRefreshInFlight;
    }

    async isAvailable() {
        const controller = new AbortController();
        const timeout = setTimeout(() => {
            controller.abort(providerTimeoutError('Gemini availability probe', GEMINI_AVAILABILITY_TIMEOUT_MS));
        }, GEMINI_AVAILABILITY_TIMEOUT_MS);
        try {
            const model = this.genAI.getGenerativeModel({ model: DEFAULT_MODEL });
            const generation = Promise.resolve(model.generateContent('hi', { signal: controller.signal }));
            generation.catch(() => {});
            await Promise.race([
                generation,
                new Promise((_, reject) => {
                    if (controller.signal.aborted) {
                        reject(controller.signal.reason);
                        return;
                    }
                    controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
                }),
            ]);
            return true;
        }
        catch {
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }
}
