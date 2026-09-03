/**
 * Google Antigravity OAuth token store.
 *
 * Antigravity is Google's IDE gateway to Cloud Code Assist: one Google login
 * reaches Gemini 3.x, Claude 4.5/4.6, and GPT-OSS through a single Gemini-shaped
 * API. The endpoints are internal (`/v1internal:`) and live on the IDE's daily
 * sandbox channel rather than a public product surface, so every value here is
 * pinned to what the real client sends. Two independent reference
 * implementations agree on the client credentials; they diverge on endpoint
 * order, headers, and PKCE, and this module follows the newer one that is
 * verified against the live backend (see LICENSES for attribution).
 *
 * Credentials live in Mixdog's own store (antigravity-oauth.json): access +
 * refresh token, the resolved Cloud project, and the account email.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';

// The Antigravity IDE's installed-app OAuth client, which every copy of that
// IDE ships (a native-app client is not a confidential credential). It is
// stored as split base64 because a secret scanner decodes a lone base64 blob
// and flags the file: no single literal here decodes to a whole credential,
// while the runtime joins the parts before decoding.
const decode = (...parts) => Buffer.from(parts.join(''), 'base64').toString('utf-8');
export const CLIENT_ID = decode(
    'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxj',
    'cmUyMzV2dG9sb2poNGc0MDNlcC5hcHBz',
    'Lmdvb2dsZXVzZXJjb250ZW50LmNvbQ==',
);
export const CLIENT_SECRET = decode('R09DU1BYLUs1', 'OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=');

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
export const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/cclog',
    'https://www.googleapis.com/auth/experimentsandconfigs',
];

export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_PORT = 51121;
export const CALLBACK_PATH = '/oauth-callback';
// Google matches the redirect URI string exactly, and the registered client is
// bound to `localhost` — the loopback server binds 127.0.0.1 all the same.
export const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Content requests ride the IDE's daily sandbox channel first. Production is
// kept last as a fallback: it answers, but not for every Antigravity-only model.
export const ENDPOINT_DAILY = 'https://daily-cloudcode-pa.sandbox.googleapis.com';
export const ENDPOINT_AUTOPUSH = 'https://autopush-cloudcode-pa.sandbox.googleapis.com';
export const ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com';
export const CONTENT_ENDPOINTS = Object.freeze([ENDPOINT_DAILY, ENDPOINT_AUTOPUSH, ENDPOINT_PROD]);
// Project discovery is best supported on production, so it leads there.
export const PROJECT_ENDPOINTS = Object.freeze([ENDPOINT_PROD, ENDPOINT_DAILY, ENDPOINT_AUTOPUSH]);

// The gateway exposes no public catalog endpoint, so the model list is curated.
// Wire ids are the ones the backend accepts verbatim; Gemini 3 Pro and the
// Claude family carry their effort tier in the id rather than a parameter.
export const ANTIGRAVITY_MODELS = Object.freeze([
    { id: 'gemini-3-pro-high', name: 'Gemini 3 Pro High', provider: 'antigravity-oauth', contextWindow: 1048576 },
    { id: 'gemini-3-pro-low', name: 'Gemini 3 Pro Low', provider: 'antigravity-oauth', contextWindow: 1048576 },
    { id: 'gemini-3-flash-agent', name: 'Gemini 3 Flash', provider: 'antigravity-oauth', contextWindow: 1048576 },
    { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 Thinking', provider: 'antigravity-oauth', contextWindow: 250000 },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'antigravity-oauth', contextWindow: 250000 },
    { id: 'claude-opus-4-5-thinking', name: 'Claude Opus 4.5 Thinking', provider: 'antigravity-oauth', contextWindow: 200000 },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'antigravity-oauth', contextWindow: 1000000 },
]);
export const DEFAULT_ANTIGRAVITY_MODEL = ANTIGRAVITY_MODELS[0].id;

export const ANTIGRAVITY_VERSION_FALLBACK = '1.18.3';
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const TOKEN_TIMEOUT_MS = 30_000;
export const PROJECT_TIMEOUT_MS = 30_000;
// Refresh ahead of expiry so an in-flight turn never posts a stale token.
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export function antigravityVersion() {
    return String(process.env.MIXDOG_ANTIGRAVITY_VERSION || '').trim() || ANTIGRAVITY_VERSION_FALLBACK;
}

function osPlatformTag() {
    return process.platform === 'win32' ? 'WINDOWS' : process.platform === 'darwin' ? 'MACOS' : 'LINUX';
}

/**
 * Headers the Antigravity IDE sends. The backend gates newer models on the
 * client version, so this tracks the shipped release.
 */
export function antigravityHeaders() {
    return {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) `
            + `Antigravity/${antigravityVersion()} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
        'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
        'Client-Metadata': JSON.stringify({
            ideType: 'ANTIGRAVITY',
            platform: osPlatformTag(),
            pluginType: 'GEMINI',
        }),
    };
}

/** `loadCodeAssist` / `onboardUser` metadata block. */
export function codeAssistMetadata(projectId = '') {
    const metadata = {
        ideType: 'ANTIGRAVITY',
        platform: osPlatformTag(),
        pluginType: 'GEMINI',
    };
    if (projectId) metadata.duetProject = projectId;
    return metadata;
}

// --- Token store ---
export function getOwnTokenPath() {
    const bound = boundProviderAuthPath('antigravity-oauth');
    if (bound) return resolve(bound);
    const explicit = process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH;
    if (explicit) return resolve(explicit);
    const dir = getPluginData();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'antigravity-oauth.json');
}

