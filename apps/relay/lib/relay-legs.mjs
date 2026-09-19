// Desktop and phone WebSocket legs: envelope routing, claim/revoke control
// frames, media-proxy frames, and per-leg oversize/ingress policy.
import { randomUUID } from 'node:crypto';

import { decodeRelayBinaryFrame, encodeRelayBinaryFrame } from './relay-binary-frame.mjs';
import { failMediaPending, forwardMediaFrame } from './relay-media-proxy.mjs';
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
  signalPhoneOversize,
  trackLegIngress,
  uplinkCeilings,
} from './relay-transport.mjs';

export function runDesktopLeg(context, deviceId, socket) {
  const {
    store,
    sendJson,
    attachDesktop,
    liveDesktops,
    claims,
    maxFrameBytes = MAX_FRAME_BYTES,
    ingress = undefined,
    rawSocket = null,
  } = context;
  const entry = attachDesktop(deviceId, socket);
  let revoked = false;
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
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
    const frame = relayCapabilities(leg, maxFrameBytes);
    const encoded = JSON.stringify(frame);
    if (encoded === leg.published) return;
    leg.published = encoded;
    sendJson(socket, frame);
  };
  publishCapabilities();
  // Existing browser legs survive a transient desktop redial. Replaying
  // client-open makes the replacement desktop build fresh E2EE channels for
  // those same sockets without waiting for backgrounded tabs to reconnect.
  for (const clientId of entry.clients.keys()) {
    sendJson(socket, { type: 'client-open', clientId });
  }
  socket.on(
    'message',
    guarded('desktop frame', (raw, isBinary) => {
      // Bookkeeping first: a message that is not acted on still has to give its
      // ingress reservation back.
      const announced = noteIngressDelivery(socket);
      if (revoked) return;
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
        if (phone) sendToPhone(phone, frame.data, frame.droppable);
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.type === 'revoke-device') {
        const removed = store.revoke(deviceId);
        if (!removed) {
          // Unknown device, or the removal could not be persisted. Report the
          // failure and keep the leg: closing it as revoked would tell the user
          // the credential is gone while it still authenticates after a restart.
          sendJson(socket, { type: 'device-revoked', ok: false });
          return;
        }
        revoked = true;
        for (const phone of entry.clients.values()) {
          try {
            phone.close(4003, 'pairing revoked');
          } catch {
            /* already gone */
          }
        }
        const finish = () => {
          try {
            socket.close(4003, 'device revoked');
          } catch {
            /* already gone */
          }
        };
        try {
          socket.send(JSON.stringify({ type: 'device-revoked', ok: true }), finish);
        } catch {
          finish();
        }
        return;
      }
      if (message.type === 'set-client-token' && typeof message.token === 'string' && message.token.length >= 16) {
        store.setClientToken(deviceId, message.token);
        return;
      }
      // The approval itself. Only the desktop the claim named may answer it, and
      // only then does a credential exist for that container.
      if (message.type === 'claim-approve' && typeof message.claimId === 'string') {
        const claim = claims?.get(message.claimId);
        if (!claim || claim.deviceId !== deviceId || claim.status !== 'pending') return;
        if (claim.expiresAt <= Date.now()) {
          claims.delete(claim.id);
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
        return;
      }
      if (message.type === 'claim-deny' && typeof message.claimId === 'string') {
        const claim = claims?.get(message.claimId);
        if (claim && claim.deviceId === deviceId) claim.status = 'denied';
        return;
      }
      if (message.type === 'list-clients' && typeof message.requestId === 'string') {
        const online = new Set([...entry.clients.values()].map((phone) => phone.browserClientId).filter(Boolean));
        sendJson(socket, {
          type: 'clients-list',
          requestId: message.requestId,
          clients: store.listClients(deviceId, online),
        });
        return;
      }
      if (
        message.type === 'revoke-client' &&
        typeof message.requestId === 'string' &&
        typeof message.clientId === 'string'
      ) {
        const removed = store.revokeClient(deviceId, message.clientId);
        // Only a credential that is actually gone closes its browser: a failed
        // persist leaves the pairing valid, and closing it as revoked would tell
        // the user something the store did not do.
        if (removed) {
          for (const phone of entry.clients.values()) {
            if (phone.browserClientId !== message.clientId) continue;
            try {
              phone.close(4003, 'pairing revoked');
            } catch {
              /* already gone */
            }
          }
        }
        sendJson(socket, {
          type: 'client-revoked',
          requestId: message.requestId,
          ok: removed,
        });
        return;
      }
      // Capability announcement, sent before the leg does anything else. It is
      // ONE bit per lane, not a version number: the relay never branches on a
      // desktop version, it only answers "this host serves media" or not.
      if (message.type === 'desktop-lanes') {
        entry.mediaLane = message.media === true;
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
        return;
      }
      if (message.type === 'frame' && typeof message.data === 'string') {
        const phone = entry.clients.get(String(message.clientId || ''));
        if (phone) sendToPhone(phone, message.data, message.droppable === true);
        return;
      }
      if (message.type === 'close-client') {
        const phone = entry.clients.get(String(message.clientId || ''));
        if (phone) {
          const reason = String(message.reason || 'desktop rejected client').slice(0, 120);
          try {
            phone.close(4004, reason);
          } catch {
            /* already gone */
          }
        }
        return;
      }
      // Media proxy frames: head, body chunks, then end. The relay only
      // forwards them; the desktop owns status, headers and byte windows so
      // both remote surfaces cache and seek by identical rules.
      if (typeof message.type === 'string' && message.type.startsWith('media-')) {
        forwardMediaFrame(entry, message);
        return;
      }
      if (message.type === 'broadcast' && typeof message.data === 'string') {
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
    })
  );
  socket.on('close', () => {
    releaseLeg(socket);
    releaseIngressLeg(socket);
    // The close code is deliberately not read. Whatever this receiver did with
    // whatever frame, it says nothing this relay can attribute — and the leg
    // state that could have carried a verdict forward goes away with the
    // socket, so the next connection starts from its own declaration.
    if (liveDesktops.get(deviceId)?.socket === socket) {
      failMediaPending(entry);
      // Keep browser legs parked at the relay during transient desktop/VPS
      // outages. New RPCs cannot reach a closed desktop socket, but the next
      // desktop leg rekeys and resumes all existing clients in place.
      if (entry.offlineTimer) clearTimeout(entry.offlineTimer);
      entry.offlineTimer = setTimeout(() => {
        entry.offlineTimer = null;
        if (liveDesktops.get(deviceId)?.socket !== socket) return;
        for (const phone of entry.clients.values()) {
          try {
            phone.close(4002, 'desktop offline');
          } catch {
            /* already gone */
          }
        }
        liveDesktops.delete(deviceId);
      }, 45_000);
      entry.offlineTimer.unref?.();
    }
  });
}

