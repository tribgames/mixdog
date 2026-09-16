// Frame admission, ingress metering, uplink capacity, and oversize signalling.
// Process-wide inflight and
// ingress counters live here; per-socket flow flags stay on the socket.
import { decodeRelayBinaryFrame, RELAY_BINARY_HEADER_BYTES } from './relay-binary-frame.mjs';
import { isRoutingId } from './ids.mjs';

// Forwarding policy ceiling for ONE frame. It matches the desktop leg's own
// budget (apps/desktop/src/main/remote-relay.ts): the media lane is disabled
// there, so gallery originals still ride the RPC fallback as single frames and
// a smaller ceiling here would cut supported traffic. Memory is protected by
// admission control and backpressure below, never by shrinking what a
// supported client is allowed to send.
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
// The transport stop sits ABOVE the policy ceiling on purpose: ws answers an
// oversize frame by killing the connection (1009), which the user only ever
// sees as "relay disconnected". The policy check runs first and answers with a
// payload error on that leg while it stays open.
export const MAX_WS_PAYLOAD_BYTES = MAX_FRAME_BYTES + 4 * 1024 * 1024;
// Upper clamp for the configured capacity. A configured number may only ever
// LOWER what a leg said about itself: capacity is a fact about the receiver, so
// configuration that can raise it is just a version-skew outage with a knob.
export const MAX_UPLINK_CAPACITY_BYTES = MAX_WS_PAYLOAD_BYTES;
// JSON escaping is unbounded in principle: one NUL becomes `\u0000`, six bytes
// for one, so a JSON envelope cannot promise to carry a message of size N. The
// text path is therefore bounded by the WORST case rather than by whatever the
// payload in hand happens to escape to — a ceiling derived from the current
// content is not a ceiling at all, because clients learn it and keep it.
const JSON_ESCAPE_WORST_CASE = 6;
// What a desktop leg is taken to receive until IT says otherwise, on the
// connection in hand. Routing wraps a phone's message in an envelope — a binary
// routing header, or a JSON frame whose string escaping can grow the payload —
// so the bytes this relay SENDS are never the bytes it received, and a message
// that fits this relay's policy can still land past the desktop's cap, where ws
// answers by destroying the socket every phone on that desktop shares.
//
// It is the conservative FLOOR every receiver in this protocol takes, not the
// largest receiver this project ships: a capacity nobody declared is a capacity
// nobody promised. That is what makes this fail-safe by CONSTRUCTION rather
// than by memory — a first connection, a redial and a restarted relay all start
// here, so losing state can never become a trust upgrade for a peer whose
// declaration was false. Small enough that every receiver in this protocol
// takes it, large enough to keep a session working (handshake, RPC, control)
// until the leg states its own number.
export const UNDECLARED_CAPACITY_BYTES = 64 * 1024;
// The smallest capacity this protocol can express. Below the relay's own
// routing envelope nothing can be forwarded at all, and every ceiling derived
// from such a number would be negative and clamped to zero — a published limit
// of "send nothing" that an empty message still overruns. Normalising up to it
// is not a trust upgrade: the relay puts `relay-capabilities` and `client-open`
// on this leg unprompted, both larger than this, so a receiver that cannot take
// it cannot take the protocol either.
const MIN_UPLINK_CAPACITY_BYTES = 1024;

/**
 * Capacity of ONE desktop leg: what that leg declared it can receive on THIS
 * connection, clamped by configuration. A leg that has declared nothing gets
 * the floor, never something roomier — assuming more than a leg can take is
 * what turns a boundary frame into a 1006 for every phone attached to it.
 *
 * This is the ONE place a capacity enters the relay. Both inputs are normalised
 * here — a declaration is a claim made by a peer, a configured value is a claim
 * made by an operator, neither can raise this relay above the largest frame its
 * own protocol works in, and neither is trusted to be a sane number — so every
 * later reader takes a bounded integer and no path can reach a raw one.
 */
export function uplinkCapacityFor(declared, configured = MAX_UPLINK_CAPACITY_BYTES) {
  const ceiling = boundedCapacity(configured, MAX_UPLINK_CAPACITY_BYTES);
  const leg = boundedCapacity(declared, UNDECLARED_CAPACITY_BYTES);
  return Math.min(ceiling, leg);
}

/** Anything malformed — negative, zero, NaN, fractional, absurd — becomes the
 *  caller's fallback rather than being carried onward; anything usable is
 *  bounded at both ends, so every capacity in this file is a whole number
 *  between the protocol minimum and this relay's transport ceiling. */
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

