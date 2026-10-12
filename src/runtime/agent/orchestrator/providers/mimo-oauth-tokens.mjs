// MiMo subscription credentials: a long-lived API key minted by the MiMo
// platform authorize flow. There is no refresh grant — a 401 means the user
// has to sign in again. Stored in Mixdog's own token file (mimo-oauth.json).
import { randomBytes } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { accountIdentityFields, fileMtimeMs, scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';

const DEFAULT_PLATFORM_ORIGIN = 'https://platform.xiaomimimo.com';
const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1';
export const DEFAULT_MODEL = 'mimo-v2.6-pro';
export const SOURCE_HEADER = Object.freeze({ 'X-Mimo-Source': 'mimocode-cli' });
export const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_PLAN_KEY_PREFIX = 'tp-';
// Probe order for a Token Plan key that arrives without a gateway URL.
export const TOKEN_PLAN_BASE_URLS = Object.freeze(
  ['sgp', 'ams', 'cn'].map((region) => `https://token-plan-${region}.xiaomimimo.com/v1`)
);
const TOKEN_PLAN_PROBE_TIMEOUT_MS = 15_000;
const TOKEN_PLAN_PROBE_MODEL = 'mimo-v2.5';
// The only hosts an API key may be sent to: the default gateway and the Token
// Plan regional gateways. Derived from the constants above so they cannot drift.
const MIMO_API_HOSTS = new Set([DEFAULT_BASE_URL, ...TOKEN_PLAN_BASE_URLS].map((url) => new URL(url).hostname));
const MAX_BASE_URL_LENGTH = 2048;
const SAFE_BASE_PATH = /^(?:\/[A-Za-z0-9._~-]+)*\/?$/;

/**
 * A gateway URL from the authorization payload, validated against the Xiaomi
 * MiMo API host allowlist: HTTPS, no credentials, default port, no query or
 * fragment. Returns it without a trailing slash; throws otherwise.
 */
export function normalizeMimoBaseUrl(value) {
  const reject = () =>
    new Error('[mimo-oauth] authorization payload carried a gateway URL outside the Xiaomi MiMo API hosts');
  if (typeof value !== 'string' || value.length > MAX_BASE_URL_LENGTH) throw reject();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw reject();
  }
  if (
    url.protocol !== 'https:' ||
    !MIMO_API_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !SAFE_BASE_PATH.test(url.pathname)
  ) {
    throw reject();
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// Read per call so MIMO_PLATFORM_URL can point every login URL at another host.
function platformOrigin() {
  const override = String(process.env.MIMO_PLATFORM_URL || '')
    .trim()
    .replace(/\/+$/, '');
  return override || DEFAULT_PLATFORM_ORIGIN;
}
export const authorizeEndpoint = () => `${platformOrigin()}/authorize`;
export const manualRedirectUri = () => `${platformOrigin()}/authorize/code/callback`;
export const resultUrl = () => `${platformOrigin()}/authorize/callback`;

function dataDir() {
  const dir = getPluginData();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function getOwnTokenPath() {
  const bound = boundProviderAuthPath('mimo-oauth');
  if (bound) return resolve(bound);
  const explicit = process.env.MIMO_OAUTH_CREDENTIALS_PATH;
  if (explicit) return resolve(explicit);
  return join(dataDir(), 'mimo-oauth.json');
}

// Key name shown on the MiMo platform. Generated once, then reused so repeated
// sign-ins replace one key instead of piling up new ones.
export function getKeyName() {
  const path = join(dataDir(), 'mimo-oauth-key-name.json');
  try {
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof saved?.keyName === 'string' && saved.keyName) return saved.keyName;
  } catch {
    /* generate below */
  }
  const keyName = `mimo-code-cli-key-${randomBytes(4).toString('hex')}`;
  writeJsonAtomicSync(path, { keyName }, { lock: true, mode: 0o600 });
  return keyName;
}

export function loadTokens() {
  const path = getOwnTokenPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!raw?.apiKey) return null;
    return {
      apiKey: String(raw.apiKey),
      uid: raw.uid ? String(raw.uid) : '',
      baseUrl: raw.baseUrl || DEFAULT_BASE_URL,
      source: 'own',
      mtimeMs: fileMtimeMs(path),
    };
  } catch {
    return null;
  }
}

