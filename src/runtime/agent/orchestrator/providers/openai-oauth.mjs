/**
 * OpenAI ChatGPT OAuth (Codex) provider.
 *
 * Dispatches over the WebSocket upgrade of chatgpt.com/backend-api/codex/
 * responses (responses_websockets=2026-02-06 beta). Authenticates via PKCE
 * OAuth or reuses ~/.codex/auth.json. Streaming/framing lives in
 * openai-oauth-ws.mjs; this file owns auth, model catalog, request-body
 * shape, and HTTP/SSE fallback when WebSocket transport is unhealthy.
 */
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getPluginData } from '../config.mjs';
import { enrichModels } from './model-catalog.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { makeModelCache } from './model-cache.mjs';

import { sendViaWebSocket } from './openai-oauth-ws.mjs';
import {
    buildStableProviderPromptCacheKey,
    resolveProviderPromptCacheLane,
    resolveProviderCacheKey,
} from '../smart-bridge/cache-strategy.mjs';
import {
    appendBridgeTrace,
    traceBridgeFetch,
    traceBridgeSse,
    traceBridgeUsage,
} from '../bridge-trace.mjs';
import {
    PROVIDER_GENERATE_TOTAL_TIMEOUT_MS,
    PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
    createTimeoutSignal,
} from '../stall-policy.mjs';
import { populateHttpStatusFromMessage } from './retry-classifier.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
// --- Constants ---
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_ORIGINATOR = 'codex_cli_rs';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OPENAI_CODEX_REMOTE_COMPACT_FALLBACK = 'openai-codex';
const OPENAI_CODEX_REMOTE_COMPACT_VERSION = 1;
const REMOTE_COMPACT_RETAINED_TOKEN_BUDGET = 64_000;
// Version string baked into the models endpoint query — Codex rejects the
// request without it. Keep close to the latest published Codex CLI because
// older versions trigger a visibility-filtered catalog (e.g. only rollout
// models). Bump when the real CLI bumps.
// Codex backend gates new model exposures (e.g. gpt-5.5 only on >= 0.130.0)
// on the client_version header. Resolve dynamically from npm so newly-shipped
// models surface within a day instead of waiting on a hardcoded bump here.
// Cached 24h in-process; npm failure falls back to the floor below.
const CODEX_CLIENT_VERSION_FLOOR = '0.130.0';
const CODEX_VERSION_CACHE_TTL_MS = 24 * 60 * 60_000;
let _codexVersionCache = { value: null, fetchedAt: 0 };

