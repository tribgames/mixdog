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
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WebSocketServer } from 'ws';

import {
  deviceCookieHeaders,
  mergeCookieHeaders,
  pairingCookieHeaders,
  parseCookieDevice,
  parseCookieToken,
  resolveStaticTarget,
  sendDeviceManifest,
  sendStaticFile,
} from './lib/static-http.mjs';
import { parseMediaRequest } from './lib/media-http.mjs';
import { createRendererReadiness } from './lib/renderer-readiness.mjs';
import {
  decodeRelayBinaryFrame,
  encodeRelayBinaryFrame,
} from './lib/relay-binary-frame.mjs';
import { isRoutingId } from './lib/ids.mjs';
import { RateLimiter } from './lib/rate-limit.mjs';
import {
  DeviceStore,
  clientProfile,
  readDeviceCredentials,
} from './lib/device-store.mjs';
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
  UNDECLARED_CAPACITY_BYTES,
  boundedCapacity,
  declareUplinkLeg,
  guarded,
  newUplinkLeg,
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
} from './lib/relay-transport.mjs';

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

// Public webhook forwarding (replaces per-user ngrok tunnels): the channel
// worker keeps one outbound `/hookleg` WebSocket and the relay replays
// inbound `/hook/<deviceId>/...` HTTP requests over it as JSON frames.
// Payloads pass through un-inspected; HMAC verification stays on the agent.
const MAX_HOOK_BODY_BYTES = 1024 * 1024;
export const MAX_HOOK_RESPONSE_BODY_BYTES = MAX_HOOK_BODY_BYTES;
const HOOK_TIMEOUT_MS = 30_000;
// The webhook lane is public, so bound both what one agent leg may hold open
// and what the relay will buffer toward it: without a cap a burst parks
// (pending responses × body) plus an unbounded socket backlog in memory.
const MAX_HOOK_PENDING_PER_DEVICE = 64;
const HOOK_SOCKET_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
// Media travels as a proxied byte stream over the desktop leg: the phone gets
// a cacheable, range-able HTTP response instead of a base64 RPC answer, and
// the relay only has to forward frames. The timeout covers the FIRST frame;
// a long clip then streams for as long as the desktop keeps sending.
const MEDIA_HEAD_TIMEOUT_MS = 30_000;
// A desktop that goes quiet mid-clip must not pin an open response forever:
// the phone retries the range instead of watching a socket that never ends.
const MEDIA_STALL_TIMEOUT_MS = 30_000;
// Byte-lane flow control. The desktop pauses on ITS socket backlog, which a
// relay that drains eagerly never fills, so a slow phone's clip would buffer
// here instead. Pause the producer once the response buffer fills, and cut a
// leg that stopped draining entirely (media is retryable: the browser asks
// for the range again).
const MEDIA_PAUSE_BUFFER_BYTES = 1024 * 1024;
const MEDIA_KILL_BUFFER_BYTES = 8 * 1024 * 1024;
// One tab opening a screenful of tiles is normal; unbounded proxied streams
// per desktop are not (each one holds an open response and a file read).
const MAX_MEDIA_STREAMS = 32;
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
export const MAX_PHONE_CONNECTIONS_PER_MINUTE = 120;
const PHONE_CONNECT_RATE_WINDOW_MS = 60_000;
export const MAX_PHONE_CLIENTS_PER_DEVICE = 32;

// Branding/installability files served without the pairing gate (see
// serveStatic): manifest + icons referenced by index.html and the manifest.
export const PUBLIC_APP_ASSETS = new Set([
  '/manifest.webmanifest',
  '/mixdog.svg',
  '/mixdog-192.png',
  '/mixdog-512.png',
]);

// Approval handoff. A freshly installed web app has an EMPTY storage
// container — no token, and on iOS no way to inherit one from the browser that
// installed it. The device route it launches at names the desktop to ask, this
// relay forwards the request, and the desktop's approval is what mints the
// per-browser credential. Pending claims are short-lived and bounded: they are
// unauthenticated state.
export const MAX_PENDING_CLAIMS = 64;
// The global pool is shared by every desktop on the box, so it also needs a
// per-target and per-source share: otherwise one caller (or one named device)
// fills all 64 slots and every other install gets `busy` until they expire.
export const MAX_PENDING_CLAIMS_PER_DEVICE = 8;
export const MAX_PENDING_CLAIMS_PER_SOURCE = 8;
// Long enough to walk to the desktop and answer the prompt there.
export const CLAIM_TTL_MS = 300_000;

/** `/d/<deviceId>/...` — the install/approval entry for one desktop. The id
 *  is a routing label, never a credential: it opens the shell that asks for
 *  approval and nothing else. */
