/**
 * Grok CLI OAuth provider ("Grok Build").
 *
 * Authenticates against xAI's shared OAuth client via PKCE (discovery at
 * https://auth.x.ai/.well-known/openid-configuration). Credentials come from
 * Mixdog's own token store (grok-oauth.json).
 *
 * Inference + catalog merge two sources, routed per model:
 *   - api.x.ai/v1 (default): grok-4.x chat models and the web_search backend.
 *   - cli-chat-proxy.grok.com/v1 (the grok-build proxy): proxy-only models
 *     grok-build and grok-composer-2.5-fast, which api.x.ai does not publish.
 *     The proxy version-gates /responses (HTTP 426); we clear it with the Grok
 *     CLI client headers (proxyHeaders, real local version from version.json).
 *
 * Inference is delegated to an inner OpenAICompatProvider('xai') — the only
 * preset wired for the Responses API — with the base URL + (for proxy models)
 * the CLI headers injected via config.extraHeaders, bearer swapped for the
 * OAuth access token. The model catalog is the union of both endpoints.
 */
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync, withFileLock } from '../../../shared/atomic-file.mjs';
import { enrichModels, getModelMetadataSync } from './model-catalog.mjs';
import { sanitizeModelList } from './model-list-sanitize.mjs';
import { makeModelCache } from './model-cache.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { createTimeoutSignal } from '../stall-policy.mjs';
import { populateHttpStatusFromMessage } from './retry-classifier.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';

// --- Constants ---
// xAI's shared OAuth client. The consent screen renders this as "Grok Build".
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ISSUER = 'https://auth.x.ai';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 56121;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
// Primary inference + search target. The OAuth token's `api:access` scope works
// against the STANDARD xAI API (GET /models 200, POST /responses 200, web_search
// 200 with citations). grok-4.x and web search live here. Proxy-only models
// (grok-build, grok-composer-2.5-fast) are NOT published on api.x.ai — they route
// to PROXY_BASE_URL below, which is version-gated and needs the Grok CLI client
// headers (see proxyHeaders).
const INFERENCE_BASE_URL = 'https://api.x.ai/v1';
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

// --- grok-build CLI proxy (Composer 2.5, grok-build) ---
// These models live ONLY on the grok-build proxy, not api.x.ai. /models is
// readable with the bare OAuth bearer; /responses is version-gated (HTTP 426)
// and requires the Grok CLI's client headers. We route only proxy-only models
// here and keep grok-4.x + search on api.x.ai.
const PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const GROK_CLIENT_IDENTIFIER = 'grok-shell';
const GROK_CLI_VERSION_FALLBACK = '0.2.16';

// Route to the proxy: any grok-composer* model, plus the bare `grok-build`
// coding agent. NOT grok-build-0.1 — that is a real api.x.ai model and must stay
// on api.x.ai, so we match grok-build exactly rather than by prefix.
const PROXY_EXACT_MODELS = new Set(['grok-build']);
function isProxyOnlyModel(model) {
    const m = String(model || '');
    return /^grok-composer/i.test(m) || PROXY_EXACT_MODELS.has(m);
}

// Use a Mixdog-controlled client version for the proxy version gate.
let _grokCliVersionCache = null;
function grokCliVersion() {
    if (_grokCliVersionCache) return _grokCliVersionCache;
    _grokCliVersionCache = String(process.env.MIXDOG_GROK_CLIENT_VERSION || '').trim() || GROK_CLI_VERSION_FALLBACK;
    return _grokCliVersionCache;
}

// Headers the Grok CLI sends to clear the proxy version gate — extracted from
// the grok binary: x-grok-client-version (the actual 426 gate),
// x-grok-client-identifier, and a matching User-Agent.
function proxyHeaders() {
    const v = grokCliVersion();
    return {
        'x-grok-client-version': v,
        'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
        'User-Agent': `xai-grok-build/${v}`,
    };
}

