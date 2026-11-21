// Frame admission, ingress metering, uplink capacity, and oversize signalling.
// Process-wide inflight and ingress counters live here; per-socket flow flags
// stay on the socket.
import { decodeRelayBinaryFrame, RELAY_BINARY_HEADER_BYTES } from './relay-binary-frame.mjs';
import { isRoutingId } from './ids.mjs';

// Matches the desktop leg's budget (apps/desktop/src/main/remote-relay.ts): the media lane is disabled there, so gallery originals ride the RPC fallback as single frames.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
// ws destroys the connection (1009) on an oversize frame, so this sits above MAX_FRAME_BYTES and the policy check answers first.
export const MAX_WS_PAYLOAD_BYTES = MAX_FRAME_BYTES + 4 * 1024 * 1024;
// Upper clamp for the configured capacity. A configured number may only ever
// LOWER what a leg said about itself: capacity is a fact about the receiver, so
// configuration that can raise it is just a version-skew outage with a knob.
export const MAX_UPLINK_CAPACITY_BYTES = MAX_WS_PAYLOAD_BYTES;
// One NUL escapes to `\u0000`: six bytes for one.
const JSON_ESCAPE_WORST_CASE = 6;
// Floor capacity that every receiver in this protocol takes.
export const UNDECLARED_CAPACITY_BYTES = 64 * 1024;
// Smallest capacity that holds the relay's own `relay-capabilities` and `client-open` frames.
const MIN_UPLINK_CAPACITY_BYTES = 1024;

/** Capacity of one desktop leg: the declared value clamped by configuration, the floor when nothing was declared. */
export function uplinkCapacityFor(declared, configured = MAX_UPLINK_CAPACITY_BYTES) {
  const ceiling = boundedCapacity(configured, MAX_UPLINK_CAPACITY_BYTES);
  const leg = boundedCapacity(declared, UNDECLARED_CAPACITY_BYTES);
  return Math.min(ceiling, leg);
}

/** A whole number within [MIN_UPLINK_CAPACITY_BYTES, MAX_UPLINK_CAPACITY_BYTES]; `fallback` for anything non-finite or not positive. */
export function boundedCapacity(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const whole = Math.floor(number);
  if (whole <= 0) return fallback;
  return Math.min(Math.max(whole, MIN_UPLINK_CAPACITY_BYTES), MAX_UPLINK_CAPACITY_BYTES);
}

// Every phone leg is routed by a randomUUID(), so envelope overhead is the same
// for all of them. This stand-in exists only to publish that overhead as a
// number, without naming a live client.
const CANONICAL_CLIENT_ID = '00000000-0000-4000-8000-000000000000';

/** The relay-capabilities frame for one desktop connection. `textFrames` is set only when the relay carries phone text in the binary envelope on this leg. */
export function relayCapabilities(leg, maxFrameBytes, nativePushPlatforms = [], webPush = false, ice = false) {
  const acknowledged = leg.textFrames === true;
  const ceilings = uplinkCeilings({
    capacity: leg.capacity,
    clientId: CANONICAL_CLIENT_ID,
    textFrames: acknowledged,
    policy: maxFrameBytes,
  });
  return {
    type: 'relay-capabilities',
    binaryFrames: 1,
    maxFrameBytes,
    ...(acknowledged ? { textFrames: 1 } : {}),
    uplinkCapacityBytes: leg.capacity,
    uplinkBinaryCeilingBytes: ceilings.binary,
    uplinkTextCeilingBytes: ceilings.text,
    // Present only when this relay holds APNs/FCM credentials: a desktop
    // advertises native push to its phones only if the relay can deliver it.
    ...(nativePushPlatforms.length > 0 ? { nativePush: 1, nativePushPlatforms: [...nativePushPlatforms] } : {}),
    // Present when this relay owns the Web Push sender identity: the desktop
    // then delivers browser push through `webpush-send` (lib/web-push-legs.mjs)
    // instead of posting to the push service itself.
    ...(webPush ? { webPush: 1 } : {}),
    // Present when this relay can issue TURN credentials (lib/ice-legs.mjs):
    // the desktop asks only a relay that says so.
    ...(ice ? { ice: 1 } : {}),
  };
}