/**
 * The capabilities frame for ONE desktop connection.
 *
 * `textFrames` here is an ACKNOWLEDGEMENT, not a menu: it appears only where
 * this relay will actually carry phone text in the binary envelope for this
 * leg. A desktop cannot infer that from `binaryFrames` — an older relay
 * advertises the very same bit and still JSON-wraps text — and a desktop that
 * guessed would price a 3 KiB text frame at a fixed 42-byte wrapper while the
 * hop it is talking to doubles it.
 *
 * The ceilings ride along because the effective capacity is the relay's to
 * know: it normalises what a leg declares and derives both wire forms from it.
 * Publishing them is what lets both ends reach the same admission decision
 * instead of re-deriving it from different inputs — and they are computed from
 * the very leg state the enforcement path reads, so what is PUBLISHED is what
 * is ENFORCED, on every path, for the life of this connection.
 */
export function relayCapabilities(leg, maxFrameBytes) {
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
  };
}

/** Everything the relay knows about ONE desktop connection's receiver: created
 *  with the socket, written only by that socket's own handler, discarded with
 *  it. Per SOCKET and not per device on purpose — a superseded leg holds a
 *  reference to its own state alone, so a handler still draining bytes from a
 *  dead connection can never move a number the replacement's phones are
 *  measured against. Nothing here outlives the socket, which is what leaves the
 *  relay with no memory of a past failure to spend on a future frame. */
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

/**
 * The largest phone message this leg can carry, per wire form. Both numbers are
 * properties of the PATH (capacity, client id, envelope in use) and never of the
 * message in hand, because this is the figure a client is told and remembers.
 *
 * The binary envelope is a fixed header, so its ceiling is exact. The JSON
 * envelope escapes what it carries, so its ceiling assumes the worst case and
 * the relay refuses anything above it even when that particular payload would
 * have fitted: a limit the relay does not honour in both directions is a limit
 * that strands its clients. A leg that decodes text in the binary envelope
 * (`textFrames`) has no such gap — that is the point of it.
 */
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

// Receive side of the same budget. Outbound bytes are charged when the relay
// hands a frame to a socket, but an ARRIVING frame is already in memory before
// any handler can decide anything: ws assembles the whole message (up to
// maxPayload) per leg on its own, so N authenticated legs are N × maxPayload of
// heap that no admission decision ever sees. Ingress is therefore metered on
// the RAW byte stream: every leg reads freely up to a small window, and a
// message larger than that window needs a reservation out of one box-wide pool.
// A leg that cannot get one is PAUSED — its bytes stay on the sender's side of
// the wire — never cut: waiting for room is not misbehaviour.
// The reservation is the leg's WORST case (the transport ceiling), so reserved
// bytes are always an upper bound on bytes actually assembled.
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
// "Was this message already refused" is a property of the MESSAGE, not of the
// leg: several messages can arrive in one read, so the answers queue up in
// delivery order. The cap only bounds an absurd backlog; ws delivers within the
// same read, so the queue is normally one entry deep.
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

/** A leg's read state has two independent owners — its own uplink backlog and
 *  box-level ingress admission — so the socket is read again only when NEITHER
 *  wants it parked. Merging them here is what keeps one lifting the other's
 *  pause by accident. */
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
  if (!socket || !socket.legPausedUplink) return;
  socket.legPausedUplink = false;
  clearTimeout(socket.legResumeTimer);
  socket.legResumeTimer = null;
  applyLegFlow(socket);
}

/** Meter one leg's arriving bytes off the RAW socket: once ws has assembled a
 *  message the memory is already spent, so every decision has to happen while
 *  the frame is still on the wire.
 *
 *  The meter reads the WebSocket FRAMING instead of counting raw bytes, which
 *  is what makes it comparable to the application:
 *   - a frame header DECLARES its payload length, so the exact size of the
 *     message is known before its bytes arrive (a refusal can quote the final
 *     size, and an exact-limit frame is never mistaken for an oversize one);
 *   - header and mask bytes are transport overhead and never counted against
 *     an application ceiling;
 *   - control frames (ping/pong/close) carry no message bytes at all, so a
 *     burst of them cannot look like one endless partial frame.
 *  Valid because this relay disables permessage-deflate: the declared length IS
 *  the application payload length. */
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
    // Unmasked prefix of the message on the wire, kept so a refusal can be
    // attributed from the envelope's OWN head — including a fragmented one,
    // whose refusal is only decided several fragments later. One buffer per
    // leg, reused per message.
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

