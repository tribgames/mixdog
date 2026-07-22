/**
 * Grok CLI OAuth provider ("Grok Build").
 *
 * Authenticates against xAI's shared OAuth client via PKCE (discovery at
 * https://auth.x.ai/.well-known/openid-configuration). Credentials come from
 * Mixdog's own token store (grok-oauth.json).
 *
 * Every OAuth inference request routes through cli-chat-proxy.grok.com/v1,
 * matching Grok Build's session-auth contract. Model discovery still merges
 * api.x.ai and proxy catalogs because each publishes a different subset.
 *
 * Inference is delegated to an inner OpenAICompatProvider('xai') — the only
 * preset wired for the Responses API — with the proxy URL + CLI headers
 * injected via config.extraHeaders, bearer swapped for the OAuth access token.
 */
import { createServer } from 'http';
import { randomBytes, randomUUID, createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync, withFileLock } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { enrichModels, getModelMetadataSync } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { makeModelCache } from './model-cache.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { createTimeoutSignal } from '../stall-policy.mjs';
import { populateHttpStatusFromMessage } from './retry-classifier.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { normalizeGrokToolSchemas } from './lib/grok-tool-schema.mjs';

// --- Constants ---
// xAI's shared OAuth client. The consent screen renders this as "Grok Build".
import { INFERENCE_BASE_URL, TOKEN_REFRESH_SKEW_MS, PROXY_BASE_URL, isProxyOnlyModel, proxyHeaders, resolveGrokOAuthResponsesTransport, normalizeGrokModelId, MODEL_CACHE_TTL_MS, GROK_MODEL_CACHE_SCHEMA_VERSION, getOwnTokenPath, _mtimeMs, _loadOwnTokens, loadTokens, _getRefreshInFlight, _setRefreshInFlight, refreshTokens } from './grok-oauth-tokens.mjs';
export { hasGrokOAuthCredentials, describeGrokOAuthCredentials, forgetGrokOAuthCredentials, normalizeGrokModelId } from './grok-oauth-tokens.mjs';
export { beginOAuthLogin, loginOAuth } from './grok-oauth-login.mjs';

const _modelCache = makeModelCache({
    fileName: 'grok-oauth-models.json',
    ttlMs: MODEL_CACHE_TTL_MS,
    version: GROK_MODEL_CACHE_SCHEMA_VERSION,
});
const PROXY_MODEL_METADATA = {
    'grok-build': { display: 'Grok Build', contextWindow: 512000 },
    'grok-composer-2.5-fast': { display: 'Composer 2.5 Fast', contextWindow: 200000 },
};

function _grokModelSupportsEffort(id) {
    const text = String(id || '').toLowerCase();
    if (!text) return false;
    if (NON_CHAT_MODEL_RE.test(text)) return false;
    if (text.includes('non-reasoning')) return false;
    if (text === 'grok-build' || text.startsWith('grok-build-')) return false;
    if (text.startsWith('grok-composer')) return false;
    return text.includes('reasoning') || /^grok-\d/.test(text);
}

function _grokApiContextWindow(model) {
    const id = String(model?.id || model?.model || model || '').trim();
    const native = Number(model?.context_window ?? model?.context_length ?? model?.contextWindow ?? 0);
    if (Number.isFinite(native) && native > 0) return native;
    const fallback = Number(PROXY_MODEL_METADATA[id]?.contextWindow || 0);
    return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}

function _displayGrokModel(model) {
    const raw = String(model?.id || model?.model || model || '').trim();
    if (!raw) return raw;
    const displayName = String(model?.display || '').trim();
    if (displayName && displayName !== raw) return displayName;
    const apiName = String(model?.name || PROXY_MODEL_METADATA[raw]?.display || '').trim();
    if (apiName && apiName !== raw) return apiName;
    let text = raw
        .replace(/^grok-/i, 'Grok ')
        .replace(/-0?309\b/g, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (m) => m.toUpperCase())
        .replace(/\bNon Reasoning\b/g, 'Non Reasoning')
        .replace(/\bMulti Agent\b/g, 'Multi Agent');
    text = text.replace(/\s+/g, ' ').trim();
    return text || raw;
}

function _normalizeGrokFamily(id) {
    return _grokModelSupportsEffort(id) ? 'grok' : 'grok-static';
}

function _normalizeGrokModel(m) {
    const id = m?.id;
    if (!id) return null;
    const contextWindow = _grokApiContextWindow(m);
    return {
        id,
        name: id,
        display: _displayGrokModel(m),
        provider: 'grok-oauth',
        family: _normalizeGrokFamily(id),
        reasoningLevels: _grokModelSupportsEffort(id) ? ['none', 'low', 'medium', 'high'] : [],
        tier: 'version',
        latest: false,
        // API/proxy model catalogs provide context_length/context_window. Only
        // proxy-only models use the tiny static fallback above.
        contextWindow,
        created: typeof m?.created === 'number' ? m.created : null,
    };
}

