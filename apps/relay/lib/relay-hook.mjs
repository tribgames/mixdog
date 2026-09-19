// Public webhook forwarding (replaces per-user ngrok tunnels): the channel
// worker keeps one outbound `/hookleg` WebSocket and the relay replays
// inbound `/hook/<deviceId>/...` HTTP requests over it as JSON frames.
// Payloads pass through un-inspected; HMAC verification stays on the agent.
import { randomUUID } from 'node:crypto';

import { clientIp, desktopLegOpen, upstreamStatus } from './relay-http.mjs';
import { guarded, noteIngressDelivery, releaseIngressLeg, trackLegIngress } from './relay-transport.mjs';

const MAX_HOOK_BODY_BYTES = 1024 * 1024;
export const MAX_HOOK_RESPONSE_BODY_BYTES = MAX_HOOK_BODY_BYTES;
const HOOK_TIMEOUT_MS = 30_000;
// The webhook lane is public, so bound both what one agent leg may hold open
// and what the relay will buffer toward it: without a cap a burst parks
// (pending responses × body) plus an unbounded socket backlog in memory.
export const MAX_HOOK_PENDING_PER_DEVICE = 64;
const HOOK_SOCKET_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;

// Hop-by-hop / transport headers stay on this hop; signature headers and the
// rest forward verbatim so local HMAC verification sees the sender's bytes.
const HOOK_DROP_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'upgrade',
  'te',
]);

function destroyRequest(request) {
  try {
    request.destroy();
  } catch {
    /* already gone */
  }
}

// Route, rate limit and agent admission for one inbound webhook. Answers the
// caller itself on refusal and returns null; otherwise the leg entry plus the
// parsed route.
function admitHookRequest(liveHooks, hookLimiter, maxPending, request, response) {
  let url;
  try {
    url = new URL(request.url || '/', 'http://localhost');
  } catch {
    response.writeHead(400).end();
    return null;
  }
  const match = url.pathname.match(/^\/hook\/([0-9a-f-]{8,64})(\/.*)?$/);
  if (!match) {
    response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}');
    return null;
  }
  // Device-keyed alone lets one source spread a burst across ids; the caller
  // bucket is what bounds the total an unauthenticated peer can push in.
  if (!hookLimiter.allow(`device:${match[1]}`) || !hookLimiter.allow(`ip:${clientIp(request)}`)) {
    response
      .writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' })
      .end('{"error":"rate limited"}');
    destroyRequest(request);
    return null;
  }
  const entry = liveHooks.get(match[1]);
  if (!desktopLegOpen(entry)) {
    response.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"agent offline"}');
    return null;
  }
  // An agent that is not keeping up must not turn into relay memory: refuse
  // before the body is read rather than queue another megabyte behind it.
  // Bodies still streaming in count too — measuring only `pending` lets any
  // number of slow uploads arrive together and pass the cap before the first
  // one lands.
  if (
    entry.pending.size + (entry.inflight || 0) >= maxPending ||
    entry.socket.bufferedAmount > HOOK_SOCKET_BUFFER_LIMIT_BYTES
  ) {
    response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' }).end('{"error":"agent busy"}');
    destroyRequest(request);
    return null;
  }
  return { entry, url, match };
}

// Buffers the body up to MAX_HOOK_BODY_BYTES. The in-flight reservation is
// released on every exit — oversize, error, hang-up, or the completed body.
function readHookBody(request, response, releaseSlot, onBody) {
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
      } catch {
        /* client vanished */
      }
      destroyRequest(request);
      return;
    }
    chunks.push(chunk);
  });
  request.on('error', () => {
    aborted = true;
    releaseSlot();
  });
  // A caller that hangs up mid-body must give its reservation back.
  request.on('close', releaseSlot);
  request.on('end', () => {
    if (aborted) return;
    // The reservation becomes a `pending` entry: release it in the same turn so
    // the two counters never double-count the same request.
    releaseSlot();
    onBody(chunks);
  });
}

