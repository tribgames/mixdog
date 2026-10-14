import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import keychain from '../../../../lib/keychain-cjs.cjs';
import { openInBrowser } from '../../../shared/open-url.mjs';
import { normalizeMcpTransportUrl } from './client-config.mjs';

export const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000;

const scopes = new WeakMap();
const reauthenticationRequired = () => Object.assign(
  new Error('MCP OAuth reauthenticationRequired: reconnect explicitly to log in'),
  { code: 'reauthenticationRequired' },
);

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
  const account = `mcp-oauth:${createHash('sha256').update(url).digest('hex')}`;
  let loaded;
  const ready = () => loaded ??= (async () => {
    const saved = await credentialStore.getSecretAsync(account);
    if (!saved) return;
    const value = JSON.parse(saved);
    if (value.url !== url) throw reauthenticationRequired();
    ({ tokens, clientInformation, redirectUrl, discovery } = value);
  })();
  const persist = () => credentialStore.setSecretAsync(account,
    JSON.stringify({ url, tokens, clientInformation, redirectUrl, discovery }));
  const fail = () => new Error('MCP OAuth login failed, cancelled, or timed out');
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
    saveClientInformation: async (value) => { clientInformation = value; await persist(); },
    tokens: async () => { await ready(); return tokens; },
    saveTokens: async (value) => { lifetime.signal.throwIfAborted(); tokens = value; await persist(); },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => {
      if (!verifier) throw fail();
      return verifier;
    },
    discoveryState: () => discovery,
    saveDiscoveryState: async (value) => { discovery = value; await persist(); },
    invalidateCredentials: async (scope) => {
      if (scope === 'all' || scope === 'tokens') tokens = undefined;
      if (scope === 'all' || scope === 'client') clientInformation = undefined;
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
      if (scope === 'all' || scope === 'discovery') discovery = undefined;
      if (scope === 'all') await credentialStore.deleteSecretAsync(account);
      else if (scope === 'tokens' || scope === 'client') await persist();
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
  async function login(challenge, requestSignal, interactive, browser) {
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
      if (!interactive && (!tokens?.refresh_token || !clientInformation || !redirectUrl)) {
        throw reauthenticationRequired();
      }
      const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
      state = randomBytes(32).toString('base64url');
      if (interactive) listener = createServer((req, res) => {
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
      if (interactive) await new Promise((resolve, reject) => {
        listener.once('error', reject);
        // Retain the registered redirect URI if this connection later needs
        // refresh or reauthorization; never register a different callback.
        listener.listen(redirectUrl ? Number(new URL(redirectUrl).port) : 0, '127.0.0.1', resolve);
      });
      signal.throwIfAborted();
      if (interactive) redirectUrl = `http://127.0.0.1:${listener.address().port}/oauth/callback`;
      const options = { serverUrl: url, ...challenge, fetchFn: safeFetch };
      const result = await auth(provider, options);
      if (result === 'REDIRECT') {
        const code = await callback;
        signal.throwIfAborted();
        if (await auth(provider, { ...options, authorizationCode: code }) !== 'AUTHORIZED') throw fail();
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
  return {
    provider,
    signal: lifetime.signal,
    async fetch(input, init = {}, requestLogin = () => false, browser, isTransportEndpoint = () => false) {
      try { await ready(); } catch { throw reauthenticationRequired(); }
      lifetime.signal.throwIfAborted();
      const signal = AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : [])]);
      const sameOrigin = new URL(input).href === new URL(url).href ||
        (new URL(input).origin === new URL(url).origin && isTransportEndpoint(input));
      const request = () => {
        const headers = new Headers(init.headers);
        if (tokens && sameOrigin) headers.set('Authorization', `Bearer ${tokens.access_token}`);
        else headers.delete('Authorization');
        return fetchImpl(input, { ...init, headers, signal, redirect: 'error' });
      };
      const attemptedToken = tokens;
      const response = await request();
      if (!sameOrigin || ![401, 403].includes(response.status)) return response;
      const { extractWWWAuthenticateParams } = await import('@modelcontextprotocol/sdk/client/auth.js');
      const challenge = extractWWWAuthenticateParams(response);
      if (response.status === 403 && challenge.error !== 'insufficient_scope') return response;
      await response.body?.cancel();
      if (!flight && tokens === attemptedToken) {
        flightController = new AbortController();
        flight = login(challenge, flightController.signal, requestLogin(), browser)
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
        await provider.invalidateCredentials('tokens');
        throw reauthenticationRequired();
      }
      return retried;
    },
    close() {
      lifetime.abort();
      finishCallback?.();
      closeListener();
    },
  };
}