/** Walk one raw chunk as WebSocket frames. The whole chunk is always accounted
 *  for, including after a park: pausing stops the NEXT read, while these bytes
 *  are already on their way to ws, and a meter that skipped them would lose the
 *  frame boundary for good. */
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
    if (state.headerBytes === 2) {
      const marker = state.header[1] & 0x7f;
      state.headerNeeded =
        2 + (marker === 126 ? 2 : marker === 127 ? 8 : 0) + ((state.header[1] & 0x80) === 0x80 ? 4 : 0);
    }
    if (state.headerBytes < state.headerNeeded) continue;
    startIngressFrame(socket);
    if (state.payloadRemaining === 0) finishIngressFrame(socket);
  }
}

/** A frame header is complete: commit what it declares. */
function startIngressFrame(socket) {
  const state = socket.ingress;
  const header = state.header;
  const opcode = header[0] & 0x0f;
  const masked = (header[1] & 0x80) === 0x80;
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
  state.mask = masked ? Buffer.from(header.subarray(cursor, cursor + 4)) : null;
  state.control = opcode >= 0x8;
  state.fin = (header[0] & 0x80) === 0x80;
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
  // Refuse at DECLARATION only for a message the transport can never deliver:
  // past ws's own ceiling the socket is destroyed (1009) and the user is told
  // nothing but "relay disconnected", so this is the last moment anything can
  // be said about it. Continuations count — a fragmented message overruns that
  // ceiling on a later fragment, never on its first.
  //
  // Everything the transport can still carry is refused on DELIVERY instead,
  // where the size is the assembled message's own. A declaration is a promise,
  // not a message: a sender that announces 5 KiB and then stops must not
  // produce a notice describing bytes that never arrived.
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

/** Keep the unmasked head of the message on the wire — its envelope, never its
 *  payload. It is captured from the message's FIRST bytes because a refusal can
 *  be decided much later (a fragmented message overruns the transport on a
 *  fragment that is nowhere near the envelope), and an id read from the middle
 *  of a payload is exactly the attribution this relay refuses to guess at. */
function captureIngressHead(state, chunk, offset, take) {
  if (state.headLength >= OVERSIZE_ID_SCAN_BYTES) return;
  const wanted = Math.min(take, OVERSIZE_ID_SCAN_BYTES - state.headLength);
  for (let index = 0; index < wanted; index += 1) {
    const byte = chunk[offset + index];
    state.head[state.headLength] = state.mask ? byte ^ state.mask[(state.payloadSeen + index) % 4] : byte;
    state.headLength += 1;
  }
}

/** Send the refusal for the message on the wire once enough of its prefix is in
 *  hand to name the client it belongs to (or once the frame ends without one).
 *  Attribution is read, never guessed: an id the relay cannot establish is
 *  omitted so the desktop fails nothing rather than the wrong call. */
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
  // The message is complete on the wire and ws is about to deliver it. Whether
  // it was already refused belongs to THAT message: a single flag would be
  // overwritten by the next message's header when both arrive in one read, and
  // the delivered one would then be refused a second time.
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

/** ws delivered a message: this leg's reservation goes back. The wire meter has
 *  already retired the bytes, so nothing is inferred from the payload here.
 *  Returns whether THIS message was already refused while it was arriving —
 *  one queued answer per completed message, taken in delivery order, so the
 *  delivered path never sends a second notice for the same message. */
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
  // This leg just lost a state push. Waiting for the NEXT patch to expose the
  // gap strands it whenever the turn ends here — the phone would keep showing a
  // transcript without the answer that landed while it was congested. One hint
  // (sent once per congestion window) makes it ask for a full snapshot as soon
  // as it drains.
  if (phone.resyncHinted) return;
  phone.resyncHinted = true;
  try {
    phone.send('{"resync":1}');
  } catch {
    /* phone vanished */
  }
}

/** Desktop -> phone. Admission is per phone leg, so a congested phone never
 *  slows the shared desktop socket or a sibling phone.
 *
 *  `pressure` says what a BOX-level refusal means for THIS leg. `'cut'` is the
 *  single-leg path: the ceiling is filled by other conversations and this leg
 *  is asking for more than the box can carry. `'defer'` is the fan-out path,
 *  where the ceiling is filled by the very loop this leg is sitting in — no
 *  flush callback can release until the loop ends, so the legs at the back
 *  would be cut for bytes the legs at the front are still holding. A leg that
 *  has shown no congestion of its own is never closed for that: it keeps its
 *  socket and is told to resync once the box has room. */
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

/** Phone -> desktop. The bytes are charged to the desktop socket that holds
 *  them, while the pause is applied to the PRODUCING phone leg and lifted by
 *  that same leg's flush — one phone can neither outrun the desktop nor stall
 *  another phone. */
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

/** One frame against the forwarding policy. Over the ceiling the sender gets a
 *  payload error and KEEPS its leg: tearing the socket down for one bad frame
 *  surfaces to the user as a relay outage. `announced` means the ingress meter
 *  already answered this message while it was still arriving. */