export function parseDeviceRoute(pathname) {
  const match = /^\/d\/([0-9a-f-]{8,64})(\/.*)?$/.exec(String(pathname || ''));
  if (!match) return null;
  const rest = match[2] || '';
  return {
    deviceId: match[1],
    // Relative asset/manifest hrefs in index.html only resolve inside the
    // route when it ends in a slash.
    redirect: rest === '',
    rest: rest === '' || rest === '/' ? '/index.html' : rest,
  };
}

export function phoneClientCapacityAvailable(clientCount) {
  return Number(clientCount) < MAX_PHONE_CLIENTS_PER_DEVICE;
}

export function browserSocketOriginAllowed(request) {
  const origin = typeof request?.headers?.origin === 'string' ? request.headers.origin : '';
  const host = typeof request?.headers?.host === 'string' ? request.headers.host : '';
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const protocol = request?.socket?.encrypted ? 'https:' : 'http:';
    return parsed.protocol === protocol
      && parsed.host.toLowerCase() === host.toLowerCase()
      && parsed.pathname === '/'
      && !parsed.search
      && !parsed.hash
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function clientIp(request) {
  return request.socket?.remoteAddress || 'unknown';
}

function authenticateLeg(store, registerLimiter, unauthorizedLimiter, request, deviceId, secret) {
  if (!isRoutingId(deviceId) || secret.length < 16) return 401;
  if (!store.isKnown(deviceId) && !registerLimiter.allow(clientIp(request))) return 429;
  if (store.authenticate(deviceId, secret)) return 0;
  return unauthorizedLimiter.allow(`auth:${clientIp(request)}`) ? 401 : 429;
}

// Hop-by-hop / transport headers stay on this hop; signature headers and the
// rest forward verbatim so local HMAC verification sees the sender's bytes.
const HOOK_DROP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'te',
]);

function handleHookRequest(liveHooks, hookLimiter, maxPending, request, response) {
  let url;
  try {
    url = new URL(request.url || '/', 'http://localhost');
  } catch {
    response.writeHead(400).end();
    return;
  }
  const match = url.pathname.match(/^\/hook\/([0-9a-f-]{8,64})(\/.*)?$/);
  if (!match) {
    response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
    return;
  }
  // Device-keyed alone lets one source spread a burst across ids; the caller
  // bucket is what bounds the total an unauthenticated peer can push in.
  if (!hookLimiter.allow(`device:${match[1]}`) || !hookLimiter.allow(`ip:${clientIp(request)}`)) {
    response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      .end('{"error":"rate limited"}');
    try { request.destroy(); } catch { /* already gone */ }
    return;
  }
  const entry = liveHooks.get(match[1]);
  if (!entry || entry.socket.readyState !== entry.socket.OPEN) {
    response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"agent offline"}');
    return;
  }
  // An agent that is not keeping up must not turn into relay memory: refuse
  // before the body is read rather than queue another megabyte behind it.
  // Bodies still streaming in count too — measuring only `pending` lets any
  // number of slow uploads arrive together and pass the cap before the first
  // one lands.
  if (entry.pending.size + (entry.inflight || 0) >= maxPending
    || entry.socket.bufferedAmount > HOOK_SOCKET_BUFFER_LIMIT_BYTES) {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' })
      .end('{"error":"agent busy"}');
    try { request.destroy(); } catch { /* already gone */ }
    return;
  }
  entry.inflight = (entry.inflight || 0) + 1;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    entry.inflight = Math.max(0, (entry.inflight || 1) - 1);
  };
  const chunks = [];
  let total = 0;
  let aborted = false;
  request.on('data', (chunk) => {
    if (aborted) return;
    total += chunk.length;
    if (total > MAX_HOOK_BODY_BYTES) {
      aborted = true;
      releaseSlot();
      try {
        response.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"payload too large"}');
      } catch { /* client vanished */ }
      try { request.destroy(); } catch { /* already gone */ }
      return;
    }
    chunks.push(chunk);
  });
  request.on('error', () => { aborted = true; releaseSlot(); });
  // A caller that hangs up mid-body must give its reservation back.
  request.on('close', releaseSlot);
  request.on('end', () => {
    if (aborted) return;
    // The reservation becomes a `pending` entry: release it in the same turn so
    // the two counters never double-count the same request.
    releaseSlot();
    const id = randomUUID();
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (!HOOK_DROP_HEADERS.has(key)) headers[key] = value;
    }
    const timer = setTimeout(() => {
      if (entry.pending.delete(id)) {
        try {
          response.writeHead(504, { 'Content-Type': 'application/json' }).end('{"error":"agent timeout"}');
        } catch { /* client vanished */ }
      }
    }, HOOK_TIMEOUT_MS);
    timer.unref?.();
    entry.pending.set(id, { response, timer });
    try {
      entry.socket.send(JSON.stringify({
        type: 'http',
        id,
        method: request.method,
        path: (match[2] || '/') + url.search,
        headers,
        body: chunks.length ? Buffer.concat(chunks).toString('base64') : '',
      }));
    } catch {
      clearTimeout(timer);
      if (entry.pending.delete(id)) {
        try {
          response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"agent unreachable"}');
        } catch { /* client vanished */ }
      }
    }
  });
}

