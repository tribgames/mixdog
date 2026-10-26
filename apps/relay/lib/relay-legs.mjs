// Desktop and phone WebSocket legs: envelope routing, claim/revoke control
// frames, media-proxy frames, and per-leg oversize/ingress policy.
import { randomUUID } from 'node:crypto';

import { decodeRelayBinaryFrame, encodeRelayBinaryFrame } from './relay-binary-frame.mjs';
import { DESKTOP_HANDSHAKE_STALLED_CLOSE, DESKTOP_OFFLINE_CLOSE } from './relay-close-codes.mjs';
import { failMediaPending, forwardMediaFrame } from './relay-media-proxy.mjs';
import { cleanName } from './pair-codes.mjs';
import { APPROVED_CLAIM_RETAIN_MS, EXPIRED_CLAIM_RETAIN_MS } from './relay-pairing.mjs';
import {
  bindNativeToken,
  dropNativeBindings,
  nativePushPlatforms,
  sendNativePush,
  unbindNativeToken,
} from './native-push-legs.mjs';
import { requestIceServers } from './ice-legs.mjs';
import { markWebPushReady, sendWebPushFromDesktop, webPushSubscriptionsFrame } from './web-push-legs.mjs';
import {
  MAX_FRAME_BYTES,
  MAX_INFLIGHT_BYTES,
  UNDECLARED_CAPACITY_BYTES,
  declareUplinkLeg,
  guarded,
  noteIngressDelivery,
  rejectOversizeFrame,
  relayCapabilities,
  releaseIngressLeg,
  releaseLeg,
  sendToPhone,
  sendUplink,
  signalDesktopOversize,
  signalPhoneDesktopGone,
  signalPhoneOversize,
  trackLegIngress,
  uplinkCeilings,
} from './relay-transport.mjs';

function closeQuietly(socket, code, reason) {
  try {
    socket.close(code, reason);
  } catch {
    /* already gone */
  }
}

export { DESKTOP_HANDSHAKE_STALLED_CLOSE, DESKTOP_OFFLINE_CLOSE };

/** A desktop leg can look open here while it no longer reads (a half-dead
 *  path, a wedged process), and a phone joining is when that shows. Both ends
 *  give the encrypted handshake 10s (the phone's encryption timer and the
 *  desktop's E2EE_HANDSHAKE_TIMEOUT_MS). A missed turn — the challenge after
 *  client-open, the ready after the hello — costs the desktop at most
 *  DESKTOP_HANDSHAKE_STALL_MS + DESKTOP_LIVENESS_PROBE_MS = 6s of that budget
 *  before its leg is closed. The remaining 4s are the redial: a new leg
 *  replays client-open, and the fresh challenge re-arms the phone's timer on
 *  the socket it already has, so the phone never sees the outage. */
export const DESKTOP_HANDSHAKE_STALL_MS = 4_000;
/** How long a desktop leg that went silent during a missed turn gets to answer
 *  a ping before it is judged dead. */
export const DESKTOP_LIVENESS_PROBE_MS = 2_000;
/** The handshake timing of a desktop entry no desktop leg configured. */
const DEFAULT_HANDSHAKE_TIMING = Object.freeze({
  stallMs: DESKTOP_HANDSHAKE_STALL_MS,
  probeMs: DESKTOP_LIVENESS_PROBE_MS,
});

/** A phone the relay still routes a handshake for: open, attached, and not
 *  being rejected or closed. */
function phoneLive(phone) {
  return phone.attached !== false && !phone.closing && phone.readyState === phone.OPEN;
}

/** Anything the desktop leg says — a frame for any phone, a control frame or
 *  a pong — proves the shared leg is read and answered. */
function markDesktopHeard(socket) {
  socket.heardAt = performance.now();
}

