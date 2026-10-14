// Command Code credentials: a non-expiring Provider API key issued by the
// Studio CLI sign-in. There is no refresh grant — a 401 means the user signs
// in again. Stored in Mixdog's own token file (command-code-oauth.json), one
// file per connected account.
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { accountIdentityFields, fileMtimeMs, scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';
import { modelProxyClientMode } from '../../../shared/model-proxy-mode.mjs';

export const PROVIDER_ID = 'command-code-oauth';
export const STUDIO_ORIGIN = 'https://commandcode.ai';
// The only origin the API key is ever sent to.
export const API_ORIGIN = 'https://api.commandcode.ai';
export const PROVIDER_BASE_URL = `${API_ORIGIN}/provider/v1`;
export const WHOAMI_URL = `${API_ORIGIN}/alpha/whoami`;
export const CREDITS_URL = `${API_ORIGIN}/alpha/billing/credits`;
export const LOGIN_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_API_KEY_LEN = 512;

export function getOwnTokenPath() {
  const bound = boundProviderAuthPath(PROVIDER_ID);
  if (bound) return resolve(bound);
  const explicit = process.env.COMMAND_CODE_OAUTH_CREDENTIALS_PATH;
  if (explicit) return resolve(explicit);
  const dir = getPluginData();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'command-code-oauth.json');
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** A key is one printable-ASCII token of bounded length; anything else is rejected before use. */
export function isWellFormedApiKey(value) {
  return typeof value === 'string' && value.length <= MAX_API_KEY_LEN && /^[\x21-\x7e]+$/.test(value);
}

export function loadTokens() {
  if (modelProxyClientMode()) return null;
  const path = getOwnTokenPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    const apiKey = text(raw?.apiKey);
    if (!apiKey) return null;
    return { apiKey, userId: text(raw.userId), userName: text(raw.userName), mtimeMs: fileMtimeMs(path) };
  } catch {
    return null;
  }
}

export function saveTokens({ apiKey, userId, userName }) {
  const tokens = { apiKey, userId: text(userId), userName: text(userName) };
  writeJsonAtomicSync(getOwnTokenPath(), tokens, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
  return tokens;
}

export function commandCodeReauthError(detail = '') {
  return Object.assign(
    new Error(
      `[command-code-oauth] API key rejected (401) — open /providers in mixdog to sign in again${detail ? `: ${detail}` : ''}`
    ),
    { httpStatus: 401, status: 401, reauthRequired: true }
  );
}

/**
 * GET a Command Code API endpoint with the key. Refuses any URL outside
 * API_ORIGIN and never follows redirects, so the key cannot leave that host.
 */
export async function requestCommandCodeJson(url, apiKey, { fetchImpl = fetch, signal = null } = {}) {
  const target = new URL(url);
  if (target.origin !== API_ORIGIN)
    throw new Error(`[command-code-oauth] refusing to send the API key to ${target.host}`);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetchImpl(target.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    const detail = scrubOAuthSecrets(body, [apiKey]).trim().slice(0, 300);
    if (res.status === 401) throw commandCodeReauthError(detail);
    throw Object.assign(
      new Error(`[command-code-oauth] ${target.pathname} ${res.status}${detail ? `: ${detail}` : ''}`),
      { status: res.status, httpStatus: res.status }
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`[command-code-oauth] ${target.pathname} returned invalid JSON`);
  }
}

/** The account behind a key: whoami's user id is the stable account identity. */
export async function fetchCommandCodeIdentity(apiKey, options = {}) {
  const body = await requestCommandCodeJson(WHOAMI_URL, apiKey, options);
  const user = body?.user;
  const userId = text(user?.id);
  if (!userId) throw new Error('[command-code-oauth] whoami returned no user id');
  return { userId, userName: text(user?.userName) };
}

export function hasCommandCodeOAuthCredentials() {
  try {
    return Boolean(loadTokens()?.apiKey);
  } catch {
    return false;
  }
}

export function describeCommandCodeOAuthCredentials() {
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
      ...accountIdentityFields({ id: tokens.userId }),
      ...(tokens.userName ? { accountId: tokens.userName } : {}),
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

export function forgetCommandCodeOAuthCredentials() {
  const path = getOwnTokenPath();
  if (!existsSync(path)) return { removed: false };
  unlinkSync(path);
  return { removed: true };
}
