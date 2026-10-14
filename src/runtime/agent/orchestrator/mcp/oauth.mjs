import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import keychain from '../../../../lib/keychain-cjs.cjs';
import { openInBrowser } from '../../../shared/open-url.mjs';
import { normalizeMcpTransportUrl } from './client-config.mjs';
import {
  MCP_OAUTH_CALLBACK_MAX_BYTES,
  MCP_OAUTH_CALLBACK_NOT_PENDING,
  parsePastedMcpOAuthCallback,
} from './oauth-callback.mjs';
import {
  TOKENS_FLAG,
  createCredentialCache,
  credentialFile,
  readStoredCredentials,
  withCredentialLock,
  writeRevisionMarker,
} from './oauth-credentials.mjs';
import { createLoginFlow } from './oauth-login.mjs';
import { createOAuthProvider } from './oauth-provider.mjs';
import { createAuthorizedFetch } from './oauth-request.mjs';
import { REAUTHENTICATION_REQUIRED_MESSAGE, anySignal } from './oauth-shared.mjs';

export { MCP_OAUTH_CALLBACK_MAX_BYTES, MCP_OAUTH_CALLBACK_NOT_PENDING, parsePastedMcpOAuthCallback };

export const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000;

const scopes = new WeakMap();

/** Whether a connect failed only because the server needs an (explicit) OAuth
 *  sign-in. Transports may wrap the error (SSE re-raises it as an event
 *  message), so the message and cause chain count too. */
export function isMcpOAuthReauthenticationRequired(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    if (current.code === 'reauthenticationRequired') return true;
    if (String(current.message ?? current).includes(REAUTHENTICATION_REQUIRED_MESSAGE)) return true;
  }
  return false;
}

// One keychain entry per exact server URL. Windows stores each account as a
// file name, so the account is a hash of the URL and nothing else.
export function mcpOAuthAccount(url) {
  return `mcp-oauth.${createHash('sha256').update(url).digest('hex')}`;
}

/** Whether OAuth tokens are stored for one server URL, read from the
 *  non-secret revision marker without touching the keychain. */
export function hasStoredMcpOAuthTokens(url) {
  try {
    const marker = readFileSync(credentialFile(mcpOAuthAccount(normalizeMcpTransportUrl(url)), 'rev'), 'utf8');
    return marker.endsWith(TOKENS_FLAG);
  } catch {
    return false;
  }
}

/** Log out of one MCP server URL: delete its stored tokens and client
 *  registration and drop them from live connections, which then need an
 *  explicit reconnect to log in again. */
export async function clearMcpOAuth({ url, credentialStore = keychain }) {
  url = normalizeMcpTransportUrl(url);
  const account = mcpOAuthAccount(url);
  await withCredentialLock(account, async () => {
    await writeRevisionMarker(account, null);
    if ((await readStoredCredentials(credentialStore, account)) != null)
      await credentialStore.deleteSecretAsync(account);
  });
  scopes.get(credentialStore)?.get(url)?.oauth.clear();
}

