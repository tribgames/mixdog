/**
 * Anthropic OAuth provider — uses Mixdog-owned local OAuth credentials
 * for Claude Max subscription access.
 *
 * Raw HTTP + SSE streaming, reuses message/tool conversion patterns
 * from anthropic.mjs. agent-trace instrumented.
 */
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import {
    traceAgentFetch,
    traceAgentSse,
    traceAgentUsage,
} from '../agent-trace.mjs';
import { createAbortController } from '../../../shared/abort-controller.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { enrichModels } from './model-catalog.mjs';
import { makeModelCache } from './model-cache.mjs';
import { sanitizeToolPairs, sanitizeAnthropicContentPairs } from '../session/context-utils.mjs';
import {
    PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
    PROVIDER_RETRY_BACKOFF_MS,
    PROVIDER_RETRY_MAX_ATTEMPTS,
    PROVIDER_SSE_IDLE_TIMEOUT_MS,
    PROVIDER_SSE_IDLE_WATCHDOG_ENABLED,
    createPassthroughSignal,
} from '../stall-policy.mjs';
import {
    classifyError,
    classifyMidstreamError,
    midstreamBackoffFor,
    MIDSTREAM_RETRY_POLICY,
    retryAfterMsFromError,
    sleepWithAbort,
    withRetry,
} from './retry-classifier.mjs';
import { buildAnthropicBetaHeaders, supportsAnthropicFastMode } from './anthropic-betas.mjs';
import { getLlmDispatcher, preconnect } from '../../../shared/llm/http-agent.mjs';
import { normalizeContentForAnthropic } from './media-normalization.mjs';
import { makeInvalidToolArgsMarker } from './openai-compat-stream.mjs';

// --- Model catalog cache helpers ---
// Disk-backed cache so repeated process starts (cron, tool calls) don't
// hammer /v1/models. 24h TTL matches the upstream client cadence.
const MODEL_CACHE_TTL_MS = 24 * 60 * 60_000;
// SSE progress emits (per-request "Response …" and "Done:" lines). Off by default.
const SSE_VERBOSE = process.env.MIXDOG_SSE_VERBOSE === '1';

/** Bounded mid-stream SSE retries (transient stream loss); shared with anthropic.mjs.
 *  Sourced from the single shared retry-budget table (MIDSTREAM_RETRY_POLICY.sse). */
export const ANTHROPIC_MAX_MIDSTREAM_RETRIES = MIDSTREAM_RETRY_POLICY.sse.defaultRetries;

// Policy passed to the shared classifyMidstreamError for the SSE path. The
// top-of-function attempt-budget gate uses defaultRetries (3); perClassifierGate
// is false so the classifier returns raw bucket strings (the loop owns the
// MAX_MIDSTREAM_RETRIES bound), matching the former _classifyMidstreamError.
const SSE_MIDSTREAM_POLICY = {
    mode: 'sse',
    defaultRetries: MIDSTREAM_RETRY_POLICY.sse.defaultRetries,
    perClassifierGate: false,
};

function formatRetryAfter(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n >= 60_000 && n % 60_000 === 0) return `${Math.round(n / 60_000)}m`;
    if (n >= 1000) return `${Math.ceil(n / 1000)}s`;
    return `${Math.ceil(n)}ms`;
}

function anthropicQuotaError(status, headers, bodyText = '') {
    const retryAfterMs = retryAfterMsFromError({ headers, response: { headers } });
    const retryAfter = formatRetryAfter(retryAfterMs);
    const detail = bodyText ? `: ${String(bodyText).slice(0, 200)}` : '';
    const retry = retryAfter ? ` retryAfter=${retryAfter}` : '';
    const err = new Error(`Anthropic OAuth API ${status} quota/rate limit${retry}${detail}`);
    err.name = 'ProviderQuotaError';
    err.code = 'PROVIDER_QUOTA';
    err.httpStatus = status;
    err.status = status;
    err.headers = headers;
    err.response = { status, headers };
    err.retryAfterMs = retryAfterMs;
    err.providerQuota = true;
    err.quotaExceeded = true;
    err.unsafeToRetry = true;
    return err;
}

const _modelCache = makeModelCache({
    fileName: 'anthropic-oauth-models.json',
    ttlMs: MODEL_CACHE_TTL_MS,
    onSave: (m) => { _inMemoryCatalog = Array.isArray(m) ? m.slice() : null; },
});

// Async wrappers so callers can keep awaiting; the shared cache CRUD is sync.
async function _loadModelCache() {
    return _modelCache.loadSync();
}

async function _saveModelCache(models) {
    _modelCache.save(models);
}

// In-memory mirror of the disk catalog — populated on first listModels() and
// refreshed after every _saveModelCache. Used by _catalogHas and _displayModel
// so hot paths don't hit disk on every response.
let _inMemoryCatalog = null;
let _modelRefreshInFlight = null;
let _oauthRefreshInFlight = null;
// No in-memory credential cache: the canonical credentials file is the
// single source of truth. Cross-process refresh_token rotation by another
// concurrent reader would invalidate any cached copy here and produce
// invalid_grant on the next refresh. Reading from
// disk on demand is cheap (one stat + one small JSON parse) and removes
// the cache-vs-disk skew entirely.


function _catalogHas(id) {
    if (!id || !Array.isArray(_inMemoryCatalog)) return false;
    return _inMemoryCatalog.some(m => m.id === id);
}

// Display-name normalization for trace / usage. Turns dated or version-alias
// ids into the version alias form: claude-opus-4-7 → claude-opus-4.7,
// claude-haiku-4-5-20251001 → claude-haiku-4.5. Falls back to the raw id.
function _displayModel(id) {
    if (!id || typeof id !== 'string') return id;
    const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/i);
    if (!m) return id;
    return `claude-${m[1].toLowerCase()}-${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

// Classify a model id into our common tier/family shape. Anthropic's catalog
// mixes dated ids (claude-opus-4-5-20251101), versioned aliases
// (claude-opus-4-6), and the raw family tokens resolved via env vars.
function _normalizeAnthropicModel(raw) {
    const id = raw?.id || raw?.name;
    if (!id) return null;
    const familyMatch = id.match(/^claude-([a-z]+)/i);
    const family = familyMatch ? familyMatch[1].toLowerCase() : 'other';
    // Dated: trailing -YYYYMMDD (8 digits).
    const dated = /-\d{8}$/.test(id);
    // Versioned alias: claude-<family>-<major>-<minor>[-...] with no dated suffix.
    const versioned = !dated && /^claude-[a-z]+-\d+(?:-\d+)?$/i.test(id);
    const tier = dated ? 'dated' : versioned ? 'version' : 'family';
    const releaseDate = dated
        ? id.match(/-(\d{4})(\d{2})(\d{2})$/)
        : null;
    return {
        id,
        display: raw?.display_name || _prettyName(id, family),
        family,
        provider: 'anthropic-oauth',
        contextWindow: raw?.context_window || raw?.max_context_window || _defaultContextForModel(id, family),
        tier,
        latest: false, // assigned in a second pass once full list is known
        releaseDate: releaseDate ? `${releaseDate[1]}-${releaseDate[2]}-${releaseDate[3]}` : null,
    };
}

function _prettyName(id, family) {
    const v = id.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i);
    const base = family[0].toUpperCase() + family.slice(1);
    return v ? `${base} ${v[1]}${v[2] ? `.${v[2]}` : ''}` : base;
}

function _defaultContextForModel(id, family) {
    const text = String(id || '');
    const version = text.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i);
    if (Number(version?.[1] || 0) >= 5) return 1000000;
    if (/^claude-(opus|sonnet)-4-(6|7|8)(?:$|-)/i.test(text)) return 1000000;
    if (family && family !== 'other') return 200000;
    return 200000;
}

// Mark the highest-numbered version per family as `latest: true`. Uses a simple
// lexicographic comparison on the numeric parts embedded in the id.
function _markLatestByFamily(models) {
    const byFamily = new Map();
    for (const m of models) {
        if (m.tier !== 'version') continue;
        const cur = byFamily.get(m.family);
        if (!cur || _compareVersion(m.id, cur.id) > 0) {
            byFamily.set(m.family, m);
        }
    }
    for (const m of byFamily.values()) m.latest = true;
}

function _compareVersion(a, b) {
    const na = (a.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i) || []).slice(1).map(Number);
    const nb = (b.match(/^claude-[a-z]+-(\d+)(?:-(\d+))?/i) || []).slice(1).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    }
    return a.localeCompare(b);
}

// Newest HIGH-TIER chat model by version, read from the SYNC in-memory catalog
// mirror. Symmetric with resolveLatestGrokModel / resolveLatestCodexModel.
// Anthropic ships three families: opus / sonnet / haiku. "Latest" is the
// highest version across opus + sonnet only — haiku is the cheap tier and is
// never the flagship default. Returns null until listModels() populates the
// mirror; callers must warm the catalog (ensureLatestAnthropicModel) when null.
export function resolveLatestAnthropicModel() {
    if (!Array.isArray(_inMemoryCatalog)) return null;
    let best = null;
    for (const m of _inMemoryCatalog) {
        if (!m?.id || (m.family !== 'opus' && m.family !== 'sonnet')) continue;
        if (!best || _compareVersion(m.id, best.id) > 0) best = m;
    }
    return best?.id || null;
}

function resolveAnthropicModelAfter404(requested) {
    if (!Array.isArray(_inMemoryCatalog)) return null;
    const wanted = String(requested || '');
    const family = (wanted.match(/^claude-([a-z]+)/i) || [])[1]?.toLowerCase() || null;
    let best = null;
    for (const m of _inMemoryCatalog) {
        if (!m?.id) continue;
        if (family && m.family !== family) continue;
        if (!family && m.family !== 'opus' && m.family !== 'sonnet') continue;
        if (!best || _compareVersion(m.id, best.id) > 0) best = m;
    }
    if (best?.id && best.id !== wanted) return best.id;
    if (family === 'opus') {
        const flagship = resolveLatestAnthropicModel();
        if (flagship && flagship !== wanted) return flagship;
    }
    return null;
}

export async function ensureLatestAnthropicModel(provider) {
    let m = resolveLatestAnthropicModel();
    if (m) return m;
    await provider._refreshModelCache();
    m = resolveLatestAnthropicModel();
    if (m) return m;
    throw new Error('[anthropic-oauth] model catalog unavailable after warmup — cannot resolve default model');
}

const API_URL = 'https://api.anthropic.com/v1/messages';
// SSRF guard for the OAuth token endpoint override. Env-supplied URLs must be
// https with a valid http(s) URL shape; reject file:/data:/ftp:/etc. and any
// http override so a hostile env cannot redirect refresh-token requests.
function assertSafeTokenURL(rawURL) {
    let parsed;
    try {
        parsed = new URL(String(rawURL));
    } catch {
        throw new Error(`[anthropic-oauth] invalid ANTHROPIC_OAUTH_TOKEN_URL: ${rawURL}`);
    }
    if (parsed.protocol.toLowerCase() !== 'https:') {
        throw new Error(`[anthropic-oauth] ANTHROPIC_OAUTH_TOKEN_URL must use https (got ${parsed.protocol})`);
    }
    return rawURL;
}
const TOKEN_URL = assertSafeTokenURL(process.env.ANTHROPIC_OAUTH_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token');
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_CREDENTIALS_PATH = join(resolvePluginData(), 'anthropic-oauth-credentials.json');
const CLAUDE_CODE_CLIENT_ID = process.env.ANTHROPIC_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
const CLAUDE_AI_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const ALL_OAUTH_SCOPES = [
    'org:create_api_key',
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
];
const OAUTH_LOGIN_SCOPE = ALL_OAUTH_SCOPES.join(' ');
const OAUTH_CALLBACK_HOST = 'localhost';
const OAUTH_CALLBACK_PORT = 54545;
const OAUTH_CALLBACK_PATH = '/callback';
const OAUTH_REDIRECT_URI = `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
const OAUTH_MANUAL_REDIRECT_URI = process.env.ANTHROPIC_OAUTH_MANUAL_REDIRECT_URI || 'https://platform.claude.com/oauth/code/callback';
const OAUTH_SUCCESS_REDIRECT_URL = process.env.ANTHROPIC_OAUTH_SUCCESS_REDIRECT_URL || 'https://platform.claude.com/oauth/code/success?app=claude-code';
const OAUTH_LOGIN_TIMEOUT_MS = 5 * 60_000;
const OAUTH_TOKEN_TIMEOUT_MS = 30_000;