// Handshake turns, tracked per phone leg on the frames this relay routes (it
// never reads them): 'challenge' and 'ready' are owed by the desktop, 'hello'
// by the phone. Only a turn the DESKTOP owes runs the clock, so a slow phone
// is never blamed on its PC — and a missed turn alone never closes the shared
// leg: one phone's handshake can be slow on a PC that is serving everyone
// else. Only a leg that also stayed silent through the turn AND a ping is
// closed; the phone's own handshake timer handles a slow-but-live PC. The
// timing is the desktop leg's (runDesktopLeg sets `entry.handshake`).
function awaitDesktopTurn(entry, phone, turn) {
  clearTimeout(phone.handshakeTimer);
  phone.handshakeTimer = null;
  if (!phoneLive(phone)) {
    phone.handshakeTurn = null;
    return;
  }
  phone.handshakeTurn = turn;
  const { stallMs, probeMs } = entry.handshake ?? DEFAULT_HANDSHAKE_TIMING;
  const desktop = entry.socket;
  const stillOwed = () => phone.handshakeTurn === turn && entry.socket === desktop && phoneLive(phone);
  // After `ms`, a turn still owed is let go when the leg spoke since `since`;
  // otherwise `silent` runs.
  const check = (ms, since, heard, silent) => {
    phone.handshakeTimer = setTimeout(() => {
      phone.handshakeTimer = null;
      if (!stillOwed()) return;
      if ((desktop.heardAt ?? 0) > since) {
        console.log(`[relay] slow phone handshake turn=${turn}; ${heard}, leaving the leg up`);
        endHandshakeWatch(phone);
        return;
      }
      silent();
    }, ms);
    phone.handshakeTimer.unref?.();
  };
  check(stallMs, performance.now(), 'desktop leg is live', () => {
    const probedAt = performance.now();
    try {
      desktop.ping();
    } catch {
      /* surfaced as close */
    }
    check(probeMs, probedAt, 'desktop leg answered its probe', () => {
      console.log(`[relay] desktop leg missed a phone handshake turn=${turn} and its probe; closing it`);
      closeQuietly(desktop, DESKTOP_HANDSHAKE_STALLED_CLOSE, 'desktop leg unresponsive');
    });
  });
}

function endHandshakeWatch(phone) {
  clearTimeout(phone.handshakeTimer);
  phone.handshakeTimer = null;
  phone.handshakeTurn = null;
}

/** The desktop routed a frame to this phone: its turn is taken. */
function noteDesktopTurn(phone) {
  if (phone.handshakeTurn === 'challenge') {
    clearTimeout(phone.handshakeTimer);
    phone.handshakeTimer = null;
    phone.handshakeTurn = 'hello';
  } else if (phone.handshakeTurn === 'ready') {
    endHandshakeWatch(phone);
  }
}

/** Announce a phone to the current desktop leg and start owing it a challenge.
 *  A phone being rejected or closed is never announced again. */
function announcePhone(entry, sendJson, clientId, phone) {
  if (!phoneLive(phone)) return;
  sendJson(entry.socket, clientOpenEnvelope(clientId, phone.browserClientId));
  awaitDesktopTurn(entry, phone, 'challenge');
}

function revokeDevice(leg) {
  const { store, deviceId, socket, entry, sendJson } = leg;
  const removed = store.revoke(deviceId);
  if (!removed) {
    // Unknown device, or the removal could not be persisted. Report the
    // failure and keep the leg: closing it as revoked would tell the user
    // the credential is gone while it still authenticates after a restart.
    sendJson(socket, { type: 'device-revoked', ok: false });
    return;
  }
  dropNativeBindings(leg.nativeBindings, deviceId);
  leg.webPush?.registry.dropClient(deviceId);
  leg.revoked = true;
  for (const phone of entry.clients.values()) closeQuietly(phone, 4003, 'pairing revoked');
  const finish = () => closeQuietly(socket, 4003, 'device revoked');
  try {
    socket.send(JSON.stringify({ type: 'device-revoked', ok: true }), finish);
  } catch {
    finish();
  }
}

function setClientToken({ store, deviceId }, message) {
  if (typeof message.token === 'string' && message.token.length >= 16) store.setClientToken(deviceId, message.token);
}