// The keychain is the only durable store. Exact URLs, including query strings,
// partition clients and tokens even when servers share an authorization issuer.
export function createMcpOAuth({
  url,
  credentialStore = keychain,
  interactive = false,
  isTransportEndpoint = () => false,
  serverName,
  ...options
}) {
  url = normalizeMcpTransportUrl(url);
  let entries = scopes.get(credentialStore);
  if (!entries) {
    entries = new Map();
    scopes.set(credentialStore, entries);
  }
  let entry = entries.get(url);
  if (!entry) {
    entry = { oauth: createSharedOAuth({ url, credentialStore, ...options }), users: 0 };
    entries.set(url, entry);
  }
  entry.users++;
  const lifetime = new AbortController();
  let onStart = () => {};
  let loginAllowed = interactive === true;
  let loginStarted = false;
  let loginCompleted = false;
  return {
    provider: entry.oauth.provider,
    signal: lifetime.signal,
    set onStart(value) {
      onStart = value;
    },
    /** Whether this connection was opened by an explicit sign-in. */
    get interactive() {
      return interactive === true;
    },
    /** Whether this connection started an interactive (browser) login. */
    get loginStarted() {
      return loginStarted;
    },
    /** Whether that login obtained tokens (the sign-in itself completed). */
    get loginCompleted() {
      return loginCompleted;
    },
    finishConnect() {
      loginAllowed = false;
    },
    /** Every OAuth token this connection held, for scrubbing errors and results. */
    secrets: () => entry.oauth.secrets(),
    /** Answer the browser login this connection started with the redirect URL
     *  pasted from the browser, exactly as the loopback callback would. */
    completeCallback(pasted) {
      if (!loginStarted || loginCompleted || lifetime.signal.aborted) throw new Error(MCP_OAUTH_CALLBACK_NOT_PENDING);
      entry.oauth.completeCallback(pasted);
    },
    async fetch(input, init = {}) {
      const signal = anySignal(lifetime.signal, init.signal);
      let startedHere = false;
      return entry.oauth.fetch(
        input,
        { ...init, signal },
        () => {
          if (!loginAllowed) return false;
          loginAllowed = false;
          loginStarted = startedHere = true;
          onStart();
          return true;
        },
        options.openBrowser,
        isTransportEndpoint,
        serverName,
        // The login this request started stored tokens (a cancel, denial,
        // timeout or failed exchange never gets here); the retry after it may
        // still fail on its own.
        () => {
          if (startedHere) loginCompleted = true;
        }
      );
    },
    close() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      if (--entry.users === 0) {
        entry.oauth.close();
        entries.delete(url);
      }
    },
  };
}

function createSharedOAuth({
  url,
  credentialStore,
  openBrowser = openInBrowser,
  fetchImpl = fetch,
  timeoutMs = MCP_OAUTH_TIMEOUT_MS,
}) {
  const lifetime = new AbortController();
  const cache = createCredentialCache({ url, credentialStore, account: mcpOAuthAccount(url) });
  const { creds } = cache;
  const flow = {
    listener: undefined,
    state: undefined,
    verifier: undefined,
    allowBrowser: false,
    browserOpened: false,
    launchBrowser: openBrowser,
    finishCallback: undefined,
  };
  const provider = createOAuthProvider({ cache, flow, lifetimeSignal: lifetime.signal });
  const { login, stopListening, closeListener, answerCallback } = createLoginFlow({
    url,
    cache,
    flow,
    provider,
    lifetimeSignal: lifetime.signal,
    openBrowser,
    fetchImpl,
    timeoutMs,
  });
  const requests = createAuthorizedFetch({
    url,
    cache,
    login,
    fetchImpl,
    lifetimeSignal: lifetime.signal,
  });
  return {
    provider,
    signal: lifetime.signal,
    fetch: requests.fetch,
    secrets: () => [...cache.held],
    /** Answer the pending browser login with a pasted redirect URL: the same
     *  state check, PKCE exchange and persistence as the loopback callback,
     *  whose listener closes. An invalid paste leaves the login pending. */
    completeCallback(pasted) {
      if (!flow.finishCallback || !flow.browserOpened || !flow.state || !creds.redirectUrl) {
        throw new Error(MCP_OAUTH_CALLBACK_NOT_PENDING);
      }
      const { code } = parsePastedMcpOAuthCallback(pasted, { redirectUrl: creds.redirectUrl, state: flow.state });
      stopListening();
      // A denial (no code) fails the login without echoing its description.
      answerCallback(code);
    },
    /** Forget in-memory credentials (after a log-out) and cancel a login in
     *  progress; the next request re-reads the keychain. */
    clear() {
      requests.cancelLogin();
      cache.clear();
    },
    close() {
      lifetime.abort();
      flow.finishCallback?.();
      closeListener();
    },
  };
}