// Anthropic OAuth contract for first-party OAuth clients.
// Opus/Sonnet requests are gated on a specific system-prompt prefix.
// Mixdog keeps that upstream client contract for OAuth routing. Haiku is not
// gated and ignores this prefix.
const CLAUDE_CODE_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADERS = 'oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,extended-cache-ttl-2025-04-11,advanced-tool-use-2025-11-20';
const DEFAULT_CLI_VERSION = '2.1.77';

function resolveCliVersion() {
    return process.env.MIXDOG_CLI_VERSION
        || DEFAULT_CLI_VERSION;
}

function requiresSystemPrefix(model) {
    // Opus / Sonnet require the OAuth system prefix when authenticated
    // via OAuth. Haiku does not.
    return /^claude-(opus|sonnet)/i.test(String(model || ''));
}

// OAuth rate-limit pool routing is gated by the server inspecting the first
// system block. When it reads exactly the OAuth system prefix string it routes
// into the first-party OAuth pool; any other
// content (even the prefix concatenated with extra text in the same block)
// falls into the standard pool and Opus/Sonnet return 429. Splitting into
// two blocks — [prefix, rest] — keeps both routing and user instructions.
function buildSystemBlocks(systemMsgs, model, systemTtl, tier3Ttl) {
    // systemMsgs is an array of { content, cacheTier } — each non-empty element
    // becomes its own Anthropic content block with its own cache_control
    // breakpoint. Blocks tagged cacheTier:'tier3' (BP3 sessionMarker) take the
    // tier3 TTL; every other block (BP1 baseRules / BP2 stableSystem) takes the
    // system TTL. Invariant: callers must pass an array.
    const items = Array.isArray(systemMsgs)
        ? systemMsgs
            .map(m => ({
                text: typeof m?.content === 'string' ? m.content.trim() : '',
                tier: m?.cacheTier === 'tier3' ? 'tier3' : 'system',
            }))
            .filter(it => it.text)
        : [];
    const gated = requiresSystemPrefix(model);

    const blocks = [];
    if (gated) {
        blocks.push({ type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX });
    }
    for (let i = 0; i < items.length; i++) {
        let body = items[i].text;
        // Strip a duplicated OAuth system prefix from the first block if present.
        if (gated && i === 0 && body.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) {
            body = body.slice(CLAUDE_CODE_SYSTEM_PREFIX.length).trim();
            if (!body) continue;
        }
        blocks.push({ type: 'text', text: body, _tier: items[i].tier });
    }
    // Apply per-tier cache_control. BP1/BP2 -> systemTtl, BP3 -> tier3Ttl. The
    // gating prefix block is never cached (Anthropic routes on its exact bytes).
    // tier3Ttl === null leaves the 3rd block uncached (e.g. maintenance roles).
    for (const b of blocks) {
        const tier = b._tier;
        delete b._tier;
        if (b.text === CLAUDE_CODE_SYSTEM_PREFIX) continue;
        const ttl = tier === 'tier3' ? tier3Ttl : systemTtl;
        if (ttl) b.cache_control = ttl;
    }
    return blocks;
}

// Per-model max_tokens when the model id is explicitly listed. New models
// (e.g., Sonnet 4.7) won't match a specific entry and fall through to the
// family-based heuristic below. Conservative defaults — model may support
// more but we'd rather stay within safe bounds.
const MAX_TOKENS = {
    'claude-opus-4-8': 65536,
    'claude-opus-4-7': 65536,
    'claude-opus-4-6': 65536,
    'claude-sonnet-4-6': 16384,
    'claude-haiku-4-5-20251001': 8192,
};

function resolveMaxTokens(model) {
    if (MAX_TOKENS[model]) return MAX_TOKENS[model];
    const id = String(model || '').toLowerCase();
    if (id.includes('opus')) return 65536;
    if (id.includes('sonnet')) return 16384;
    if (id.includes('haiku')) return 8192;
    return 8192;
}

const EFFORT_BUDGET = {
    low: 1024,
    medium: 4096,
    high: 16384,
    xhigh: 32768,
    max: 32768,
};

const MIN_THINKING_BUDGET = 1024;
const THINKING_OUTPUT_RESERVE = 1024;

function clampThinkingBudgetTokens(value, maxTokens) {
    const desired = Math.floor(Number(value));
    const max = Math.floor(Number(maxTokens));
    if (!Number.isFinite(desired) || desired <= 0 || !Number.isFinite(max)) return null;
    const ceiling = max - THINKING_OUTPUT_RESERVE;
    if (ceiling < MIN_THINKING_BUDGET) return null;
    return Math.max(MIN_THINKING_BUDGET, Math.min(desired, ceiling));
}

// Tracks which unknown effort labels we've already logged so a repeated
// session-level misconfig doesn't flood stderr with the same warning.
const _LOGGED_UNKNOWN_EFFORT = new Set();

// Layered cache TTLs — stable layers get 1h, volatile layers get 5m.
// Anthropic requires 1h entries to appear before 5m entries in the request.
const CACHE_TTL_STABLE = { type: 'ephemeral', ttl: '1h' };   // tools, system, tier3, messages
const CACHE_TTL_VOLATILE = { type: 'ephemeral' };             // explicit 5m override

// --- Credential helpers ---

function _pushUnique(list, value) {
    if (!value || typeof value !== 'string') return;
    if (!list.includes(value)) list.push(value);
}

function credentialCandidates() {
    const paths = [];
    _pushUnique(paths, process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH);
    _pushUnique(paths, DEFAULT_CREDENTIALS_PATH);
    return paths;
}

// Fallback expiry from the access_token's JWT `exp` claim (epoch ms) when the
// credentials file carries no explicit expiresAt — without it expiresAt stays 0,
// which ensureAuth reads as "never expires", disabling proactive refresh. Claude
// OAuth tokens are opaque so this returns 0 and the file's expiresAt governs; kept
// for parity with the other OAuth providers. JWT `exp` is epoch SECONDS (RFC 7519).
function _expiryFromAccessToken(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return 0;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        const exp = Number(payload?.exp);
        return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
    } catch { return 0; }
}

function _loadCredentialsFile(path) {
    if (!existsSync(path)) return null;
    try {
        const stat = statSync(path);
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        const oauth = raw?.claudeAiOauth;
        if (!oauth?.accessToken) return null;
        return {
            path,
            mtimeMs: stat.mtimeMs,
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken || null,
            expiresAt: _normalizeExpiresAt(oauth.expiresAt ?? oauth.expires_at) || _expiryFromAccessToken(oauth.accessToken),
            scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
            subscriptionType: oauth.subscriptionType || null,
        };
    } catch {
        return null;
    }
}