// The approval itself. Only the desktop the claim named may answer it, and
// only then does a credential exist for that container.
function approveClaim({ store, deviceId, claims }, message) {
  if (typeof message.claimId !== 'string') return;
  const claim = claims?.get(message.claimId);
  if (!claim || claim.deviceId !== deviceId || claim.status !== 'pending') return;
  if (claim.expiresAt <= Date.now()) {
    // Not deleted: a poll must still read `expired`, which only `unknown` differs from.
    claim.status = 'expired';
    claim.expiresAt = Date.now() + EXPIRED_CLAIM_RETAIN_MS;
    return;
  }
  const registered = store.registerClient(deviceId, claim.clientId, claim.profile);
  if (!registered) {
    claim.status = 'denied';
    return;
  }
  claim.token = registered.token;
  claim.sealed = message.sealed ?? null;
  claim.status = 'approved';
  // From here the claim only lives to be re-read by a poller whose answer was lost.
  claim.expiresAt = Date.now() + APPROVED_CLAIM_RETAIN_MS;
}

function denyClaim({ deviceId, claims }, message) {
  if (typeof message.claimId !== 'string') return;
  const claim = claims?.get(message.claimId);
  if (claim && claim.deviceId === deviceId) claim.status = 'denied';
}

function listClients({ store, deviceId, socket, entry, sendJson }, message) {
  if (typeof message.requestId !== 'string') return;
  const online = new Set([...entry.clients.values()].map((phone) => phone.browserClientId).filter(Boolean));
  sendJson(socket, {
    type: 'clients-list',
    requestId: message.requestId,
    clients: store.listClients(deviceId, online),
  });
}

function revokeClient({ store, deviceId, socket, entry, sendJson, nativeBindings, webPush }, message) {
  if (typeof message.requestId !== 'string' || typeof message.clientId !== 'string') return;
  const removed = store.revokeClient(deviceId, message.clientId);
  // Only a credential that is actually gone closes its browser: a failed
  // persist leaves the pairing valid, and closing it as revoked would tell
  // the user something the store did not do.
  if (removed) {
    dropNativeBindings(nativeBindings, deviceId, message.clientId);
    // Only THIS PC's association with that browser goes; its other PCs keep
    // delivering to the same subscription.
    if (webPush?.registry.dropClient(deviceId, message.clientId)) webPush.publish(deviceId);
    for (const phone of entry.clients.values()) {
      if (phone.browserClientId === message.clientId) closeQuietly(phone, 4003, 'pairing revoked');
    }
  }
  sendJson(socket, {
    type: 'client-revoked',
    requestId: message.requestId,
    ok: removed,
  });
}

// Capability announcement, sent before the leg does anything else. It is
// ONE bit per lane, not a version number: the relay never branches on a
// desktop version, it only answers "this host serves media" or not.
function declareLanes({ socket, entry, publishCapabilities }, message) {
  entry.mediaLane = message.media === true;
  // Pairing v2 (6-digit codes, direct browser connect). Declared per leg like
  // every other lane: an older desktop never says it, so it stays false.
  entry.pairV2 = message.pairV2 === 1;
  // What THIS leg's receiver accepts, and whether it can take a text
  // payload inside the binary envelope. Both are per connection and both
  // are written to the state of the socket that said them: one relay-wide
  // constant is version skew waiting to disconnect somebody, and one
  // per-device value is the previous connection speaking for this one.
  declareUplinkLeg(socket.uplinkLeg, message.maxPayloadBytes, message.textFrames === 1);
  // Answer the declaration on the connection it was made on: the leg now
  // knows which envelope its text will actually travel in, and the ceilings
  // that go with it.
  publishCapabilities();
}

// The desktop's build, reported once per leg. It only selects which renderer
// release the relay serves this device's phones; an old desktop never sends it.
function reportVersion({ store, deviceId }, message) {
  store.recordDesktopVersion(deviceId, message);
}

// The main PC publishes its current 6-digit code (only while Settings →
// Connection is open) and withdraws it when that screen closes. The code is
// never logged; the answer says only whether the relay accepted it.
function requestPairCode({ pairCodes, deviceId, socket, sendJson }, message) {
  if (!pairCodes) return;
  const result = pairCodes.issue(deviceId, message.lease, message.name);
  const lease = typeof message.lease === 'string' ? message.lease.slice(0, 64) : '';
  sendJson(
    socket,
    result.status === 'ok'
      ? { type: 'pair-code-issued', lease, ok: true, code: result.code, expiresInMs: result.ttlMs }
      : { type: 'pair-code-issued', lease, ok: false }
  );
}