function resolveGrokOAuthResponsesTransport(config) {
    // An explicit Grok-specific transport setting is the escape hatch and wins
    // for EVERY Grok model, api.x.ai and proxy-only alike — e.g. pin 'http' to
    // force proxy-only models back onto cli-chat-proxy.grok.com over HTTP.
    const raw = config?.responsesTransport
        ?? config?.transport
        ?? process.env.MIXDOG_GROK_OAUTH_RESPONSES_TRANSPORT
        ?? process.env.MIXDOG_GROK_OAUTH_TRANSPORT
        ?? '';
    const mode = String(raw).trim().toLowerCase();
    if (mode) return mode;
    // No Grok-specific override: leave the field unset so ALL api.x.ai-capable
    // Grok models honor the shared MIXDOG_OAI_TRANSPORT switch. Proxy-only
    // grok-build is included: the shared xAI WebSocket connector targets the
    // fixed wss://api.x.ai/v1/responses endpoint (not the proxy baseURL), and a
    // live probe confirmed grok-build serves there with the OAuth token. No
    // implicit HTTP pin — the proxy baseURL is only used when HTTP is selected.
    return undefined;
}

// Retired model aliases xAI no longer exposes by their old ids. The live
// catalog surfaces the coding model as grok-build-0.1; map the legacy ids to
// it so a stale config selection doesn't hit a model-not-found. Exact table,
// not a heuristic. Mirrors openclaw extensions/xai/model-definitions.ts.
const RETIRED_MODEL_ALIASES = Object.freeze({
    'grok-code-fast-1': 'grok-build-0.1',
    'grok-code-fast': 'grok-build-0.1',
    'grok-code-fast-1-0825': 'grok-build-0.1',
});
export function normalizeGrokModelId(id) {
    return (id && RETIRED_MODEL_ALIASES[id]) || id;
}
const MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
// Bump when the on-disk cache shape changes so stale-shape entries are
// discarded instead of misread.
const GROK_MODEL_CACHE_SCHEMA_VERSION = 1;
const DISCOVERY_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

// SSRF guard for any endpoint pulled from the discovery document or saved
// tokens. xAI OAuth endpoints must be https on x.ai / *.x.ai — reject
// anything else outright so a hostile discovery response can't redirect the
// token / refresh request. Mirrors openclaw's isTrustedXaiOAuthEndpoint.
function assertTrustedXaiEndpoint(endpoint, label) {
    let url;
    try {
        url = new URL(String(endpoint));
    } catch {
        throw new Error(`[grok-oauth] invalid ${label}: ${endpoint}`);
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (host !== 'x.ai' && !host.endsWith('.x.ai'))) {
        throw new Error(`[grok-oauth] untrusted ${label}: ${endpoint}`);
    }
    return url.toString();
}

let _discoveryCache = null;
async function fetchDiscovery() {
    if (_discoveryCache) return _discoveryCache;
    const timeout = createTimeoutSignal(null, DISCOVERY_TIMEOUT_MS, 'grok-oauth discovery');
    try {
        const res = await fetch(DISCOVERY_URL, {
            headers: { Accept: 'application/json' },
            // No redirect-following: the discovery doc is a fixed well-known URL.
            // A 3xx could bounce the request to an untrusted host before the
            // endpoint trust checks below ever run.
            redirect: 'error',
            signal: timeout.signal,
            dispatcher: getLlmDispatcher(),
        });
        if (!res.ok) throw new Error(`discovery ${res.status}`);
        const j = await res.json();
        const discovery = {
            authorization_endpoint: assertTrustedXaiEndpoint(j?.authorization_endpoint, 'authorization endpoint'),
            token_endpoint: assertTrustedXaiEndpoint(j?.token_endpoint, 'token endpoint'),
        };
        _discoveryCache = discovery;
        return discovery;
    } finally {
        timeout.cleanup();
    }
}

// --- Token store ---
function getOwnTokenPath() {
    const dir = getPluginData();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'grok-oauth.json');
}

function getRefreshLockPath() {
    return `${getOwnTokenPath()}.refresh.lock`;
}

// expires_at may arrive as a unix number or an ISO-8601 string. Normalize both
// to epoch milliseconds; 0 means unknown.
function _normalizeExpiresAt(value) {
    if (typeof value === 'string') {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : 0;
    }
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
}