export function runClientLeg(entry, sendJson, socket, browserClientId = null, options = {}) {
  const {
    maxFrameBytes = MAX_FRAME_BYTES,
    inflightCeiling = MAX_INFLIGHT_BYTES,
    ingress = undefined,
    rawSocket = null,
  } = options;
  const clientId = randomUUID();
  socket.browserClientId = browserClientId;
  socket.inflightCeiling = inflightCeiling;
  // Ceilings belong to the LEG this phone is attached to: the desktop declares
  // what its receiver takes, and that changes under the phone whenever the
  // desktop redials with a different build. Recomputed when the declaration
  // changes and shared by every refusal, so a client only ever learns one
  // number per wire form.
  let ceilingKey = '';
  let ceilings = uplinkCeilings({
    capacity: UNDECLARED_CAPACITY_BYTES,
    clientId,
    policy: maxFrameBytes,
  });
  /** ONE read of the leg this phone is attached to right now, with the ceilings
   *  that belong to THAT connection's declaration. Every decision about one
   *  message — which ceiling it is held to, which envelope it travels in, which
   *  socket it is handed to — comes from this single snapshot, so a redial
   *  between two of them can never measure a frame against one leg and deliver
   *  it to another. No configured number reaches this: the only capacity here
   *  is the normalised one the live connection declared for itself. */
  const legPath = () => {
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
  socket.oversizeLimitFor = (binary) => {
    const path = legPath();
    return binary ? path.binary : path.text;
  };
  socket.oversizeSignal = (bytes, limit) => signalPhoneOversize(socket, bytes, limit);
  trackLegIngress(socket, rawSocket, { ...ingress, limit: maxFrameBytes });
  entry.clients.set(clientId, socket);
  const legOpenedAt = Date.now();
  sendJson(entry.socket, { type: 'client-open', clientId });
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
  socket.on('error', () => {
    /* surfaced as close */
  });
  socket.on(
    'message',
    guarded('phone frame', (raw, isBinary) => {
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
        sendUplink(socket, path.desktop, encodeRelayBinaryFrame({ clientId, data: raw }));
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
      sendUplink(socket, path.desktop, envelope);
    })
  );
  socket.on('close', (code, reason) => {
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