/** Receiver state of one desktop connection, owned by that socket and discarded with it. */
export function newUplinkLeg(capacityCeiling) {
  return {
    capacityCeiling,
    // Until THIS connection declares: the floor. Never what an earlier
    // connection said, never what an earlier failure suggested.
    capacity: uplinkCapacityFor(undefined, capacityCeiling),
    textFrames: false,
    // The capabilities frame last published on this socket, so a declaration
    // that moves the numbers is answered and one that changes nothing is not.
    published: '',
  };
}

/** Take this connection's declaration: normalised once, written to the state of
 *  the socket that made it. */
export function declareUplinkLeg(leg, declared, textFrames) {
  leg.capacity = uplinkCapacityFor(declared, leg.capacityCeiling);
  leg.textFrames = textFrames === true;
}

/** Largest phone message this leg carries per wire form; the JSON ceiling assumes worst-case escaping. */
export function uplinkCeilings({
  capacity = UNDECLARED_CAPACITY_BYTES,
  clientId = '',
  textFrames = false,
  policy = MAX_FRAME_BYTES,
}) {
  const binaryBase = RELAY_BINARY_HEADER_BYTES + Buffer.byteLength(String(clientId));
  const jsonBase = Buffer.byteLength(JSON.stringify({ type: 'frame', clientId, data: '' }));
  const binary = Math.max(0, Math.min(policy, capacity - binaryBase));
  return {
    binary,
    text: textFrames
      ? binary
      : Math.max(0, Math.min(policy, Math.floor((capacity - jsonBase) / JSON_ESCAPE_WORST_CASE))),
  };
}

// Slow-consumer guards: a phone that stops draining would otherwise buffer
// the whole push stream in relay memory (1GB box, thousands of legs). Pushes
// are recoverable (state resync + terminal repaint) so they drop first.
const SKIP_PUSH_BUFFER_BYTES = 1024 * 1024;
// Per-leg queue budgets. A leg with an EMPTY queue may always take one frame of
// any supported size; these bound accumulation on a leg that is not draining,
// and admission runs before the enqueue so nothing overshoots by a full frame.
const PHONE_QUEUE_LIMIT_BYTES = 8 * 1024 * 1024;
const UPLINK_QUEUE_LIMIT_BYTES = 8 * 1024 * 1024;
// Self-throttle for the phone -> desktop direction: a phone stops being READ
// while its OWN frames are outstanding. The state is per leg, so one slow phone
// never stalls a sibling leg or the shared desktop socket.
const UPLINK_PAUSE_BYTES = 2 * 1024 * 1024;
// The pause lifts on that leg's own flush callback; this is the safety net for
// a callback that never arrives (peer died mid-write).
const LEG_RESUME_TIMEOUT_MS = 10_000;
// Box-level ceiling across every leg: per-leg budgets bound one conversation,
// this bounds the process, so N congested legs cannot add up to the heap.
export const MAX_INFLIGHT_BYTES = 128 * 1024 * 1024;

// Bytes handed to sockets that have not flushed them yet.
let inflightBytes = 0;

export function relayInflightBytes() {
  return inflightBytes;
}

export const INGRESS_RESERVATION_BYTES = MAX_WS_PAYLOAD_BYTES;
export const MAX_INGRESS_BYTES = 2 * INGRESS_RESERVATION_BYTES;
export const INGRESS_FREE_WINDOW_BYTES = 256 * 1024;
// The meter reads WebSocket framing rather than counting raw bytes, so it needs
// the header window: 2 bytes of prefix, up to 8 more for an extended length,
// and a 4-byte mask key on every client -> server frame.
const WS_MAX_HEADER_BYTES = 14;
// How much of a refused frame's payload is read to name the client it belongs
// to: the binary routing header, or the head of a JSON envelope. Bounded on
// purpose — the id has to be readable without ever holding the payload.
const OVERSIZE_ID_SCAN_BYTES = 512;
const MAX_ANNOUNCED_QUEUE = 256;
// A holder that stops making progress pins box memory for a peer that went
// quiet mid-frame; a parked leg cannot answer a ping while it is not read.
// Both are bounded on the heartbeat sweep.
export const INGRESS_STALL_TIMEOUT_MS = 30_000;
export const INGRESS_WAIT_TIMEOUT_MS = 60_000;

