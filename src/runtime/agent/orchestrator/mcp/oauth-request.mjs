import { anySignal, loginFailed, reauthenticationRequired } from './oauth-shared.mjs';

/**
 * The authenticated `fetch` of one server over its credential `cache`: it
 * sends the cached token to the server's own endpoints and, on a challenge,
 * joins the single login in flight (starting it with `login` when none is).
 */
export function createAuthorizedFetch({ url, cache, login, fetchImpl, lifetimeSignal }) {
  const { creds } = cache;
  let flight;
  let waiters = 0;
  let flightController;
  // An unreadable (e.g. locked) keychain must not block a server that needs no
  // authentication; credentials are required only on challenge.
  const storeReadable = () =>
    cache.ready().then(
      () => true,
      () => false
    );
  // One request, carrying the cached token only to the server's own endpoints.
  // Reports the revision and token it was sent with, and whether the cached
  // token could not be verified.
  async function sendRequest(input, options, signal, sameOrigin) {
    let unreadable = false;
    if (creds.tokens && sameOrigin) {
      try {
        await cache.observeStoredRevision();
      } catch {
        // Unverifiable (e.g. locked keychain): never send the cached token.
        creds.tokens = creds.loaded = undefined;
        unreadable = true;
      }
    }
    signal.throwIfAborted();
    const { observed: revision, tokens } = creds;
    const headers = new Headers(options.headers);
    if (tokens && sameOrigin) headers.set('Authorization', `Bearer ${tokens.access_token}`);
    else headers.delete('Authorization');
    const response = await fetchImpl(input, { ...options, headers, signal, redirect: 'error' });
    return { response, revision, tokens, unreadable };
  }
  function startLogin(challenge, requestLogin, browser, attemptedToken, serverName) {
    flightController = new AbortController();
    flight = login(challenge, flightController.signal, requestLogin(), browser, attemptedToken, serverName).finally(
      () => {
        flight = undefined;
      }
    );
  }
  // Wait for the login in flight; the last waiter to leave cancels it.
  async function awaitLogin(signal, onAuthorized) {
    waiters++;
    let abort;
    try {
      await Promise.race([
        flight,
        new Promise((_, reject) => {
          abort = () => reject(loginFailed());
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
        // The cancelled login's own failure is not this request's.
        await flight.catch(() => {});
      }
    }
  }
  async function authorizedFetch(
    input,
    options = {},
    requestLogin = () => false,
    browser,
    isTransportEndpoint = () => false,
    serverName = undefined,
    onAuthorized = () => {}
  ) {
    let storeUnreadable = !(await storeReadable());
    lifetimeSignal.throwIfAborted();
    const signal = anySignal(lifetimeSignal, options.signal);
    const target = new URL(input);
    const server = new URL(url);
    const sameOrigin = target.href === server.href || (target.origin === server.origin && isTransportEndpoint(input));
    const sent = await sendRequest(input, options, signal, sameOrigin);
    const { response } = sent;
    const attemptedToken = sent.tokens;
    storeUnreadable ||= sent.unreadable;
    if (!sameOrigin || ![401, 403].includes(response.status)) return response;
    const { extractWWWAuthenticateParams } = await import('@modelcontextprotocol/sdk/client/auth.js');
    const challenge = extractWWWAuthenticateParams(response);
    if (response.status === 403 && challenge.error !== 'insufficient_scope') return response;
    await response.body?.cancel();
    if (storeUnreadable) throw reauthenticationRequired();
    if (!flight && creds.tokens === attemptedToken) {
      startLogin(challenge, requestLogin, browser, attemptedToken, serverName);
    }
    if (flight) await awaitLogin(signal, onAuthorized);
    lifetimeSignal.throwIfAborted();
    signal.throwIfAborted();
    const retry = await sendRequest(input, options, signal, sameOrigin);
    const retried = retry.response;
    if (retried.status === 401 || retried.status === 403) {
      await retried.body?.cancel();
      // Forget the rejected tokens unless a refresh (here or in another
      // process) or a log-out replaced them since this retry was sent.
      await cache.update(
        () => {
          creds.tokens = undefined;
        },
        { expected: retry.revision }
      );
      throw reauthenticationRequired();
    }
    return retried;
  }
  return { fetch: authorizedFetch, cancelLogin: () => flightController?.abort() };
}
