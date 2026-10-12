// 6-digit pairing codes (pairing v2). The main PC registers a short-lived code
// for its device route while Settings → Connection is open; a phone, another
// PC or a browser enters it here and learns the route plus a one-time ticket.
// The code never grants access: the ticket only lets the following /claim say
// "entered a code" on the approval dialog, and the desktop still decides.
// Codes and tickets are secrets of a few minutes' life: they are held in
// memory only and never written to any log or to disk.
import { randomBytes, randomInt } from 'node:crypto';

import { RateLimiter } from './rate-limit.mjs';
import { isRoutingId } from './ids.mjs';
import { browserSocketOriginAllowed, clientIp, desktopLegOpen, requestUrl } from './relay-http.mjs';

export const PAIR_CODE_TTL_MS = 300_000;
const MAX_ACTIVE_PAIR_CODES = 10_000;
const MAX_PENDING_TICKETS = 4_096;
const MAX_PAIR_CODE_BODY_BYTES = 1_024;
const MAX_PRESENCE_IDS = 16;
const MAX_NAME_LENGTH = 80;

// Wrong guesses. A 6-digit space is only safe because attempts are scarce:
// each source gets a handful per window and then an exponentially growing
// lockout, and the whole code space shares one budget so a botnet of sources
// still cannot enumerate it inside a code's five-minute life.
export const IP_FAILS_PER_STRIKE = 5;
export const IP_BACKOFF_BASE_MS = 60_000;
const IP_BACKOFF_MAX_MS = 60 * 60_000;
const IP_STATE_TTL_MS = 60 * 60_000;
const MAX_IP_STATES = 10_000;
export const GLOBAL_FAIL_LIMIT = 60;
const GLOBAL_FAIL_WINDOW_MS = 10 * 60_000;

const CODE_PATTERN = /^\d{6}$/;
const LEASE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const TICKET_PATTERN = /^[0-9a-f]{32}$/;
// The bundled phone-app pairing screen is the only cross-origin caller.
const CORS_ORIGINS = new Set(['https://localhost', 'capacitor://localhost']);

export function cleanName(value) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, MAX_NAME_LENGTH)
    : '';
}

