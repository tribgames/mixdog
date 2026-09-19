#!/usr/bin/env node
// Mixdog remote relay for the installable web app.
//
// Topology: the desktop keeps ONE outbound WebSocket to this relay (so no
// port-forwarding/NAT work on the user side), phones connect here with the
// pairing token, and the relay forwards frames between them verbatim. The
// phone-side wire protocol is implemented by the renderer's remote shim.
//
// Envelope protocol on the desktop leg (JSON, one object per message):
//   relay -> desktop: { type: 'client-open',  clientId }
//                     { type: 'client-close', clientId }
//                     { type: 'frame', clientId, data }   // phone RPC frame
//   desktop -> relay: { type: 'frame', clientId, data }   // RPC response
//                     { type: 'broadcast', data }         // state/term push
//                     { type: 'set-client-token', token } // phone auth token
//
// Auth: desktops self-register on first connect (trust-on-first-use device
// id + secret, hashes persisted under DATA_DIR); phones present the client
// token the desktop registered. Payloads are relayed without inspection.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WebSocketServer } from 'ws';

import { createRendererReadiness } from './lib/renderer-readiness.mjs';
import { RateLimiter } from './lib/rate-limit.mjs';
import { DeviceStore, readDeviceCredentials } from './lib/device-store.mjs';
import {
  INGRESS_FREE_WINDOW_BYTES,
  INGRESS_RESERVATION_BYTES,
  INGRESS_STALL_TIMEOUT_MS,
  INGRESS_WAIT_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_INFLIGHT_BYTES,
  MAX_INGRESS_BYTES,
  MAX_UPLINK_CAPACITY_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  boundedCapacity,
  newUplinkLeg,
  releaseIngressLeg,
} from './lib/relay-transport.mjs';
import {
  MAX_PHONE_CONNECTIONS_PER_MINUTE,
  PHONE_CONNECT_RATE_WINDOW_MS,
  authenticateLeg,
  browserSocketOriginAllowed,
  clientIp,
  phoneClientCapacityAvailable,
} from './lib/relay-http.mjs';
import { MAX_HOOK_PENDING_PER_DEVICE, failHookPending, handleHookRequest, runHookLeg } from './lib/relay-hook.mjs';
import { failMediaPending, handleMediaRequest } from './lib/relay-media-proxy.mjs';
import { handleClaimRequest, handleClientRegistration } from './lib/relay-pairing.mjs';
import { serveStatic } from './lib/relay-static-gate.mjs';
import { runClientLeg, runDesktopLeg } from './lib/relay-legs.mjs';

export { MAX_RATE_KEYS, RateLimiter } from './lib/rate-limit.mjs';
export {
  DeviceStore,
  readDeviceCredentials,
  registrableDeviceId,
} from './lib/device-store.mjs';
export {
  INGRESS_RESERVATION_BYTES,
  MAX_FRAME_BYTES,
  MAX_INFLIGHT_BYTES,
  MAX_INGRESS_BYTES,
  MAX_UPLINK_CAPACITY_BYTES,
  MAX_WS_PAYLOAD_BYTES,
  UNDECLARED_CAPACITY_BYTES,
  admitFrame,
  admitIngress,
  relayInflightBytes,
  relayIngressStats,
  resetRelayIngressStats,
  routedClientId,
  sendToPhone,
  uplinkCapacityFor,
  uplinkCeilings,
} from './lib/relay-transport.mjs';
export {
  MAX_PHONE_CLIENTS_PER_DEVICE,
  MAX_PHONE_CONNECTIONS_PER_MINUTE,
  browserSocketOriginAllowed,
  phoneClientCapacityAvailable,
} from './lib/relay-http.mjs';
export { MAX_HOOK_RESPONSE_BODY_BYTES, decodeHookResponseBody } from './lib/relay-hook.mjs';
export { mediaResponseHeaders } from './lib/relay-media-proxy.mjs';
export {
  CLAIM_TTL_MS,
  MAX_PENDING_CLAIMS,
  MAX_PENDING_CLAIMS_PER_DEVICE,
  MAX_PENDING_CLAIMS_PER_SOURCE,
} from './lib/relay-pairing.mjs';
export { PUBLIC_APP_ASSETS, parseDeviceRoute } from './lib/relay-static-gate.mjs';