// Fallback expiry from the access_token's JWT `exp` claim (epoch ms) when the
// store carries no explicit expires_at — without it expires_at stays 0, which
// ensureAuth reads as "never expires", disabling proactive refresh. Returns 0
// for opaque (non-JWT) tokens. JWT `exp` is epoch SECONDS (RFC 7519).
function _expiryFromAccessToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return 0;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        const exp = Number(payload?.exp);
        return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
    } catch { return 0; }
}

function _identityFromAccessToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return {};
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        const userId = payload?.user_id
            || payload?.userId
            || payload?.principal_id
            || payload?.principalId
            || payload?.sub
            || '';
        return userId ? { user_id: String(userId) } : {};
    } catch { return {}; }
}

function _mtimeMs(path) {
    try { return statSync(path).mtimeMs; } catch { return 0; }
}

// mixdog's own login store (grok-oauth.json). Single writer, accurate
// numeric expires_at from refresh.
function _loadOwnTokens() {
    const path = getOwnTokenPath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw?.access_token || !raw?.refresh_token) return null;
        return {
            access_token: raw.access_token,
            refresh_token: raw.refresh_token,
            expires_at: _normalizeExpiresAt(raw.expires_at ?? raw.expiresAt) || _expiryFromAccessToken(raw.access_token),
            token_endpoint: raw.token_endpoint || null,
            user_id: raw.user_id || raw.userId || _identityFromAccessToken(raw.access_token).user_id || '',
            source: 'own',
            mtimeMs: _mtimeMs(path),
        };
    } catch { return null; }
}

// Mixdog-owned token store only.
function loadTokens() {
    return _loadOwnTokens();
}

