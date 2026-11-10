// Model proxy bridge: remote-mode model calls for processes the daemon does
// not host.
//
// With MIXDOG_MODEL_PROXY=client the daemon holds no model credentials; its
// ModelProxyProviders talk through the in-process channel the desktop client
// attaches to (model-proxy-channel.mjs). A skill script started by the model's
// shell (headless exec, one fresh runtime per run) is a separate process and
// cannot reach that channel, so the daemon relays for it over loopback:
//
//   child  -> daemon  {"type":"hello","v":1,"token":…}        (once, first)
//   daemon -> child   {"type":"state","connected","generation"} (initial + on change)
//   child  -> daemon  {"type":"reserve","id","bytes"}         (request frame size)
//   daemon -> child   {"type":"grant","id"}                   (FIFO, within the byte cap)
//   child  -> daemon  {"type":"req","id","callbacks":[…],"call":<wire>}  (only once granted)
//   daemon -> child   {"type":"event","id","seq","name","args":<wire>}
//   child  -> daemon  {"type":"result","id","seq","ok","value"|"error"}
//   daemon -> child   {"type":"done","id","ok","value"|"error"}
//   child  -> daemon  {"type":"cancel","id"}
//
// NDJSON frames; every frame is decoded with the channel's wire codec, so
// bytes and errors (status, code, partial usage…) survive exactly as on the
// PC wire. The endpoint and its per-lifetime token are published only in the
// owner-only daemon.json. The bridge itself never holds a credential: it
// forwards to the same channel the daemon's own providers use.
//
// Admission: a request's bytes are reserved before they are sent, so the
// daemon never has to stop reading a socket for budget. Control frames
// (result, cancel, reserve) are always read and handled at once, bounded by
// their own frame limit; only reservations wait, first come first served.
import net from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLoopbackListener } from '../../../shared/loopback-listener.mjs';
import { isPidAlive } from '../../../shared/pid-liveness.mjs';
import {
  MODEL_PROXY_METHODS,
  ModelProxyUnavailableError,
  decodeModelProxyWire,
  encodeModelProxyWire,
  modelProxyErrorFromWire,
  modelProxyErrorToWire,
  modelProxyWireValue,
} from './model-proxy-channel.mjs';

export const MODEL_PROXY_BRIDGE_PROTOCOL = 1;

const MiB = 1024 * 1024;
/**
 * Byte limits are 1.5× the PC's character limits (model-proxy-host.ts: 128 MiB
 * per call, 256 MiB in flight): multibyte transcript text the PC accepts is
 * never refused here, and an ASCII payload (base64 attachments) meets the PC's
 * own limit first.
 */
export const MODEL_PROXY_BRIDGE_LIMITS = Object.freeze({
  helloTimeoutMs: 5_000,
  helloMaxBytes: 1024,
  /** Every frame but `req`: results, cancels, reservations (callback answers are tiny). */
  controlFrameMaxBytes: MiB,
  requestFrameMaxBytes: 192 * MiB,
  /** Granted request frames (being received or running), across all connections. */
  aggregateBytes: 384 * MiB,
  /** Unwritten bytes queued to one client before it is dropped as not reading. */
  outgoingQueueBytes: 64 * MiB,
  /** A relayed callback the client has not answered by then aborts its call. */
  callbackAckMs: 30_000,
  /** A partial frame, or a grant whose own request frame, receives no bytes for this long: its client is dropped. */
  frameStallMs: 60_000,
  /** A granted request frame must have arrived in full by then, however steadily it trickles. */
  grantMaxMs: 300_000,
  maxConnections: 16,
  maxRequestsPerConnection: 16,
  maxCallbacks: 32,
});

const TOKEN_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Same rule as splitModelProxySendOptions (/^on[A-Z]/), bounded.
const CALLBACK_NAME_RE = /^on[A-Z][A-Za-z0-9_]{0,62}$/;
const MAX_FIELD_CHARS = 256;
const NEWLINE = 0x0a;
const REQ_PREFIX = Buffer.from('{"type":"req",');
// The bridge client writes `{"type":"req","id":"<id>",…`: enough head bytes name the grant.
const REQ_ID_RE = /^\{"type":"req","id":"([A-Za-z0-9_-]{1,64})"/;
const REQ_HEAD_BYTES = 96;
const RECONNECT_DELAY_MS = 250;

function bridgeError(code, message) {
  const error = new Error(`model proxy bridge: ${message}`);
  error.name = 'ModelProxyBridgeError';
  error.code = code;
  return error;
}

function abortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return abortError(String(signal?.reason || 'model call aborted'));
}