export class PairCodes {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.codes = new Map(); // code -> { deviceId, name, expiresAt }
    this.byDevice = new Map(); // deviceId -> code
    this.tickets = new Map(); // ticket -> { deviceId, expiresAt }
    this.ipStates = new Map(); // ip -> { fails, strikes, blockedUntil, seenAt }
    this.globalFails = [];
  }

  sweep() {
    const now = this.now();
    for (const [code, row] of this.codes) {
      if (row.expiresAt > now) continue;
      this.codes.delete(code);
      if (this.byDevice.get(row.deviceId) === code) this.byDevice.delete(row.deviceId);
    }
    for (const [ticket, row] of this.tickets) {
      if (row.expiresAt <= now) this.tickets.delete(ticket);
    }
  }

  /** Issues a fresh relay-chosen code under a desktop-named lease. The caller
   *  never picks or sees any other code, so it cannot probe the code space.
   *  One live code per device; the lease's expiry is fixed at issue time.
   *  { status: 'ok', code, lease, ttlMs } | { status: 'invalid' | 'full' } */
  issue(deviceId, lease, name) {
    if (!isRoutingId(deviceId) || typeof lease !== 'string' || !LEASE_PATTERN.test(lease)) return { status: 'invalid' };
    this.sweep();
    this.clear(deviceId);
    if (this.codes.size >= MAX_ACTIVE_PAIR_CODES) return { status: 'full' };
    let code = '';
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = String(randomInt(0, 1_000_000)).padStart(6, '0');
      if (!this.codes.has(candidate)) {
        code = candidate;
        break;
      }
    }
    if (!code) return { status: 'full' };
    this.codes.set(code, { deviceId, lease, name: cleanName(name), expiresAt: this.now() + PAIR_CODE_TTL_MS });
    this.byDevice.set(deviceId, code);
    return { status: 'ok', code, lease, ttlMs: PAIR_CODE_TTL_MS };
  }

  clear(deviceId) {
    const code = this.byDevice.get(deviceId);
    this.byDevice.delete(deviceId);
    if (code) this.codes.delete(code);
  }

  ipState(ip) {
    const now = this.now();
    const state = this.ipStates.get(ip);
    if (state && now - state.seenAt > IP_STATE_TTL_MS && state.blockedUntil <= now) {
      this.ipStates.delete(ip);
      return null;
    }
    return state ?? null;
  }

  /** Milliseconds this source (or the whole code space) must still wait, else 0. */
  retryAfterMs(ip) {
    const now = this.now();
    const state = this.ipState(ip);
    const ipWait = state ? Math.max(0, state.blockedUntil - now) : 0;
    this.globalFails = this.globalFails.filter((stamp) => stamp > now - GLOBAL_FAIL_WINDOW_MS);
    const globalWait =
      this.globalFails.length >= GLOBAL_FAIL_LIMIT ? this.globalFails[0] + GLOBAL_FAIL_WINDOW_MS - now : 0;
    return Math.max(ipWait, globalWait);
  }

  noteFailure(ip) {
    const now = this.now();
    this.globalFails.push(now);
    let state = this.ipState(ip);
    if (!state) {
      if (this.ipStates.size >= MAX_IP_STATES) {
        const oldest = this.ipStates.keys().next().value;
        if (oldest !== undefined) this.ipStates.delete(oldest);
      }
      state = { fails: 0, strikes: 0, blockedUntil: 0, seenAt: now };
    }
    this.ipStates.delete(ip);
    state.seenAt = now;
    state.fails += 1;
    if (state.fails >= IP_FAILS_PER_STRIKE) {
      state.fails = 0;
      state.strikes += 1;
      state.blockedUntil = now + Math.min(IP_BACKOFF_MAX_MS, IP_BACKOFF_BASE_MS * 2 ** (state.strikes - 1));
    }
    this.ipStates.set(ip, state);
  }

  /** Looks a code up for one caller. A right code is consumed (single use). */
  resolve(code, ip) {
    this.sweep();
    const wait = this.retryAfterMs(ip);
    if (wait > 0) return { status: 'limited', retryAfterMs: wait };
    const row = typeof code === 'string' && CODE_PATTERN.test(code) ? this.codes.get(code) : undefined;
    if (!row) {
      this.noteFailure(ip);
      return { status: 'invalid' };
    }
    this.codes.delete(code);
    this.byDevice.delete(row.deviceId);
    const ticket = this.mintTicket(row.deviceId);
    return { status: 'ok', deviceId: row.deviceId, name: row.name, ticket, lease: row.lease };
  }

  mintTicket(deviceId) {
    while (this.tickets.size >= MAX_PENDING_TICKETS) {
      const oldest = this.tickets.keys().next().value;
      if (oldest === undefined) break;
      this.tickets.delete(oldest);
    }
    const ticket = randomBytes(16).toString('hex');
    this.tickets.set(ticket, { deviceId, expiresAt: this.now() + PAIR_CODE_TTL_MS });
    return ticket;
  }

  /** True once, for a live ticket minted for this device. */
  takeTicket(ticket, deviceId) {
    if (typeof ticket !== 'string' || !TICKET_PATTERN.test(ticket)) return false;
    const row = this.tickets.get(ticket);
    if (!row) return false;
    this.tickets.delete(ticket);
    return row.deviceId === deviceId && row.expiresAt > this.now();
  }
}

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (tooLarge) return;
      if (size > MAX_PAIR_CODE_BODY_BYTES) {
        // Stop keeping bytes but let the request drain so the 400 can be sent.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        rejectBody(new Error('request body too large'));
        return;
      }
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        rejectBody(new Error('invalid json'));
      }
    });
    request.on('error', rejectBody);
  });
}

/** Same-origin or the bundled phone screen; a request with no Origin at all is
 *  a native client (the desktop app) and is fine. */