function failHookPending(entry) {
  for (const { response, timer } of entry.pending.values()) {
    clearTimeout(timer);
    try {
      response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"agent disconnected"}');
    } catch { /* client vanished */ }
  }
  entry.pending.clear();
}

function runHookLeg(liveHooks, deviceId, socket, options = {}) {
  const { ingress = undefined, rawSocket = null } = options;
  trackLegIngress(socket, rawSocket, { ...ingress, limit: MAX_HOOK_BODY_BYTES });
  const previous = liveHooks.get(deviceId);
  if (previous) {
    try { previous.socket.close(4000, 'superseded'); } catch { /* already gone */ }
    failHookPending(previous);
  }
  const entry = { socket, pending: new Map(), inflight: 0 };
  liveHooks.set(deviceId, entry);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => { /* surfaced as close */ });
  socket.on('message', guarded('hook frame', (raw) => {
    noteIngressDelivery(socket);
    socket.isAlive = true;
    let frame;
    try { frame = JSON.parse(raw.toString()); } catch { return; }
    if (frame.type !== 'http-response' || typeof frame.id !== 'string') return;
    const pending = entry.pending.get(frame.id);
    if (!pending) return;
    entry.pending.delete(frame.id);
    clearTimeout(pending.timer);
    const status = Number.isInteger(frame.status) && frame.status >= 100 && frame.status <= 599
      ? frame.status : 502;
    let body;
    try {
      body = decodeHookResponseBody(frame.body);
    } catch {
      try {
        pending.response.writeHead(502, { 'Content-Type': 'application/json' })
          .end('{"error":"invalid agent response"}');
      } catch { /* client vanished */ }
      return;
    }
    const rawContentType = typeof frame.headers?.['content-type'] === 'string'
      ? frame.headers['content-type'] : '';
    const contentType = /^[\x20-\x7e]{1,200}$/.test(rawContentType)
      ? rawContentType : 'application/json';
    try {
      pending.response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
      pending.response.end(body);
    } catch { /* client vanished */ }
  }));
  socket.on('close', () => {
    releaseIngressLeg(socket);
    if (liveHooks.get(deviceId)?.socket !== socket) return;
    failHookPending(entry);
    liveHooks.delete(deviceId);
  });
}

/** Percent-decoding throws on malformed input (`/media/%`). That input arrives
 *  unauthenticated, so it has to become a response, never an exception on the
 *  server's request path. Null means "not a decodable path". */
function decodePathname(pathname) {
  try {
    return decodeURIComponent(String(pathname || ''));
  } catch {
    return null;
  }
}

/**
 * `/media/<assetId>?variant=` — the gallery's byte lane through the relay.
 *
 * The files live on the desktop, so the relay proxies: it forwards one media
 * request over the desktop leg and streams the frames straight into the HTTP
 * response. Payloads pass through un-inspected, exactly like /hook.
 */
function handleMediaRequest(store, liveDesktops, unauthorizedLimiter, request, response) {
  let url;
  try {
    url = new URL(request.url || '/', 'http://localhost');
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end();
    return;
  }
  const pathname = decodePathname(url.pathname);
  if (pathname === null) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Bad request.');
    return;
  }
  const token = url.searchParams.get('token') || parseCookieToken(request.headers.cookie);
  const deviceId = token ? store.deviceIdForClientToken(token) : null;
  if (!deviceId) {
    if (!unauthorizedLimiter.allow(clientIp(request))) {
      response.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' })
        .end('Too many requests.');
      return;
    }
    response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Unauthorized.');
    return;
  }
  const entry = liveDesktops.get(deviceId);
  const online = Boolean(entry) && entry.socket.readyState === entry.socket.OPEN;
  // Feature probe, answered for the DESKTOP that would produce the bytes.
  // The relay serves ONE web bundle to every phone while installs update on
  // their own schedule, so this relay is routinely newer than the desktop it
  // is paired with. Reporting the desktop's lane keeps that skew a plain
  // answer instead of something the phone has to infer from a stall.
  if (pathname === '/media/healthz') {
    if (!online || !entry.mediaLane) {
      response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"status":"unsupported"}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  const target = parseMediaRequest(pathname, url.searchParams);
  if (!target) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
    return;
  }
  if (!online) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Desktop offline.');
    return;
  }
  // An older desktop leg drops unknown frames on the floor, so asking it for
  // media would buy nothing but a first-frame timeout on every tile. One
  // capability bit from the leg turns that into an instant downgrade to the
  // RPC payload.
  if (!entry.mediaLane) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Desktop media lane unsupported.');
    return;
  }
  if (entry.media.size >= MAX_MEDIA_STREAMS) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '1' })
      .end('Too many media streams.');
    return;
  }
  const id = randomUUID();
  const pending = { response, timer: null, head: false, paused: false };
  entry.media.set(id, pending);
  // First frame, then per-frame idle: a stalled stream expires either way.
  armMediaTimer(entry, id, pending, MEDIA_HEAD_TIMEOUT_MS);
  // A phone that scrolls away mid-clip must not leave the desktop pumping
  // frames into a dead response.
  response.on('close', () => {
    if (!entry.media.delete(id)) return;
    clearTimeout(pending.timer);
    abortMediaUpstream(entry, id);
  });
  try {
    entry.socket.send(JSON.stringify({
      type: 'media-request',
      id,
      assetId: target.assetId,
      variant: target.variant,
      method: request.method,
      range: String(request.headers.range || ''),
      ifNoneMatch: String(request.headers['if-none-match'] || ''),
    }));
  } catch {
    clearTimeout(pending.timer);
    if (entry.media.delete(id)) {
      try { response.writeHead(502).end(); } catch { /* client vanished */ }
    }
  }
}

