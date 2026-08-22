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
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { dirname, join, resolve } from 'node:path';
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
import {
  decodeRelayBinaryFrame,
  encodeRelayBinaryFrame,
  RELAY_BINARY_HEADER_BYTES,
} from './lib/relay-binary-frame.mjs';

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
function boundedCapacity(value, fallback) {
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
function relayCapabilities(leg, maxFrameBytes) {
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
function newUplinkLeg(capacityCeiling) {
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
function declareUplinkLeg(leg, declared, textFrames) {
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
const INGRESS_FREE_WINDOW_BYTES = 256 * 1024;
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
const INGRESS_STALL_TIMEOUT_MS = 30_000;
const INGRESS_WAIT_TIMEOUT_MS = 60_000;

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
function releaseLeg(socket) {
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
function trackLegIngress(socket, rawSocket, options = {}) {
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
      state.headerNeeded = 2
        + (marker === 126 ? 2 : marker === 127 ? 8 : 0)
        + ((state.header[1] & 0x80) === 0x80 ? 4 : 0);
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
    state.head[state.headLength] = state.mask
      ? byte ^ state.mask[(state.payloadSeen + index) % 4]
      : byte;
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
  const limit = socket.oversizeLimitFor
    ? socket.oversizeLimitFor(state.messageBinary)
    : state.limit;
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
function noteIngressDelivery(socket) {
  const state = socket.ingress;
  if (!state) return false;
  state.progressAt = Date.now();
  releaseIngressReservation(socket);
  return state.announcedQueue.length > 0 ? state.announcedQueue.shift() : false;
}

/** A leg that goes away (or is cut) hands its slice of the pool back, and the
 *  next waiter takes it. */
function releaseIngressLeg(socket) {
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
  } catch { /* already gone */ }
}

function hintResync(phone) {
  // This leg just lost a state push. Waiting for the NEXT patch to expose the
  // gap strands it whenever the turn ends here — the phone would keep showing a
  // transcript without the answer that landed while it was congested. One hint
  // (sent once per congestion window) makes it ask for a full snapshot as soon
  // as it drains.
  if (phone.resyncHinted) return;
  phone.resyncHinted = true;
  try { phone.send('{"resync":1}'); } catch { /* phone vanished */ }
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
  try { phone.send(data, release); } catch { release(); }
  return true;
}

/** Phone -> desktop. The bytes are charged to the desktop socket that holds
 *  them, while the pause is applied to the PRODUCING phone leg and lifted by
 *  that same leg's flush — one phone can neither outrun the desktop nor stall
 *  another phone. */
function sendUplink(phone, desktop, payload) {
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
function rejectOversizeFrame(socket, raw, limit, announced = false, binary = false) {
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
function signalPhoneOversize(socket, bytes, limit) {
  try {
    socket.send(JSON.stringify({
      resync: 1,
      error: 'frame-too-large',
      bytes,
      // The stable ceiling of this path in this wire form — the same number the
      // desktop leg was published, and the only figure a client may keep. A
      // per-payload measurement would have a client refusing traffic this relay
      // would have carried.
      limit,
    }));
  } catch { /* peer vanished */ }
}

/** Oversize toward the DESKTOP leg. The desktop is what answers phone RPCs, so
 *  name the client whose call produced the refused frame whenever that can be
 *  read without touching the payload: only the desktop can hand that phone an
 *  answer it is able to decrypt. */
function signalDesktopOversize(socket, bytes, limit, raw, binary) {
  const clientId = oversizeFrameClientId(raw, binary);
  try {
    socket.send(JSON.stringify({
      type: 'frame-too-large',
      ...(clientId ? { clientId } : {}),
      bytes,
      limit,
    }));
  } catch { /* peer vanished */ }
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
    const frame = decodeRelayBinaryFrame(
      raw.subarray(0, Math.min(raw.length, OVERSIZE_ID_SCAN_BYTES)),
    );
    return frame ? frame.clientId : '';
  }
  return routedClientId(raw);
}

/** The `clientId` this frame would be ROUTED to, or '' when it would be routed
 *  to nobody.
 *
 *  It is the router's decision, taken with the router's own tool. The text lane
 *  routes by `JSON.parse` (`runDesktopLeg` below) and reads `clientId` off the
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
  return typeof clientId === 'string' && /^[0-9a-f-]{8,64}$/.test(clientId) ? clientId : '';
}

/** Wrap an event callback so one bad frame cannot take the process down: a
 *  throw inside a socket/server listener is an uncaught exception. */
function guarded(label, callback) {
  return (...args) => {
    try {
      return callback(...args);
    } catch (error) {
      console.error(`[relay] ${label} failed:`, error?.message || error);
      return undefined;
    }
  };
}

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
const MAX_PAIRED_CLIENTS_PER_DEVICE = 256;
export const MAX_RATE_KEYS = 10_000;

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

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
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

function hashesMatch(expectedHex, candidate) {
  if (!expectedHex || !candidate) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = createHash('sha256').update(String(candidate)).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readDeviceCredentials(request, url) {
  const authorization = String(request.headers?.authorization || '');
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const divider = decoded.indexOf(':');
      if (divider > 0) {
        return {
          deviceId: decoded.slice(0, divider),
          secret: decoded.slice(divider + 1),
        };
      }
    } catch { /* invalid Basic authorization */ }
  }
  return { deviceId: '', secret: '' };
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

// Trust-on-first-use only binds ids that cannot be guessed ahead of the device
// that owns them: a full UUID (what the desktop and the hook worker mint) or an
// equivalent 32+ hex-character id. Routing still accepts the wider shape, so
// existing rows and links keep working.
const REGISTRABLE_DEVICE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})$/;

export function registrableDeviceId(deviceId) {
  return REGISTRABLE_DEVICE_ID.test(String(deviceId || ''));
}

export class DeviceStore {
  constructor(dataDir) {
    this.path = join(dataDir, 'devices.json');
    this.devices = new Map();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('device store root is invalid');
      }
      for (const [id, row] of Object.entries(parsed)) {
        if (!/^[0-9a-f-]{8,64}$/.test(id)
          || !row || typeof row !== 'object' || Array.isArray(row)
          || !/^[0-9a-f]{64}$/.test(String(row.secretHash || ''))
          || (row.clientTokenHash && !/^[0-9a-f]{64}$/.test(String(row.clientTokenHash)))
          || (row.clients && (typeof row.clients !== 'object' || Array.isArray(row.clients)))) {
          throw new TypeError('device store row is invalid');
        }
        if (!row.clientTokenHash) row.clientTokenHash = '';
        if (!row.clients) row.clients = {};
        for (const [clientId, client] of Object.entries(row.clients)) {
          if (!/^[0-9a-f-]{8,64}$/.test(clientId)
            || !client || typeof client !== 'object' || Array.isArray(client)
            || !/^[0-9a-f]{64}$/.test(String(client.tokenHash || ''))) {
            throw new TypeError('device store client row is invalid');
          }
          client.name = String(client.name || 'Browser').slice(0, 80);
          client.platform = String(client.platform || '').slice(0, 80);
          client.browser = String(client.browser || '').slice(0, 80);
          client.createdAt = Number.isFinite(client.createdAt) ? client.createdAt : Date.now();
          client.lastSeenAt = Number.isFinite(client.lastSeenAt) ? client.lastSeenAt : client.createdAt;
        }
        this.devices.set(id, row);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`failed to load device store: ${error.message}`, { cause: error });
      }
    }
    // sha256(token) hex -> deviceId. Phone auth is on the hot path of every
    // /ws upgrade and static GET; a linear scan over all devices would decay
    // with fleet size. Indexing by digest keeps lookup O(1) and leaks nothing
    // useful: matching a key requires the token preimage.
    this.tokenIndex = new Map();
    this.clientTokenIndex = new Map();
    for (const [id, row] of this.devices) {
      if (row.clientTokenHash) this.tokenIndex.set(row.clientTokenHash, id);
      for (const [clientId, client] of Object.entries(row.clients)) {
        this.clientTokenIndex.set(client.tokenHash, { deviceId: id, clientId });
      }
    }
    this.saveTimer = null;
  }

  // Throws on failure by design: registration and revocation acknowledge their
  // caller only once the credential change is on disk, and a swallowed write
  // here would report success for state that reappears after a restart.
  save() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const plain = Object.fromEntries(this.devices);
    const directory = dirname(this.path);
    const temporary = join(directory, `.devices-${process.pid}-${randomUUID()}.tmp`);
    try {
      mkdirSync(directory, { recursive: true });
      // Write-then-rename keeps the previous authentication database intact
      // across interruption; the replacement itself is owner-only.
      writeFileSync(temporary, JSON.stringify(plain, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
      // Past the rename the state IS committed. A chmod hiccup here (exotic fs,
      // Windows) must not be reported as a failed write: callers would roll
      // back live state that the next restart loads anyway.
      try {
        chmodSync(this.path, 0o600);
      } catch (error) {
        console.error('[relay] device store written but not tightened:', error.message);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Persist for the paths with nobody to answer (the debounced beat and the
   *  shutdown flush). False means the write did not land. */
  saveOrLog() {
    try {
      this.save();
      return true;
    } catch (error) {
      console.error('[relay] failed to persist device store:', error.message);
      return false;
    }
  }

  // A relay restart makes the whole fleet redial at once; coalescing the
  // (synchronous) devices.json rewrites keeps that stampede off the event
  // loop. Registration is still durable within a beat, and close() flushes.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.saveOrLog(); }, 250);
    this.saveTimer.unref?.();
  }

  isKnown(deviceId) {
    return this.devices.has(deviceId);
  }

  // Trust-on-first-use registration is what makes setup zero-config, but an
  // unauthenticated caller must not be able to mint rows at network speed.
  // The caller applies the per-IP registration limiter; legitimate fleet
  // growth itself is unbounded here and can move to sharded storage later.
  authenticate(deviceId, secret) {
    const known = this.devices.get(deviceId);
    if (!known) {
      // A NEW id is bound to whichever secret arrives first, so the id itself
      // has to be unguessable: a short or predictable label could be preclaimed
      // before the real device ever dials, and the owner would then be locked
      // out of its own route. Desktops and hook workers mint a UUID; ids
      // already in the store keep authenticating on their secret alone.
      if (!registrableDeviceId(deviceId)) return false;
      this.devices.set(deviceId, { secretHash: sha256(secret), clientTokenHash: '', clients: {} });
      // Persist BEFORE the credential goes live. A registration that only
      // exists in memory authenticates until the next restart and then
      // silently becomes a stranger — worse, a failed write would leave the id
      // claimed here while the owner's next dial re-registers it elsewhere.
      if (!this.saveOrLog()) {
        this.devices.delete(deviceId);
        return false;
      }
      return true;
    }
    return hashesMatch(known.secretHash, secret);
  }

  setClientToken(deviceId, token) {
    const known = this.devices.get(deviceId);
    if (!known) return false;
    const hash = sha256(token);
    // Every desktop reconnect re-announces its (unchanged) pairing token;
    // rewriting the store for that would turn restarts into a write storm. A
    // CHANGED token is rare, so it persists synchronously before it is honored.
    if (known.clientTokenHash === hash) return true;
    const previousHash = known.clientTokenHash;
    if (previousHash) this.tokenIndex.delete(previousHash);
    known.clientTokenHash = hash;
    this.tokenIndex.set(hash, deviceId);
    if (!this.saveOrLog()) {
      this.tokenIndex.delete(hash);
      known.clientTokenHash = previousHash;
      if (previousHash) this.tokenIndex.set(previousHash, deviceId);
      return false;
    }
    return true;
  }

  revoke(deviceId) {
    const known = this.devices.get(deviceId);
    if (!known) return false;
    if (known.clientTokenHash) this.tokenIndex.delete(known.clientTokenHash);
    for (const client of Object.values(known.clients || {})) {
      this.clientTokenIndex.delete(client.tokenHash);
    }
    this.devices.delete(deviceId);
    // The acknowledgement is the durability boundary for Unpair: persist
    // synchronously before telling the desktop that the registration is gone.
    // A write that fails is reported as a failed revocation — otherwise the
    // credential returns on the next restart while the user was told it was
    // gone; restore the in-memory row so relay and disk stay one state.
    if (!this.saveOrLog()) {
      this.devices.set(deviceId, known);
      if (known.clientTokenHash) this.tokenIndex.set(known.clientTokenHash, deviceId);
      for (const [clientId, client] of Object.entries(known.clients || {})) {
        this.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
      }
      return false;
    }
    return true;
  }

  deviceIdForClientToken(token) {
    return this.clientAccessForToken(token)?.deviceId ?? null;
  }

  clientAccessForToken(token) {
    if (!token) return null;
    const hash = sha256(token);
    const deviceId = this.tokenIndex.get(hash);
    if (deviceId) return { deviceId, clientId: null };
    return this.clientTokenIndex.get(hash) ?? null;
  }

  registerClient(deviceId, clientId, profile = {}) {
    const known = this.devices.get(deviceId);
    if (!known || !/^[0-9a-f-]{8,64}$/.test(clientId)) return null;
    known.clients ||= {};
    if (!known.clients[clientId]
      && Object.keys(known.clients).length >= MAX_PAIRED_CLIENTS_PER_DEVICE) return null;
    const previous = known.clients[clientId];
    if (previous?.tokenHash) this.clientTokenIndex.delete(previous.tokenHash);
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const client = {
      tokenHash: sha256(token),
      name: String(profile.name || 'Browser').slice(0, 80),
      platform: String(profile.platform || '').slice(0, 80),
      browser: String(profile.browser || '').slice(0, 80),
      createdAt: previous?.createdAt || now,
      lastSeenAt: now,
    };
    known.clients[clientId] = client;
    this.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
    // The token IS the answer to the caller: handing out one the store could
    // not record would authenticate a browser only until the next restart.
    if (!this.saveOrLog()) {
      delete known.clients[clientId];
      this.clientTokenIndex.delete(client.tokenHash);
      if (previous?.tokenHash) {
        known.clients[clientId] = previous;
        this.clientTokenIndex.set(previous.tokenHash, { deviceId, clientId });
      }
      return null;
    }
    return { token, client: { id: clientId, ...client } };
  }

  touchClient(deviceId, clientId, profile = {}) {
    const client = this.devices.get(deviceId)?.clients?.[clientId];
    if (!client) return false;
    client.lastSeenAt = Date.now();
    if (profile.name) client.name = String(profile.name).slice(0, 80);
    if (profile.platform) client.platform = String(profile.platform).slice(0, 80);
    if (profile.browser) client.browser = String(profile.browser).slice(0, 80);
    this.scheduleSave();
    return true;
  }

  listClients(deviceId, online = new Set()) {
    const clients = this.devices.get(deviceId)?.clients || {};
    return Object.entries(clients)
      .map(([id, client]) => ({
        id,
        name: client.name,
        platform: client.platform,
        browser: client.browser,
        createdAt: client.createdAt,
        lastSeenAt: client.lastSeenAt,
        online: online.has(id),
      }))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
  }

  revokeClient(deviceId, clientId) {
    const known = this.devices.get(deviceId);
    const client = known?.clients?.[clientId];
    if (!known || !client) return false;
    this.clientTokenIndex.delete(client.tokenHash);
    delete known.clients[clientId];
    // Same durability boundary as device revocation: a browser reported as
    // unpaired must not come back when the relay restarts.
    if (!this.saveOrLog()) {
      known.clients[clientId] = client;
      this.clientTokenIndex.set(client.tokenHash, { deviceId, clientId });
      return false;
    }
    return true;
  }
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
  if (!access || !/^[0-9a-f-]{8,64}$/.test(clientId)) {
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
  if (!/^[0-9a-f-]{8,64}$/.test(deviceId)
    || !/^[0-9a-f-]{8,64}$/.test(clientId)
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
  const profile = {
    name: String(body?.name || 'Web app').slice(0, 80),
    platform: String(body?.platform || '').slice(0, 80),
    browser: String(body?.browser || '').slice(0, 80),
  };
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
  const routeRequest = (request, response) => {
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
    const authenticateLeg = (deviceId, secret) => {
      if (!/^[0-9a-f-]{8,64}$/.test(deviceId) || secret.length < 16) return 401;
      if (!store.isKnown(deviceId) && !registerLimiter.allow(clientIp(request))) return 429;
      if (store.authenticate(deviceId, secret)) return 0;
      return unauthorizedLimiter.allow(`auth:${clientIp(request)}`) ? 401 : 429;
    };
    const rejectLeg = (status) => {
      reject(status, status === 429 ? 'Too Many Requests' : 'Unauthorized');
    };
    if (url.pathname === '/desktop') {
      const { deviceId, secret } = readDeviceCredentials(request, url);
      const denied = authenticateLeg(deviceId, secret);
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
      const denied = authenticateLeg(deviceId, secret);
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
  socket.on('close', () => {
    releaseLeg(socket);
    releaseIngressLeg(socket);
    entry.clients.delete(clientId);
    sendJson(entry.socket, { type: 'client-close', clientId });
  });
}