function originAllowed(request) {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
  return !origin || CORS_ORIGINS.has(origin) || browserSocketOriginAllowed(request);
}

function corsHeaders(request) {
  const origin = typeof request.headers.origin === 'string' ? request.headers.origin : '';
  return CORS_ORIGINS.has(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'Content-Type' }
    : {};
}

function reply(request, response, status, body, extra = {}) {
  response
    .writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
      ...extra,
    })
    .end(JSON.stringify(body));
}

async function handleResolve({ pairCodes, liveDesktops }, request, response) {
  let body;
  try {
    body = await readBody(request);
  } catch {
    reply(request, response, 400, { status: 'bad-request' });
    return;
  }
  const result = pairCodes.resolve(body?.code, clientIp(request));
  if (result.status === 'limited') {
    const retryAfter = Math.ceil(result.retryAfterMs / 1000);
    reply(request, response, 429, { status: 'rate-limited', retryAfter }, { 'Retry-After': String(retryAfter) });
    return;
  }
  if (result.status !== 'ok') {
    reply(request, response, 404, { status: 'invalid-code' });
    return;
  }
  // The shown code is spent: the main PC rolls a fresh one.
  const entry = liveDesktops.get(result.deviceId);
  if (desktopLegOpen(entry)) {
    try {
      entry.socket.send(JSON.stringify({ type: 'pair-code-used', lease: result.lease }));
    } catch {
      /* the desktop redials and republishes */
    }
  }
  reply(request, response, 200, { deviceId: result.deviceId, name: result.name, ticket: result.ticket });
}

/** Answers 429 and returns true when this source is over its presence budget. */
function presenceThrottled(presenceLimiter, request, response) {
  if (presenceLimiter.allow(clientIp(request))) return false;
  reply(request, response, 429, { status: 'rate-limited' }, { 'Retry-After': '60' });
  return true;
}

function handleSupport({ liveDesktops, store, presenceLimiter }, request, response) {
  if (presenceThrottled(presenceLimiter, request, response)) return;
  const url = requestUrl(request);
  const deviceId = url?.searchParams.get('deviceId') || '';
  if (!isRoutingId(deviceId) || !store.isKnown(deviceId)) {
    reply(request, response, 404, { status: 'unknown' });
    return;
  }
  const entry = liveDesktops.get(deviceId);
  reply(request, response, 200, {
    online: desktopLegOpen(entry),
    pairV2: entry?.pairV2 === true,
  });
}

async function handlePresence({ liveDesktops, store, presenceLimiter }, request, response) {
  if (presenceThrottled(presenceLimiter, request, response)) return;
  let body;
  try {
    body = await readBody(request);
  } catch {
    reply(request, response, 400, { status: 'bad-request' });
    return;
  }
  const ids = Array.isArray(body?.ids) ? body.ids.slice(0, MAX_PRESENCE_IDS) : [];
  const online = {};
  for (const id of ids) {
    if (typeof id === 'string' && isRoutingId(id) && store.isKnown(id))
      online[id] = desktopLegOpen(liveDesktops.get(id));
  }
  reply(request, response, 200, { online });
}

/** `/pair-code/resolve`, `/pair-code/support`, `/pair-code/presence`. */
export async function handlePairCodeRequest(context, request, response) {
  const pathname = requestUrl(request)?.pathname ?? '';
  if (request.method === 'OPTIONS') {
    response
      .writeHead(204, {
        ...corsHeaders(request),
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Max-Age': '600',
      })
      .end();
    return;
  }
  if (!originAllowed(request)) {
    response.writeHead(403).end();
    return;
  }
  if (request.method === 'POST' && pathname === '/pair-code/resolve') return handleResolve(context, request, response);
  if (request.method === 'POST' && pathname === '/pair-code/presence')
    return handlePresence(context, request, response);
  if (request.method === 'GET' && pathname === '/pair-code/support') return handleSupport(context, request, response);
  response.writeHead(404).end();
}

export function createPresenceLimiter() {
  return new RateLimiter(60, 60_000);
}
