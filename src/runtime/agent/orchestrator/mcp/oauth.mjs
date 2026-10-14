import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import keychain from '../../../../lib/keychain-cjs.cjs';
import { withFileLock, writeFileAtomicAsync } from '../../../shared/atomic-file.mjs';
import { openInBrowser } from '../../../shared/open-url.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { normalizeMcpTransportUrl } from './client-config.mjs';
import { OAUTH_PAGE_CONTENT_TYPE, oauthErrorHtml, oauthSuccessHtml } from '../providers/lib/oauth-page.mjs';

export const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000;
// Same lease as the provider OAuth refresh (openai-oauth-tokens.mjs): a
// refresh is a network exchange plus keychain persistence. The lock file
// itself holds no credential (they live in the keychain).
const CREDENTIAL_LOCK_OPTIONS = Object.freeze({ timeoutMs: 120_000, staleMs: 120_000 });

const scopes = new WeakMap();
const REAUTHENTICATION_REQUIRED_MESSAGE = 'MCP OAuth reauthenticationRequired: sign in to connect';
const reauthenticationRequired = () =>
  Object.assign(new Error(REAUTHENTICATION_REQUIRED_MESSAGE), {
    code: 'reauthenticationRequired',
  });

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

const credentialFile = (account, extension) => join(resolvePluginData(), 'mcp-oauth', `${account}.${extension}`);

// Serializes refreshes, logins and log-outs of one account across processes.
function withCredentialLock(account, fn) {
  return withFileLock(credentialFile(account, 'lock'), fn, CREDENTIAL_LOCK_OPTIONS);
}

// A non-secret marker of the stored entry's revision ('deleted' when there is
// none) and whether the entry holds tokens (a client registration alone does
// not sign in), written under the credential lock before every change of the
// entry. Every process compares it before sending a cached token, so a refresh
// or log-out elsewhere is observed without reading the keychain per request.
const TOKENS_FLAG = '+tokens';
const markerOf = (revision, hasTokens) =>
  revision === null ? 'deleted' : hasTokens ? `${revision}${TOKENS_FLAG}` : revision;