// Cross-process safe credential save. Lockfile (O_EXCL) prevents two Mixdog
// refreshers from clobbering each other; atomic rename guarantees readers see
// either the old or new file, never a half-written one. Used so refresh_token
// rotation propagates to other Mixdog readers of the same credentials file
// instead of leaving them stuck on the previous refresh_token.
function _saveCredentialsFile(path, raw) {
    // Secret file, not parent-dir ACL mutation. `secret: true` clamps the file
    // itself on Windows; it deliberately leaves the data dir inheritance alone.
    writeJsonAtomicSync(path, raw, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}

// Cheap stat-only probe so ensureAuth can detect Mixdog-updated credentials
// without paying a full JSON read every call.
function _credentialsMaxMtime() {
    let max = 0;
    for (const p of credentialCandidates()) {
        try {
            const s = statSync(p);
            if (s.mtimeMs > max) max = s.mtimeMs;
        } catch { /* not present — skip */ }
    }
    return max;
}

function loadCredentials() {
    const loaded = credentialCandidates()
        .map(_loadCredentialsFile)
        .filter(Boolean);
    if (!loaded.length) return null;
    loaded.sort((a, b) => (Number(b.expiresAt) || 0) - (Number(a.expiresAt) || 0));
    return loaded[0];
}

// Public predicate used by config.buildDefaultConfig — provider is enabled
// when on-disk credentials exist AND carry the inference scope. Single
// truth: same loader the runtime uses, no parallel hard-coded path probe.
export function hasAnthropicOAuthCredentials() {
    const creds = loadCredentials();
    if (!creds?.accessToken) return false;
    return Array.isArray(creds.scopes) && creds.scopes.includes('user:inference');
}

export function describeAnthropicOAuthCredentials() {
    try {
        const creds = loadCredentials();
        if (!creds?.accessToken) {
            return { authenticated: false, status: 'Not Set', detail: 'Mixdog OAuth credentials' };
        }
        const hasInferenceScope = Array.isArray(creds.scopes) && creds.scopes.includes('user:inference');
        const hasRefresh = Boolean(creds.refreshToken);
        const expiresAt = _normalizeExpiresAt(creds.expiresAt);
        const expiring = expiresAt > 0 && expiresAt < Date.now() + TOKEN_REFRESH_SKEW_MS;
        const expired = expiresAt > 0 && expiresAt <= Date.now();
        const detail = creds.path || DEFAULT_CREDENTIALS_PATH;
        if (!hasInferenceScope) {
            return { authenticated: false, status: 'Missing Scope', detail, expiresAt };
        }
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

export function forgetAnthropicOAuthCredentials() {
    let removed = false;
    for (const path of credentialCandidates()) {
        if (!existsSync(path)) continue;
        try {
            const raw = JSON.parse(readFileSync(path, 'utf-8'));
            if (raw?.claudeAiOauth) {
                delete raw.claudeAiOauth;
                _saveCredentialsFile(path, raw);
                removed = true;
            }
        } catch (err) {
            throw new Error(`Anthropic OAuth reset failed for ${path}: ${err?.message || err}`);
        }
    }
    return { removed };
}

function _normalizeExpiresAt(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
    return value < 1e12 ? value * 1000 : value;
}

function _scrubTokens(text) {
    return String(text || '')
        .replace(/Bearer [A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
        .replace(/sk-ant-[A-Za-z0-9._\-]+/g, '[REDACTED]')
        .replace(/"access[Tt]oken"\s*:\s*"[^"]+"/g, '"accessToken":"[REDACTED]"')
        .replace(/"refresh[Tt]oken"\s*:\s*"[^"]+"/g, '"refreshToken":"[REDACTED]"')
        .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"')
        .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[REDACTED]"');
}

async function refreshOAuthCredentials(creds) {
    if (!creds?.refreshToken) {
        throw new Error('Anthropic OAuth refresh token not available. Open /providers in mixdog to sign in again.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'anthropic-dangerous-direct-browser-access': 'true',
                'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
            },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: creds.refreshToken,
                client_id: CLAUDE_CODE_CLIENT_ID,
            }),
            // Never follow a redirect on a secret-bearing request: a token
            // endpoint that 307/308-redirects would replay the refresh_token to
            // the redirect target. Fail loud instead.
            redirect: 'error',
            signal: controller.signal,
            dispatcher: getLlmDispatcher(),
        });

        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* handled below */ }
        if (!res.ok) {
            const isInvalidGrant = text.includes('invalid_grant') || json?.error === 'invalid_grant';
            throw Object.assign(new Error(`token refresh ${res.status}: ${_scrubTokens(text).slice(0, 200)}`), { isInvalidGrant });
        }

        const accessToken = json?.access_token || json?.accessToken;
        if (!accessToken) throw new Error('token refresh returned no access token');
        const expiresAt = _normalizeExpiresAt(json?.expires_at ?? json?.expiresAt)
            || (typeof json?.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0);
        const refreshed = {
            path: creds.path,
            accessToken,
            refreshToken: json?.refresh_token || json?.refreshToken || creds.refreshToken,
            expiresAt,
            scopes: Array.isArray(json?.scope) ? json.scope : creds.scopes,
            subscriptionType: creds.subscriptionType,
        };
        // Persist rotated tokens back so any other Mixdog reader of the same
        // credentials file picks up the new refresh_token. Without this, a
        // later process can replay an old single-use refresh token and loop on
        // invalid_grant.
        if (creds.path && existsSync(creds.path)) {
            try {
                const raw = JSON.parse(readFileSync(creds.path, 'utf-8'));
                raw.claudeAiOauth = {
                    ...(raw.claudeAiOauth || {}),
                    accessToken: refreshed.accessToken,
                    refreshToken: refreshed.refreshToken,
                    expiresAt: refreshed.expiresAt,
                    scopes: refreshed.scopes,
                };
                _saveCredentialsFile(creds.path, raw);
            } catch (err) {
                process.stderr.write(`[anthropic-oauth] credential save failed: ${_scrubTokens(err?.message || String(err)).slice(0, 200)}\n`);
                throw new Error(`[oauth] credentials save failed: ${err?.message ?? String(err)}`);
            }
        }
        return refreshed;
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error('Anthropic OAuth token refresh timed out after 30000ms');
        }
        throw err;
    } finally {
        clearTimeout(timeout);
    }
}

// Exported so callers can detect re-auth-required scenarios and prompt the user.
export class ReauthRequired extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReauthRequired';
    }
}

// --- Message conversion (mirrors anthropic.mjs) ---

function withCacheControl(block, ttl = CACHE_TTL_VOLATILE) {
    if (!block || typeof block !== 'object' || block.cache_control) return block;
    return { ...block, cache_control: ttl };
}

function appendCacheControl(content, ttl = CACHE_TTL_VOLATILE) {
    if (Array.isArray(content)) {
        if (content.length === 0) return content;
        const next = [...content];
        next[next.length - 1] = withCacheControl(next[next.length - 1], ttl);
        return next;
    }
    if (typeof content === 'string') {
        return [withCacheControl({ type: 'text', text: content }, ttl)];
    }
    return content;
}

// Anthropic's tool spec forbids oneOf / allOf / anyOf at the TOP level of
// input_schema (nested usage inside properties is allowed). External MCP
// servers sometimes emit such schemas.
// Convert them to a flat object schema so the API never sees a 400.
function _sanitizeInputSchema(schema, toolName) {
    if (!schema || typeof schema !== 'object') {
        return { type: 'object', properties: {} };
    }
    const compound = schema.oneOf || schema.anyOf || schema.allOf;
    if (!compound) return structuredClone(schema);
    // Merge all branch properties into one permissive object schema.
    // None of the branches' required lists are hoisted — callers that relied
    // on discriminated-union semantics will still function; the model simply
    // receives a union of the property surface with no hard-required constraint.
    const mergedProps = {};
    const branchDescs = [];
    for (const branch of Array.isArray(compound) ? compound : []) {
        if (branch && typeof branch === 'object' && branch.properties) {
            Object.assign(mergedProps, branch.properties);
        }
        if (branch && typeof branch === 'object') {
            const parts = [];
            if (branch.description) parts.push(branch.description);
            else if (branch.type) parts.push(`type:${branch.type}`);
            if (parts.length) branchDescs.push(parts.join(' '));
        }
    }
    const compoundKey = schema.oneOf ? 'oneOf' : schema.anyOf ? 'anyOf' : 'allOf';
    let description = schema.description || '';
    if (branchDescs.length) {
        const parts = [];
        let used = 0;
        for (let i = 0; i < branchDescs.length; i++) {
            const v = `(variant ${i + 1}: ${branchDescs[i]})`;
            if (used + v.length + (parts.length ? 1 : 0) > 500) break;
            parts.push(v);
            used += v.length + (parts.length > 1 ? 1 : 0);
        }
        const addition = parts.join(' ');
        if (addition) description = description ? `${description} ${addition}` : addition;
    }
    const mergedPropsCount = Object.keys(mergedProps).length;
    if (process.env.MIXDOG_DEBUG_SESSION_LOG) {
        process.stderr.write(
            `[anthropic-oauth-sanitizer] tool="${toolName ?? ''}" compound="${compoundKey}" branches=${Array.isArray(compound) ? compound.length : 0} mergedProps=${mergedPropsCount}\n`
        );
    }
    return {
        type: 'object',
        ...(description ? { description } : {}),
        properties: mergedProps,
    };
}

function toAnthropicTools(tools) {
    return tools.map(t => {
        const out = {
            name: t.name,
            description: t.description,
            input_schema: _sanitizeInputSchema(t.inputSchema, t.name),
        };
        if (t.deferLoading === true || t.defer_loading === true) out.defer_loading = true;
        return out;
    });
}
function nativeAnthropicTools(opts) {
    return Array.isArray(opts?.nativeTools)
        ? opts.nativeTools.filter(t => t && typeof t === 'object')
        : [];
}
function deferredAnthropicTools(activeTools, opts) {
    if (opts?.session?.deferredNativeTools !== true) return [];
    const active = new Set((activeTools || []).map((tool) => String(tool?.name || '').trim()).filter(Boolean));
    const catalog = Array.isArray(opts.session.deferredToolCatalog) ? opts.session.deferredToolCatalog : [];
    return catalog
        .filter((tool) => tool?.name && !active.has(String(tool.name)))
        .map((tool) => ({ ...tool, deferLoading: true }));
}

function toAnthropicMessages(messages) {
    // Marker-free lowering. cache_control is applied AFTER sanitization by
    // applyAnthropicCacheMarkers() so that block drops/inserts/reorders
    // performed by sanitizeAnthropicContentPairs cannot move or delete a
    // marked block (the root cause of the sporadic COLD-turn cache miss:
    // pre-sanitize markers landed on blocks the sanitizer then rewrote, so
    // the provider-visible breakpoint diverged from the cached one).
    const result = [];
    for (let idx = 0; idx < messages.length; idx++) {
        const m = messages[idx];
        if (m.role === 'system') continue;

        if (m.role === 'assistant' && (m.toolCalls?.length || m.assistantBlocks?.length)) {
            let content;
            if (m.assistantBlocks?.length) {
                content = m.assistantBlocks.slice();
            } else {
                content = [];
                if (m.content) content.push({ type: 'text', text: m.content });
                for (const tc of m.toolCalls) {
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.name,
                        input: tc.arguments,
                    });
                }
            }
            result.push({ role: 'assistant', content });
            continue;
        }

        if (m.role === 'tool') {
            const last = result[result.length - 1];
            const refs = Array.isArray(m.nativeToolSearch?.toolReferences)
                ? m.nativeToolSearch.toolReferences.map((name) => String(name || '').trim()).filter(Boolean)
                : [];
            const block = {
                type: 'tool_result',
                tool_use_id: m.toolCallId || '',
                content: refs.length
                    ? refs.map((name) => ({ type: 'tool_reference', tool_name: name }))
                    : normalizeContentForAnthropic(m.content),
            };
            if (last?.role === 'user' && Array.isArray(last.content)) {
                last.content.push(block);
            } else {
                result.push({ role: 'user', content: [block] });
            }
            continue;
        }

        result.push({ role: m.role, content: normalizeContentForAnthropic(m.content) });
    }
    return sanitizeAnthropicContentPairs(result);
}