function _sanitizeGrokModels(models) {
    if (!Array.isArray(models)) return models;
    let changed = false;
    const next = models.map((m) => {
        let out = m;
        const display = _displayGrokModel(m);
        const family = _normalizeGrokFamily(m?.id);
        const reasoningLevels = _grokModelSupportsEffort(m?.id) ? ['none', 'low', 'medium', 'high'] : [];
        if (display && display !== out?.display) {
            changed = true;
            out = { ...out, display, name: out?.name || out?.id };
        }
        if (family !== out?.family || JSON.stringify(reasoningLevels) !== JSON.stringify(out?.reasoningLevels || [])) {
            changed = true;
            out = { ...out, family, reasoningLevels };
        }
        const apiContextWindow = _grokApiContextWindow(out);
        if (Number.isFinite(apiContextWindow) && apiContextWindow > 0 && apiContextWindow !== out?.contextWindow) {
            changed = true;
            out = { ...out, contextWindow: apiContextWindow };
        }
        const trustedContext = Number(getModelMetadataSync(m?.id, 'grok-oauth')?.contextWindow);
        if (!(apiContextWindow > 0) && Number.isFinite(trustedContext) && trustedContext > 0 && trustedContext !== out?.contextWindow) {
            changed = true;
            return { ...out, contextWindow: trustedContext };
        }
        if (!(apiContextWindow > 0) && !(trustedContext > 0) && out?.contextWindow) {
            changed = true;
            return { ...out, contextWindow: 0 };
        }
        return out;
    });
    return changed ? next : models;
}

// Image/video generation ids — excluded from "latest chat model" resolution.
const NON_CHAT_MODEL_RE = /imagine|image|video/i;

// List-facing sanitizer: drop grok image/video generation ids (proxy-only
// chat models are kept), then apply the shared cross-provider sanitizer.
function _sanitizeGrokList(models) {
    const base = _sanitizeGrokModels(models);
    if (!Array.isArray(base)) return base;
    const chatOnly = base.filter((m) => {
        if (!m?.id) return false;
        if (NON_CHAT_MODEL_RE.test(m.id) && !isProxyOnlyModel(m.id)) return false;
        return true;
    });
    return sanitizeModelList(chatOnly, { provider: 'grok-oauth' });
}

function _markLatestGrok(models) {
    let best = null;
    for (const m of models) {
        if (!m?.id || NON_CHAT_MODEL_RE.test(m.id) || isProxyOnlyModel(m.id)) continue;
        if (!best || (Number(m.created) || 0) > (Number(best.created) || 0)) best = m;
    }
    if (best) best.latest = true;
}

// Newest chat model by RELEASE DATE (the catalog's `created`), read from the
// on-disk catalog cache. Deterministic — no version-string guessing (xAI's
// grok-4.20 actually predates grok-4.3 despite the higher-looking number).
// Returns null until the catalog is cached; use ensureLatestGrokModel when null.
function resolveLatestGrokModel() {
    const cached = _modelCache.loadSync();
    if (!Array.isArray(cached)) return null;
    let best = null;
    for (const m of cached) {
        if (!m?.id || NON_CHAT_MODEL_RE.test(m.id) || isProxyOnlyModel(m.id) || !(Number(m.created) > 0)) continue;
        if (!best || Number(m.created) > Number(best.created)) best = m;
    }
    return best?.id || null;
}

async function ensureLatestGrokModel(provider) {
    let m = resolveLatestGrokModel();
    if (m) return m;
    await provider._refreshModelCache();
    m = resolveLatestGrokModel();
    if (m) return m;
    throw new Error('[grok-oauth] model catalog unavailable after warmup — cannot resolve default model');
}

let _modelRefreshInFlight = null;

export class GrokOAuthProvider {
    // OpenAI-compatible usage: prompt_tokens includes cached. See registry.mjs.
    static inputExcludesCache = false;
    name = 'grok-oauth';
    config;
    tokens = null;
    _inner = null;
    _innerKey = null;
    // Grace window after a non-force refresh failure: keep serving the current
    // still-valid access_token instead of thrashing the shared refresh_token.
    _refreshFallbackUntil = 0;

    constructor(config) {
        this.config = config || {};
        this.tokens = loadTokens();
    }

