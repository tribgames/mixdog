// Muse Code login: OAuth 2.0 device authorization grant against Meta, then a
// one-time exchange of the account token for the subscription Model API key.
import { getLlmDispatcher } from '../../../shared/llm/http-agent.mjs';
import { openLoginUrl } from './lib/open-login-url.mjs';
import {
  CLIENT_ID,
  DEVICE_AUTH_URL,
  DEVICE_TOKEN_URL,
  credentialsFromKeyResponse,
  museError,
  museHeaders,
  requestMuseCodeKey,
  saveTokens,
  scrubMuseSecrets,
} from './muse-code-oauth-tokens.mjs';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_INTERVAL_S = 5;
const MIN_INTERVAL_S = 1;
const SLOW_DOWN_STEP_S = 5;
const MAX_BACKOFF_INTERVAL_MS = 60_000;
export const DEVICE_REQUEST_TIMEOUT_MS = 30_000;
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_TRANSIENT_FAILURES = 3;

// Retry-After as delta-seconds or an HTTP date; 0 when absent or unusable.
function retryAfterMs(res, now) {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now()) : 0;
}

export const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const cancelled = (signal) =>
  museError(`[muse-code-oauth] login cancelled${signal?.reason?.message ? `: ${signal.reason.message}` : ''}`, {
    kind: 'cancelled',
    cancelled: true,
  });

// `kind` names the failure class for transport errors (device-auth or device-token).
async function postForm(url, params, { fetchFn, signal, kind = 'device-auth' }) {
  const timeout = AbortSignal.timeout(DEVICE_REQUEST_TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: museHeaders({ 'Content-Type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams(params),
      // The body carries the device code: a redirect must never receive it.
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      dispatcher: getLlmDispatcher(),
    });
    text = await res.text();
  } catch (cause) {
    if (signal?.aborted) throw cancelled(signal);
    if (timeout.aborted) {
      throw museError(`[muse-code-oauth] request to ${new URL(url).host} timed out`, { kind: 'timeout' });
    }
    throw museError(
      `[muse-code-oauth] ${kind} request failed: ${scrubMuseSecrets(String(cause?.message || cause)).slice(0, 300)}`,
      {
        kind,
      }
    );
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body handled by callers */
  }
  return { res, text, json };
}

export async function requestDeviceAuthorization({ fetchFn = fetch, signal } = {}) {
  const { res, text, json } = await postForm(DEVICE_AUTH_URL, { client_id: CLIENT_ID }, { fetchFn, signal });
  if (!res.ok) {
    throw museError(`[muse-code-oauth] device authorization ${res.status}: ${scrubMuseSecrets(text).slice(0, 300)}`, {
      kind: 'device-auth',
      status: res.status,
    });
  }
  const stringOrEmpty = (v) => (typeof v === 'string' && v.length > 0 ? v : '');
  const deviceCode = stringOrEmpty(json?.device_code);
  const userCode = stringOrEmpty(json?.user_code);
  const verificationUri = stringOrEmpty(json?.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw museError('[muse-code-oauth] device authorization response is missing required fields', {
      kind: 'validation',
      status: res.status,
    });
  }
  const interval = typeof json.interval === 'number' && Number.isFinite(json.interval) ? json.interval : null;
  // A supplied expiry (even zero or negative) is a deadline; only an absent one means none.
  const expiresIn = typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) ? json.expires_in : null;
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: stringOrEmpty(json.verification_uri_complete),
    intervalS: Math.max(MIN_INTERVAL_S, interval ?? DEFAULT_INTERVAL_S),
    // Null means the server gave no expiry: the flow then runs until approval,
    // denial, or cancellation.
    expiresInS: expiresIn,
  };
}