async function _resolveCodexClientVersion() {
    const now = Date.now();
    if (_codexVersionCache.value && now - _codexVersionCache.fetchedAt < CODEX_VERSION_CACHE_TTL_MS) {
        return _codexVersionCache.value;
    }
    try {
        const res = await fetch('https://registry.npmjs.org/@openai/codex/latest', {
            signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
            const j = await res.json();
            const v = String(j?.version || '').trim();
            if (/^\d+\.\d+\.\d+/.test(v)) {
                _codexVersionCache = { value: v, fetchedAt: now };
                return v;
            }
        }
    } catch { /* network down / npm rejects — use floor */ }
    _codexVersionCache = { value: CODEX_CLIENT_VERSION_FLOOR, fetchedAt: now };
    return CODEX_CLIENT_VERSION_FLOOR;
}
const CODEX_MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
const CODEX_MODEL_CACHE_SCHEMA_VERSION = 2;
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

const _codexModelCache = makeModelCache({
    fileName: 'openai-oauth-models.json',
    ttlMs: CODEX_MODEL_CACHE_TTL_MS,
    version: CODEX_MODEL_CACHE_SCHEMA_VERSION,
    onSave: (m) => { _inMemoryCodexCatalog = Array.isArray(m) ? m.slice() : null; },
});

function _loadCodexModelCacheSync() {
    return _codexModelCache.loadSync();
}

async function _loadCodexModelCache() {
    return _codexModelCache.loadSync();
}

async function _saveCodexModelCache(models) {
    _codexModelCache.save(models);
}

// In-memory mirror of the on-disk catalog, same pattern as anthropic-oauth.
// Populated on first listModels() and after every _saveCodexModelCache.
let _inMemoryCodexCatalog = null;
let _codexRefreshInFlight = null;
let _oauthRefreshInFlight = null;
let _lastCodexListModelsError = '';

export function getOpenAIOAuthModelCatalogError() {
    return _lastCodexListModelsError;
}

function _codexCatalogHas(id) {
    if (!id || !Array.isArray(_inMemoryCodexCatalog)) return false;
    return _inMemoryCodexCatalog.some(m => m.id === id);
}

function _findCachedCodexModel(id) {
    if (!id) return null;
    if (!Array.isArray(_inMemoryCodexCatalog)) {
        _inMemoryCodexCatalog = _loadCodexModelCacheSync();
    }
    if (!Array.isArray(_inMemoryCodexCatalog)) return null;
    return _inMemoryCodexCatalog.find(m => m?.id === id) || null;
}

function _codexServiceTiers(modelInfo) {
    return Array.isArray(modelInfo?.serviceTiers) ? modelInfo.serviceTiers : [];
}

function _codexModelBlocksServiceTier(id, serviceTier) {
    if (serviceTier !== 'priority') return false;
    const family = _codexFamily(id);
    return family === 'gpt-mini' || family === 'gpt-nano' || family === 'gpt-codex';
}

export function codexModelSupportsServiceTier(id, serviceTier) {
    if (_codexModelBlocksServiceTier(id, serviceTier)) return false;
    const info = _findCachedCodexModel(id);
    if (!info) return true;
    const tiers = _codexServiceTiers(info);
    if (!tiers.length) return false;
    return tiers.some(t => t?.id === serviceTier);
}

// Codex returns dated ids (gpt-5.4-mini-2026-03-17). Strip the trailing
// -YYYY-MM-DD to get the version alias (gpt-5.4-mini). Unknown shapes pass
// through unchanged.
function _displayCodexModel(id) {
    if (!id || typeof id !== 'string') return id;
    return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function _normalizeCodexModel(m) {
    const id = m?.slug || m?.id;
    const family = _codexFamily(id);
    const serviceTiers = Array.isArray(m?.service_tiers)
        ? m.service_tiers
            .map(t => ({
                id: String(t?.id || '').trim(),
                name: String(t?.name || '').trim(),
                description: String(t?.description || '').trim(),
            }))
            .filter(t => t.id)
        : [];
    const additionalSpeedTiers = Array.isArray(m?.additional_speed_tiers)
        ? m.additional_speed_tiers.map(t => String(t || '').trim()).filter(Boolean)
        : [];
    // Codex doesn't use dated ids — everything is effectively a version alias.
    return {
        id,
        name: m?.display_name || id,
        display: m?.display_name || id,
        family,
        provider: 'openai-oauth',
        contextWindow: m?.context_window || m?.max_context_window || 1000000,
        maxContextWindow: m?.max_context_window || null,
        outputTokens: m?.max_output_tokens || m?.output_tokens || 32768,
        autoCompactTokenLimit: m?.auto_compact_token_limit || null,
        effectiveContextWindowPercent: m?.effective_context_window_percent || null,
        tier: 'version',
        latest: false,
        description: m?.description || '',
        reasoningLevels: (m?.supported_reasoning_levels || []).map(r => r.effort),
        serviceTiers,
        defaultServiceTier: m?.default_service_tier || null,
        additionalSpeedTiers,
    };
}

function _codexFamily(id) {
    const s = String(id || '').toLowerCase();
    if (s.includes('nano')) return 'gpt-nano';
    if (s.includes('mini')) return 'gpt-mini';
    if (s.includes('codex')) return 'gpt-codex';
    if (s.startsWith('gpt-5.5')) return 'gpt-5.5';
    if (s.startsWith('gpt-5.4')) return 'gpt-5.4';
    if (s.startsWith('gpt-5.2')) return 'gpt-5.2';
    if (s.startsWith('gpt-5')) return 'gpt-5';
    return 'gpt';
}

// Compare two Codex ids by the X.Y version embedded in `gpt-X.Y`. Mirrors
// anthropic-oauth's _compareVersion, but Codex ids have no trailing date so
// the version lives in the dotted number, not a -YYYY-MM-DD suffix.
function _compareVersion(a, b) {
    const na = (String(a).match(/gpt-(\d+)\.(\d+)/) || []).slice(1).map(Number);
    const nb = (String(b).match(/gpt-(\d+)\.(\d+)/) || []).slice(1).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    }
    return String(a).localeCompare(String(b));
}

// Main gpt-5 chat family only: exclude the mini/nano/codex variants so "latest"
// resolves to the flagship, not a smaller sibling.
function _isMainCodexFamily(family) {
    return typeof family === 'string' && family.startsWith('gpt-5');
}

// Mark the highest-version model per family as `latest: true`. VERSION-based
// (Codex ids carry no `created`), mirroring anthropic-oauth's per-family pass.
function _markLatestCodex(models) {
    const byFamily = new Map();
    for (const m of models) {
        if (!m?.id) continue;
        const cur = byFamily.get(m.family);
        if (!cur || _compareVersion(m.id, cur.id) > 0) {
            byFamily.set(m.family, m);
        }
    }
    for (const m of byFamily.values()) m.latest = true;
}

// Newest MAIN gpt-5 chat model by version, read from the SYNC in-memory
// catalog mirror. Returns null until populated; callers warm via
// ensureLatestCodexModel when null.
export function resolveLatestCodexModel() {
    if (!Array.isArray(_inMemoryCodexCatalog)) return null;
    let best = null;
    for (const m of _inMemoryCodexCatalog) {
        if (!m?.id || !_isMainCodexFamily(m.family)) continue;
        if (!best || _compareVersion(m.id, best.id) > 0) best = m;
    }
    return best?.id || null;
}

export async function ensureLatestCodexModel(provider) {
    let m = resolveLatestCodexModel();
    if (m) return m;
    await provider._refreshModelCache();
    m = resolveLatestCodexModel();
    if (m) return m;
    throw new Error('[openai-oauth] model catalog unavailable after warmup — cannot resolve default model');
}

function getOwnTokenPath() {
    const dir = getPluginData();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return join(dir, 'openai-oauth.json');
}

// Public predicate used by config.buildDefaultConfig — provider is enabled
// when own tokens exist OR codex bootstrap auth is present. Single truth:
// same loader the runtime uses (loadTokens), no parallel hard-coded path probe.
export function hasOpenAIOAuthCredentials() {
    try {
        const tokens = loadTokens();
        return !!(tokens?.access_token && tokens?.refresh_token);
    } catch { return false; }
}
function _normalizeExpiresAt(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
}
function _tokensMaxMtime() {
    let max = 0;
    const paths = [getOwnTokenPath(), join(homedir(), '.codex', 'auth.json')];
    for (const p of paths) {
        try {
            const s = statSync(p);
            if (s.mtimeMs > max) max = s.mtimeMs;
        } catch { /* not present — skip */ }
    }
    return max;
}

function _codexCliAuthPath() {
    return join(homedir(), '.codex', 'auth.json');
}
function _loadOwnCodexTokens() {
    const ownPath = getOwnTokenPath();
    if (!existsSync(ownPath)) return null;
    try {
        const stat = statSync(ownPath);
        const own = JSON.parse(readFileSync(ownPath, 'utf-8'));
        if (own.access_token && own.refresh_token) {
            return {
                ...own,
                expires_at: _normalizeExpiresAt(own.expires_at ?? own.expiresAt) || _expiryFromAccessToken(own.access_token),
                account_id: own.account_id || extractAccountId(own.access_token),
                _mtimeMs: stat.mtimeMs,
            };
        }
    }
    catch { /* fall through */ }
    return null;
}
function _loadCodexCliTokens() {
    const codexPath = _codexCliAuthPath();
    if (!existsSync(codexPath)) return null;
    try {
        const stat = statSync(codexPath);
        const data = JSON.parse(readFileSync(codexPath, 'utf-8'));
        const tokens = data.tokens || data;
        if (tokens.access_token && tokens.refresh_token) {
            const expiresAt = _normalizeExpiresAt(data.expires_at ?? tokens.expires_at ?? data.expiresAt ?? tokens.expiresAt) || _expiryFromAccessToken(tokens.access_token);
            return {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expires_at: expiresAt,
                account_id: tokens.account_id || extractAccountId(tokens.access_token),
                _mtimeMs: stat.mtimeMs,
            };
        }
    }
    catch { /* fall through */ }
    return null;
}
// Own store is authoritative (accurate expires_at from refresh); the Codex CLI
// store seeds the initial bootstrap. But the refresh-token lineage is shared
// single-use with the Codex CLI, so when the CLI store is STRICTLY newer on
// disk (an independent `codex login`/CLI refresh) we must adopt it instead of
// replaying our consumed token. Freshest-wins, own preferred on a tie.
function loadTokens() {
    const own = _loadOwnCodexTokens();
    const cli = _loadCodexCliTokens();
    if (own && cli) return (cli._mtimeMs > own._mtimeMs) ? cli : own;
    return own || cli;
}
function saveTokens(tokens) {
    const target = getOwnTokenPath();
    writeJsonAtomicSync(target, tokens, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}
// Write rotated tokens back to the Codex CLI store (~/.codex/auth.json) so the
// Codex CLI picks up the rotation instead of replaying a consumed refresh_token
// from the shared single-use lineage. Mirrors anthropic-oauth's write-back.
// Best-effort; the own store stays authoritative. Host-owned file: preserve all
// other fields and don't re-permission it (no secret/mode).
function _writeBackCodexCliTokens(tokens) {
    const path = _codexCliAuthPath();
    if (!existsSync(path)) return;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw || typeof raw !== 'object') return;
        const slot = (raw.tokens && typeof raw.tokens === 'object') ? raw.tokens : raw;
        slot.access_token = tokens.access_token;
        slot.refresh_token = tokens.refresh_token;
        raw.last_refresh = new Date().toISOString();
        // Preserve the Codex CLI file's existing POSIX mode (writeJsonAtomicSync
        // otherwise defaults to 0o600, re-permissioning a host-owned file).
        let mode;
        try { mode = statSync(path).mode & 0o777; } catch { /* keep helper default */ }
        writeJsonAtomicSync(path, raw, { lock: true, fsyncDir: true, mode });
    } catch (err) {
        process.stderr.write(`[openai-oauth] Codex CLI store write-back failed: ${String(err?.message || err).slice(0, 200)}\n`);
    }
}
function extractAccountId(token) {
    try {
        const parts = token.split('.');
        if (parts.length !== 3)
            return undefined;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        return payload?.['https://api.openai.com/auth']?.chatgpt_account_id;
    }
    catch {
        return undefined;
    }
}
// Derive token expiry from the access_token's JWT `exp` claim (epoch ms), as a
// fallback when the source store carries no explicit expires_at — e.g. the Codex
// CLI's ~/.codex/auth.json records only last_refresh, so expires_at resolves to 0
// and ensureAuth reads that as "never expires", disabling proactive refresh; the
// token then only refreshes reactively after a request fails (and a WS handshake
// 401 can surface as an opaque transport error that the 401 path misses). Returns
// 0 for opaque (non-JWT) tokens. JWT `exp` is epoch SECONDS (RFC 7519).
function _expiryFromAccessToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return 0;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        const exp = Number(payload?.exp);
        return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
    }
    catch { return 0; }
}
// --- Token refresh ---
async function refreshTokens(refreshToken) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: CLIENT_ID,
            }),
            // Never follow a redirect on a secret-bearing request: a token
            // endpoint that 307/308-redirects would replay the refresh_token to
            // the redirect target. Fail loud instead.
            redirect: 'error',
            signal: controller.signal,
            dispatcher: getLlmDispatcher(),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            // Distinguish a terminally-dead refresh token (consumed by the Codex
            // CLI's single-use lineage) from transient failures, so the caller can
            // re-read disk and retry once with a newer token instead of
            // collapsing every failure to a generic null.
            if (res.status === 400 || res.status === 401 || /invalid_grant|revoked|reused/i.test(text)) {
                throw Object.assign(new Error(`OpenAI OAuth token refresh ${res.status} (invalid_grant)`), { isInvalidGrant: true });
            }
            return null;
        }
        const json = await res.json();
        if (!json.access_token) return null;
        const expiresAt = _normalizeExpiresAt(json.expires_at ?? json.expiresAt)
            || (typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0);
        const tokens = {
            access_token: json.access_token,
            refresh_token: json.refresh_token || refreshToken,
            expires_at: expiresAt,
            account_id: extractAccountId(json.access_token),
        };
        // CLI store first, own store last: the own store keeps the newest mtime
        // (and its accurate refresh expires_at), so freshest-wins loadTokens
        // treats our refresh as authoritative while the CLI still picks up the
        // rotated token.
        _writeBackCodexCliTokens(tokens);
        saveTokens(tokens);
        return tokens;
    } catch (err) {
        if (err?.name === 'AbortError')
            throw new Error('OpenAI OAuth token refresh timed out after 30000ms');
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}
// --- Build Responses API request ---
function _cloneJson(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

function _nativeCompactState(providerState, model) {
    const state = providerState?.openaiCodex?.remoteCompact;
    if (!state || state.version !== OPENAI_CODEX_REMOTE_COMPACT_VERSION) return null;
    if (!Array.isArray(state.nativePrefix) || state.nativePrefix.length === 0) return null;
    if (state.model && model && state.model !== model) return null;
    return state;
}

function _isRemoteCompactFallbackMessage(m) {
    return m?._mixdogRemoteCompactFallback === OPENAI_CODEX_REMOTE_COMPACT_FALLBACK;
}

function _contentTextParts(content, type = 'input_text') {
    if (typeof content === 'string') return content ? [{ type, text: content }] : [];
    if (!Array.isArray(content)) {
        const text = content == null ? '' : JSON.stringify(content);
        return text ? [{ type, text }] : [];
    }
    const out = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (typeof item.text === 'string') {
            out.push({ type: item.type === 'output_text' ? 'output_text' : type, text: item.text });
        } else if (typeof item.content === 'string') {
            out.push({ type, text: item.content });
        }
    }
    return out;
}