// Public ingress and trust-on-first-use registration are the only unauthenticated
// surfaces here, so both carry a quota: without one, a scanner can mint device
// rows until devices.json fills the box, or replay hook posts until the agent
// leg starves. Buckets are keyed by client IP / deviceId and swept lazily.
const HOOK_RATE_LIMIT = 120;
const HOOK_RATE_WINDOW_MS = 60_000;
const REGISTER_RATE_LIMIT = 5;
const REGISTER_RATE_WINDOW_MS = 10 * 60_000;
const UNAUTHORIZED_RATE_LIMIT = 60;
const UNAUTHORIZED_RATE_WINDOW_MS = 60_000;

export async function startRelay({
  port = 9800,
  dataDir = './data',
  rendererDir = '',
  // TLS termination stays in-process (no reverse proxy in the data path):
  // point these at fullchain.pem / privkey.pem to serve https+wss directly.
  tlsCert = '',
  tlsKey = '',
  // Forwarding policy knobs. Production runs the defaults; they exist so the
  // ceilings can be exercised without moving 64 MiB through a test.
  maxFrameBytes = MAX_FRAME_BYTES,
  maxHookPending = MAX_HOOK_PENDING_PER_DEVICE,
  // Memory ceilings, outbound and inbound. Production runs the defaults; they
  // are options so both gates can be driven at a size that fits in a test
  // instead of moving hundreds of megabytes through one.
  maxInflightBytes = MAX_INFLIGHT_BYTES,
  maxIngressBytes = MAX_INGRESS_BYTES,
  ingressReservationBytes = INGRESS_RESERVATION_BYTES,
  ingressWindowBytes = INGRESS_FREE_WINDOW_BYTES,
  // Transport ceiling of this relay's own receiver, and the one the desktop leg
  // applies to what the relay sends it. Both are policy the meter compares
  // against, so both are options.
  maxPayloadBytes = MAX_WS_PAYLOAD_BYTES,
  // An upper CLAMP on what a desktop leg is taken to accept — never a value
  // that can raise a leg above what it declared about itself.
  uplinkCapacityBytes = MAX_UPLINK_CAPACITY_BYTES,
} = {}) {
  // Configuration enters the relay HERE, and is normalised HERE, once. Every
  // later reader takes this number, so no path can reach the raw option and no
  // figure this relay publishes can differ from the one it enforces.
  const uplinkCapacityCeiling = boundedCapacity(uplinkCapacityBytes, MAX_UPLINK_CAPACITY_BYTES);
  const store = new DeviceStore(resolve(dataDir));
  // deviceId -> { socket, clients: Map<clientId, phoneSocket> }
  const liveDesktops = new Map();
  // hook deviceId -> { socket, pending: Map<requestId, {response, timer}> }
  const liveHooks = new Map();
  // claimId -> pending approval for a container that has no credential yet.
  const claims = new Map();
  // Abuse guards for the unauthenticated surfaces: public webhook ingress,
  // trust-on-first-use device registration, and pairing-token probing.
  const hookLimiter = new RateLimiter(HOOK_RATE_LIMIT, HOOK_RATE_WINDOW_MS);
  const registerLimiter = new RateLimiter(REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS);
  const unauthorizedLimiter = new RateLimiter(UNAUTHORIZED_RATE_LIMIT, UNAUTHORIZED_RATE_WINDOW_MS);
  const phoneConnectLimiter = new RateLimiter(MAX_PHONE_CONNECTIONS_PER_MINUTE, PHONE_CONNECT_RATE_WINDOW_MS);
  // An async handler settles outside the synchronous guard below, so it gets
  // its own terminator: no unhandled rejection, and the caller still answers.
  const failRequest = (request, response, label) => (error) => {
    console.error(`[relay] ${label} failed:`, error?.message || error);
    try {
      if (response.headersSent) response.end();
      else {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Internal error.');
      }
    } catch {
      try {
        request.destroy();
      } catch {
        /* already gone */
      }
    }
  };
  const rendererReadiness = createRendererReadiness(rendererDir);
  const routeRequest = (request, response) => {
    if ((request.url || '').split('?')[0] === '/readyz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405).end();
        return;
      }
      const ready = rendererReadiness();
      response
        .writeHead(ready.statusCode, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        .end(request.method === 'HEAD' ? undefined : JSON.stringify(ready.body));
      return;
    }
    // Public webhook ingress bypasses the pairing-token gate: callers are
    // external services (GitHub, Stripe); authentication is the per-endpoint
    // HMAC signature verified on the agent side.
    if ((request.url || '').startsWith('/hook/')) {
      handleHookRequest(liveHooks, hookLimiter, maxHookPending, request, response);
      return;
    }
    if ((request.url || '').startsWith('/client/register')) {
      handleClientRegistration(store, unauthorizedLimiter, request, response).catch(
        failRequest(request, response, 'client registration')
      );
      return;
    }
    // Approval handoff: the only surface a credential-less container may use,
    // and it grants nothing without the desktop's answer.
    if ((request.url || '').startsWith('/claim')) {
      handleClaimRequest({ store, liveDesktops, claims, unauthorizedLimiter }, request, response).catch(
        failRequest(request, response, 'claim request')
      );
      return;
    }
    // Media is a byte lane: it answers before the app shell so a gallery tile
    // or a video seek never rides the phone's RPC socket.
    if ((request.url || '').startsWith('/media/')) {
      handleMediaRequest(store, liveDesktops, unauthorizedLimiter, request, response);
      return;
    }
    serveStatic(rendererDir, store, unauthorizedLimiter, request, response);
  };
  // Last line of defence for the unauthenticated HTTP surface: a throw here
  // would otherwise take the process down and let any caller crash-loop the
  // relay for the whole fleet.
  const handler = (request, response) => {
    try {
      routeRequest(request, response);
    } catch (error) {
      console.error('[relay] request failed:', error?.message || error);
      try {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Internal error.');
      } catch {
        try {
          request.destroy();
        } catch {
          /* already gone */
        }
      }
    }
  };
  // HTTP/1.1. An http2.createSecureServer({ allowHTTP1: true }) listener was
  // measurably faster for the phone's first boot (~275ms to reveal, one TLS
  // handshake instead of one per parallel asset) and passed an isolated probe
  // on this box: h2 negotiated, the /desktop upgrade completed, brotli and the
  // cookie/redirect paths were intact. Live traffic disagreed — phone legs
  // started dying at their 20s RPC deadline and the app came up with no
  // transcript at all. WebSockets are the product here and the first boot is
  // paid once per deploy, so the listener stays on the transport where the
  // legs are known to survive until that failure is understood.
  const server =
    tlsCert && tlsKey
      ? createTlsServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, handler)
      : createServer(handler);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
    // Transport compression is OFF because everything on the phone leg is
    // already E2EE ciphertext by the time it reaches this hop, and ciphertext
    // does not compress — deflate spent CPU and a zlib context per socket to
    // move the same number of bytes. The desktop now compresses transcript
    // and state payloads INSIDE the encrypted envelope instead, so this box
    // just forwards frames and can hold far more legs on the same RAM.
    perMessageDeflate: false,
  });
  // Receive-side budget shared by every authenticated leg on this relay.
  const legIngress = {
    ceiling: maxIngressBytes,
    reservation: ingressReservationBytes,
    window: ingressWindowBytes,
    transport: maxPayloadBytes,
  };

  const sendJson = (socket, payload) => {
    if (socket && socket.readyState === socket.OPEN) {
      try {
        socket.send(JSON.stringify(payload));
      } catch {
        /* peer vanished */
      }
    }
  };

  const attachDesktop = (deviceId, socket) => {
    // Every desktop socket carries its own uplink state from the moment it is
    // attached. Nothing about a receiver is inherited, restored or remembered:
    // the replacement leg is a different build until it says otherwise, and
    // "until it says otherwise" is the floor, not the last leg's number.
    socket.uplinkLeg = newUplinkLeg(uplinkCapacityCeiling);
    const previous = liveDesktops.get(deviceId);
    if (previous) {
      if (previous.offlineTimer) clearTimeout(previous.offlineTimer);
      previous.offlineTimer = null;
      try {
        previous.socket.close(4000, 'superseded');
      } catch {
        /* already gone */
      }
      failMediaPending(previous);
      // A desktop/VPS redial is a transport event, not a browser-session
      // event. Keep phone sockets attached and re-announce them to the new
      // desktop leg; its E2EE challenge rekeys each existing connection.
      previous.socket = socket;
      previous.media = new Map();
      previous.mediaLane = false;
      return previous;
    }
    // `mediaLane` starts false on purpose: an older desktop never announces
    // it, and the media route must degrade on the FIRST request instead of
    // waiting out a first-frame timeout per tile.
    const entry = {
      socket,
      clients: new Map(),
      media: new Map(),
      mediaLane: false,
      // No capacity and no envelope support live here: they are properties of
      // the CONNECTION (`socket.uplinkLeg`), so a phone always reads the state
      // of the leg its next frame will actually be handed to.
      offlineTimer: null,
    };
    liveDesktops.set(deviceId, entry);
    return entry;
  };

  const handleUpgrade = (request, rawSocket, head) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      rawSocket.destroy();
      return;
    }
    const reject = (status = 401, reason = 'Unauthorized') => {
      rawSocket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      rawSocket.destroy();
    };
    // Trust-on-first-use keeps setup zero-config, but only a bounded number of
    // NEW ids may be minted per source; a known device re-dialing is free.
    // A FAILED attempt is charged to the caller either way — otherwise a known
    // device id is a free oracle for guessing its secret at network speed.
    // 0 = authenticated, otherwise the HTTP status to reject the upgrade with.
    const rejectLeg = (status) => {
      reject(status, status === 429 ? 'Too Many Requests' : 'Unauthorized');
    };
    if (url.pathname === '/desktop') {
      const { deviceId, secret } = readDeviceCredentials(request, url);
      const denied = authenticateLeg(store, registerLimiter, unauthorizedLimiter, request, deviceId, secret);
      if (denied) {
        rejectLeg(denied);
        return;
      }
      wss.handleUpgrade(request, rawSocket, head, (socket) =>
        runDesktopLeg(
          {
            store,
            sendJson,
            attachDesktop,
            liveDesktops,
            claims,
            maxFrameBytes,
            ingress: legIngress,
            rawSocket,
          },
          deviceId,
          socket
        )
      );
      return;
    }
    if (url.pathname === '/ws') {
      if (!browserSocketOriginAllowed(request)) {
        reject(403, 'Forbidden');
        return;
      }
      const token = url.searchParams.get('token') || '';
      const access = store.clientAccessForToken(token);
      // Clean break (v2): /ws accepts ONLY the per-browser credential minted
      // by /client/register. A missing, stale, or legacy shared token is not
      // retryable — finish the handshake and close 4005 so the phone drops
      // its stored pairing and shows the QR scanner instead of retrying.
      if (!access?.clientId) {
        if (!unauthorizedLimiter.allow(clientIp(request))) {
          reject(429, 'Too Many Requests');
          return;
        }
        wss.handleUpgrade(request, rawSocket, head, (socket) => {
          try {
            socket.close(4005, 'pairing rescan required');
          } catch {
            /* already gone */
          }
        });
        return;
      }
      const deviceId = access.deviceId;
      const entry = liveDesktops.get(deviceId);
      if (!entry || entry.socket.readyState !== entry.socket.OPEN) {
        // Desktop offline is transient: plain reject keeps the phone's
        // reconnect loop alive without touching its stored pairing.
        reject();
        return;
      }
      if (!phoneConnectLimiter.allow(deviceId)) {
        reject(429, 'Too Many Requests');
        return;
      }
      if (!phoneClientCapacityAvailable(entry.clients.size)) {
        reject(429, 'Too Many Requests');
        return;
      }
      store.touchClient(deviceId, access.clientId);
      wss.handleUpgrade(request, rawSocket, head, (socket) =>
        runClientLeg(entry, sendJson, socket, access.clientId, {
          maxFrameBytes,
          inflightCeiling: maxInflightBytes,
          ingress: legIngress,
          rawSocket,
        })
      );
      return;
    }
    if (url.pathname === '/hookleg') {
      // Channel-worker webhook tunnel: same trust-on-first-use device model
      // as the desktop leg (worker mints its own id/secret pair).
      const { deviceId, secret } = readDeviceCredentials(request, url);
      const denied = authenticateLeg(store, registerLimiter, unauthorizedLimiter, request, deviceId, secret);
      if (denied) {
        rejectLeg(denied);
        return;
      }
      wss.handleUpgrade(request, rawSocket, head, (socket) =>
        runHookLeg(liveHooks, deviceId, socket, { ingress: legIngress, rawSocket })
      );
      return;
    }
    rawSocket.destroy();
  };
  // The upgrade listener runs outside any request scope, so a throw here is an
  // uncaught exception for the whole fleet: answer with a dead socket instead.
  server.on('upgrade', (request, rawSocket, head) => {
    try {
      handleUpgrade(request, rawSocket, head);
    } catch (error) {
      console.error('[relay] websocket upgrade failed:', error?.message || error);
      try {
        rawSocket.destroy();
      } catch {
        /* already gone */
      }
    }
  });

  return finishRelayStart({ server, wss, store, liveDesktops, liveHooks, port });
}

