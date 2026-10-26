// Desktop-leg side of ICE server issuance (credentials: lib/turn-credentials.mjs).
//
//   desktop -> relay: { type: 'ice-servers-request', requestId }
//   relay -> desktop: { type: 'ice-servers', requestId, ok: true,
//                       servers: [{ urls }, { urls, username, credential }],
//                       ttlSeconds, expiresAt, remainingMs }
//                  or { type: 'ice-servers', requestId, ok: false, error, stun,
//                       retryAfterMs? }
//                       error: 'not-paired' | 'rate-limited'; `stun` is the
//                       unauthenticated STUN URL list; `retryAfterMs` (rate
//                       limit only) is when the relay will answer again.
//   `remainingMs` is how long the credential really lives from the moment of
//   issue (its expiry is a whole second, so up to 999 ms under ttlSeconds); a
//   cache counts down from it on its own clock and never compares `expiresAt`.
//   A request whose id is not a routing id (lib/ids.mjs) gets no answer: the
//   desktop mints them with randomUUID(), and an id too long to be one is not
//   echoed back, truncated or otherwise.
//
// The desktop leg is the only way to ask. It authenticated with its device
// secret, and the phone's side of the connection travels end-to-end encrypted
// through that desktop, so a phone receives the list from its own PC and never
// asks this relay directly. A device that has paired no phone is refused: a
// TURN relay moves traffic at this host's expense, and a registered-but-unpaired
// device has no connection to relay.
import { isRoutingId } from './ids.mjs';
import { RateLimiter } from './rate-limit.mjs';
import { issueTurnCredential, iceServersFor, stunUrls, turnUserId } from './turn-credentials.mjs';

/** The relay's issuer for one TURN configuration, or null without one. A device
 *  may ask `config.issueLimit` times per credential lifetime: a desktop asks
 *  once per lifetime (it caches until shortly before expiry) plus once per
 *  process start, so the figure is the number of starts a deployment expects
 *  a device to make in that time. */
export function createIceService(config, { now = Date.now, log = console.log } = {}) {
  if (!config) return null;
  return {
    stunUrls: stunUrls(config),
    limiter: new RateLimiter(config.issueLimit, config.ttlSeconds * 1000),
    log,
    issue(deviceId) {
      const issued = issueTurnCredential({
        secret: config.secret,
        userId: turnUserId(config.secret, deviceId),
        nowMs: now(),
        ttlSeconds: config.ttlSeconds,
      });
      return {
        servers: iceServersFor(config, issued),
        ttlSeconds: issued.ttlSeconds,
        expiresAt: issued.expiresAt,
        remainingMs: issued.remainingMs,
      };
    },
  };
}

export function requestIceServers(leg, message) {
  const { ice, store, deviceId, socket, sendJson } = leg;
  if (!ice) return;
  const { requestId } = message;
  if (typeof requestId !== 'string' || !isRoutingId(requestId)) return;
  const device = String(deviceId).slice(0, 8);
  const refuse = (error, extra = {}) => {
    ice.log(`[relay] ice-servers refused cause=${error} device=${device}`);
    sendJson(socket, { type: 'ice-servers', requestId, ok: false, error, stun: ice.stunUrls, ...extra });
  };
  if (store.listClients(deviceId).length === 0) {
    refuse('not-paired');
    return;
  }
  if (!ice.limiter.allow(deviceId)) {
    refuse('rate-limited', { retryAfterMs: ice.limiter.retryAfterMs(deviceId) });
    return;
  }
  ice.log(`[relay] ice-servers issued device=${device}`);
  sendJson(socket, { type: 'ice-servers', requestId, ok: true, ...ice.issue(deviceId) });
}