// The desktop's own name for itself, shown in the PC switcher of the remote
// UI. A label only; it is never an identifier.
function reportName({ entry }, message) {
  entry.hostName = cleanName(message.name);
}

function clearPairCode({ pairCodes, deviceId }) {
  pairCodes?.clear(deviceId);
}

function forwardFrame({ entry }, message) {
  if (typeof message.data !== 'string') return;
  const phone = entry.clients.get(String(message.clientId || ''));
  if (!phone) return;
  noteDesktopTurn(phone);
  sendToPhone(phone, message.data, message.droppable === true);
}

function closeClient({ entry }, message) {
  const phone = entry.clients.get(String(message.clientId || ''));
  if (!phone) return;
  // The PC answered this phone — with a rejection. Its handshake is over the
  // moment the rejection starts, whether or not the phone ever acknowledges
  // the close: nothing here may hold the PC to a turn for it.
  phone.closing = true;
  endHandshakeWatch(phone);
  closeQuietly(phone, 4004, String(message.reason || 'desktop rejected client').slice(0, 120));
}

function broadcastFrame({ entry }, message) {
  if (typeof message.data !== 'string') return;
  // A full snapshot (phone join, resync answer) IS the recovery frame:
  // dropping it for a busy leg would leave nothing to recover with.
  const droppable = message.critical !== true;
  // Fan-out is parallel and non-blocking: each leg answers for its own
  // queue (drop, or cut when it stopped draining), and the box-level
  // ceiling is what stops a fan-out from adding up to the heap. That
  // ceiling is filled by this loop itself — no flush callback can run
  // before it ends — so a leg the box cannot carry right now is deferred
  // with a resync hint, never closed: it is healthy, it just arrived late
  // in the iteration order.
  for (const phone of entry.clients.values()) {
    sendToPhone(phone, message.data, droppable, 'defer');
  }
}

// Desktop-leg control frames by message.type. Each handler validates its own
// shape; a malformed frame of a known type is ignored like an unknown one.
const DESKTOP_FRAME_HANDLERS = new Map([
  ['revoke-device', revokeDevice],
  ['set-client-token', setClientToken],
  ['claim-approve', approveClaim],
  ['claim-deny', denyClaim],
  ['list-clients', listClients],
  ['revoke-client', revokeClient],
  ['desktop-lanes', declareLanes],
  ['desktop-version', reportVersion],
  ['pair-code-request', requestPairCode],
  ['pair-code-clear', clearPairCode],
  ['desktop-name', reportName],
  ['native-push-bind', bindNativeToken],
  ['native-push-unbind', unbindNativeToken],
  ['native-push', sendNativePush],
  ['webpush-send', sendWebPushFromDesktop],
  ['webpush-ready', markWebPushReady],
  ['ice-servers-request', requestIceServers],
  ['frame', forwardFrame],
  ['close-client', closeClient],
  ['broadcast', broadcastFrame],
]);

function releaseDesktopLeg(liveDesktops, deviceId, entry, socket) {
  releaseLeg(socket);
  releaseIngressLeg(socket);
  // The close code is deliberately not read. Whatever this receiver did with
  // whatever frame, it says nothing this relay can attribute — and the leg
  // state that could have carried a verdict forward goes away with the
  // socket, so the next connection starts from its own declaration.
  if (liveDesktops.get(deviceId)?.socket !== socket) return;
  failMediaPending(entry);
  // Parked phones keep answering their own pings, so without a word from here
  // they look connected while every call goes nowhere.
  for (const phone of entry.clients.values()) signalPhoneDesktopGone(phone);
  // Keep browser legs parked at the relay during transient desktop/VPS
  // outages. New RPCs cannot reach a closed desktop socket, but the next
  // desktop leg rekeys and resumes all existing clients in place.
  if (entry.offlineTimer) clearTimeout(entry.offlineTimer);
  entry.offlineTimer = setTimeout(() => {
    entry.offlineTimer = null;
    if (liveDesktops.get(deviceId)?.socket !== socket) return;
    for (const phone of entry.clients.values()) closeQuietly(phone, DESKTOP_OFFLINE_CLOSE, 'desktop offline');
    liveDesktops.delete(deviceId);
  }, 45_000);
  entry.offlineTimer.unref?.();
}

