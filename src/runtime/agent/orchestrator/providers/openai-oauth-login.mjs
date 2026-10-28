/**
 * OpenAI ChatGPT OAuth PKCE login flow.
 *
 * PKCE generation, authorization-code
 * exchange, the localhost callback server, and interactive login helpers.
 * openai-oauth.mjs re-exports beginOAuthLogin/loginOAuth as a facade so
 * existing importers resolve unchanged. Token persistence + JWT parsing stay
 * owned by openai-oauth-tokens.mjs and are injected here to avoid a circular
 * import of its module-level token store state.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createOAuthPkce, parseOAuthCodeInput } from './lib/oauth-pkce.mjs';
import { OAUTH_PAGE_CONTENT_TYPE, oauthErrorHtml, oauthSuccessHtml } from './lib/oauth-page.mjs';
import { oauthFailureReason, oauthHttpError, oauthRequestError, oauthResponseJson } from './lib/oauth-token-utils.mjs';
import { openLoginUrl } from './lib/open-login-url.mjs';
import { sleepWithAbort } from './retry-backoff.mjs';

const DEFAULT_ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const CODEX_OAUTH_SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_TIMEOUT_MS = 30_000;
// Codex device-code login: the user has 15 minutes to enter the code.
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DEVICE_INTERVAL_S = 5;

/**
 * @param {object} deps
 * @param {string} deps.clientId
 * @param {string} deps.originator
 * @param {(token:string)=>(string|undefined)} deps.extractAccountId
 * @param {(...tokens:string[])=>(object|null)} deps.identityFromTokens
 * @param {(token:string)=>number} deps.expiryFromAccessToken
 * @param {(tokens:object)=>void} deps.saveTokens
 * @param {string} [deps.issuer] auth server base URL (tests point it at a fake server)
 * @param {(ms:number, signal?:AbortSignal)=>Promise<void>} [deps.sleep] device-poll wait (tests inject a fast one)
 * @param {()=>number} [deps.now]
 * @param {number} [deps.deviceTimeoutMs] device-code login deadline (tests shorten it)
 * @param {number} [deps.requestTimeoutMs] deadline of the device-code start request (tests shorten it)
 */
