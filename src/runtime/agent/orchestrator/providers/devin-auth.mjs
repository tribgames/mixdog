import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { writeJsonAtomicSync } from '../../../shared/atomic-file.mjs';
import { boundProviderAuthPath } from '../../../shared/provider-auth-binding.mjs';
import { modelProxyClientMode } from '../../../shared/model-proxy-mode.mjs';
import { openLoginUrl } from './lib/open-login-url.mjs';
import { OAUTH_PAGE_CONTENT_TYPE, oauthErrorHtml, oauthSuccessHtml } from './lib/oauth-page.mjs';
import { createOAuthPkce } from './lib/oauth-pkce.mjs';
import {
  accountIdentityFields,
  decodeJwtPayload,
  expiryFromAccessToken,
  normalizeAccountIdentity,
} from './lib/oauth-token-utils.mjs';

const AUTHORIZE_URL = 'https://app.devin.ai/auth/cli/continue';
const TOKEN_URL = 'https://api.devin.ai/auth/cli/token';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 59653;
const CALLBACK_PATH = '/callback';
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const EXCHANGE_TIMEOUT_MS = 30_000;
// The login token is the only credential and cannot be refreshed. A token
// without a readable `exp` claim is assumed to live for a year.
const DEFAULT_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60_000;
export const REAUTH_GUIDANCE = 'Open /providers in Mixdog to sign in again.';

function reauthError(message) {
  return Object.assign(new Error(message), { reauthRequired: true });
}

function credentialsPath() {
  const bound = boundProviderAuthPath('devin-oauth');
  if (bound) return resolve(bound);
  const explicit = process.env.DEVIN_OAUTH_CREDENTIALS_PATH;
  if (explicit) return resolve(explicit);
  const dir = resolvePluginData();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'devin-oauth.json');
}

export function devinTokenExpiry(token) {
  return expiryFromAccessToken(token);
}

// The login token is a JWT whose `sub` is the Devin user; no request needed.
export function devinTokenIdentity(token) {
  const payload = decodeJwtPayload(token);
  return normalizeAccountIdentity({ id: payload?.sub, email: payload?.email });
}

function loadStoredCredentials() {
  if (modelProxyClientMode()) return null;
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw?.access_token) return null;
    return {
      ...raw,
      expires_at: Number(raw.expires_at) || devinTokenExpiry(raw.access_token),
      identity: normalizeAccountIdentity(raw.identity) || devinTokenIdentity(raw.access_token),
      source: 'Mixdog token store',
    };
  } catch {
    return null;
  }
}

function saveCredentials(tokens) {
  writeJsonAtomicSync(credentialsPath(), tokens, {
    lock: true,
    fsyncDir: true,
    mode: 0o600,
    secret: true,
  });
}

function tokenRecord(accessToken) {
  const identity = devinTokenIdentity(accessToken);
  return {
    access_token: accessToken,
    refresh_token: null,
    expires_at: devinTokenExpiry(accessToken) || Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
    ...(identity ? { identity } : {}),
  };
}

export function hasDevinOAuthCredentials() {
  const tokens = loadStoredCredentials();
  if (!tokens?.access_token) return false;
  const expiresAt = Number(tokens.expires_at) || 0;
  return expiresAt === 0 || expiresAt > Date.now();
}

export function describeDevinOAuthCredentials() {
  const tokens = loadStoredCredentials();
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
  const expiresAt = Number(tokens.expires_at) || 0;
  const expired = expiresAt > 0 && expiresAt <= Date.now();
  return {
    authenticated: !expired,
    usable: !expired,
    refreshable: false,
    reauthRequired: expired,
    status: expired ? 'Reauth Required' : 'Access Only',
    detail: tokens.source || 'Devin OAuth',
    expiresAt: expiresAt || null,
    ...accountIdentityFields(tokens.identity),
  };
}

export function forgetDevinOAuthCredentials() {
  const path = credentialsPath();
  if (!existsSync(path)) return { removed: false };
  unlinkSync(path);
  return { removed: true };
}

export function generateDevinOAuthParams() {
  const { verifier, challenge } = createOAuthPkce();
  const state = randomUUID();
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    prompt: 'select_account',
  });
  return { verifier, challenge, state, loginUrl: `${AUTHORIZE_URL}?${params}` };
}

export async function exchangeDevinCode(code, verifier, { fetchFn = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(EXCHANGE_TIMEOUT_MS);
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
  });
  // Response bodies may carry the login token itself, so none is ever quoted
  // in an error: only the status is reported.
  if (!response.ok) {
    const error = new Error(`Devin token exchange failed (${response.status})`);
    error.status = response.status;
    error.httpStatus = response.status;
    throw error;
  }
  const data = await response.json().catch(() => null);
  if (typeof data?.token !== 'string' || !data.token) throw new Error('Devin token exchange returned no token');
  return tokenRecord(data.token);
}

// The callback port is fixed, so at most one login can own it. A newer login
// in this process takes the port over from the one it supersedes.
let activeLogin = null;

function listenOnCallbackPort(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
}

// Logins start one at a time, in call order: ownership of the port is decided
// only once the previous start has fully settled, so overlapping calls
// supersede each other instead of racing for the bind.
let startQueue = Promise.resolve();

export function beginDevinOAuthLogin(options) {
  const started = startQueue.then(() => startDevinOAuthLogin(options));
  startQueue = started.catch(() => {});
  return started;
}