export function runDesktopLeg(context, deviceId, socket) {
  const {
    store,
    sendJson,
    attachDesktop,
    liveDesktops,
    claims,
    pairCodes = null,
    maxFrameBytes = MAX_FRAME_BYTES,
    ingress,
    rawSocket = null,
    nativePush = null,
    nativeBindings = null,
    nativeLimiter = null,
    webPush = null,
    ice = null,
    handshakeStallMs = DESKTOP_HANDSHAKE_STALL_MS,
    livenessProbeMs = DESKTOP_LIVENESS_PROBE_MS,
  } = context;
  const entry = attachDesktop(deviceId, socket);
  entry.handshake = { stallMs: handshakeStallMs, probeMs: livenessProbeMs };
  socket.isAlive = true;
  socket.heardAt = 0;
  socket.on('pong', () => {
    socket.isAlive = true;
    markDesktopHeard(socket);
  });
  socket.on('error', () => {
    /* surfaced as close */
  });
  // The wire form has to travel with the refusal: a binary frame is read by the
  // binary decoder that routes it, a text frame by JSON.parse. Dropping it here
  // sent binary bytes through the JSON reader, which fails and names nobody.
  socket.oversizeSignal = (bytes, limit, raw, binary) => signalDesktopOversize(socket, bytes, limit, raw, binary);
  trackLegIngress(socket, rawSocket, { ...ingress, limit: maxFrameBytes });
  // Publish what THIS connection enforces, and re-publish whenever a
  // declaration moves it. Both come from this socket's own leg state, so the
  // numbers the desktop reads are the numbers its phones are held to — and a
  // leg that changes nothing is answered with nothing, exactly as before.
  const publishCapabilities = () => {
    const leg = socket.uplinkLeg;
    const frame = relayCapabilities(
      leg,
      maxFrameBytes,
      nativePushPlatforms({ nativePush }),
      Boolean(webPush),
      Boolean(ice)
    );
    const encoded = JSON.stringify(frame);
    if (encoded === leg.published) return;
    leg.published = encoded;
    sendJson(socket, frame);
  };
  publishCapabilities();
  // The browser subscriptions this PC may deliver to, after the capabilities
  // that say how. An older desktop ignores the frame.
  if (webPush) sendJson(socket, webPushSubscriptionsFrame(webPush, store, deviceId));
  const leg = {
    socket,
    entry,
    deviceId,
    store,
    sendJson,
    claims,
    pairCodes,
    publishCapabilities,
    nativePush,
    nativeBindings,
    nativeLimiter,
    webPush,
    ice,
    revoked: false,
  };
  // Existing browser legs survive a transient desktop redial. Replaying
  // client-open makes the replacement desktop build fresh E2EE channels for
  // those same sockets without waiting for backgrounded tabs to reconnect.
  for (const [clientId, phone] of entry.clients) {
    announcePhone(entry, sendJson, clientId, phone);
  }
  socket.on(
    'message',
    guarded('desktop frame', (raw, isBinary) => handleDesktopFrame(leg, liveDesktops, maxFrameBytes, raw, isBinary))
  );
  socket.on('close', () => {
    // A closed live leg's code dies with it; a superseded leg must not clear
    // the code its replacement just requested.
    if (liveDesktops.get(deviceId)?.socket === socket) pairCodes?.clear(deviceId);
    releaseDesktopLeg(liveDesktops, deviceId, entry, socket);
  });
}

