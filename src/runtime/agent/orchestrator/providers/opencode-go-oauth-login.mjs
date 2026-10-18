// OpenCode Go login: OAuth device authorization against the OpenCode Console
// (JSON bodies, client `opencode-cli`), then the account and the organization
// the token acts for.
import { openLoginUrl } from './lib/open-login-url.mjs';
import { scrubOAuthSecrets } from './lib/oauth-token-utils.mjs';
import {
  CLIENT_ID,
  DEVICE_CODE_URL,
  DEVICE_TOKEN_URL,
  ORGS_URL,
  PROVIDER_ID,
  SERVER,
  USER_URL,
  consoleGetJson,
  consoleRequest,
  openCodeGoError,
  saveTokens,
  tokenFieldsFromGrant,
} from './opencode-go-oauth-tokens.mjs';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_STEP_S = 5;
const MAX_TRANSIENT_FAILURES = 3;

const cancelled = () => openCodeGoError(`[${PROVIDER_ID}] login cancelled`, { kind: 'cancelled', cancelled: true });

export const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** The device code request; the verification URL is resolved against the Console. */
export async function requestDeviceCode({ fetchFn = fetch, signal } = {}) {
  const { res, json, text } = await consoleRequest(DEVICE_CODE_URL, {
    method: 'POST',
    body: { client_id: CLIENT_ID },
    fetchFn,
    signal,
  });
  if (!res.ok) {
    throw openCodeGoError(
      `[${PROVIDER_ID}] device authorization ${res.status}: ${scrubOAuthSecrets(text).slice(0, 300)}`,
      {
        kind: 'device-auth',
        status: res.status,
      }
    );
  }
  const deviceCode = typeof json?.device_code === 'string' ? json.device_code : '';
  const userCode = typeof json?.user_code === 'string' ? json.user_code : '';
  const verification = typeof json?.verification_uri_complete === 'string' ? json.verification_uri_complete : '';
  if (!deviceCode || !userCode || !verification) {
    throw openCodeGoError(`[${PROVIDER_ID}] device authorization response is missing required fields`, {
      kind: 'validation',
    });
  }
  const url = new URL(verification, `${SERVER}/`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw openCodeGoError(`[${PROVIDER_ID}] device verification URL is not HTTP(S)`, { kind: 'validation' });
  }
  const interval = Number(json.interval);
  const expiresIn = Number(json.expires_in);
  return {
    deviceCode,
    userCode,
    verificationUrl: url.href,
    intervalS: Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_INTERVAL_S,
    expiresInS: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : null,
  };
}

/** Poll until approval, denial or expiry; resolves the token fields of the grant. */
export async function pollDeviceToken(device, { fetchFn = fetch, signal, sleep = defaultSleep, now = Date.now } = {}) {
  const expired = () =>
    openCodeGoError(`[${PROVIDER_ID}] device code expired — start the login again`, {
      kind: 'device-token',
      code: 'expired_token',
    });
  const deadline = device.expiresInS ? now() + device.expiresInS * 1000 : Number.POSITIVE_INFINITY;
  let intervalMs = device.intervalS * 1000;
  let failures = 0;
  while (now() < deadline) {
    if (signal?.aborted) throw cancelled();
    let reply;
    try {
      reply = await consoleRequest(DEVICE_TOKEN_URL, {
        method: 'POST',
        body: { grant_type: DEVICE_GRANT_TYPE, device_code: device.deviceCode, client_id: CLIENT_ID },
        fetchFn,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw cancelled();
      if (++failures > MAX_TRANSIENT_FAILURES) throw err;
      await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), signal);
      continue;
    }
    const { res, json, text } = reply;
    const error = typeof json?.error === 'string' ? json.error : '';
    if (res.ok && !error && json?.access_token) return tokenFieldsFromGrant(json, now());
    if (error === 'authorization_pending') {
      failures = 0;
    } else if (error === 'slow_down') {
      failures = 0;
      intervalMs += SLOW_DOWN_STEP_S * 1000;
    } else if (error === 'expired_token') {
      throw expired();
    } else if (error === 'access_denied') {
      throw openCodeGoError(`[${PROVIDER_ID}] sign-in was denied`, { kind: 'device-token', code: 'access_denied' });
    } else if (!error && res.status >= 500 && ++failures <= MAX_TRANSIENT_FAILURES) {
      /* transient gateway failure: poll again */
    } else {
      const detail = error || scrubOAuthSecrets(text, [device.deviceCode]).slice(0, 300);
      throw openCodeGoError(`[${PROVIDER_ID}] device token ${res.status}: ${detail}`, {
        kind: 'device-token',
        status: res.status,
        ...(error ? { code: error } : {}),
      });
    }
    const left = deadline - now();
    if (left <= 0) break;
    await sleep(Math.min(intervalMs, left), signal);
  }
  throw expired();
}

/** The organization the login acts for: the grant's own, else the first by name (as opencode picks). */
export function pickOrganization(orgs, orgId = '') {
  const list = (Array.isArray(orgs) ? orgs : []).filter((org) => typeof org?.id === 'string' && org.id);
  if (orgId) {
    const match = list.find((org) => org.id === orgId);
    if (!match)
      throw openCodeGoError(`[${PROVIDER_ID}] OpenCode organization not found: ${orgId}`, { kind: 'validation' });
    return match;
  }
  return (
    [...list].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')) || a.id.localeCompare(b.id))[0] ||
    null
  );
}

/** Read the account and organization for a fresh grant and persist the credential. */
export async function completeLogin(granted, { fetchFn = fetch, signal } = {}) {
  const [user, orgs] = await Promise.all([
    consoleGetJson(USER_URL, granted, { fetchFn, signal }),
    consoleGetJson(ORGS_URL, granted, { fetchFn, signal }),
  ]);
  const org = pickOrganization(orgs, granted.org_id);
  if (!org) throw openCodeGoError(`[${PROVIDER_ID}] the OpenCode account has no organization`, { kind: 'validation' });
  return saveTokens({
    ...granted,
    account_id: typeof user?.id === 'string' ? user.id : '',
    email: typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '',
    org_id: org.id,
    org_name: typeof org.name === 'string' ? org.name : '',
  });
}

export async function beginOAuthLogin({ openBrowser = true, fetchFn = fetch, sleep, now } = {}) {
  const controller = new AbortController();
  const device = await requestDeviceCode({ fetchFn, signal: controller.signal });
  process.stderr.write(
    `\n[${PROVIDER_ID}] Enter code: ${device.userCode}\n[${PROVIDER_ID}] Open: ${device.verificationUrl}\n\n`
  );
  if (openBrowser) await openLoginUrl(PROVIDER_ID, device.verificationUrl);
  const waitForCallback = pollDeviceToken(device, { fetchFn, signal: controller.signal, sleep, now }).then((granted) =>
    completeLogin(granted, { fetchFn, signal: controller.signal })
  );
  // A cancelled flow rejects before some hosts attach a listener.
  waitForCallback.catch(() => {});
  return {
    provider: PROVIDER_ID,
    url: device.verificationUrl,
    manualUrl: null,
    userCode: device.userCode,
    waitForCallback,
    cancel: () => controller.abort(new Error('OpenCode Go login cancelled')),
  };
}

export async function loginOAuth() {
  const login = await beginOAuthLogin();
  return await login.waitForCallback;
}