async function startDevinOAuthLogin({
  openBrowser = true,
  timeoutMs = LOGIN_TIMEOUT_MS,
  fetchFn = fetch,
} = {}) {
  activeLogin?.cancel();
  const params = generateDevinOAuthParams();
  const controller = new AbortController();
  const server = createServer();
  let timer = null;
  let exchangePromise = null;
  let settled = false;
  let resolveLogin;
  let rejectLogin;
  const waitForCallback = new Promise((resolvePromise, rejectPromise) => {
    resolveLogin = resolvePromise;
    rejectLogin = rejectPromise;
  });
  // A caller may only ever cancel; that rejection must not go unhandled.
  waitForCallback.catch(() => {});

  const login = {
    provider: 'devin-oauth',
    url: params.loginUrl,
    manualUrl: null,
    waitForCallback,
    cancel: () => finish(null, new Error('Devin OAuth cancelled')),
  };

  function finish(value, error = null) {
    if (settled) return;
    settled = true;
    if (activeLogin === login) activeLogin = null;
    // Work arriving after the login settled (or was cancelled) is rejected.
    controller.abort();
    clearTimeout(timer);
    try {
      server.close();
      server.closeIdleConnections?.();
    } catch {
      /* already closed */
    }
    if (error) rejectLogin(error);
    else resolveLogin(value);
  }

  // The authorization code is spent once: a duplicate callback joins the first
  // exchange instead of failing the login.
  const acceptCode = (code) => {
    if (exchangePromise) return exchangePromise;
    controller.signal.throwIfAborted();
    // The browser deadline ends once a code arrives; the exchange has its own.
    clearTimeout(timer);
    exchangePromise = exchangeDevinCode(code, params.verifier, { fetchFn, signal: controller.signal }).then(
      (tokens) => {
        // A cancelled login never stores the account it was exchanging.
        controller.signal.throwIfAborted();
        saveCredentials(tokens);
        return tokens;
      }
    );
    exchangePromise.then(
      (tokens) => finish(tokens),
      (error) => finish(null, error instanceof Error ? error : new Error(String(error)))
    );
    return exchangePromise;
  };

  const reply = (res, status, html) => {
    res.writeHead(status, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE, Connection: 'close' });
    res.end(html);
  };

  const handleRequest = async (req, res) => {
    const target = new URL(req.url || '/', REDIRECT_URI);
    if (req.method !== 'GET' || target.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    // A request that is not this login's own is refused; the real callback
    // may still arrive.
    if (target.searchParams.get('state') !== params.state) {
      reply(res, 400, oauthErrorHtml('The sign-in callback did not match this login.'));
      return;
    }
    const authorizationError = target.searchParams.get('error');
    if (authorizationError) {
      // Only a plain OAuth error code is named; free text (error_description)
      // may carry anything, secrets included, so it never reaches the message.
      const code = /^[A-Za-z0-9_.-]{1,64}$/.test(authorizationError) ? ` (${authorizationError})` : '';
      reply(res, 400, oauthErrorHtml('Devin did not authorize this sign-in.'));
      // A late denial must not cancel an already accepted code.
      if (!exchangePromise) {
        finish(null, new Error(`[devin-oauth] authorization failed${code}`));
      }
      return;
    }
    const code = target.searchParams.get('code')?.trim();
    if (!code) {
      reply(res, 400, oauthErrorHtml('The sign-in callback carried no authorization code.'));
      return;
    }
    try {
      await acceptCode(code);
      reply(res, 200, oauthSuccessHtml('Devin'));
    } catch {
      // The shared exchange reports its error through waitForCallback.
      reply(res, 500, oauthErrorHtml('Devin could not complete the token exchange.'));
    }
  };

  // Whatever a stray local client sends (a malformed target included) is
  // answered here and never escapes the listener.
  server.on('request', async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch {
      if (res.headersSent) res.destroy();
      else reply(res, 400, oauthErrorHtml('The sign-in callback was malformed.'));
    }
  });

  try {
    await listenOnCallbackPort(server);
  } catch (error) {
    const failure =
      error?.code === 'EADDRINUSE'
        ? Object.assign(
            new Error(
              `[devin-oauth] callback port ${CALLBACK_HOST}:${CALLBACK_PORT} is already in use. Close the program using it (or another Devin sign-in) and try again.`
            ),
            { code: 'EADDRINUSE' }
          )
        : new Error(`[devin-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${error?.message || error}`);
    finish(null, failure);
    throw failure;
  }
  // Once bound, a runtime fault on the listener ends the login.
  server.on('error', (error) =>
    finish(null, new Error(`[devin-oauth] callback server failed: ${error?.message || error}`))
  );
  timer = setTimeout(
    () => finish(null, new Error(`[devin-oauth] browser authentication timed out after ${timeoutMs}ms`)),
    timeoutMs
  );
  timer.unref?.();
  activeLogin = login;

  process.stderr.write(`\n[devin-oauth] Open the Devin sign-in page:\n${params.loginUrl}\n\n`);
  if (openBrowser) await openLoginUrl('devin-oauth', params.loginUrl);
  return login;
}

export async function loginDevinOAuth() {
  const login = await beginDevinOAuthLogin();
  return await login.waitForCallback;
}

// The login token cannot be refreshed: once it expires the user signs in again.
export async function resolveDevinOAuthAccessToken() {
  const tokens = loadStoredCredentials();
  if (!tokens?.access_token) {
    throw reauthError(`Devin OAuth is not connected. ${REAUTH_GUIDANCE}`);
  }
  if (tokens.expires_at > 0 && tokens.expires_at <= Date.now()) {
    throw reauthError(`Devin login token expired and cannot be refreshed. ${REAUTH_GUIDANCE}`);
  }
  return tokens.access_token;
}