export function saveTokens({ apiKey, uid, baseUrl }) {
  const tokens = { apiKey, uid: uid ? String(uid) : '', baseUrl: baseUrl || DEFAULT_BASE_URL };
  writeJsonAtomicSync(getOwnTokenPath(), tokens, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
  return tokens;
}

// Find the regional gateway that accepts a Token Plan key. Each endpoint gets
// its own fresh timeout so one slow region cannot starve the next; a 401 or a
// failure of any kind moves on (only caller cancellation stops); the last error
// is reported when every region fails.
export async function probeTokenPlanBaseUrl(apiKey, { fetchImpl = fetch, signal = null } = {}) {
  let lastError = null;
  let allRejected = true;
  for (const baseUrl of TOKEN_PLAN_BASE_URLS) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(TOKEN_PLAN_PROBE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...SOURCE_HEADER },
        body: JSON.stringify({
          model: TOKEN_PLAN_PROBE_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.ok) return baseUrl;
      const detail = scrubOAuthSecrets(await res.text().catch(() => ''), [apiKey])
        .trim()
        .slice(0, 300);
      lastError = Object.assign(
        new Error(`[mimo-oauth] Token Plan check failed (${res.status})${detail ? `: ${detail}` : ''}`),
        { status: res.status, httpStatus: res.status, detail }
      );
      if (res.status !== 401) allRejected = false;
    } catch (err) {
      if (signal?.aborted) throw err;
      allRejected = false;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  if (lastError && allRejected) throw mimoReauthError(lastError.detail);
  throw lastError || new Error('[mimo-oauth] Token Plan check failed');
}

// A rejected key needs a fresh sign-in; shared by the probe and the send path.
export function mimoReauthError(detail = '') {
  return Object.assign(
    new Error(
      `[mimo-oauth] API key rejected (401) — open /providers in mixdog to sign in again${detail ? `: ${detail}` : ''}`
    ),
    { httpStatus: 401, status: 401, reauthRequired: true }
  );
}

// A Token Plan key whose gateway URL is unknown is resolved once and persisted.
export async function ensureTokenPlanBaseUrl(tokens, options = {}) {
  const needsProbe =
    tokens.apiKey.startsWith(TOKEN_PLAN_KEY_PREFIX) && (!tokens.baseUrl || tokens.baseUrl === DEFAULT_BASE_URL);
  if (!needsProbe) return tokens;
  const { persist = true, ...probeOptions } = options;
  const baseUrl = await probeTokenPlanBaseUrl(tokens.apiKey, probeOptions);
  // The probe awaited the network; only write back if the stored credential is
  // still the one that was probed (a newer sign-in must not be overwritten).
  const current = persist ? loadTokens() : null;
  if (current && current.apiKey === tokens.apiKey && current.uid === (tokens.uid || '')) {
    saveTokens({ apiKey: tokens.apiKey, uid: tokens.uid, baseUrl });
  }
  return { ...tokens, baseUrl };
}

export function hasMimoOAuthCredentials() {
  try {
    return Boolean(loadTokens()?.apiKey);
  } catch {
    return false;
  }
}

export function describeMimoOAuthCredentials() {
  try {
    const tokens = loadTokens();
    if (!tokens) {
      return {
        authenticated: false,
        usable: false,
        refreshable: false,
        reauthRequired: false,
        status: 'Not Set',
        detail: 'Mixdog token store',
      };
    }
    return {
      authenticated: true,
      usable: true,
      refreshable: false,
      reauthRequired: false,
      status: 'Valid',
      detail: 'Mixdog token store; API key',
      expiresAt: 0,
      ...accountIdentityFields({ id: tokens.uid }),
    };
  } catch (err) {
    return {
      authenticated: false,
      usable: false,
      refreshable: false,
      reauthRequired: false,
      status: 'Error',
      detail: String(err?.message || err).slice(0, 200),
    };
  }
}

export function forgetMimoOAuthCredentials() {
  const path = getOwnTokenPath();
  if (!existsSync(path)) return { removed: false };
  unlinkSync(path);
  return { removed: true };
}