let ingressReservedBytes = 0;
let ingressPeakBytes = 0;
let ingressDeferrals = 0;
// FIFO: the leg that has waited longest takes the next reservation, so a busy
// box cannot starve one conversation indefinitely.
const ingressWaiting = [];

export function relayIngressStats() {
  return {
    reserved: ingressReservedBytes,
    peak: ingressPeakBytes,
    waiting: ingressWaiting.length,
    deferrals: ingressDeferrals,
  };
}

export function resetRelayIngressStats() {
  ingressPeakBytes = ingressReservedBytes;
  ingressDeferrals = 0;
}

/**
 * Ingress decision for ONE leg, taken while its message is still arriving.
 * `'read'` keeps reading, `'reserve'` charges this leg's worst case to the box
 * pool, `'wait'` parks the leg until the pool has room for it.
 */
export function admitIngress({
  pending = 0,
  holding = false,
  window = INGRESS_FREE_WINDOW_BYTES,
  reservation = INGRESS_RESERVATION_BYTES,
  reserved = 0,
  ceiling = MAX_INGRESS_BYTES,
}) {
  if (holding || pending <= window) return 'read';
  return reserved + reservation > ceiling ? 'wait' : 'reserve';
}

function frameBytes(data) {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (data && typeof data.byteLength === 'number') return data.byteLength;
  if (data && typeof data.length === 'number') return data.length;
  return 0;
}

/**
 * Admission decision for one frame on one leg, before anything is enqueued.
 * `'send'` hands it over, `'drop'` skips a recoverable push, `'slow'` cuts a leg
 * that is not draining, `'busy'` cuts one the box can no longer carry.
 */
export function admitFrame({
  queued = 0,
  size = 0,
  budget = PHONE_QUEUE_LIMIT_BYTES,
  droppable = false,
  inflight = 0,
  ceiling = MAX_INFLIGHT_BYTES,
}) {
  if (inflight + size > ceiling) return droppable ? 'drop' : 'busy';
  // An idle leg may always take one frame: the budget bounds ACCUMULATION, not
  // the payload size a supported client is allowed to send.
  if (queued > 0 && queued + size > budget) return droppable ? 'drop' : 'slow';
  return 'send';
}

/** Charge one frame to the socket holding it; the returned release runs when
 *  the frame flushes (ws always calls the callback, including on failure). */
function chargeFrame(socket, size) {
  socket.pendingBytes = (socket.pendingBytes || 0) + size;
  socket.pendingEpoch = socket.pendingEpoch || 0;
  const epoch = socket.pendingEpoch;
  inflightBytes += size;
  let released = false;
  return () => {
    if (released || socket.pendingEpoch !== epoch) return;
    released = true;
    socket.pendingBytes = Math.max(0, socket.pendingBytes - size);
    inflightBytes = Math.max(0, inflightBytes - size);
  };
}

/** A leg that goes away takes its outstanding charge with it: callbacks for
 *  frames it never flushed would otherwise never run. The epoch bump makes the
 *  stale releases no-ops so the counter cannot drift. */
export function releaseLeg(socket) {
  inflightBytes = Math.max(0, inflightBytes - (socket.pendingBytes || 0));
  socket.pendingBytes = 0;
  socket.pendingEpoch = (socket.pendingEpoch || 0) + 1;
}

function applyLegFlow(socket) {
  const parked = Boolean(socket.legPausedUplink || socket.legPausedIngress);
  if (parked === Boolean(socket.legParked)) return;
  socket.legParked = parked;
  try {
    if (parked) socket.pause();
    else socket.resume();
  } catch {
    socket.legParked = !parked;
  }
}

/** Stop reading from ONE leg until its own frames flush. */
function pauseLeg(socket) {
  if (!socket || socket.legPausedUplink) return;
  socket.legPausedUplink = true;
  applyLegFlow(socket);
  socket.legResumeTimer = setTimeout(() => resumeLeg(socket), LEG_RESUME_TIMEOUT_MS);
  socket.legResumeTimer.unref?.();
}

function resumeLeg(socket) {
  if (!socket?.legPausedUplink) return;
  socket.legPausedUplink = false;
  clearTimeout(socket.legResumeTimer);
  socket.legResumeTimer = null;
  applyLegFlow(socket);
}

