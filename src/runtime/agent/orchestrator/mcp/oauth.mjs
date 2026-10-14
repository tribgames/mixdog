import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import keychain from '../../../../lib/keychain-cjs.cjs';
import { withFileLock, writeFileAtomicAsync } from '../../../shared/atomic-file.mjs';
import { openInBrowser } from '../../../shared/open-url.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { normalizeMcpTransportUrl } from './client-config.mjs';

export const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000;
// Same lease as the provider OAuth refresh (openai-oauth-tokens.mjs): a
// refresh is a network exchange plus keychain persistence. The lock file
// itself holds no credential (they live in the keychain).
const CREDENTIAL_LOCK_OPTIONS = Object.freeze({ timeoutMs: 120_000, staleMs: 120_000 });

const scopes = new WeakMap();
const reauthenticationRequired = () => Object.assign(
  new Error('MCP OAuth reauthenticationRequired: reconnect explicitly to log in'),
  { code: 'reauthenticationRequired' },
);

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
// none), written under the credential lock before every change of the entry.
// Every process compares it before sending a cached token, so a refresh or
// log-out elsewhere is observed without reading the keychain per request.
const markerOf = (revision) => (revision === null ? 'deleted' : revision);
function writeRevisionMarker(account, revision) {
  return writeFileAtomicAsync(credentialFile(account, 'rev'), markerOf(revision));
}
// Missing or unreadable (null) never matches: the caller re-reads the keychain.
function readRevisionMarker(account) {
  return readFile(credentialFile(account, 'rev'), 'utf8').catch(() => null);
}

// The stored value as another process may have just written it, not this
// process's cached copy.
function readStoredCredentials(credentialStore, account) {
  credentialStore.invalidateSecretCache?.(account);
  return credentialStore.getSecretAsync(account);
}

// Every write stores a fresh random revision; null stands for no entry.
const revisionOf = (saved) => (saved ? (JSON.parse(saved).revision ?? '') : null);

/** Log out of one MCP server URL: delete its stored tokens and client
 *  registration and drop them from live connections, which then need an
 *  explicit reconnect to log in again. */
export async function clearMcpOAuth({ url, credentialStore = keychain }) {
  url = normalizeMcpTransportUrl(url);
  const account = mcpOAuthAccount(url);
  await withCredentialLock(account, async () => {
    await writeRevisionMarker(account, null);
    if (await readStoredCredentials(credentialStore, account) != null) await credentialStore.deleteSecretAsync(account);
  });
  scopes.get(credentialStore)?.get(url)?.oauth.clear();
}

// The keychain is the only durable store. Exact URLs, including query strings,
// partition clients and tokens even when servers share an authorization issuer.
export function createMcpOAuth({
  url, credentialStore = keychain, interactive = false, isTransportEndpoint = () => false, ...options
}) {
  url = normalizeMcpTransportUrl(url);
  let entries = scopes.get(credentialStore);
  if (!entries) scopes.set(credentialStore, entries = new Map());
  let entry = entries.get(url);
  if (!entry) {
    entry = { oauth: createSharedOAuth({ url, credentialStore, ...options }), users: 0 };
    entries.set(url, entry);
  }
  entry.users++;
  const lifetime = new AbortController();
  let onStart = () => {};
  let loginAllowed = interactive === true;
  return {
    provider: entry.oauth.provider,
    signal: lifetime.signal,
    set onStart(value) { onStart = value; },
    finishConnect() { loginAllowed = false; },
    /** Every OAuth token this connection held, for scrubbing errors and results. */
    secrets: () => entry.oauth.secrets(),
    async fetch(input, init = {}) {
      const signal = AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : [])]);
      return entry.oauth.fetch(input, { ...init, signal }, () => {
        if (!loginAllowed) return false;
        loginAllowed = false;
        onStart();
        return true;
      }, options.openBrowser, isTransportEndpoint);
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