/** Tell the desktop to stop reading for a request this relay gave up on. */
function abortMediaUpstream(entry, id) {
  if (entry.socket.readyState !== entry.socket.OPEN) return;
  try { entry.socket.send(JSON.stringify({ type: 'media-abort', id })); } catch { /* gone */ }
}

/** (Re)arm the expiry for one proxied stream; every frame pushes it out. */
function armMediaTimer(entry, id, pending, ms) {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    if (!entry.media.delete(id)) return;
    try {
      if (!pending.head) pending.response.writeHead(504);
      pending.response.end();
    } catch { /* client vanished */ }
    abortMediaUpstream(entry, id);
  }, ms);
  pending.timer.unref?.();
}

// Desktop-supplied media metadata is forwarded, not trusted: these bytes leave
// the RELAY origin, so an HTML/SVG asset must never become an active document
// there and the leg must not be able to set arbitrary headers (cookies, CSP
// overrides) on it. Everything outside this table is dropped.
const MEDIA_PASS_HEADERS = new Map([
  ['content-type', 'Content-Type'],
  ['content-length', 'Content-Length'],
  ['content-range', 'Content-Range'],
  ['accept-ranges', 'Accept-Ranges'],
  ['cache-control', 'Cache-Control'],
  ['etag', 'ETag'],
  ['last-modified', 'Last-Modified'],
  ['vary', 'Vary'],
]);
const MEDIA_ACTIVE_TYPE =
  /^(?:text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/ecmascript)/;

function safeMediaContentType(value) {
  const raw = String(value ?? '');
  if (!/^[\x20-\x7e]{1,200}$/.test(raw)) return 'application/octet-stream';
  const base = raw.split(';')[0].trim().toLowerCase();
  if (!base || MEDIA_ACTIVE_TYPE.test(base)) return 'application/octet-stream';
  return raw;
}

export function mediaResponseHeaders(supplied) {
  const source = supplied && typeof supplied === 'object' && !Array.isArray(supplied)
    ? supplied
    : {};
  const headers = {
    // Nothing on this lane is a document: no scripts, no framing, no sniffing
    // a gallery file into active content at the relay origin.
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'attachment',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'Content-Type': 'application/octet-stream',
  };
  for (const [key, value] of Object.entries(source)) {
    const name = MEDIA_PASS_HEADERS.get(String(key).toLowerCase());
    if (!name || value == null || Array.isArray(value) || typeof value === 'object') continue;
    const text = String(value);
    if (!/^[\x20-\x7e]{0,4096}$/.test(text)) continue;
    headers[name] = name === 'Content-Type' ? safeMediaContentType(text) : text;
  }
  return headers;
}