/** Meter a leg's arriving bytes off the raw socket by reading WebSocket framing: the header declares the payload length, and header, mask and control-frame bytes are not counted. Exact because permessage-deflate is disabled. */
export function trackLegIngress(socket, rawSocket, options = {}) {
  const {
    ceiling = MAX_INGRESS_BYTES,
    reservation = INGRESS_RESERVATION_BYTES,
    window = INGRESS_FREE_WINDOW_BYTES,
    limit = MAX_FRAME_BYTES,
    transport = MAX_WS_PAYLOAD_BYTES,
  } = options;
  const state = {
    // Application bytes committed to the message currently on the wire.
    pending: 0,
    holding: false,
    waiting: false,
    announced: false,
    // One entry per message that completed on the wire, in delivery order.
    announcedQueue: [],
    progressAt: Date.now(),
    waitingSince: 0,
    ceiling,
    reservation,
    window,
    limit,
    transport,
    // WebSocket frame cursor.
    header: Buffer.allocUnsafe(WS_MAX_HEADER_BYTES),
    headerBytes: 0,
    headerNeeded: 2,
    payloadRemaining: 0,
    payloadSeen: 0,
    mask: null,
    control: false,
    fin: false,
    messageBinary: false,
    head: Buffer.allocUnsafe(OVERSIZE_ID_SCAN_BYTES),
    headLength: 0,
    refusalDue: false,
    refusalBytes: 0,
  };
  socket.ingress = state;
  if (!rawSocket || typeof rawSocket.prependListener !== 'function') return;
  rawSocket.prependListener('data', (chunk) => {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
    consumeIngressBytes(socket, chunk);
  });
}

function consumeIngressBytes(socket, chunk) {
  const state = socket.ingress;
  let offset = 0;
  while (offset < chunk.length) {
    if (state.payloadRemaining > 0) {
      const take = Math.min(state.payloadRemaining, chunk.length - offset);
      captureIngressHead(state, chunk, offset, take);
      state.payloadSeen += take;
      state.payloadRemaining -= take;
      offset += take;
      state.progressAt = Date.now();
      flushIngressRefusal(socket);
      if (state.payloadRemaining === 0) finishIngressFrame(socket);
      continue;
    }
    const take = Math.min(state.headerNeeded - state.headerBytes, chunk.length - offset);
    chunk.copy(state.header, state.headerBytes, offset, offset + take);
    state.headerBytes += take;
    offset += take;
    if (state.headerBytes === 2) state.headerNeeded = frameHeaderLength(state.header);
    if (state.headerBytes < state.headerNeeded) continue;
    startIngressFrame(socket);
    if (state.payloadRemaining === 0) finishIngressFrame(socket);
  }
}

function frameHeaderLength(header) {
  const marker = header[1] & 0x7f;
  let extendedLengthBytes = 0;
  if (marker === 126) extendedLengthBytes = 2;
  else if (marker === 127) extendedLengthBytes = 8;
  const maskBytes = (header[1] & 0x80) === 0x80 ? 4 : 0;
  return 2 + extendedLengthBytes + maskBytes;
}

function decodeFrameHeader(header) {
  const marker = header[1] & 0x7f;
  let length = marker;
  let cursor = 2;
  if (marker === 126) {
    length = header.readUInt16BE(2);
    cursor = 4;
  } else if (marker === 127) {
    length = Number(header.readBigUInt64BE(2));
    cursor = 10;
  }
  return {
    opcode: header[0] & 0x0f,
    fin: (header[0] & 0x80) === 0x80,
    length,
    mask: (header[1] & 0x80) === 0x80 ? Buffer.from(header.subarray(cursor, cursor + 4)) : null,
  };
}