function createSharedOAuth({ url, credentialStore, openBrowser = openInBrowser, fetchImpl = fetch, timeoutMs = MCP_OAUTH_TIMEOUT_MS }) {
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
  const ready = () => loaded ??= credentialStore.getSecretAsync(account).then(adopt).catch((error) => {
    loaded = undefined;
    throw error;
  });
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
        await writeRevisionMarker(account, revision);
        await credentialStore.setSecretAsync(account,
          JSON.stringify({ url, revision, tokens, clientInformation, redirectUrl, discovery }));
        observed = revision;
      }
      return true;
    });
  }
  // Before a cached token is sent: adopt a change another process made (a
  // refresh, a log-out) since this process last read or wrote the entry.
  async function observeStoredRevision() {
    if ((await readRevisionMarker(account)) === markerOf(observed)) return;
    await withCredentialLock(account, async () => {
      adopt(await readStoredCredentials(credentialStore, account));
      // Repair a missing or stale marker (an entry stored before markers
      // existed, an interrupted change) so the next request reads no keychain.
      if ((await readRevisionMarker(account)) !== markerOf(observed)) await writeRevisionMarker(account, observed);
    });
  }
  // The SDK saves only inside a login, which holds the lock and has just
  // adopted the stored entry.
  const save = async (change) => {
    if (!(await update(change))) throw fail();
  };
  const provider = {
    get redirectUrl() { return redirectUrl; },
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
    clientInformation: async () => { await ready(); return clientInformation; },
    saveClientInformation: (value) => save(() => { clientInformation = value; }),
    tokens: async () => { await ready(); return tokens; },
    saveTokens: async (value) => {
      lifetime.signal.throwIfAborted();
      await save(() => { tokens = value; });
    },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => {
      if (!verifier) throw fail();
      return verifier;
    },
    discoveryState: () => discovery,
    saveDiscoveryState: (value) => save(() => { discovery = value; }),
    invalidateCredentials: async (scope) => {
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
      if (scope === 'discovery') discovery = undefined;
      if (scope !== 'all' && scope !== 'tokens' && scope !== 'client') return;
      await update(() => {
        if (scope !== 'client') tokens = undefined;
        if (scope !== 'tokens') clientInformation = undefined;
        if (scope === 'all') discovery = undefined;
      }, { remove: scope === 'all' });
    },
    redirectToAuthorization: async (authorizationUrl) => {
      if (!allowBrowser || browserOpened) throw reauthenticationRequired();
      const target = new URL(normalizeMcpTransportUrl(authorizationUrl));
      if (target.searchParams.get('state') !== state ||
          target.searchParams.get('code_challenge_method') !== 'S256' || !verifier) throw fail();
      browserOpened = true;
      await launchBrowser(target.href);
    },
  };
  function closeListener() {
    listener?.close();
    listener?.closeAllConnections();
    listener = undefined;
    verifier = undefined;
    state = undefined;
  }
  async function login(challenge, requestSignal, interactive, browser, attemptedToken) {
    allowBrowser = interactive;
    browserOpened = false;
    launchBrowser = browser || openBrowser;
    const signal = AbortSignal.any([lifetime.signal, requestSignal, AbortSignal.timeout(timeoutMs)]);
    const safeFetch = (input, init = {}) => fetchImpl(normalizeMcpTransportUrl(input), {
      ...init, redirect: 'error',
      signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]),
    });
    let abort;
    const callback = new Promise((resolve, reject) => {
      finishCallback = (code) => code ? resolve(code) : reject(fail());
      abort = () => finishCallback();
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
        if (interactive) await listenForCallback();
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
  async function listenForCallback() {
    listener = createServer((req, res) => {
      let target;
      try { target = new URL(req.url || '/', redirectUrl); } catch {
        res.writeHead(400).end('Invalid OAuth callback');
        return;
      }
      const supplied = Buffer.from(target.searchParams.get('state') || '');
      const expected = Buffer.from(state || '');
      const valid = req.method === 'GET' && req.headers.host === new URL(redirectUrl).host &&
        target.pathname === '/oauth/callback' && target.searchParams.getAll('state').length === 1 &&
        supplied.length === expected.length && timingSafeEqual(supplied, expected);
      if (!valid || (!target.searchParams.has('error') && target.searchParams.getAll('code').length !== 1)) {
        res.writeHead(400, { 'Cache-Control': 'no-store' }).end('Invalid OAuth callback');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end('You may return to Mixdog.');
      finishCallback(target.searchParams.has('error') ? undefined : target.searchParams.get('code'));
    });
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
    async fetch(input, init = {}, requestLogin = () => false, browser, isTransportEndpoint = () => false) {
      // An unreadable (e.g. locked) keychain must not block a server that
      // needs no authentication; credentials are required only on challenge.
      let storeUnreadable = false;
      try { await ready(); } catch { storeUnreadable = true; }
      lifetime.signal.throwIfAborted();
      const signal = AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : [])]);
      const sameOrigin = new URL(input).href === new URL(url).href ||
        (new URL(input).origin === new URL(url).origin && isTransportEndpoint(input));
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
        flight = login(challenge, flightController.signal, requestLogin(), browser, attemptedToken)
          .finally(() => { flight = undefined; });
      }
      if (flight) {
        waiters++;
        let abort;
        try {
          await Promise.race([flight, new Promise((_, reject) => {
            abort = () => reject(fail());
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          })]);
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
        await update(() => { tokens = undefined; }, { expected: sentRevision });
        throw reauthenticationRequired();
      }
      return retried;
    },
    secrets: () => [...held],
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
