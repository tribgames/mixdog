/**
 * openai-oauth-tokens.mjs — ChatGPT OAuth credential store for openai-oauth.
 *
 * Extracted from openai-oauth.mjs: token path resolution, atomic persistence,
 * the refresh exchange, and the in-process + cross-process serialization that
 * keeps concurrent turns from racing a single-use refresh token. The provider
 * keeps only the send-path policy (when a refresh is due, how long a failed
 * refresh may coast on a still-valid token) and delegates every credential
 * mechanic here.
 *
 * openai-oauth.mjs re-exports the has/describe/forget facade and the login
 * pair, so /providers and every existing importer resolve unchanged. The login
 * flow is wired here because this module owns the token store it writes into.
 */
import { readFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { getPluginData } from '../config.mjs';
import { writeJsonAtomicSync, withFileLock } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { decodeJwtPayload, expiryFromAccessToken } from './lib/oauth-token-utils.mjs';
import { createOpenAIOAuthLogin } from './openai-oauth-login.mjs';
import { CODEX_OAUTH_ORIGINATOR } from './openai-codex-endpoints.mjs';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
// OAuth refresh includes a network exchange plus owner-only atomic
// persistence. Match the Anthropic/xAI lease: the generic 2s file lock timeout
// is too short under Windows ACL and process contention.
const REFRESH_LOCK_OPTIONS = Object.freeze({
  timeoutMs: 120_000,
  staleMs: 120_000,
  secret: true,
});

// One in-flight refresh per token file, shared by every provider instance in
// this process. The file lock below serializes across processes.
const _refreshesInFlight = new Map();

export function getOwnTokenPath() {
  const bound = boundProviderAuthPath('openai-oauth');
  if (bound) return resolve(bound);
  const explicit = process.env.OPENAI_OAUTH_CREDENTIALS_PATH;
  if (explicit) return resolve(explicit);
  const dir = getPluginData();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'openai-oauth.json');
}

function getRefreshLockPath() {
  return `${getOwnTokenPath()}.refresh.lock`;
}

