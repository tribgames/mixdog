// Grok OAuth browser login + PKCE exchange against xAI's shared OAuth client
// (the consent screen renders it as "Grok Build"). A machine with no browser
// (`openBrowser: false`) signs in by RFC 8628 device code instead.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { createOAuthPkce, parseOAuthCodeInput } from './lib/oauth-pkce.mjs';
import { OAUTH_PAGE_CONTENT_TYPE, oauthErrorHtml, oauthSuccessHtml } from './lib/oauth-page.mjs';
import { emailFromJwts } from './lib/oauth-token-utils.mjs';
import {
  CLIENT_ID,
  SCOPE,
  CALLBACK_HOST,
  CALLBACK_PORT,
  CALLBACK_PATH,
  REDIRECT_URI,
  TOKEN_TIMEOUT_MS,
  LOGIN_TIMEOUT_MS,
  fetchDiscovery,
  _normalizeExpiresAt,
  _identityFromAccessToken,
  saveTokens,
  _scrubTokens,
} from './grok-oauth-tokens.mjs';

// The device flow is xAI's own headless path (`grok login --device-auth`): the
// user opens the URL on any device and confirms the code while this host polls,
// so no loopback listener, port forward or pasted redirect is involved.
const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
// The path the issuer's discovery document advertises as its
// device_authorization_endpoint; the token endpoint is the discovered one.
const DEVICE_CODE_PATH = '/oauth2/device/code';
const DEFAULT_DEVICE_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
// The Grok CLI keeps polling for at least ten minutes whatever expires_in says.
const MIN_DEVICE_EXPIRY_S = 600;
const SAFE_USER_CODE = /^[A-Za-z0-9-]+$/;

export function generatePKCE() {
  return createOAuthPkce();
}

// The tokens a successful grant (authorization code or device code) yields.
function tokensFromGrant(json, discovery) {
  if (!json.access_token || !json.refresh_token) {
    throw new Error('[grok-oauth] token exchange response missing access_token or refresh_token');
  }
  const identity = _identityFromAccessToken(json.access_token);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at:
      typeof json.expires_in === 'number' ? Date.now() + json.expires_in * 1000 : _normalizeExpiresAt(json.expires_at),
    token_endpoint: discovery.token_endpoint,
    user_id: identity.user_id || '',
    principal_type: json.principal_type || identity.principal_type || '',
    principal_id: json.principal_id || identity.principal_id || '',
    ...(emailFromJwts(json.id_token, json.access_token)
      ? { email: emailFromJwts(json.id_token, json.access_token) }
      : {}),
  };
}

export async function exchangeAuthorizationCode({ discovery, pkce, code, signal = null }) {
  signal?.throwIfAborted();
  const cleanCode = String(code || '').trim();
  if (!cleanCode) throw new Error('[grok-oauth] authorization code is required');
  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: cleanCode,
      code_verifier: pkce.verifier,
      redirect_uri: REDIRECT_URI,
      // xAI re-validates the PKCE challenge at token exchange
      // (not just the verifier), so echo it back. Omitting
      // these makes the exchange fail. Matches the Grok CLI.
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    }),
    // Secret-bearing (authorization code + verifier): refuse
    // redirects so they can't be replayed to an untrusted host.
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)])
      : AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    dispatcher: getLlmDispatcher(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text().catch(() => '');
    throw new Error(`[grok-oauth] token exchange ${tokenRes.status}: ${_scrubTokens(text).slice(0, 500)}`);
  }
  const tokens = tokensFromGrant(await tokenRes.json(), discovery);
  // A cancelled login never stores the account it was exchanging.
  signal?.throwIfAborted();
  saveTokens(tokens);
  return tokens;
}

// Not sleepWithAbort: grok-oauth-isolated.test.mjs loads this file in a VM
// sandbox that admits no dependency beyond its reviewed list.
const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

const hasAsciiControl = (text) => [...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);

