// OpenCode Go OAuth credentials: an OpenCode Console device-flow login
// (client `opencode-cli`) yields a refreshable access token bound to one
// Console organization. The token reads the organization's remote config
// (`/api/v2/config`), whose `opencode-go` provider names the inference base
// URL, the request headers and the model catalog, and the Go usage meters
// (`/api/go/status`). Stored in Mixdog's own opencode-go-oauth.json, one file
// per connected account.
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getPluginData } from '../config.mjs';
import {
  updateJsonAtomicSync,
  withFileLock,
  withFileLockSync,
  writeJsonAtomicSync,
} from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { modelProxyClientMode, serverModelCredentialsDisabledError } from '../../../shared/model-proxy-mode.mjs';
import {
  accountIdentityFields,
  fileMtimeMs,
  oauthCredentialStatus,
  scrubOAuthSecrets,
} from './lib/oauth-token-utils.mjs';

export const PROVIDER_ID = 'opencode-go-oauth';
export const SERVER = 'https://opencode.ai/console';
export const CLIENT_ID = 'opencode-cli';
export const DEVICE_CODE_URL = `${SERVER}/auth/device/code`;
export const DEVICE_TOKEN_URL = `${SERVER}/auth/device/token`;
export const USER_URL = `${SERVER}/api/user`;
export const ORGS_URL = `${SERVER}/api/orgs`;
export const CONFIG_URL = `${SERVER}/api/v2/config`;
export const STATUS_URL = `${SERVER}/api/go/status`;
// The remote config's provider entry this login serves (`opencode` is Zen).
export const CONFIG_PROVIDER_KEY = 'opencode-go';
// Used only when the remote config names no base URL.
export const FALLBACK_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
export const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = 'mixdog';

export function getOwnTokenPath() {
  const bound = boundProviderAuthPath(PROVIDER_ID);
  if (bound) return resolve(bound);
  const explicit = process.env.OPENCODE_GO_OAUTH_CREDENTIALS_PATH;
  if (explicit) return resolve(explicit);
  const dir = getPluginData();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'opencode-go-oauth.json');
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

export const isValidOpenCodeGoCredentialDocument = (doc) =>
  Boolean(text(doc?.access_token) && text(doc?.refresh_token));

export function openCodeGoError(message, meta = {}) {
  return Object.assign(new Error(message), meta);
}

export function openCodeGoReauthError(detail, status = 401) {
  return openCodeGoError(
    `[${PROVIDER_ID}] invalid_grant: OpenCode sign-in expired${detail ? ` (${detail})` : ''} — open /providers in mixdog to sign in again`,
    { status, reauthRequired: true, kind: 'reauth' }
  );
}

export function loadTokens() {
  if (modelProxyClientMode()) return null;
  const path = getOwnTokenPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isValidOpenCodeGoCredentialDocument(raw)) return null;
    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token,
      expires_at: Number(raw.expires_at) || 0,
      account_id: text(raw.account_id),
      email: text(raw.email),
      org_id: text(raw.org_id),
      org_name: text(raw.org_name),
      mtimeMs: fileMtimeMs(path),
    };
  } catch {
    return null;
  }
}

const tokenDocument = (tokens) => ({
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token,
  expires_at: Number(tokens.expires_at) || 0,
  ...(text(tokens.account_id) ? { account_id: text(tokens.account_id) } : {}),
  ...(text(tokens.email) ? { email: text(tokens.email) } : {}),
  ...(text(tokens.org_id) ? { org_id: text(tokens.org_id) } : {}),
  ...(text(tokens.org_name) ? { org_name: text(tokens.org_name) } : {}),
});

