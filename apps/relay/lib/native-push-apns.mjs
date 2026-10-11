// APNs (HTTP/2, token auth) delivery: owns the per-origin HTTP/2 sessions and
// the cached provider JWT.
import { sign as signBytes } from 'node:crypto';
import http2 from 'node:http2';

const REQUEST_TIMEOUT_MS = 10_000;
const APNS_JWT_TTL_MS = 40 * 60_000;
const NOTIFICATION_TTL_SECONDS = 3600;

const base64url = (value) => Buffer.from(value).toString('base64url');

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
 * @param {{ keyId: string, teamId: string, key: import('node:crypto').KeyObject, topic: string, sandboxDefault: boolean }} options.config
 * @param {() => number} options.now
 * @param {{ production: string, sandbox: string }} options.origins
 */
export function createApnsSender({ config, now, origins }) {
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
      const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
      const claims = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now() / 1000) }));
      const signature = signBytes('sha256', Buffer.from(`${header}.${claims}`), {
        key: config.key,
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
    const useSandbox = typeof sandbox === 'boolean' ? sandbox : config.sandboxDefault;
    const origin = useSandbox ? origins.sandbox : origins.production;
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
        'apns-topic': config.topic,
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

  function close() {
    for (const session of sessions.values()) session.close();
    sessions.clear();
  }

  return { send: sendApns, close };
}