// One frame from the desktop. Bookkeeping first: a message that is not acted
// on still has to give its ingress reservation back.
function handleDesktopFrame(leg, liveDesktops, maxFrameBytes, raw, isBinary) {
  const { socket, entry, deviceId } = leg;
  const announced = noteIngressDelivery(socket);
  markDesktopHeard(socket);
  if (leg.revoked) return;
  // A superseded leg goes on draining whatever was already on the wire. It
  // may answer for itself, but nothing it says belongs to the connection that
  // replaced it: this device's routing, and its declaration, are the live
  // socket's alone.
  if (liveDesktops.get(deviceId)?.socket !== socket) return;
  socket.isAlive = true;
  // Oversize is answered ON this leg and the leg stays open: cutting it here
  // reaches every attached phone as a relay outage over one bad frame.
  if (rejectOversizeFrame(socket, raw, maxFrameBytes, announced, isBinary)) return;
  if (isBinary) {
    const frame = decodeRelayBinaryFrame(raw);
    if (!frame) return;
    const phone = entry.clients.get(frame.clientId);
    // Admission is per phone leg, so a congested phone slows nothing but
    // itself — this desktop socket is never paused for one consumer.
    if (!phone) return;
    noteDesktopTurn(phone);
    sendToPhone(phone, frame.data, frame.droppable);
    return;
  }
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const handler = DESKTOP_FRAME_HANDLERS.get(message.type);
  if (handler) {
    handler(leg, message);
    return;
  }
  // Media proxy frames: head, body chunks, then end. The relay only
  // forwards them; the desktop owns status, headers and byte windows so
  // both remote surfaces cache and seek by identical rules.
  if (typeof message.type === 'string' && message.type.startsWith('media-')) {
    forwardMediaFrame(entry, message);
  }
}

/** ONE read of the leg this phone is attached to right now, with the ceilings
 *  that belong to THAT connection's declaration. Every decision about one
 *  message — which ceiling it is held to, which envelope it travels in, which
 *  socket it is handed to — comes from this single snapshot, so a redial
 *  between two of them can never measure a frame against one leg and deliver
 *  it to another. No configured number reaches this: the only capacity here
 *  is the normalised one the live connection declared for itself.
 *  Ceilings belong to the LEG this phone is attached to: the desktop declares
 *  what its receiver takes, and that changes under the phone whenever the
 *  desktop redials with a different build. Recomputed when the declaration
 *  changes and shared by every refusal, so a client only ever learns one
 *  number per wire form. */
function createLegPathReader(entry, clientId, maxFrameBytes) {
  let ceilingKey = '';
  let ceilings = uplinkCeilings({
    capacity: UNDECLARED_CAPACITY_BYTES,
    clientId,
    policy: maxFrameBytes,
  });
  return () => {
    const desktop = entry.socket || null;
    const leg = desktop?.uplinkLeg || null;
    const capacity = leg ? leg.capacity : UNDECLARED_CAPACITY_BYTES;
    const textFrames = leg?.textFrames === true;
    const key = `${capacity}:${textFrames}`;
    if (key !== ceilingKey) {
      ceilingKey = key;
      ceilings = uplinkCeilings({ capacity, clientId, textFrames, policy: maxFrameBytes });
    }
    return { desktop, textFrames, binary: ceilings.binary, text: ceilings.text };
  };
}

/** Phone -> desktop, telling the phone when there is no desktop leg to carry
 *  the frame (a refusal for any other reason has its own handling). */
function uplink(socket, desktop, payload) {
  if (sendUplink(socket, desktop, payload)) return;
  if (!desktop || desktop.readyState !== desktop.OPEN) signalPhoneDesktopGone(socket, true);
}