/** Apply one desktop media frame to its waiting HTTP response. */
function forwardMediaFrame(entry, message) {
  const id = String(message.id || '');
  const pending = entry.media.get(id);
  if (!pending) return;
  if (message.type === 'media-head') {
    pending.head = true;
    armMediaTimer(entry, id, pending, MEDIA_STALL_TIMEOUT_MS);
    const status = Number.isInteger(message.status) && message.status >= 100 && message.status <= 599
      ? message.status : 502;
    try {
      pending.response.writeHead(status, mediaResponseHeaders(message.headers));
    } catch { /* client vanished */ }
    return;
  }
  if (message.type === 'media-chunk' && typeof message.data === 'string') {
    if (!pending.head) return;
    armMediaTimer(entry, id, pending, MEDIA_STALL_TIMEOUT_MS);
    try { pending.response.write(Buffer.from(message.data, 'base64')); } catch { /* client vanished */ }
    const buffered = pending.response.writableLength || 0;
    if (buffered > MEDIA_KILL_BUFFER_BYTES) {
      entry.media.delete(id);
      clearTimeout(pending.timer);
      try { pending.response.destroy(); } catch { /* already gone */ }
      abortMediaUpstream(entry, id);
      return;
    }
    if (!pending.paused && buffered > MEDIA_PAUSE_BUFFER_BYTES) {
      pending.paused = true;
      try { entry.socket.send(JSON.stringify({ type: 'media-pause', id })); } catch { /* gone */ }
      pending.response.once('drain', () => {
        pending.paused = false;
        if (entry.media.get(id) !== pending) return;
        try { entry.socket.send(JSON.stringify({ type: 'media-resume', id })); } catch { /* gone */ }
      });
    }
    return;
  }
  if (message.type === 'media-end' || message.type === 'media-error') {
    entry.media.delete(id);
    clearTimeout(pending.timer);
    try {
      if (!pending.head) pending.response.writeHead(502);
      pending.response.end();
    } catch { /* client vanished */ }
  }
}

/** A desktop that vanished mid-stream leaves half-written responses; close
 *  them so the phone retries instead of hanging on an open socket. */
function failMediaPending(entry) {
  for (const [, pending] of entry.media) {
    clearTimeout(pending.timer);
    try {
      if (!pending.head) pending.response.writeHead(503);
      pending.response.end();
    } catch { /* client vanished */ }
  }
  entry.media.clear();
}

export function decodeHookResponseBody(value) {
  const encoded = value == null ? '' : String(value);
  const maximumEncoded = Math.ceil(MAX_HOOK_RESPONSE_BODY_BYTES / 3) * 4;
  if (encoded.length > maximumEncoded
    || (encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))) {
    throw new Error('invalid hook response body');
  }
  const body = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  if (body.length > MAX_HOOK_RESPONSE_BODY_BYTES) {
    throw new Error('hook response body exceeds limit');
  }
  return body;
}

function requestToken(request, url) {
  const authorization = String(request.headers.authorization || '');
  const bearer = authorization.match(/^Bearer\s+([0-9a-f]{32,128})$/i)?.[1] || '';
  return bearer || url.searchParams.get('token') || parseCookieToken(request.headers.cookie);
}

function readBoundedJson(request, maxBytes = 8 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectBody(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        rejectBody(new Error('invalid json'));
      }
    });
    request.on('error', rejectBody);
  });
}

async function handleClientRegistration(store, unauthorizedLimiter, request, response) {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }
  if (!browserSocketOriginAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  let url;
  let body;
  try {
    url = new URL(request.url || '/', 'http://localhost');
    body = await readBoundedJson(request);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const token = requestToken(request, url);
  const access = store.clientAccessForToken(token);
  const clientId = String(body?.clientId || '');
  if (!access || !isRoutingId(clientId)) {
    if (!unauthorizedLimiter.allow(clientIp(request))) {
      response.writeHead(429, { 'Retry-After': '60' }).end();
      return;
    }
    response.writeHead(401).end();
    return;
  }
  const profile = {
    name: body?.name,
    platform: body?.platform,
    browser: body?.browser,
  };
  if (access.clientId) {
    if (access.clientId !== clientId) {
      response.writeHead(401).end();
      return;
    }
    store.touchClient(access.deviceId, clientId, profile);
    response.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }).end(JSON.stringify({ clientId }));
    return;
  }
  const registered = store.registerClient(access.deviceId, clientId, profile);
  if (!registered) {
    response.writeHead(409).end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...pairingCookieHeaders(registered.token, request),
  }).end(JSON.stringify({ clientId, token: registered.token }));
}

/**
 * `POST /claim` + `GET /claim/<claimId>` — approval handoff for a container
 * that holds no credential yet.
 *
 * The relay routes and stores, it never authorizes: the desktop decides, and
 * the pairing material it returns is sealed to the browser's throwaway public
 * key, so this hop forwards a box it cannot open.
 */
