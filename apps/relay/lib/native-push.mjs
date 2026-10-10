// Native app push delivery: APNs (HTTP/2, token auth) and FCM (HTTP v1). The
// relay holds the credentials and carries the opaque `mx` string the desktop
// encrypted for the phone; it never sees notification content.
import { createPrivateKey, createSign, sign as signBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http2 from 'node:http2';

const APNS_PRODUCTION = 'https://api.push.apple.com';
const APNS_SANDBOX = 'https://api.sandbox.push.apple.com';
const FCM_ORIGIN = 'https://fcm.googleapis.com';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOPIC = 'io.mixdog.app';
// Identifiers, not secrets: the .p8 (APNS_KEY_P8) and the FCM service account
// JSON (FCM_SERVICE_ACCOUNT_JSON; project `mixdog-app`, sender
// mixdog-relay-fcm@mixdog-app.iam.gserviceaccount.com) are provided at deploy
// time as inline content or as a file path, and never live in the repo.
const DEFAULT_APNS_KEY_ID = '6S9P5W53QC';
const DEFAULT_APNS_TEAM_ID = 'Q6C35DQU78';
const REQUEST_TIMEOUT_MS = 10_000;
const APNS_JWT_TTL_MS = 40 * 60_000;
const NOTIFICATION_TTL_SECONDS = 3600;

export const NATIVE_PUSH_REASONS = new Set(['turn-finished', 'approval-pending', 'input-needed']);
export const MAX_MX_CHARS = 3500;
const TOKEN_PATTERNS = {
  apns: /^[0-9a-fA-F]{32,400}$/u,
  fcm: /^[A-Za-z0-9_:.-]{32,4096}$/u,
};

export function validNativeToken(platform, token) {
  return typeof token === 'string' && TOKEN_PATTERNS[platform]?.test(token) === true;
}

const base64url = (value) => Buffer.from(value).toString('base64url');

/** A secret that may be given inline or as a path to a file. */
function readInlineOrFile(value, inlinePrefix) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.startsWith(inlinePrefix) ? text : readFileSync(text, 'utf8');
}

function readApnsConfig(env) {
  const keyId = String(env.APNS_KEY_ID || '').trim() || DEFAULT_APNS_KEY_ID;
  const teamId = String(env.APNS_TEAM_ID || '').trim() || DEFAULT_APNS_TEAM_ID;
  const p8 = readInlineOrFile(env.APNS_KEY_P8, '-----BEGIN');
  if (!keyId || !teamId || !p8) return null;
  return {
    keyId,
    teamId,
    key: createPrivateKey(p8),
    topic: String(env.APNS_TOPIC || '').trim() || DEFAULT_TOPIC,
    sandboxDefault: String(env.APNS_ENVIRONMENT || '').trim().toLowerCase() === 'sandbox',
  };
}

function readFcmConfig(env) {
  const json = readInlineOrFile(env.FCM_SERVICE_ACCOUNT_JSON, '{');
  if (!json) return null;
  const account = JSON.parse(json);
  if (!account.project_id || !account.client_email || !account.private_key) return null;
  return {
    projectId: String(account.project_id),
    clientEmail: String(account.client_email),
    key: createPrivateKey(account.private_key),
    tokenUri: String(account.token_uri || 'https://oauth2.googleapis.com/token'),
  };
}

/** Credentials that do not parse disable that platform instead of crashing the
 *  relay: a push misconfiguration must never take pairing down with it. */
function tryRead(read, env, label, log) {
  try {
    return read(env);
  } catch (error) {
    log(`[relay] ${label} credentials unusable: ${error?.message || error}`);
    return null;
  }
}

function http2Request(session, headers, body) {
  return new Promise((resolve, reject) => {
    const request = session.request(headers);
    const chunks = [];
    let status = 0;
    request.setTimeout?.(REQUEST_TIMEOUT_MS, () => {
      request.close?.(http2.constants.NGHTTP2_CANCEL);
      reject(new Error('APNs request timed out'));
    });
    request.on('response', (responseHeaders) => {
      status = Number(responseHeaders[':status']) || 0;
    });
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }));
    request.on('error', reject);
    request.end(body);
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {Record<string, string | undefined>} [options.env]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {{ apnsProduction?: string, apnsSandbox?: string, fcm?: string }} [options.origins] test overrides
 * @param {(message: string) => void} [options.log]
 */