async function finishRelayStart({ server, wss, store, liveDesktops, liveHooks, port }) {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
  // NAT/middleboxes drop idle WebSockets silently; sweep every 10s so dead
  // desktop legs release their registration (phones otherwise blackhole)
  // and dead phone legs stop holding broadcast fan-out slots.
  // A backgrounded phone usually closes its own socket, but the leg can also
  // vanish with no CLOSE frame (WiFi/LTE handover, task kill, Doze). Until a
  // sweep terminates that leg the desktop keeps producing frames this relay
  // can only discard, so the sweep interval IS the waste window: 25s meant up
  // to 50s of billed traffic nobody could receive. The extra pings on live
  // legs are a few bytes each and buy that window back.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const ingress = ws.ingress;
      // A leg holding a slice of the receive budget without making progress is
      // box memory pinned by a peer that went quiet mid-frame.
      if (ingress?.holding && Date.now() - ingress.progressAt > INGRESS_STALL_TIMEOUT_MS) {
        releaseIngressLeg(ws);
        try {
          ws.close(4008, 'slow producer');
        } catch {
          /* already gone */
        }
        continue;
      }
      // A leg parked for ingress admission is not being READ, so it cannot
      // answer a ping: sweeping it would turn backpressure into a disconnect.
      // Its wait is what is bounded instead.
      if (ingress?.waiting) {
        if (Date.now() - ingress.waitingSince > INGRESS_WAIT_TIMEOUT_MS) {
          releaseIngressLeg(ws);
          try {
            ws.close(4009, 'relay busy');
          } catch {
            /* already gone */
          }
        }
        continue;
      }
      if (ws.isAlive === false) {
        // A terminate reaches the peer as a bare 1006 that names nobody, so the
        // sweep says here that IT was the one that cut a silent leg.
        console.log('[relay] sweep terminated a leg that missed its ping window');
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* surfaced as close */
      }
    }
  }, 10_000);
  heartbeat.unref?.();
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const entry of liveDesktops.values()) {
      if (entry.offlineTimer) clearTimeout(entry.offlineTimer);
      try {
        entry.socket.terminate();
      } catch {
        /* already gone */
      }
      for (const phone of entry.clients.values()) {
        try {
          phone.terminate();
        } catch {
          /* already gone */
        }
      }
    }
    liveDesktops.clear();
    for (const entry of liveHooks.values()) {
      failHookPending(entry);
      try {
        entry.socket.terminate();
      } catch {
        /* already gone */
      }
    }
    liveHooks.clear();
    // Flush any debounced device registration before the process goes away.
    store.saveOrLog();
    await new Promise((resolveClose) => wss.close(() => resolveClose()));
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  };
  return { port: boundPort, store, close };
}

const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const port = Number(process.env.PORT || 9800);
  const dataDir = process.env.DATA_DIR || './data';
  const rendererDir = process.env.RENDERER_DIR || '';
  const tlsCert = process.env.TLS_CERT || '';
  const tlsKey = process.env.TLS_KEY || '';
  startRelay({ port, dataDir, rendererDir, tlsCert, tlsKey })
    .then((relay) => {
      const scheme = tlsCert && tlsKey ? 'https' : 'http';
      console.log(`[relay] ${scheme} listening on :${relay.port} (renderer: ${rendererDir || 'none'})`);
    })
    .catch((error) => {
      console.error('[relay] failed to start:', error.message);
      process.exit(1);
    });
}