function _messageToNativeRetainedItem(m) {
    const role = m?.role;
    if (role !== 'user') return null;
    if (_isRemoteCompactFallbackMessage(m)) return null;
    const content = _contentTextParts(m.content, 'input_text');
    if (!content.length) return null;
    return { type: 'message', role, content };
}

function _nativeMessageTextTokenCount(item) {
    if (!item || item.type !== 'message') return 0;
    const content = Array.isArray(item.content) ? item.content : [];
    let chars = 0;
    for (const part of content) {
        if (typeof part?.text === 'string') chars += part.text.length;
    }
    return Math.max(1, Math.ceil(chars / 4));
}

function _truncateTextForTokens(text, maxTokens) {
    const value = String(text || '');
    const maxChars = Math.max(0, Math.floor(maxTokens * 4));
    if (value.length <= maxChars) return value;
    if (maxChars <= 32) return value.slice(0, maxChars);
    const marker = `...${Math.max(1, Math.ceil((value.length - maxChars) / 4))} tokens truncated...`;
    const room = Math.max(0, maxChars - marker.length);
    const head = Math.ceil(room / 2);
    const tail = Math.floor(room / 2);
    return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

function _truncateNativeMessageToTokenBudget(item, maxTokens) {
    if (!item || item.type !== 'message') return item;
    const clone = _cloneJson(item);
    let remaining = Math.max(0, Math.floor(maxTokens));
    const content = [];
    for (const part of Array.isArray(clone.content) ? clone.content : []) {
        if (typeof part?.text !== 'string') {
            content.push(part);
            continue;
        }
        if (remaining <= 0) continue;
        const tokenCount = Math.max(1, Math.ceil(part.text.length / 4));
        if (tokenCount <= remaining) {
            content.push(part);
            remaining -= tokenCount;
        } else {
            const truncated = _truncateTextForTokens(part.text, remaining);
            if (truncated) content.push({ ...part, text: truncated });
            remaining = 0;
        }
    }
    if (!content.length) return null;
    clone.content = content;
    return clone;
}

function _truncateRetainedNativeMessages(items, maxTokens = REMOTE_COMPACT_RETAINED_TOKEN_BUDGET) {
    let remaining = Math.max(0, Math.floor(maxTokens));
    const reversed = [];
    for (let i = items.length - 1; i >= 0; i -= 1) {
        if (remaining <= 0) break;
        const item = items[i];
        const tokenCount = _nativeMessageTextTokenCount(item);
        if (tokenCount <= remaining) {
            reversed.push(item);
            remaining -= tokenCount;
            continue;
        }
        const truncated = _truncateNativeMessageToTokenBudget(item, remaining);
        if (truncated) reversed.push(truncated);
        remaining = 0;
    }
    return reversed.reverse();
}

function _buildOpenAICodexNativeCompactPrefix(messages, compactionItem) {
    const retained = [];
    for (const m of messages || []) {
        const item = _messageToNativeRetainedItem(m);
        if (item) retained.push(item);
    }
    const compact = _cloneJson(compactionItem);
    return [..._truncateRetainedNativeMessages(retained), compact];
}

function _withOpenAICodexRemoteCompactState(providerState, { model, nativePrefix, responseId } = {}) {
    return {
        ...(providerState || {}),
        openaiCodex: {
            ...(providerState?.openaiCodex || {}),
            remoteCompact: {
                version: OPENAI_CODEX_REMOTE_COMPACT_VERSION,
                model: model || null,
                nativePrefix,
                responseId: responseId || null,
                installedAt: Date.now(),
            },
        },
    };
}

/**
 * Convert a message slice to Responses API input items.
 */
function convertMessagesToResponsesInput(messages, opts = {}) {
    const out = [];
    const nativeCompact = _nativeCompactState(opts.providerState, opts.model);
    if (nativeCompact) {
        for (const item of nativeCompact.nativePrefix) out.push(_cloneJson(item));
    }
    for (const m of messages) {
        if (!m || m.role === 'system') continue;
        if (nativeCompact && _isRemoteCompactFallbackMessage(m)) continue;
        if (m.role === 'tool') {
            out.push({
                type: 'function_call_output',
                call_id: m.toolCallId || '',
                output: m.content,
            });
            continue;
        }
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            // Reasoning replay deliberately omitted: Codex rejects an
            // `rs_*` reasoning item with the same id across the same
            // handshake session_id (in-memory conversation state lives
            // for the WS_IDLE_MS window even after a socket close).
            // Server-side state already preserves the prefix; sending
            // reasoning in `input` triggers "Duplicate item".
            if (m.content) out.push({ role: 'assistant', content: m.content });
            for (const tc of m.toolCalls) {
                out.push({
                    type: 'function_call',
                    call_id: tc.id,
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                });
            }
            continue;
        }
        out.push({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
        });
    }
    return out;
}
export function buildRequestBody(messages, model, tools, sendOpts) {
    // Extract system/instructions
    const systemMsgs = messages.filter(m => m.role === 'system');
    const instructions = systemMsgs.map(m => m.content).join('\n\n') || 'You are a helpful assistant.';
    const opts = sendOpts || {};
    const input = convertMessagesToResponsesInput(messages, {
        providerState: opts.providerState,
        model,
    });
    // Match the body shape pi-mono and the official Codex CLI ship so the
    // server-side auto-cache routes correctly. text.verbosity / include /
    // tool_choice / parallel_tool_calls are all inert without side effects
    // for most callers but their presence affects how Codex classifies the
    // request (and therefore whether the prompt cache is consulted).
    const body = {
        model,
        instructions,
        input,
        store: process.env.MIXDOG_OAI_STORE === 'true' ? true : false,
        stream: true,
        reasoning: { effort: opts.effort || 'medium' },
        text: { verbosity: 'medium' },
        include: ['reasoning.encrypted_content'],
        tool_choice: opts.toolChoice || 'auto',
        parallel_tool_calls: true,
    };
    const maxOutputTokens = Number(opts.maxOutputTokens ?? opts.outputTokens ?? opts.max_output_tokens);
    if (_envFlag('MIXDOG_OPENAI_OAUTH_SEND_MAX_OUTPUT_TOKENS', false)
        && Number.isFinite(maxOutputTokens)
        && maxOutputTokens > 0) {
        body.max_output_tokens = Math.floor(maxOutputTokens);
    }
    if (opts.fast === true) {
        // 'priority' is the only fast-class value the Codex OAuth backend
        // accepts on the wire: 'fast' is hard-rejected ("Unsupported
        // service_tier: fast", probed 2026-06-11). Match official Codex:
        // only send the request value when the model catalog advertises it.
        if (codexModelSupportsServiceTier(model, 'priority')) {
            body.service_tier = 'priority';
        }
    }
    // Add tools
    if (tools?.length) {
        body.tools = tools.map(t => ({
            type: 'function',
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
        }));
    }
    const promptCacheProvider = opts.promptCacheProvider || 'openai-oauth';
    const promptCacheLane = opts.promptCacheLane || resolveProviderPromptCacheLane(promptCacheProvider, opts);
    body.prompt_cache_key = buildStableProviderPromptCacheKey(promptCacheProvider, opts, {
        model,
        instructions,
        tools: body.tools || [],
        effort: body.reasoning?.effort,
        fast: opts.fast === true,
        serviceTier: body.service_tier || '',
        toolChoice: body.tool_choice,
        parallelToolCalls: body.parallel_tool_calls,
        cacheLaneSlot: promptCacheLane.slot,
        cacheLaneShards: promptCacheLane.shards,
    });
    // NOTE: prompt_cache_retention is a public OpenAI Responses API parameter,
    // but the Codex OAuth endpoint still rejects it ("Unsupported parameter:
    // prompt_cache_retention", re-probed 2026-06-22). Leave retention on the
    // Codex server default; public OpenAI direct injects 24h separately.
    return body;
}

