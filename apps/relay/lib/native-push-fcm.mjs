// FCM (HTTP v1) delivery: owns the cached OAuth access token.
import { createSign } from 'node:crypto';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 10_000;
const NOTIFICATION_TTL_SECONDS = 3600;

const base64url = (value) => Buffer.from(value).toString('base64url');

/**
 * @param {object} options
 * @param {{ projectId: string, clientEmail: string, key: import('node:crypto').KeyObject, tokenUri: string }} options.config
 * @param {typeof fetch} options.fetchImpl
 * @param {() => number} options.now
 * @param {string} options.origin
 */
export function createFcmSender({ config, fetchImpl, now, origin }) {
  let fcmAccess = { token: '', expiresAt: 0 };
  async function fcmAccessToken() {
    if (fcmAccess.token && now() < fcmAccess.expiresAt - 60_000) return fcmAccess.token;
    const issued = Math.floor(now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64url(
      JSON.stringify({
        iss: config.clientEmail,
        scope: FCM_SCOPE,
        aud: config.tokenUri,
        iat: issued,
        exp: issued + 3600,
      })
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const assertion = `${header}.${claims}.${signer.sign(config.key).toString('base64url')}`;
    const response = await fetchImpl(config.tokenUri, {
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
    const response = await fetchImpl(`${origin}/v1/projects/${config.projectId}/messages:send`, {
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
    return {
      ok: false,
      status: response.status,
      invalid: unregistered,
      error: error?.status || `http ${response.status}`,
    };
  }

  return { send: sendFcm };
}
