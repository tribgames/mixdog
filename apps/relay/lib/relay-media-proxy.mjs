// Media travels as a proxied byte stream over the desktop leg: the phone gets
// a cacheable, range-able HTTP response instead of a base64 RPC answer, and
// the relay only has to forward frames. The timeout covers the FIRST frame;
// a long clip then streams for as long as the desktop keeps sending.
import { randomUUID } from 'node:crypto';

import { parseMediaRequest } from './media-http.mjs';
import { desktopLegOpen, endText, rejectUnauthorizedText, upstreamStatus } from './relay-http.mjs';
import { parseCookieToken } from './static-http.mjs';

// A desktop that goes quiet mid-clip must not pin an open response forever:
// the phone retries the range instead of watching a socket that never ends.
const MEDIA_HEAD_TIMEOUT_MS = 30_000;
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
export function handleMediaRequest(store, liveDesktops, unauthorizedLimiter, request, response) {
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
    endText(response, 400, 'Bad request.');
    return;
  }
  const token = url.searchParams.get('token') || parseCookieToken(request.headers.cookie);
  const deviceId = token ? store.deviceIdForClientToken(token) : null;
  if (!deviceId) {
    rejectUnauthorizedText(unauthorizedLimiter, request, response);
    return;
  }
  const entry = liveDesktops.get(deviceId);
  const online = desktopLegOpen(entry);
  if (pathname === '/media/healthz') {
    answerMediaHealth(response, online && Boolean(entry.mediaLane));
    return;
  }
  const target = parseMediaRequest(pathname, url.searchParams);
  if (!target) {
    endText(response, 404, 'Not found.');
    return;
  }
  const refusal = mediaRefusal(entry, online);
  if (refusal) {
    endText(response, 503, refusal.text, refusal.headers);
    return;
  }
  openMediaStream(entry, target, request, response);
}

// Feature probe, answered for the DESKTOP that would produce the bytes.
// The relay serves ONE web bundle to every phone while installs update on
// their own schedule, so this relay is routinely newer than the desktop it
// is paired with. Reporting the desktop's lane keeps that skew a plain
// answer instead of something the phone has to infer from a stall.
function answerMediaHealth(response, supported) {
  if (!supported) {
    response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"status":"unsupported"}');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
}

/** Why the desktop cannot take one more stream right now (all 503), or null. */
function mediaRefusal(entry, online) {
  if (!online) return { text: 'Desktop offline.' };
  // An older desktop leg drops unknown frames on the floor, so asking it for
  // media would buy nothing but a first-frame timeout on every tile. One
  // capability bit from the leg turns that into an instant downgrade to the
  // RPC payload.
  if (!entry.mediaLane) return { text: 'Desktop media lane unsupported.' };
  if (entry.media.size >= MAX_MEDIA_STREAMS) {
    return { text: 'Too many media streams.', headers: { 'Retry-After': '1' } };
  }
  return null;
}

// Registers the pending stream and asks the desktop for the bytes.
function openMediaStream(entry, target, request, response) {
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
    entry.socket.send(
      JSON.stringify({
        type: 'media-request',
        id,
        assetId: target.assetId,
        variant: target.variant,
        method: request.method,
        range: String(request.headers.range || ''),
        ifNoneMatch: String(request.headers['if-none-match'] || ''),
      })
    );
  } catch {
    clearTimeout(pending.timer);
    if (entry.media.delete(id)) {
      try {
        response.writeHead(502).end();
      } catch {
        /* client vanished */
      }
    }
  }
}

/** Tell the desktop to stop reading for a request this relay gave up on. */
function abortMediaUpstream(entry, id) {
  if (entry.socket.readyState !== entry.socket.OPEN) return;
  try {
    entry.socket.send(JSON.stringify({ type: 'media-abort', id }));
  } catch {
    /* gone */
  }
}

/** (Re)arm the expiry for one proxied stream; every frame pushes it out. */
function armMediaTimer(entry, id, pending, ms) {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(() => {
    if (!entry.media.delete(id)) return;
    try {
      if (!pending.head) pending.response.writeHead(504);
      pending.response.end();
    } catch {
      /* client vanished */
    }
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
  const source = supplied && typeof supplied === 'object' && !Array.isArray(supplied) ? supplied : {};
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
export function forwardMediaFrame(entry, message) {
  const id = String(message.id || '');
  const pending = entry.media.get(id);
  if (!pending) return;
  if (message.type === 'media-head') {
    applyMediaHead(entry, id, pending, message);
    return;
  }
  if (message.type === 'media-chunk' && typeof message.data === 'string') {
    if (pending.head) applyMediaChunk(entry, id, pending, message.data);
    return;
  }
  if (message.type === 'media-end' || message.type === 'media-error') finishMediaStream(entry, id, pending);
}

function applyMediaHead(entry, id, pending, message) {
  pending.head = true;
  armMediaTimer(entry, id, pending, MEDIA_STALL_TIMEOUT_MS);
  try {
    pending.response.writeHead(upstreamStatus(message.status), mediaResponseHeaders(message.headers));
  } catch {
    /* client vanished */
  }
}

// Writes the chunk, then applies byte-lane flow control: pause the producer
// once the response buffer fills, cut the stream once it stops draining.
function applyMediaChunk(entry, id, pending, data) {
  armMediaTimer(entry, id, pending, MEDIA_STALL_TIMEOUT_MS);
  try {
    pending.response.write(Buffer.from(data, 'base64'));
  } catch {
    /* client vanished */
  }
  const buffered = pending.response.writableLength || 0;
  if (buffered > MEDIA_KILL_BUFFER_BYTES) {
    cutMediaStream(entry, id, pending);
    return;
  }
  if (!pending.paused && buffered > MEDIA_PAUSE_BUFFER_BYTES) pauseMediaProducer(entry, id, pending);
}

function cutMediaStream(entry, id, pending) {
  entry.media.delete(id);
  clearTimeout(pending.timer);
  try {
    pending.response.destroy();
  } catch {
    /* already gone */
  }
  abortMediaUpstream(entry, id);
}

function pauseMediaProducer(entry, id, pending) {
  pending.paused = true;
  try {
    entry.socket.send(JSON.stringify({ type: 'media-pause', id }));
  } catch {
    /* gone */
  }
  pending.response.once('drain', () => {
    pending.paused = false;
    if (entry.media.get(id) !== pending) return;
    try {
      entry.socket.send(JSON.stringify({ type: 'media-resume', id }));
    } catch {
      /* gone */
    }
  });
}

function finishMediaStream(entry, id, pending) {
  entry.media.delete(id);
  clearTimeout(pending.timer);
  try {
    if (!pending.head) pending.response.writeHead(502);
    pending.response.end();
  } catch {
    /* client vanished */
  }
}

/** A desktop that vanished mid-stream leaves half-written responses; close
 *  them so the phone retries instead of hanging on an open socket. */
export function failMediaPending(entry) {
  for (const [, pending] of entry.media) {
    clearTimeout(pending.timer);
    try {
      if (!pending.head) pending.response.writeHead(503);
      pending.response.end();
    } catch {
      /* client vanished */
    }
  }
  entry.media.clear();
}