// Applies cache_control markers to the FINAL, already-sanitized Anthropic
// message array — by INVARIANT, never by pre-sanitize index. Because
// sanitizeAnthropicContentPairs has already run (and must NOT run again
// after this), the blocks we mark here are exactly the blocks the provider
// sees, so the cache breakpoint is stable across turns.
//   message-anchor: prefer a safe tool_result tail, then a previous real user
//                   text turn if another slot remains. Synthetic
//                   <system-reminder> messages and current pure-text prompts
//                   are excluded so first-turn prompts do not create a fresh
//                   BP4 write on every new session.
// messageTtl === null disables the tail. BP3 (tier3) now rides a system block,
// so it is no longer marked here.
// ANTHROPIC_MSG_SLOTS=0 is honoured upstream by passing messageTtl = null.
function applyAnthropicCacheMarkers(sanitizedMessages, { messageTtl = CACHE_TTL_VOLATILE, messageSlots = 1 } = {}) {
    if (!Array.isArray(sanitizedMessages) || sanitizedMessages.length === 0) {
        return sanitizedMessages;
    }

    const firstText = (content) => {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            const first = content.find((b) => b?.type === 'text');
            return first && typeof first.text === 'string' ? first.text : '';
        }
        return '';
    };
    const isSystemReminder = (content) => firstText(content).startsWith('<system-reminder>');

    const markLast = (msg, ttl) => {
        if (!msg) return;
        msg.content = appendCacheControl(msg.content, ttl);
    };
    const ttlRank = (ttl) => ttl?.ttl === '1h' ? 2 : 1;
    const canMarkMessageIdx = (idx) => {
        // System-reminder messages (volatileTail / roleSpecific BP4) vary
        // per-call, so never pin them with a 1h marker. The 1h system blocks
        // (BP1/BP2/BP3) already satisfy Anthropic's "1h before 5m" ordering.
        if (idx < 0) return false;
        const msg = sanitizedMessages[idx];
        if (ttlRank(messageTtl) > ttlRank(CACHE_TTL_VOLATILE)
            && isSystemReminder(msg?.content)) {
            return false;
        }
        return true;
    };
    const hasUserText = (msg) => {
        if (msg?.role !== 'user') return false;
        if (isSystemReminder(msg.content)) return false;
        if (typeof msg.content === 'string') return msg.content.trim().length > 0;
        if (!Array.isArray(msg.content)) return false;
        return msg.content.some(b => b?.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
    };
    const previousUserTextAnchorIdx = () => {
        // Prefer the user text turn before the current tail. In a normal
        // user->assistant->tool loop this is the last prompt that was already
        // present in the previous API request, so its prefix can overlap.
        const tailIdx = sanitizedMessages.length - 1;
        for (let i = tailIdx - 1; i >= 0; i--) {
            if (hasUserText(sanitizedMessages[i])) return i;
        }
        return -1;
    };
    const latestToolResultTailIdx = () => {
        // Claude/pi refs allow cache_control on tool_result blocks. Keep this
        // narrower than "last message" so a fresh user prompt or steering text
        // never becomes a 1h breakpoint.
        for (let i = sanitizedMessages.length - 1; i >= 0; i--) {
            const msg = sanitizedMessages[i];
            if (msg?.role !== 'user' || !Array.isArray(msg.content) || msg.content.length === 0) continue;
            const lastBlock = msg.content[msg.content.length - 1];
            if (lastBlock?.type === 'tool_result') return i;
        }
        return -1;
    };

    if (messageTtl !== null) {
        const slots = Math.max(0, Math.min(4, Number(messageSlots) || 0));
        const marked = new Set();
        const candidates = [latestToolResultTailIdx(), previousUserTextAnchorIdx()];
        for (const idx of candidates) {
            if (slots <= 0) break;
            if (idx < 0 || marked.has(idx) || !canMarkMessageIdx(idx)) continue;
            markLast(sanitizedMessages[idx], messageTtl);
            marked.add(idx);
            if (marked.size >= slots) break;
        }
    }

    return sanitizedMessages;
}

// --- SSE parser ---

function _captureMidstreamAbort(state, reason) {
    if (!state) return;
    const reasonName = reason?.name || '';
    if (reasonName === 'AgentStallAbortError' || reasonName === 'StreamStalledAbortError') {
        state.watchdogAbort = reasonName;
    } else {
        state.userAbort = true;
    }
}

// Abort-aware mid-stream backoff sleep → shared sleepWithAbort
// (retry-classifier.mjs). abortMessage preserves the prior fallback text.
function _midstreamSleepWithAbort(ms, signal) {
    return sleepWithAbort(ms, signal, undefined, 'Anthropic OAuth mid-stream retry backoff aborted');
}

function _statusForAnthropicSseError(type, message) {
    const kind = String(type || '').toLowerCase();
    const text = String(message || '').toLowerCase();
    if (kind.includes('overload') || text.includes('overload')) return 503;
    if (kind.includes('rate_limit') || text.includes('rate limit') || text.includes('quota')) return 429;
    if (kind.includes('authentication') || text.includes('authentication') || text.includes('unauthorized')) return 401;
    if (kind.includes('permission') || text.includes('forbidden')) return 403;
    if (kind.includes('not_found') || text.includes('not found')) return 404;
    if (kind.includes('invalid_request')) return 400;
    return 0;
}

function _anthropicSseError(event) {
    const payload = event?.error && typeof event.error === 'object' ? event.error : event;
    const type = payload?.type || event?.type || 'error';
    const message = payload?.message || 'Anthropic SSE error';
    const err = new Error(`Anthropic OAuth SSE error ${type}: ${message}`);
    err.name = 'AnthropicSseError';
    err.code = 'EANTHROPIC_SSE_ERROR';
    err.providerErrorType = type;
    err.requestId = event?.request_id || event?.requestId || null;
    const status = _statusForAnthropicSseError(type, message);
    if (status) {
        err.httpStatus = status;
        err.status = status;
    }
    return err;
}

async function parseSSEStream(response, signal, abortStream, onStreamDelta, onToolCall, state, onTextDelta) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const SSE_IDLE_TIMEOUT_MS = PROVIDER_SSE_IDLE_TIMEOUT_MS;
    let content = '';
    let hasThinkingContent = false;
    const contentBlockTypes = new Set();
    let model = '';
    let toolCalls = [];
    let usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, raw: null };
    let stopReason = null;
    let buffer = '';
    let idleTimedOut = false;
    let idleTimer = null;
    let currentEvent = '';

    const pendingToolInputs = new Map();

    // Holds the in-flight reader.read() race rejector so the idle timer can
    // force-unblock the loop even when reader.cancel() fails to settle the
    // pending read (undici half-open socket). See resetIdleTimer below.
    let idleReject = null;

    const resetIdleTimer = () => {
        // OFF by default. When disabled the
        // idle timer never arms, so the stream is never killed on inactivity;
        // the agent stall watchdog (600s) remains the dead-stream backstop.
        if (!PROVIDER_SSE_IDLE_WATCHDOG_ENABLED) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            idleTimedOut = true;
            try { abortStream?.(); } catch (err) {
                try { process.stderr.write(`[anthropic-oauth] sse idle abortStream failed: ${err?.message ?? String(err)}\n`); } catch {}
            }
            try {
                const _c = reader.cancel('SSE idle timeout');
                if (_c && typeof _c.catch === 'function') _c.catch(() => {});
            } catch (err) {
                try { process.stderr.write(`[anthropic-oauth] sse idle cancel failed: ${err?.message ?? String(err)}\n`); } catch {}
            }
            // Force-reject the in-flight reader.read() race even when reader.cancel()
            // fails to settle the pending read: without this the await below stays
            // pending forever and the SSE idle timeout never unblocks the loop —
            // the 391s-hang root cause.
            if (idleReject) {
                const e = new Error(`Anthropic OAuth SSE stream timed out after ${SSE_IDLE_TIMEOUT_MS}ms of inactivity`);
                e.code = 'ETIMEDOUT';
                const r = idleReject; idleReject = null; r(e);
            }
        // Shared provider policy: short inter-chunk inactivity catches the
        // sess_9cfd11-class stuck pattern where SSE starts but then goes silent.
        }, SSE_IDLE_TIMEOUT_MS);
    };

    const onAbort = () => {
        try {
            const _c = reader.cancel('SSE aborted');
            if (_c && typeof _c.catch === 'function') _c.catch(() => {});
        } catch {}
    };
    if (signal) {
        if (signal.aborted) {
            _captureMidstreamAbort(state, signal.reason);
            throw signal.reason instanceof Error
                ? signal.reason
                : new Error('Anthropic OAuth SSE stream aborted');
        }
        signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
        resetIdleTimer();
        streamLoop: while (true) {
            let chunk;
            try {
                // Race the read against the idle timer's rejector so a stuck
                // reader.read() (cancel did not settle it) still unblocks here.
                chunk = await new Promise((resolve, reject) => {
                    idleReject = reject;
                    reader.read().then(resolve, reject);
                });
            } catch (err) {
                if (idleTimedOut) {
                    const idleErr = new Error(`Anthropic OAuth SSE stream timed out after ${SSE_IDLE_TIMEOUT_MS}ms of inactivity`);
                    idleErr.code = 'ETIMEDOUT';
                    throw idleErr;
                }
                if (signal?.aborted) {
                    _captureMidstreamAbort(state, signal.reason);
                    throw signal.reason instanceof Error
                        ? signal.reason
                        : new Error('Anthropic OAuth SSE stream aborted');
                }
                throw err;
            }
            const { done, value } = chunk;
            if (done) break;

            resetIdleTimer();
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (line.startsWith(':')) {
                    // SSE comment frame (Anthropic `:ping` keepalive). The HTML Standard SSE
                    // spec says comments are silently ignored, but we surface them here so
                    // the agent stall watchdog sees the stream is still alive during Opus
                    // extended-thinking pauses. No content is emitted — this only refreshes
                    // the runtime's lastStreamDeltaAt timestamp.
                    try { onStreamDelta?.(); } catch {}
                    continue;
                }
                if (line.startsWith('event: ')) {
                    currentEvent = line.slice(7).trim();
                    continue;
                }
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event = JSON.parse(data);

                    if (currentEvent === 'error' || event?.type === 'error' || event?.error) {
                        throw _anthropicSseError(event);
                    }

                    if (event.type === 'message_start' && event.message) {
                        if (state) state.sawMessageStart = true;
                        if (event.message.model) model = event.message.model;
                        if (event.message.usage) {
                            usage.inputTokens = event.message.usage.input_tokens || 0;
                            usage.cachedTokens = event.message.usage.cache_read_input_tokens || 0;
                            usage.cacheWriteTokens = event.message.usage.cache_creation_input_tokens || 0;
                            usage.raw = { ...event.message.usage };
                        }
                    }

                    if (event.type === 'content_block_start') {
                        const block = event.content_block;
                        if (block?.type === 'tool_use') {
                            pendingToolInputs.set(event.index, {
                                id: block.id || '',
                                name: block.name || '',
                                inputJson: '',
                            });
                        }
                    }

                    if (event.type === 'content_block_delta') {
                        const delta = event.delta;
                        if (delta?.type) contentBlockTypes.add(delta.type);
                        // Time-to-first-token: stamp the first content delta
                        // (text / thinking / tool input_json) exactly once so
                        // the SSE trace can separate first-byte latency from
                        // total stream/generation time. Without this stamp
                        // ttftMs was always null and reported as 0ms.
                        if (state && !state.ttftAt) state.ttftAt = Date.now();
                        if (delta?.type === 'text_delta') {
                            content += delta.text || '';
                            try { onStreamDelta?.(); } catch {}
                            // Live text relay (gateway): forward the explicit
                            // text chunk. thinking/signature/input_json deltas
                            // intentionally stay off this path.
                            // Invariant: once a non-empty chunk has been relayed
                            // live it cannot be withdrawn, so flag the attempt so
                            // the mid-stream retry loop treats any later failure
                            // as final (a retry would concatenate attempts).
                            if (delta.text && onTextDelta) {
                                if (state) state.emittedText = true;
                                try { onTextDelta(delta.text); } catch {}
                            }
                        }
                        if (delta?.type === 'thinking_delta' || delta?.type === 'signature_delta') {
                            // Extended-thinking block: provider reasoning without
                            // user-visible text. Track presence so a final turn
                            // that emitted ONLY thinking (no text_delta, no
                            // tool_use) can be classified by the loop as
                            // synthesis-stalled rather than silent empty.
                            hasThinkingContent = true;
                            try { onStreamDelta?.(); } catch {}
                        }
                        if (delta?.type === 'input_json_delta') {
                            const pending = pendingToolInputs.get(event.index);
                            if (pending) {
                                pending.inputJson += delta.partial_json || '';
                            }
                            try { onStreamDelta?.(); } catch {}
                        }
                    }

                    if (event.type === 'content_block_stop') {
                        const pending = pendingToolInputs.get(event.index);
                        if (pending) {
                            // Bare JSON.parse threw straight up into the
                            // surrounding broad catch, which swallowed the
                            // whole tool_call — the loop never saw it and
                            // the assistant turn ended with an unmatched
                            // tool_use id. Wrap the parse so a malformed
                            // input still produces a tool_call (with an
                            // invalid-args marker and a logged error) instead
                            // of a silent drop or accidental `{}` dispatch.
                            let parsedArgs = {};
                            if (pending.inputJson) {
                                try { parsedArgs = JSON.parse(pending.inputJson); }
                                catch (parseErr) {
                                    process.stderr.write(`[anthropic-oauth] tool args JSON.parse failed (id=${pending.id}, name=${pending.name}): ${parseErr?.message || parseErr}\n`);
                                    parsedArgs = makeInvalidToolArgsMarker(pending.inputJson, parseErr instanceof Error ? parseErr.message : String(parseErr));
                                }
                            }
                            // Tool arguments must be a plain object. Anthropic's
                            // tool_use input is always a JSON object, but a
                            // malformed stream could parse to an array/string/
                            // number — wrap those as {} to keep the contract
                            // (invariant-based, no heuristic coercion).
                            if (parsedArgs === null
                                || typeof parsedArgs !== 'object'
                                || Array.isArray(parsedArgs)) {
                                process.stderr.write(`[anthropic-oauth] tool args not a plain object (id=${pending.id}, name=${pending.name}, type=${Array.isArray(parsedArgs) ? 'array' : typeof parsedArgs}); using {}\n`);
                                parsedArgs = {};
                            }
                            const call = {
                                id: pending.id,
                                name: pending.name,
                                arguments: parsedArgs,
                            };
                            toolCalls.push(call);
                            pendingToolInputs.delete(event.index);
                            if (state) state.emittedToolCall = true;
                            // Eager dispatch: let the loop start this tool
                            // before message_stop arrives. The loop keys
                            // pending promises by call.id so order is safe.
                            try { onToolCall?.(call); } catch {}
                            try { onStreamDelta?.(); } catch {}
                        }
                    }

                    if (event.type === 'message_delta') {
                        if (event.delta?.stop_reason) {
                            stopReason = event.delta.stop_reason;
                        }
                        if (event.usage) {
                            usage.outputTokens = event.usage.output_tokens || 0;
                            usage.raw = { ...(usage.raw || {}), ...event.usage };
                        }
                        if (stopReason === 'tool_use' && toolCalls.length > 0 && pendingToolInputs.size === 0) {
                            if (state) state.sawCompleted = true;
                            break streamLoop;
                        }
                    }
                    if (event.type === 'message_stop') {
                        if (state) state.sawCompleted = true;
                        // Anthropic streams can keep emitting `:ping` keepalive
                        // frames after `message_stop`; if we wait for EOF the
                        // outer reader.read() loop hangs indefinitely. Break
                        // out of streamLoop the moment the message ends.
                        break streamLoop;
                    }
                    // Unified prompt volume — what the model actually ingested.
                    // Anthropic splits input into three billable slots (uncached
                    // input + cache_read + cache_create); keep them separate for
                    // cost math but also expose the sum so cross-provider logs
                    // have a consistent `promptTokens` meaning.
                    usage.promptTokens = (usage.inputTokens || 0)
                        + (usage.cachedTokens || 0)
                        + (usage.cacheWriteTokens || 0);
                } catch (err) {
                    if (err?.code === 'EANTHROPIC_SSE_ERROR') throw err;
                    /* skip malformed events */
                }
            }
        }

        // Truncated-stream guard: if the reader loop exited (EOF or break)
        // after message_start but without seeing message_stop / a tool_use
        // stop_reason, the assistant turn was cut off mid-flight. Returning
        // success here would silently surface partial content (or a partially
        // streamed tool_use whose input_json never completed) as final.
        // Throw a typed truncated-stream error so the loop can decide whether
        // to retry, surface, or escalate instead of accepting the partial.
        if (state?.sawMessageStart && !state?.sawCompleted) {
            const pendingToolUse = pendingToolInputs.size > 0;
            const err = Object.assign(
                new Error(
                    `Anthropic OAuth SSE stream truncated: message_start without message_stop`
                    + (pendingToolUse ? ` (pending tool_use input)` : ''),
                ),
                {
                    name: 'TruncatedStreamError',
                    code: 'TRUNCATED_STREAM',
                    truncatedStream: true,
                    pendingToolUse,
                    stopReason,
                },
            );
            throw err;
        }

        return {
            content,
            model,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            usage,
            stopReason,
            hasThinkingContent,
            contentBlockTypes: Array.from(contentBlockTypes),
        };
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try { reader.releaseLock(); } catch (err) {
            try { process.stderr.write(`[anthropic-oauth] reader releaseLock failed: ${err?.message ?? String(err)}\n`); } catch {}
        }
    }
}