// Replays the buffered request over the agent leg and parks the response
// until the agent answers or the timeout fires.
function forwardHookRequest(entry, request, response, url, match, chunks) {
  const id = randomUUID();
  const headers = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (!HOOK_DROP_HEADERS.has(key)) headers[key] = value;
  }
  const timer = setTimeout(() => {
    if (entry.pending.delete(id)) {
      try {
        response.writeHead(504, { 'Content-Type': 'application/json' }).end('{"error":"agent timeout"}');
      } catch {
        /* client vanished */
      }
    }
  }, HOOK_TIMEOUT_MS);
  timer.unref?.();
  entry.pending.set(id, { response, timer });
  try {
    entry.socket.send(
      JSON.stringify({
        type: 'http',
        id,
        method: request.method,
        path: (match[2] || '/') + url.search,
        headers,
        body: chunks.length ? Buffer.concat(chunks).toString('base64') : '',
      })
    );
  } catch {
    clearTimeout(timer);
    if (entry.pending.delete(id)) {
      try {
        response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"agent unreachable"}');
      } catch {
        /* client vanished */
      }
    }
  }
}

export function handleHookRequest(liveHooks, hookLimiter, maxPending, request, response) {
  const admitted = admitHookRequest(liveHooks, hookLimiter, maxPending, request, response);
  if (!admitted) return;
  const { entry, url, match } = admitted;
  entry.inflight = (entry.inflight || 0) + 1;
  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    entry.inflight = Math.max(0, (entry.inflight || 1) - 1);
  };
  readHookBody(request, response, releaseSlot, (chunks) =>
    forwardHookRequest(entry, request, response, url, match, chunks)
  );
}

export function failHookPending(entry) {
  for (const { response, timer } of entry.pending.values()) {
    clearTimeout(timer);
    try {
      response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"agent disconnected"}');
    } catch {
      /* client vanished */
    }
  }
  entry.pending.clear();
}

export function runHookLeg(liveHooks, deviceId, socket, options = {}) {
  const { ingress = undefined, rawSocket = null } = options;
  trackLegIngress(socket, rawSocket, { ...ingress, limit: MAX_HOOK_BODY_BYTES });
  const previous = liveHooks.get(deviceId);
  if (previous) {
    try {
      previous.socket.close(4000, 'superseded');
    } catch {
      /* already gone */
    }
    failHookPending(previous);
  }
  const entry = { socket, pending: new Map(), inflight: 0 };
  liveHooks.set(deviceId, entry);
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
  socket.on('error', () => {
    /* surfaced as close */
  });
  socket.on(
    'message',
    guarded('hook frame', (raw) => {
      noteIngressDelivery(socket);
      socket.isAlive = true;
      answerHookFrame(entry, raw);
    })
  );
  socket.on('close', () => {
    releaseIngressLeg(socket);
    if (liveHooks.get(deviceId)?.socket !== socket) return;
    failHookPending(entry);
    liveHooks.delete(deviceId);
  });
}

// One `http-response` frame from the agent settles its pending inbound request.
function answerHookFrame(entry, raw) {
  let frame;
  try {
    frame = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (frame.type !== 'http-response' || typeof frame.id !== 'string') return;
  const pending = entry.pending.get(frame.id);
  if (!pending) return;
  entry.pending.delete(frame.id);
  clearTimeout(pending.timer);
  let body;
  try {
    body = decodeHookResponseBody(frame.body);
  } catch {
    try {
      pending.response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":"invalid agent response"}');
    } catch {
      /* client vanished */
    }
    return;
  }
  try {
    pending.response.writeHead(upstreamStatus(frame.status), {
      'Content-Type': hookContentType(frame.headers),
      'Content-Length': body.length,
    });
    pending.response.end(body);
  } catch {
    /* client vanished */
  }
}

function hookContentType(headers) {
  const raw = typeof headers?.['content-type'] === 'string' ? headers['content-type'] : '';
  return /^[\x20-\x7e]{1,200}$/.test(raw) ? raw : 'application/json';
}

export function decodeHookResponseBody(value) {
  const encoded = value == null ? '' : String(value);
  const maximumEncoded = Math.ceil(MAX_HOOK_RESPONSE_BODY_BYTES / 3) * 4;
  if (
    encoded.length > maximumEncoded ||
    (encoded && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
  ) {
    throw new Error('invalid hook response body');
  }
  const body = encoded ? Buffer.from(encoded, 'base64') : Buffer.alloc(0);
  if (body.length > MAX_HOOK_RESPONSE_BODY_BYTES) {
    throw new Error('hook response body exceeds limit');
  }
  return body;
}