async function handleClaimRequest(context, request, response) {
  const { store, liveDesktops, claims, unauthorizedLimiter } = context;
  const json = (status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      .end(JSON.stringify(body));
  };
  let url;
  let pathname;
  try {
    url = new URL(request.url || '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  for (const [id, pending] of claims) {
    if (pending.expiresAt <= Date.now()) claims.delete(id);
  }
  if (request.method === 'GET' && pathname.startsWith('/claim/')) {
    const claim = claims.get(pathname.slice('/claim/'.length));
    if (!claim) {
      json(200, { status: 'expired' });
      return;
    }
    if (claim.status !== 'approved') {
      json(200, { status: claim.status });
      return;
    }
    // One-shot: the credential leaves this relay exactly once.
    claims.delete(claim.id);
    json(200, {
      status: 'approved',
      clientId: claim.clientId,
      token: claim.token,
      sealed: claim.sealed,
    });
    return;
  }
  if (request.method !== 'POST' || pathname !== '/claim') {
    response.writeHead(405).end();
    return;
  }
  if (!browserSocketOriginAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  let body;
  try {
    body = await readBoundedJson(request);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const deviceId = String(body?.deviceId || '');
  const clientId = String(body?.clientId || '');
  const publicKey = String(body?.publicKey || '');
  if (!isRoutingId(deviceId)
    || !isRoutingId(clientId)
    || !/^[A-Za-z0-9_-]{86,88}$/.test(publicKey)
    || !store.isKnown(deviceId)) {
    if (!unauthorizedLimiter.allow(clientIp(request))) {
      response.writeHead(429, { 'Retry-After': '60' }).end();
      return;
    }
    response.writeHead(404).end();
    return;
  }
  const entry = liveDesktops.get(deviceId);
  if (!entry || entry.socket.readyState !== entry.socket.OPEN) {
    json(503, { status: 'offline' });
    return;
  }
  // Idempotent: a phone that reloads mid-approval (a backgrounded web app is
  // discarded freely) resumes the request the user is already looking at
  // instead of raising a second prompt on the desktop. A different key is a
  // different container and does get its own request.
  for (const [id, pending] of claims) {
    if (pending.status === 'pending'
      && pending.deviceId === deviceId
      && pending.clientId === clientId
      && pending.publicKey === publicKey) {
      json(202, { claimId: id });
      return;
    }
  }
  const source = clientIp(request);
  let deviceClaims = 0;
  let sourceClaims = 0;
  for (const pending of claims.values()) {
    if (pending.deviceId === deviceId) deviceClaims += 1;
    if (pending.source === source) sourceClaims += 1;
  }
  if (claims.size >= MAX_PENDING_CLAIMS
    || deviceClaims >= MAX_PENDING_CLAIMS_PER_DEVICE
    || sourceClaims >= MAX_PENDING_CLAIMS_PER_SOURCE) {
    json(503, { status: 'busy' });
    return;
  }
  const profile = clientProfile(body, 'Web app');
  const id = randomUUID();
  const expiresAt = Date.now() + CLAIM_TTL_MS;
  claims.set(id, {
    id,
    deviceId,
    clientId,
    publicKey,
    profile,
    source,
    status: 'pending',
    token: '',
    sealed: null,
    expiresAt,
  });
  try {
    entry.socket.send(JSON.stringify({
      type: 'client-claim',
      claimId: id,
      clientId,
      publicKey,
      expiresAt,
      ...profile,
    }));
  } catch {
    claims.delete(id);
    json(503, { status: 'offline' });
    return;
  }
  json(202, { claimId: id });
}

// The installed app's share sheet posts to its service worker, which answers
// on the device. A share that still reaches the relay means no worker was
// active yet: reopening the app beats failing the share outright, even though
// the payload itself is lost with the request this relay never stores.
const SHARE_TARGET_PATH = /^\/(?:d\/[^/]+\/)?share-target$/;

function shareTargetShell(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl || '/', 'http://localhost').pathname);
  } catch {
    return '';
  }
  return SHARE_TARGET_PATH.test(pathname) ? pathname.replace(/share-target$/, '') : '';
}