/** Poll the token endpoint until approval, denial, or expiry; resolves the account access token. */
export async function pollDeviceToken(device, { fetchFn = fetch, signal, sleep = defaultSleep, now = Date.now } = {}) {
  const expired = () =>
    museError('[muse-code-oauth] device code expired — start the login again', {
      kind: 'device-token',
      code: 'expired_token',
    });
  const deadline = typeof device.expiresInS === 'number' ? now() + device.expiresInS * 1000 : Number.POSITIVE_INFINITY;
  let intervalMs = Math.round(Math.max(MIN_INTERVAL_S, device.intervalS) * 1000);
  let failures = 0;
  while (now() < deadline) {
    // The in-flight request dies with the device code.
    const remaining = deadline - now();
    let pollSignal = signal;
    if (Number.isFinite(remaining)) {
      const timeout = AbortSignal.timeout(remaining);
      pollSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    }
    let reply;
    let waitMs = intervalMs;
    try {
      reply = await postForm(
        DEVICE_TOKEN_URL,
        { client_id: CLIENT_ID, device_code: device.deviceCode, grant_type: DEVICE_GRANT_TYPE },
        { fetchFn, signal: pollSignal, kind: 'device-token' }
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      // Expiry aborted the request: that is the expiry outcome, not a transport error.
      if (now() >= deadline || (pollSignal?.aborted && pollSignal !== signal)) break;
      // Only timeouts and network failures are transient.
      if ((err.kind !== 'timeout' && err.kind !== 'device-token') || ++failures > MAX_TRANSIENT_FAILURES) throw err;
      // RFC 8628 §3.5: after a connection timeout the client backs off by
      // increasing the polling interval; the increase persists for the rest of the flow.
      // Already at (or past) the cap: backing off further is impossible, and polling
      // again at the same frequency would defeat the backoff, so fail instead.
      if (intervalMs >= MAX_BACKOFF_INTERVAL_MS) throw err;
      intervalMs = Math.min(intervalMs * 2, MAX_BACKOFF_INTERVAL_MS);
      await sleep(Math.min(intervalMs, deadline - now()), signal);
      continue;
    }
    const { res, text, json } = reply;
    const error = typeof json?.error === 'string' ? json.error : '';
    if (res.ok && !error && typeof json?.access_token === 'string' && json.access_token) return json.access_token;
    const knownOutcome = ['authorization_pending', 'slow_down', 'expired_token', 'access_denied'].includes(error);
    const transient = !knownOutcome && TRANSIENT_STATUSES.has(res.status);
    if (transient) {
      if (++failures > MAX_TRANSIENT_FAILURES) {
        throw museError(
          `[muse-code-oauth] device token ${res.status}: ${scrubMuseSecrets(text, [device.deviceCode]).slice(0, 300)}`,
          { kind: 'device-token', status: res.status }
        );
      }
      if (res.status === 429) intervalMs += SLOW_DOWN_STEP_S * 1000;
      waitMs = Math.max(intervalMs, retryAfterMs(res, now));
    } else {
      failures = 0;
    }
    if (transient) {
      /* retry after waitMs */
    } else if (error === 'authorization_pending') {
      /* keep polling */
    } else if (error === 'slow_down') {
      intervalMs += SLOW_DOWN_STEP_S * 1000;
      waitMs = intervalMs;
    } else if (error === 'expired_token') {
      throw expired();
    } else if (error === 'access_denied') {
      throw museError('[muse-code-oauth] sign-in was denied', {
        kind: 'device-token',
        code: 'access_denied',
        status: res.status,
        reauthRequired: true,
      });
    } else {
      const description = typeof json?.error_description === 'string' ? json.error_description : '';
      const detail = [error, description].filter(Boolean).join(': ') || text;
      throw museError(
        `[muse-code-oauth] device token ${res.status}: ${scrubMuseSecrets(detail, [device.deviceCode]).slice(0, 300)}`,
        { kind: 'device-token', status: res.status, ...(error ? { code: error } : {}) }
      );
    }
    const left = deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(waitMs, left), signal);
  }
  throw expired();
}

/** Mint the Model API key for a fresh account token and persist the credential. */
export async function completeLogin(accessToken, { fetchFn = fetch, signal } = {}) {
  const payload = await requestMuseCodeKey(accessToken, { onboard: true, fetchFn, signal });
  const credentials = credentialsFromKeyResponse(payload, accessToken);
  saveTokens(credentials);
  return credentials;
}

export async function beginOAuthLogin({ openBrowser = true, fetchFn = fetch, sleep, now } = {}) {
  const controller = new AbortController();
  const device = await requestDeviceAuthorization({ fetchFn, signal: controller.signal });
  const url = device.verificationUriComplete || device.verificationUri;
  process.stderr.write(`\n[muse-code-oauth] Enter code: ${device.userCode}\n[muse-code-oauth] Open: ${url}\n\n`);
  if (openBrowser) await openLoginUrl('muse-code-oauth', url);
  const waitForCallback = pollDeviceToken(device, { fetchFn, signal: controller.signal, sleep, now }).then(
    (accessToken) => completeLogin(accessToken, { fetchFn, signal: controller.signal })
  );
  // A cancelled flow rejects with no listener attached yet in some hosts.
  waitForCallback.catch(() => {});
  return {
    provider: 'muse-code-oauth',
    url,
    manualUrl: null,
    userCode: device.userCode,
    waitForCallback,
    cancel: () => controller.abort(new Error('Muse Code login cancelled')),
  };
}

export async function loginOAuth() {
  const login = await beginOAuthLogin();
  return await login.waitForCallback;
}