export function saveTokens(tokens) {
  const doc = tokenDocument(tokens);
  writeJsonAtomicSync(getOwnTokenPath(), doc, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
  return { ...doc, mtimeMs: fileMtimeMs(getOwnTokenPath()) };
}

// Stores `tokens` only over the very credential `previous` was read from,
// compared under the store's write lock: a sign-in that replaced it, or a
// sign-out that removed it, meanwhile is kept and the stored state returned.
function replaceTokens(previous, tokens) {
  const path = getOwnTokenPath();
  const doc = tokenDocument(tokens);
  let replaced = false;
  updateJsonAtomicSync(
    path,
    (current) => {
      if (current?.access_token !== previous.access_token || current?.refresh_token !== previous.refresh_token) {
        return undefined;
      }
      replaced = true;
      return doc;
    },
    { fsyncDir: true, mode: 0o600, secret: true }
  );
  if (replaced) return { ...doc, mtimeMs: fileMtimeMs(path) };
  const current = loadTokens();
  if (!current) throw openCodeGoReauthError('credentials removed');
  return current;
}

export function hasOpenCodeGoOAuthCredentials() {
  try {
    return Boolean(loadTokens());
  } catch {
    return false;
  }
}

export function describeOpenCodeGoOAuthCredentials() {
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
      ...oauthCredentialStatus({
        hasRefresh: true,
        expiresAt: tokens.expires_at,
        detail: tokens.org_name ? `OpenCode Console · ${tokens.org_name}` : 'OpenCode Console',
        refreshSkewMs: TOKEN_REFRESH_SKEW_MS,
      }),
      ...accountIdentityFields({ id: tokens.account_id, email: tokens.email }),
      ...(tokens.org_id ? { orgId: tokens.org_id } : {}),
      ...(tokens.org_name ? { orgName: tokens.org_name } : {}),
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

export function forgetOpenCodeGoOAuthCredentials() {
  const path = getOwnTokenPath();
  // Under the store's write lock, so a refresh finishing now cannot restore it.
  return withFileLockSync(
    `${path}.lock`,
    () => {
      if (!existsSync(path)) return { removed: false };
      unlinkSync(path);
      return { removed: true };
    },
    { secret: true }
  );
}

/** Console bearer headers: the access token plus the organization it acts for. */
export function consoleHeaders(tokens) {
  return {
    Authorization: `Bearer ${tokens.access_token}`,
    ...(tokens.org_id ? { 'x-org-id': tokens.org_id } : {}),
  };
}

/**
 * One JSON request to the Console. Never follows a redirect (the request
 * carries a token); resolves `{ res, json, text }` whatever the status.
 */
export async function consoleRequest(url, { method = 'GET', headers = {}, body, fetchFn = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetchFn(url, {
    method,
    headers: {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    dispatcher: getLlmDispatcher(),
  });
  const textBody = await res.text();
  let json = null;
  try {
    json = textBody ? JSON.parse(textBody) : null;
  } catch {
    /* non-JSON body: callers report the status */
  }
  return { res, json, text: textBody };
}

/**
 * Authenticated Console GET; a 401 is a reauth error, any other failure
 * carries its status. `refresh` (a stored credential's read) first refreshes
 * once and retries (withConsoleTokenRetry); a login's fresh grant, not yet
 * stored, has nothing to refresh.
 */
export async function consoleGetJson(url, tokens, { fetchFn, signal, refresh = false } = {}) {
  if (refresh) {
    return await withConsoleTokenRetry(tokens, (current) => consoleGetJson(url, current, { fetchFn, signal }), {
      fetchFn,
    });
  }
  const { res, json, text: body } = await consoleRequest(url, { headers: consoleHeaders(tokens), fetchFn, signal });
  if (res.status === 401) throw openCodeGoReauthError(`${new URL(url).pathname} 401`);
  if (!res.ok || json === null) {
    const detail = scrubOAuthSecrets(body, [tokens.access_token, tokens.refresh_token]).trim().slice(0, 300);
    throw openCodeGoError(`[${PROVIDER_ID}] ${new URL(url).pathname} ${res.status}${detail ? `: ${detail}` : ''}`, {
      status: res.status,
    });
  }
  return json;
}

/** Token fields from a device/refresh grant response (`expires_in` seconds). */
export function tokenFieldsFromGrant(json, now = Date.now()) {
  const access = text(json?.access_token);
  const refresh = text(json?.refresh_token);
  if (!access || !refresh) {
    throw openCodeGoError(`[${PROVIDER_ID}] token response is missing access_token or refresh_token`, {
      kind: 'validation',
    });
  }
  const expiresIn = Number(json?.expires_in);
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : 0,
    ...(text(json?.org_id) ? { org_id: text(json.org_id) } : {}),
  };
}

async function postRefresh(tokens, { fetchFn } = {}) {
  const {
    res,
    json,
    text: body,
  } = await consoleRequest(DEVICE_TOKEN_URL, {
    method: 'POST',
    body: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: CLIENT_ID },
    fetchFn,
  });
  if (!res.ok) {
    const oauthError = text(json?.error).toLowerCase();
    if (oauthError === 'invalid_grant' || res.status === 401)
      throw openCodeGoReauthError('refresh rejected', res.status);
    const detail = scrubOAuthSecrets(body, [tokens.access_token, tokens.refresh_token]).trim().slice(0, 200);
    throw openCodeGoError(`[${PROVIDER_ID}] token refresh ${res.status}${detail ? `: ${detail}` : ''}`, {
      status: res.status,
    });
  }
  const granted = tokenFieldsFromGrant(json);
  // A grant naming another organization moves the account to it; its name is
  // then unknown until the next sign-in.
  const orgChanged = granted.org_id && granted.org_id !== tokens.org_id;
  return replaceTokens(tokens, {
    ...tokens,
    ...granted,
    org_id: granted.org_id || tokens.org_id,
    org_name: orgChanged ? granted.org_id : tokens.org_name,
  });
}

/**
 * Refresh under a cross-process lease: a waiter that finds a newer generation
 * on disk adopts it instead of spending the refresh token again.
 */
export async function refreshTokens(tokens, { force = false, fetchFn } = {}) {
  if (modelProxyClientMode()) throw serverModelCredentialsDisabledError('OpenCode Go OAuth credentials');
  return withFileLock(
    `${getOwnTokenPath()}.refresh.lock`,
    async () => {
      const disk = loadTokens();
      if (!disk) throw openCodeGoReauthError('credentials removed');
      const validAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
      const rotated = disk.access_token !== tokens.access_token || disk.refresh_token !== tokens.refresh_token;
      if (rotated && (!disk.expires_at || disk.expires_at >= validAfter)) return disk;
      return await postRefresh(disk, { fetchFn });
    },
    { timeoutMs: 60_000, staleMs: 60_000, secret: true }
  );
}

/**
 * An authenticated Console read of the stored credential that outlives one
 * stale access token: a 401 refreshes once (a newer stored generation is
 * adopted instead of spending the refresh token again) and reads again. Only
 * a second 401, or a refresh the server rejects, asks for a new sign-in.
 */
export async function withConsoleTokenRetry(tokens, read, { fetchFn } = {}) {
  try {
    return await read(tokens);
  } catch (err) {
    if (Number(err?.status) !== 401) throw err;
  }
  const next = await refreshTokens(tokens, { force: true, fetchFn });
  if (next.account_id !== tokens.account_id || next.org_id !== tokens.org_id) {
    throw openCodeGoError(`[${PROVIDER_ID}] the OpenCode sign-in changed during the request`, { kind: 'superseded' });
  }
  try {
    return await read(next);
  } catch (err) {
    if (Number(err?.status) === 401 && !err.reauthRequired) throw openCodeGoReauthError('console 401');
    throw err;
  }
}

/** The stored credential, refreshed when it is about to expire (or `force`). */
export async function ensureFreshTokens({ force = false, fetchFn } = {}) {
  const tokens = loadTokens();
  if (!tokens) {
    throw openCodeGoError(`[${PROVIDER_ID}] credentials not found — open /providers in mixdog to sign in first`, {
      status: 401,
    });
  }
  const expiring = tokens.expires_at > 0 && tokens.expires_at < Date.now() + TOKEN_REFRESH_SKEW_MS;
  return force || expiring ? await refreshTokens(tokens, { force, fetchFn }) : tokens;
}