function saveTokens(tokens) {
    writeJsonAtomicSync(getOwnTokenPath(), {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at || 0,
        token_endpoint: tokens.token_endpoint || null,
        user_id: tokens.user_id || tokens.userId || _identityFromAccessToken(tokens.access_token).user_id || undefined,
    }, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}

function _scrubTokens(text) {
    return String(text || '')
        .replace(/Bearer [A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
        .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"')
        .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[REDACTED]"')
        .replace(/"key"\s*:\s*"[^"]+"/g, '"key":"[REDACTED]"');
}

// Public predicate used by config.buildDefaultConfig — enabled when Mixdog's
// token store carries credentials. Single truth: same loader the runtime uses.
export function hasGrokOAuthCredentials() {
    try {
        const tokens = loadTokens();
        return !!(tokens?.access_token && tokens?.refresh_token);
    } catch { return false; }
}

export function describeGrokOAuthCredentials() {
    try {
        const tokens = loadTokens();
        if (!tokens?.access_token) {
            return { authenticated: false, status: 'Not Set', detail: 'Mixdog token store' };
        }
        const hasRefresh = Boolean(tokens.refresh_token);
        const expiresAt = _normalizeExpiresAt(tokens.expires_at);
        const expiring = expiresAt > 0 && expiresAt < Date.now() + TOKEN_REFRESH_SKEW_MS;
        const expired = expiresAt > 0 && expiresAt <= Date.now();
        const detail = tokens.source === 'own' ? 'Mixdog token store' : (tokens.source || 'oauth');
        if (!hasRefresh) {
            return {
                authenticated: expiresAt === 0 || !expired,
                status: expired ? 'Reauth Required' : 'Access Only',
                detail: `${detail}; no refresh token`,
                expiresAt,
            };
        }
        if (expired) return { authenticated: true, status: 'Refresh Required', detail, expiresAt };
        if (expiring) return { authenticated: true, status: 'Refresh Soon', detail, expiresAt };
        return { authenticated: true, status: 'Valid', detail, expiresAt };
    } catch (err) {
        return { authenticated: false, status: 'Error', detail: String(err?.message || err).slice(0, 200) };
    }
}

export function forgetGrokOAuthCredentials() {
    let removed = false;
    const ownPath = getOwnTokenPath();
    if (existsSync(ownPath)) {
        unlinkSync(ownPath);
        removed = true;
    }
    return { removed };
}

let _refreshInFlight = null;
async function _postRefresh(tokens) {
    const tokenEndpoint = tokens.token_endpoint
        ? assertTrustedXaiEndpoint(tokens.token_endpoint, 'token endpoint')
        : (await fetchDiscovery()).token_endpoint;
    const timeout = createTimeoutSignal(null, TOKEN_TIMEOUT_MS, 'grok-oauth refresh');
    try {
        const res = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: CLIENT_ID,
                refresh_token: tokens.refresh_token,
            }),
            // Never follow a redirect on a secret-bearing request: a trusted
            // token endpoint that 307/308-redirects would replay the
            // refresh_token to the redirect target. Fail loud instead.
            redirect: 'error',
            signal: timeout.signal,
            dispatcher: getLlmDispatcher(),
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
        if (!res.ok) {
            // 400/401 (or an explicit invalid_grant/revoked/reused body) means
            // this refresh_token was revoked or already consumed.
            const isInvalidGrant = res.status === 400 || res.status === 401
                || /invalid_grant|revoked|reused/i.test(text);
            throw Object.assign(
                new Error(`[grok-oauth] token refresh ${res.status}: ${_scrubTokens(text).slice(0, 200)}`),
                { isInvalidGrant },
            );
        }
        const accessToken = json?.access_token;
        if (!accessToken) throw new Error('[grok-oauth] token refresh returned no access token');
        const refreshed = {
            access_token: accessToken,
            // xAI rotates refresh tokens; reuse the prior one only when the
            // response omits it (RFC 6749 permits reuse).
            refresh_token: json?.refresh_token || tokens.refresh_token,
            expires_at: typeof json?.expires_in === 'number'
                ? Date.now() + json.expires_in * 1000
                : _normalizeExpiresAt(json?.expires_at),
            token_endpoint: tokenEndpoint,
            user_id: tokens.user_id || tokens.userId || _identityFromAccessToken(accessToken).user_id || '',
        };
        saveTokens(refreshed);
        return { ...refreshed, source: 'own', mtimeMs: _mtimeMs(getOwnTokenPath()) };
    } finally {
        timeout.cleanup();
    }
}

// Mixdog processes share one grok-oauth.json and xAI rotates refresh tokens
// single-use. Hold a cross-process lease across the re-read, exchange, and
// atomic save so only one process can spend a generation.
async function refreshTokens(tokens, { force = false } = {}) {
    if (!tokens?.refresh_token) {
        throw new Error('[grok-oauth] refresh token not available — open /providers in mixdog to sign in again');
    }

    return withFileLock(getRefreshLockPath(), async () => {
        const validAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
        const disk = _loadOwnTokens();
        // A waiter that entered with the prior generation adopts the winner's
        // persisted, valid token instead of rotating it again. xAI may rotate
        // only the refresh token while reissuing the same access token.
        const diskGenerationChanged = disk?.access_token
            && (disk.access_token !== tokens.access_token
                || disk.refresh_token !== tokens.refresh_token);
        if (diskGenerationChanged
            && (!disk.expires_at || disk.expires_at >= validAfter)) {
            return disk;
        }

        const current = disk || tokens;
        try {
            return await _postRefresh(current);
        } catch (err) {
            if (err?.isInvalidGrant) {
                // A writer that does not participate in this lease may still
                // have won the rotation while the request was in flight.
                // Adopt its valid generation; only exchange it when it cannot
                // satisfy this caller.
                const rotated = _loadOwnTokens();
                if (rotated?.refresh_token && rotated.refresh_token !== current.refresh_token) {
                    if (rotated.access_token
                        && (!rotated.expires_at || rotated.expires_at >= validAfter)) {
                        return rotated;
                    }
                    return await _postRefresh(rotated);
                }
            }
            throw err;
        }
    }, {
        timeoutMs: 120_000,
        staleMs: 120_000,
        secret: true,
    });
}

// --- Model catalog cache (24h disk TTL) ---
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
export function resolveLatestGrokModel() {
    const cached = _modelCache.loadSync();
    if (!Array.isArray(cached)) return null;
    let best = null;
    for (const m of cached) {
        if (!m?.id || NON_CHAT_MODEL_RE.test(m.id) || isProxyOnlyModel(m.id) || !(Number(m.created) > 0)) continue;
        if (!best || Number(m.created) > Number(best.created)) best = m;
    }
    return best?.id || null;
}

export async function ensureLatestGrokModel(provider) {
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
        // Warm a kept-alive socket to the xAI inference API so the first
        // request skips the cold TLS handshake. Best-effort; never throws.
        preconnect(INFERENCE_BASE_URL);
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
                if (_refreshInFlight) {
                    const shared = await _refreshInFlight;
                    this.tokens = shared;
                    // A forced caller must not accept a shared non-force result
                    // that merely handed back its own prior token: start a fresh
                    // forced refresh instead (mirror openai-oauth).
                    if (forceRefresh && shared?.access_token === currentToken) {
                        if (!_refreshInFlight) {
                            _refreshInFlight = refreshTokens(this.tokens, { force: true })
                                .finally(() => { _refreshInFlight = null; });
                        }
                        this.tokens = await _refreshInFlight;
                    }
                } else {
                    _refreshInFlight = refreshTokens(this.tokens, { force: forceRefresh })
                        .finally(() => { _refreshInFlight = null; });
                    this.tokens = await _refreshInFlight;
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
    // that owns request shaping. name 'xai' selects the Responses API path the
    // Grok CLI proxy speaks; baseURL + bearer are overridden for grok-build.
    _ensureInner(token, model) {
        // Proxy-only models (grok-composer*, grok-build) live on the grok-build
        // CLI proxy: different baseURL + the Grok CLI client headers. Everything
        // else stays on api.x.ai. The cache key includes the route so an
        // interleaved sequence of api/proxy calls each get the right inner.
        const proxy = isProxyOnlyModel(model);
        const key = `${proxy ? 'proxy' : 'api'}:${token}`;
        if (this._inner && this._innerKey === key) return this._inner;
        this._inner = new OpenAICompatProvider('xai', {
            ...this.config,
            apiKey: token,
            baseURL: proxy ? PROXY_BASE_URL : INFERENCE_BASE_URL,
            // All Grok models — proxy-only grok-build included — inherit the
            // shared xAI transport switch (WS→api.x.ai by default). An explicit
            // Grok-specific http setting is the escape hatch back to the proxy.
            responsesTransport: resolveGrokOAuthResponsesTransport(this.config, proxy),
            // Proxy-only models additionally need the Grok CLI client headers to
            // clear the proxy version gate (HTTP 426 otherwise).
            ...(proxy ? { extraHeaders: proxyHeaders() } : {}),
        });
        this._innerKey = key;
        return this._inner;
    }

    async send(messages, model, tools, sendOpts) {
        // Re-warm a kept-alive socket before the turn (TTL-gated no-op while
        // hot) so a post-idle request skips the cold TLS handshake.
        preconnect(INFERENCE_BASE_URL);
        const useModel = normalizeGrokModelId(
            model || await ensureLatestGrokModel(this),
        );
        const tokens = await this.ensureAuth();
        const inner = this._ensureInner(tokens.access_token, useModel);
        try {
            // Call _doSend directly, bypassing OpenAICompatProvider.send()'s
            // own 401 handler — that one reloads a static apiKey from config,
            // which is wrong for OAuth. We own the refresh-and-retry below.
            // Caller's model passes through (or catalog-top default), with
            // retired aliases normalized. api.x.ai exposes the full grok-4.x
            // catalog to this token — no single-model lock.
            return await inner._doSend(messages, useModel, tools, sendOpts);
        } catch (err) {
            // Refresh-and-retry only on 401 (stale/expired access token).
            // Resolve the status from the structured field (falling back to the
            // shared classifier that derives it from the error text) rather than
            // ad-hoc string matching. A 403 is an entitlement signal (the
            // account's tier lacks the model) — refreshing the same grant can't
            // fix it, so it must surface unretried.
            populateHttpStatusFromMessage(err);
            if (Number(err?.httpStatus || err?.status) === 401) {
                process.stderr.write('[grok-oauth] 401, force-refreshing token...\n');
                const fresh = await this.ensureAuth({ forceRefresh: true });
                const retryInner = this._ensureInner(fresh.access_token, useModel);
                return await retryInner._doSend(messages, useModel, tools, sendOpts);
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
function generatePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

async function exchangeAuthorizationCode({ discovery, pkce, code }) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new Error('[grok-oauth] authorization code is required');
    const tokenRes = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code: cleanCode,
            code_verifier: pkce.verifier,
            redirect_uri: REDIRECT_URI,
            // xAI re-validates the PKCE challenge at token exchange
            // (not just the verifier), so echo it back. Omitting
            // these makes the exchange fail. Matches the Grok CLI.
            code_challenge: pkce.challenge,
            code_challenge_method: 'S256',
        }),
        // Secret-bearing (authorization code + verifier): refuse
        // redirects so they can't be replayed to an untrusted host.
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '');
        throw new Error(`[grok-oauth] token exchange ${tokenRes.status}: ${_scrubTokens(text).slice(0, 500)}`);
    }
    const json = await tokenRes.json();
    if (!json.access_token || !json.refresh_token) {
        throw new Error('[grok-oauth] token exchange response missing access_token or refresh_token');
    }
    const tokens = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: typeof json.expires_in === 'number'
            ? Date.now() + json.expires_in * 1000
            : _normalizeExpiresAt(json.expires_at),
        token_endpoint: discovery.token_endpoint,
        user_id: _identityFromAccessToken(json.access_token).user_id || '',
    };
    saveTokens(tokens);
    return tokens;
}