function _normalizeExpiresAt(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

export function extractAccountId(token) {
  return decodeJwtPayload(token)?.['https://api.openai.com/auth']?.chatgpt_account_id;
}

/** mtime of the token file, 0 when it is missing or unreadable. */
export function tokensFileMtimeMs() {
  try {
    return statSync(getOwnTokenPath()).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadTokens() {
  const ownPath = getOwnTokenPath();
  if (!existsSync(ownPath)) return null;
  try {
    const stat = statSync(ownPath);
    const own = JSON.parse(readFileSync(ownPath, 'utf-8'));
    if (own.access_token && own.refresh_token) {
      return {
        ...own,
        expires_at: _normalizeExpiresAt(own.expires_at ?? own.expiresAt) || expiryFromAccessToken(own.access_token),
        account_id: own.account_id || extractAccountId(own.access_token),
        source: 'Mixdog token store',
        _mtimeMs: stat.mtimeMs,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export function saveTokens(tokens) {
  const target = getOwnTokenPath();
  writeJsonAtomicSync(target, tokens, { lock: true, fsyncDir: true, mode: 0o600, secret: true });
}

// Public predicate used by config.buildDefaultConfig — provider is enabled
// when own Mixdog tokens exist. Single truth:
// same loader the runtime uses (loadTokens), no parallel hard-coded path probe.
export function hasOpenAIOAuthCredentials() {
  try {
    const tokens = loadTokens();
    return !!(tokens?.access_token && tokens?.refresh_token);
  } catch {
    return false;
  }
}

export function describeOpenAIOAuthCredentials() {
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
    const expiresAt = _normalizeExpiresAt(tokens.expires_at ?? tokens.expiresAt);
    const expiring = expiresAt > 0 && expiresAt < Date.now() + TOKEN_REFRESH_SKEW_MS;
    const expired = expiresAt > 0 && expiresAt <= Date.now();
    const source = tokens.source || 'oauth';
    // Account identity for multi-account rosters: the id_token's email
    // when present, else a short prefix of the ChatGPT account id.
    const claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) || {} : {};
    const email = typeof claims.email === 'string' ? claims.email : '';
    const accountId = tokens.account_id ? `${String(tokens.account_id).slice(0, 8)}…` : '';
    const identity = { ...(email ? { email } : {}), ...(accountId ? { accountId } : {}) };
    if (!hasRefresh) {
      return {
        authenticated: expiresAt === 0 || !expired,
        usable: expiresAt === 0 || !expired,
        refreshable: false,
        reauthRequired: expired,
        status: expired ? 'Reauth Required' : 'Access Only',
        detail: `${source}; no refresh token`,
        expiresAt,
        ...identity,
      };
    }
    if (expired)
      return {
        authenticated: true,
        usable: false,
        refreshable: true,
        reauthRequired: false,
        status: 'Refresh Required',
        detail: source,
        expiresAt,
        ...identity,
      };
    if (expiring)
      return {
        authenticated: true,
        usable: true,
        refreshable: true,
        reauthRequired: false,
        status: 'Refresh Soon',
        detail: source,
        expiresAt,
        ...identity,
      };
    return {
      authenticated: true,
      usable: true,
      refreshable: true,
      reauthRequired: false,
      status: 'Valid',
      detail: source,
      expiresAt,
      ...identity,
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

export function forgetOpenAIOAuthCredentials() {
  let removed = false;
  const ownPath = getOwnTokenPath();
  if (existsSync(ownPath)) {
    unlinkSync(ownPath);
    removed = true;
  }
  return { removed };
}

// --- Token refresh ---
async function exchangeRefreshToken(refreshToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);
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
      // Distinguish a terminally-dead refresh token (consumed by the official
      // CLI's single-use lineage) from transient failures, so the caller can
      // re-read disk and retry once with a newer token instead of
      // collapsing every failure to a generic null.
      if (res.status === 400 || res.status === 401 || /invalid_grant|revoked|reused/i.test(text)) {
        throw Object.assign(new Error(`OpenAI OAuth token refresh ${res.status} (invalid_grant)`), {
          isInvalidGrant: true,
        });
      }
      return null;
    }
    const json = await res.json();
    if (!json.access_token) return null;
    const expiresAt =
      _normalizeExpiresAt(json.expires_at ?? json.expiresAt) ||
      (typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0);
    const tokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || refreshToken,
      expires_at: expiresAt,
      account_id: extractAccountId(json.access_token),
    };
    saveTokens(tokens);
    return tokens;
  } catch (err) {
    if (err?.name === 'AbortError')
      throw new Error(`OpenAI OAuth token refresh timed out after ${TOKEN_REFRESH_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Tokens another writer (a fresh login, a sibling process) already put on disk
 * that supersede the caller's own: a different access token that still clears
 * the refresh skew. Null when disk has nothing better, which is the signal to
 * run the refresh exchange.
 */
function adoptableDiskTokens(currentAccessToken, tokens, force) {
  const validAfter = Date.now() + (force ? 0 : TOKEN_REFRESH_SKEW_MS);
  if (!tokens?.access_token || tokens.access_token === currentAccessToken) return null;
  if (tokens.expires_at && tokens.expires_at < validAfter) return null;
  return tokens;
}

/**
 * The current token when it is still usable on its own. A refresh that cannot
 * run (no refresh token, failed exchange) must not take a session that still
 * holds a valid access token down with it; a forced refresh has no such
 * licence because its caller already saw the token rejected.
 */
function reusableCurrentTokens(tokens, force) {
  if (force || !tokens?.access_token) return null;
  if (tokens.expires_at && tokens.expires_at <= Date.now()) return null;
  return tokens;
}

async function refreshUnderLock({ currentToken, force, reason, startingTokens }) {
  const latest = loadTokens() || startingTokens;
  const adopted = adoptableDiskTokens(currentToken, latest, force);
  if (adopted) {
    process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
    return { tokens: adopted, coastOnCurrent: false };
  }

  if (!latest?.refresh_token) {
    const reusable = reusableCurrentTokens(latest, force);
    if (reusable) {
      process.stderr.write(
        `[openai-oauth] WARNING: token expiring but no refresh token; using current token until expiry\n`
      );
      return { tokens: reusable, coastOnCurrent: true };
    }
    throw new Error('OpenAI OAuth refresh token not available. Open /providers in mixdog to sign in again.');
  }

  try {
    const _refreshT0 = Date.now();
    const _expiringInMs = (latest?.expires_at ?? 0) - Date.now();
    if (process.env.MIXDOG_DEBUG_AGENT) {
      process.stderr.write(`[agent-trace] auth-refresh-needed expiringInMs=${_expiringInMs}\n`);
    }
    process.stderr.write(`[openai-oauth] Token ${reason}, refreshing...\n`);
    const refreshed = await exchangeRefreshToken(latest.refresh_token);
    if (process.env.MIXDOG_DEBUG_AGENT) {
      process.stderr.write(`[agent-trace] auth-refresh-done elapsed=${Date.now() - _refreshT0}ms ok=${!!refreshed}\n`);
    }
    if (!refreshed) throw new Error('refresh returned null');
    process.stderr.write(
      `[openai-oauth] Token refreshed, expires in ${Math.round(((refreshed.expires_at || Date.now()) - Date.now()) / 1000)}s\n`
    );
    return { tokens: refreshed, coastOnCurrent: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const reusable = reusableCurrentTokens(latest, force);
    if (reusable) {
      process.stderr.write(`[openai-oauth] Refresh failed (${msg}); using still-valid current token\n`);
      return { tokens: reusable, coastOnCurrent: true };
    }
    throw new Error(`OpenAI OAuth token refresh failed (${msg}). Re-authenticate via provider login.`);
  }
}

/**
 * Resolve the credentials a turn should use, refreshing when needed.
 *
 * Resolves `{ tokens, coastOnCurrent }`; `coastOnCurrent` is true when the
 * refresh could not run and the caller is coasting on a still-valid token, so
 * the provider can hold off re-attempting until the expiry skew.
 */
export async function refreshStoredTokens({ current = null, force = false, reason = 'preemptive' } = {}) {
  const currentToken = current?.access_token || null;
  const disk = loadTokens();
  const adopted = adoptableDiskTokens(currentToken, disk, force);
  if (adopted) {
    process.stderr.write(`[openai-oauth] Reloaded tokens from disk\n`);
    return { tokens: adopted, coastOnCurrent: false };
  }

  const refreshKey = getOwnTokenPath();
  let startingTokens = current || disk;
  const shared = _refreshesInFlight.get(refreshKey);
  if (shared) {
    const result = await shared;
    // A forced refresh that was handed back the very token it already
    // rejected has to run its own exchange.
    if (!force || result.tokens?.access_token !== currentToken) {
      // The coast window belongs to the caller that actually attempted
      // the refresh. A waiter only adopts the resulting tokens: arming
      // its own window here would suppress that caller's next refresh.
      return { tokens: result.tokens, coastOnCurrent: false };
    }
    startingTokens = result.tokens;
  }

  const refresh = withFileLock(
    getRefreshLockPath(),
    () => refreshUnderLock({ currentToken, force, reason, startingTokens }),
    REFRESH_LOCK_OPTIONS
  ).finally(() => {
    _refreshesInFlight.delete(refreshKey);
  });
  _refreshesInFlight.set(refreshKey, refresh);
  return refresh;
}

const { beginOAuthLogin, loginOAuth } = createOpenAIOAuthLogin({
  clientId: CLIENT_ID,
  originator: CODEX_OAUTH_ORIGINATOR,
  extractAccountId,
  expiryFromAccessToken,
  saveTokens,
});
export { beginOAuthLogin, loginOAuth };
