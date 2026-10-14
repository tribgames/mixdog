import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openInBrowser } from '../../../shared/open-url.mjs';
import { normalizeMcpTransportUrl } from './client-config.mjs';

export const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000;

// Credentials belong to this connection only: no configuration writes, disk
// cache, URL logging, or cross-server/cross-session token sharing.
export function createMcpOAuth({ url, openBrowser = openInBrowser, fetchImpl = fetch, timeoutMs = MCP_OAUTH_TIMEOUT_MS }) {
  const lifetime = new AbortController();
  let listener;
  let redirectUrl;
  let state;
  let verifier;
  let tokens;
  let clientInformation;
  let discovery;
  let flight;
  let onStart = () => {};
  let finishCallback;
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
    clientInformation: () => clientInformation,
    saveClientInformation: (value) => { clientInformation = value; },
    tokens: () => tokens,
    saveTokens: (value) => { lifetime.signal.throwIfAborted(); tokens = value; },
    saveCodeVerifier: (value) => { verifier = value; },
    codeVerifier: () => {
      if (!verifier) throw fail();
      return verifier;
    },
    discoveryState: () => discovery,
    saveDiscoveryState: (value) => { discovery = value; },
    invalidateCredentials: (scope) => {
      if (scope === 'all' || scope === 'tokens') tokens = undefined;
      if (scope === 'all' || scope === 'client') clientInformation = undefined;
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
      if (scope === 'all' || scope === 'discovery') discovery = undefined;
    },
    redirectToAuthorization: async (authorizationUrl) => {
      const target = new URL(normalizeMcpTransportUrl(authorizationUrl));
      if (target.searchParams.get('state') !== state ||
          target.searchParams.get('code_challenge_method') !== 'S256' || !verifier) throw fail();
      await openBrowser(target.href);
    },
  };
  function closeListener() {
    listener?.close();
    listener?.closeAllConnections();
    listener = undefined;
    verifier = undefined;
    state = undefined;
  }
  async function login(challenge, requestSignal) {
    onStart();
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
      state = randomBytes(32).toString('base64url');
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
      signal.throwIfAborted();
      redirectUrl = `http://127.0.0.1:${listener.address().port}/oauth/callback`;
      const options = { serverUrl: url, ...challenge, fetchFn: safeFetch };
      const result = await auth(provider, options);
      if (result === 'REDIRECT') {
        const code = await callback;
        signal.throwIfAborted();
        if (await auth(provider, { ...options, authorizationCode: code }) !== 'AUTHORIZED') throw fail();
      }
      signal.throwIfAborted();
    } catch {
      // SDK errors may contain authorization server response bodies/secrets.
      lifetime.abort();
      throw fail();
    } finally {
      signal.removeEventListener('abort', abort);
      closeListener();
      finishCallback = undefined;
    }
  }
  return {
    provider,
    signal: lifetime.signal,
    set onStart(value) { onStart = value; },
    async fetch(input, init = {}) {
      lifetime.signal.throwIfAborted();
      const signal = AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : [])]);
      const sameOrigin = new URL(input).origin === new URL(url).origin;
      const request = () => {
        const headers = new Headers(init.headers);
        if (tokens && sameOrigin) headers.set('Authorization', `Bearer ${tokens.access_token}`);
        return fetchImpl(input, { ...init, headers, signal });
      };
      const response = await request();
      if (!sameOrigin || ![401, 403].includes(response.status)) return response;
      const { extractWWWAuthenticateParams } = await import('@modelcontextprotocol/sdk/client/auth.js');
      const challenge = extractWWWAuthenticateParams(response);
      if (response.status === 403 && challenge.error !== 'insufficient_scope') return response;
      await response.body?.cancel();
      flight ??= login(challenge, signal).finally(() => { flight = undefined; });
      await flight;
      lifetime.signal.throwIfAborted();
      const retried = await request();
      if (retried.status === 401 || retried.status === 403) {
        await retried.body?.cancel();
        throw fail();
      }
      return retried;
    },
    close() {
      lifetime.abort();
      finishCallback?.();
      closeListener();
      tokens = clientInformation = discovery = undefined;
    },
  };
}
