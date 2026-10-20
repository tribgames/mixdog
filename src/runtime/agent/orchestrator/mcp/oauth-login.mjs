import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { normalizeMcpTransportUrl } from './client-config.mjs';
import { identityFromTokenResponse } from './oauth-account.mjs';
import { answerOAuthCallback } from './oauth-callback.mjs';
import { anySignal, loginFailed, reauthenticationRequired } from './oauth-shared.mjs';

/**
 * The browser login of one connection over its credential `cache` and login
 * `flow` state: the loopback callback listener and the SDK authorization
 * (refresh, registration, redirect and code exchange).
 */
export function createLoginFlow({ url, cache, flow, provider, lifetimeSignal, openBrowser, fetchImpl, timeoutMs }) {
  const { creds } = cache;
  function stopListening() {
    flow.listener?.close();
    flow.listener?.closeAllConnections();
    flow.listener = undefined;
  }
  function closeListener() {
    stopListening();
    flow.verifier = undefined;
    flow.state = undefined;
  }
  // The login's callback is answered once, by the loopback or a paste.
  function answerCallback(code) {
    const finish = flow.finishCallback;
    flow.finishCallback = undefined;
    finish?.(code);
  }
  async function listenForCallback(serverName) {
    flow.listener = createServer((req, res) =>
      answerOAuthCallback(req, res, {
        redirectUrl: creds.redirectUrl,
        state: flow.state,
        finish: flow.finishCallback && answerCallback,
        serverName,
      })
    );
    await new Promise((resolve, reject) => {
      flow.listener.once('error', reject);
      // Retain the registered redirect URI if this connection later needs
      // refresh or reauthorization; never register a different callback.
      flow.listener.listen(creds.redirectUrl ? Number(new URL(creds.redirectUrl).port) : 0, '127.0.0.1', resolve);
    });
    creds.redirectUrl = `http://127.0.0.1:${flow.listener.address().port}/oauth/callback`;
  }
  async function login(challenge, requestSignal, interactive, browser, attemptedToken, serverName) {
    flow.allowBrowser = interactive;
    flow.browserOpened = false;
    flow.launchBrowser = browser || openBrowser;
    const signal = AbortSignal.any([lifetimeSignal, requestSignal, AbortSignal.timeout(timeoutMs)]);
    // Who this login's tokens belong to (oauth-account.mjs): the SDK keeps only
    // the token fields, so the token endpoint's answer is read here.
    flow.identity = undefined;
    const safeFetch = async (input, init = {}) => {
      const response = await fetchImpl(normalizeMcpTransportUrl(input), {
        ...init,
        redirect: 'error',
        signal: anySignal(signal, init.signal),
      });
      if (response.ok && /(^|&)grant_type=/.test(String(init.body ?? ''))) {
        flow.identity = identityFromTokenResponse(
          await response
            .clone()
            .json()
            .catch(() => null)
        );
      }
      return response;
    };
    // The caller's progress hooks (mcp-oauth-login.mjs): the callback arrived,
    // then the tokens are stored.
    const progress = (hook) => {
      try {
        browser?.[hook]?.();
      } catch {
        /* progress reporting never fails the login */
      }
    };
    let abort;
    const callback = new Promise((resolve, reject) => {
      const finish = (code) => (code ? resolve(code) : reject(loginFailed()));
      flow.finishCallback = finish;
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
      const result = await cache.withLock(async () => {
        await cache.adoptStored();
        if (creds.tokens && creds.tokens.access_token !== attemptedToken?.access_token) return 'AUTHORIZED';
        const registered = provider.preRegistered || creds.clientInformation;
        if (!interactive && (!creds.tokens?.refresh_token || !registered || !creds.redirectUrl)) {
          throw reauthenticationRequired();
        }
        flow.state = randomBytes(32).toString('base64url');
        if (interactive) await listenForCallback(serverName);
        signal.throwIfAborted();
        return auth(provider, options);
      });
      if (result === 'REDIRECT') {
        const code = await callback;
        signal.throwIfAborted();
        progress('onCallback');
        const exchanged = await cache.withLock(async () => {
          // The entry this login registered in is gone only after a log-out
          // since it began, which wins: never recreate it.
          await cache.adoptStored();
          if (creds.observed === null) throw loginFailed();
          return auth(provider, { ...options, authorizationCode: code });
        });
        if (exchanged !== 'AUTHORIZED') throw loginFailed();
      }
      progress('onAuthorized');
      signal.throwIfAborted();
    } catch (error) {
      // SDK errors may contain authorization server response bodies/secrets.
      if (error?.code === 'reauthenticationRequired' || !interactive) throw reauthenticationRequired();
      throw loginFailed();
    } finally {
      flow.allowBrowser = false;
      signal.removeEventListener('abort', abort);
      closeListener();
      flow.finishCallback = undefined;
    }
  }
  return { login, stopListening, closeListener, answerCallback };
}
