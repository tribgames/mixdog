#!/usr/bin/env node
// Mixdog remote relay for the installable web app.
//
// Topology: the desktop keeps ONE outbound WebSocket to this relay (so no
// port-forwarding/NAT work on the user side), phones connect here with the
// pairing token, and the relay forwards frames between them verbatim. The
// phone-side wire protocol is IDENTICAL to the desktop's LAN bridge
// (apps/desktop/src/main/remote-bridge.ts), so the renderer's remote shim
// works unchanged whether it talks to the LAN bridge or to this relay.
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
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { WebSocketServer } from 'ws';

import {
  pairingCookieHeaders,
  parseCookieToken,
  resolveStaticTarget,
  sendStaticFile,
} from './lib/static-http.mjs';
import { parseMediaRequest } from './lib/media-http.mjs';

const MAX_WS_PAYLOAD_BYTES = 64 * 1024 * 1024;
// Slow-consumer guards: a phone that stops draining would otherwise buffer
// the whole push stream in relay memory (1GB box, thousands of legs). Pushes
// are recoverable (state resync + terminal repaint) so they drop first; the
// hard limit only cuts a leg that stopped draining entirely.
const SKIP_PUSH_BUFFER_BYTES = 1024 * 1024;
const KILL_BUFFER_BYTES = MAX_WS_PAYLOAD_BYTES;

function sendToPhone(phone, data, droppable) {
  if (phone.readyState !== phone.OPEN) return;
  if (phone.bufferedAmount > KILL_BUFFER_BYTES) {
    try { phone.close(4008, 'slow consumer'); } catch { /* already gone */ }
    return;
  }
  if (droppable && phone.bufferedAmount > SKIP_PUSH_BUFFER_BYTES) {
    // This leg just lost a state push. Waiting for the NEXT patch to expose
    // the gap strands it whenever the turn ends here — the phone would keep
    // showing a transcript without the answer that landed while it was
    // congested. One hint (sent once per congestion window) makes it ask for
    // a full snapshot as soon as it drains.
    if (!phone.resyncHinted) {
      phone.resyncHinted = true;
      try { phone.send('{"resync":1}'); } catch { /* phone vanished */ }
    }
    return;
  }
  phone.resyncHinted = false;
  try { phone.send(data); } catch { /* phone vanished */ }
}

// Public webhook forwarding (replaces per-user ngrok tunnels): the channel
// worker keeps one outbound `/hookleg` WebSocket and the relay replays
// inbound `/hook/<deviceId>/...` HTTP requests over it as JSON frames.
// Payloads pass through un-inspected; HMAC verification stays on the agent.
const MAX_HOOK_BODY_BYTES = 1024 * 1024;
const HOOK_TIMEOUT_MS = 30_000;
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
const MAX_REGISTERED_DEVICES = 5000;
export const MAX_RATE_KEYS = 10_000;

export class RateLimiter {
  constructor(limit, windowMs, maxKeys = MAX_RATE_KEYS) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = Math.max(1, Number(maxKeys) || MAX_RATE_KEYS);
    this.hits = new Map();
  }

  allow(key) {
    const id = String(key || 'unknown');
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const prior = this.hits.get(id);
    if (prior) this.hits.delete(id);
    if (!prior && this.hits.size >= this.maxKeys) {
      for (const [existing, stamps] of this.hits) {
        const live = stamps.filter((stamp) => stamp > cutoff);
        if (live.length) this.hits.set(existing, live);
        else this.hits.delete(existing);
      }
      // An attacker can keep every key live. Enforce the cap after the expiry
      // sweep as an LRU: bounded memory outranks retaining an old bucket.
      while (this.hits.size >= this.maxKeys) {
        const oldest = this.hits.keys().next().value;
        if (oldest === undefined) break;
        this.hits.delete(oldest);
      }
    }
    const stamps = (prior || []).filter((stamp) => stamp > cutoff);
    if (stamps.length >= this.limit) {
      this.hits.set(id, stamps);
      return false;
    }
    stamps.push(now);
    this.hits.set(id, stamps);
    return true;
  }
}

function clientIp(request) {
  return request.socket?.remoteAddress || 'unknown';
}

// Hop-by-hop / transport headers stay on this hop; signature headers and the
// rest forward verbatim so local HMAC verification sees the sender's bytes.
const HOOK_DROP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'te',
]);