/** A frame header is complete: commit what it declares. */
function startIngressFrame(socket) {
  const state = socket.ingress;
  const { opcode, fin, length, mask } = decodeFrameHeader(state.header);
  state.mask = mask;
  state.control = opcode >= 0x8;
  state.fin = fin;
  state.payloadRemaining = length;
  state.payloadSeen = 0;
  state.headerBytes = 0;
  state.headerNeeded = 2;
  // Control frames are answered by ws itself and never become a message: they
  // hold no memory, so they are charged nothing.
  if (state.control) return;
  if (opcode !== 0x0) {
    // A new message starts here; a continuation adds to the one in progress.
    state.pending = 0;
    state.announced = false;
    state.headLength = 0;
    state.refusalDue = false;
    // Which wire form this message arrived in decides which ceiling applies to
    // it, and a continuation inherits the one its first frame set.
    state.messageBinary = opcode === 0x2;
  }
  state.pending += length;
  // ws destroys the socket (1009) past its own ceiling, so a message over `transport` is refused at declaration, continuations included; anything smaller is refused on delivery.
  if (!state.announced && state.pending > state.transport) {
    state.announced = true;
    state.refusalDue = true;
    // This frame's declared bytes plus every fragment already declared for the
    // same message: what the sender committed to before the transport gave up.
    state.refusalBytes = state.pending;
  }
  evaluateLegIngress(socket);
  // A fragmented message already has its head captured, so its refusal can go
  // out now instead of waiting for payload that ws will never accept.
  flushIngressRefusal(socket);
}

function captureIngressHead(state, chunk, offset, take) {
  if (state.headLength >= OVERSIZE_ID_SCAN_BYTES) return;
  const wanted = Math.min(take, OVERSIZE_ID_SCAN_BYTES - state.headLength);
  for (let index = 0; index < wanted; index += 1) {
    const byte = chunk[offset + index];
    state.head[state.headLength] = state.mask ? byte ^ state.mask[(state.payloadSeen + index) % 4] : byte;
    state.headLength += 1;
  }
}

function flushIngressRefusal(socket, frameEnded = false) {
  const state = socket.ingress;
  if (!state.refusalDue) return;
  if (!frameEnded && state.headLength < OVERSIZE_ID_SCAN_BYTES) return;
  state.refusalDue = false;
  const head = state.headLength > 0 ? state.head.subarray(0, state.headLength) : null;
  // Quote the ceiling this leg would enforce for a message of THIS wire form,
  // so every refusal a client sees names the same number it can keep.
  const limit = socket.oversizeLimitFor ? socket.oversizeLimitFor(state.messageBinary) : state.limit;
  socket.oversizeSignal?.(state.refusalBytes, limit, head, state.messageBinary);
}

function finishIngressFrame(socket) {
  const state = socket.ingress;
  state.mask = null;
  if (state.control) return;
  flushIngressRefusal(socket, true);
  if (!state.fin) return;
  state.announcedQueue.push(state.announced);
  if (state.announcedQueue.length > MAX_ANNOUNCED_QUEUE) state.announcedQueue.shift();
  state.announced = false;
  // The bytes stop being in flight here; the reservation goes back on delivery.
  state.pending = 0;
}

function evaluateLegIngress(socket) {
  const state = socket.ingress;
  if (!state || socket.readyState !== socket.OPEN) return;
  const decision = admitIngress({
    pending: state.pending,
    holding: state.holding,
    window: state.window,
    reservation: state.reservation,
    reserved: ingressReservedBytes,
    ceiling: state.ceiling,
  });
  if (decision === 'read') {
    state.progressAt = Date.now();
    return;
  }
  if (decision === 'reserve') {
    takeIngressReservation(socket);
    return;
  }
  parkForIngress(socket);
}

function takeIngressReservation(socket) {
  const state = socket.ingress;
  if (!state || state.holding) return;
  state.holding = true;
  state.progressAt = Date.now();
  ingressReservedBytes += state.reservation;
  if (ingressReservedBytes > ingressPeakBytes) ingressPeakBytes = ingressReservedBytes;
}

function parkForIngress(socket) {
  const state = socket.ingress;
  if (!state || state.waiting) return;
  state.waiting = true;
  state.waitingSince = Date.now();
  ingressDeferrals += 1;
  ingressWaiting.push(socket);
  socket.legPausedIngress = true;
  applyLegFlow(socket);
}

/** Give the pool back and wake whoever has waited longest for it. */
function releaseIngressReservation(socket) {
  const state = socket.ingress;
  if (!state?.holding) return;
  state.holding = false;
  ingressReservedBytes = Math.max(0, ingressReservedBytes - state.reservation);
  pumpIngressWaiting();
}