    async ensureAuth({ forceRefresh = false } = {}) {
        if (!this.tokens) this.tokens = loadTokens();
        if (!this.tokens) {
            throw new Error('[grok-oauth] credentials not found — open /providers in mixdog to sign in first');
        }
        // Pick up Mixdog-owned token updates without touching external CLI
        // stores. The scan watermark guarantees the same unreadable write does
        // not re-fire forever.
        const ownM = _mtimeMs(getOwnTokenPath());
        if (ownM > (this._lastDiskScan || 0) && ownM > (this.tokens.mtimeMs || 0)) {
            const disk = _loadOwnTokens();
            if (disk?.access_token) this.tokens = disk;
            this._lastDiskScan = ownM;
        }
        if (!forceRefresh && this._refreshFallbackUntil > Date.now() && this.tokens?.access_token
            && (!this.tokens.expires_at || this.tokens.expires_at > Date.now())) {
            return this.tokens;
        }
        const expiring = this.tokens.expires_at
            && this.tokens.expires_at < Date.now() + TOKEN_REFRESH_SKEW_MS;
        if (forceRefresh || expiring) {
            const currentToken = this.tokens?.access_token || null;
            try {
                if (_getRefreshInFlight()) {
                    const shared = await _getRefreshInFlight();
                    this.tokens = shared;
                    // A forced caller must not accept a shared non-force result
                    // that merely handed back its own prior token: start a fresh
                    // forced refresh instead (mirror openai-oauth).
                    if (forceRefresh && shared?.access_token === currentToken) {
                        if (!_getRefreshInFlight()) {
                            _setRefreshInFlight(refreshTokens(this.tokens, { force: true })
                                .finally(() => { _setRefreshInFlight(null); }));
                        }
                        this.tokens = await _getRefreshInFlight();
                    }
                } else {
                    const inFlight = _setRefreshInFlight(refreshTokens(this.tokens, { force: forceRefresh })
                        .finally(() => { _setRefreshInFlight(null); }));
                    this.tokens = await inFlight;
                }
                this._refreshFallbackUntil = 0;
            } catch (err) {
                // Non-force failure while the current token is still valid: serve
                // it under a grace window rather than throwing (mirror openai-oauth).
                if (!forceRefresh && currentToken
                    && (!this.tokens?.expires_at || this.tokens.expires_at > Date.now())) {
                    this._refreshFallbackUntil = Date.now() + TOKEN_REFRESH_SKEW_MS;
                    process.stderr.write(`[grok-oauth] Refresh failed (${String(err?.message || err).slice(0, 120)}); using still-valid current token\n`);
                    return this.tokens;
                }
                throw err;
            }
        }
        return this.tokens;
    }

    // Build (or rebuild on token change) the inner OpenAI-compatible provider
    // that owns request shaping. Every OAuth model uses the Grok CLI proxy.
    _ensureInner(token, model, requestHeaders = proxyHeaders({ model })) {
        const key = `proxy:${token}:${JSON.stringify(requestHeaders)}`;
        if (this._inner && this._innerKey === key) return this._inner;
        this._inner = new OpenAICompatProvider('xai', {
            ...this.config,
            apiKey: token,
            baseURL: PROXY_BASE_URL,
            responsesTransport: resolveGrokOAuthResponsesTransport(),
            extraHeaders: requestHeaders,
        });
        this._innerKey = key;
        return this._inner;
    }

    async send(messages, model, tools, sendOpts) {
        // Re-warm a kept-alive socket before the turn (TTL-gated no-op while
        // hot) so a post-idle request skips the cold TLS handshake.
        if (this.config?.preconnect !== false) {
            const warm = typeof this.config?.preconnectFn === 'function'
                ? this.config.preconnectFn
                : preconnect;
            warm(PROXY_BASE_URL);
        }
        const useModel = normalizeGrokModelId(
            model || await ensureLatestGrokModel(this),
        );
        const tokens = await this.ensureAuth();
        const requestHeaders = proxyHeaders({
            model: useModel,
            sendOpts,
            userId: tokens.user_id,
        });
        const inner = this._ensureInner(tokens.access_token, useModel, requestHeaders);
        const grokTools = normalizeGrokToolSchemas(tools);
        try {
            // Call _doSend directly, bypassing OpenAICompatProvider.send()'s
            // own 401 handler — that one reloads a static apiKey from config,
            // which is wrong for OAuth. We own the refresh-and-retry below.
            // Caller's model passes through (or catalog-top default), with
            // retired aliases normalized. api.x.ai exposes the full grok-4.x
            // catalog to this token — no single-model lock.
            return await inner._doSend(messages, useModel, grokTools, sendOpts);
        } catch (err) {
            // Refresh-and-retry on a server-rejected OAuth session (401/403).
            // Resolve the status from the structured field (falling back to the
            // shared classifier that derives it from the error text) rather than
            // ad-hoc string matching.
            populateHttpStatusFromMessage(err);
            const rejectedStatus = Number(err?.httpStatus || err?.status);
            if (rejectedStatus === 401 || rejectedStatus === 403) {
                // A stream-level rejection after text/tool dispatch cannot be safely
                // replayed: the client has already observed output or may have
                // executed a side-effecting tool.
                if (err.liveTextEmitted === true || err.emittedToolCall === true || err.unsafeToRetry === true) {
                    throw err;
                }
                process.stderr.write(`[grok-oauth] ${rejectedStatus}, force-refreshing token...\n`);
                const fresh = await this.ensureAuth({ forceRefresh: true });
                const retryInner = this._ensureInner(fresh.access_token, useModel, requestHeaders);
                const retryOpts = err?.__warmup?.usage
                    ? { ...(sendOpts || {}), _carriedWarmup: err.__warmup }
                    : sendOpts;
                return await retryInner._doSend(messages, useModel, grokTools, retryOpts);
            }
            throw err;
        }
    }