function handleHookRequest(liveHooks, hookLimiter, request, response) {
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
  if (!hookLimiter.allow(match[1])) {
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
  const chunks = [];
  let total = 0;
  let aborted = false;
  request.on('data', (chunk) => {
    if (aborted) return;
    total += chunk.length;
    if (total > MAX_HOOK_BODY_BYTES) {
      aborted = true;
      try {
        response.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"payload too large"}');
      } catch { /* client vanished */ }
      try { request.destroy(); } catch { /* already gone */ }
      return;
    }
    chunks.push(chunk);
  });
  request.on('error', () => { aborted = true; });
  request.on('end', () => {
    if (aborted) return;
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

function runHookLeg(liveHooks, deviceId, socket) {
  const previous = liveHooks.get(deviceId);
  if (previous) {
    try { previous.socket.close(4000, 'superseded'); } catch { /* already gone */ }
    failHookPending(previous);
  }
  const entry = { socket, pending: new Map() };
  liveHooks.set(deviceId, entry);
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => { /* surfaced as close */ });
  socket.on('message', (raw) => {
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
    try { body = frame.body ? Buffer.from(String(frame.body), 'base64') : Buffer.alloc(0); }
    catch { body = Buffer.alloc(0); }
    const contentType = typeof frame.headers?.['content-type'] === 'string'
      ? frame.headers['content-type'] : 'application/json';
    try {
      pending.response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
      pending.response.end(body);
    } catch { /* client vanished */ }
  });
  socket.on('close', () => {
    if (liveHooks.get(deviceId)?.socket !== socket) return;
    failHookPending(entry);
    liveHooks.delete(deviceId);
  });
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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
  const pathname = decodeURIComponent(url.pathname);
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
    const headers = message.headers && typeof message.headers === 'object' ? message.headers : {};
    try { pending.response.writeHead(status, headers); } catch { /* client vanished */ }
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

function hashesMatch(expectedHex, candidate) {
  if (!expectedHex || !candidate) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = createHash('sha256').update(String(candidate)).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

class DeviceStore {
  constructor(dataDir) {
    this.path = join(dataDir, 'devices.json');
    this.devices = new Map();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      for (const [id, row] of Object.entries(parsed)) this.devices.set(id, row);
    } catch { /* first run */ }
    // sha256(token) hex -> deviceId. Phone auth is on the hot path of every
    // /ws upgrade and static GET; a linear scan over all devices would decay
    // with fleet size. Indexing by digest keeps lookup O(1) and leaks nothing
    // useful: matching a key requires the token preimage.
    this.tokenIndex = new Map();
    for (const [id, row] of this.devices) {
      if (row.clientTokenHash) this.tokenIndex.set(row.clientTokenHash, id);
    }
    this.saveTimer = null;
  }

  save() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const plain = Object.fromEntries(this.devices);
    try {
      mkdirSync(resolve(this.path, '..'), { recursive: true });
      // Secret/token digests: owner-only, never group/world readable.
      writeFileSync(this.path, JSON.stringify(plain, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      console.error('[relay] failed to persist device store:', error.message);
    }
  }

  // A relay restart makes the whole fleet redial at once; coalescing the
  // (synchronous) devices.json rewrites keeps that stampede off the event
  // loop. Registration is still durable within a beat, and close() flushes.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, 250);
    this.saveTimer.unref?.();
  }

  isKnown(deviceId) {
    return this.devices.has(deviceId);
  }

  // Trust-on-first-use registration is what makes setup zero-config, but an
  // unauthenticated caller could otherwise mint device rows forever. The
  // caller rate-limits new ids per IP; the fleet cap is the hard backstop.
  authenticate(deviceId, secret) {
    const known = this.devices.get(deviceId);
    if (!known) {
      if (this.devices.size >= MAX_REGISTERED_DEVICES) return false;
      this.devices.set(deviceId, { secretHash: sha256(secret), clientTokenHash: '' });
      this.scheduleSave();
      return true;
    }
    return hashesMatch(known.secretHash, secret);
  }

  setClientToken(deviceId, token) {
    const known = this.devices.get(deviceId);
    if (!known) return;
    const hash = sha256(token);
    // Every desktop reconnect re-announces its (unchanged) pairing token;
    // rewriting the store for that would turn restarts into a write storm.
    if (known.clientTokenHash === hash) return;
    if (known.clientTokenHash) this.tokenIndex.delete(known.clientTokenHash);
    known.clientTokenHash = hash;
    this.tokenIndex.set(known.clientTokenHash, deviceId);
    this.scheduleSave();
  }

  revoke(deviceId) {
    const known = this.devices.get(deviceId);
    if (!known) return false;
    if (known.clientTokenHash) this.tokenIndex.delete(known.clientTokenHash);
    this.devices.delete(deviceId);
    // The acknowledgement is the durability boundary for Unpair: persist
    // synchronously before telling the desktop that the registration is gone.
    this.save();
    return true;
  }

  deviceIdForClientToken(token) {
    if (!token) return null;
    return this.tokenIndex.get(sha256(token)) ?? null;
  }
}

function serveStatic(rendererDir, store, unauthorizedLimiter, request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
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
  // Token gate: the web app is for paired browsers only. The pairing QR
  // carries ?token= on the entry URL; a cookie forwards it to asset requests.
  // Bots probing GET / see 401, never the app shell.
  const queryToken = url.searchParams.get('token') || '';
  const token = queryToken || parseCookieToken(request.headers.cookie);
  if (!token || !store.deviceIdForClientToken(token)) {
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
  const resolved = resolveStaticTarget(rendererDir, pathname);
  if (resolved.status === 403) {
    response.writeHead(403).end();
    return;
  }
  if (resolved.status === 404) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found.');
    return;
  }
  sendStaticFile(request, response, resolved.target, pairingCookieHeaders(queryToken, request));
}

export async function startRelay({
  port = 9800,
  dataDir = './data',
  rendererDir = '',
  // TLS termination stays in-process (no reverse proxy in the data path):
  // point these at fullchain.pem / privkey.pem to serve https+wss directly.
  tlsCert = '',
  tlsKey = '',
} = {}) {
  const store = new DeviceStore(resolve(dataDir));
  // deviceId -> { socket, clients: Map<clientId, phoneSocket> }
  const liveDesktops = new Map();
  // hook deviceId -> { socket, pending: Map<requestId, {response, timer}> }
  const liveHooks = new Map();
  // Abuse guards for the unauthenticated surfaces: public webhook ingress,
  // trust-on-first-use device registration, and pairing-token probing.
  const hookLimiter = new RateLimiter(HOOK_RATE_LIMIT, HOOK_RATE_WINDOW_MS);
  const registerLimiter = new RateLimiter(REGISTER_RATE_LIMIT, REGISTER_RATE_WINDOW_MS);
  const unauthorizedLimiter = new RateLimiter(UNAUTHORIZED_RATE_LIMIT, UNAUTHORIZED_RATE_WINDOW_MS);
  const handler = (request, response) => {
    // Public webhook ingress bypasses the pairing-token gate: callers are
    // external services (GitHub, Stripe); authentication is the per-endpoint
    // HMAC signature verified on the agent side.
    if ((request.url || '').startsWith('/hook/')) {
      handleHookRequest(liveHooks, hookLimiter, request, response);
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
  const server = tlsCert && tlsKey
    ? createTlsServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, handler)
    : createServer(handler);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    // Relayed transcript pushes are repetitive text: deflate cuts them 5-10x.
    // No-context-takeover releases each zlib context between messages so
    // thousands of mostly idle sockets do not pin ~300KB of window each.
    perMessageDeflate: {
      threshold: 1024,
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 6, memLevel: 6 },
      concurrencyLimit: 8,
    },
  });

  const sendJson = (socket, payload) => {
    if (socket && socket.readyState === socket.OPEN) {
      try { socket.send(JSON.stringify(payload)); } catch { /* peer vanished */ }
    }
  };

  const attachDesktop = (deviceId, socket) => {
    const previous = liveDesktops.get(deviceId);
    if (previous) {
      try { previous.socket.close(4000, 'superseded'); } catch { /* already gone */ }
      failMediaPending(previous);
      for (const phone of previous.clients.values()) {
        try { phone.close(4001, 'desktop reconnected'); } catch { /* already gone */ }
      }
    }
    // `mediaLane` starts false on purpose: an older desktop never announces
    // it, and the media route must degrade on the FIRST request instead of
    // waiting out a first-frame timeout per tile.
    const entry = { socket, clients: new Map(), media: new Map(), mediaLane: false };
    liveDesktops.set(deviceId, entry);
    return entry;
  };

  server.on('upgrade', (request, rawSocket, head) => {
    let url;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      rawSocket.destroy();
      return;
    }
    const reject = () => {
      rawSocket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      rawSocket.destroy();
    };
    // Trust-on-first-use keeps setup zero-config, but only a bounded number of
    // NEW ids may be minted per source; a known device re-dialing is free.
    const registrationAllowed = (deviceId) =>
      store.isKnown(deviceId) || registerLimiter.allow(clientIp(request));
    if (url.pathname === '/desktop') {
      const deviceId = url.searchParams.get('device') || '';
      const secret = url.searchParams.get('secret') || '';
      if (!/^[0-9a-f-]{8,64}$/.test(deviceId) || secret.length < 16
        || !registrationAllowed(deviceId) || !store.authenticate(deviceId, secret)) {
        reject();
        return;
      }
      wss.handleUpgrade(request, rawSocket, head, (socket) =>
        runDesktopLeg({ store, sendJson, attachDesktop, liveDesktops }, deviceId, socket));
      return;
    }
    if (url.pathname === '/ws') {
      const token = url.searchParams.get('token') || '';
      const deviceId = store.deviceIdForClientToken(token);
      const entry = deviceId ? liveDesktops.get(deviceId) : null;
      if (!entry || entry.socket.readyState !== entry.socket.OPEN) {
        reject();
        return;
      }
      wss.handleUpgrade(request, rawSocket, head, (socket) => runClientLeg(entry, sendJson, socket));
      return;
    }
    if (url.pathname === '/hookleg') {
      // Channel-worker webhook tunnel: same trust-on-first-use device model
      // as the desktop leg (worker mints its own id/secret pair).
      const deviceId = url.searchParams.get('device') || '';
      const secret = url.searchParams.get('secret') || '';
      if (!/^[0-9a-f-]{8,64}$/.test(deviceId) || secret.length < 16
        || !registrationAllowed(deviceId) || !store.authenticate(deviceId, secret)) {
        reject();
        return;
      }
      wss.handleUpgrade(request, rawSocket, head, (socket) => runHookLeg(liveHooks, deviceId, socket));
      return;
    }
    rawSocket.destroy();
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
  // NAT/middleboxes drop idle WebSockets silently; sweep every 25s so dead
  // desktop legs release their registration (phones otherwise blackhole)
  // and dead phone legs stop holding broadcast fan-out slots.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch { /* already gone */ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* surfaced as close */ }
    }
  }, 25_000);
  heartbeat.unref?.();
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const entry of liveDesktops.values()) {
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
    store.save();
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
  const { store, sendJson, attachDesktop, liveDesktops } = context;
  const entry = attachDesktop(deviceId, socket);
  let revoked = false;
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => { /* surfaced as close */ });
  socket.on('message', (raw) => {
    if (revoked) return;
    socket.isAlive = true;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === 'revoke-device') {
      revoked = true;
      const removed = store.revoke(deviceId);
      for (const phone of entry.clients.values()) {
        try { phone.close(4003, 'pairing revoked'); } catch { /* already gone */ }
      }
      const finish = () => {
        try { socket.close(4003, 'device revoked'); } catch { /* already gone */ }
      };
      try {
        socket.send(JSON.stringify({ type: 'device-revoked', ok: removed }), finish);
      } catch {
        finish();
      }
      return;
    }
    if (message.type === 'set-client-token' && typeof message.token === 'string' && message.token.length >= 16) {
      store.setClientToken(deviceId, message.token);
      return;
    }
    // Capability announcement, sent before the leg does anything else. It is
    // ONE bit per lane, not a version number: the relay never branches on a
    // desktop version, it only answers "this host serves media" or not.
    if (message.type === 'desktop-lanes') {
      entry.mediaLane = message.media === true;
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
      for (const phone of entry.clients.values()) {
        sendToPhone(phone, message.data, droppable);
      }
    }
  });
  socket.on('close', () => {
    if (liveDesktops.get(deviceId)?.socket === socket) {
      failMediaPending(entry);
      for (const phone of entry.clients.values()) {
        try { phone.close(4002, 'desktop offline'); } catch { /* already gone */ }
      }
      liveDesktops.delete(deviceId);
    }
  });
}

function runClientLeg(entry, sendJson, socket) {
  const clientId = randomUUID();
  entry.clients.set(clientId, socket);
  sendJson(entry.socket, { type: 'client-open', clientId });
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });
  socket.on('error', () => { /* surfaced as close */ });
  socket.on('message', (raw) => {
    socket.isAlive = true;
    const text = raw.toString();
    // Phone liveness probe: answered at the relay — reaching this hop is the
    // question being asked (a dead desktop closes this leg outright).
    if (text.startsWith('{"ping"')) {
      try { socket.send('{"pong":1}'); } catch { /* surfaced as close */ }
      return;
    }
    sendJson(entry.socket, { type: 'frame', clientId, data: text });
  });
  socket.on('close', () => {
    entry.clients.delete(clientId);
    sendJson(entry.socket, { type: 'client-close', clientId });
  });
}