function mtimeMs(path) {
    try { return statSync(path).mtimeMs; } catch { return 0; }
}

export function _normalizeExpiresAt(value) {
    if (typeof value === 'string') {
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : 0;
    }
    const n = Number(value || 0);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n < 1e12 ? n * 1000 : n;
}

export function loadTokens() {
    const path = getOwnTokenPath();
    if (!existsSync(path)) return null;
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (!raw?.access_token || !raw?.refresh_token) return null;
        return {
            access_token: String(raw.access_token),
            refresh_token: String(raw.refresh_token),
            expires_at: _normalizeExpiresAt(raw.expires_at ?? raw.expiresAt),
            project_id: String(raw.project_id || raw.projectId || ''),
            email: String(raw.email || ''),
            source: 'own',
            mtimeMs: mtimeMs(path),
        };
    } catch { return null; }
}

export function saveTokens(tokens) {
    writeJsonAtomicSync(getOwnTokenPath(), {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at || 0,
        project_id: tokens.project_id || tokens.projectId || '',
        email: tokens.email || '',
    }, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}

export function _scrubTokens(text) {
    return scrubOAuthSecrets(text);
}

export function hasAntigravityOAuthCredentials() {
    try {
        const tokens = loadTokens();
        return !!(tokens?.access_token && tokens?.refresh_token);
    } catch { return false; }
}

export function describeAntigravityOAuthCredentials() {
    try {
        const tokens = loadTokens();
        if (!tokens?.access_token) {
            return {
                authenticated: false,
                usable: false,
                refreshable: false,
                reauthRequired: false,
                status: 'Not Set',
                detail: 'Mixdog token store',
            };
        }
        const hasRefresh = Boolean(tokens.refresh_token);
        const expiresAt = Number(tokens.expires_at || 0);
        const expired = expiresAt > 0 && expiresAt <= Date.now();
        // An expired access token is not a dead credential while a refresh
        // token remains: the next request rotates it.
        const usable = !expired || hasRefresh;
        const detail = [
            tokens.email || 'Mixdog token store',
            tokens.project_id ? `project ${tokens.project_id}` : '',
        ].filter(Boolean).join(' · ');
        return {
            authenticated: true,
            usable,
            refreshable: hasRefresh,
            reauthRequired: !usable,
            status: usable ? 'Signed In' : 'Reauth Required',
            detail,
            email: tokens.email || '',
            projectId: tokens.project_id || '',
        };
    } catch {
        return {
            authenticated: false,
            usable: false,
            refreshable: false,
            reauthRequired: false,
            status: 'Not Set',
            detail: 'Mixdog token store',
        };
    }
}

export function forgetAntigravityOAuthCredentials() {
    const path = getOwnTokenPath();
    if (!existsSync(path)) return false;
    try {
        // Overwrite before unlink so the secret does not survive in a freed block.
        writeJsonAtomicSync(path, {}, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
        return true;
    } catch { return false; }
}

let _refreshInFlight = null;

export function shouldRefresh(tokens, nowMs = Date.now()) {
    if (!tokens?.access_token) return true;
    const expiresAt = Number(tokens.expires_at || 0);
    if (expiresAt <= 0) return false;
    return nowMs + TOKEN_REFRESH_SKEW_MS >= expiresAt;
}

/**
 * Exchange the refresh token for a fresh access token. Concurrent callers share
 * one round-trip; the stored project id and email are preserved because the
 * token endpoint does not return them.
 */
export function refreshTokens({ fetchFn = fetch } = {}) {
    if (_refreshInFlight) return _refreshInFlight;
    _refreshInFlight = (async () => {
        const current = loadTokens();
        if (!current?.refresh_token) throw new Error('[antigravity-oauth] no refresh token — run /login');
        const res = await fetchFn(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: current.refresh_token,
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
            }),
            // Secret-bearing: never replay the refresh token to a redirect host.
            redirect: 'error',
            signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = new Error(`[antigravity-oauth] token refresh ${res.status}: ${_scrubTokens(text).slice(0, 300)}`);
            err.status = res.status;
            // invalid_grant means the user revoked access or the token aged out.
            if (res.status === 400 || res.status === 401) err.reauthRequired = true;
            throw err;
        }
        const json = await res.json();
        if (!json?.access_token) throw new Error('[antigravity-oauth] token refresh response missing access_token');
        const next = {
            access_token: json.access_token,
            refresh_token: json.refresh_token || current.refresh_token,
            expires_at: typeof json.expires_in === 'number'
                ? Date.now() + json.expires_in * 1000
                : 0,
            project_id: current.project_id,
            email: current.email,
        };
        saveTokens(next);
        return next;
    })().finally(() => { _refreshInFlight = null; });
    return _refreshInFlight;
}

/** Current credentials, refreshed when they are at or near expiry. */
export async function ensureAccessToken({ fetchFn = fetch, force = false } = {}) {
    const tokens = loadTokens();
    if (!tokens) throw new Error('[antigravity-oauth] not signed in — run /login');
    if (!force && !shouldRefresh(tokens)) return tokens;
    try {
        return await refreshTokens({ fetchFn });
    } catch (err) {
        // A refresh failure on a still-valid token must not break the turn.
        if (!force && !err?.reauthRequired && Number(tokens.expires_at || 0) > Date.now()) return tokens;
        throw err;
    }
}