/**
 * Classify an Anthropic SSE failure for single-shot mid-stream retry.
 *
 * Retry is allowed only after `message_start` and before `message_stop`,
 * and only when no tool call has already been surfaced to the loop.
 * That keeps recovery limited to transport/stream stalls without risking
 * duplicate eager tool execution.
 */
// Thin wrapper: the SSE mid-stream decision tree now lives in the shared
// classifyMidstreamError (retry-classifier.mjs, policy.mode='sse'). Kept as a
// named export so internal call sites AND anthropic.mjs (which imports this
// symbol) keep resolving it. Behavior is byte-identical — the shared function
// is the relocated original, gated by SSE_MIDSTREAM_POLICY (defaultRetries=3,
// perClassifierGate:false).
export function _classifyMidstreamError(err, state) {
    return classifyMidstreamError(err, state, SSE_MIDSTREAM_POLICY);
}

// --- Build request body ---

function resolveCacheTtls(opts) {
    // Layered cache strategy — caller may override per-layer via opts.cacheStrategy.
    // Anthropic enforces: 1h entries must appear before 5m entries in the request.
    const strategy = opts.cacheStrategy || {};
    const pick = (layer, fallback) => {
        const v = strategy[layer];
        if (v === '1h') return CACHE_TTL_STABLE;
        if (v === '5m') return CACHE_TTL_VOLATILE;
        if (v === 'none') return null;
        return fallback;
    };
    // BP budget (4 total):
    //   BP1 baseRules    — 1h (shared tool policy + compact skill manifest)
    //   BP2 stableSystem — 1h (role/system rules)
    //   BP3 tier3        — 1h (sessionMarker: stable memory/meta body)
    //   BP4 messages     — 1h sliding tail (tool_result cache across iter)
    // tools BP is dropped — system BP covers the tools prefix via
    // Anthropic's prompt cache prefix semantics (order: tools → system
    // → messages).
    // tier3 defaults to 1h (stable) — sessionMarker content is stable per
    // memory/meta tuple and the BP slot is only spent when a 3rd
    // (cacheTier:'tier3') system block is actually present, so this default is
    // free for sessions that don't carry one. Previously null here meant any
    // caller that skipped agent runtime resolve (CLI, raw agent spawn)
    // silently lost the tier3 cache layer even though it supported one.
    return {
        tools: pick('tools', null),
        system: pick('system', CACHE_TTL_STABLE),
        tier3: pick('tier3', CACHE_TTL_STABLE),
        messages: pick('messages', CACHE_TTL_STABLE),
    };
}

// BP3 (tier3) is injected by session/manager as its own `system` role block —
// the 3rd system block, tagged `cacheTier:'tier3'`. buildSystemBlocks applies
// the tier3 1h cache_control to that block; BP1/BP2 take the system TTL. No
// `<system-reminder>` user message / sentinel scan is involved anymore.

function buildRequestBody(messages, model, tools, sendOpts) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const maxTokens = resolveMaxTokens(model);
    const opts = sendOpts || {};
    const ttls = resolveCacheTtls(opts);
    // Each system message becomes its own Anthropic content block with its own
    // breakpoint: BP1 baseRules + BP2 stableSystem at ttls.system, BP3
    // sessionMarker (cacheTier:'tier3') at ttls.tier3.
    const systemBlocks = buildSystemBlocks(systemMsgs, model, ttls?.system, ttls?.tier3);

    // 4-BP budget layout. tools BP is dropped — system BP covers the
    // tools prefix via Anthropic's prompt cache prefix semantics
    // (order: tools → system → messages). That frees slots for the
    // messages-tail. The system blocks now hold BP1/BP2/BP3 (tier3), so the
    // tier3 breakpoint is accounted for inside systemBpUsed.
    const systemBpUsed = systemBlocks.filter(b => b.cache_control).length;
    const toolsBpUsed = 0;
    const usedSlots = toolsBpUsed + systemBpUsed;
    // Env override for BP strategy. ANTHROPIC_MSG_SLOTS=0 disables message
    // caching entirely. Any value >=1 first marks the previous user text turn
    // so consecutive requests share a breakpoint; a second free slot marks the
    // tail for the newest delta.
    const msgSlotsCap = Number.parseInt(process.env.ANTHROPIC_MSG_SLOTS, 10);
    const defaultMsgSlots = Math.max(0, 4 - usedSlots);
    const msgSlots = ttls.messages
        ? (Number.isFinite(msgSlotsCap) && msgSlotsCap >= 0 ? Math.min(msgSlotsCap, defaultMsgSlots) : defaultMsgSlots)
        : 0;
    // Build → sanitize (once, inside toAnthropicMessages) → mark. Markers are
    // applied to the FINAL sanitized array by invariant, so block drops /
    // inserts / reorders performed by the sanitizer can never move or delete a
    // marked block. NEVER sanitize again after this (see send path).
    // msgSlots === 0 (ANTHROPIC_MSG_SLOTS=0, or no free slot) → tail disabled.
    const tailTtl = msgSlots > 0 ? ttls.messages : null;
    const anthropicMessages = applyAnthropicCacheMarkers(
        toAnthropicMessages(chatMsgs),
        { messageTtl: tailTtl, messageSlots: msgSlots },
    );

    const body = {
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
        stream: true,
    };

    if (systemBlocks.length) body.system = systemBlocks;

    const nativeTools = nativeAnthropicTools(opts);
    const deferredTools = deferredAnthropicTools(tools || [], opts);
    if (tools?.length || nativeTools.length || deferredTools.length) {
        // No cache_control on tools — the systemBase BP already covers the
        // tools prefix via Anthropic's prompt cache prefix semantics (order:
        // tools → system → messages). Placing a separate BP here would waste
        // a slot that's better spent on messages tail.
        body.tools = [...nativeTools, ...toAnthropicTools([...(tools || []), ...deferredTools])];
    }

    const thinkingBudgetTokens = Number(opts.thinkingBudgetTokens);
    if (Number.isFinite(thinkingBudgetTokens) && thinkingBudgetTokens > 0) {
        const budgetTokens = clampThinkingBudgetTokens(thinkingBudgetTokens, maxTokens);
        if (budgetTokens) body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
    } else if (opts.effort) {
        if (EFFORT_BUDGET[opts.effort]) {
            const budgetTokens = clampThinkingBudgetTokens(EFFORT_BUDGET[opts.effort], maxTokens);
            if (budgetTokens) body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
        } else if (!_LOGGED_UNKNOWN_EFFORT.has(opts.effort)) {
            _LOGGED_UNKNOWN_EFFORT.add(opts.effort);
            try {
                process.stderr.write(`[anthropic-oauth] unknown effort=${opts.effort} ignored (known: ${Object.keys(EFFORT_BUDGET).join(',')})\n`);
            } catch {}
        }
    }

    if (opts.fast === true && supportsAnthropicFastMode(model)) {
        body.speed = 'fast';
    }

    return body;
}