export function createNativePush({
  env = {},
  fetchImpl = globalThis.fetch,
  now = Date.now,
  origins = {},
  log = console.warn,
} = {}) {
  const apns = tryRead(readApnsConfig, env, 'APNs', log);
  const fcm = tryRead(readFcmConfig, env, 'FCM', log);
  const platforms = [...(apns ? ['apns'] : []), ...(fcm ? ['fcm'] : [])];

  // ---- APNs ---------------------------------------------------------------
  const sessions = new Map();
  const sessionFor = (origin) => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = http2.connect(origin);
    const drop = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    session.on('error', drop);
    session.on('close', drop);
    session.on('goaway', drop);
    session.unref?.();
    sessions.set(origin, session);
    return session;
  };
  let apnsJwt = { value: '', at: 0 };
  const apnsAuthorization = () => {
    if (!apnsJwt.value || now() - apnsJwt.at > APNS_JWT_TTL_MS) {
      const header = base64url(JSON.stringify({ alg: 'ES256', kid: apns.keyId }));
      const claims = base64url(JSON.stringify({ iss: apns.teamId, iat: Math.floor(now() / 1000) }));
      const signature = signBytes('sha256', Buffer.from(`${header}.${claims}`), {
        key: apns.key,
        dsaEncoding: 'ieee-p1363',
      });
      apnsJwt = { value: `${header}.${claims}.${base64url(signature)}`, at: now() };
    }
    return `bearer ${apnsJwt.value}`;
  };

  async function sendApns({ token, mx, reason, collapseKey, sandbox }) {
    // The app reports its environment at registration (development builds are
    // sandbox, TestFlight/App Store are production); APNS_ENVIRONMENT only
    // decides for a subscription that did not say.
    const useSandbox = typeof sandbox === 'boolean' ? sandbox : apns.sandboxDefault;
    const origin = useSandbox ? origins.apnsSandbox || APNS_SANDBOX : origins.apnsProduction || APNS_PRODUCTION;
    const payload = {
      aps: {
        // Shown only if the notification service extension cannot decrypt
        // `mx`; deliberately free of any session content or language.
        alert: { title: 'Mixdog', body: '\u{1F514}' },
        'mutable-content': 1,
        sound: 'default',
        ...(reason === 'approval-pending' ? { category: 'MIXDOG_APPROVAL' } : {}),
      },
      mx,
    };
    const response = await http2Request(
      sessionFor(origin),
      {
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: apnsAuthorization(),
        'apns-topic': apns.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(now() / 1000) + NOTIFICATION_TTL_SECONDS),
        'apns-collapse-id': collapseKey,
        'content-type': 'application/json',
      },
      JSON.stringify(payload)
    );
    if (response.status === 200) return { ok: true, status: 200 };
    const failure = parseJson(response.body)?.reason;
    // 403 means the cached provider token was refused: mint a fresh one next time.
    if (response.status === 403) apnsJwt = { value: '', at: 0 };
    return {
      ok: false,
      status: response.status,
      invalid: response.status === 410 || failure === 'Unregistered',
      error: failure || `http ${response.status}`,
    };
  }

  // ---- FCM ----------------------------------------------------------------
  let fcmAccess = { token: '', expiresAt: 0 };
  async function fcmAccessToken() {
    if (fcmAccess.token && now() < fcmAccess.expiresAt - 60_000) return fcmAccess.token;
    const issued = Math.floor(now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({ iss: fcm.clientEmail, scope: FCM_SCOPE, aud: fcm.tokenUri, iat: issued, exp: issued + 3600 })
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${signer.sign(fcm.key).toString('base64url')}`;
    const response = await fetchImpl(fcm.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.access_token) throw new Error(`FCM token exchange failed (${response.status})`);
    fcmAccess = { token: body.access_token, expiresAt: now() + (Number(body.expires_in) || 3600) * 1000 };
    return fcmAccess.token;
  }

  async function sendFcm({ token, mx, reason, collapseKey }) {
    const accessToken = await fcmAccessToken();
    const response = await fetchImpl(`${origins.fcm || FCM_ORIGIN}/v1/projects/${fcm.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          // Data-only: the app builds the visible notification after decrypting.
          data: { mx, reason },
          android: { priority: 'HIGH', collapse_key: collapseKey, ttl: `${NOTIFICATION_TTL_SECONDS}s` },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.ok) return { ok: true, status: response.status };
    if (response.status === 401) fcmAccess = { token: '', expiresAt: 0 };
    const error = (await response.json().catch(() => null))?.error;
    const unregistered =
      response.status === 404 &&
      (error?.status === 'NOT_FOUND' || (error?.details || []).some((detail) => detail?.errorCode === 'UNREGISTERED'));
    return { ok: false, status: response.status, invalid: unregistered, error: error?.status || `http ${response.status}` };
  }

  return {
    platforms,
    /** Resolves to `{ ok, status, invalid?, error? }`; never rejects. */
    async send(message) {
      try {
        if (message.platform === 'apns' && apns) return await sendApns(message);
        if (message.platform === 'fcm' && fcm) return await sendFcm(message);
        return { ok: false, status: 0, error: 'platform-unavailable' };
      } catch (error) {
        return { ok: false, status: 0, error: error?.message || 'send failed' };
      }
    },
    close() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  };
}
