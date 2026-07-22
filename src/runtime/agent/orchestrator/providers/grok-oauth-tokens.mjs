// Grok OAuth discovery, token storage/refresh, and proxy identity, extracted from grok-oauth.mjs.
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

export const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const ISSUER = 'https://auth.x.ai';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
export const SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PORT = 56121;
export const CALLBACK_PATH = '/callback';
export const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
// Primary inference + search target. The OAuth token's `api:access` scope works
// against the STANDARD xAI API (GET /models 200, POST /responses 200, web_search
// 200 with citations). grok-4.x and web search live here. Proxy-only models
// (grok-build, grok-composer-2.5-fast) are NOT published on api.x.ai — they route
// to PROXY_BASE_URL below, which is version-gated and needs the Grok CLI client
// headers (see proxyHeaders).
export const INFERENCE_BASE_URL = 'https://api.x.ai/v1';
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

// --- grok-build CLI proxy (Composer 2.5, grok-build) ---
// These models live ONLY on the grok-build proxy, not api.x.ai. /models is
// readable with the bare OAuth bearer; /responses is version-gated (HTTP 426)
// and requires the Grok CLI's client headers. We route only proxy-only models
// here and keep grok-4.x + search on api.x.ai.
export const PROXY_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
const GROK_CLIENT_IDENTIFIER = 'grok-shell';
const GROK_CLI_VERSION_FALLBACK = '0.2.16';

// Route to the proxy: any grok-composer* model, plus the bare `grok-build`
// coding agent. NOT grok-build-0.1 — that is a real api.x.ai model and must stay
// on api.x.ai, so we match grok-build exactly rather than by prefix.
const PROXY_EXACT_MODELS = new Set(['grok-build']);
export function isProxyOnlyModel(model) {
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
export function proxyHeaders({ model, sendOpts, userId } = {}) {
    const v = grokCliVersion();
    const headers = {
        'x-grok-client-version': v,
        'x-grok-client-identifier': GROK_CLIENT_IDENTIFIER,
        'User-Agent': `xai-grok-build/${v}`,
    };
    const sessionId = String(sendOpts?.sessionId || sendOpts?.session?.id || '').trim();
    const requestId = String(sendOpts?.requestId || '').trim() || (sendOpts ? randomUUID() : '');
    const turnIndex = sendOpts?.iteration;
    // Mixdog has an authoritative session id but no distinct Grok conversation
    // id. Do not synthesize the latter from the former.
    if (sessionId) headers['x-grok-session-id'] = sessionId;
    if (requestId) headers['x-grok-req-id'] = requestId;
    if (model) headers['x-grok-model-override'] = String(model);
    if (turnIndex != null && Number.isFinite(Number(turnIndex))) {
        headers['x-grok-turn-idx'] = String(turnIndex);
    }
    if (userId) headers['x-grok-user-id'] = String(userId);
    return headers;
}

export function resolveGrokOAuthResponsesTransport() {
    // The OAuth bearer is session auth and must never escape to api.x.ai.
    // Mixdog's xAI WebSocket connector has a fixed api.x.ai endpoint, so OAuth
    // inference is pinned to the proxy's reference HTTP/SSE transport.
    return 'http';
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
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
// Bump when the on-disk cache shape changes so stale-shape entries are
// discarded instead of misread.
export const GROK_MODEL_CACHE_SCHEMA_VERSION = 1;
const DISCOVERY_TIMEOUT_MS = 15_000;
export const TOKEN_TIMEOUT_MS = 30_000;
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

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
export async function fetchDiscovery() {
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
export function getOwnTokenPath() {
    const bound = boundProviderAuthPath('grok-oauth');
    if (bound) return resolve(bound);
    const explicit = process.env.GROK_OAUTH_CREDENTIALS_PATH;
    if (explicit) return resolve(explicit);
    const dir = getPluginData();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'grok-oauth.json');
}

export function getRefreshLockPath() {
    return `${getOwnTokenPath()}.refresh.lock`;
}

// expires_at may arrive as a unix number or an ISO-8601 string. Normalize both
// to epoch milliseconds; 0 means unknown.
export function _normalizeExpiresAt(value) {
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
export function _expiryFromAccessToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return 0;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        const exp = Number(payload?.exp);
        return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
    } catch { return 0; }
}

export function _identityFromAccessToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return {};
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        const principalId = payload?.principal_id || payload?.principalId || '';
        const principalType = payload?.principal_type || payload?.principalType || '';
        const userId = payload?.user_id
            || payload?.userId
            || principalId
            || payload?.sub
            || '';
        return {
            ...(userId ? { user_id: String(userId) } : {}),
            ...(principalType ? { principal_type: String(principalType) } : {}),
            ...(principalId ? { principal_id: String(principalId) } : {}),
        };
    } catch { return {}; }
}

