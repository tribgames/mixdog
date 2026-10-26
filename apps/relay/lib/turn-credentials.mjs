// Time-limited TURN credentials for the coturn instance that runs beside this
// relay (deploy/coturn). coturn runs with `use-auth-secret`, which accepts
//
//   username   = "<expiry unix seconds>:<user id>"
//   credential = base64(HMAC-SHA1(shared secret, username))
//
// (coturn's turnserver.conf "TURN REST API flag"; draft-uberti-behave-turn-rest-00
// §2.2 and §4.2). The secret exists only on the VPS: coturn reads it from its
// config, this relay from the environment. A credential cannot be forged
// without it, and coturn rejects it once the expiry has passed, so there is
// nothing to revoke and nothing to store.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** coturn's `listening-port` default (turnserver.conf): UDP and TCP. */
export const TURN_DEFAULT_PORT = 3478;
/** coturn's `tls-listening-port` default (turnserver.conf). */
export const TURN_DEFAULT_TLS_PORT = 5349;
/** draft-uberti-behave-turn-rest-00 §2.2: "A value of one day (86400 seconds)
 *  is recommended." The draft also notes expiry does not touch allocations that
 *  already exist, only new ones (an ICE restart), which is why a client that
 *  starts a session is given at least coturn's allocation lifetime (see the
 *  desktop's remote-ice-servers.ts) rather than a nearly expired credential. */
export const TURN_CREDENTIAL_TTL_SECONDS = 86_400;
/** RFC 2104 §3: keys shorter than the hash output length (20 bytes for SHA-1)
 *  are strongly discouraged. */
export const TURN_SECRET_MIN_BYTES = 20;

const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/u;

/** The TURN password for `username`: the value coturn recomputes. */
export function turnPassword(secret, username) {
  return createHmac('sha1', secret).update(username).digest('base64');
}

/** The user id part of a username: stable per device, so coturn's per-user
 *  quota and its log lines can tell devices apart, and opaque, so the device's
 *  routing id (which opens its phone route) never travels in a STUN message.
 *  The full HMAC-SHA-256 digest (64 hex characters): RFC 8489 §14.3 allows a
 *  USERNAME of fewer than 509 bytes, and "<10-digit expiry>:<digest>" is 75. */
export function turnUserId(secret, deviceId) {
  return createHmac('sha256', secret).update(`turn-user\0${deviceId}`).digest('hex');
}

/** A credential for `userId` that stops working `ttlSeconds` after `nowMs`.
 *  The expiry is a whole second, floor(now) + ttl, so the credential really
 *  lives `remainingMs` — up to 999 ms less than `ttlSeconds`; that is the figure
 *  a cache must count down from. */
export function issueTurnCredential({ secret, userId, nowMs, ttlSeconds = TURN_CREDENTIAL_TTL_SECONDS }) {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds;
  const username = `${expiresAt}:${userId}`;
  return {
    username,
    credential: turnPassword(secret, username),
    expiresAt,
    ttlSeconds,
    remainingMs: expiresAt * 1000 - nowMs,
  };
}

/** What coturn decides for a long-term credential under `use-auth-secret`:
 *  the expiry is still ahead, and the password is the HMAC of the username. */
export function verifyTurnCredential({ secret, username, credential, nowMs }) {
  if (typeof username !== 'string' || typeof credential !== 'string') return false;
  const match = /^(\d+):.+$/u.exec(username);
  if (!match || Number(match[1]) <= Math.floor(nowMs / 1000)) return false;
  const expected = Buffer.from(turnPassword(secret, username));
  const given = Buffer.from(credential);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function parsePort(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RangeError(`${name} must be a port number.`);
  return port;
}

/** TURN settings from the environment the deploy writes (/etc/mixdog-relay/turn.env):
 *    TURN_AUTH_SECRET  the shared secret (same value as coturn's static-auth-secret)
 *    TURN_HOST         the name clients dial (also the TLS certificate name)
 *    TURN_PORT         UDP/TCP port, default coturn's 3478
 *    TURN_TLS_PORT     TLS port; absent means no `turns:` URL is offered
 *    TURN_ISSUE_LIMIT  credential requests one device may make per credential
 *                      lifetime. A deploy-time decision with no default (see
 *                      deploy/README.md); issuance stays off without it.
 *  Returns null when neither secret nor host is set (TURN not provisioned) and
 *  throws when the settings are present but unusable. */
export function turnConfigFromEnv(env = {}) {
  const secret = env.TURN_AUTH_SECRET || '';
  const host = env.TURN_HOST || '';
  if (!secret && !host) return null;
  if (!secret || !host) throw new RangeError('TURN needs both TURN_AUTH_SECRET and TURN_HOST.');
  const issueLimit = Number(env.TURN_ISSUE_LIMIT);
  if (!/^[0-9]+$/u.test(env.TURN_ISSUE_LIMIT ?? '') || !Number.isSafeInteger(issueLimit) || issueLimit < 1) {
    throw new RangeError('TURN_ISSUE_LIMIT must be a positive whole number.');
  }
  if (Buffer.byteLength(secret) < TURN_SECRET_MIN_BYTES) {
    throw new RangeError(`TURN_AUTH_SECRET must be at least ${TURN_SECRET_MIN_BYTES} bytes.`);
  }
  if (!HOST.test(host)) throw new RangeError('TURN_HOST must be a host name or IPv4 address.');
  return Object.freeze({
    secret,
    host,
    port: parsePort(env.TURN_PORT, TURN_DEFAULT_PORT, 'TURN_PORT'),
    tlsPort: parsePort(env.TURN_TLS_PORT, 0, 'TURN_TLS_PORT'),
    ttlSeconds: TURN_CREDENTIAL_TTL_SECONDS,
    issueLimit,
  });
}

/** The unauthenticated STUN URL coturn answers on the same port as TURN. */
export function stunUrls(config) {
  return [`stun:${config.host}:${config.port}`];
}

/** `turn:` URLs for each transport the deploy provisioned (RFC 7064/7065). */
export function turnUrls(config) {
  const urls = [`turn:${config.host}:${config.port}?transport=udp`, `turn:${config.host}:${config.port}?transport=tcp`];
  if (config.tlsPort) urls.push(`turns:${config.host}:${config.tlsPort}?transport=tcp`);
  return urls;
}

/** The list a WebRTC peer connection takes as `iceServers`. */
export function iceServersFor(config, { username, credential }) {
  return [{ urls: stunUrls(config) }, { urls: turnUrls(config), username, credential }];
}
