// Desktop-leg side of relay-owned Web Push (lib/web-push.mjs).
//
//   relay -> desktop: { type: 'webpush-subscriptions', subscriptions: [{ endpoint, clientId, sealed }] }
//                     the full set THIS PC may deliver to; sent when the leg
//                     opens and again whenever it changes.
//   desktop -> relay: { type: 'webpush-send', endpoint, clientId, payload, ttl?, urgency?, topic? }
//                     `payload` is the RFC 8291 aes128gcm body, base64url.
//   relay -> desktop: { type: 'webpush-result', endpoint, clientId, ok, status?, expired?, error? }
//
// A desktop sends only through an association it holds for a client the
// device store still knows: an unpaired or revoked client, or another PC's
// association, is refused.
import { webPushBody, webPushOptions } from './web-push.mjs';

/** The set one PC may deliver to, minus clients the store no longer knows. */
export function webPushSubscriptionsFrame(webPush, store, deviceId) {
  return {
    type: 'webpush-subscriptions',
    subscriptions: webPush.registry
      .listFor(deviceId)
      .filter((row) => store.hasClient?.(deviceId, row.clientId) === true),
  };
}

/** `{ type: 'webpush-ready' }`: this PC delivers through the relay. Browsers
 *  register their subscription only with PCs that said so; an older PC keeps
 *  its own legacy registration. */
export function markWebPushReady({ webPush, deviceId }) {
  webPush?.registry.markCapable(deviceId);
}

export function sendWebPushFromDesktop(leg, message) {
  const { webPush, store, deviceId, socket, sendJson } = leg;
  if (!webPush) return;
  const endpoint = typeof message.endpoint === 'string' ? message.endpoint : '';
  const clientId = typeof message.clientId === 'string' ? message.clientId : '';
  const reply = (fields) =>
    sendJson(socket, { type: 'webpush-result', endpoint: endpoint.slice(0, 2048), clientId: clientId.slice(0, 128), ...fields });
  const body = webPushBody(message.payload);
  if (!endpoint || !clientId || !body) {
    reply({ ok: false, error: 'invalid-message' });
    return;
  }
  if (!webPush.registry.has(deviceId, clientId, endpoint) || store.hasClient?.(deviceId, clientId) !== true) {
    reply({ ok: false, error: 'unbound-subscription' });
    return;
  }
  if (webPush.limiter && !webPush.limiter.allow(deviceId)) {
    reply({ ok: false, error: 'rate-limited' });
    return;
  }
  void webPush.sender.send({ endpoint, body, ...webPushOptions(message) }).then((result) => {
    if (result.expired) {
      // The browser retired this subscription for every PC; each PC that held
      // it gets its new set.
      for (const holder of webPush.registry.dropEndpoint(endpoint)) webPush.publish(holder);
    }
    reply({
      ok: result.ok,
      ...(result.status ? { status: result.status } : {}),
      ...(result.expired ? { expired: true } : {}),
      ...(result.error ? { error: String(result.error).slice(0, 80) } : {}),
    });
  });
}