export function _mtimeMs(path) {
    try { return statSync(path).mtimeMs; } catch { return 0; }
}

// mixdog's own login store (grok-oauth.json). Single writer, accurate
// numeric expires_at from refresh.
export function _loadOwnTokens() {
    const path = getOwnTokenPath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw?.access_token || !raw?.refresh_token) return null;
        const identity = _identityFromAccessToken(raw.access_token);
        return {
            access_token: raw.access_token,
            refresh_token: raw.refresh_token,
            expires_at: _normalizeExpiresAt(raw.expires_at ?? raw.expiresAt) || _expiryFromAccessToken(raw.access_token),
            token_endpoint: raw.token_endpoint || null,
            user_id: raw.user_id || raw.userId || identity.user_id || '',
            principal_type: raw.principal_type || raw.principalType || identity.principal_type || '',
            principal_id: raw.principal_id || raw.principalId || identity.principal_id || '',
            source: 'own',
            mtimeMs: _mtimeMs(path),
        };
    } catch { return null; }
}

// Mixdog-owned token store only.
export function loadTokens() {
    return _loadOwnTokens();
}

export function saveTokens(tokens) {
    const identity = _identityFromAccessToken(tokens.access_token);
    writeJsonAtomicSync(getOwnTokenPath(), {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at || 0,
        token_endpoint: tokens.token_endpoint || null,
        user_id: tokens.user_id || tokens.userId || identity.user_id || undefined,
        principal_type: tokens.principal_type || tokens.principalType || identity.principal_type || undefined,
        principal_id: tokens.principal_id || tokens.principalId || identity.principal_id || undefined,
    }, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}

export function _scrubTokens(text) {
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

export let _refreshInFlight = null;
export function _getRefreshInFlight() { return _refreshInFlight; }
export function _setRefreshInFlight(promise) { _refreshInFlight = promise; return promise; }
async function _postRefresh(tokens) {
    const tokenEndpoint = tokens.token_endpoint
        ? assertTrustedXaiEndpoint(tokens.token_endpoint, 'token endpoint')
        : (await fetchDiscovery()).token_endpoint;
    const timeout = createTimeoutSignal(null, TOKEN_TIMEOUT_MS, 'grok-oauth refresh');
    try {
        const body = new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            refresh_token: tokens.refresh_token,
        });
        if (tokens.principal_type) body.set('principal_type', tokens.principal_type);
        if (tokens.principal_id) body.set('principal_id', tokens.principal_id);
        const res = await fetch(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
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
            const oauthError = String(json?.error || '').toLowerCase();
            const isInvalidGrant = oauthError === 'invalid_grant';
            const isTerminalRefresh = isInvalidGrant || oauthError === 'invalid_client';
            throw Object.assign(
                new Error(`[grok-oauth] token refresh ${res.status}: ${_scrubTokens(text).slice(0, 200)}`),
                { isInvalidGrant, isTerminalRefresh, oauthError: oauthError || null },
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
            principal_type: json?.principal_type || tokens.principal_type || tokens.principalType || '',
            principal_id: json?.principal_id || tokens.principal_id || tokens.principalId || '',
        };
        saveTokens(refreshed);
        return { ...refreshed, source: 'own', mtimeMs: _mtimeMs(getOwnTokenPath()) };
    } finally {
        timeout.cleanup();
    }
}

async function _postRefreshWithRetry(tokens) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await _postRefresh(tokens);
        } catch (err) {
            if (err?.isTerminalRefresh || attempt === 2) throw err;
            const baseMs = Math.min(2_000, 200 * (2 ** attempt));
            const delayMs = Math.round(baseMs + Math.random() * baseMs);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    throw new Error('[grok-oauth] unreachable refresh retry state');
}

// Mixdog processes share one grok-oauth.json and xAI rotates refresh tokens
// single-use. Hold a cross-process lease across the re-read, exchange, and
// atomic save so only one process can spend a generation.
export async function refreshTokens(tokens, { force = false } = {}) {
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
            return await _postRefreshWithRetry(current);
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
                    return await _postRefreshWithRetry(rotated);
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