    async _fetchModelItems() {
        const tokens = await this.ensureAuth();
        const timeout = createTimeoutSignal(null, 10_000, 'grok-oauth model list');
        try {
            const res = await fetch(`${INFERENCE_BASE_URL}/models`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${tokens.access_token}` },
                // Bearer-bearing request — refuse redirects so the access token
                // is never replayed to a redirect target.
                redirect: 'error',
                signal: timeout.signal,
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) throw new Error(`models ${res.status}`);
            const data = await res.json();
            if (!Array.isArray(data?.data)) {
                throw new Error('[grok-oauth] unexpected /models response shape (no data[])');
            }
            return data.data;
        } finally {
            timeout.cleanup();
        }
    }

    // The grok-build proxy catalog (grok-build, grok-composer-2.5-fast). /models
    // is readable with the bare bearer + the Grok CLI client headers. Best-effort:
    // a proxy hiccup must NOT break the api.x.ai catalog, so failures return [].
    async _fetchProxyModelItems() {
        let tokens;
        try { tokens = await this.ensureAuth(); } catch { return []; }
        const timeout = createTimeoutSignal(null, 10_000, 'grok-oauth proxy model list');
        try {
            const res = await fetch(`${PROXY_BASE_URL}/models`, {
                method: 'GET',
                headers: { Authorization: `Bearer ${tokens.access_token}`, ...proxyHeaders() },
                redirect: 'error',
                signal: timeout.signal,
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) return [];
            const data = await res.json();
            return Array.isArray(data?.data) ? data.data : [];
        } catch {
            return [];
        } finally {
            timeout.cleanup();
        }
    }

    // Merge api.x.ai ∪ grok-build proxy catalogs, deduped by id (api wins on
    // overlap). The proxy contributes grok-build and grok-composer-2.5-fast,
    // which api.x.ai does not publish. api.x.ai failures still propagate (the
    // primary catalog); proxy failures are swallowed best-effort above.
    async _fetchAllModelItems() {
        const [apiItems, proxyItems] = await Promise.all([
            this._fetchModelItems(),
            this._fetchProxyModelItems(),
        ]);
        const byId = new Map();
        for (const m of proxyItems) if (m?.id) byId.set(m.id, m);
        for (const m of apiItems) if (m?.id) byId.set(m.id, m);
        return [...byId.values()];
    }

    async listModels() {
        const cached = _modelCache.loadSync();
        if (cached) {
            const sanitized = _sanitizeGrokList(cached);
            if (sanitized !== cached) _modelCache.save(sanitized);
            return sanitized;
        }
        // No swallow-to-[] fallback. Catalog/auth failures propagate to the
        // caller (registry warmup + setup model listing), both of which already
        // wrap this in their own catch.
        const items = await this._fetchAllModelItems();
        const normalized = items.map(_normalizeGrokModel).filter(Boolean);
        _markLatestGrok(normalized);
        const enriched = _sanitizeGrokList(await enrichModels(normalized));
        _modelCache.save(enriched);
        return enriched;
    }

    async _refreshModelCache() {
        if (_modelRefreshInFlight) return _modelRefreshInFlight;
        _modelRefreshInFlight = (async () => {
            try {
                const items = await this._fetchAllModelItems();
                const normalized = items.map(_normalizeGrokModel).filter(Boolean);
                _markLatestGrok(normalized);
                const enriched = _sanitizeGrokList(await enrichModels(normalized));
                _modelCache.save(enriched);
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[grok-oauth] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[grok-oauth] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _modelRefreshInFlight = null;
            }
        })();
        return _modelRefreshInFlight;
    }

    async isAvailable() {
        return this.tokens !== null || loadTokens() !== null;
    }
}

// --- Login flow (PKCE, export for CLI / setup use) ---