export function rejectOversizeFrame(socket, raw, limit, announced = false, binary = false) {
  const size = frameBytes(raw);
  if (size <= limit) return false;
  // The wire form travels with the refusal: it decides which ROUTER would have
  // carried this frame, and therefore which one gets to name its client.
  if (!announced) socket.oversizeSignal?.(size, limit, raw, binary);
  return true;
}

// Nothing in this file OBSERVES a failure to decide a later limit, and there is
// no second admission gate behind the per-form ceilings above.
//
// A close carries no evidence of WHICH frame a receiver refused, so a capacity
// derived from one is a guess charged to whichever client happened to be
// sending: that mechanism shrank a sibling phone's path over an attacker's
// frame, turned an unrelated 1009 into a refusal for an honest leg, and made a
// relay restart a trust upgrade for a peer that had declared falsely. So the
// relay keeps NO record of a send, a close code, or a past declaration. Every
// limit comes from the declaration in force on the connection the frame is
// about to be sent on, and from nothing else.
//
// What replaces it is arithmetic. A message admitted under `uplinkCeilings`
// fits its envelope by construction — the binary form adds a fixed header, the
// JSON form adds a fixed base plus at most six bytes per byte — and a
// normalised capacity is never smaller than that envelope, so an admitted frame
// cannot overrun the receiver its own leg declared. A leg that declares more
// than it can take still dies of its own claim, exactly once, on the connection
// that made it: the phones keep their sockets, no client is accused, and the
// next connection is judged only by what it says for itself.

/** Oversize toward a PHONE leg. Everything on that leg is E2EE ciphertext and
 *  the shim handles exactly two CLEARTEXT keys before decryption
 *  (apps/desktop/src/renderer/remote-shim.ts:1199-1209 — `pong` and `resync`);
 *  any other cleartext object is handed to decryptJson, throws, and closes the
 *  socket. So the refusal rides the `resync` key: a shim that predates this
 *  frame recovers with a resync instead of disconnecting, and one that reads
 *  `error` fails the oversize call with a payload error the user can act on.
 *  A raw (non-E2EE) phone takes the same branch before any dispatch. */
export function signalPhoneOversize(socket, bytes, limit) {
  try {
    socket.send(
      JSON.stringify({
        resync: 1,
        error: 'frame-too-large',
        bytes,
        // The stable ceiling of this path in this wire form — the same number the
        // desktop leg was published, and the only figure a client may keep. A
        // per-payload measurement would have a client refusing traffic this relay
        // would have carried.
        limit,
      })
    );
  } catch {
    /* peer vanished */
  }
}

/** Oversize toward the DESKTOP leg. The desktop is what answers phone RPCs, so
 *  name the client whose call produced the refused frame whenever that can be
 *  read without touching the payload: only the desktop can hand that phone an
 *  answer it is able to decrypt. */
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

/** Name the client a refused frame belongs to — and name one ONLY when that is
 *  the client the frame's OWN router would have delivered it to.
 *
 *  Each wire form is answered by the decoder that routes it. A binary frame
 *  carries its id in a fixed header and is decoded by `decodeRelayBinaryFrame`,
 *  the same call that routes it, so bytes that decoder refuses — JSON-shaped
 *  bytes sent on the binary lane, a bad magic, an id of the wrong length —
 *  reach no client and are attributed to none. A text frame is routed by
 *  `JSON.parse`, so that is what reads its id.
 *
 *  Attribution is a courtesy on a frame being thrown away: a misattributed
 *  refusal makes the desktop fail somebody else's call, while an unattributed
 *  one it treats as "not mine to fail". Naming nobody is always available, so
 *  every uncertainty resolves that way. */
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

/** The `clientId` this frame would be ROUTED to, or '' when it would be routed
 *  to nobody.
 *
 *  It is the router's decision, taken with the router's own tool. The text lane
 *  routes by `JSON.parse` (`runDesktopLeg` in server.mjs) and reads `clientId` off the
 *  result, so every question about what JSON accepts — duplicate keys, escapes,
 *  control bytes, primitive tokens, matching delimiters, trailing bytes — is
 *  answered by the parser instead of being re-litigated here. Every re-
 *  implementation of that answer this relay has tried diverged from it
 *  somewhere, and each divergence named an innocent client.
 *
 *  A frame the parser rejects, one that is not an object, and one whose id is
 *  not an id this relay hands out are all attributed to nobody. No size bound
 *  guards this: the transport already destroys anything past its own ceiling,
 *  and the routing path parses the very same bytes, so refusing to parse here
 *  would only un-attribute refusals the router itself can attribute. */
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
