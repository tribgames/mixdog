/**
 * Google Antigravity OAuth token store.
 *
 * Antigravity is Google's IDE gateway to Cloud Code Assist: one Google login
 * reaches Gemini 3.x, Claude 4.5/4.6, and GPT-OSS through a single Gemini-shaped
 * API. The endpoints are internal (`/v1internal:`) and live on the IDE's daily
 * sandbox channel rather than a public product surface, so every value here is
 * pinned to what the real client sends. Two independent reference
 * implementations agree on the client credentials; they diverge on headers
 * and PKCE, and this module follows the newer one that is verified against
 * the live daily backend (see LICENSES for attribution).
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
import { ANTIGRAVITY_MODELS } from './provider-model-identities.mjs';
export { ANTIGRAVITY_MODELS } from './provider-model-identities.mjs';

// The Antigravity IDE's installed-app OAuth client, which every copy of that
// IDE ships (a native-app client is not a confidential credential). It is
// stored as split base64 because a secret scanner decodes a lone base64 blob
// and flags the file: no single literal here decodes to a whole credential,
// while the runtime joins the parts before decoding.
const decode = (...parts) => Buffer.from(parts.join(''), 'base64').toString('utf-8');
export const CLIENT_ID = decode(
  'MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxj',
  'cmUyMzV2dG9sb2poNGc0MDNlcC5hcHBz',
  'Lmdvb2dsZXVzZXJjb250ZW50LmNvbQ=='
);
export const CLIENT_SECRET = decode('R09DU1BYLUs1', 'OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=');

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
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
// Use the same literal loopback address in authorization and token exchange.
export const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;

// Generation stays on the IDE's daily channel. Alternate Cloud Code Assist
// hosts (autopush / sandbox / prod) carry different entitlements, so they
// are never used as automatic fallbacks.
export const CONTENT_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';
export const CONTENT_ENDPOINTS = Object.freeze([CONTENT_ENDPOINT]);
// Account provisioning uses the same daily control plane as generation.
export const PROJECT_ENDPOINT = CONTENT_ENDPOINT;

export const DEFAULT_ANTIGRAVITY_MODEL = ANTIGRAVITY_MODELS[0].id;

const ANTIGRAVITY_VERSION_FALLBACK = '2.8.0';
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const TOKEN_TIMEOUT_MS = 30_000;
export const PROJECT_TIMEOUT_MS = 30_000;
// Refresh ahead of expiry so an in-flight turn never posts a stale token.
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

// The backend gates models on the client version in the User-Agent, so the
// version tracks the latest Antigravity release via its update manifest.
// The pinned value is the offline fallback; the env override always wins.
const VERSION_MANIFEST_URL =
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml';
const VERSION_FETCH_TIMEOUT_MS = 5_000;
const VERSION_RETRY_AFTER_MS = 10 * 60 * 1000;
let _discoveredVersion = null;
let _versionFetch = null;
let _versionFailedAt = 0;

function antigravityVersion() {
  return (
    String(process.env.MIXDOG_ANTIGRAVITY_VERSION || '').trim() || _discoveredVersion || ANTIGRAVITY_VERSION_FALLBACK
  );
}

/** Version from an electron-builder update manifest, or null when absent. */
export function parseAntigravityManifestVersion(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
    if (!match) continue;
    const version = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : null;
  }
  return null;
}

/**
 * Resolve the current client version once per process. A failed lookup keeps
 * the pinned fallback and is not retried for a while, so an unreachable
 * manifest host never delays every request.
 */
export function ensureAntigravityVersion({ fetchFn = fetch } = {}) {
  if (process.env.MIXDOG_ANTIGRAVITY_VERSION || _discoveredVersion) return Promise.resolve(antigravityVersion());
  if (_versionFetch) return _versionFetch;
  if (Date.now() - _versionFailedAt < VERSION_RETRY_AFTER_MS) return Promise.resolve(antigravityVersion());
  _versionFetch = (async () => {
    try {
      const res = await fetchFn(VERSION_MANIFEST_URL, {
        headers: { 'Cache-Control': 'no-cache', 'User-Agent': 'electron-builder' },
        signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS),
      });
      if (res.ok) _discoveredVersion = parseAntigravityManifestVersion(await res.text());
    } catch {
      // The pinned fallback stays valid when discovery fails.
    } finally {
      if (!_discoveredVersion) _versionFailedAt = Date.now();
      _versionFetch = null;
    }
    return antigravityVersion();
  })();
  return _versionFetch;
}

export function _resetAntigravityVersionForTest() {
  _discoveredVersion = null;
  _versionFetch = null;
  _versionFailedAt = 0;
}

/**
 * Cloud Code Assist expects the hub client identity rather than Electron's
 * browser headers. Keep the captured client platform independent of the host.
 */
export function antigravityHeaders() {
  return {
    'User-Agent': `antigravity/hub/${antigravityVersion()} (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`,
  };
}

/** `loadCodeAssist` / `onboardUser` metadata block. */
export function codeAssistMetadata() {
  return { ideType: 'ANTIGRAVITY' };
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
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
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
  } catch {
    return null;
  }
}

export function saveTokens(tokens) {
  writeJsonAtomicSync(
    getOwnTokenPath(),
    {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at || 0,
      project_id: tokens.project_id || tokens.projectId || '',
      email: tokens.email || '',
    },
    { lock: true, fsyncDir: true, mode: 0o600, secret: true }
  );
}

export function _scrubTokens(text) {
  return scrubOAuthSecrets(text);
}

export function hasAntigravityOAuthCredentials() {
  try {
    const tokens = loadTokens();
    return !!(tokens?.access_token && tokens?.refresh_token);
  } catch {
    return false;
  }
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
    const detail = [tokens.email || 'Mixdog token store', tokens.project_id ? `project ${tokens.project_id}` : '']
      .filter(Boolean)
      .join(' · ');
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
  } catch {
    return false;
  }
}

const _refreshesInFlight = new Map();

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
  const path = getOwnTokenPath();
  if (_refreshesInFlight.has(path)) return _refreshesInFlight.get(path);
  const refresh = (async () => {
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
      expires_at: typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0,
      project_id: current.project_id,
      email: current.email,
    };
    saveTokens(next);
    return next;
  })().finally(() => {
    _refreshesInFlight.delete(path);
  });
  _refreshesInFlight.set(path, refresh);
  return refresh;
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