function pumpIngressWaiting() {
  while (ingressWaiting.length > 0) {
    const socket = ingressWaiting[0];
    const state = socket.ingress;
    if (!state?.waiting || socket.readyState !== socket.OPEN) {
      ingressWaiting.shift();
      if (state) state.waiting = false;
      continue;
    }
    if (ingressReservedBytes + state.reservation > state.ceiling) return;
    ingressWaiting.shift();
    state.waiting = false;
    takeIngressReservation(socket);
    socket.legPausedIngress = false;
    applyLegFlow(socket);
  }
}

/** Returns whether this message was already refused while arriving; one queued answer per completed message, in delivery order. */
export function noteIngressDelivery(socket) {
  const state = socket.ingress;
  if (!state) return false;
  state.progressAt = Date.now();
  releaseIngressReservation(socket);
  return state.announcedQueue.length > 0 ? state.announcedQueue.shift() : false;
}

/** A leg that goes away (or is cut) hands its slice of the pool back, and the
 *  next waiter takes it. */
export function releaseIngressLeg(socket) {
  const state = socket.ingress;
  if (!state) return;
  if (state.waiting) {
    state.waiting = false;
    const index = ingressWaiting.indexOf(socket);
    if (index >= 0) ingressWaiting.splice(index, 1);
  }
  state.pending = 0;
  socket.legPausedIngress = false;
  applyLegFlow(socket);
  releaseIngressReservation(socket);
}

function closeLeg(socket, decision) {
  const busy = decision === 'busy';
  try {
    socket.close(busy ? 4009 : 4008, busy ? 'relay busy' : 'slow consumer');
  } catch {
    /* already gone */
  }
}

function hintResync(phone) {
  if (phone.resyncHinted) return;
  phone.resyncHinted = true;
  try {
    phone.send('{"resync":1}');
  } catch {
    /* phone vanished */
  }
}

/** Desktop -> phone, admitted per phone leg. `pressure` 'cut' closes the leg on a box-level refusal; 'defer' (fan-out) keeps a leg with no congestion of its own and hints it to resync. */
export function sendToPhone(phone, data, droppable, pressure = 'cut') {
  if (phone.readyState !== phone.OPEN) return false;
  const queued = phone.bufferedAmount || 0;
  if (droppable && queued > SKIP_PUSH_BUFFER_BYTES) {
    hintResync(phone);
    return false;
  }
  const size = frameBytes(data);
  const decision = admitFrame({
    queued,
    size,
    budget: PHONE_QUEUE_LIMIT_BYTES,
    droppable,
    inflight: inflightBytes,
    ceiling: phone.inflightCeiling || MAX_INFLIGHT_BYTES,
  });
  if (decision === 'drop' || (decision === 'busy' && pressure === 'defer')) {
    hintResync(phone);
    return false;
  }
  if (decision !== 'send') {
    closeLeg(phone, decision);
    return false;
  }
  phone.resyncHinted = false;
  const release = chargeFrame(phone, size);
  try {
    phone.send(data, release);
  } catch {
    release();
  }
  return true;
}

/** Phone -> desktop: bytes are charged to the desktop socket, the pause applies to the producing phone leg and is lifted by its flush. */
export function sendUplink(phone, desktop, payload) {
  if (!desktop || desktop.readyState !== desktop.OPEN) return false;
  const size = frameBytes(payload);
  const queued = phone.uplinkBytes || 0;
  const decision = admitFrame({
    queued,
    size,
    budget: UPLINK_QUEUE_LIMIT_BYTES,
    inflight: inflightBytes,
    ceiling: phone.inflightCeiling || MAX_INFLIGHT_BYTES,
  });
  if (decision !== 'send') {
    closeLeg(phone, decision);
    return false;
  }
  phone.uplinkBytes = queued + size;
  const release = chargeFrame(desktop, size);
  const settle = () => {
    release();
    phone.uplinkBytes = Math.max(0, (phone.uplinkBytes || 0) - size);
    if ((phone.uplinkBytes || 0) <= UPLINK_PAUSE_BYTES) resumeLeg(phone);
  };
  try {
    desktop.send(payload, settle);
  } catch {
    settle();
    return false;
  }
  if (phone.uplinkBytes > UPLINK_PAUSE_BYTES) pauseLeg(phone);
  return true;
}