// The Grok CLI's verification-URI rules (validate_verification_uri): a string
// without ASCII control characters (they could reach the terminal) that parses
// as a URL and is https, or http only for localhost / 127.0.0.1.
function verificationUri(value, field) {
  if (typeof value !== 'string') throw new Error(`[grok-oauth] device authorization ${field} must be a string`);
  if (hasAsciiControl(value) || !URL.canParse(value)) {
    throw new Error('[grok-oauth] device authorization returned an invalid verification URI');
  }
  const { protocol, hostname } = new URL(value);
  const loopback = protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1');
  if (protocol !== 'https:' && !loopback) {
    throw new Error('[grok-oauth] device authorization returned an unsupported verification URI scheme');
  }
  return value;
}

// The vendor reads these as typed integers: a string or a fraction is a
// malformed response.
function integerField(value, field) {
  if (!Number.isInteger(value)) {
    throw new Error(`[grok-oauth] device authorization ${field} must be an integer`);
  }
  return value;
}

const requestSignal = (signal) => AbortSignal.any([signal, AbortSignal.timeout(TOKEN_TIMEOUT_MS)]);

function postDeviceForm(url, params, signal) {
  return fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    // The device code is secret-bearing: refuse redirects.
    redirect: 'error',
    signal: requestSignal(signal),
    dispatcher: getLlmDispatcher(),
  });
}