// One frame from a phone: a liveness probe is answered here, everything else
// rides up the desktop leg inside the routing envelope.
function handlePhoneFrame(socket, clientId, legPath, raw, isBinary, onPhoneTurn) {
  const announced = noteIngressDelivery(socket);
  socket.isAlive = true;
  const path = legPath();
  // The ceiling this phone is held to is the one its message can actually be
  // DELIVERED under: this relay's policy, bounded by what the desktop leg
  // accepts once the routing envelope is on it. Past that is a payload error
  // for this phone, never a reason to drop the socket its session runs on.
  // Inside it, the enveloped frame fits that leg's declared capacity by
  // arithmetic, so admission needs no second opinion after the fact.
  const limit = isBinary ? path.binary : path.text;
  if (rejectOversizeFrame(socket, raw, limit, announced)) return;
  if (isBinary) {
    onPhoneTurn();
    uplink(socket, path.desktop, encodeRelayBinaryFrame({ clientId, data: raw }));
    return;
  }
  const text = raw.toString();
  // Phone liveness probe: answered at the relay — reaching this hop is the
  // question being asked (a dead desktop closes this leg outright).
  if (text.startsWith('{"ping"')) {
    try {
      socket.send('{"pong":1}');
    } catch {
      /* surfaced as close */
    }
    return;
  }
  onPhoneTurn();
  // Backpressure is charged to this leg only: it stops being read while its
  // own frames are outstanding, and resumes on its own flush.
  //
  // A leg that decodes text inside the binary envelope gets it there: that
  // envelope is a fixed header, so a message within policy is still within
  // policy on the wire. JSON escaping can make no such promise, which is why
  // the text ceiling above is a worst case wherever JSON is the only option.
  const envelope = path.textFrames
    ? encodeRelayBinaryFrame({ clientId, data: raw, text: true })
    : JSON.stringify({ type: 'frame', clientId, data: text });
  uplink(socket, path.desktop, envelope);
}

// `browserClientId` is the per-browser credential the relay authenticated when
// the leg upgraded. The desktop keys per-client trust on it; a phone cannot
// choose it. Omitted when absent so older desktops see the envelope they know.
function clientOpenEnvelope(clientId, browserClientId) {
  return typeof browserClientId === 'string' && browserClientId
    ? { type: 'client-open', clientId, browserClientId }
    : { type: 'client-open', clientId };
}

export function runClientLeg(entry, sendJson, socket, browserClientId = null, options = {}) {
  const { maxFrameBytes = MAX_FRAME_BYTES, inflightCeiling = MAX_INFLIGHT_BYTES, ingress, rawSocket = null } = options;
  const clientId = randomUUID();
  socket.browserClientId = browserClientId;
  socket.inflightCeiling = inflightCeiling;
  const legPath = createLegPathReader(entry, clientId, maxFrameBytes);
  socket.oversizeLimitFor = (binary) => {
    const path = legPath();
    return binary ? path.binary : path.text;
  };
  socket.oversizeSignal = (bytes, limit) => signalPhoneOversize(socket, bytes, limit);
  trackLegIngress(socket, rawSocket, { ...ingress, limit: maxFrameBytes });
  entry.clients.set(clientId, socket);
  socket.attached = true;
  const legOpenedAt = Date.now();
  announcePhone(entry, sendJson, clientId, socket);
  // The phone's first frame after a challenge is its hello; the desktop owes
  // the answer from then on.
  const onPhoneTurn = () => {
    if (socket.handshakeTurn === 'hello') awaitDesktopTurn(entry, socket, 'ready');
  };
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
  socket.on('error', () => {
    /* surfaced as close */
  });
  socket.on(
    'message',
    guarded('phone frame', (raw, isBinary) => handlePhoneFrame(socket, clientId, legPath, raw, isBinary, onPhoneTurn))
  );
  socket.on('close', (code, reason) => {
    socket.attached = false;
    endHandshakeWatch(socket);
    releaseLeg(socket);
    releaseIngressLeg(socket);
    entry.clients.delete(clientId);
    sendJson(entry.socket, { type: 'client-close', clientId });
    // A phone that reconnects every few seconds pays a full E2EE handshake and
    // a full roster resync each time, and this is the ONE place both ends of
    // that loop are visible. The code names who hung up: 1000 'background' is
    // the app's own foreground gate, 1001/1006 is the link or the browser
    // discarding the page, and 4xxx is this relay's own guard.
    console.log(
      `[relay] phone leg closed client=${clientId.slice(0, 8)}` +
        ` code=${code} reason=${String(reason || '').slice(0, 60)}` +
        ` lived=${Date.now() - legOpenedAt}ms`
    );
  });
}