function serveStatic(rendererDir, store, unauthorizedLimiter, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const shell = request.method === 'POST' ? shareTargetShell(request.url) : '';
    if (shell) {
      response.writeHead(303, { Location: shell }).end();
      return;
    }
    response.writeHead(405).end();
    return;
  }
  let url;
  let pathname;
  try {
    url = new URL(request.url || '/', 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    return;
  }
  // Gate: an approved browser presents its per-browser token (Authorization,
  // or this cookie for plain asset requests). A container with no credential
  // yet may still reach the shell through its device route — that shell can
  // only show the install guide and ask the desktop for approval, and the
  // bundle behind it holds no user data. Bots probing GET / see 401.
  // Installability metadata is exempt: browsers fetch the manifest and its
  // icons WITHOUT credentials, and a 401 there silently downgrades "install
  // app" to an icon-less shortcut. These assets carry no user data.
  const route = parseDeviceRoute(pathname);
  const queryToken = url.searchParams.get('token') || '';
  const token = queryToken || parseCookieToken(request.headers.cookie);
  const tokenDevice = token ? store.deviceIdForClientToken(token) : null;
  // Only a credential this relay actually knows is persisted as the pairing
  // cookie. A public asset carrying `?token=<attacker value>` would otherwise
  // plant an HttpOnly cookie the visitor cannot see or clear, and every later
  // request would ride the attacker's session.
  const persistQueryToken = Boolean(queryToken) && Boolean(tokenDevice);
  const cookieDevice = parseCookieDevice(request.headers.cookie);
  const routeDevice = route?.deviceId || cookieDevice;
  const routeAllowed = Boolean(routeDevice) && store.isKnown(routeDevice);
  if (!PUBLIC_APP_ASSETS.has(pathname) && !routeAllowed && !tokenDevice) {
    // Bounded probing: a scanner hammering the gate gets throttled instead of
    // buying unlimited token guesses and log noise.
    if (!unauthorizedLimiter.allow(clientIp(request))) {
      response.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' })
        .end('Too many requests.');
      return;
    }
    response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Unauthorized.');
    return;
  }
  if (!rendererDir) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Mixdog relay: no RENDERER_DIR configured; this relay only forwards WebSocket traffic.');
    return;
  }
  if (route) {
    if (route.redirect) {
      response.writeHead(301, { Location: `/d/${route.deviceId}/` }).end();
      return;
    }
    // The install captures start_url, so the manifest under a device route
    // must point back at that same route.
    if (route.rest === '/manifest.webmanifest') {
      const manifest = resolveStaticTarget(rendererDir, route.rest);
      if (manifest.status === 200
        && sendDeviceManifest(request, response, manifest.target, route.deviceId)) return;
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
      return;
    }
    const scoped = resolveStaticTarget(rendererDir, route.rest);
    if (scoped.status !== 200) {
      response.writeHead(scoped.status === 403 ? 403 : 404).end();
      return;
    }
    sendStaticFile(request, response, scoped.target, deviceCookieHeaders(route.deviceId, request));
    return;
  }
  const resolved = resolveStaticTarget(rendererDir, pathname);
  if (resolved.status === 403) {
    response.writeHead(403).end();
    return;
  }
  if (resolved.status === 404) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
    return;
  }
  sendStaticFile(request, response, resolved.target, mergeCookieHeaders(
    persistQueryToken ? pairingCookieHeaders(queryToken, request) : {},
    // A root asset request proves the container still belongs to this route;
    // refreshing the cookie keeps a long-lived install from aging out of it.
    routeAllowed && !route ? deviceCookieHeaders(routeDevice, request) : {},
  ));
}

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
  const phoneConnectLimiter = new RateLimiter(
    MAX_PHONE_CONNECTIONS_PER_MINUTE,
    PHONE_CONNECT_RATE_WINDOW_MS,
  );
  // An async handler settles outside the synchronous guard below, so it gets
  // its own terminator: no unhandled rejection, and the caller still answers.
  const failRequest = (request, response, label) => (error) => {
    console.error(`[relay] ${label} failed:`, error?.message || error);
    try {
      if (response.headersSent) response.end();
      else {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Internal error.');
      }
    } catch {
      try { request.destroy(); } catch { /* already gone */ }
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
      response.writeHead(ready.statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      }).end(request.method === 'HEAD' ? undefined : JSON.stringify(ready.body));
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
      handleClientRegistration(store, unauthorizedLimiter, request, response)
        .catch(failRequest(request, response, 'client registration'));
      return;
    }
    // Approval handoff: the only surface a credential-less container may use,
    // and it grants nothing without the desktop's answer.
    if ((request.url || '').startsWith('/claim')) {
      handleClaimRequest(
        { store, liveDesktops, claims, unauthorizedLimiter },
        request,
        response,
      ).catch(failRequest(request, response, 'claim request'));
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
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end('Internal error.');
      } catch {
        try { request.destroy(); } catch { /* already gone */ }
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
  const server = tlsCert && tlsKey
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
      try { socket.send(JSON.stringify(payload)); } catch { /* peer vanished */ }
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
      try { previous.socket.close(4000, 'superseded'); } catch { /* already gone */ }
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
      wss.handleUpgrade(request, rawSocket, head, (socket) => runDesktopLeg(
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
        socket,
      ));
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
          try { socket.close(4005, 'pairing rescan required'); } catch { /* already gone */ }
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
      wss.handleUpgrade(request, rawSocket, head, (socket) => runClientLeg(
        entry,
        sendJson,
        socket,
        access.clientId,
        {
          maxFrameBytes,
          inflightCeiling: maxInflightBytes,
          ingress: legIngress,
          rawSocket,
        },
      ));
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
      wss.handleUpgrade(request, rawSocket, head, (socket) => runHookLeg(
        liveHooks,
        deviceId,
        socket,
        { ingress: legIngress, rawSocket },
      ));
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
      try { rawSocket.destroy(); } catch { /* already gone */ }
    }
  });

  return finishRelayStart({ server, wss, store, liveDesktops, liveHooks, port, sendJson });
}

