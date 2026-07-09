/**
 * Anthropic OAuth credential store + PKCE login flow.
 *
 * Split out of anthropic-oauth.mjs (section-scoped extraction). Owns the
 * on-disk credentials file (load/save/refresh/forget) and the loopback
 * PKCE login flow. anthropic-oauth.mjs imports these back and re-exports
 * the public functions so external callers keep their existing import path.
 */
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
import { randomBytes, createHash } from 'crypto';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';

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
export const TOKEN_URL = assertSafeTokenURL(process.env.ANTHROPIC_OAUTH_TOKEN_URL || 'https://platform.claude.com/v1/oauth/token');
export const DEFAULT_CREDENTIALS_PATH = join(resolvePluginData(), 'anthropic-oauth-credentials.json');
export const CLAUDE_CODE_CLIENT_ID = process.env.ANTHROPIC_OAUTH_CLIENT_ID || '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
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

export const DEFAULT_CLI_VERSION = '2.1.77';

export function resolveCliVersion() {
    return process.env.MIXDOG_CLI_VERSION
        || DEFAULT_CLI_VERSION;
}

// --- Credential helpers ---

function _pushUnique(list, value) {
    if (!value || typeof value !== 'string') return;
    if (!list.includes(value)) list.push(value);
}

export function credentialCandidates() {
    const paths = [];
    _pushUnique(paths, process.env.ANTHROPIC_OAUTH_CREDENTIALS_PATH);
    _pushUnique(paths, DEFAULT_CREDENTIALS_PATH);
    return paths;
}

// Fallback expiry from the access_token's JWT `exp` claim (epoch ms) when the
// credentials file carries no explicit expiresAt — without it expiresAt stays 0,
// which ensureAuth reads as "never expires", disabling proactive refresh. Claude
// OAuth tokens are opaque so this returns 0 and the file's expiresAt governs.
// JWT `exp` is epoch SECONDS (RFC 7519).
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
export function _saveCredentialsFile(path, raw) {
    // Secret file, not parent-dir ACL mutation. `secret: true` clamps the file
    // itself on Windows; it deliberately leaves the data dir inheritance alone.
    writeJsonAtomicSync(path, raw, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}

// Cheap stat-only probe so ensureAuth can detect Mixdog-updated credentials
// without paying a full JSON read every call.
export function _credentialsMaxMtime() {
    let max = 0;
    for (const p of credentialCandidates()) {
        try {
            const s = statSync(p);
            if (s.mtimeMs > max) max = s.mtimeMs;
        } catch { /* not present — skip */ }
    }
    return max;
}

export function loadCredentials() {
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

export function _normalizeExpiresAt(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
    return value < 1e12 ? value * 1000 : value;
}

export function _scrubTokens(text) {
    return String(text || '')
        .replace(/Bearer [A-Za-z0-9._\-]+/g, 'Bearer [REDACTED]')
        .replace(/sk-ant-[A-Za-z0-9._\-]+/g, '[REDACTED]')
        .replace(/"access[Tt]oken"\s*:\s*"[^"]+"/g, '"accessToken":"[REDACTED]"')
        .replace(/"refresh[Tt]oken"\s*:\s*"[^"]+"/g, '"refreshToken":"[REDACTED]"')
        .replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token":"[REDACTED]"')
        .replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"[REDACTED]"');
}

export async function refreshOAuthCredentials(creds) {
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
    const openLoginUrl = async (targetUrl, label = 'login') => {
        try {
            const { openInBrowser } = await import('../../../shared/open-url.mjs');
            openInBrowser(targetUrl.toString());
        } catch (err) {
            process.stderr.write(`[anthropic-oauth] browser open failed for ${label} URL: ${String(err?.message || err).slice(0, 200)}\n`);
        }
    };

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
            await openLoginUrl(url, 'callback');
        });
        server.on('error', async (err) => {
            process.stderr.write(`\n[anthropic-oauth] localhost callback unavailable on ${OAUTH_CALLBACK_HOST}:${OAUTH_CALLBACK_PORT}: ${err?.message || err}\n[anthropic-oauth] Opening manual login URL instead. Paste the shown code#state:\n${manualUrl.toString()}\n\n`);
            await openLoginUrl(manualUrl, 'manual');
        });
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
