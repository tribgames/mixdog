import { createHash, randomBytes } from 'node:crypto';
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
  readIdentityFile,
  readStoredCredentials,
  withCredentialLock,
  writeIdentityFile,
  writeRevisionMarker,
} from './oauth-credentials.mjs';
import { createLoginFlow } from './oauth-login.mjs';
import { createOAuthProvider } from './oauth-provider.mjs';
import { createAuthorizedFetch } from './oauth-request.mjs';
import { REAUTHENTICATION_REQUIRED_MESSAGE, SCOPE_NOT_GRANTED_MARKER, anySignal } from './oauth-shared.mjs';

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

/** Whether a sign-in failed because the provider did not grant a requested
 *  scope (a real failure with its own message, not a plain "sign in"). */
export function isMcpOAuthScopeNotGranted(error) {
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    if (current.code === 'scopeNotGranted') return true;
    if (String(current.message ?? current).includes(SCOPE_NOT_GRANTED_MARKER)) return true;
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

/** Who the stored sign-in of one MCP server URL belongs to, without a keychain
 *  read: `{ account, workspace, forcedChoice }` (empty strings when the server
 *  named nobody), or null when signed out. */
export function storedMcpOAuthIdentity(url) {
  return readIdentityFile(mcpOAuthAccount(normalizeMcpTransportUrl(url)));
}

// RFC 7009 revocation of the stored grant, only where the authorization server
// advertises its revocation endpoint (RFC 8414 metadata): it revokes the token
// this client was issued, nothing workspace-wide. True when the server
// confirmed it.
async function revokeStoredGrant(saved, fetchImpl) {
  let value;
  try {
    value = JSON.parse(saved);
  } catch {
    return false;
  }
  const endpoint = value?.discovery?.authorizationServerMetadata?.revocation_endpoint;
  const token = value?.tokens?.refresh_token || value?.tokens?.access_token;
  const clientId = value?.clientInformation?.client_id;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || !token || !clientId) return false;
  const body = new URLSearchParams({
    token,
    token_type_hint: value.tokens.refresh_token ? 'refresh_token' : 'access_token',
    client_id: clientId,
  });
  if (value.clientInformation.client_secret) body.set('client_secret', value.clientInformation.client_secret);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Log out of one MCP server URL: delete its stored tokens and client
 *  registration and drop them from live connections, which then need an
 *  explicit reconnect to log in again. With `revoke`, the grant is first
 *  revoked at the authorization server where it documents a revocation
 *  endpoint. Resolves `{ revoked }`. */
export async function clearMcpOAuth({ url, credentialStore = keychain, revoke = false, fetchImpl = fetch }) {
  url = normalizeMcpTransportUrl(url);
  const account = mcpOAuthAccount(url);
  let revoked = false;
  await withCredentialLock(account, async () => {
    const saved = await readStoredCredentials(credentialStore, account);
    if (revoke && saved != null) revoked = await revokeStoredGrant(saved, fetchImpl);
    await writeRevisionMarker(account, null);
    if (saved != null) await credentialStore.deleteSecretAsync(account);
    await writeIdentityFile(account, null);
  });
  scopes.get(credentialStore)?.get(url)?.oauth.clear();
  return { revoked };
}

async function storeEntry(account, url, value, credentialStore) {
  const revision = randomBytes(16).toString('hex');
  const { tokens, clientInformation, redirectUrl, discovery, identity } = value;
  await writeRevisionMarker(account, revision, Boolean(tokens));
  await credentialStore.setSecretAsync(
    account,
    JSON.stringify({ url, revision, tokens, clientInformation, redirectUrl, discovery, identity })
  );
  await writeIdentityFile(account, value);
}

/**
 * 계정 바꾸기 for one MCP server URL, transactionally: a browser sign-in with
 * the provider's documented account choice that runs beside the stored
 * sign-in, reusing its client registration and discovery but never its tokens,
 * and stores nothing. `done` resolves the new sign-in (`{ tokens, identity, … }`)
 * or rejects (cancel, denial, timeout), leaving the stored sign-in and every
 * live connection as they were. `answer(pasted)` completes it with a pasted
 * redirect URL (remote sign-in); `cancel()` aborts it.
 */
export function startMcpOAuthSwitch({
  url,
  launch,
  serverName,
  credentialStore = keychain,
  fetchImpl = fetch,
  timeoutMs = MCP_OAUTH_TIMEOUT_MS,
  oauthClient = null,
}) {
  url = normalizeMcpTransportUrl(url);
  const lifetime = new AbortController();
  const creds = {
    tokens: undefined,
    clientInformation: undefined,
    redirectUrl: undefined,
    discovery: undefined,
    identity: undefined,
    // Never null: the in-memory entry always exists.
    observed: 'switch',
  };
  // An in-memory entry: a registration made during the switch stays here
  // until the commit stores it with the tokens.
  const cache = {
    creds,
    held: new Set(),
    ready: async () => {},
    adoptStored: async () => {},
    update: async (change) => {
      change();
      return true;
    },
    withLock: (fn) => fn(),
  };
  const flow = {
    listener: undefined,
    state: undefined,
    verifier: undefined,
    allowBrowser: false,
    browserOpened: false,
    launchBrowser: launch,
    finishCallback: undefined,
  };
  const provider = createOAuthProvider({
    cache,
    flow,
    lifetimeSignal: lifetime.signal,
    client: oauthClient,
    credentialStore,
  });
  const loginFlow = createLoginFlow({
    url,
    cache,
    flow,
    provider,
    lifetimeSignal: lifetime.signal,
    openBrowser: launch,
    fetchImpl,
    timeoutMs,
  });
  const done = (async () => {
    const saved = await readStoredCredentials(credentialStore, mcpOAuthAccount(url));
    if (saved) {
      const value = JSON.parse(saved);
      if (value.url === url) {
        creds.clientInformation = value.clientInformation;
        creds.redirectUrl = value.redirectUrl;
        creds.discovery = value.discovery;
      }
    }
    await loginFlow.login({}, lifetime.signal, true, launch, undefined, serverName);
    const { tokens, clientInformation, redirectUrl, discovery, identity } = creds;
    if (!tokens) throw new Error('MCP OAuth login failed, cancelled, or timed out');
    return { tokens, clientInformation, redirectUrl, discovery, identity: identity ?? null };
  })();
  return {
    done,
    answer(pasted) {
      if (!flow.finishCallback || !flow.browserOpened || !flow.state || !creds.redirectUrl) {
        throw new Error(MCP_OAUTH_CALLBACK_NOT_PENDING);
      }
      const { code } = parsePastedMcpOAuthCallback(pasted, { redirectUrl: creds.redirectUrl, state: flow.state });
      loginFlow.stopListening();
      loginFlow.answerCallback(code);
    },
    cancel() {
      lifetime.abort();
      flow.finishCallback?.();
      loginFlow.closeListener();
    },
  };
}

/** Store the sign-in a switch returned as the URL's sign-in; resolves a
 *  `rollback()` that restores the previous one (or none). Live connections
 *  adopt either through the revision marker on their next request. */
export async function commitMcpOAuthSwitch({ url, signIn, credentialStore = keychain }) {
  url = normalizeMcpTransportUrl(url);
  const account = mcpOAuthAccount(url);
  let previous = null;
  await withCredentialLock(account, async () => {
    previous = await readStoredCredentials(credentialStore, account);
    await storeEntry(account, url, signIn, credentialStore);
  });
  return () =>
    withCredentialLock(account, async () => {
      if (previous) return storeEntry(account, url, JSON.parse(previous), credentialStore);
      await writeRevisionMarker(account, null);
      await credentialStore.deleteSecretAsync(account);
      await writeIdentityFile(account, null);
    });
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
  oauthClient = null,
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
  const provider = createOAuthProvider({
    cache,
    flow,
    lifetimeSignal: lifetime.signal,
    client: oauthClient,
    credentialStore,
  });
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