export function createOpenAIOAuthLogin(deps) {
  const {
    clientId,
    originator,
    extractAccountId,
    identityFromTokens,
    expiryFromAccessToken,
    saveTokens,
    issuer = DEFAULT_ISSUER,
    sleep = sleepWithAbort,
    now = Date.now,
    deviceTimeoutMs = DEVICE_LOGIN_TIMEOUT_MS,
    requestTimeoutMs = TOKEN_TIMEOUT_MS,
  } = deps;
  const issuerBase = issuer.replace(/\/+$/, '');
  const tokenUrl = `${issuerBase}/oauth/token`;
  const deviceApiBase = `${issuerBase}/api/accounts`;

  async function exchangeAuthorizationCode({ pkce, code, redirectUri = REDIRECT_URI, signal = null }) {
    signal?.throwIfAborted();
    const cleanCode = String(code || '').trim();
    if (!cleanCode) throw new Error('[openai-oauth] authorization code is required');
    let tokenRes;
    try {
      tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: cleanCode,
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: pkce.verifier,
        }),
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)])
          : AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (err) {
      throw oauthRequestError('[openai-oauth] token exchange', err);
    }
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      throw oauthHttpError('[openai-oauth] token exchange', tokenRes.status, text, [cleanCode, pkce.verifier]);
    }
    const json = await oauthResponseJson(tokenRes, '[openai-oauth] token exchange');
    if (!json.access_token || !json.refresh_token) {
      throw new Error('[openai-oauth] token exchange response missing access_token or refresh_token');
    }
    const expiresAt =
      (typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : 0) ||
      expiryFromAccessToken(json.access_token);
    const tokens = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at: expiresAt,
      account_id: extractAccountId(json.access_token),
      identity: identityFromTokens(json.id_token, json.access_token),
    };
    // A cancelled login never stores the account it was exchanging.
    signal?.throwIfAborted();
    saveTokens(tokens);
    return tokens;
  }

  const postJson = (path, body, signal) =>
    fetch(`${deviceApiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    });

  // Codex device-code flow (`codex login --device-auth`): the user enters a
  // short code at the verification URL on any machine; this host polls until
  // the server hands back an authorization code, then exchanges it with the
  // deviceauth redirect URI. Resolves null when the server has no device flow.
  async function beginDeviceLogin() {
    // No login deadline or cancel handle exists yet, so the start request
    // carries its own timeout; it also bounds reading the response body.
    const startSignal = AbortSignal.timeout(requestTimeoutMs);
    const res = await postJson('/deviceauth/usercode', { client_id: clientId }, startSignal);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`[openai-oauth] device code request failed with status ${res.status}`);
    const started = await res.json();
    const userCode = started.user_code || started.usercode;
    const deviceAuthId = started.device_auth_id;
    if (!userCode || !deviceAuthId)
      throw new Error('[openai-oauth] device code response missing user_code or device_auth_id');
    const interval = Number(String(started.interval ?? '').trim());
    const intervalMs = (Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_DEVICE_INTERVAL_S) * 1000;
    const url = `${issuerBase}/codex/device`;

    const controller = new AbortController();
    const { signal } = controller;
    const timedOut = () => new Error('[openai-oauth] device auth timed out after 15 minutes');
    // One poll, aborted at the login deadline so a stalled request cannot
    // outlive it. A reply that arrives in time is honoured whatever the clock
    // says afterwards (the user did authorize).
    const pollOnce = async (left) => {
      const deadlineController = new AbortController();
      const timer = setTimeout(() => deadlineController.abort(), left);
      try {
        const poll = await postJson(
          '/deviceauth/token',
          { device_auth_id: deviceAuthId, user_code: userCode },
          AbortSignal.any([signal, deadlineController.signal])
        );
        if (poll.ok) return { granted: await poll.json() };
        // 403/404: the user has not approved the code yet.
        if (poll.status !== 403 && poll.status !== 404) {
          throw new Error(`[openai-oauth] device auth failed with status ${poll.status}`);
        }
        return { granted: null };
      } catch (err) {
        if (!signal.aborted && deadlineController.signal.aborted) throw timedOut();
        throw err;
      } finally {
        clearTimeout(timer);
      }
    };
    const pollForCode = async () => {
      const deadline = now() + deviceTimeoutMs;
      for (;;) {
        const left = deadline - now();
        if (left <= 0) throw timedOut();
        const { granted } = await pollOnce(left);
        if (granted) return granted;
        await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), signal);
      }
    };
    const waitForCallback = (async () => {
      try {
        const granted = await pollForCode();
        return await exchangeAuthorizationCode({
          pkce: { verifier: granted.code_verifier },
          code: granted.authorization_code,
          redirectUri: `${issuerBase}/deviceauth/callback`,
          signal,
        });
      } catch (err) {
        // A cancelled login settles empty, as the browser flow does.
        if (signal.aborted) return null;
        throw err;
      }
    })();
    // A cancelled or expired login may reject before a host attaches a listener.
    waitForCallback.catch(() => {});
    process.stderr.write(
      `\n[openai-oauth] To log in to ChatGPT (OpenAI OAuth), open:\n${url}\nand enter this code: ${userCode}\n\n`
    );
    return {
      provider: 'openai-oauth',
      url,
      userCode,
      waitForCallback,
      cancel: () => controller.abort(),
    };
  }

  // Without a browser on this host (headless/SSH) the device-code flow is used;
  // like Codex, a server that has none (404) falls back to the browser flow.
  async function beginOAuthLogin({ openBrowser = true } = {}) {
    if (!openBrowser) {
      const device = await beginDeviceLogin();
      if (device) return device;
      process.stderr.write('\n[openai-oauth] Device code login is not enabled; falling back to browser login.\n');
    }
    return await beginBrowserLogin({ openBrowser });
  }

  async function beginBrowserLogin({ openBrowser }) {
    const pkce = createOAuthPkce(64);
    const state = randomBytes(16).toString('hex');
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('scope', CODEX_OAUTH_SCOPE);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('state', state);
    url.searchParams.set('originator', originator);

    let server = null;
    let timeout = null;
    let finish = null;
    let exchangePromise = null;
    const controller = new AbortController();
    // Browser and manual callbacks share one exchange: an authorization code is
    // single-use, and a duplicate must not settle the login before the first.
    const acceptCode = (code) => {
      if (exchangePromise) return exchangePromise;
      controller.signal.throwIfAborted();
      // The browser deadline ends when a code arrives; the exchange has its own.
      if (timeout) clearTimeout(timeout);
      timeout = null;
      exchangePromise = exchangeAuthorizationCode({ pkce, code, signal: controller.signal });
      exchangePromise.then(
        (tokens) => finish(tokens),
        (err) => finish(null, err instanceof Error ? err : new Error(String(err)))
      );
      return exchangePromise;
    };
    const waitForCallback = new Promise((resolve, reject) => {
      let settled = false;
      finish = (value, error = null) => {
        if (settled) return;
        settled = true;
        // Work arriving after the login settled (or was cancelled) is rejected.
        controller.abort();
        if (timeout) clearTimeout(timeout);
        try {
          server?.close();
        } catch {
          /* already closed */
        }
        if (error) reject(error);
        else resolve(value);
      };
      server = createServer(async (req, res) => {
        const u = new URL(req.url || '/', `http://${CALLBACK_HOST}:${CALLBACK_PORT}`);
        if (u.pathname !== CALLBACK_PATH) {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = u.searchParams.get('code');
        const stateMatches = u.searchParams.get('state') === state;
        if (!code || !stateMatches) {
          res.writeHead(400, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE });
          res.end(oauthErrorHtml('The sign-in callback was invalid or did not match this login.'));
          // A request for another login is rejected alone; this login's
          // legitimate callback may still arrive.
          if (stateMatches && !exchangePromise) finish(null);
          return;
        }
        try {
          await acceptCode(code);
          // The login settles (closing the server) before this response is
          // written; do not leave a keep-alive connection bound to it.
          res.writeHead(200, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE, Connection: 'close' });
          res.end(oauthSuccessHtml('OpenAI'));
        } catch (err) {
          // The shared exchange also reports its error through waitForCallback.
          res.writeHead(500, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE, Connection: 'close' });
          res.end(oauthErrorHtml(oauthFailureReason('OpenAI could not complete the token exchange.', err)));
        }
      });
      timeout = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
      server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
        process.stderr.write(
          `\n[openai-oauth] Open this URL to log in to ChatGPT (OpenAI OAuth):\n${url.toString()}\n\n`
        );
        if (openBrowser) await openLoginUrl('openai-oauth', url.toString());
      });
      server.on('error', (err) =>
        finish(
          null,
          new Error(
            `[openai-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`
          )
        )
      );
    });

    return {
      provider: 'openai-oauth',
      url: url.toString(),
      waitForCallback,
      completeCode: async (input) => {
        const parsed = parseOAuthCodeInput(input, { allowHashState: true });
        if (parsed.state && parsed.state !== state) throw new Error('[openai-oauth] OAuth state mismatch');
        if (!parsed.code) throw new Error('[openai-oauth] authorization code is required');
        return await acceptCode(parsed.code);
      },
      cancel: () => {
        finish?.(null);
      },
    };
  }

  async function loginOAuth() {
    const login = await beginOAuthLogin();
    return await login.waitForCallback;
  }

  return { beginOAuthLogin, loginOAuth };
}