function buildRemoteCompactionRequestBody(messages, model, tools, sendOpts) {
    const body = buildRequestBody(messages, model, tools, {
        ...(sendOpts || {}),
        expectCompaction: true,
    });
    body.input = [
        ...(Array.isArray(body.input) ? body.input : []),
        { type: 'compaction_trigger' },
    ];
    return body;
}

function _envFlag(name, fallback = true) {
    const raw = process.env[name];
    if (raw == null || raw === '') return fallback;
    return !['0', 'false', 'off', 'no'].includes(String(raw).toLowerCase());
}

function _parseJsonObject(value) {
    try {
        const parsed = JSON.parse(value || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function _extractCachedTokens(usage) {
    const details = usage?.input_tokens_details || usage?.prompt_tokens_details || {};
    return Number(details.cached_tokens ?? details.cached ?? usage?.cached_tokens ?? 0) || 0;
}

function _sseEventsFromBuffer(buffer) {
    const frames = [];
    let rest = buffer.replace(/\r\n/g, '\n');
    let idx;
    while ((idx = rest.indexOf('\n\n')) >= 0) {
        frames.push(rest.slice(0, idx));
        rest = rest.slice(idx + 2);
    }
    return { frames, rest };
}

function _parseSseFrame(frame) {
    const lines = String(frame || '').split('\n');
    const data = [];
    for (const line of lines) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
    }
    if (!data.length) return null;
    const raw = data.join('\n').trim();
    if (!raw || raw === '[DONE]') return null;
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

function _pushOutputTextAnnotations(part, citations, citationKeys) {
    const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
    for (const raw of annotations) {
        const url = raw?.url || raw?.uri || raw?.href || '';
        if (!url || citationKeys.has(url)) continue;
        citationKeys.add(url);
        citations.push({
            title: raw?.title || '',
            url,
            snippet: raw?.snippet || raw?.text || raw?.description || '',
            source: 'openai-oauth',
        });
    }
}

function _buildOpenAIHttpFallbackHeaders({ auth, cacheKey }) {
    const headers = {
        Authorization: `Bearer ${auth.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'OpenAI-Beta': 'responses=experimental',
        originator: CODEX_OAUTH_ORIGINATOR,
        'chatgpt-account-id': auth.account_id || '',
        'x-client-request-id': randomBytes(16).toString('hex'),
    };
    if (cacheKey) headers.session_id = String(cacheKey);
    return headers;
}

function _shouldUseOpenAIHttpFallback(err, externalSignal) {
    if (!_envFlag('MIXDOG_OPENAI_OAUTH_HTTP_FALLBACK', true)) return false;
    if (externalSignal?.aborted) return false;
    // Live-text invariant: if the WS attempt already relayed a non-empty text
    // chunk to the client, the HTTP fallback would re-run the request and
    // concatenate a second attempt onto rendered output. Never fall back.
    if (err?.liveTextEmitted === true) return false;
    const status = Number(err?.httpStatus || err?.status || 0);
    if (status === 401 || status === 403 || status === 404 || status === 429) return false;
    if (status >= 500 && status < 600) return true;
    const code = String(err?.code || '');
    if (['EWSACQUIRETIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'EAI_NODATA', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'].includes(code)) {
        return true;
    }
    const classifier = String(err?.retryClassifier || err?.midstreamClassifier || '');
    if (['timeout', 'reset', 'dns', 'refused', 'network', 'acquire_timeout', 'http_5xx', 'first_byte_timeout', 'first_meaningful_timeout'].includes(classifier)) {
        return true;
    }
    if (/^http_5\d\d$/.test(classifier)) return true;
    if (err?.firstByteTimeout) return true;
    if (err?.firstMeaningfulTimeout) return true;
    const msg = String(err?.message || '');
    return /opening handshake has timed out|socket hang up|acquire timed out|no first server event|no meaningful output/i.test(msg);
}

// Exported for the single-emit regression smoke (scripts/openai-oauth-
// http-sse-toolcall-smoke.mjs): the SSE stream can surface the same
// function_call across response.function_call_arguments.done +
// response.output_item.done + response.completed, and onToolCall must fire
// exactly once per call id. No production caller imports this name; the
// provider invokes it internally.
export async function sendViaHttpSse({
    auth,
    body,
    opts,
    onStreamDelta,
    onToolCall,
    onTextDelta,
    onStageChange,
    externalSignal,
    poolKey,
    cacheKey,
    iteration,
    useModel,
    fetchFn = fetch,
} = {}) {
    const totalTimeout = createTimeoutSignal(
        externalSignal,
        PROVIDER_GENERATE_TOTAL_TIMEOUT_MS,
        'OpenAI OAuth HTTP fallback total',
    );
    const headerTimeout = createTimeoutSignal(
        totalTimeout.signal,
        PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
        'OpenAI OAuth HTTP fallback initial response',
    );
    const headers = _buildOpenAIHttpFallbackHeaders({ auth, cacheKey });
    const fetchStartedAt = Date.now();
    let response;
    try {
        try { onStageChange?.('requesting'); } catch {}
        response = await fetchFn(CODEX_RESPONSES_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: headerTimeout.signal,
            dispatcher: getLlmDispatcher(),
        });
    } catch (err) {
        if (headerTimeout.signal?.aborted && headerTimeout.signal.reason instanceof Error) throw headerTimeout.signal.reason;
        throw err;
    } finally {
        headerTimeout.cleanup();
    }

    traceBridgeFetch({
        sessionId: poolKey,
        headersMs: Date.now() - fetchStartedAt,
        httpStatus: response.status,
        provider: 'openai-oauth',
        model: useModel,
        transport: 'http',
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        const err = new Error(`OpenAI OAuth HTTP fallback ${response.status}: ${text.slice(0, 200)}`);
        err.httpStatus = response.status;
        err.headers = response.headers;
        populateHttpStatusFromMessage(err, text);
        totalTimeout.cleanup();
        throw err;
    }
    if (!response.body) {
        totalTimeout.cleanup();
        throw new Error('OpenAI OAuth HTTP fallback returned no response body');
    }

    try { onStageChange?.('streaming'); } catch {}
    const sseStartedAt = Date.now();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // After headerTimeout.cleanup() the in-flight fetch no longer carries a live
    // signal, so a totalTimeout / external abort that fires during a pending
    // reader.read() would otherwise leave the pooled request hanging. Keep the
    // reader tied to totalTimeout for the whole stream: on abort, cancel the
    // reader so the awaited read() unblocks and the socket is released back to
    // the shared pool instead of leaking. reader.cancel() may resolve the
    // pending read() as {done:true} rather than rejecting, which would let a
    // partial response surface as success — so record the abort reason and
    // re-throw it after the loop unblocks (see below).
    let _streamAbortReason = null;
    let _onTotalAbort = null;
    if (totalTimeout.signal) {
        _onTotalAbort = () => {
            const reason = totalTimeout.signal.reason;
            _streamAbortReason = reason instanceof Error
                ? reason
                : new Error('OpenAI OAuth HTTP fallback aborted');
            try { reader.cancel(_streamAbortReason).catch(() => {}); } catch {}
        };
        if (totalTimeout.signal.aborted) _onTotalAbort();
        else totalTimeout.signal.addEventListener('abort', _onTotalAbort, { once: true });
    }
    let buffer = '';
    let content = '';
    let model = '';
    let responseId = '';
    let serviceTier = '';
    let usage = null;
    let ttftMs = null;
    const toolCalls = [];
    const pendingCalls = new Map();
    const reasoningItems = [];
    const compactionItems = [];
    const citations = [];
    const citationKeys = new Set();
    const webSearchCalls = [];
    const webSearchCallKeys = new Set();
    let completed = false;
    let stopReason = null;
    // Gateway live-text relay invariant: set once a non-empty text chunk has
    // been forwarded to the client. A failure afterwards is non-retryable —
    // the rendered text cannot be withdrawn and a re-request would concatenate
    // a second attempt.
    let emittedText = false;

    // Single-emit guard for tool calls (matches the WS path's
    // emittedToolCall intent). The HTTP/SSE event stream can surface the
    // same function_call across multiple frames — response.function_call_arguments.done,
    // response.output_item.done, and the final response.completed.output
    // bundle. Each frame independently completes the call (id + name) and
    // would re-invoke onToolCall, double-executing a side-effecting tool.
    // Route every emit through emitToolCall: it fires the callback exactly
    // once per unique call id, the first time the call is complete. A call
    // whose id/name only arrives in a later frame is NOT dropped — its
    // first complete frame still emits; only redundant re-emits are
    // suppressed.
    const emittedToolCallIds = new Set();
    const emitToolCall = (call) => {
        if (!call || !call.id) return;
        if (emittedToolCallIds.has(call.id)) return;
        emittedToolCallIds.add(call.id);
        try { onToolCall?.(call); } catch {}
    };

    const pushWebSearchCall = (item) => {
        if (!item || item.type !== 'web_search_call') return;
        const key = item.id || JSON.stringify(item.action || item);
        if (webSearchCallKeys.has(key)) return;
        webSearchCallKeys.add(key);
        webSearchCalls.push({ id: item.id || '', status: item.status || '', action: item.action || null });
    };
    const pushReasoningItem = (item) => {
        if (item?.type === 'reasoning' && item.encrypted_content && !reasoningItems.some(r => r.id === item.id)) {
            reasoningItems.push({
                id: item.id || '',
                encrypted_content: item.encrypted_content,
                summary: Array.isArray(item.summary) ? item.summary : [],
            });
        }
    };
    const pushCompactionItem = (item) => {
        if (!item || !['compaction', 'compaction_summary', 'context_compaction'].includes(item.type)) return;
        if (!item.encrypted_content) return;
        compactionItems.push(item);
    };
    const meaningful = () => {
        if (ttftMs == null) ttftMs = Date.now() - sseStartedAt;
        try { onStreamDelta?.(); } catch {}
    };
    const handleEvent = (event) => {
        if (!event || typeof event.type !== 'string') return;
        switch (event.type) {
            case 'response.created':
                if (event.response?.model) model = event.response.model;
                if (event.response?.id) responseId = event.response.id;
                break;
            case 'response.output_text.delta':
                content += event.delta || '';
                meaningful();
                if (event.delta && onTextDelta) {
                    emittedText = true;
                    try { onTextDelta(event.delta); } catch {}
                }
                break;
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta':
                meaningful();
                break;
            case 'response.output_item.added':
                if (event.item?.type === 'function_call') {
                    pendingCalls.set(event.item.id || '', {
                        name: event.item.name || '',
                        callId: event.item.call_id || '',
                    });
                }
                break;
            case 'response.function_call_arguments.delta':
                meaningful();
                break;
            case 'response.function_call_arguments.done': {
                const itemId = event.item_id || '';
                const pending = pendingCalls.get(itemId);
                const call = {
                    id: pending?.callId || event.call_id || '',
                    name: pending?.name || event.name || '',
                    arguments: _parseJsonObject(event.arguments),
                    _pendingItemId: itemId,
                };
                toolCalls.push(call);
                if (call.id && call.name) {
                    delete call._pendingItemId;
                    emitToolCall(call);
                }
                meaningful();
                break;
            }
            case 'response.output_item.done': {
                const item = event.item || {};
                pushReasoningItem(item);
                pushWebSearchCall(item);
                pushCompactionItem(item);
                if (item.type === 'function_call') {
                    const tc = toolCalls.find(t => t._pendingItemId === (item.id || ''));
                    if (tc) {
                        if (!tc.id && item.call_id) tc.id = item.call_id;
                        if (!tc.name && item.name) tc.name = item.name;
                        if (tc.id && tc.name) {
                            delete tc._pendingItemId;
                            emitToolCall(tc);
                        }
                    }
                }
                break;
            }
            case 'response.completed': {
                const resp = event.response || {};
                serviceTier = resp.service_tier || resp.serviceTier || serviceTier;
                if (!model && resp.model) model = resp.model;
                if (!responseId && resp.id) responseId = resp.id;
                if (resp.usage) {
                    usage = {
                        inputTokens: resp.usage.input_tokens || 0,
                        outputTokens: resp.usage.output_tokens || 0,
                        cachedTokens: _extractCachedTokens(resp.usage),
                        promptTokens: resp.usage.input_tokens || 0,
                        raw: serviceTier ? { ...resp.usage, service_tier: serviceTier } : resp.usage,
                    };
                }
                for (const item of resp.output || []) {
                    if (item.type === 'message') {
                        for (const part of item.content || []) {
                            if (!content && part.type === 'output_text') content += part.text || '';
                            if (part.type === 'output_text') _pushOutputTextAnnotations(part, citations, citationKeys);
                        }
                    } else if (item.type === 'reasoning') {
                        pushReasoningItem(item);
                    } else if (item.type === 'web_search_call') {
                        pushWebSearchCall(item);
                    } else if (['compaction', 'compaction_summary', 'context_compaction'].includes(item.type)) {
                        pushCompactionItem(item);
                    } else if (item.type === 'function_call') {
                        // Match the still-pending placeholder by item id, or
                        // an already-recorded call by its canonical call_id —
                        // so a call completed at args.done / output_item.done
                        // is reused here rather than re-pushed as a duplicate.
                        const tc = toolCalls.find(t =>
                            t._pendingItemId === (item.id || '')
                            || (item.call_id && t.id === item.call_id));
                        if (tc) {
                            if (!tc.id && item.call_id) tc.id = item.call_id;
                            if (!tc.name && item.name) tc.name = item.name;
                            if (tc.id && tc.name) {
                                delete tc._pendingItemId;
                                emitToolCall(tc);
                            }
                        } else if (item.call_id && item.name) {
                            const call = {
                                id: item.call_id,
                                name: item.name,
                                arguments: _parseJsonObject(item.arguments),
                            };
                            toolCalls.push(call);
                            emitToolCall(call);
                        }
                    }
                }
                completed = true;
                break;
            }
            case 'response.done':
                if (!event.response || event.response.status === 'completed') completed = true;
                else if (event.response.status === 'failed') {
                    const msg = event.response?.error?.message || 'response.done failed';
                    const err = new Error(`OpenAI OAuth HTTP fallback response.done failed: ${msg}`);
                    populateHttpStatusFromMessage(err, msg);
                    throw err;
                } else if (event.response.status === 'incomplete') {
                    const reason = _incompleteReasonFromEvent(event);
                    if (_isMaxOutputIncompleteReason(reason)) {
                        completed = true;
                        stopReason = 'length';
                        break;
                    }
                    throw new Error(`OpenAI OAuth HTTP fallback response.done incomplete: ${reason}`);
                }
                break;
            case 'response.failed': {
                const msg = event.response?.error?.message || event.error?.message || event.message || 'response.failed';
                const err = new Error(`OpenAI OAuth HTTP fallback response.failed: ${msg}`);
                populateHttpStatusFromMessage(err, msg);
                throw err;
            }
            case 'response.incomplete': {
                const reason = _incompleteReasonFromEvent(event);
                if (_isMaxOutputIncompleteReason(reason)) {
                    completed = true;
                    stopReason = 'length';
                    break;
                }
                throw new Error(`OpenAI OAuth HTTP fallback response.incomplete: ${reason}`);
            }
            case 'error': {
                const msg = event.message || event.error?.message || 'unknown';
                const err = new Error(`OpenAI OAuth HTTP fallback error: ${msg}`);
                populateHttpStatusFromMessage(err, msg);
                throw err;
            }
            default:
                break;
        }
    };

    try {
        while (true) {
            if (totalTimeout.signal.aborted) {
                const reason = totalTimeout.signal.reason;
                throw reason instanceof Error ? reason : new Error('OpenAI OAuth HTTP fallback aborted');
            }
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parsed = _sseEventsFromBuffer(buffer);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
                const event = _parseSseFrame(frame);
                if (event) handleEvent(event);
            }
        }
        // The read() above can unblock via reader.cancel() as {done:true} on an
        // external/total-timeout abort. Surface that as the abort/timeout error
        // instead of treating the partial stream as a successful response.
        if (_streamAbortReason) throw _streamAbortReason;
        buffer += decoder.decode();
        const parsed = _sseEventsFromBuffer(buffer + '\n\n');
        for (const frame of parsed.frames) {
            const event = _parseSseFrame(frame);
            if (event) handleEvent(event);
        }
    } catch (err) {
        // Live-text invariant: once a non-empty chunk has been relayed it
        // cannot be withdrawn — flag the error so no upstream layer retries.
        if (emittedText && err) { try { err.liveTextEmitted = true; err.unsafeToRetry = true; } catch {} }
        throw err;
    } finally {
        try { reader.releaseLock?.(); } catch {}
        if (_onTotalAbort && totalTimeout.signal) {
            try { totalTimeout.signal.removeEventListener('abort', _onTotalAbort); } catch {}
        }
        totalTimeout.cleanup();
    }

    const unresolved = toolCalls.find(t => t._pendingItemId);
    if (unresolved) {
        throw new Error(`OpenAI OAuth HTTP fallback function_call salvage failed: missing call_id/name for item_id=${unresolved._pendingItemId || '?'}`);
    }
    if (opts?.expectCompaction === true && compactionItems.length !== 1) {
        throw new Error(`OpenAI OAuth HTTP fallback remote compaction expected exactly one compaction output item, got ${compactionItems.length}`);
    }
    if (!completed && !content && !toolCalls.length) {
        throw new Error('OpenAI OAuth HTTP fallback ended before response.completed');
    }

    const liveModel = model || useModel;
    traceBridgeSse({
        sessionId: poolKey,
        sseParseMs: Date.now() - sseStartedAt,
        ttftMs,
        provider: 'openai-oauth',
        model: liveModel,
        transport: 'sse',
    });
    if (usage) {
        traceBridgeUsage({
            sessionId: poolKey,
            iteration,
            inputTokens: usage.inputTokens || 0,
            outputTokens: usage.outputTokens || 0,
            cachedTokens: usage.cachedTokens || 0,
            promptTokens: usage.promptTokens || 0,
            model: liveModel,
            modelDisplay: _displayCodexModel(liveModel),
            responseId: responseId || null,
            rawUsage: usage.raw || null,
            provider: 'openai-oauth',
            serviceTier,
        });
    }
    return {
        content,
        model: liveModel,
        reasoningItems: reasoningItems.length ? reasoningItems : undefined,
        compactionItem: compactionItems.length === 1 ? compactionItems[0] : undefined,
        compactionItems: compactionItems.length ? compactionItems : undefined,
        toolCalls: toolCalls.length ? toolCalls.map(({ _pendingItemId, ...t }) => t) : undefined,
        citations: citations.length ? citations : undefined,
        webSearchCalls: webSearchCalls.length ? webSearchCalls : undefined,
        usage: usage || undefined,
        stopReason: stopReason || undefined,
        responseId: responseId || undefined,
        serviceTier: serviceTier || undefined,
    };
}

// --- Provider ---
export class OpenAIOAuthProvider {
    // OpenAI input_tokens already INCLUDES cached_tokens (cached is a subset),
    // so input alone is the context footprint. See registry.mjs.
    static inputExcludesCache = false;
    name = 'openai-oauth';
    tokens = null;
    _refreshFallbackUntil = 0;
    _forceHttpFallback = false;
    config;
    constructor(config) {
        this.config = config || {};
        this.tokens = loadTokens();
        // Warm a kept-alive socket to the Codex responses API so the first
        // request skips the cold TLS handshake. Best-effort; never throws.
        preconnect('https://chatgpt.com');
    }
    getCachedModelInfo(model) {
        return _findCachedCodexModel(model);
    }
    async remoteCompactMessages(messages, model, tools, sendOpts = {}) {
        const opts = {
            ...sendOpts,
            expectCompaction: true,
            nativeCompact: true,
        };
        const useModel = model || await ensureLatestCodexModel(this);
        const promptCacheLane = resolveProviderPromptCacheLane('openai-oauth', opts, this.config);
        const bodyOpts = {
            ...opts,
            promptCacheLane,
        };
        const body = buildRemoteCompactionRequestBody(messages, useModel, tools, bodyOpts);
        let auth = await this.ensureAuth();
        const poolKey = opts.sessionId || null;
        const cacheKey = body.prompt_cache_key || resolveProviderCacheKey(opts, 'openai-oauth');
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const sendWs = typeof opts._sendViaWebSocketFn === 'function' ? opts._sendViaWebSocketFn : sendViaWebSocket;
        const sendHttp = typeof opts._sendViaHttpSseFn === 'function' ? opts._sendViaHttpSseFn : sendViaHttpSse;
        const dispatchHttp = async (reason, originalErr = null) => {
            appendBridgeTrace({
                sessionId: poolKey,
                iteration,
                kind: 'transport_fallback',
                provider: 'openai-oauth',
                model: useModel,
                transport: 'http',
                payload: {
                    from: 'websocket',
                    to: 'http',
                    reason,
                    remote_compact: true,
                    error_code: originalErr?.code || null,
                    error_http_status: Number(originalErr?.httpStatus || 0) || null,
                },
            });
            return sendHttp({
                auth,
                body,
                opts,
                onStreamDelta: null,
                onToolCall: null,
                onStageChange,
                externalSignal: opts.signal || null,
                poolKey,
                cacheKey,
                iteration,
                useModel,
                fetchFn: opts._fetchFn,
            });
        };
        const dispatchWs = (forceFresh = false) => sendWs({
            auth,
            body,
            sendOpts: opts,
            onStreamDelta: null,
            onToolCall: null,
            onStageChange,
            externalSignal: opts.signal || null,
            poolKey,
            cacheKey,
            iteration,
            useModel,
            displayModel: _displayCodexModel,
            forceFresh,
            includeResponseId: true,
        });

        let result;
        if (opts.forceHttpFallback === true
            || this._forceHttpFallback
            || _envFlag('MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK', false)) {
            result = await dispatchHttp('forced');
        } else {
            try {
                result = await dispatchWs(false);
            } catch (err) {
                const status = err?.httpStatus;
                if (status === 401 || status === 403) {
                    this._refreshFallbackUntil = 0;
                    auth = await this.ensureAuth({ forceRefresh: true, reason: String(status) });
                    result = await dispatchWs(true);
                } else if (_shouldUseOpenAIHttpFallback(err, opts.signal || null)) {
                    result = await dispatchHttp(err?.retryClassifier || err?.midstreamClassifier || err?.code || err?.message || 'ws_failed', err);
                } else {
                    throw err;
                }
            }
        }

        if (!result?.compactionItem) {
            throw new Error('OpenAI OAuth remote compact completed without compaction item');
        }
        const liveModel = result.model || useModel;
        if (liveModel && !_codexCatalogHas(liveModel)) void this._refreshModelCache();
        const nativePrefix = _buildOpenAICodexNativeCompactPrefix(messages, result.compactionItem);
        return {
            model: liveModel,
            usage: result.usage,
            responseId: result.responseId || null,
            providerState: _withOpenAICodexRemoteCompactState(opts.providerState, {
                model: useModel,
                nativePrefix,
                responseId: result.responseId || null,
            }),
        };
    }
    async ensureAuth({ forceRefresh = false, reason = 'preemptive' } = {}) {
        if (!this.tokens) this.tokens = loadTokens();
        if (!this.tokens)
            throw new Error('OpenAI OAuth not authenticated. Run codex login first.');
        // Pick up disk-rotated tokens (codex login, host refresh) the moment
        // the auth file is rewritten — without this, a fresh login is ignored
        // until the in-memory token hits its expiry skew.
        const diskMtime = _tokensMaxMtime();
        // Watermark guards termination: if the newest file on disk isn't loadable
        // (e.g. a logged-out host auth.json beside a valid own store), loadTokens
        // falls back to the older valid store; record the scanned mtime so this
        // check can't re-fire on every ensureAuth().
        if (diskMtime > 0 && diskMtime > (this._lastDiskScan || 0) && diskMtime > (this.tokens._mtimeMs || 0)) {
            const fresh = loadTokens();
            if (fresh?.access_token) {
                this.tokens = fresh;
                this._refreshFallbackUntil = 0;
                process.stderr.write(`[openai-oauth] Reloaded tokens from disk (mtime change)\n`);
            }
            this._lastDiskScan = diskMtime;
        }
        if (!forceRefresh && this._refreshFallbackUntil > Date.now() && this.tokens?.access_token) {
            return this.tokens;
        }
        const expiring = this.tokens.expires_at
            ? this.tokens.expires_at < Date.now() + TOKEN_REFRESH_SKEW_MS
            : false;
        if (forceRefresh || expiring) {
            this._refreshFallbackUntil = 0;
            this.tokens = await this._refreshTokens({ force: forceRefresh, reason });
        }
        return this.tokens;
    }

    async _refreshTokens({ force = false, reason = 'preemptive' } = {}) {
        const currentToken = this.tokens?.access_token || null;
        const disk = loadTokens();
        const validAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
        if (disk?.access_token && disk.access_token !== currentToken
            && (!disk.expires_at || disk.expires_at >= validAfter)) {
            this.tokens = disk;
            process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
            return disk;
        }
        if (!this.tokens && disk) this.tokens = disk;

        if (_oauthRefreshInFlight) {
            const shared = await _oauthRefreshInFlight;
            this.tokens = shared;
            if (!force || shared?.access_token !== currentToken) return this.tokens;
        }

        const startingTokens = this.tokens || disk;
        _oauthRefreshInFlight = (async () => {
            const latest = loadTokens() || startingTokens;
            const latestValidAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
            if (latest?.access_token && latest.access_token !== currentToken
                && (!latest.expires_at || latest.expires_at >= latestValidAfter)) {
                process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
                return latest;
            }

            if (!latest?.refresh_token) {
                if (!force && latest?.access_token && (!latest.expires_at || latest.expires_at > Date.now())) {
                    process.stderr.write(`[openai-oauth] WARNING: token expiring but no refresh token; using current token until expiry\n`);
                    this._refreshFallbackUntil = Date.now() + TOKEN_REFRESH_SKEW_MS;
                    return latest;
                }
                throw new Error('OpenAI OAuth refresh token not available. Run codex login to re-authenticate.');
            }

            try {
                const _refreshT0 = Date.now();
                const _expiringInMs = (latest?.expires_at ?? 0) - Date.now();
                if (process.env.MIXDOG_DEBUG_BRIDGE) { process.stderr.write(`[bridge-trace] auth-refresh-needed expiringInMs=${_expiringInMs}\n`); }
                process.stderr.write(`[openai-oauth] Token ${reason}, refreshing...\n`);
                let refreshed;
                try {
                    refreshed = await refreshTokens(latest.refresh_token);
                } catch (refreshErr) {
                    // invalid_grant: the Codex CLI rotated this single-use refresh
                    // token between our disk read and this refresh. Re-read both
                    // stores and retry ONCE with the freshest different token.
                    if (!refreshErr?.isInvalidGrant) throw refreshErr;
                    process.stderr.write('[openai-oauth] invalid_grant — re-reading disk, retrying refresh\n');
                    const candidates = [_loadOwnCodexTokens(), _loadCodexCliTokens()].filter(Boolean)
                        .sort((a, b) => (b._mtimeMs || 0) - (a._mtimeMs || 0));
                    const freshTok = candidates.find(c => c.refresh_token && c.refresh_token !== latest.refresh_token);
                    if (!freshTok) throw refreshErr;
                    refreshed = await refreshTokens(freshTok.refresh_token);
                }
                if (process.env.MIXDOG_DEBUG_BRIDGE) { process.stderr.write(`[bridge-trace] auth-refresh-done elapsed=${Date.now() - _refreshT0}ms ok=${!!refreshed}\n`); }
                if (!refreshed) throw new Error('refresh returned null');
                process.stderr.write(`[openai-oauth] Token refreshed, expires in ${Math.round(((refreshed.expires_at || Date.now()) - Date.now()) / 1000)}s\n`);
                return refreshed;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!force && latest?.access_token && (!latest.expires_at || latest.expires_at > Date.now())) {
                    this._refreshFallbackUntil = Date.now() + TOKEN_REFRESH_SKEW_MS;
                    process.stderr.write(`[openai-oauth] Refresh failed (${msg}); using still-valid current token\n`);
                    return latest;
                }
                throw new Error(`OpenAI OAuth token refresh failed (${msg}). Run codex login to re-authenticate.`);
            }
        })().finally(() => { _oauthRefreshInFlight = null; });

        this.tokens = await _oauthRefreshInFlight;
        return this.tokens;
    }
    async send(messages, model, tools, sendOpts) {
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        const externalSignal = opts.signal || null;
        const _sendSessionId = opts.sessionId || '(none)';
        const _sendRole = opts.role || '(none)';
        if (process.env.MIXDOG_DEBUG_BRIDGE) { process.stderr.write(`[bridge-trace] auth-start sessionHash=${createHash('sha256').update(String(_sendSessionId)).digest('hex').slice(0, 8)} role=${_sendRole} expiringInMs=${this.tokens?.expires_at ? this.tokens.expires_at - Date.now() : 'unknown'}\n`); }
        // Build request body in parallel with auth resolution. ensureAuth is
        // a no-op fast-path on cached tokens, but a refresh round-trip can
        // take 300ms+; the body build (message serialisation) overlaps cleanly.
        const useModel = model || await ensureLatestCodexModel(this);
        // Escape hatch for callers (e.g. the web-search backend) that ship a
        // fully-formed request body with a server-side tool shape buildRequestBody
        // can't express. Routing through send() still gives them the 401/403
        // force-refresh retry + HTTP/SSE fallback instead of a hard fail.
        const promptCacheLane = resolveProviderPromptCacheLane('openai-oauth', opts, this.config);
        const bodyOpts = {
            ...sendOpts,
            promptCacheLane,
        };
        const _bodyP = opts._prebuiltBody
            ? Promise.resolve(opts._prebuiltBody)
            : Promise.resolve().then(() => buildRequestBody(messages, useModel, tools, bodyOpts));
        const _authP = this.ensureAuth();
        let auth = await _authP;
        const body = await _bodyP;
        // poolKey ≠ cacheKey by design (see openai-oauth-ws.mjs header note).
        // poolKey is per-session so parallel reviewer/worker callers each
        // get their own socket bucket — a sibling cannot grab a mid-turn
        // entry and trip Codex's "No tool call found for function call
        // output with call_id …" rejection. cacheKey is prefix-scoped
        // (base namespace + model/system/tools hash) and feeds both
        // `body.prompt_cache_key` and the handshake `session_id` header, so
        // compatible prefixes share cache without main/worker lanes evicting
        // each other.
        // poolKey defaults to sessionId (per-session socket isolation); cacheKey
        // never falls back to sessionId, so a fresh session still reuses the
        // warm prefix cache for the same route/prefix.
        const poolKey  = opts.sessionId || null;
        const cacheKey = body.prompt_cache_key || resolveProviderCacheKey(opts, 'openai-oauth');
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        const sendWs = typeof opts._sendViaWebSocketFn === 'function' ? opts._sendViaWebSocketFn : sendViaWebSocket;
        const sendHttp = typeof opts._sendViaHttpSseFn === 'function' ? opts._sendViaHttpSseFn : sendViaHttpSse;
        const _t1 = Date.now();
        const recordLiveModel = (result) => {
            if (result?.model && !_codexCatalogHas(result.model)) {
                void this._refreshModelCache();
            }
            if (result && opts.providerState !== undefined && result.providerState === undefined) {
                result.providerState = opts.providerState;
            }
            return result;
        };
        const dispatchHttp = async (reason, originalErr = null) => {
            appendBridgeTrace({
                sessionId: poolKey,
                iteration,
                kind: 'transport_fallback',
                provider: 'openai-oauth',
                model: useModel,
                transport: 'http',
                payload: {
                    from: 'websocket',
                    to: 'http',
                    reason,
                    error_code: originalErr?.code || null,
                    error_http_status: Number(originalErr?.httpStatus || 0) || null,
                    error_classifier: originalErr?.retryClassifier || originalErr?.midstreamClassifier || null,
                },
            });
            process.stderr.write(`[openai-oauth] WebSocket unhealthy (${reason}); falling back to HTTP/SSE\n`);
            const result = await sendHttp({
                auth,
                body,
                opts,
                onStreamDelta,
                onToolCall,
                onTextDelta,
                onStageChange,
                externalSignal,
                poolKey,
                cacheKey,
                iteration,
                useModel,
                fetchFn: opts._fetchFn,
            });
            this._forceHttpFallback = true;
            if (process.env.MIXDOG_DEBUG_BRIDGE) {
                process.stderr.write(`[bridge-trace] provider-send-end elapsed=${Date.now() - _t1}ms result=ok transport=http-fallback\n`);
            }
            return recordLiveModel(result);
        };
        const dispatchWs = (forceFresh = false) => sendWs({
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
            displayModel: _displayCodexModel,
            forceFresh,
        });
        if (opts.forceHttpFallback === true
            || this._forceHttpFallback
            || _envFlag('MIXDOG_OPENAI_OAUTH_FORCE_HTTP_FALLBACK', false)) {
            return dispatchHttp('forced');
        }

        // Prefer WebSocket for hot cache/delta transport; fall back to HTTP/SSE
        // after retry-exhausted handshake/acquire/no-first-event failures.
        try {
            if (process.env.MIXDOG_DEBUG_BRIDGE) { process.stderr.write(`[bridge-trace] provider-send-start model=${useModel} role=${_sendRole} sessionHash=${createHash('sha256').update(String(_sendSessionId)).digest('hex').slice(0, 8)} iteration=${iteration ?? '(none)'}\n`); }
            const result = await dispatchWs(false);
            if (process.env.MIXDOG_DEBUG_BRIDGE) { process.stderr.write(`[bridge-trace] provider-send-end elapsed=${Date.now() - _t1}ms result=ok\n`); }
            return recordLiveModel(result);
        } catch (err) {
            const status = err?.httpStatus;
            // Live-text invariant: if the WS attempt already relayed a
            // non-empty text chunk to the client, NO recovery path may reissue
            // the turn — an auth-refresh + dispatchWs(true) retry would
            // concatenate a second attempt onto already-rendered output. Refuse
            // the retry (and the HTTP fallback below already refuses) and
            // surface the original error.
            const liveTextEmitted = err?.liveTextEmitted === true || err?.unsafeToRetry === true;
            if ((status === 401 || status === 403) && !liveTextEmitted) {
                process.stderr.write(`[openai-oauth-ws] ${status} — forcing refresh and retrying once over WS\n`);
                if (process.env.MIXDOG_DEBUG_BRIDGE) { process.stderr.write(`[bridge-trace] provider-${status}-retry attempt=1\n`); }
                this._refreshFallbackUntil = 0;
                auth = await this.ensureAuth({ forceRefresh: true, reason: String(status) });
                try {
                    const result = await dispatchWs(true);
                    if (process.env.MIXDOG_DEBUG_BRIDGE) { process.stderr.write(`[bridge-trace] provider-send-end elapsed=${Date.now() - _t1}ms result=ok\n`); }
                    return recordLiveModel(result);
                } catch (retryErr) {
                    if (_shouldUseOpenAIHttpFallback(retryErr, externalSignal)) {
                        try {
                            return await dispatchHttp(retryErr?.retryClassifier || retryErr?.code || retryErr?.message || 'ws_auth_retry_failed', retryErr);
                        } catch (fallbackErr) {
                            try { retryErr.fallbackError = fallbackErr; } catch {}
                            throw retryErr;
                        }
                    }
                    throw retryErr;
                }
            }
            // Auth failure after live text already emitted: never reissue.
            if ((status === 401 || status === 403) && liveTextEmitted) {
                throw err;
            }
            const msg = err?.message || '';
            const isUnknownModel = status === 404
                || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(msg);
            if (isUnknownModel && !opts._modelRetry) {
                process.stderr.write(`[openai-oauth-ws] unknown model — refreshing catalog + 1 retry\n`);
                await this._refreshModelCache();
                return this.send(messages, model, tools, { ...opts, _modelRetry: true });
            }
            if (_shouldUseOpenAIHttpFallback(err, externalSignal)) {
                try {
                    return await dispatchHttp(err?.retryClassifier || err?.midstreamClassifier || err?.code || err?.message || 'ws_failed', err);
                } catch (fallbackErr) {
                    try { err.fallbackError = fallbackErr; } catch {}
                    throw err;
                }
            }
            throw err;
        }
    }
    async listModels() {
        // Dynamic lookup via Codex /backend-api/codex/models. Cached 24h.
        // Endpoint returns rich metadata (context_window, reasoning levels,
        // visibility) that is more detailed than /v1/models.
        const cached = await _loadCodexModelCache();
        if (cached) {
            _lastCodexListModelsError = '';
            _inMemoryCodexCatalog = cached.slice();
            return cached;
        }
        try {
            const auth = await this.ensureAuth();
            const clientVersion = await _resolveCodexClientVersion();
            const url = `https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion}`;
            const res = await fetch(url, {
                signal: AbortSignal.timeout(10_000),
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${auth.access_token}`,
                    'OpenAI-Beta': 'responses=experimental',
                    'originator': 'codex_cli_rs',
                    'chatgpt-account-id': auth.account_id || '',
                },
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) throw new Error(`codex list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.models) ? data.models : [];
            const normalized = items.map(m => _normalizeCodexModel(m));
            _markLatestCodex(normalized);
            const enriched = await enrichModels(normalized);
            await _saveCodexModelCache(enriched);
            _lastCodexListModelsError = '';
            return enriched;
        } catch (err) {
            _lastCodexListModelsError = err?.message || String(err);
            process.stderr.write(`[openai-oauth] listModels fetch failed (${_lastCodexListModelsError})\n`);
            // No fallback catalog — empty list signals the UI to show a
            // "catalog unavailable, retry" state. Codex has no equivalent to
            // Anthropic's family tokens so there's no meaningful minimal list.
            return [];
        }
    }
    // Force a catalog refresh (ignores 24h TTL). De-duped via
    // _codexRefreshInFlight so concurrent callers share one HTTP round-trip.
    async _refreshModelCache() {
        if (_codexRefreshInFlight) return _codexRefreshInFlight;
        _codexRefreshInFlight = (async () => {
            try {
                const auth = await this.ensureAuth();
                const clientVersion = await _resolveCodexClientVersion();
                const url = `https://chatgpt.com/backend-api/codex/models?client_version=${clientVersion}`;
                const res = await fetch(url, {
                    signal: AbortSignal.timeout(10_000),
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${auth.access_token}`,
                        'OpenAI-Beta': 'responses=experimental',
                        'originator': 'codex_cli_rs',
                        'chatgpt-account-id': auth.account_id || '',
                    },
                    dispatcher: getLlmDispatcher(),
                });
                if (!res.ok) throw new Error(`codex list_models ${res.status}`);
                const data = await res.json();
                const items = Array.isArray(data?.models) ? data.models : [];
                const normalized = items.map(m => _normalizeCodexModel(m));
                _markLatestCodex(normalized);
                const enriched = await enrichModels(normalized);
                await _saveCodexModelCache(enriched);
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[openai-oauth] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[openai-oauth] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _codexRefreshInFlight = null;
            }
        })();
        return _codexRefreshInFlight;
    }

    async isAvailable() {
        return this.tokens !== null;
    }
}

const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;

function generatePKCE() {
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

export async function loginOAuth() {
    const pkce = generatePKCE();
    const state = randomBytes(16).toString('hex');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('originator', CODEX_OAUTH_ORIGINATOR);
    process.stderr.write(`\n[openai-oauth] Open this URL to log in to ChatGPT (Codex):\n${url.toString()}\n\n`);
        const { openInBrowser } = await import('../../../shared/open-url.mjs');
        openInBrowser(url.toString());

    return new Promise((resolve) => {
        const timeout = setTimeout(() => { server.close(); resolve(null); }, LOGIN_TIMEOUT_MS);
        const server = createServer(async (req, res) => {
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
                clearTimeout(timeout);
                server.close();
                resolve(null);
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h2>Codex login successful! You can close this tab.</h2></body></html>');
            clearTimeout(timeout);
            server.close();
            try {
                const tokenRes = await fetch(TOKEN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        code,
                        redirect_uri: REDIRECT_URI,
                        client_id: CLIENT_ID,
                        code_verifier: pkce.verifier,
                    }),
                    redirect: 'error',
                    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
                });
                if (!tokenRes.ok) { resolve(null); return; }
                const json = await tokenRes.json();
                if (!json.access_token || !json.refresh_token) { resolve(null); return; }
                const expiresAt = (typeof json.expires_in === 'number'
                    ? Date.now() + json.expires_in * 1000
                    : 0) || _expiryFromAccessToken(json.access_token);
                const tokens = {
                    access_token: json.access_token,
                    refresh_token: json.refresh_token,
                    expires_at: expiresAt,
                    account_id: extractAccountId(json.access_token),
                };
                saveTokens(tokens);
                resolve(tokens);
            } catch {
                resolve(null);
            }
        });
        server.listen(CALLBACK_PORT, CALLBACK_HOST);
        server.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
}