export function _buildRequestBodyForCacheSmoke(messages, model, tools = [], sendOpts = {}) {
    return buildRequestBody(messages, model, tools, sendOpts);
}

// --- Provider ---

export class AnthropicOAuthProvider {
    // input_tokens EXCLUDES cache_read_input_tokens (separate field) — add the
    // cache back for the real context footprint. See registry.mjs.
    static inputExcludesCache = true;
    name = 'anthropic-oauth';
    credentials = null;
    config;
    fastModeBetaHeaderLatched = false;

    constructor(config) {
        this.config = config || {};
        this.credentials = loadCredentials();
        // Warm a kept-alive socket to the messages API so the first request
        // skips the cold TLS handshake. Best-effort; never throws.
        preconnect('https://api.anthropic.com');
    }

    async ensureAuth({ forceRefresh = false, reason = 'preemptive' } = {}) {
        if (!this.credentials) {
            this.credentials = loadCredentials();
        }
        if (!this.credentials) {
            throw new Error('Anthropic OAuth credentials not found. Open /providers in mixdog to sign in.');
        }

        // Pick up Mixdog-updated tokens the moment the credentials file is
        // rewritten — without this, a fresh /auth login in another process is
        // ignored until the in-memory token's expiry skew triggers a refresh.
        const diskMtime = _credentialsMaxMtime();
        if (diskMtime > 0 && diskMtime > (this.credentials.mtimeMs || 0)) {
            const fresh = loadCredentials();
            if (fresh?.accessToken) {
                this.credentials = fresh;
                process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk (mtime change)\n`);
            }
        }

        const expiring = this.credentials.expiresAt
            && this.credentials.expiresAt < Date.now() + TOKEN_REFRESH_SKEW_MS;
        if (forceRefresh || expiring) {
            this.credentials = await this._refreshCredentials({ force: forceRefresh, reason });
        }

        return this.credentials;
    }

    async _refreshCredentials({ force = false, reason = 'preemptive' } = {}) {
        const currentToken = this.credentials?.accessToken || null;
        const disk = loadCredentials();
        const validAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
        if (disk?.accessToken && disk.accessToken !== currentToken
            && (!disk.expiresAt || disk.expiresAt >= validAfter)) {
            this.credentials = disk;
            process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk\n`);
            return disk;
        }
        if (!this.credentials && disk) this.credentials = disk;

        if (_oauthRefreshInFlight) {
            const shared = await _oauthRefreshInFlight;
            this.credentials = shared;
            if (!force || shared?.accessToken !== currentToken) return this.credentials;
        }

        const startingCreds = this.credentials || disk;
        _oauthRefreshInFlight = (async () => {
            const latest = loadCredentials() || startingCreds;
            const latestValidAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
            if (latest?.accessToken && latest.accessToken !== currentToken
                && (!latest.expiresAt || latest.expiresAt >= latestValidAfter)) {
                process.stderr.write(`[anthropic-oauth] Credentials reloaded from disk\n`);
                return latest;
            }

            if (!latest?.refreshToken) {
                if (!force && latest?.accessToken && (!latest.expiresAt || latest.expiresAt > Date.now())) {
                    process.stderr.write(`[anthropic-oauth] WARNING: token expiring but no refresh token; using current token until expiry\n`);
                    return latest;
                }
                throw new Error('Anthropic OAuth refresh token not available. Open /providers in mixdog to sign in again.');
            }

            try {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] Token ${reason}, refreshing...\n`);
                const refreshed = await refreshOAuthCredentials(latest);
                process.stderr.write(`[anthropic-oauth] Token refreshed, expires in ${Math.round(((refreshed.expiresAt || Date.now()) - Date.now()) / 1000)}s\n`);
                return refreshed;
            } catch (err) {
                if (!force && latest?.accessToken && (!latest.expiresAt || latest.expiresAt > Date.now())) {
                    const msg = err instanceof Error ? err.message : String(err);
                    process.stderr.write(`[anthropic-oauth] Refresh failed (${msg}); using still-valid current token\n`);
                    return latest;
                }
                throw err;
            }
        })().finally(() => { _oauthRefreshInFlight = null; });

        this.credentials = await _oauthRefreshInFlight;
        return this.credentials;
    }

    scrubTokens(text) {
        return _scrubTokens(text);
    }

    async send(messages, model, tools, sendOpts) {
        // Re-warm the kept-alive socket before the turn. preconnect() is a
        // best-effort no-op while a socket is still hot (TTL gate), but after an
        // idle gap longer than the keep-alive window it re-opens one in parallel
        // with auth/body build so the POST below skips the cold TLS handshake.
        preconnect('https://api.anthropic.com');
        // Defense-in-depth: enforce tool_use / tool_result pairing before
        // the Anthropic API call. The trim.mjs sanitize pass is normally
        // invoked by the budget trimmer in loop.mjs, but dispatches under
        // budget skip it — a tool that aborted mid-flight then leaves an
        // unmatched tool_use in messages, which the provider rejects with
        // a hard 400. Pairing here closes the gap regardless of caller.
        messages = sanitizeToolPairs(messages);
        const opts = sendOpts || {};
        const onStageChange = typeof opts.onStageChange === 'function' ? opts.onStageChange : null;
        const onStreamDelta = typeof opts.onStreamDelta === 'function' ? opts.onStreamDelta : null;
        const onToolCall = typeof opts.onToolCall === 'function' ? opts.onToolCall : null;
        const onTextDelta = typeof opts.onTextDelta === 'function' ? opts.onTextDelta : null;
        const externalSignal = opts.signal || null;
        // Test seam: lets the retry harness drive stream outcomes without a
        // live OAuth session.
        const parseSSEFn = typeof opts._parseSSEFn === 'function' ? opts._parseSSEFn : parseSSEStream;

        let creds = await this.ensureAuth();
        // Default when the caller doesn't pin a model: newest high-tier chat
        // model from the live catalog (one warmup round-trip if cache is cold).
        const useModel = model || await ensureLatestAnthropicModel(this);
        const body = buildRequestBody(messages, useModel, tools, sendOpts);
        if (body.speed === 'fast') {
            this.fastModeBetaHeaderLatched = true;
        }
        const sessionId = opts.sessionId || null;
        const iteration = Number.isFinite(Number(opts.iteration)) ? Number(opts.iteration) : null;
        // Option A: no absolute wall-clock cap on streaming generation. A stream
        // that keeps emitting SSE deltas must NOT be killed by a fixed total-lifetime
        // timer — the old PROVIDER_GENERATE_TOTAL_TIMEOUT_MS (~285s, derived from the
        // stall WARN threshold) false-aborted live high-reasoning turns that were
        // still alive and producing tokens. The streaming phase is bounded instead by:
        //   (a) the per-attempt initial-response timeout in requestWithRetry
        //       (PROVIDER_HTTP_RESPONSE_TIMEOUT_MS) for a socket that never sends a
        //       first byte (truly wedged),
        //   (b) externalSignal (client disconnect / replaced-by-newer-request), and
        //   (c) the agent stall watchdog (STALL_ABORT_S, 600s, progress-based) plus
        //       the optional SSE idle watchdog for a stream that goes dead mid-flight.
        // totalSignal is therefore a pure pass-through of externalSignal with no timer.
        const totalTimeout = createPassthroughSignal(externalSignal);
        const totalSignal = totalTimeout.signal;

        const cleanupCancelHandler = (handler) => {
            if (!handler) return;
            try { totalSignal.removeEventListener('abort', handler); } catch {}
        };

        const doRequest = async (accessToken, requestSignal = null) => {
            const controller = createAbortController();
            const fetchStartedAt = Date.now();

            let cancelHandler = null;
            let attemptCancelHandler = null;
            if (totalSignal) {
                if (totalSignal.aborted) {
                    controller.abort(totalSignal.reason);
                    throw totalSignal.reason instanceof Error
                        ? totalSignal.reason
                        : new Error('Anthropic OAuth request aborted by session close');
                }
                cancelHandler = () => { try { controller.abort(totalSignal.reason); } catch {} };
                totalSignal.addEventListener('abort', cancelHandler, { once: true });
            }
            if (requestSignal && requestSignal !== totalSignal) {
                if (requestSignal.aborted) {
                    cleanupCancelHandler(cancelHandler);
                    controller.abort(requestSignal.reason);
                    throw requestSignal.reason instanceof Error
                        ? requestSignal.reason
                        : new Error('Anthropic OAuth request attempt aborted');
                }
                attemptCancelHandler = () => { try { controller.abort(requestSignal.reason); } catch {} };
                requestSignal.addEventListener('abort', attemptCancelHandler, { once: true });
            }

            try {
                try { onStageChange?.('requesting'); } catch {}
                // NOTE: do NOT sanitize here. body.messages was already
                // sanitized once inside toAnthropicMessages and then had cache
                // markers applied by applyAnthropicCacheMarkers. Re-sanitizing
                // after marking could drop/reorder a marked block and move the
                // provider-visible cache breakpoint off the cached one — the
                // exact COLD-turn bug this change fixes. Order is fixed:
                // build → sanitize (once) → mark → JSON.stringify.
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'anthropic-beta': buildAnthropicBetaHeaders({
                            base: OAUTH_BETA_HEADERS,
                            fastMode: this.fastModeBetaHeaderLatched,
                            toolSearch: true,
                        }),
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                        'x-app': 'cli',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                    dispatcher: getLlmDispatcher(),
                });

                traceAgentFetch({
                    sessionId,
                    headersMs: Date.now() - fetchStartedAt,
                    httpStatus: response.status,
                    provider: 'anthropic-oauth',
                    model: useModel,
                    transport: 'sse',
                });

                if (attemptCancelHandler) {
                    try { requestSignal.removeEventListener('abort', attemptCancelHandler); } catch {}
                }
                return { response, controller, cancelHandler };
            } catch (err) {
                if (attemptCancelHandler) {
                    try { requestSignal.removeEventListener('abort', attemptCancelHandler); } catch {}
                }
                cleanupCancelHandler(cancelHandler);
                if (requestSignal?.aborted) {
                    const reason = requestSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Anthropic OAuth request attempt aborted');
                }
                if (totalSignal?.aborted) {
                    const reason = totalSignal.reason;
                    throw reason instanceof Error ? reason : new Error('Anthropic OAuth request aborted by session close');
                }
                if (err?.name === 'AbortError') {
                    const timeoutErr = new Error(`Anthropic OAuth API initial response timed out after ${PROVIDER_HTTP_RESPONSE_TIMEOUT_MS}ms`);
                    timeoutErr.code = 'EPROVIDERTIMEOUT';
                    throw timeoutErr;
                }
                throw err;
            }
        };
        // Test seam: injectable request factory for retry-path tests.
        const doRequestImpl = typeof opts._doRequestFn === 'function' ? opts._doRequestFn : doRequest;

        const requestWithRetry = async (accessToken) => withRetry(async ({ signal: attemptSignal }) => {
            const result = await doRequestImpl(accessToken, attemptSignal);
            const status = Number(result?.response?.status || 0);
            const transientStatus = classifyError({ httpStatus: status }) === 'transient';
            if (transientStatus || status === 429) {
                if (status === 429) {
                    const quotaText = await result.response.text().catch(() => '');
                    cleanupCancelHandler(result.cancelHandler);
                    try { result.controller?.abort?.(); } catch {}
                    throw anthropicQuotaError(status, result?.response?.headers, this.scrubTokens(quotaText));
                }
                const err = new Error(`Anthropic OAuth API ${status}`);
                err.httpStatus = status;
                err.status = status;
                err.headers = result?.response?.headers;
                err.response = { status, headers: result?.response?.headers };
                const retryAfterMs = retryAfterMsFromError(err);
                if (transientStatus || retryAfterMs != null) {
                    try { await result.response.text(); } catch {}
                    cleanupCancelHandler(result.cancelHandler);
                    try { result.controller?.abort?.(); } catch {}
                    throw err;
                }
            }
            return result;
        }, {
            signal: totalSignal,
            maxAttempts: PROVIDER_RETRY_MAX_ATTEMPTS,
            backoffMs: PROVIDER_RETRY_BACKOFF_MS,
            perAttemptTimeoutMs: PROVIDER_HTTP_RESPONSE_TIMEOUT_MS,
            perAttemptLabel: 'Anthropic OAuth initial response',
            onRetry: ({ attempt, lastErr, delayMs, delayReason }) => {
                const status = Number(lastErr?.httpStatus || lastErr?.status || lastErr?.response?.status || 0) || null;
                const reason = status || lastErr?.code || lastErr?.message || 'network error';
                const suffix = delayReason ? ` (${delayReason})` : '';
                try {
                    process.stderr.write(
                        `[anthropic-oauth] retry attempt ${attempt + 1}/${PROVIDER_RETRY_MAX_ATTEMPTS} after ${reason}, backoff ${delayMs}ms${suffix}\n`,
                    );
                } catch {}
            },
        });
        // Bounded mid-stream retries for transient stream loss; jittered backoff
        // between attempts (see catch branches).
        const MAX_MIDSTREAM_RETRIES = ANTHROPIC_MAX_MIDSTREAM_RETRIES;
        let firstAttemptError = null;
        let firstAttemptClassifier = null;

        try {
        for (let attemptIndex = 0; attemptIndex <= MAX_MIDSTREAM_RETRIES; attemptIndex++) {
            let response, controller, cancelHandler;
            ({ response, controller, cancelHandler } = await requestWithRetry(creds.accessToken));

            // 401: token expired/revoked. 403: organization permission flipped
            // (e.g. relogin into a different org). Both: force a shared refresh
            // and retry once with the new token.
            if (response.status === 401 || response.status === 403) {
                process.stderr.write(`[anthropic-oauth] ${response.status} — forcing refresh and retrying once\n`);
                cleanupCancelHandler(cancelHandler);
                creds = await this.ensureAuth({ forceRefresh: true, reason: String(response.status) });
                ({ response, controller, cancelHandler } = await requestWithRetry(creds.accessToken));
            }

            if (!response.ok) {
                cleanupCancelHandler(cancelHandler);
                const text = await response.text().catch(() => '');
                const safeText = this.scrubTokens(text).slice(0, 200);
                process.stderr.write(`[anthropic-oauth] API error ${response.status}: ${safeText}\n`);

                if (response.status === 429) {
                    throw anthropicQuotaError(response.status, response.headers, safeText);
                }

                // Phase I: on unknown/404 model errors, force a catalog refresh and
                // retry once. Protects against a silently-rotated model id.
                const isUnknownModel = response.status === 404
                    || /unknown[_\s-]?model|model[_\s-]?not[_\s-]?found/i.test(safeText);
                if (isUnknownModel && !opts._modelRetry) {
                    process.stderr.write(`[anthropic-oauth] unknown model — refreshing catalog + 1 retry\n`);
                    await this._refreshModelCache();
                    const fallbackModel = resolveAnthropicModelAfter404(useModel);
                    if (fallbackModel) {
                        process.stderr.write(`[anthropic-oauth] model fallback ${useModel} -> ${fallbackModel}\n`);
                    }
                    return this.send(messages, fallbackModel || model, tools, { ...opts, _modelRetry: true });
                }
                throw new Error(`Anthropic OAuth API ${response.status}: ${safeText}`);
            }

            if (SSE_VERBOSE) process.stderr.write(`[anthropic-oauth] Response ${response.status}, parsing SSE...\n`);
            try { onStageChange?.('streaming'); } catch {}

            const midState = {
                attemptIndex,
                sawMessageStart: false,
                sawCompleted: false,
                emittedToolCall: false,
                // Gateway live-text relay invariant: set by parseSSEStream once
                // a non-empty text chunk has been forwarded to the client. A
                // later failure is non-retryable (rendered text cannot be
                // withdrawn; a retry would concatenate attempts).
                emittedText: false,
                userAbort: false,
                watchdogAbort: null,
                ttftAt: null,
            };

            try {
                const sseStartedAt = Date.now();
                const result = await parseSSEFn(
                    response,
                    controller.signal,
                    () => controller.abort(),
                    onStreamDelta,
                    onToolCall,
                    midState,
                    onTextDelta,
                );

                const ttftMs = midState.ttftAt ? midState.ttftAt - sseStartedAt : null;
                const liveModel = result.model || useModel;
                traceAgentSse({
                    sessionId,
                    sseParseMs: Date.now() - sseStartedAt,
                    ttftMs,
                    provider: 'anthropic-oauth',
                    model: liveModel,
                    transport: 'sse',
                });

                traceAgentUsage({
                    sessionId,
                    iteration,
                    inputTokens: result.usage?.inputTokens || 0,
                    outputTokens: result.usage?.outputTokens || 0,
                    cachedTokens: result.usage?.cachedTokens || 0,
                    cacheWriteTokens: result.usage?.cacheWriteTokens || 0,
                    promptTokens: result.usage?.promptTokens || 0,
                    model: liveModel,
                    modelDisplay: _displayModel(liveModel),
                    rawUsage: result.usage?.raw || null,
                    provider: 'anthropic-oauth',
                    requestKind: opts.requestKind || null,
                });

                // Phase I: if the live response surfaced a model id we don't know
                // about yet, kick off a background catalog refresh. Fire-and-forget
                // — do not await, do not surface errors.
                if (result.model && !_catalogHas(result.model)) {
                    void this._refreshModelCache();
                }

                if (SSE_VERBOSE) process.stderr.write(`[anthropic-oauth] Done: ${result.content.length} chars, ${result.toolCalls?.length || 0} tool calls\n`);
                // Empty-stream guard. Invariant: a valid Anthropic SSE response
                // ALWAYS opens with message_start (which carries usage.input_tokens).
                // A 200 whose body produced no message_start delivered nothing —
                // no usage, no content, no tool calls — i.e. a dropped/empty stream
                // (transient, often rate-limit-adjacent under concurrent load), NOT
                // a valid terminal turn. Returning it surfaces upstream as a silent
                // empty turn (0 tokens, no content) that masks the cause. Throw a
                // marked error: retry is provably safe here (no message_start ⇒
                // nothing was emitted ⇒ no duplicate-tool risk), and once retries
                // are exhausted the error is surfaced instead of swallowed.
                if (!midState.sawMessageStart
                    && !midState.userAbort
                    && !midState.watchdogAbort
                    && !result.content
                    && !(result.toolCalls && result.toolCalls.length)
                    && !(result.usage && result.usage.inputTokens > 0)) {
                    const emptyErr = new Error('Anthropic OAuth SSE stream produced no message_start (empty/dropped stream — likely transient or rate-limited)');
                    emptyErr.code = 'EEMPTYSTREAM';
                    emptyErr.isEmptyStream = true;
                    throw emptyErr;
                }
                try {
                    Object.defineProperty(result, '__midstreamRetries', { value: attemptIndex, enumerable: false });
                } catch { /* ignore non-extensible result */ }
                return result;
            } catch (err) {
                // Live-text invariant: once a non-empty text chunk has been
                // relayed to the client (gateway live mode), the rendered output
                // cannot be withdrawn and re-issuing would concatenate a second
                // attempt. Surface the failure immediately — never retry — and
                // tag the error so upstream layers refuse to retry as well.
                if (midState.emittedText) {
                    try { err.liveTextEmitted = true; err.unsafeToRetry = true; } catch {}
                    try { controller?.abort?.(err); } catch { /* best-effort teardown */ }
                    if (attemptIndex > 0 && firstAttemptError) {
                        try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                        try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                        throw firstAttemptError;
                    }
                    throw err;
                }
                // Empty/dropped stream (no message_start): safe to retry once —
                // nothing was emitted, so there is no duplicate-tool risk. This
                // is intentionally NOT routed through _classifyMidstreamError,
                // which requires sawMessageStart and would reject it.
                if (err?.isEmptyStream && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = 'empty_stream';
                    try { controller?.abort?.(err); } catch { /* best-effort teardown */ }
                    try { process.stderr.write(`[anthropic-oauth] empty stream (no message_start) — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES}\n`); } catch {}
                    await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                    continue;
                }
                if (classifyError(err) === 'transient'
                    && !midState.sawMessageStart
                    && !midState.emittedToolCall
                    && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = err?.providerErrorType || 'sse_transient';
                    try { controller?.abort?.(err); } catch { /* best-effort teardown */ }
                    try {
                        process.stderr.write(`[anthropic-oauth] transient SSE error — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (${err?.providerErrorType || err?.message || 'unknown'})\n`);
                    } catch {}
                    await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                    continue;
                }
                // Truncated stream (message_start without message_stop): the
                // partial result is discarded and re-requesting is safe (a
                // pendingToolUse means the tool_use input JSON never completed).
                // _classifyMidstreamError does not cover this; route it through
                // the shared classifier so it inherits the cross-provider
                // transient policy instead of escaping and killing the worker.
                // Guard: parseSSEStream eagerly fires onToolCall and sets
                // emittedToolCall=true at content_block_stop, BEFORE message_stop.
                // If the stream truncates after that, retrying would
                // double-execute the tool. Only retry when nothing was emitted
                // yet; otherwise let the error surface.
                if ((err?.truncatedStream === true || err?.code === 'TRUNCATED_STREAM')
                    && classifyError(err) === 'transient'
                    && !midState.emittedToolCall
                    && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = 'truncated_stream';
                    try { controller?.abort?.(err); } catch { /* best-effort teardown */ }
                    try { process.stderr.write(`[anthropic-oauth] truncated stream — retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES}\n`); } catch {}
                    await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                    continue;
                }
                const classifier = _classifyMidstreamError(err, midState);
                if (classifier && attemptIndex < MAX_MIDSTREAM_RETRIES) {
                    firstAttemptError = err;
                    firstAttemptClassifier = classifier;
                    try { controller?.abort?.(err); } catch (abortErr) {
                        /* best-effort stream teardown */
                        try { process.stderr.write(`[anthropic-oauth] abort on stream error failed: ${abortErr?.message ?? String(abortErr)}\n`); } catch {}
                    }
                    try {
                        process.stderr.write(`[anthropic-oauth] mid-stream recovered: retry ${attemptIndex + 1}/${MAX_MIDSTREAM_RETRIES} (cause: ${classifier})\n`);
                    } catch {}
                    await _midstreamSleepWithAbort(midstreamBackoffFor(attemptIndex + 1), totalSignal);
                    continue;
                }
                if (attemptIndex > 0 && firstAttemptError) {
                    try { firstAttemptError.midstreamRetries = attemptIndex; } catch {}
                    try { firstAttemptError.midstreamClassifier = firstAttemptClassifier; } catch {}
                    throw firstAttemptError;
                }
                throw err;
            } finally {
                cleanupCancelHandler(cancelHandler);
            }
        }
        throw firstAttemptError || new Error('Anthropic OAuth mid-stream retry: unreachable');
        } finally {
            totalTimeout.cleanup();
        }
    }

    async listModels() {
        // Dynamic lookup via /v1/models — returns whatever Anthropic currently
        // exposes for this OAuth account. Cached on disk with 24h TTL; falls
        // back to the static MODELS list on any failure so the plugin still
        // works offline or when Anthropic's /v1/models is momentarily down.
        const cached = await _loadModelCache();
        if (cached) {
            _inMemoryCatalog = cached.slice();
            return cached;
        }
        try {
            const creds = await this.ensureAuth();
            const res = await fetch('https://api.anthropic.com/v1/models', {
                signal: AbortSignal.timeout(10_000),
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${creds.accessToken}`,
                    'anthropic-version': ANTHROPIC_VERSION,
                    'anthropic-beta': OAUTH_BETA_HEADERS,
                    'anthropic-dangerous-direct-browser-access': 'true',
                    'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                    'x-app': 'cli',
                },
                dispatcher: getLlmDispatcher(),
            });
            if (!res.ok) throw new Error(`list_models ${res.status}`);
            const data = await res.json();
            const items = Array.isArray(data?.data) ? data.data : [];
            const normalized = items
                .map(m => _normalizeAnthropicModel(m))
                .filter(Boolean);
            _markLatestByFamily(normalized);
            // Enrich with LiteLLM catalog metadata (context, pricing, capabilities)
            const enriched = await enrichModels(normalized);
            await _saveModelCache(enriched);
            return enriched;
        } catch (err) {
            if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] listModels fetch failed (${err.message})\n`);
            // Fallback with full API model IDs. Short family tokens leaked
            // through here would be accepted by setup and reintroduce the
            // legacy shape. Env var override keeps this tracking defaults.
            const opusId   = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL   || 'claude-opus-4-8';
            const sonnetId = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';
            const haikuId  = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5-20251001';
            return [
                { id: opusId,   display: 'Opus (auto)',   family: 'opus',   provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 1000000 },
                { id: sonnetId, display: 'Sonnet (auto)', family: 'sonnet', provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 1000000 },
                { id: haikuId,  display: 'Haiku (auto)',  family: 'haiku',  provider: 'anthropic-oauth', tier: 'family', latest: true, contextWindow: 200000 },
            ];
        }
    }

    // Force a catalog refresh (ignores the 24h TTL). De-duped via
    // _modelRefreshInFlight so concurrent callers share one HTTP round-trip.
    // Returns the new catalog on success, null on failure.
    async _refreshModelCache() {
        if (_modelRefreshInFlight) return _modelRefreshInFlight;
        _modelRefreshInFlight = (async () => {
            try {
                const creds = await this.ensureAuth();
                const res = await fetch('https://api.anthropic.com/v1/models', {
                    signal: AbortSignal.timeout(10_000),
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${creds.accessToken}`,
                        'anthropic-version': ANTHROPIC_VERSION,
                        'anthropic-beta': OAUTH_BETA_HEADERS,
                        'anthropic-dangerous-direct-browser-access': 'true',
                        'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
                        'x-app': 'cli',
                    },
                    dispatcher: getLlmDispatcher(),
                });
                if (!res.ok) throw new Error(`list_models ${res.status}`);
                const data = await res.json();
                const items = Array.isArray(data?.data) ? data.data : [];
                const normalized = items
                    .map(m => _normalizeAnthropicModel(m))
                    .filter(Boolean);
                _markLatestByFamily(normalized);
                const enriched = await enrichModels(normalized);
                await _saveModelCache(enriched);
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] catalog refreshed (${enriched.length} models)\n`);
                return enriched;
            } catch (err) {
                if (!process.env.MIXDOG_QUIET_PROVIDER_LOG) process.stderr.write(`[anthropic-oauth] catalog refresh failed (${err.message})\n`);
                return null;
            } finally {
                _modelRefreshInFlight = null;
            }
        })();
        return _modelRefreshInFlight;
    }

    async isAvailable() {
        return this.credentials !== null || loadCredentials() !== null;
    }
}

// --- Login flow (PKCE loopback, export for setup UI / CLI) ---

function _oauthGeneratePKCE() {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function _oauthCredentialsWritePath() {
    for (const p of credentialCandidates()) {
        if (existsSync(p)) return p;
    }
    return DEFAULT_CREDENTIALS_PATH;
}

function _oauthParseScopeField(scope) {
    if (Array.isArray(scope)) return scope;
    return String(scope || '').split(' ').filter(Boolean);
}

function _parseOAuthCodeInput(input) {
    const value = String(input || '').trim();
    if (!value) return { code: '', state: '' };
    try {
        const url = new URL(value);
        const code = url.searchParams.get('code') || '';
        const state = url.searchParams.get('state') || '';
        if (code || state) return { code, state, redirectUri: `${url.origin}${url.pathname}` };
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

async function exchangeAuthorizationCode({ pkce, code, state, redirectUri }) {
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new Error('[anthropic-oauth] authorization code is required');
    const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'anthropic-dangerous-direct-browser-access': 'true',
            'user-agent': `claude-cli/${resolveCliVersion()} (external, sdk-cli)`,
        },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code: cleanCode,
            redirect_uri: redirectUri,
            client_id: CLAUDE_CODE_CLIENT_ID,
            code_verifier: pkce.verifier,
            state,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(OAUTH_TOKEN_TIMEOUT_MS),
        dispatcher: getLlmDispatcher(),
    });
    if (!tokenRes.ok) {
        const text = await tokenRes.text().catch(() => '');
        throw new Error(`[anthropic-oauth] token exchange ${tokenRes.status}: ${_scrubTokens(text).slice(0, 500)}`);
    }
    const json = await tokenRes.json();
    const accessToken = json?.access_token || json?.accessToken;
    const refreshToken = json?.refresh_token || json?.refreshToken;
    if (!accessToken || !refreshToken) {
        throw new Error('[anthropic-oauth] token exchange response missing access_token or refresh_token');
    }
    const expiresAt = _normalizeExpiresAt(json?.expires_at ?? json?.expiresAt)
        || (typeof json?.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0);
    const scopes = _oauthParseScopeField(json?.scope);
    const credPath = _oauthCredentialsWritePath();
    let raw = {};
    if (existsSync(credPath)) {
        raw = JSON.parse(readFileSync(credPath, 'utf-8'));
    }
    const existingOauth = raw.claudeAiOauth || {};
    raw.claudeAiOauth = {
        ...existingOauth,
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
        subscriptionType: existingOauth.subscriptionType ?? null,
    };
    _saveCredentialsFile(credPath, raw);
    return {
        path: credPath,
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
        subscriptionType: raw.claudeAiOauth.subscriptionType,
    };
}

export async function beginOAuthLogin() {
    const pkce = _oauthGeneratePKCE();
    const state = randomBytes(32).toString('base64url');
    const buildUrl = (redirectUri) => {
        const url = new URL(CLAUDE_AI_AUTHORIZE_URL);
        url.searchParams.set('code', 'true');
        url.searchParams.set('client_id', CLAUDE_CODE_CLIENT_ID);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', OAUTH_LOGIN_SCOPE);
        url.searchParams.set('code_challenge', pkce.challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        url.searchParams.set('state', state);
        return url;
    };
    const url = buildUrl(OAUTH_REDIRECT_URI);
    const manualUrl = buildUrl(OAUTH_MANUAL_REDIRECT_URI);

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
            const u = new URL(req.url || '/', `http://${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}`);
            if (u.pathname !== OAUTH_CALLBACK_PATH) {
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
            try {
                const tokens = await exchangeAuthorizationCode({ pkce, code, state, redirectUri: OAUTH_REDIRECT_URI });
                res.writeHead(302, { Location: OAUTH_SUCCESS_REDIRECT_URL });
                res.end();
                finish(tokens);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Claude login failed: ${error.message}`);
                finish(null, error);
            }
        });
        timeout = setTimeout(() => finish(null), OAUTH_LOGIN_TIMEOUT_MS);
        server.listen(OAUTH_CALLBACK_PORT, OAUTH_CALLBACK_HOST, async () => {
            process.stderr.write(`\n[anthropic-oauth] Open this URL to log in with Claude:\n${url.toString()}\n\nIf the localhost callback cannot complete, open this manual URL and paste the shown code#state:\n${manualUrl.toString()}\n\n`);
            try {
                const { openInBrowser } = await import('../../../shared/open-url.mjs');
                openInBrowser(url.toString());
            } catch (err) {
                process.stderr.write(`[anthropic-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
            }
        });
        server.on('error', (err) => finish(null, new Error(`[anthropic-oauth] callback server failed on ${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}: ${err?.message || err}`)));
    });

    return {
        provider: 'anthropic-oauth',
        url: url.toString(),
        manualUrl: manualUrl.toString(),
        waitForCallback,
        completeCode: async (input) => {
            const parsed = _parseOAuthCodeInput(input);
            if (parsed.state && parsed.state !== state) throw new Error('[anthropic-oauth] OAuth state mismatch');
            const redirectUri = parsed.redirectUri || (parsed.state ? OAUTH_MANUAL_REDIRECT_URI : OAUTH_REDIRECT_URI);
            const tokens = await exchangeAuthorizationCode({ pkce, code: parsed.code, state, redirectUri });
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

// Additive exports for test harnesses.
// Lets the SSE parser be exercised in isolation against a synthetic
// ReadableStream without needing a live OAuth session.
export { parseSSEStream };