/** Over `limit` the sender gets a payload error and keeps its leg. `announced`: the ingress meter already answered this message. */
export function rejectOversizeFrame(socket, raw, limit, announced = false, binary = false) {
  const size = frameBytes(raw);
  if (size <= limit) return false;
  // The wire form travels with the refusal: it decides which ROUTER would have
  // carried this frame, and therefore which one gets to name its client.
  if (!announced) socket.oversizeSignal?.(size, limit, raw, binary);
  return true;
}

/** Oversize toward a phone leg. The shim (apps/desktop/src/renderer/remote-shim.ts) accepts only `pong` and `resync` as cleartext keys and closes on any other, so the refusal rides `resync`. */
export function signalPhoneOversize(socket, bytes, limit) {
  try {
    socket.send(
      JSON.stringify({
        resync: 1,
        error: 'frame-too-large',
        bytes,
        limit,
      })
    );
  } catch {
    /* peer vanished */
  }
}

/** At most one desktop-gone notice per phone in this window when it is
 *  triggered by the phone's own frames. */
export const DESKTOP_GONE_NOTICE_INTERVAL_MS = 1_000;

/** Tell a phone its desktop leg is gone with `{"resync":"desktop-gone"}` (the shim drops the socket on any other cleartext key). `throttle` limits a notice provoked by the phone's own frames to one per DESKTOP_GONE_NOTICE_INTERVAL_MS. */
export function signalPhoneDesktopGone(socket, throttle = false) {
  if (socket.readyState !== socket.OPEN) return;
  const now = Date.now();
  if (throttle && now - (socket.desktopGoneAt ?? -Infinity) < DESKTOP_GONE_NOTICE_INTERVAL_MS) return;
  socket.desktopGoneAt = now;
  try {
    socket.send(JSON.stringify({ resync: 'desktop-gone' }));
  } catch {
    /* peer vanished */
  }
}

/** Oversize toward the desktop leg, naming the client whose frame was refused when that is readable without the payload. */
export function signalDesktopOversize(socket, bytes, limit, raw, binary) {
  const clientId = oversizeFrameClientId(raw, binary);
  try {
    socket.send(
      JSON.stringify({
        type: 'frame-too-large',
        ...(clientId ? { clientId } : {}),
        bytes,
        limit,
      })
    );
  } catch {
    /* peer vanished */
  }
}

/** The client a refused frame would have been routed to by its own wire form's router (binary: `decodeRelayBinaryFrame`, text: `JSON.parse`), or '' when none. */
function oversizeFrameClientId(raw, binary = false) {
  if (!Buffer.isBuffer(raw) || raw.length < 8) return '';
  if (binary) {
    // The routing header is fixed-size and sits at the front, so this is
    // settled by the head of the frame however large the frame is.
    const frame = decodeRelayBinaryFrame(raw.subarray(0, Math.min(raw.length, OVERSIZE_ID_SCAN_BYTES)));
    return frame ? frame.clientId : '';
  }
  return routedClientId(raw);
}

/** The `clientId` the text router (`handleDesktopFrame` in relay-legs.mjs) would route this frame to, or '' when it would reach nobody. */
export function routedClientId(bytes) {
  if (!Buffer.isBuffer(bytes)) return '';
  let envelope;
  try {
    // The same decoding the routing path does, on the same bytes.
    envelope = JSON.parse(bytes.toString());
  } catch {
    return '';
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return '';
  // The router looks a client up by this exact string (`entry.clients.get`), so
  // anything that is not one of the ids it hands out reaches nobody and names
  // nobody: a number, an object, a missing key, an id of another shape.
  const { clientId } = envelope;
  return typeof clientId === 'string' && isRoutingId(clientId) ? clientId : '';
}

/** Wrap an event callback so one bad frame cannot take the process down: a
 *  throw inside a socket/server listener is an uncaught exception. */
export function guarded(label, callback) {
  return (...args) => {
    try {
      return callback(...args);
    } catch (error) {
      console.error(`[relay] ${label} failed:`, error?.message || error);
      return undefined;
    }
  };
}