function unavailable(detail, reason) {
  const error = new ModelProxyUnavailableError(detail);
  if (reason) error.reason = reason;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Log-safe token: no frame content, only a bounded identifier. */
function logField(value) {
  const text = String(value ?? '');
  return text ? text.slice(0, 80).replace(/[^\w.:/@+-]/g, '_') : '-';
}

// ── Framing ─────────────────────────────────────────────────────────────────

/** Newline framing over chunk lists: a large frame is joined once, and its
 *  size is checked against its limit before it is ever parsed. */
class LineBuffer {
  #chunks = [];
  #headCache = null;
  size = 0;

  /** The frame's first bytes (stable once long enough: the frame start never changes). */
  #head(piece, length) {
    if (this.#headCache) return this.#headCache;
    const parts = [];
    let have = 0;
    for (const part of [...this.#chunks, piece]) {
      if (have >= length) break;
      parts.push(part);
      have += part.length;
    }
    const head = Buffer.concat(parts).subarray(0, length);
    if (head.length >= length) this.#headCache = head;
    return head;
  }

  /** The first `length` bytes of the buffered partial frame. */
  peek(length) {
    const parts = [];
    let have = 0;
    for (const part of this.#chunks) {
      if (have >= length) break;
      parts.push(part);
      have += part.length;
    }
    return Buffer.concat(parts).subarray(0, length);
  }

  /**
   * Feed `chunk`; `onLine(line)` runs for each complete frame as it is found
   * (so a frame can change the limits of the next) and returns false to stop.
   * `limit.min()` is the size below which no frame is refused and
   * `limit.forHead(head)` the limit of a frame starting with `head`. Returns
   * false once a frame exceeds its limit.
   */
  push(chunk, limit, onLine) {
    let start = 0;
    for (;;) {
      const index = chunk.indexOf(NEWLINE, start);
      const piece = chunk.subarray(start, index < 0 ? chunk.length : index);
      const size = this.size + piece.length;
      if (size > limit.min() && size > limit.forHead(this.#head(piece, REQ_PREFIX.length))) return false;
      if (index < 0) {
        if (piece.length) {
          this.#chunks.push(piece);
          this.size = size;
        }
        return true;
      }
      const line = this.#chunks.length ? Buffer.concat([...this.#chunks, piece]) : piece;
      this.#chunks = [];
      this.#headCache = null;
      this.size = 0;
      if (onLine(line) === false) return true;
      start = index + 1;
    }
  }
}

const startsWithReq = (head) => head.length >= REQ_PREFIX.length && head.equals(REQ_PREFIX);

// ── Daemon side ─────────────────────────────────────────────────────────────

/**
 * The daemon's loopback relay to `channel`. `admit()` gates every new
 * connection and request (owner fencing, shutdown); `trackWork(active)` hears
 * every change of the running-request count; `log` gets one line per request
 * (id, method, provider, model, duration, error code) and never a token or a
 * frame.
 */
export function createModelProxyBridgeServer({
  channel,
  admit = () => true,
  trackWork = () => {},
  log = () => {},
  limits: limitOverrides = {},
} = {}) {
  const limits = { ...MODEL_PROXY_BRIDGE_LIMITS, ...limitOverrides };
  const tokenBytes = randomBytes(32);
  const token = tokenBytes.toString('hex');
  const connections = new Set();
  /** Reservations waiting for byte budget, oldest first. */
  const waiting = [];
  let draining = false;
  let redrain = false;
  const settling = new Set();
  /** Bytes of granted reservations and of running requests' frames. */
  let budgetUsed = 0;
  let active = 0;
  let closing = false;
  let closed = null;

  const server = net.createServer({ allowHalfOpen: false }, onConnection);
  const listener = createLoopbackListener({
    server,
    onListening: () => {},
    onError: (error) => log(`model-proxy bridge listener error: ${logField(error?.code || error?.name)}`),
  });
  const unsubscribe = channel.onStateChange(() => {
    for (const conn of connections) if (conn.authenticated) sendState(conn);
  });

  function setActive(delta) {
    active += delta;
    trackWork(active);
  }

  function onConnection(socket) {
    if (closing || connections.size >= limits.maxConnections || !admit()) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    const conn = {
      socket,
      authenticated: false,
      closed: false,
      lines: new LineBuffer(),
      limit: null,
      reservations: new Map(),
      /** The grant the buffered partial frame belongs to, and its size when last seen. */
      partialGrant: null,
      partialSize: 0,
      requests: new Map(),
      stallTimer: null,
      helloTimer: setTimeout(() => {
        if (!conn.authenticated) closeConnection(conn);
      }, limits.helloTimeoutMs),
    };
    conn.helloTimer.unref?.();
    conn.limit = frameLimit(conn);
    connections.add(conn);
    socket.on('data', (chunk) => onData(conn, chunk));
    socket.on('error', () => {});
    socket.on('close', () => closeConnection(conn));
  }

  function frameLimit(conn) {
    return {
      min: () => (conn.authenticated ? limits.controlFrameMaxBytes : limits.helloMaxBytes),
      forHead: (head) => {
        if (!conn.authenticated) return limits.helloMaxBytes;
        // A request frame may only be as large as the largest grant it could be for.
        return startsWithReq(head) ? largestGrant(conn) : limits.controlFrameMaxBytes;
      },
    };
  }

  function largestGrant(conn) {
    let largest = 0;
    for (const reservation of conn.reservations.values()) {
      if (reservation.granted && reservation.bytes > largest) largest = reservation.bytes;
    }
    return largest;
  }

  /** Never paused for budget: request bytes were reserved before they were sent. */
  function onData(conn, chunk) {
    if (conn.closed) return;
    const withinLimits = conn.lines.push(chunk, conn.limit, (line) => {
      handleLine(conn, line);
      return !conn.closed;
    });
    if (conn.closed) return;
    if (!withinLimits) {
      fail(conn, 'MODEL_PROXY_BRIDGE_FRAME_TOO_LARGE');
      return;
    }
    trackGrantProgress(conn);
    armStall(conn);
  }

  /**
   * A grant's stall timer is refreshed only by its own `req` frame growing:
   * control frames and frames for other ids never keep a silent grant alive.
   * (A frame that completes settles its grant in handleRequest.)
   */
  function trackGrantProgress(conn) {
    const size = conn.lines.size;
    if (size === 0) {
      conn.partialGrant = null;
      return;
    }
    const id = REQ_ID_RE.exec(conn.lines.peek(REQ_HEAD_BYTES).toString('latin1'))?.[1];
    const reservation = id === undefined ? undefined : conn.reservations.get(id);
    const owner = reservation?.granted ? reservation : null;
    if (owner && (owner !== conn.partialGrant || size > conn.partialSize)) owner.timer?.refresh();
    conn.partialGrant = owner;
    conn.partialSize = size;
  }

  function armStall(conn) {
    if (conn.lines.size === 0) {
      clearTimeout(conn.stallTimer);
      conn.stallTimer = null;
      return;
    }
    if (conn.stallTimer) {
      conn.stallTimer.refresh();
      return;
    }
    conn.stallTimer = setTimeout(() => fail(conn, 'MODEL_PROXY_BRIDGE_FRAME_STALLED'), limits.frameStallMs);
    conn.stallTimer.unref?.();
  }

  /**
   * Grants waiting reservations strictly in FIFO order. Non-reentrant: a grant
   * can close its connection (slow client), which calls back in here; a nested
   * call only requests another pass, so the loop always acts on the current
   * head of the queue. A reservation leaves the queue only once granted or
   * withdrawn (cancel, disconnect, fencing); budget held by grants and running
   * requests is always released by their completion or by a bounded timeout,
   * so a waiting reservation is eventually granted.
   */
  function drain() {
    if (draining) {
      redrain = true;
      return;
    }
    draining = true;
    try {
      do {
        redrain = false;
        while (waiting.length) {
          const reservation = waiting[0];
          if (reservation.conn.closed || reservation.conn.reservations.get(reservation.id) !== reservation) {
            waiting.shift();
            continue;
          }
          if (budgetUsed + reservation.bytes > limits.aggregateBytes) break;
          waiting.shift();
          grant(reservation);
        }
      } while (redrain);
    } finally {
      draining = false;
    }
  }

  function grant(reservation) {
    const { conn } = reservation;
    budgetUsed += reservation.bytes;
    reservation.granted = true;
    // The granted frame must keep arriving, and arrive in full by the ceiling,
    // or its budget is reclaimed.
    reservation.timer = setTimeout(() => fail(conn, 'MODEL_PROXY_BRIDGE_FRAME_STALLED'), limits.frameStallMs);
    reservation.timer.unref?.();
    reservation.deadline = setTimeout(() => fail(conn, 'MODEL_PROXY_BRIDGE_FRAME_STALLED'), limits.grantMaxMs);
    reservation.deadline.unref?.();
    send(conn, { type: 'grant', id: reservation.id });
  }

  /** Withdraws a reservation; a granted one gives its budget back (the caller drains). */
  function dropReservation(conn, reservation) {
    conn.reservations.delete(reservation.id);
    clearTimeout(reservation.timer);
    clearTimeout(reservation.deadline);
    if (reservation.granted) budgetUsed -= reservation.bytes;
  }

  function handleLine(conn, line) {
    if (!conn.authenticated) {
      handleHello(conn, line);
      return;
    }
    let frame;
    try {
      frame = decodeModelProxyWire(line.toString('utf8'));
    } catch {
      fail(conn, 'MODEL_PROXY_BRIDGE_BAD_FRAME');
      return;
    }
    if (!isPlainObject(frame) || (line.length > limits.controlFrameMaxBytes && frame.type !== 'req')) {
      fail(conn, 'MODEL_PROXY_BRIDGE_BAD_FRAME');
      return;
    }
    if (frame.type === 'req') handleRequest(conn, frame, line.length + 1);
    else if (frame.type === 'reserve') handleReserve(conn, frame);
    else if (frame.type === 'result') handleResult(conn, frame);
    else if (frame.type === 'cancel') handleCancel(conn, frame);
    else fail(conn, 'MODEL_PROXY_BRIDGE_BAD_FRAME');
  }

  function handleHello(conn, line) {
    let hello = null;
    try {
      hello = JSON.parse(line.toString('utf8'));
    } catch {
      /* rejected below */
    }
    const presented = typeof hello?.token === 'string' && TOKEN_RE.test(hello.token) ? hello.token : null;
    const valid =
      hello?.type === 'hello' &&
      hello.v === MODEL_PROXY_BRIDGE_PROTOCOL &&
      presented !== null &&
      timingSafeEqual(Buffer.from(presented, 'hex'), tokenBytes);
    if (!valid) {
      fail(conn, 'MODEL_PROXY_BRIDGE_UNAUTHORIZED');
      return;
    }
    if (!admit()) {
      fail(conn, 'MODEL_PROXY_UNAVAILABLE');
      return;
    }
    clearTimeout(conn.helloTimer);
    conn.authenticated = true;
    sendState(conn);
  }

  function refuse(conn, id, error) {
    send(conn, { type: 'done', id, ok: false, error: modelProxyErrorToWire(error) });
  }

  function validCallbackNames(names) {
    return (
      Array.isArray(names) &&
      names.length <= limits.maxCallbacks &&
      names.every((name) => typeof name === 'string' && CALLBACK_NAME_RE.test(name)) &&
      new Set(names).size === names.length
    );
  }

  /** A request announces its frame size first; it is granted when the byte budget allows. */
  function handleReserve(conn, frame) {
    const { id, bytes } = frame;
    if (typeof id !== 'string' || !ID_RE.test(id) || !Number.isSafeInteger(bytes) || bytes < 1) {
      fail(conn, 'MODEL_PROXY_BRIDGE_BAD_FRAME');
      return;
    }
    if (conn.requests.has(id) || conn.reservations.has(id)) {
      fail(conn, 'MODEL_PROXY_BRIDGE_DUPLICATE_ID');
      return;
    }
    if (!admit()) {
      refuse(conn, id, unavailable('the daemon is not accepting new model calls'));
      return;
    }
    if (conn.requests.size + conn.reservations.size >= limits.maxRequestsPerConnection) {
      refuse(conn, id, bridgeError('MODEL_PROXY_BRIDGE_LIMIT', 'too many concurrent calls on one connection'));
      return;
    }
    if (bytes > limits.requestFrameMaxBytes || bytes > limits.aggregateBytes) {
      refuse(conn, id, bridgeError('MODEL_PROXY_REQUEST_TOO_LARGE', 'the model call exceeds the bridge limit'));
      return;
    }
    const reservation = { conn, id, bytes, granted: false, timer: null, deadline: null };
    conn.reservations.set(id, reservation);
    waiting.push(reservation);
    drain();
  }

  function requestRefusal(call, names) {
    if (!admit()) return unavailable('the daemon is not accepting new model calls');
    if (!isPlainObject(call) || !MODEL_PROXY_METHODS.includes(call.method)) {
      return bridgeError('MODEL_PROXY_BRIDGE_METHOD', 'unsupported model proxy method');
    }
    const provider = call.provider ?? '';
    const model = call.model ?? null;
    if (
      typeof provider !== 'string' ||
      provider.length > MAX_FIELD_CHARS ||
      (model !== null && (typeof model !== 'string' || model.length > MAX_FIELD_CHARS)) ||
      !validCallbackNames(names)
    ) {
      return bridgeError('MODEL_PROXY_BRIDGE_BAD_REQUEST', 'malformed model proxy request');
    }
    return null;
  }

  function handleRequest(conn, frame, bytes) {
    const { id, call, callbacks: names } = frame;
    const reservation = typeof id === 'string' ? conn.reservations.get(id) : undefined;
    // Only a granted reservation admits a request frame, and only up to its size.
    if (!reservation?.granted || bytes > reservation.bytes) {
      fail(conn, 'MODEL_PROXY_BRIDGE_BAD_FRAME');
      return;
    }
    conn.reservations.delete(id);
    clearTimeout(reservation.timer);
    clearTimeout(reservation.deadline);
    const refusal = requestRefusal(call, names);
    if (refusal) {
      budgetUsed -= reservation.bytes;
      refuse(conn, id, refusal);
      drain();
      return;
    }
    const entry = {
      id,
      method: call.method,
      provider: call.provider ?? '',
      model: call.model ?? null,
      // The granted bytes stay reserved until the call settles.
      bytes: reservation.bytes,
      controller: new AbortController(),
      seq: 0,
      waiters: new Map(),
      queue: Promise.resolve(),
      startedAt: Date.now(),
    };
    conn.requests.set(id, entry);
    setActive(1);
    const callbacks = Object.fromEntries(names.map((name) => [name, (...args) => relay(conn, entry, name, args)]));
    const { callbacks: _names, ...upstream } = call;
    const settled = channel
      .request(upstream, { signal: entry.controller.signal, callbacks })
      .then(
        (value) => finish(conn, entry, true, value),
        (error) => finish(conn, entry, false, error)
      )
      .finally(() => settling.delete(settled));
    settling.add(settled);
  }

  /** One callback of one request, strictly after the previous one answered. */
  function relay(conn, entry, name, args) {
    const run = () =>
      new Promise((resolve, reject) => {
        if (conn.closed || entry.controller.signal.aborted) {
          reject(entry.controller.signal.reason ?? abortError('model call aborted'));
          return;
        }
        entry.seq += 1;
        const seq = entry.seq;
        const timer = setTimeout(() => {
          entry.waiters.delete(seq);
          const error = unavailable('the bridge client did not acknowledge a model callback');
          reject(error);
          abortEntry(entry, error);
        }, limits.callbackAckMs);
        timer.unref?.();
        entry.waiters.set(seq, { resolve, reject, timer });
        send(conn, { type: 'event', id: entry.id, seq, name, args: modelProxyWireValue(args) ?? [] });
      });
    const next = entry.queue.then(run, run);
    entry.queue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  function rejectWaiters(entry, reason) {
    const waiters = [...entry.waiters.values()];
    entry.waiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  }

  function abortEntry(entry, reason) {
    if (!entry.controller.signal.aborted) entry.controller.abort(reason);
    rejectWaiters(entry, reason);
  }

  async function finish(conn, entry, ok, value) {
    // Every relayed callback is answered (or failed) before `done`.
    await entry.queue;
    rejectWaiters(entry, abortError('model call settled'));
    conn.requests.delete(entry.id);
    budgetUsed -= entry.bytes;
    setActive(-1);
    const code = ok ? '' : ` error=${logField(value?.code || value?.name || 'Error')}`;
    log(
      `model-proxy bridge ${logField(entry.method)} id=${logField(entry.id)} provider=${logField(entry.provider)}` +
        ` model=${logField(entry.model)} ${Date.now() - entry.startedAt}ms${code}`
    );
    if (ok) send(conn, { type: 'done', id: entry.id, ok: true, value: modelProxyWireValue(value) ?? null });
    else send(conn, { type: 'done', id: entry.id, ok: false, error: modelProxyErrorToWire(value) });
    drain();
  }

  function handleResult(conn, frame) {
    const entry = conn.requests.get(frame.id);
    const waiter = entry?.waiters.get(frame.seq);
    if (!waiter) return;
    entry.waiters.delete(frame.seq);
    clearTimeout(waiter.timer);
    if (frame.ok === true) waiter.resolve(frame.value ?? null);
    else waiter.reject(modelProxyErrorFromWire(frame.error));
  }

  function handleCancel(conn, frame) {
    const reservation = conn.reservations.get(frame.id);
    if (reservation) {
      dropReservation(conn, reservation);
      drain();
      return;
    }
    const entry = conn.requests.get(frame.id);
    if (entry) abortEntry(entry, abortError('the bridge client cancelled the model call'));
  }

  function sendState(conn) {
    send(conn, { type: 'state', connected: channel.connected, generation: channel.generation });
  }

  function send(conn, frame) {
    if (conn.closed) return;
    if (conn.socket.writableLength > limits.outgoingQueueBytes) {
      fail(conn, 'MODEL_PROXY_BRIDGE_SLOW_CLIENT');
      return;
    }
    conn.socket.write(`${JSON.stringify(frame)}\n`);
  }

  function fail(conn, code) {
    if (conn.closed) return;
    conn.socket.write(`${JSON.stringify({ type: 'error', code })}\n`);
    closeConnection(conn, true);
  }

  /** Never replays: every running call of the connection is aborted upstream. */
  function closeConnection(conn, flush = false) {
    if (conn.closed) return;
    conn.closed = true;
    connections.delete(conn);
    clearTimeout(conn.helloTimer);
    clearTimeout(conn.stallTimer);
    const reason = unavailable('the bridge client disconnected');
    for (const entry of conn.requests.values()) abortEntry(entry, reason);
    for (const reservation of [...conn.reservations.values()]) dropReservation(conn, reservation);
    if (flush) {
      conn.socket.end();
      setTimeout(() => conn.socket.destroy(), 1_000).unref?.();
    } else {
      conn.socket.destroy();
    }
    drain();
  }

  return {
    /** Listen on 127.0.0.1 (an OS-chosen port); resolves the endpoint to publish. */
    async start() {
      const port = await listener.start();
      return { port, token };
    },
    get activeCount() {
      return active;
    },
    get connectionCount() {
      return connections.size;
    },
    /** Abort every running call (fenced owner, shutdown); new ones are gated by admit(). */
    abortAll(reason = 'the daemon is stopping') {
      const error = unavailable(String(reason));
      for (const conn of connections) {
        for (const entry of conn.requests.values()) abortEntry(entry, error);
        // Reserved calls never start: refused now, not when their frame arrives.
        for (const reservation of [...conn.reservations.values()]) {
          dropReservation(conn, reservation);
          refuse(conn, reservation.id, error);
        }
      }
      drain();
    },
    /** Stop listening, abort every call, close every socket and wait until each call settled. */
    close(reason = 'the daemon is stopping') {
      if (closed) return closed;
      closing = true;
      unsubscribe();
      this.abortAll(reason);
      for (const conn of [...connections]) closeConnection(conn);
      closed = Promise.all([listener.stop(), Promise.allSettled([...settling])]).then(() => {});
      return closed;
    },
  };
}

// ── Child side ──────────────────────────────────────────────────────────────

/**
 * The daemon's bridge endpoint from `<runtimeRoot>/daemon.json`. Fails closed
 * with MODEL_PROXY_UNAVAILABLE (and a `reason`) when the file is missing, its
 * daemon is gone, or it publishes no bridge. Never echoes file contents.
 */
export function readModelProxyBridgeDiscovery(runtimeRoot) {
  const root = String(runtimeRoot || '').trim();
  if (!root) throw unavailable('MIXDOG_RUNTIME_ROOT does not name the daemon runtime root', 'runtime-root-missing');
  let record;
  try {
    record = JSON.parse(readFileSync(join(root, 'daemon.json'), 'utf8'));
  } catch {
    throw unavailable('no readable daemon discovery file in the runtime root', 'discovery-missing');
  }
  if (!isPidAlive(record?.pid)) {
    throw unavailable('the daemon named by the discovery file is not running', 'daemon-not-running');
  }
  const endpoint = record?.endpoints?.modelProxy;
  const port = Number(endpoint?.port);
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    typeof endpoint?.token !== 'string' ||
    !TOKEN_RE.test(endpoint.token)
  ) {
    throw unavailable('the daemon publishes no model proxy bridge endpoint', 'endpoint-missing');
  }
  return { port, token: endpoint.token, pid: Number(record.pid) };
}

/**
 * The child half: exactly the channel surface ModelProxyProvider and
 * loadModelProxyProviderConfig use. Connects lazily; `connected` means the
 * bridge is authenticated AND the daemon has a usable PC client. The
 * generation advances on every (re)connect, disconnect and upstream change.
 */
export class ModelProxyBridgeChannel {
  #host;
  #port;
  #token;
  #connectTimeoutMs;
  #maxFrameBytes;
  #socket = null;
  #lines = null;
  #connecting = null;
  #authenticated = false;
  #upstream = false;
  #upstreamGeneration = null;
  #generation = 0;
  #requests = new Map();
  #nextId = 0;
  #changeWaiters = new Set();
  #disposed = false;

  constructor({
    port,
    token,
    host = '127.0.0.1',
    connectTimeoutMs = 10_000,
    maxFrameBytes = MODEL_PROXY_BRIDGE_LIMITS.requestFrameMaxBytes,
  } = {}) {
    this.#host = host;
    this.#port = port;
    this.#token = token;
    this.#connectTimeoutMs = connectTimeoutMs;
    this.#maxFrameBytes = maxFrameBytes;
  }

  get connected() {
    return this.#authenticated && this.#upstream;
  }

  get generation() {
    return this.#generation;
  }

  /** Connects if needed; true once the bridge and a PC client are usable, false after `timeoutMs`. */
  async whenConnected(timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      if (this.connected) return true;
      const remaining = deadline - Date.now();
      if (this.#disposed || remaining <= 0) return false;
      if (this.#authenticated) {
        await this.#waitForChange(remaining);
        continue;
      }
      const failed = await this.#withTimeout(this.#connect(), remaining).then(
        () => false,
        () => true
      );
      if (failed && !this.#authenticated) {
        await this.#waitForChange(Math.min(RECONNECT_DELAY_MS, Math.max(0, deadline - Date.now())));
      }
    }
  }

  request(call, { signal = null, callbacks = {} } = {}) {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.#disposed) return Promise.reject(unavailable('the model proxy bridge was closed'));
    return new Promise((resolve, reject) => {
      this.#nextId += 1;
      const entry = {
        id: `r${this.#nextId}`,
        callbacks,
        resolve,
        reject,
        signal,
        onAbort: null,
        settled: false,
        sent: false,
        queue: Promise.resolve(),
      };
      if (signal) {
        entry.onAbort = () => {
          const wasSent = entry.sent && !entry.settled;
          this.#settle(entry, false, abortReason(signal));
          if (wasSent) this.#write({ type: 'cancel', id: entry.id });
        };
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#requests.set(entry.id, entry);
      this.#updateRef();
      this.#connect().then(
        () => this.#send(entry, call),
        (error) => this.#settle(entry, false, error)
      );
    });
  }

  /** Close for good: outstanding calls fail, later ones fail fast. */
  dispose(reason = 'the model proxy bridge was closed') {
    if (this.#disposed) return;
    this.#disposed = true;
    const error = unavailable(reason);
    if (this.#socket) this.#drop(this.#socket, error);
    for (const entry of [...this.#requests.values()]) this.#settle(entry, false, error);
    this.#notifyChange();
  }

  #send(entry, call) {
    if (entry.settled) return;
    if (!this.#upstream) {
      this.#settle(entry, false, unavailable('no desktop client is connected to run model calls'));
      return;
    }
    let line;
    try {
      // Built in this order so a large frame starts with the `req` prefix the
      // daemon checks before buffering it.
      line = `{"type":"req","id":${JSON.stringify(entry.id)},"callbacks":${JSON.stringify(
        Object.keys(entry.callbacks)
      )},"call":${encodeModelProxyWire(call)}}`;
    } catch (error) {
      this.#settle(entry, false, error);
      return;
    }
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > this.#maxFrameBytes) {
      this.#settle(
        entry,
        false,
        bridgeError('MODEL_PROXY_REQUEST_TOO_LARGE', 'the model call exceeds the bridge limit')
      );
      return;
    }
    // The frame follows its grant; a cancel from here on also withdraws the reservation.
    entry.line = line;
    entry.sent = true;
    this.#socket.write(`${JSON.stringify({ type: 'reserve', id: entry.id, bytes })}\n`);
  }

  #handleGrant(socket, frame) {
    const entry = this.#requests.get(String(frame.id));
    if (!entry?.line) return;
    const line = entry.line;
    entry.line = null;
    socket.write(`${line}\n`);
  }

  #connect() {
    if (this.#disposed) return Promise.reject(unavailable('the model proxy bridge was closed'));
    if (this.#authenticated) return Promise.resolve();
    if (this.#connecting) return this.#connecting.promise;
    const attempt = Promise.withResolvers();
    attempt.promise.catch(() => {});
    this.#connecting = attempt;
    const socket = net.connect({ host: this.#host, port: this.#port });
    this.#socket = socket;
    this.#lines = new LineBuffer();
    socket.setNoDelay(true);
    attempt.timer = setTimeout(
      () => this.#drop(socket, unavailable('the model proxy bridge did not answer')),
      this.#connectTimeoutMs
    );
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'hello', v: MODEL_PROXY_BRIDGE_PROTOCOL, token: this.#token })}\n`);
    });
    socket.on('data', (chunk) => this.#onData(socket, chunk));
    socket.on('error', () => {});
    socket.on('close', () => this.#drop(socket, unavailable('the model proxy bridge disconnected')));
    this.#updateRef();
    return attempt.promise;
  }

  #onData(socket, chunk) {
    if (socket !== this.#socket) return;
    const max = () => this.#maxFrameBytes;
    const withinLimits = this.#lines.push(chunk, { min: max, forHead: max }, (line) => {
      let frame;
      try {
        frame = decodeModelProxyWire(line.toString('utf8'));
      } catch {
        this.#drop(socket, unavailable('the model proxy bridge sent a malformed frame'));
        return false;
      }
      if (isPlainObject(frame)) this.#handleFrame(socket, frame);
      return socket === this.#socket;
    });
    if (!withinLimits && socket === this.#socket) {
      this.#drop(socket, unavailable('the model proxy bridge sent an oversized frame'));
    }
  }

  #handleFrame(socket, frame) {
    switch (frame.type) {
      case 'state':
        this.#handleState(frame);
        return;
      case 'grant':
        this.#handleGrant(socket, frame);
        return;
      case 'event':
        this.#handleEvent(frame);
        return;
      case 'done': {
        const entry = this.#requests.get(String(frame.id));
        if (!entry) return;
        const ok = frame.ok === true;
        const value = ok ? (frame.value ?? null) : modelProxyErrorFromWire(frame.error);
        entry.queue.then(() => this.#settle(entry, ok, value));
        return;
      }
      case 'error':
        this.#drop(socket, unavailable(`the model proxy bridge refused the connection (${logField(frame.code)})`));
        return;
      default:
    }
  }

  #handleState(frame) {
    const connected = frame.connected === true;
    const generation = frame.generation;
    if (!this.#authenticated) {
      this.#authenticated = true;
      this.#upstream = connected;
      this.#upstreamGeneration = generation;
      this.#generation += 1;
      const attempt = this.#connecting;
      this.#connecting = null;
      clearTimeout(attempt?.timer);
      attempt?.resolve();
      this.#updateRef();
      this.#notifyChange();
      return;
    }
    if (connected === this.#upstream && generation === this.#upstreamGeneration) return;
    this.#upstream = connected;
    this.#upstreamGeneration = generation;
    this.#generation += 1;
    this.#notifyChange();
  }

  #handleEvent(frame) {
    const entry = this.#requests.get(String(frame.id));
    const seq = frame.seq;
    if (!entry) {
      // Given up here: answer at once so the daemon never waits out the ack.
      this.#write({
        type: 'result',
        id: frame.id,
        seq,
        ok: false,
        error: modelProxyErrorToWire(abortError('model call aborted')),
      });
      return;
    }
    const run = async () => {
      const callback = entry.callbacks[String(frame.name || '')];
      let reply;
      try {
        const args = Array.isArray(frame.args) ? frame.args : [];
        const value = typeof callback === 'function' ? await callback(...args) : null;
        reply = { type: 'result', id: entry.id, seq, ok: true, value: modelProxyWireValue(value) ?? null };
      } catch (error) {
        reply = { type: 'result', id: entry.id, seq, ok: false, error: modelProxyErrorToWire(error) };
      }
      if (Buffer.byteLength(JSON.stringify(reply)) + 1 > MODEL_PROXY_BRIDGE_LIMITS.controlFrameMaxBytes) {
        const error = bridgeError('MODEL_PROXY_BRIDGE_RESULT_TOO_LARGE', 'a callback result exceeds the bridge limit');
        reply = { type: 'result', id: entry.id, seq, ok: false, error: modelProxyErrorToWire(error) };
      }
      this.#write(reply);
    };
    entry.queue = entry.queue.then(run, run);
  }

  #write(frame) {
    if (!this.#socket || !this.#authenticated) return;
    this.#socket.write(`${JSON.stringify(frame)}\n`);
  }

  #settle(entry, ok, value) {
    if (entry.settled) return;
    entry.settled = true;
    entry.line = null;
    this.#requests.delete(entry.id);
    if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    entry.callbacks = {};
    this.#updateRef();
    if (ok) entry.resolve(value);
    else entry.reject(value);
  }

  #drop(socket, error) {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#lines = null;
    socket.destroy();
    const wasAuthenticated = this.#authenticated;
    this.#authenticated = false;
    this.#upstream = false;
    this.#upstreamGeneration = null;
    if (wasAuthenticated) this.#generation += 1;
    const attempt = this.#connecting;
    this.#connecting = null;
    if (attempt) {
      clearTimeout(attempt.timer);
      attempt.reject(error);
    }
    for (const entry of [...this.#requests.values()]) this.#settle(entry, false, error);
    this.#notifyChange();
  }

  /** The socket keeps the process alive only while something waits on it. */
  #updateRef() {
    if (!this.#socket) return;
    if (this.#connecting || this.#requests.size || this.#changeWaiters.size) this.#socket.ref();
    else this.#socket.unref();
  }

  #waitForChange(ms) {
    return new Promise((resolve) => {
      const waiter = () => {
        clearTimeout(timer);
        this.#changeWaiters.delete(waiter);
        this.#updateRef();
        resolve();
      };
      const timer = setTimeout(waiter, ms);
      this.#changeWaiters.add(waiter);
      this.#updateRef();
    });
  }

  #notifyChange() {
    for (const waiter of [...this.#changeWaiters]) waiter();
  }

  #withTimeout(promise, ms) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(unavailable('the model proxy bridge did not answer in time')), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }
}