function parseOAuthCodeInput(input) {
    const value = String(input || '').trim();
    if (!value) return { code: '', state: '' };
    try {
        const url = new URL(value);
        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || '';
        if (code || state) return { code, state };
    } catch { /* not a URL */ }
    if (value.includes('#')) {
        const [code, state] = value.split('#', 2);
        return { code: String(code || '').trim(), state: String(state || '').trim() };
    }
    if (value.includes('code=')) {
        const params = new URLSearchParams(value.startsWith('?') ? value.slice(1) : value);
        return { code: params.get('code') || '', state: params.get('state') || '' };
    }
    return { code: value, state: '' };
}

export async function beginOAuthLogin() {
    const discovery = await fetchDiscovery();
    const pkce = generatePKCE();
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', SCOPE);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('plan', 'generic');
    url.searchParams.set('referrer', 'mixdog');

    let server = null;
    let timeout = null;
    let finish = null;
    const waitForCallback = new Promise((resolve, reject) => {
        let settled = false;
        finish = (value, error = null) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            try { server?.close(); } catch { /* already closed */ }
            if (error) reject(error);
            else resolve(value);
        };
        server = createServer(async (req, res) => {
            const u = new URL(req.url || '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
            if (u.pathname !== CALLBACK_PATH) {
                res.writeHead(404);
                res.end();
                return;
            }
            const code = u.searchParams.get('code');
            if (!code || u.searchParams.get('state') !== state) {
                res.writeHead(400);
                res.end('Invalid');
                finish(null);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Grok login successful! You can close this tab.</h2></body></html>');
            try {
                const tokens = await exchangeAuthorizationCode({ discovery, pkce, code });
                finish(tokens);
            } catch (err) {
                finish(null, err instanceof Error ? err : new Error(String(err)));
            }
        });
        timeout = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
        server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
            process.stderr.write(`\n[grok-oauth] Open this URL to log in (consent shows as "Grok Build"):\n${url.toString()}\n\n`);
            try {
                const { openInBrowser } = await import('../../../shared/open-url.mjs');
                openInBrowser(url.toString());
            } catch (err) {
                process.stderr.write(`[grok-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
            }
        });
        server.on('error', (err) => finish(null, new Error(`[grok-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`)));
    });

    return {
        provider: 'grok-oauth',
        url: url.toString(),
        waitForCallback,
        completeCode: async (input) => {
            const parsed = parseOAuthCodeInput(input);
            if (parsed.state && parsed.state !== state) throw new Error('[grok-oauth] OAuth state mismatch');
            const tokens = await exchangeAuthorizationCode({ discovery, pkce, code: parsed.code });
            finish?.(tokens);
            return tokens;
        },
        cancel: () => {
            finish?.(null);
        },
    };
}

export async function loginOAuth() {
    const login = await beginOAuthLogin();
    return await login.waitForCallback;
}