async function finishRelayStart({ server, wss, store, liveDesktops, liveHooks, port, sendJson }) {
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
        try { ws.close(4008, 'slow producer'); } catch { /* already gone */ }
        continue;
      }
      // A leg parked for ingress admission is not being READ, so it cannot
      // answer a ping: sweeping it would turn backpressure into a disconnect.
      // Its wait is what is bounded instead.
      if (ingress?.waiting) {
        if (Date.now() - ingress.waitingSince > INGRESS_WAIT_TIMEOUT_MS) {
          releaseIngressLeg(ws);
          try { ws.close(4009, 'relay busy'); } catch { /* already gone */ }
        }
        continue;
      }
      if (ws.isAlive === false) {
        // A terminate reaches the peer as a bare 1006 that names nobody, so the
        // sweep says here that IT was the one that cut a silent leg.
        console.log('[relay] sweep terminated a leg that missed its ping window');
        try { ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* surfaced as close */ }
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
      try { entry.socket.terminate(); } catch { /* already gone */ }
      for (const phone of entry.clients.values()) {
        try { phone.terminate(); } catch { /* already gone */ }
      }
    }
    liveDesktops.clear();
    for (const entry of liveHooks.values()) {
      failHookPending(entry);
      try { entry.socket.terminate(); } catch { /* already gone */ }
    }
    liveHooks.clear();
    // Flush any debounced device registration before the process goes away.
    store.saveOrLog();
    await new Promise((resolveClose) => wss.close(() => resolveClose()));
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  };
  return { port: boundPort, store, close };
}

const invokedDirectly = Boolean(process.argv[1])
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const port = Number(process.env.PORT || 9800);
  const dataDir = process.env.DATA_DIR || './data';
  const rendererDir = process.env.RENDERER_DIR || '';
  const tlsCert = process.env.TLS_CERT || '';
  const tlsKey = process.env.TLS_KEY || '';
  startRelay({ port, dataDir, rendererDir, tlsCert, tlsKey }).then((relay) => {
    const scheme = tlsCert && tlsKey ? 'https' : 'http';
    console.log(`[relay] ${scheme} listening on :${relay.port} (renderer: ${rendererDir || 'none'})`);
  }).catch((error) => {
    console.error('[relay] failed to start:', error.message);
    process.exit(1);
  });
}

function runDesktopLeg(context, deviceId, socket) {
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
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => { /* surfaced as close */ });
  // The wire form has to travel with the refusal: a binary frame is read by the
  // binary decoder that routes it, a text frame by JSON.parse. Dropping it here
  // sent binary bytes through the JSON reader, which fails and names nobody.
  socket.oversizeSignal = (bytes, limit, raw, binary) => (
    signalDesktopOversize(socket, bytes, limit, raw, binary)
  );
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
  socket.on('message', guarded('desktop frame', (raw, isBinary) => {
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
    try { message = JSON.parse(raw.toString()); } catch { return; }
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
        try { phone.close(4003, 'pairing revoked'); } catch { /* already gone */ }
      }
      const finish = () => {
        try { socket.close(4003, 'device revoked'); } catch { /* already gone */ }
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
      const online = new Set(
        [...entry.clients.values()].map((phone) => phone.browserClientId).filter(Boolean),
      );
      sendJson(socket, {
        type: 'clients-list',
        requestId: message.requestId,
        clients: store.listClients(deviceId, online),
      });
      return;
    }
    if (message.type === 'revoke-client'
      && typeof message.requestId === 'string'
      && typeof message.clientId === 'string') {
      const removed = store.revokeClient(deviceId, message.clientId);
      // Only a credential that is actually gone closes its browser: a failed
      // persist leaves the pairing valid, and closing it as revoked would tell
      // the user something the store did not do.
      if (removed) {
        for (const phone of entry.clients.values()) {
          if (phone.browserClientId !== message.clientId) continue;
          try { phone.close(4003, 'pairing revoked'); } catch { /* already gone */ }
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
        try { phone.close(4004, reason); } catch { /* already gone */ }
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
  }));
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
          try { phone.close(4002, 'desktop offline'); } catch { /* already gone */ }
        }
        liveDesktops.delete(deviceId);
      }, 45_000);
      entry.offlineTimer.unref?.();
    }
  });
}

function runClientLeg(entry, sendJson, socket, browserClientId = null, options = {}) {
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
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => { /* surfaced as close */ });
  socket.on('message', guarded('phone frame', (raw, isBinary) => {
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
      try { socket.send('{"pong":1}'); } catch { /* surfaced as close */ }
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
  }));
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
    console.log(`[relay] phone leg closed client=${clientId.slice(0, 8)}`
      + ` code=${code} reason=${String(reason || '').slice(0, 60)}`
      + ` lived=${Date.now() - legOpenedAt}ms`);
  });
}