function writeRevisionMarker(account, revision, hasTokens = false) {
  return writeFileAtomicAsync(credentialFile(account, 'rev'), markerOf(revision, hasTokens));
}
// Missing or unreadable (null) never matches: the caller re-reads the keychain.
function readRevisionMarker(account) {
  return readFile(credentialFile(account, 'rev'), 'utf8').catch(() => null);
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

// The stored value as another process may have just written it, not this
// process's cached copy.
function readStoredCredentials(credentialStore, account) {
  credentialStore.invalidateSecretCache?.(account);
  return credentialStore.getSecretAsync(account);
}

// Every write stores a fresh random revision; null stands for no entry.
const revisionOf = (saved) => (saved ? (JSON.parse(saved).revision ?? '') : null);

// `signal`, also aborted by the caller's optional `other` signal.
const anySignal = (signal, other) => AbortSignal.any(other ? [signal, other] : [signal]);

/** Upper bound of a pasted redirect URL (`completeMcpLogin`). */
export const MCP_OAUTH_CALLBACK_MAX_BYTES = 64 * 1024;
// Fixed messages: a pasted URL carries the authorization code and is never
// echoed into an error, a log or a status.
const INVALID_CALLBACK_PASTE =
  'The pasted sign-in URL is invalid. Paste the full address the browser was redirected to after signing in.';
export const MCP_OAUTH_CALLBACK_NOT_PENDING = 'MCP OAuth sign-in is not waiting for a callback';
const sameState = (supplied, expected) => {
  const a = Buffer.from(supplied || '');
  const b = Buffer.from(expected || '');
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The outcome of a redirect URL pasted from the browser for a pending login
 * whose redirect URI is `redirectUrl` and state `state`: `{ code }`, or
 * `{ denied: true }` for an authorization error. Throws a fixed message (never
 * the pasted text) for anything that is not exactly that login's callback.
 */
export function parsePastedMcpOAuthCallback(pasted, { redirectUrl, state }) {
  const invalid = () => new Error(INVALID_CALLBACK_PASTE);
  if (typeof pasted !== 'string' || Buffer.byteLength(pasted) > MCP_OAUTH_CALLBACK_MAX_BYTES) throw invalid();
  const raw = pasted.trim();
  let target;
  let expected;
  try {
    target = new URL(raw);
    expected = new URL(redirectUrl);
  } catch {
    throw invalid();
  }
  if (
    raw.includes('#') ||
    target.username ||
    target.password ||
    target.origin !== expected.origin ||
    target.pathname !== expected.pathname
  )
    throw invalid();
  const seen = new Set();
  for (const [key, value] of target.searchParams) {
    if (seen.has(key)) throw invalid();
    seen.add(key);
    // The redirect URI's own parameters come back unchanged; any others an
    // authorization server adds (e.g. Google's scope/authuser/prompt) are
    // ignored, as in Codex's parse_callback_url.
    if (expected.searchParams.has(key) && expected.searchParams.get(key) !== value) throw invalid();
  }
  for (const key of expected.searchParams.keys()) if (!seen.has(key)) throw invalid();
  if (!sameState(target.searchParams.get('state'), state)) throw invalid();
  if (seen.has('code') === seen.has('error')) throw invalid();
  if (seen.has('error')) return { denied: true };
  const code = target.searchParams.get('code');
  if (!code) throw invalid();
  return { code };
}

// Answers a request to the loopback redirect URI: only a GET of the exact
// callback path and host, carrying exactly the pending state (compared in
// constant time) and either one code or an error, finishes the login.
function answerOAuthCallback(req, res, { redirectUrl, state, finish, serverName }) {
  const page = (status, html) => {
    res.writeHead(status, {
      'Content-Type': OAUTH_PAGE_CONTENT_TYPE,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  };
  const invalid = () =>
    page(400, oauthErrorHtml('This sign-in link is invalid or has expired.', 'Start the sign-in again from Mixdog.'));
  let target;
  try {
    target = new URL(req.url || '/', redirectUrl);
  } catch {
    invalid();
    return;
  }
  // `finish` is absent once the login was answered (e.g. by a pasted URL).
  const valid =
    typeof finish === 'function' &&
    req.method === 'GET' &&
    req.headers.host === new URL(redirectUrl).host &&
    target.pathname === '/oauth/callback' &&
    target.searchParams.getAll('state').length === 1 &&
    sameState(target.searchParams.get('state'), state);
  if (!valid || (!target.searchParams.has('error') && target.searchParams.getAll('code').length !== 1)) {
    invalid();
    return;
  }
  const server = serverName || 'the MCP server';
  if (target.searchParams.has('error')) {
    // The authorization server's error text is never reflected.
    page(400, oauthErrorHtml(`Sign-in to ${server} was not completed.`, 'Start the sign-in again from Mixdog.'));
    finish(undefined);
    return;
  }
  page(200, oauthSuccessHtml(server));
  finish(target.searchParams.get('code'));
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
  let listener;
  let redirectUrl;
  let state;
  let verifier;
  let tokens;
  let clientInformation;
  let discovery;
  let flight;
  let waiters = 0;
  let flightController;
  let allowBrowser = false;
  let browserOpened = false;
  let launchBrowser = openBrowser;
  let finishCallback;
  const account = mcpOAuthAccount(url);
  let loaded;
  // Revision of the stored entry this process last read or wrote: null when
  // there was none, undefined when unknown (after a log-out here).
  let observed;
  // Every token this connection held: an error or result echoing the token a
  // request was sent with stays scrubbed after a refresh or log-out.
  const held = new Set();
  const hold = () => {
    for (const token of [tokens?.access_token, tokens?.refresh_token]) if (token) held.add(token);
  };
  const adopt = (saved) => {
    const value = saved ? JSON.parse(saved) : {};
    if (saved && value.url !== url) throw reauthenticationRequired();
    ({ tokens, clientInformation, redirectUrl, discovery } = value);
    observed = revisionOf(saved);
    hold();
  };
  // A failed read (locked keychain) is retried by the next request.
  const ready = () =>
    (loaded ??= credentialStore
      .getSecretAsync(account)
      .then(adopt)
      .catch((error) => {
        loaded = undefined;
        throw error;
      }));
  const fail = () => new Error('MCP OAuth login failed, cancelled, or timed out');
  // The only writer of the stored entry. Under the cross-process lock it
  // changes the entry only while it still has the revision the caller observed
  // (by default the one this process last read or wrote); otherwise it adopts
  // the newer entry, or its deletion by a log-out, and changes nothing.
  function update(change, { expected = observed, remove = false } = {}) {
    return withCredentialLock(account, async () => {
      const saved = await readStoredCredentials(credentialStore, account);
      if (revisionOf(saved) !== expected) {
        adopt(saved);
        return false;
      }
      change();
      hold();
      if (remove) {
        await writeRevisionMarker(account, null);
        if (saved) await credentialStore.deleteSecretAsync(account);
        observed = null;
      } else {
        const revision = randomBytes(16).toString('hex');
        await writeRevisionMarker(account, revision, Boolean(tokens));
        await credentialStore.setSecretAsync(
          account,
          JSON.stringify({ url, revision, tokens, clientInformation, redirectUrl, discovery })
        );
        observed = revision;
      }
      return true;
    });
  }
  // Before a cached token is sent: adopt a change another process made (a
  // refresh, a log-out) since this process last read or wrote the entry.
  async function observeStoredRevision() {
    if ((await readRevisionMarker(account)) === markerOf(observed, Boolean(tokens))) return;
    await withCredentialLock(account, async () => {
      adopt(await readStoredCredentials(credentialStore, account));
      // Repair a missing or stale marker (an entry stored before markers or
      // the tokens flag existed, an interrupted change) so the next request
      // reads no keychain.
      if ((await readRevisionMarker(account)) !== markerOf(observed, Boolean(tokens))) {
        await writeRevisionMarker(account, observed, Boolean(tokens));
      }
    });
  }
  // The SDK saves only inside a login, which holds the lock and has just
  // adopted the stored entry.
  const save = async (change) => {
    if (!(await update(change))) throw fail();
  };
  const provider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return {
        client_name: 'Mixdog',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    },
    state: () => state,
    clientInformation: async () => {
      await ready();
      // A connect that cannot open a sign-in never registers a client (the
      // SDK registers one after dropping a rejected registration): the next
      // explicit sign-in registers it.
      if (!clientInformation && !allowBrowser) throw reauthenticationRequired();
      return clientInformation;
    },
    saveClientInformation: (value) =>
      save(() => {
        clientInformation = value;
      }),
    tokens: async () => {
      await ready();
      return tokens;
    },
    saveTokens: async (value) => {
      lifetime.signal.throwIfAborted();
      await save(() => {
        tokens = value;
      });
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => {
      if (!verifier) throw fail();
      return verifier;
    },
    discoveryState: () => discovery,
    saveDiscoveryState: (value) =>
      save(() => {
        discovery = value;
      }),
    // The SDK invalidates 'all' when the token endpoint rejects the client
    // (invalid_client / unauthorized_client) and 'tokens' when it rejects the
    // grant (invalid_grant). The registration goes in both cases: an
    // authorization server that forgot its clients (a restart) may answer the
    // refresh with invalid_grant, and reusing that registration would fail
    // every later sign-in at the authorization endpoint; re-registering is cheap.
    invalidateCredentials: async (scope) => {
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
      if (scope === 'discovery') discovery = undefined;
      if (scope !== 'all' && scope !== 'tokens' && scope !== 'client') return;
      await update(
        () => {
          if (scope !== 'client') tokens = undefined;
          clientInformation = undefined;
          if (scope === 'all') discovery = undefined;
        },
        { remove: scope === 'all' }
      );
    },
    redirectToAuthorization: async (authorizationUrl) => {
      if (!allowBrowser || browserOpened) throw reauthenticationRequired();
      const target = new URL(normalizeMcpTransportUrl(authorizationUrl));
      if (
        target.searchParams.get('state') !== state ||
        target.searchParams.get('code_challenge_method') !== 'S256' ||
        !verifier
      )
        throw fail();
      browserOpened = true;
      await launchBrowser(target.href);
    },
  };
  function stopListening() {
    listener?.close();
    listener?.closeAllConnections();
    listener = undefined;
  }
  function closeListener() {
    stopListening();
    verifier = undefined;
    state = undefined;
  }
  // The login's callback is answered once, by the loopback or a paste.
  function answerCallback(code) {
    const finish = finishCallback;
    finishCallback = undefined;
    finish?.(code);
  }
  async function login(challenge, requestSignal, interactive, browser, attemptedToken, serverName) {
    allowBrowser = interactive;
    browserOpened = false;
    launchBrowser = browser || openBrowser;
    const signal = AbortSignal.any([lifetime.signal, requestSignal, AbortSignal.timeout(timeoutMs)]);
    const safeFetch = (input, init = {}) =>
      fetchImpl(normalizeMcpTransportUrl(input), {
        ...init,
        redirect: 'error',
        signal: anySignal(signal, init.signal),
      });
    let abort;
    const callback = new Promise((resolve, reject) => {
      const finish = (code) => (code ? resolve(code) : reject(fail()));
      finishCallback = finish;
      abort = () => finish();
      signal.addEventListener('abort', abort, { once: true });
    });
    // A discovery/registration error can precede waiting for the callback.
    callback.catch(() => {});
    try {
      signal.throwIfAborted();
      const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
      const options = { serverUrl: url, ...challenge, fetchFn: safeFetch };
      // Another process sharing this keychain entry may already have
      // refreshed (and rotated) the tokens this request was rejected with:
      // decide on the stored credentials, under the cross-process lock.
      const result = await withCredentialLock(account, async () => {
        adopt(await readStoredCredentials(credentialStore, account));
        if (tokens && tokens.access_token !== attemptedToken?.access_token) return 'AUTHORIZED';
        if (!interactive && (!tokens?.refresh_token || !clientInformation || !redirectUrl)) {
          throw reauthenticationRequired();
        }
        state = randomBytes(32).toString('base64url');
        if (interactive) await listenForCallback(serverName);
        signal.throwIfAborted();
        return auth(provider, options);
      });
      if (result === 'REDIRECT') {
        const code = await callback;
        signal.throwIfAborted();
        const exchanged = await withCredentialLock(account, async () => {
          // The entry this login registered in is gone only after a log-out
          // since it began, which wins: never recreate it.
          const saved = await readStoredCredentials(credentialStore, account);
          if (!saved) throw fail();
          adopt(saved);
          return auth(provider, { ...options, authorizationCode: code });
        });
        if (exchanged !== 'AUTHORIZED') throw fail();
      }
      signal.throwIfAborted();
    } catch (error) {
      // SDK errors may contain authorization server response bodies/secrets.
      if (error?.code === 'reauthenticationRequired' || !interactive) throw reauthenticationRequired();
      throw fail();
    } finally {
      allowBrowser = false;
      signal.removeEventListener('abort', abort);
      closeListener();
      finishCallback = undefined;
    }
  }
  async function listenForCallback(serverName) {
    listener = createServer((req, res) =>
      answerOAuthCallback(req, res, { redirectUrl, state, finish: finishCallback && answerCallback, serverName })
    );
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      // Retain the registered redirect URI if this connection later needs
      // refresh or reauthorization; never register a different callback.
      listener.listen(redirectUrl ? Number(new URL(redirectUrl).port) : 0, '127.0.0.1', resolve);
    });
    redirectUrl = `http://127.0.0.1:${listener.address().port}/oauth/callback`;
  }
  return {
    provider,
    signal: lifetime.signal,
    async fetch(
      input,
      init = {},
      requestLogin = () => false,
      browser,
      isTransportEndpoint = () => false,
      serverName = undefined,
      onAuthorized = () => {}
    ) {
      // An unreadable (e.g. locked) keychain must not block a server that
      // needs no authentication; credentials are required only on challenge.
      let storeUnreadable = false;
      try {
        await ready();
      } catch {
        storeUnreadable = true;
      }
      lifetime.signal.throwIfAborted();
      const signal = anySignal(lifetime.signal, init.signal);
      const target = new URL(input);
      const server = new URL(url);
      const sameOrigin = target.href === server.href || (target.origin === server.origin && isTransportEndpoint(input));
      let sentRevision;
      let sentTokens;
      const request = async () => {
        if (tokens && sameOrigin) {
          try {
            await observeStoredRevision();
          } catch {
            // Unverifiable (e.g. locked keychain): never send the cached token.
            tokens = loaded = undefined;
            storeUnreadable = true;
          }
        }
        signal.throwIfAborted();
        sentRevision = observed;
        sentTokens = tokens;
        const headers = new Headers(init.headers);
        if (tokens && sameOrigin) headers.set('Authorization', `Bearer ${tokens.access_token}`);
        else headers.delete('Authorization');
        return fetchImpl(input, { ...init, headers, signal, redirect: 'error' });
      };
      const response = await request();
      const attemptedToken = sentTokens;
      if (!sameOrigin || ![401, 403].includes(response.status)) return response;
      const { extractWWWAuthenticateParams } = await import('@modelcontextprotocol/sdk/client/auth.js');
      const challenge = extractWWWAuthenticateParams(response);
      if (response.status === 403 && challenge.error !== 'insufficient_scope') return response;
      await response.body?.cancel();
      if (storeUnreadable) throw reauthenticationRequired();
      if (!flight && tokens === attemptedToken) {
        flightController = new AbortController();
        flight = login(
          challenge,
          flightController.signal,
          requestLogin(),
          browser,
          attemptedToken,
          serverName
        ).finally(() => {
          flight = undefined;
        });
      }
      if (flight) {
        waiters++;
        let abort;
        try {
          await Promise.race([
            flight,
            new Promise((_, reject) => {
              abort = () => reject(fail());
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            }),
          ]);
          // The login settled with tokens stored, before the retry is sent.
          onAuthorized();
        } finally {
          signal.removeEventListener('abort', abort);
          if (--waiters === 0 && flight) {
            flightController.abort();
            await flight.catch(() => {});
          }
        }
      }
      lifetime.signal.throwIfAborted();
      signal.throwIfAborted();
      const retried = await request();
      if (retried.status === 401 || retried.status === 403) {
        await retried.body?.cancel();
        // Forget the rejected tokens unless a refresh (here or in another
        // process) or a log-out replaced them since this retry was sent.
        await update(
          () => {
            tokens = undefined;
          },
          { expected: sentRevision }
        );
        throw reauthenticationRequired();
      }
      return retried;
    },
    secrets: () => [...held],
    /** Answer the pending browser login with a pasted redirect URL: the same
     *  state check, PKCE exchange and persistence as the loopback callback,
     *  whose listener closes. An invalid paste leaves the login pending. */
    completeCallback(pasted) {
      if (!finishCallback || !browserOpened || !state || !redirectUrl) {
        throw new Error(MCP_OAUTH_CALLBACK_NOT_PENDING);
      }
      const { code } = parsePastedMcpOAuthCallback(pasted, { redirectUrl, state });
      stopListening();
      // A denial (no code) fails the login without echoing its description.
      answerCallback(code);
    },
    /** Forget in-memory credentials (after a log-out) and cancel a login in
     *  progress; the next request re-reads the keychain. */
    clear() {
      flightController?.abort();
      tokens = clientInformation = redirectUrl = discovery = undefined;
      loaded = observed = undefined;
    },
    close() {
      lifetime.abort();
      finishCallback?.();
      closeListener();
    },
  };
}