// null when the issuer has no device flow (404), as the Grok CLI reads it:
// the caller then falls back to the loopback login.
async function requestDeviceCode(discovery, signal) {
  const res = await postDeviceForm(
    new URL(DEVICE_CODE_PATH, discovery.token_endpoint).href,
    { client_id: CLIENT_ID, scope: SCOPE },
    signal
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[grok-oauth] device authorization ${res.status}: ${_scrubTokens(text).slice(0, 300)}`);
  }
  const json = await res.json().catch(() => null);
  const deviceCode = typeof json?.device_code === 'string' ? json.device_code : '';
  const userCode = typeof json?.user_code === 'string' ? json.user_code : '';
  if (!deviceCode || !SAFE_USER_CODE.test(userCode)) {
    throw new Error('[grok-oauth] device authorization response is missing or has invalid required fields');
  }
  // Both addresses are checked on their own: an invalid one fails the login
  // rather than yielding to the other. The complete one (code pre-filled) wins.
  const plainUrl = verificationUri(json.verification_uri, 'verification_uri');
  const completeUrl = json.verification_uri_complete ?? null;
  const verificationUrl = completeUrl === null ? plainUrl : verificationUri(completeUrl, 'verification_uri_complete');
  const interval = json.interval ?? null;
  return {
    deviceCode,
    userCode,
    verificationUrl,
    // 5 s only when the interval is omitted; zero or a negative value clamps to one second.
    intervalS: Math.max(interval === null ? DEFAULT_DEVICE_INTERVAL_S : integerField(interval, 'interval'), 1),
    expiresInS: Math.max(integerField(json.expires_in, 'expires_in'), MIN_DEVICE_EXPIRY_S),
  };
}

const deviceExpired = () => new Error('[grok-oauth] device code expired — start the login again');

/** Poll until approval, denial or expiry; resolves the token response of the grant. */
async function pollDeviceGrant(device, discovery, { signal, sleep, now }) {
  const deadline = now() + device.expiresInS * 1000;
  let intervalMs = device.intervalS * 1000;
  for (;;) {
    // A poll straight after the code was issued only answers authorization_pending.
    await sleep(intervalMs, signal);
    if (now() > deadline) throw deviceExpired();
    let res;
    let text;
    try {
      res = await postDeviceForm(
        discovery.token_endpoint,
        { grant_type: DEVICE_GRANT_TYPE, device_code: device.deviceCode, client_id: CLIENT_ID },
        signal
      );
      text = await res.text();
    } catch (err) {
      // As in the Grok CLI, a transport failure ends the login at once.
      throw new Error(`[grok-oauth] device token request failed: ${_scrubTokens(String(err?.message || err))}`);
    }
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* a non-JSON body is reported below */
    }
    if (res.ok && json?.access_token) return json;
    const error = typeof json?.error === 'string' ? json.error : '';
    // Only these two answers keep the poll going; anything else ends the login.
    if (error === 'slow_down') {
      intervalMs += SLOW_DOWN_STEP_S * 1000;
    } else if (error === 'access_denied') {
      throw new Error('[grok-oauth] sign-in was denied');
    } else if (error === 'expired_token') {
      throw deviceExpired();
    } else if (error !== 'authorization_pending') {
      throw new Error(`[grok-oauth] device token ${res.status}: ${error || _scrubTokens(text).slice(0, 300)}`);
    }
  }
}

async function beginDeviceLogin(discovery, { sleep, now }) {
  const controller = new AbortController();
  const device = await requestDeviceCode(discovery, controller.signal);
  if (!device) return null;
  process.stderr.write(
    `\n[grok-oauth] Enter code: ${device.userCode}\n[grok-oauth] Open: ${device.verificationUrl}\n\n`
  );
  const waitForCallback = pollDeviceGrant(device, discovery, { signal: controller.signal, sleep, now })
    .then((json) => {
      const tokens = tokensFromGrant(json, discovery);
      // A cancelled login never stores the account it was granted.
      controller.signal.throwIfAborted();
      saveTokens(tokens);
      return tokens;
    })
    .catch((error) => {
      // Cancelling settles quietly, as it does for the loopback login.
      if (controller.signal.aborted) return null;
      throw error;
    });
  // A caller may only ever cancel; a later failure must not be unhandled.
  waitForCallback.catch(() => {});
  return {
    provider: 'grok-oauth',
    url: device.verificationUrl,
    manualUrl: null,
    userCode: device.userCode,
    waitForCallback,
    cancel: () => controller.abort(new Error('Grok login cancelled')),
  };
}

export async function beginOAuthLogin({ openBrowser = true, sleep = defaultSleep, now = Date.now } = {}) {
  const discovery = await fetchDiscovery();
  if (!openBrowser) {
    const device = await beginDeviceLogin(discovery, { sleep, now });
    if (device) return device;
  }
  const pkce = generatePKCE();
  const state = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('hex');
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('plan', 'generic');
  url.searchParams.set('referrer', 'mixdog');

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
    exchangePromise = exchangeAuthorizationCode({ discovery, pkce, code, signal: controller.signal });
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
      if (!code || u.searchParams.get('state') !== state) {
        // Reject this request only; the valid callback may still arrive.
        res.writeHead(400, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE });
        res.end(oauthErrorHtml('The sign-in callback was invalid or did not match this login.'));
        return;
      }
      try {
        await acceptCode(code);
        res.writeHead(200, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE });
        res.end(oauthSuccessHtml('Grok'));
      } catch {
        // The shared exchange reports its error through waitForCallback.
        res.writeHead(500, { 'Content-Type': OAUTH_PAGE_CONTENT_TYPE });
        res.end(oauthErrorHtml('Grok could not complete the token exchange.'));
      }
    });
    timeout = setTimeout(() => finish(null), LOGIN_TIMEOUT_MS);
    server.listen(CALLBACK_PORT, CALLBACK_HOST, async () => {
      process.stderr.write(
        `\n[grok-oauth] Open this URL to log in (consent shows as "Grok Build"):\n${url.toString()}\n\n`
      );
      if (!openBrowser) return;
      try {
        const { openInBrowser } = await import('../../../shared/open-url.mjs');
        openInBrowser(url.toString());
      } catch (err) {
        process.stderr.write(`[grok-oauth] browser open failed: ${String(err?.message || err).slice(0, 200)}\n`);
      }
    });
    server.on('error', (err) =>
      finish(
        null,
        new Error(`[grok-oauth] callback server failed on ${CALLBACK_HOST}:${CALLBACK_PORT}: ${err?.message || err}`)
      )
    );
  });

  return {
    provider: 'grok-oauth',
    url: url.toString(),
    waitForCallback,
    completeCode: async (input) => {
      const parsed = parseOAuthCodeInput(input, { allowHashState: true });
      if (parsed.state && parsed.state !== state) throw new Error('[grok-oauth] OAuth state mismatch');
      if (!parsed.code) throw new Error('[grok-oauth] authorization code is required');
      return await acceptCode(parsed.code);
    },
    cancel: () => {
      finish?.(null);
    },
  };
}

export async function loginOAuth() {
  const login = await beginOAuthLogin();
  return await login.waitForCallback;
}
