/**
 * Direct transport: the wire contract for carrying a paired session's live
 * traffic over an always-on WebRTC data channel, with the relay as fallback
 * carrier. docs/remote-transport.md is the spec; this module is its code:
 * capability, signaling, record framing, the authenticated cumulative ack,
 * the media adapter messages, the bounds, and the carrier-agnostic stream core
 * (sender: sequence, retain, ack, retransmit; receiver: reorder, dedup,
 * bounded buffer, chunk reassembly BEFORE decryption).
 *
 * Nothing here trusts a carrier. Record framing is unauthenticated on purpose
 * and only ever decides what to hand to E2EE decryption; a record counts as
 * accepted (and is acked) only after its E2EE box opened. Acks and signaling
 * are control-domain boxes (shared/remote-e2ee.ts `sealControl`), so a relay
 * can neither forge an ack nor replay one into another session or direction.
 */
import {
  assertRemoteWebrtcSdpFingerprints,
  parseRemoteWebrtcCandidate,
  parseRemoteWebrtcIceServers,
  parseRemoteWebrtcSdp,
  remoteWebrtcCertificateMatches,
  remoteWebrtcSdpFingerprints,
  type RemoteWebrtcCandidate,
  type RemoteWebrtcFingerprint,
  type RemoteWebrtcIceServer,
} from './remote-webrtc';
import { RELAY_DEFAULT_MAX_FRAME_BYTES } from './remote-payload-limit';
import {
  RELAY_E2EE_TRANSPORT_MAX_BOX_BYTES,
  RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES,
  type RelayE2EEControlOpen,
} from './remote-e2ee';

export { remoteWebrtcCertificateMatches, remoteWebrtcSdpFingerprints };

// ---------------------------------------------------------------------------
// Version, capability, channel
// ---------------------------------------------------------------------------

export const REMOTE_TRANSPORT_VERSION = 1 as const;
/** The application data channel: one per transport peer connection, created
 *  by the desktop (the offerer) before its offer; reliable and ordered. It
 *  carries kinds 1 and 2 (app records and chunks) only. */
export const REMOTE_TRANSPORT_CHANNEL_LABEL = 'mixdog-transport';
/** The control data channel on the SAME peer connection: reliable and
 *  ORDERED (a FIFO control lane, so the per-lane replay rule in remote-e2ee.ts
 *  never drops a genuine box), kind 3 only (acks, repair, ping/pong). Its
 *  own SCTP stream, ordered independently of the app stream (SCTP orders per stream, RFC 9260 §6.6), so
 *  the stream scheduler interleaves it with bulk instead of queueing it
 *  behind the app channel's send buffer; with no I-DATA (RFC 8260) in
 *  browsers, a control message waits at most for the one app message
 *  (≤ REMOTE_TRANSPORT_MAX_MESSAGE_BYTES) already on the wire. The receiver
 *  accepts kind 3 from either channel and from the relay. */
export const REMOTE_TRANSPORT_CONTROL_CHANNEL_LABEL = 'mixdog-transport-control';

// ---------------------------------------------------------------------------
// Bounds (each grounded in an existing limit; see docs/remote-transport.md)
// ---------------------------------------------------------------------------

/** One E2EE box: `MXE\x01 | u64 sequence | nonce(12)` (remote-e2ee.ts
 *  E2EE_BINARY_HEADER_BYTES) and the AES-GCM tag. */
export const REMOTE_TRANSPORT_BOX_HEADER_BYTES = 24;
const GCM_TAG_BYTES = 16;
/** Transport message prefix: magic(4) and kind(1). */
export const REMOTE_TRANSPORT_PREFIX_BYTES = 5;
/** Chunk header after the prefix: u64 sequence, u32 index, u32 count, u32 total. */
export const REMOTE_TRANSPORT_CHUNK_HEADER_BYTES = REMOTE_TRANSPORT_PREFIX_BYTES + 8 + 4 + 4 + 4;
/** Largest message either carrier is handed: the relay's binary ceiling for
 *  a leg that declared no capacity — relay-transport.mjs
 *  UNDECLARED_CAPACITY_BYTES (64 KiB) minus the binary envelope
 *  (relay-binary-frame.mjs RELAY_BINARY_HEADER_BYTES, 6) and the longest
 *  routing id (ids.mjs ROUTING_ID, 64), as relay-transport.mjs
 *  `uplinkCeilings` computes it. It is below SCTP's default max-message-size
 *  when the SDP states none (RFC 8841 §6.1, 65 536), so both carriers take it. */
export const REMOTE_TRANSPORT_MAX_MESSAGE_BYTES = 64 * 1024 - 6 - 64;
/** Payload bytes per chunk: one maximal carrier message minus the chunk
 *  header. Fixed per protocol version so chunks of one record are
 *  interchangeable between carriers. */
export const REMOTE_TRANSPORT_CHUNK_BYTES = REMOTE_TRANSPORT_MAX_MESSAGE_BYTES - REMOTE_TRANSPORT_CHUNK_HEADER_BYTES;
/** Largest application plaintext per record (remote-e2ee.ts
 *  RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES = main/remote-relay-media.ts
 *  MEDIA_WINDOW_MAX_BYTES, 1 MiB) and the largest E2EE box that carries it.
 *  Larger payloads are split ABOVE the record layer
 *  (`splitRemoteTransportPayload`). */
export const REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES = RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES;
export const REMOTE_TRANSPORT_MAX_RECORD_BYTES = RELAY_E2EE_TRANSPORT_MAX_BOX_BYTES;
/** Per-leg queue bound the relay already enforces (relay-transport.mjs
 *  PHONE_QUEUE_LIMIT_BYTES / UPLINK_QUEUE_LIMIT_BYTES, 8 MiB): the most it
 *  lets accumulate for one conversation that is not draining. */
const RELAY_LEG_QUEUE_BYTES = 8 * 1024 * 1024;
/** The window is in bytes only (as RFC 9000 flow control, §4). Every record
 *  is charged at least one carrier message against it, on both sides, so
 *  per-record bookkeeping is bounded by bytes too: a tiny record — honest or
 *  forged — costs as much window as the smallest thing a carrier moves. */
export function remoteTransportRecordCharge(bytes: number): number {
  return Math.max(bytes, REMOTE_TRANSPORT_MAX_MESSAGE_BYTES);
}
/** Records in flight at most: the 8 MiB window over the minimum charge
 *  (8 388 608 / 65 466 = 128, derived). It is the receiver's reorder span and
 *  bounds ack ranges and the `ping.sent` clamp. */
export const REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT = Math.floor(
  RELAY_LEG_QUEUE_BYTES / REMOTE_TRANSPORT_MAX_MESSAGE_BYTES
);
/** Competing assemblies one slot may hold while their geometry is still
 *  unauthenticated. Structural minimum, not a tuning: fewer than two cannot
 *  hold the genuine copy beside one forged one. */
export const REMOTE_TRANSPORT_CANDIDATES_PER_SLOT = 2;
/** Peak memory of opening ONE maximal record, beyond its own assembly buffer,
 *  counted from the open path (remote-e2ee.ts decryptJson): the ciphertext
 *  slice and its ArrayBuffer copy (2 × box), the AES-GCM output (1 ×
 *  plaintext), inflate chunks and their concatenation (2 × plaintext), and the
 *  decoded string at two bytes per code unit (2 × plaintext). */
export const REMOTE_TRANSPORT_OPEN_WORKING_BYTES =
  2 * REMOTE_TRANSPORT_MAX_RECORD_BYTES + 5 * REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES;
/** Reserved for the head-of-line record (the next one required): its slot's
 *  candidates plus the open working set. Nothing else may use it, so future
 *  records can never starve the record the stream is waiting for. */
export const REMOTE_TRANSPORT_HEAD_RESERVE_BYTES =
  REMOTE_TRANSPORT_CANDIDATES_PER_SLOT * REMOTE_TRANSPORT_MAX_RECORD_BYTES + REMOTE_TRANSPORT_OPEN_WORKING_BYTES;
/** What records behind the head may hold (assembly buffers, reserved): the
 *  relay's per-leg queue bound. */
export const REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES = RELAY_LEG_QUEUE_BYTES;
/** The receiver's whole budget for unauthenticated record state: the
 *  per-leg queue plus the head reserve. Reserved before anything is
 *  allocated. */
export const REMOTE_TRANSPORT_RECEIVE_BUDGET_BYTES =
  REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES + REMOTE_TRANSPORT_HEAD_RESERVE_BYTES;
/** Unacked window bytes per direction (each record charged
 *  `remoteTransportRecordCharge`): the relay's per-leg queue bound, which
 *  equals what the receiver buffers behind its head under the same charge,
 *  so a conforming sender never makes it drop. */
export const REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES = RELAY_LEG_QUEUE_BYTES;
/** Bulk (media adapter) records may hold the window minus one maximal
 *  record, so one RPC or state record always finds room (derived). */
export const REMOTE_TRANSPORT_BULK_OUTSTANDING_BYTES =
  REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES - REMOTE_TRANSPORT_MAX_RECORD_BYTES;
/** Unacked bytes one media stream may hold: the relay's per-stream pause
 *  point (relay-media-proxy.mjs MEDIA_PAUSE_BUFFER_BYTES, 1 MiB). */
export const REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES = 1024 * 1024;
/** No ack progress for this long, with records outstanding, ends the
 *  session: the relay's own bound on a leg waiting for room
 *  (relay-transport.mjs INGRESS_WAIT_TIMEOUT_MS). Measured from the last ack
 *  advance, never from a record's age, so a slow but moving link never
 *  expires. */
export const REMOTE_TRANSPORT_RECORD_EXPIRY_MS = 60_000;
// Loss detection and recovery are an ADAPTATION of RFC 9002 (QUIC Loss
// Detection and Congestion Control): its estimator, thresholds and PTO
// formula with its constants, run at the receiver over reliable carriers.
// The differences are listed in docs/remote-transport.md §3.

/** RFC 9002 §6.2.2 kInitialRtt: the RTT of a carrier with no sample yet;
 *  every carrier change starts here again (RFC 9000 §9.4). */
export const REMOTE_TRANSPORT_INITIAL_RTT_MS = 333;
/** RFC 9002 §6.1.2 kGranularity (recommended 1 ms). */
export const REMOTE_TRANSPORT_GRANULARITY_MS = 1;
/** RFC 9002 §6.1.1 kPacketThreshold: a record is lost once one at least this
 *  many sequences later has arrived. */
export const REMOTE_TRANSPORT_PACKET_THRESHOLD = 3;
/** RFC 9002 §6.1.2 kTimeThreshold = 9/8, as numerator and denominator. */
export const REMOTE_TRANSPORT_TIME_THRESHOLD_NUM = 9;
export const REMOTE_TRANSPORT_TIME_THRESHOLD_DEN = 8;
/** RFC 9002 §6.2.4: on PTO expiry an endpoint MAY send up to two probes. */
export const REMOTE_TRANSPORT_PTO_PROBES = 2;
/** RFC 9000 §18.2 max_ack_delay default (25 ms): the delayed-ack timer, and
 *  the `max_ack_delay` term of the PTO (RFC 9002 §6.2.1). */
export const REMOTE_TRANSPORT_MAX_ACK_DELAY_MS = 25;
/** RFC 9000 §13.2.2: a receiver SHOULD ack after at least two ack-eliciting
 *  packets (here: accepted records). */
export const REMOTE_TRANSPORT_ACK_ELICITING_THRESHOLD = 2;
/** Liveness pings on the direct carrier (RFC 9000 §10.1.2 keep-alive, which
 *  sets no interval): the relay's own desktop liveness probe
 *  (relay-legs.mjs DESKTOP_LIVENESS_PROBE_MS, 2 s). */
export const REMOTE_TRANSPORT_PING_MS = 2_000;
/** The relay's bound before it closes a desktop leg that missed a turn
 *  (relay-legs.mjs DESKTOP_HANDSHAKE_STALL_MS 4 s + DESKTOP_LIVENESS_PROBE_MS
 *  2 s = 6 s). Used twice:
 *    - as max_idle_timeout (RFC 9000 §10.1); the effective idle timeout is
 *      max(this, 3 × PTO) as §10.1 requires (`idleTimeoutMs`);
 *    - as the application-progress bound of the `no-progress` policy (a
 *      Mixdog policy, not an RFC rule; `RemoteTransportPathMonitor.stalled`). */
export const REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS = 4_000 + 2_000;
/** Offer to channel-open: one STUN transaction with RFC 5389 §7.2.1 defaults
 *  (as main/remote-webrtc/viewer.ts REMOTE_WEBRTC_NEGOTIATION_TIMEOUT_MS). */
export const REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS = 39_500;
/** RTCDataChannel backpressure, mirroring the relay's two socket thresholds:
 *    LOW   `bufferedAmountLowThreshold` and the bulk admission gate: the
 *          buffered amount above which the relay sheds low-priority frames
 *          (relay-transport.mjs SKIP_PUSH_BUFFER_BYTES, 1 MiB);
 *    HIGH  nothing more is written and file readers pause: the relay's
 *          per-leg queue bound (8 MiB). */
export const REMOTE_TRANSPORT_BUFFER_LOW_BYTES = 1024 * 1024;
export const REMOTE_TRANSPORT_BUFFER_HIGH_BYTES = RELAY_LEG_QUEUE_BYTES;
/** Room on a direct carrier that app records leave free for the control
 *  lane, on both ends: the low-water mark. Both channels share ONE bound,
 *  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES over their summed buffered bytes and
 *  the control boxes held for them; app records stop this much short of it,
 *  so acks, pongs and repairs still go out while bulk holds the rest, and
 *  control alone is held only once the whole bound is used. */
export const REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES = REMOTE_TRANSPORT_BUFFER_LOW_BYTES;
/** A phone leg counts as foreground for push suppression only while its
 *  session showed authenticated liveness within this span: the phone's own
 *  dead-socket verdict (renderer/remote-shim-liveness.ts:93 25 s silence
 *  probe + :85 10 s pong wait), so the PC gives up exactly when the phone
 *  does. A phone that reported `hidden` loses eligibility at once. */
export const REMOTE_TRANSPORT_FOREGROUND_STALE_MS = 25_000 + 10_000;
/** A carrier is promotable only if its negotiated SCTP max message size
 *  (`RTCSctpTransport.maxMessageSize`; +∞ when unlimited) takes the largest
 *  message this contract sends. */
export function remoteTransportCarrierFits(maxMessageSize: number | null | undefined): boolean {
  return typeof maxMessageSize === 'number' && maxMessageSize >= REMOTE_TRANSPORT_MAX_MESSAGE_BYTES;
}
/** Concurrent media adapter streams per session (relay-media-proxy.mjs MAX_MEDIA_STREAMS). */
export const REMOTE_TRANSPORT_MAX_MEDIA_STREAMS = 32;
/** One media-crypto frame: u32 length | nonce(12) | 64 KiB segment | tag
 *  (remote-media-crypto.ts MEDIA_SEGMENT_BYTES), base64url encoded. */
const MEDIA_FRAME_MAX_BYTES = 4 + 12 + 64 * 1024 + GCM_TAG_BYTES;
export const REMOTE_TRANSPORT_MEDIA_CHUNK_MAX_CHARS = Math.ceil((MEDIA_FRAME_MAX_BYTES * 4) / 3);
/** One control box fills at most one carrier message, and its plaintext is
 *  the box minus header and tag: every signal must serialize within it. */
export const REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES =
  REMOTE_TRANSPORT_MAX_MESSAGE_BYTES - REMOTE_TRANSPORT_PREFIX_BYTES;
export const REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES =
  REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES - REMOTE_TRANSPORT_BOX_HEADER_BYTES - GCM_TAG_BYTES;
/** Most selective-ack ranges one ack carries (RFC 9000 §19.3 ACK ranges set
 *  no count): as many maximal ranges as fit one control box beside the
 *  largest ack envelope (derived). */
export const REMOTE_TRANSPORT_MAX_ACK_RANGES = Math.floor(
  (REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES -
    JSON.stringify({ v: 1, t: 'ack', through: Number.MAX_SAFE_INTEGER, ranges: [] }).length) /
    `${JSON.stringify([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])},`.length
);
/** Application messages above the record layer: a payload whose JSON is
 *  larger than one record is split into fragments of this many bytes — the
 *  largest multiple of 3 whose base64url form (4/3, unpadded) plus the
 *  largest fragment envelope fits one record's plaintext (derived). */
const FRAGMENT_ENVELOPE_MAX_BYTES = JSON.stringify({
  type: 'transport-fragment',
  id: Number.MAX_SAFE_INTEGER,
  index: Number.MAX_SAFE_INTEGER,
  count: Number.MAX_SAFE_INTEGER,
  data: '',
}).length;
export const REMOTE_TRANSPORT_FRAGMENT_BYTES =
  Math.floor((REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES - FRAGMENT_ENVELOPE_MAX_BYTES) / 4) * 3;
/** Largest application message in SERIALIZED (UTF-8 JSON) bytes, both
 *  directions: the relay's single-frame policy ceiling (relay-transport.mjs
 *  MAX_FRAME_BYTES, 64 MiB), so nothing the relay delivers today is refused.
 *  Like a relay frame today, a message is parsed whole once complete; its
 *  parsed size and processing lifetime are NOT bounded here (a known limit
 *  shared with the legacy path, docs/remote-transport.md §4). */
export const REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES = RELAY_DEFAULT_MAX_FRAME_BYTES;
/** Process-wide serialized bytes of large messages (any message above one
 *  record) assembling at once: what the single relay uplink holds today —
 *  one frame of any size into an empty queue (MAX_FRAME_BYTES, 64 MiB) plus
 *  the per-leg queue bound behind it (relay-transport.mjs
 *  UPLINK_QUEUE_LIMIT_BYTES / PHONE_QUEUE_LIMIT_BYTES, 8 MiB). An empty pool
 *  always admits one maximal message. */
export const REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES = RELAY_DEFAULT_MAX_FRAME_BYTES + RELAY_LEG_QUEUE_BYTES;
/** A large message that receives no fragment for this long ends its
 *  session and frees its pool reservation, so a stalled peer cannot hold
 *  the pool: the relay's bound on a leg waiting for room
 *  (relay-transport.mjs INGRESS_WAIT_TIMEOUT_MS, 60 s). */
export const REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS = 60_000;

/** Longest diagnostic detail text a close signal or peer report carries. A
 *  Mixdog choice, not a protocol limit: enough for an ICE/DTLS failure
 *  message, far below one control box (REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES). */
export const REMOTE_TRANSPORT_MAX_DETAIL_CHARS = 200;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>;

function fail(what: string): never {
  throw new TypeError(`remote transport: invalid ${what}.`);
}

function record(value: unknown, what: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(what);
  return value as Fields;
}

function positiveInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(what);
  return value;
}

function boundedText(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length > max) fail(what);
  return value;
}

function token(value: unknown, what: string, min = 1, max = 64): string {
  const text = boundedText(value, max, what);
  if (text.length < min || !/^[A-Za-z0-9_-]+$/u.test(text)) fail(what);
  return text;
}

// ---------------------------------------------------------------------------
// Signaling (control domain, relay carrier)
// ---------------------------------------------------------------------------

export type RemoteTransportCloseReason =
  | 'superseded'
  | 'negotiation-timeout'
  | 'ice-failed'
  | 'dtls-failed'
  | 'fingerprint-mismatch'
  | 'channel-failed'
  | 'stall'
  /** The client asks the desktop for a fresh offer (ICE restart or new peer). */
  | 'restart'
  | 'peer-host-unavailable'
  | 'session-ended'
  | 'revoked'
  | 'suspended'
  | 'protocol-error';

const CLOSE_REASONS: ReadonlySet<string> = new Set<RemoteTransportCloseReason>([
  'superseded',
  'negotiation-timeout',
  'ice-failed',
  'dtls-failed',
  'fingerprint-mismatch',
  'channel-failed',
  'stall',
  'restart',
  'peer-host-unavailable',
  'session-ended',
  'revoked',
  'suspended',
  'protocol-error',
]);

/** Every signal names the transport session (the E2EE handshake challenge,
 *  as the media lane's `sid`), the peer connection the desktop minted, and the
 *  generation: it rises per session with every offer, so anything below the
 *  current one is stale and ignored. */
export interface RemoteTransportSignalRef {
  v: typeof REMOTE_TRANSPORT_VERSION;
  sessionId: string;
  connectionId: string;
  generation: number;
}

export type RemoteTransportSignal =
  | (RemoteTransportSignalRef & {
      t: 'offer';
      sdp: string;
      fingerprints: RemoteWebrtcFingerprint[];
      iceServers: RemoteWebrtcIceServer[];
    })
  | (RemoteTransportSignalRef & { t: 'answer'; sdp: string; fingerprints: RemoteWebrtcFingerprint[] })
  | (RemoteTransportSignalRef & { t: 'candidate'; candidate: RemoteWebrtcCandidate | null })
  | (RemoteTransportSignalRef & { t: 'close'; reason: RemoteTransportCloseReason; detail?: string });

/** The live view's SDP check, bounded first to what one control box can
 *  carry: parseRemoteWebrtcSdp alone allows 64 KiB, twice the box. The whole
 *  signal is then held to the same budget (`assertRemoteTransportControlFits`). */
function sdp(value: unknown): string {
  if (typeof value === 'string' && value.length > REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES) fail('sdp size');
  return parseRemoteWebrtcSdp(value);
}

function fingerprintsFor(sdpText: string, value: unknown): RemoteWebrtcFingerprint[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) fail('fingerprints');
  // The SDP's own attributes, parsed by the shared strict reader, must be
  // exactly the declared set; the declared copies are then returned in that
  // canonical form.
  try {
    assertRemoteWebrtcSdpFingerprints(sdpText, value as RemoteWebrtcFingerprint[]);
  } catch {
    fail('fingerprints');
  }
  return remoteWebrtcSdpFingerprints(sdpText);
}

function signalRef(input: Fields): RemoteTransportSignalRef {
  if (input.v !== REMOTE_TRANSPORT_VERSION) fail('version');
  return {
    v: REMOTE_TRANSPORT_VERSION,
    // The E2EE challenge: 32 random bytes, base64url (remote-e2ee.ts).
    sessionId: token(input.sessionId, 'session id', 43, 43),
    connectionId: token(input.connectionId, 'connection id', 8, 64),
    generation: positiveInteger(input.generation, 'generation'),
  };
}

const utf8 = new TextEncoder();

/** Bytes a control message seals to: its JSON as UTF-8 (`sealControl`). */
export function remoteTransportControlBytes(message: unknown): number {
  return utf8.encode(JSON.stringify(message)).byteLength;
}

/** Refuses, before sealing, a control message that would not fit one carrier
 *  message once encrypted. */
export function assertRemoteTransportControlFits(message: unknown): void {
  if (remoteTransportControlBytes(message) > REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES) fail('control size');
}

/** A signal opened from the control domain. `from` is the sender's role:
 *  only the desktop offers, only the client answers. The normalized signal
 *  must also serialize within one control box, so whatever passes here can be
 *  sealed and carried as it is. */
export function parseRemoteTransportSignal(value: unknown, from: 'desktop' | 'client'): RemoteTransportSignal {
  const signal = parseSignalFields(value, from);
  assertRemoteTransportControlFits(signal);
  return signal;
}

function parseSignalFields(value: unknown, from: 'desktop' | 'client'): RemoteTransportSignal {
  const input = record(value, 'signal');
  const ref = signalRef(input);
  switch (input.t) {
    case 'offer': {
      if (from !== 'desktop') fail('offer direction');
      const text = sdp(input.sdp);
      return {
        ...ref,
        t: 'offer',
        sdp: text,
        fingerprints: fingerprintsFor(text, input.fingerprints),
        iceServers: parseRemoteWebrtcIceServers(input.iceServers),
      };
    }
    case 'answer': {
      if (from !== 'client') fail('answer direction');
      const text = sdp(input.sdp);
      return { ...ref, t: 'answer', sdp: text, fingerprints: fingerprintsFor(text, input.fingerprints) };
    }
    case 'candidate':
      return { ...ref, t: 'candidate', candidate: parseRemoteWebrtcCandidate(input.candidate) };
    case 'close': {
      if (typeof input.reason !== 'string' || !CLOSE_REASONS.has(input.reason)) fail('close reason');
      return {
        ...ref,
        t: 'close',
        reason: input.reason as RemoteTransportCloseReason,
        ...(input.detail === undefined
          ? {}
          : { detail: boundedText(input.detail, REMOTE_TRANSPORT_MAX_DETAIL_CHARS, 'close detail') }),
      };
    }
    default:
      return fail('signal type');
  }
}

// ---------------------------------------------------------------------------
// Control messages: authenticated ack and liveness
// ---------------------------------------------------------------------------

/** Cumulative: every application record up to and including `through` was
 *  authenticated (its E2EE box opened) and accepted into the ordered stream.
 *  It says nothing about RPC execution. */
export interface RemoteTransportAck {
  v: typeof REMOTE_TRANSPORT_VERSION;
  t: 'ack';
  through: number;
  /** Selective ranges `[first, last]` above `through` the receiver already
   *  holds complete (not yet opened). Hints only: they suppress re-sending
   *  after a carrier switch but never release a buffer — only `through`,
   *  which counts opened records, does. Ascending, disjoint, at most
   *  REMOTE_TRANSPORT_MAX_ACK_RANGES. */
  ranges?: Array<[number, number]>;
}
/** One repair round: the receiver asks for these records again (ascending,
 *  distinct, at most REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT — only sequences
 *  inside the reorder span can be missing). Retained records are re-sent on
 *  the same carrier only for this or for a carrier failure — never on a
 *  timer. */
export interface RemoteTransportRepair {
  v: typeof REMOTE_TRANSPORT_VERSION;
  t: 'repair';
  sequences: number[];
}
export interface RemoteTransportPing {
  v: typeof REMOTE_TRANSPORT_VERSION;
  t: 'ping' | 'pong';
  id: number;
  /** Ping only: the highest application sequence whose bytes have left the
   *  sender's queue on this carrier (`RemoteTransportSender.probeThrough`).
   *  The receiver repairs anything at or below it that never arrived, which
   *  is how a lost FINAL record is found (no later record reveals the gap). */
  sent?: number;
}
export type RemoteTransportControl =
  | RemoteTransportSignal
  | RemoteTransportAck
  | RemoteTransportRepair
  | RemoteTransportPing;

function ackRanges(value: unknown, through: number): Array<[number, number]> {
  if (!Array.isArray(value) || value.length > REMOTE_TRANSPORT_MAX_ACK_RANGES) fail('ack ranges');
  let floor = through + 1;
  return value.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) fail('ack range');
    const [first, last] = entry as unknown[];
    if (
      typeof first !== 'number' ||
      typeof last !== 'number' ||
      !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) ||
      first < floor ||
      last < first ||
      last > through + REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT
    ) {
      fail('ack range');
    }
    floor = last + 2;
    return [first, last] as [number, number];
  });
}

/** Objects that came out of an authenticated control box, mapped to that
 *  box's control-domain sequence. Only these can release or re-send sender
 *  buffers (a structurally identical object built from relay cleartext is not
 *  in the map), and the sequence orders acks against repairs: they may come
 *  on different lanes (relay, direct), so arrival order says nothing. */
const authenticated = new WeakMap<object, number>();

/** Reads one OPENED control box (`RelayE2EEChannel.openControl`). Stale
 *  copies yield null; malformed content throws. `from` is the peer's role. */
export function readRemoteTransportControl(
  opened: RelayE2EEControlOpen,
  from: 'desktop' | 'client'
): RemoteTransportControl | null {
  if (opened.stale) return null;
  const input = record(opened.value, 'control');
  let message: RemoteTransportControl;
  if (input.t === 'ack') {
    if (input.v !== REMOTE_TRANSPORT_VERSION) fail('version');
    if (typeof input.through !== 'number' || !Number.isSafeInteger(input.through) || input.through < 0) fail('ack');
    message = {
      v: REMOTE_TRANSPORT_VERSION,
      t: 'ack',
      through: input.through,
      ...(input.ranges === undefined ? {} : { ranges: ackRanges(input.ranges, input.through) }),
    };
  } else if (input.t === 'repair') {
    if (input.v !== REMOTE_TRANSPORT_VERSION) fail('version');
    const sequences = input.sequences;
    if (
      !Array.isArray(sequences) ||
      sequences.length < 1 ||
      sequences.length > REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT
    ) {
      fail('repair');
    }
    let floor = 0;
    for (const sequence of sequences) {
      if (positiveInteger(sequence, 'repair') <= floor) fail('repair order');
      floor = sequence as number;
    }
    message = { v: REMOTE_TRANSPORT_VERSION, t: 'repair', sequences: [...(sequences as number[])] };
  } else if (input.t === 'ping' || input.t === 'pong') {
    if (input.v !== REMOTE_TRANSPORT_VERSION) fail('version');
    const sent =
      input.t === 'ping' && input.sent !== undefined
        ? typeof input.sent === 'number' && Number.isSafeInteger(input.sent) && input.sent >= 0
          ? input.sent
          : fail('ping sent')
        : undefined;
    message = {
      v: REMOTE_TRANSPORT_VERSION,
      t: input.t,
      id: positiveInteger(input.id, 'ping id'),
      ...(sent === undefined ? {} : { sent }),
    };
  } else {
    message = parseRemoteTransportSignal(input, from);
  }
  authenticated.set(message, opened.sequence);
  return message;
}

export function remoteTransportPing(id: number, sent?: number): RemoteTransportPing {
  return { v: REMOTE_TRANSPORT_VERSION, t: 'ping', id, ...(sent === undefined ? {} : { sent }) };
}

export function remoteTransportAck(through: number, ranges: Array<[number, number]> = []): RemoteTransportAck {
  return { v: REMOTE_TRANSPORT_VERSION, t: 'ack', through, ...(ranges.length ? { ranges } : {}) };
}

/** One repair round: every sequence `repairDue` returned, in one box. */
export function remoteTransportRepair(sequences: number[]): RemoteTransportRepair {
  return { v: REMOTE_TRANSPORT_VERSION, t: 'repair', sequences };
}

// ---------------------------------------------------------------------------
// Media adapter (application-stream payloads)
// ---------------------------------------------------------------------------

/** The relay's HTTP media lane re-expressed as stream messages. Range,
 *  version and encryption semantics are unchanged: `chunk.frame` is a
 *  remote-media-crypto.ts frame (meta first, then segments) sealed with the
 *  session's media key, exactly what public/sw-media.js decodes today. The
 *  session (and so the device a download lease must belong to) is the stream's
 *  own, never a field of the request. */
export const REMOTE_TRANSPORT_MEDIA_TYPE = 'transport-media';
export type RemoteTransportMediaStatus = 200 | 403 | 404 | 405 | 412 | 416 | 500;
const MEDIA_STATUSES: ReadonlySet<number> = new Set([200, 403, 404, 405, 412, 416, 500]);

export type RemoteTransportMedia =
  | {
      type: typeof REMOTE_TRANSPORT_MEDIA_TYPE;
      op: 'request';
      id: string;
      assetId: string;
      variant: string;
      range: string;
      enc: string;
    }
  | { type: typeof REMOTE_TRANSPORT_MEDIA_TYPE; op: 'head'; id: string; status: RemoteTransportMediaStatus }
  | { type: typeof REMOTE_TRANSPORT_MEDIA_TYPE; op: 'chunk'; id: string; frame: string }
  | { type: typeof REMOTE_TRANSPORT_MEDIA_TYPE; op: 'end' | 'cancel' | 'error'; id: string };

/** A media adapter message, or null when the payload is not one. `from` is
 *  the sender's role: requests and cancels come from the client only. */
export function readRemoteTransportMedia(value: unknown, from: 'desktop' | 'client'): RemoteTransportMedia | null {
  if (!value || typeof value !== 'object' || (value as Fields).type !== REMOTE_TRANSPORT_MEDIA_TYPE) return null;
  const input = value as Fields;
  const type = REMOTE_TRANSPORT_MEDIA_TYPE;
  const id = token(input.id, 'media id');
  const clientOp = input.op === 'request' || input.op === 'cancel';
  if (clientOp !== (from === 'client')) fail('media direction');
  switch (input.op) {
    case 'request': {
      // The relay route's own asset id shape (relay/lib/media-http.mjs MEDIA_ROUTE).
      const assetId = boundedText(input.assetId, 64, 'media asset');
      if (!/^[0-9a-fA-F-]{8,64}$/u.test(assetId)) fail('media asset');
      const range = boundedText(input.range, 64, 'media range');
      if (range && !/^bytes=\d{0,16}-\d{0,16}$/u.test(range)) fail('media range');
      return {
        type,
        op: 'request',
        id,
        assetId,
        variant: token(input.variant, 'media variant', 1, 32),
        range,
        enc: token(input.enc, 'media scheme', 1, 16),
      };
    }
    case 'head': {
      if (typeof input.status !== 'number' || !MEDIA_STATUSES.has(input.status)) fail('media status');
      return { type, op: 'head', id, status: input.status as RemoteTransportMediaStatus };
    }
    case 'chunk': {
      const frame = boundedText(input.frame, REMOTE_TRANSPORT_MEDIA_CHUNK_MAX_CHARS, 'media frame');
      if (!/^[A-Za-z0-9_-]{40,}$/u.test(frame)) fail('media frame');
      return { type, op: 'chunk', id, frame };
    }
    case 'end':
    case 'cancel':
    case 'error':
      return { type, op: input.op, id };
    default:
      return fail('media op');
  }
}

// ---------------------------------------------------------------------------
// Application messages above the record layer
// ---------------------------------------------------------------------------

/** A payload larger than one record travels as consecutive fragment
 *  payloads, each sealed as its own record:
 *    { type: 'transport-fragment', id, index, count, data }
 *  `data` is base64url of REMOTE_TRANSPORT_FRAGMENT_BYTES (the last: 1 to
 *  that many) bytes of the payload's UTF-8 JSON. The sender seals a message's
 *  fragments back to back with nothing in between, so application order is
 *  exactly the send order; the receiver holds one partial message at most and
 *  rejects interleaving. Fragments are authenticated records, so this layer
 *  only bounds an honest peer. */
export const REMOTE_TRANSPORT_FRAGMENT_TYPE = 'transport-fragment';

export interface RemoteTransportFragment {
  type: typeof REMOTE_TRANSPORT_FRAGMENT_TYPE;
  id: number;
  index: number;
  count: number;
  data: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string, what: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) fail(what);
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Largest fragment count: a maximal message in whole fragments. */
export const REMOTE_TRANSPORT_MAX_FRAGMENTS = Math.ceil(
  REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES / REMOTE_TRANSPORT_FRAGMENT_BYTES
);

/** The payloads to seal for one application message: the payload itself
 *  when its JSON fits one record, otherwise its fragments under `id` (unique
 *  per session and direction). Throws BEFORE anything is sealed when the
 *  message exceeds REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES (the relay's
 *  own frame ceiling, so the same payloads are refused as today) or does not
 *  serialize, so a refusal never consumes a sequence. */
export function splitRemoteTransportPayload(payload: unknown, id: number): unknown[] {
  const text = JSON.stringify(payload);
  if (typeof text !== 'string') fail('payload');
  const bytes = utf8.encode(text);
  if (bytes.byteLength <= REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES) return [payload];
  if (bytes.byteLength > REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES) fail('message size');
  positiveInteger(id, 'fragment id');
  const count = Math.ceil(bytes.byteLength / REMOTE_TRANSPORT_FRAGMENT_BYTES);
  const fragments: RemoteTransportFragment[] = [];
  for (let index = 0; index < count; index += 1) {
    const part = bytes.subarray(index * REMOTE_TRANSPORT_FRAGMENT_BYTES, (index + 1) * REMOTE_TRANSPORT_FRAGMENT_BYTES);
    fragments.push({ type: REMOTE_TRANSPORT_FRAGMENT_TYPE, id, index, count, data: base64UrlEncode(part) });
  }
  return fragments;
}

/** Process-wide accounting of large-message assembly in SERIALIZED bytes
 *  (REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES). It bounds the fragments held, as
 *  the relay's queues bound frames today; it is not a bound on the parsed
 *  object or on what the application does with it. */
export class RemoteTransportAssemblyPool {
  private used = 0;

  constructor(readonly capacity: number = REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES) {}

  tryReserve(bytes: number): boolean {
    if (this.used + bytes > this.capacity) return false;
    this.used += bytes;
    return true;
  }

  release(bytes: number): void {
    this.used = Math.max(0, this.used - bytes);
  }

  usedBytes(): number {
    return this.used;
  }
}

/** The pool every assembler of this process shares by default (the
 *  desktop daemon: all sessions; a phone page: its one session). */
export const remoteTransportAssemblyPool = new RemoteTransportAssemblyPool();

/** What `accept` made of one opened payload:
 *    complete  a whole message (`payload`);
 *    partial   a fragment was kept; more are coming;
 *    wait      the first fragment of a large message found the process pool
 *              full. Nothing was kept: the caller holds this one payload and
 *              offers it again later, pulling no further record from the
 *              receiver meanwhile, so backpressure reaches the sender through
 *              its window (the session holds no more than its record budget,
 *              as a relay leg waiting for room does today). */
export type RemoteTransportAssembly =
  | { state: 'complete'; payload: unknown }
  | { state: 'partial' }
  | { state: 'wait' };

/** Turns the opened, in-order record payloads of ONE session back into
 *  application messages, with relay-equivalent serialized-bytes semantics:
 *    - a message is at most REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES
 *      (the relay frame ceiling) and is parsed whole once complete, as a
 *      relay frame is today;
 *    - at most one large message (above one record) assembles per session at
 *      a time: fragments are sealed back to back, and anything else in
 *      between is a protocol error;
 *    - its declared size (count × fragment) is reserved from the process
 *      pool at the first fragment, before anything is kept, and released on
 *      completion, failure or `close`;
 *    - a large message with no new fragment for REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS
 *      is `stalled`: the caller ends the session (`close` frees the pool).
 *  Parsed-object size and processing lifetime are not bounded here (a known
 *  limit shared with the legacy path). `accept` throws on a protocol
 *  violation (a gap, interleaving, oversize, a bad fragment), which ends the
 *  session. */
export class RemoteTransportMessageAssembler {
  private partial: { id: number; count: number; next: number; parts: Uint8Array[]; bytes: number; at: number } | null =
    null;
  private reserved = 0;

  constructor(private readonly pool: RemoteTransportAssemblyPool = remoteTransportAssemblyPool) {}

  accept(value: unknown, now: number): RemoteTransportAssembly {
    if (!value || typeof value !== 'object' || (value as Fields).type !== REMOTE_TRANSPORT_FRAGMENT_TYPE) {
      if (this.partial) fail('message interleaved with a fragmented one');
      return { state: 'complete', payload: value };
    }
    const input = value as Fields;
    const id = positiveInteger(input.id, 'fragment id');
    const count = positiveInteger(input.count, 'fragment count');
    if (count < 2 || count > REMOTE_TRANSPORT_MAX_FRAGMENTS) fail('fragment count');
    if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index)) fail('fragment index');
    const data = boundedText(input.data, Math.ceil((REMOTE_TRANSPORT_FRAGMENT_BYTES * 4) / 3), 'fragment data');
    let partial = this.partial;
    if (!partial) {
      if (input.index !== 0) fail('fragment order');
      const declared = count * REMOTE_TRANSPORT_FRAGMENT_BYTES;
      if (!this.pool.tryReserve(declared)) return { state: 'wait' };
      this.reserved = declared;
      partial = { id, count, next: 0, parts: [], bytes: 0, at: now };
    }
    try {
      if (partial.id !== id || partial.count !== count || input.index !== partial.next) fail('fragment order');
      const bytes = base64UrlDecode(data, 'fragment data');
      const last = partial.next === count - 1;
      if (last ? bytes.byteLength < 1 : bytes.byteLength !== REMOTE_TRANSPORT_FRAGMENT_BYTES) fail('fragment length');
      partial.parts.push(bytes);
      partial.bytes += bytes.byteLength;
      partial.next += 1;
      partial.at = now;
      this.partial = partial;
      if (!last) return { state: 'partial' };
      this.partial = null;
      if (partial.bytes <= REMOTE_TRANSPORT_MAX_RECORD_PLAINTEXT_BYTES) fail('fragmented message size');
      if (partial.bytes > REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES) fail('message size');
      const whole = new Uint8Array(partial.bytes);
      let offset = 0;
      for (const part of partial.parts) {
        whole.set(part, offset);
        offset += part.byteLength;
      }
      partial.parts = [];
      this.free();
      return { state: 'complete', payload: JSON.parse(new TextDecoder().decode(whole)) as unknown };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  /** A large message is assembling but got no fragment for
   *  REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS: end the session. */
  stalled(now: number): boolean {
    return this.partial !== null && now - this.partial.at >= REMOTE_TRANSPORT_ASSEMBLY_IDLE_MS;
  }

  /** The session ended: drop the partial message and free its reservation. */
  close(): void {
    this.partial = null;
    this.free();
  }

  private free(): void {
    this.pool.release(this.reserved);
    this.reserved = 0;
  }

  /** Bytes held by the message in progress. */
  pendingBytes(): number {
    return this.partial?.bytes ?? 0;
  }

  /** Pool bytes reserved for the message in progress (0 when none). */
  reservedBytes(): number {
    return this.reserved;
  }
}

// ---------------------------------------------------------------------------
// Record framing (both carriers)
// ---------------------------------------------------------------------------

const TRANSPORT_MAGIC = [0x4d, 0x58, 0x54, 0x01] as const; // 'MXT' v1
const BOX_MAGIC = [0x4d, 0x58, 0x45, 0x01] as const; // remote-e2ee.ts binary box
const CONTROL_MAGIC = [0x4d, 0x58, 0x43, 0x01] as const; // remote-e2ee.ts control box
const KIND_APP = 1;
const KIND_CHUNK = 2;
const KIND_CONTROL = 3;
const MIN_BOX_BYTES = REMOTE_TRANSPORT_BOX_HEADER_BYTES + GCM_TAG_BYTES;

export type RemoteTransportMessage =
  | { kind: 'app'; sequence: number; box: Uint8Array }
  | { kind: 'chunk'; sequence: number; index: number; count: number; total: number; data: Uint8Array }
  | { kind: 'control'; box: Uint8Array };

function hasMagic(bytes: Uint8Array, offset: number, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[offset + index] === byte);
}

function boxSequence(box: Uint8Array): number {
  if (box.byteLength < MIN_BOX_BYTES || !hasMagic(box, 0, BOX_MAGIC)) fail('application box');
  const raw = new DataView(box.buffer, box.byteOffset, box.byteLength).getBigUint64(4, false);
  if (raw < 1n || raw > BigInt(Number.MAX_SAFE_INTEGER)) fail('application sequence');
  return Number(raw);
}

function prefixed(kind: number, length: number): Uint8Array {
  const out = new Uint8Array(REMOTE_TRANSPORT_PREFIX_BYTES + length);
  out.set(TRANSPORT_MAGIC, 0);
  out[4] = kind;
  return out;
}

/** The carrier messages for one application box: whole when it fits one
 *  chunk, otherwise fixed-size chunks. Same bytes on every carrier. */
export function encodeRemoteTransportRecord(box: Uint8Array): Uint8Array[] {
  const sequence = boxSequence(box);
  if (box.byteLength > REMOTE_TRANSPORT_MAX_RECORD_BYTES) fail('record size');
  if (box.byteLength <= REMOTE_TRANSPORT_CHUNK_BYTES) {
    const out = prefixed(KIND_APP, box.byteLength);
    out.set(box, REMOTE_TRANSPORT_PREFIX_BYTES);
    return [out];
  }
  const count = Math.ceil(box.byteLength / REMOTE_TRANSPORT_CHUNK_BYTES);
  const messages: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const data = box.subarray(index * REMOTE_TRANSPORT_CHUNK_BYTES, (index + 1) * REMOTE_TRANSPORT_CHUNK_BYTES);
    const out = new Uint8Array(REMOTE_TRANSPORT_CHUNK_HEADER_BYTES + data.byteLength);
    out.set(TRANSPORT_MAGIC, 0);
    out[4] = KIND_CHUNK;
    const view = new DataView(out.buffer);
    view.setBigUint64(5, BigInt(sequence), false);
    view.setUint32(13, index, false);
    view.setUint32(17, count, false);
    view.setUint32(21, box.byteLength, false);
    out.set(data, REMOTE_TRANSPORT_CHUNK_HEADER_BYTES);
    messages.push(out);
  }
  return messages;
}

/** The carrier message for one sealed control box. */
export function encodeRemoteTransportControl(box: Uint8Array): Uint8Array {
  if (box.byteLength < MIN_BOX_BYTES || !hasMagic(box, 0, CONTROL_MAGIC)) fail('control box');
  if (box.byteLength > REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES) fail('control size');
  const out = prefixed(KIND_CONTROL, box.byteLength);
  out.set(box, REMOTE_TRANSPORT_PREFIX_BYTES);
  return out;
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Strict decoder for one carrier message; throws on anything a conforming
 *  peer cannot produce. Copies, so a carrier may reuse its buffer. */
export function decodeRemoteTransportMessage(raw: unknown): RemoteTransportMessage {
  const bytes = bytesOf(raw);
  if (
    !bytes ||
    bytes.byteLength > REMOTE_TRANSPORT_MAX_MESSAGE_BYTES ||
    bytes.byteLength < REMOTE_TRANSPORT_PREFIX_BYTES
  ) {
    fail('message size');
  }
  if (!hasMagic(bytes, 0, TRANSPORT_MAGIC)) fail('message magic');
  const body = bytes.slice(REMOTE_TRANSPORT_PREFIX_BYTES);
  switch (bytes[4]) {
    case KIND_APP:
      if (body.byteLength > REMOTE_TRANSPORT_CHUNK_BYTES) fail('record size');
      return { kind: 'app', sequence: boxSequence(body), box: body };
    case KIND_CONTROL:
      if (body.byteLength < MIN_BOX_BYTES || !hasMagic(body, 0, CONTROL_MAGIC)) fail('control box');
      return { kind: 'control', box: body };
    case KIND_CHUNK: {
      if (bytes.byteLength < REMOTE_TRANSPORT_CHUNK_HEADER_BYTES) fail('chunk header');
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const rawSequence = view.getBigUint64(5, false);
      if (rawSequence < 1n || rawSequence > BigInt(Number.MAX_SAFE_INTEGER)) fail('chunk sequence');
      const index = view.getUint32(13, false);
      const count = view.getUint32(17, false);
      const total = view.getUint32(21, false);
      if (total <= REMOTE_TRANSPORT_CHUNK_BYTES || total > REMOTE_TRANSPORT_MAX_RECORD_BYTES) fail('chunk total');
      if (count !== Math.ceil(total / REMOTE_TRANSPORT_CHUNK_BYTES) || index >= count) fail('chunk index');
      const expected =
        index === count - 1 ? total - index * REMOTE_TRANSPORT_CHUNK_BYTES : REMOTE_TRANSPORT_CHUNK_BYTES;
      const data = bytes.slice(REMOTE_TRANSPORT_CHUNK_HEADER_BYTES);
      if (data.byteLength !== expected) fail('chunk length');
      return { kind: 'chunk', sequence: Number(rawSequence), index, count, total, data };
    }
    default:
      return fail('message kind');
  }
}

// ---------------------------------------------------------------------------
// Sender stream core
// ---------------------------------------------------------------------------

/** A carrier instance: `relay`, or one direct peer connection
 *  (`direct:<connectionId>`); TURN-relayed peers are still `direct:` carriers
 *  and report `relayed` in diagnostics. */
export type RemoteTransportCarrierId = string;

/** Largest record a media adapter `chunk` seals to: the base64url frame, its
 *  exact JSON envelope with the longest media id (64), box header and tag
 *  (derived). Bulk admission reserves this, not a maximal record. */
export const REMOTE_TRANSPORT_MEDIA_RECORD_MAX_BYTES =
  JSON.stringify({ type: REMOTE_TRANSPORT_MEDIA_TYPE, op: 'chunk', id: 'x'.repeat(64), frame: '' }).length +
  REMOTE_TRANSPORT_MEDIA_CHUNK_MAX_CHARS +
  REMOTE_TRANSPORT_BOX_HEADER_BYTES +
  GCM_TAG_BYTES;

interface Retained {
  sequence: number;
  box: Uint8Array;
  /** Media stream id for bulk records; null for everything else. */
  stream: string | null;
  /** Carrier it was last handed to; null while never sent. */
  carrier: RemoteTransportCarrierId | null;
  /** Waiting to be handed to a carrier (first send or re-send). */
  pending: boolean;
  /** The pending send is a re-send (carrier failure or repair). */
  resend: boolean;
  /** A selective ack says the receiver already holds it complete. */
  held: boolean;
  /** Control sequence of the latest repair for it (0: none). A selective
   *  ack sealed before that repair is older news and never sets `held`. */
  repairedBy: number;
  /** The carrier's handed-over byte count once this record was handed to
   *  it (for `probeThrough`). */
  handedEnd: number;
  /** Window bytes it holds: `remoteTransportRecordCharge(box.byteLength)`. */
  charge: number;
}

export interface RemoteTransportSenderStats {
  nextSequence: number;
  ackedThrough: number;
  retainedRecords: number;
  /** Charged window bytes (`remoteTransportRecordCharge` per record). */
  outstandingBytes: number;
  bulkBytes: number;
  retransmits: number;
}

/** What a record is, for admission: `stream` marks a media adapter (bulk)
 *  record of that stream. `bufferedAmount` is the current carrier's queue. */
export interface RemoteTransportAdmission {
  stream?: string;
  bufferedAmount?: number;
}

/** Holds every sealed application box until an authenticated ack covers it.
 *  The sequence is the E2EE box's own, assigned when it was sealed, before
 *  any carrier was chosen; it must be contiguous, since a hole would stall the
 *  receiver forever.
 *
 *  Carriers are reliable and ordered, so nothing is re-sent on a timer: a
 *  record handed to a working carrier is in its queue, and a slow queue is
 *  not a loss (a timer would multiply the load on exactly the slow link). A
 *  record is re-sent only when its carrier failed (`carrierFailed`, after a
 *  hold of one PTO for the receiver's resume point) or when the receiver
 *  asks for it (`repair`, RFC 9002 loss detection at the receiver; see
 *  `RemoteTransportReceiver.repairDue`).
 *  Pure: time is passed in. */
export class RemoteTransportSender {
  private readonly retained = new Map<number, Retained>();
  private readonly streamBytes = new Map<string, number>();
  private expected = 1;
  private acked = 0;
  private highestSent = 0;
  private bytes = 0;
  private bulkBytes = 0;
  private retransmits = 0;
  /** Last ack advance (or first send into an empty window). */
  private progressAt: number | null = null;
  /** Re-sends after a carrier failure wait until then, or for an ack. */
  private holdUntil: number | null = null;
  /** RFC 9002 §6.2 PTO state: last send or ack advance, and pto_count. */
  private ptoArmedAt: number | null = null;
  private ptoCount = 0;
  /** Highest control sequence applied (acks and repairs). */
  private controlSeen = 0;
  /** An ack ends the post-failure hold only if sealed after this. */
  private resumeAfter = 0;
  /** Bytes handed to each carrier since it became current. */
  private readonly handed = new Map<RemoteTransportCarrierId, number>();

  /** Whether a new record may be sealed now. Room for its largest possible
   *  size is reserved (the size is known only after sealing). A bulk record
   *  (`stream`) is admitted only while the carrier queue is at or below the
   *  low-water mark, the bulk share has room and its stream has credit, so
   *  media can never starve RPC and state records. Droppable payloads that
   *  find it closed are coalesced or dropped BEFORE sealing, never after. */
  canAdmit(admission: RemoteTransportAdmission = {}): boolean {
    const size =
      admission.stream === undefined ? REMOTE_TRANSPORT_MAX_RECORD_BYTES : REMOTE_TRANSPORT_MEDIA_RECORD_MAX_BYTES;
    if (this.bytes + size > REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES) return false;
    if (admission.stream === undefined) return true;
    return (
      (admission.bufferedAmount ?? 0) <= REMOTE_TRANSPORT_BUFFER_LOW_BYTES &&
      this.bulkBytes + size <= REMOTE_TRANSPORT_BULK_OUTSTANDING_BYTES &&
      (this.streamBytes.get(admission.stream) ?? 0) + size <= REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES
    );
  }

  /** The sequence the next sealed box must carry. A refusal before sealing
   *  (size, window) leaves it unchanged. */
  nextSequence(): number {
    return this.expected;
  }

  /** Takes one sealed box (immutable from here on). Call only after
   *  `canAdmit` with the same admission said yes. */
  push(box: Uint8Array, admission: RemoteTransportAdmission = {}): number {
    const sequence = boxSequence(box);
    if (sequence !== this.expected) fail(`sender sequence ${sequence}, expected ${this.expected}`);
    if (box.byteLength > REMOTE_TRANSPORT_MAX_RECORD_BYTES) fail('record size');
    const charge = remoteTransportRecordCharge(box.byteLength);
    if (this.bytes + charge > REMOTE_TRANSPORT_MAX_OUTSTANDING_BYTES) fail('sender window');
    const stream = admission.stream ?? null;
    if (stream !== null) {
      if (box.byteLength > REMOTE_TRANSPORT_MEDIA_RECORD_MAX_BYTES) fail('bulk record size');
      const held = this.streamBytes.get(stream) ?? 0;
      if (
        this.bulkBytes + charge > REMOTE_TRANSPORT_BULK_OUTSTANDING_BYTES ||
        held + charge > REMOTE_TRANSPORT_MEDIA_STREAM_CREDIT_BYTES
      ) {
        fail('bulk credit');
      }
      this.streamBytes.set(stream, held + charge);
      this.bulkBytes += charge;
    }
    this.retained.set(sequence, {
      sequence,
      box,
      stream,
      carrier: null,
      pending: true,
      resend: false,
      held: false,
      repairedBy: 0,
      handedEnd: 0,
      charge,
    });
    this.bytes += charge;
    this.expected += 1;
    return sequence;
  }

  /** Records to hand to the current carrier now, in sequence order (the
   *  receiver delivers in order, so a later record never jumps a gap): first
   *  sends, plus re-sends once the post-failure hold ended, minus records a
   *  selective ack says the receiver holds. `budgetBytes` is the room the
   *  carrier has (high-water mark minus its queue, or the relay's
   *  backpressure); the first record is always offered when there is any. */
  due(now: number, budgetBytes = Number.POSITIVE_INFINITY): Array<{ sequence: number; box: Uint8Array }> {
    const holding = this.holdUntil !== null && now < this.holdUntil;
    const out: Array<{ sequence: number; box: Uint8Array }> = [];
    let used = 0;
    for (const entry of this.retained.values()) {
      if (!entry.pending || (entry.resend && (holding || entry.held))) continue;
      if (out.length > 0 && used + entry.box.byteLength > budgetBytes) break;
      if (budgetBytes <= 0) break;
      out.push({ sequence: entry.sequence, box: entry.box });
      used += entry.box.byteLength;
    }
    return out;
  }

  /** The carrier accepted the whole record (all of its messages). */
  markSent(sequence: number, carrier: RemoteTransportCarrierId, now: number): void {
    const entry = this.retained.get(sequence);
    if (!entry) return;
    if (entry.resend) this.retransmits += 1;
    entry.pending = false;
    entry.resend = false;
    entry.carrier = carrier;
    const handed = (this.handed.get(carrier) ?? 0) + entry.box.byteLength;
    this.handed.set(carrier, handed);
    entry.handedEnd = handed;
    this.progressAt ??= now;
    // RFC 9002 §6.2.1: the PTO timer restarts with every ack-eliciting send.
    this.ptoArmedAt = now;
    if (sequence > this.highestSent) this.highestSent = sequence;
  }

  /** RFC 9002 §6.2 probe timeout, at the sender: true when records sent and
   *  unacked have seen neither a send nor an ack for PTO × 2^pto_count
   *  (`pto` = the current carrier's `RemoteTransportPathMonitor.ptoMs()`).
   *  The caller then sends ONE probe (§6.2.4): a ping whose `sent` is
   *  `probeThrough`, which lets the receiver detect a lost tail. pto_count
   *  doubles the timeout per expiry and resets on an ack advance (§6.2.1). */
  probeDue(now: number, pto: number): boolean {
    if (this.ptoArmedAt === null || this.highestSent <= this.acked) return false;
    if (now - this.ptoArmedAt < pto * 2 ** this.ptoCount) return false;
    this.ptoCount += 1;
    this.ptoArmedAt = now;
    return true;
  }

  /** The highest sequence whose bytes have certainly left `carrier`'s queue:
   *  bytes handed to it minus its `bufferedAmount` (wire bytes, which include
   *  framing, so the estimate errs low and never invites an early repair).
   *  Sent as `ping.sent`; the receiver repairs what at or below it never
   *  arrived — including a lost final record. */
  probeThrough(carrier: RemoteTransportCarrierId, bufferedAmount: number): number {
    const drained = (this.handed.get(carrier) ?? 0) - Math.max(0, bufferedAmount);
    let through = this.acked;
    for (const entry of this.retained.values()) {
      if (entry.carrier === carrier && !entry.pending && entry.handedEnd <= drained) {
        through = Math.max(through, entry.sequence);
      }
    }
    return through;
  }

  /** A carrier was demoted or closed: what was last handed to it becomes a
   *  re-send for the next carrier, held for `holdMs` — one PTO of the
   *  surviving carrier (`RemoteTransportPathMonitor.ptoMs`). The hold is a
   *  Mixdog optimization, not something RFC 9002 prescribes: it only borrows
   *  the PTO as "time to wait for an acknowledgment" — or until an
   *  ack newer than every control message observed before this point
   *  arrives, whichever is first. That ack is taken as the resume point; it
   *  is not proof that it was sealed after the failure. Late copies still in
   *  flight on the old carrier become harmless duplicates. */
  carrierFailed(carrier: RemoteTransportCarrierId, now: number, holdMs: number): number {
    let count = 0;
    for (const entry of this.retained.values()) {
      if (entry.carrier !== carrier || entry.pending) continue;
      entry.pending = true;
      entry.resend = true;
      count += 1;
    }
    this.handed.delete(carrier);
    if (count > 0) {
      this.holdUntil = now + Math.max(0, holdMs);
      this.resumeAfter = this.controlSeen;
    }
    return count;
  }

  /** The receiver discarded, evicted or never got `sequences` (one repair
   *  round, one box): send them again at once. Returns how many were
   *  re-queued. Only from an authenticated control box; its control sequence
   *  makes every selective ack sealed before it powerless over these
   *  records, whatever order the two lanes deliver them in. */
  repair(message: RemoteTransportRepair): number {
    const controlSequence = authenticated.get(message);
    if (controlSequence === undefined || message.t !== 'repair') fail('repair (unauthenticated)');
    this.controlSeen = Math.max(this.controlSeen, controlSequence);
    let count = 0;
    for (const sequence of message.sequences) {
      // A forged chunk for a record not yet sent can be evicted at the
      // receiver and asked for: nothing to repair, and no reason to end the
      // session.
      const entry = sequence <= this.highestSent ? this.retained.get(sequence) : undefined;
      if (!entry) continue;
      entry.repairedBy = Math.max(entry.repairedBy, controlSequence);
      entry.pending = true;
      entry.resend = true;
      entry.held = false;
      count += 1;
    }
    return count;
  }

  private release(entry: Retained): void {
    this.retained.delete(entry.sequence);
    this.bytes -= entry.charge;
    if (entry.stream === null) return;
    this.bulkBytes -= entry.charge;
    const left = (this.streamBytes.get(entry.stream) ?? 0) - entry.charge;
    if (left > 0) this.streamBytes.set(entry.stream, left);
    else this.streamBytes.delete(entry.stream);
  }

  /** Applies an ack that came out of an authenticated control box
   *  (`readRemoteTransportControl`). Anything else is refused, as is an ack
   *  naming a record never sent. Only `through` releases buffers, and it only
   *  ever moves forward, whatever order acks arrive in; `ranges` only spare
   *  re-sends, and only for records not repaired by a LATER control message.
   *  An ack sealed after a carrier failure ends its hold: it is the resume
   *  point. Returns how many records it released. */
  acknowledge(ack: RemoteTransportAck, now: number): number {
    const controlSequence = authenticated.get(ack);
    if (controlSequence === undefined || ack.t !== 'ack') fail('ack (unauthenticated)');
    const ranges = ack.ranges ?? [];
    if (ack.through > this.highestSent || ranges.some(([, last]) => last > this.highestSent)) fail('ack (beyond sent)');
    this.controlSeen = Math.max(this.controlSeen, controlSequence);
    if (controlSequence > this.resumeAfter) this.holdUntil = null;
    for (const [first, last] of ranges) {
      for (let sequence = Math.max(first, this.acked + 1); sequence <= last; sequence += 1) {
        const entry = this.retained.get(sequence);
        if (entry && controlSequence > entry.repairedBy) entry.held = true;
      }
    }
    if (ack.through <= this.acked) return 0;
    let released = 0;
    for (let sequence = this.acked + 1; sequence <= ack.through; sequence += 1) {
      const entry = this.retained.get(sequence);
      if (!entry) continue;
      this.release(entry);
      released += 1;
    }
    this.acked = ack.through;
    this.progressAt = this.retained.size > 0 ? now : null;
    this.ptoCount = 0;
    this.ptoArmedAt = now;
    return released;
  }

  /** True once records are outstanding and no ack has advanced for
   *  REMOTE_TRANSPORT_RECORD_EXPIRY_MS: the caller must end the session (a
   *  new authenticated session resets the stream) and fail unacked calls as
   *  ambiguous. A slow link that keeps acking never expires. */
  expired(now: number): boolean {
    return (
      this.retained.size > 0 && this.progressAt !== null && now - this.progressAt >= REMOTE_TRANSPORT_RECORD_EXPIRY_MS
    );
  }

  stats(): RemoteTransportSenderStats {
    return {
      nextSequence: this.expected,
      ackedThrough: this.acked,
      retainedRecords: this.retained.size,
      outstandingBytes: this.bytes,
      bulkBytes: this.bulkBytes,
      retransmits: this.retransmits,
    };
  }
}

// ---------------------------------------------------------------------------
// Receiver stream core
// ---------------------------------------------------------------------------

export type RemoteTransportAcceptResult =
  | 'buffered'
  | 'duplicate'
  | 'out-of-window'
  | 'over-memory'
  /** The chunk's embedded box sequence is not the sequence it claims. */
  | 'mismatch';

/** One possible reading of a slot. Geometry (`total`) is unauthenticated
 *  until the assembled box opens, so rival geometries are separate
 *  candidates; the buffer is allocated only after `total` bytes were
 *  reserved. A whole record is a complete candidate of one part. */
interface Candidate {
  total: number;
  buffer: Uint8Array;
  /** Per-chunk presence; null for a whole record. */
  filled: Uint8Array | null;
  count: number;
  received: number;
  progressAt: number;
}

interface Slot {
  candidates: Candidate[];
  bytes: number;
}

export interface RemoteTransportReceiverStats {
  deliveredThrough: number;
  bufferedRecords: number;
  /** Charged bytes (`remoteTransportRecordCharge` per candidate). */
  bufferedBytes: number;
  headBytes: number;
  futureBytes: number;
  duplicates: number;
  discarded: number;
  evicted: number;
}

/** Whether `head` (a box prefix) is an app box sealed under `sequence`. */
function headerNames(head: Uint8Array, sequence: number): boolean {
  if (head.byteLength < 12 || !hasMagic(head, 0, BOX_MAGIC)) return false;
  return new DataView(head.buffer, head.byteOffset, 12).getBigUint64(4, false) === BigInt(sequence);
}

const complete = (candidate: Candidate): boolean => candidate.received === candidate.count;

/** Reorders, dedups and reassembles application records BEFORE decryption,
 *  inside a fixed memory budget that is reserved before any allocation:
 *    head    the next required record has its own reserve
 *            (REMOTE_TRANSPORT_HEAD_RESERVE_BYTES), so nothing queued behind
 *            it — honest or forged — can starve it;
 *    future  later records share REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES.
 *  A slot is only exposed once a candidate is complete AND names the slot's
 *  own sequence; rival geometries assemble side by side (at most
 *  REMOTE_TRANSPORT_CANDIDATES_PER_SLOT), and an incomplete one that stops
 *  progressing is evicted, so no forged chunk can hold a slot for good.
 *  `next()` hands out the head candidate; the caller opens it (one at a time)
 *  and reports `commit` (opened: accepted, ackable) or `discard` (failed
 *  authentication: that candidate goes, the sender's retransmission refills).
 *  Pure: time is passed in. */
export class RemoteTransportReceiver {
  private readonly slots = new Map<number, Slot>();
  private delivered = 0;
  private bytes = 0;
  private ackedThrough = 0;
  private unackedRecords = 0;
  private unackedSince: number | null = null;
  private forceAck = false;
  private duplicates = 0;
  private discarded = 0;
  private evicted = 0;
  /** Copies discarded or evicted here: explicit losses, declared next round. */
  private readonly repairs = new Set<number>();
  /** Missing, not yet declared lost: when the evidence (a later record, or
   *  `ping.sent`) arrived — the start of the RFC 9002 §6.1.2 time threshold. */
  private readonly gaps = new Map<number, number>();
  /** Declared lost (repair already requested once); recovered by PTO. */
  private readonly lost = new Set<number>();
  /** Every sequence at or below this has been looked at for evidence. */
  private evidenceThrough = 0;
  /** Highest record sequence that has arrived (packet threshold, §6.1.1). */
  private highestArrived = 0;
  /** RFC 9002 §6.2 PTO state of the repair requests: last request, pto_count. */
  private ptoArmedAt: number | null = null;
  private ptoCount = 0;

  private headBytes(): number {
    return this.slots.get(this.delivered + 1)?.bytes ?? 0;
  }

  /** Room for `size` more bytes in `sequence`'s slot after freeing `freed`. */
  private fits(sequence: number, slot: Slot | undefined, size: number, freed: number): boolean {
    const slotBytes = (slot?.bytes ?? 0) - freed + size;
    if (slotBytes > REMOTE_TRANSPORT_CANDIDATES_PER_SLOT * REMOTE_TRANSPORT_MAX_RECORD_BYTES) return false;
    if (sequence === this.delivered + 1) return true;
    return this.bytes - this.headBytes() - freed + size <= REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES;
  }

  private removeCandidate(sequence: number, slot: Slot, candidate: Candidate): void {
    slot.candidates.splice(slot.candidates.indexOf(candidate), 1);
    slot.bytes -= remoteTransportRecordCharge(candidate.total);
    this.bytes -= remoteTransportRecordCharge(candidate.total);
    if (slot.candidates.length === 0) this.slots.delete(sequence);
  }

  private hasComplete(sequence: number): boolean {
    return this.slots.get(sequence)?.candidates.some(complete) ?? false;
  }

  /** Marks every sequence above what was already examined, up to
   *  `through`, as missing since `now` unless a complete copy is here. */
  private noteEvidence(through: number, now: number): void {
    const last = Math.min(through, this.delivered + REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT);
    for (let sequence = Math.max(this.delivered, this.evidenceThrough) + 1; sequence <= last; sequence += 1) {
      if (!this.hasComplete(sequence) && !this.lost.has(sequence) && !this.gaps.has(sequence)) {
        this.gaps.set(sequence, now);
      }
    }
    this.evidenceThrough = Math.max(this.evidenceThrough, last);
  }

  /** Evicts every incomplete assembly that made no progress for one idle
   *  timeout (`RemoteTransportPathMonitor.idleTimeoutMs`, RFC 9000 §10.1: an
   *  assembly that silent is as dead as a silent path). Call on a timer;
   *  `accept` also runs it when the budget is short. */
  sweep(now: number, idleMs: number = REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS): number {
    let count = 0;
    for (const [sequence, slot] of [...this.slots]) {
      for (const candidate of [...slot.candidates]) {
        if (complete(candidate) || now - candidate.progressAt < idleMs) continue;
        this.removeCandidate(sequence, slot, candidate);
        this.repairs.add(sequence);
        count += 1;
      }
    }
    this.evicted += count;
    return count;
  }

  accept(message: Exclude<RemoteTransportMessage, { kind: 'control' }>, now: number): RemoteTransportAcceptResult {
    const { sequence } = message;
    if (sequence <= this.delivered) {
      // The sender may have lost our ack: say it again.
      this.duplicates += 1;
      this.forceAck = true;
      this.unackedSince ??= now;
      return 'duplicate';
    }
    if (sequence > this.delivered + REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT) return 'out-of-window';
    // Chunk 0 carries the box header: its embedded sequence must be the one
    // the chunk claims (a whole record's sequence IS its header's).
    if (message.kind === 'chunk' && message.index === 0 && !headerNames(message.data, sequence)) return 'mismatch';
    // A later record is evidence about every earlier one (RFC 9002 §6.1).
    if (sequence > this.highestArrived) {
      this.highestArrived = sequence;
      this.noteEvidence(sequence - 1, now);
    }
    let slot = this.slots.get(sequence);
    if (message.kind === 'chunk') {
      const same = slot?.candidates.find((candidate) => candidate.filled && candidate.total === message.total);
      if (same) {
        if (complete(same) || same.filled![message.index]) {
          this.duplicates += 1;
          return 'duplicate';
        }
        same.buffer.set(message.data, message.index * REMOTE_TRANSPORT_CHUNK_BYTES);
        same.filled![message.index] = 1;
        same.received += 1;
        same.progressAt = now;
        // Belt and braces for the header check above: a complete assembly is
        // exposed only when its box names this slot.
        if (complete(same) && !headerNames(same.buffer, sequence)) {
          this.removeCandidate(sequence, slot!, same);
          this.discarded += 1;
          return 'mismatch';
        }
        return 'buffered';
      }
    } else if (slot?.candidates.some((candidate) => !candidate.filled)) {
      this.duplicates += 1;
      return 'duplicate';
    }
    const total = message.kind === 'app' ? message.box.byteLength : message.total;
    // A full slot makes room by evicting its least advanced incomplete rival.
    let victim: Candidate | null = null;
    if (slot && slot.candidates.length >= REMOTE_TRANSPORT_CANDIDATES_PER_SLOT) {
      for (const candidate of slot.candidates) {
        if (complete(candidate)) continue;
        if (
          !victim ||
          candidate.received < victim.received ||
          (candidate.received === victim.received && candidate.progressAt < victim.progressAt)
        ) {
          victim = candidate;
        }
      }
      if (!victim) {
        this.duplicates += 1;
        return 'duplicate';
      }
    }
    // Every candidate is charged at least one carrier message, so many tiny
    // (forged) records are bounded by bytes like large ones.
    const charge = remoteTransportRecordCharge(total);
    const freed = (): number => (victim ? remoteTransportRecordCharge(victim.total) : 0);
    if (!this.fits(sequence, slot, charge, freed())) {
      this.sweep(now);
      slot = this.slots.get(sequence);
      if (victim && !slot?.candidates.includes(victim)) victim = null;
      if (!this.fits(sequence, slot, charge, freed())) return 'over-memory';
    }
    if (victim && slot) {
      this.removeCandidate(sequence, slot, victim);
      this.repairs.add(sequence);
      this.evicted += 1;
      slot = this.slots.get(sequence);
    }
    // Reserved: allocate.
    let candidate: Candidate;
    if (message.kind === 'app') {
      candidate = { total, buffer: message.box, filled: null, count: 1, received: 1, progressAt: now };
    } else {
      const buffer = new Uint8Array(total);
      buffer.set(message.data, message.index * REMOTE_TRANSPORT_CHUNK_BYTES);
      const filled = new Uint8Array(message.count);
      filled[message.index] = 1;
      candidate = { total, buffer, filled, count: message.count, received: 1, progressAt: now };
    }
    if (!slot) {
      slot = { candidates: [], bytes: 0 };
      this.slots.set(sequence, slot);
    }
    slot.candidates.push(candidate);
    slot.bytes += charge;
    this.bytes += charge;
    return 'buffered';
  }

  private headCandidate(): Candidate | null {
    return this.slots.get(this.delivered + 1)?.candidates.find(complete) ?? null;
  }

  /** The next box in order, complete, naming its own sequence, not yet
   *  opened; null when none has arrived. Repeated calls return the same box
   *  until commit/discard. */
  next(): { sequence: number; box: Uint8Array } | null {
    const candidate = this.headCandidate();
    return candidate ? { sequence: this.delivered + 1, box: candidate.buffer } : null;
  }

  /** The head box opened under the session key: it is accepted. */
  commit(sequence: number, now: number): void {
    if (sequence !== this.delivered + 1) fail('commit order');
    const slot = this.slots.get(sequence);
    const candidate = this.headCandidate();
    if (!slot || !candidate) fail('commit slot');
    this.bytes -= slot.bytes;
    this.slots.delete(sequence);
    this.delivered = sequence;
    this.unackedRecords += 1;
    this.unackedSince ??= now;
    this.gaps.delete(sequence);
    this.lost.delete(sequence);
    // Progress resets pto_count (RFC 9002 §6.2.1); a sequence already
    // declared lost stays declared, so it is never re-declared (and never
    // repaired at once again) — its later requests are PTO probes only.
    this.ptoCount = 0;
    if (this.lost.size > 0) this.ptoArmedAt = now;
  }

  /** The head box failed authentication: that candidate goes; a rival, or
   *  the copy `repairDue` asks the sender for, fills the slot. */
  discard(sequence: number): void {
    if (sequence !== this.delivered + 1) return;
    const slot = this.slots.get(sequence);
    const candidate = this.headCandidate();
    if (!slot || !candidate) return;
    this.removeCandidate(sequence, slot, candidate);
    this.discarded += 1;
    this.repairs.add(sequence);
  }

  /** An authenticated `ping.sent`: everything up to it has left the
   *  sender's queue, so it is evidence about every sequence at or below it
   *  (RFC 9002 §6.1, time threshold only) — the only way to find a lost
   *  FINAL record, which no later record can reveal. */
  probe(sent: number, now: number): void {
    this.noteEvidence(sent, now);
  }

  /** The sequences to repair now, lowest first: ONE repair round, sealed as
   *  ONE control box (`remoteTransportRepair(sequences)`) when not empty.
   *  Nothing is re-sent on a timer at the sender, so this is the only loss
   *  recovery on a working carrier. It is an ADAPTATION of RFC 9002 run at
   *  the receiver (differences: docs/remote-transport.md §3), `rtt` being
   *  the current carrier's estimator (`RemoteTransportPathMonitor`):
   *    declare lost  a sequence with no complete copy is declared lost, and
   *                  its repair requested once, when
   *                  - its copy was discarded or evicted here (explicit), or
   *                  - a record REMOTE_TRANSPORT_PACKET_THRESHOLD or more
   *                    sequences later has arrived (§6.1.1), or
   *                  - the evidence that it was sent (a later record, or
   *                    `ping.sent`) arrived at least `rtt.lossDelayMs()`
   *                    ago: kTimeThreshold × max(smoothed_rtt, latest_rtt),
   *                    at least kGranularity (§6.1.2).
   *                  A sequence is declared at most once; further discards
   *                  and evictions of it change nothing.
   *    PTO probes    while declared sequences are still missing, a probe
   *                  timeout of `rtt.ptoMs()` × 2^pto_count since the last
   *                  request re-requests the REMOTE_TRANSPORT_PTO_PROBES
   *                  lowest of them (§6.2.1, §6.2.4) and doubles pto_count;
   *                  delivery progress resets pto_count (§6.2.1).
   *  The session-wide repair budget follows: at most one declared repair per
   *  sequence, plus REMOTE_TRANSPORT_PTO_PROBES per backed-off PTO. */
  repairDue(now: number, rtt: RemoteTransportRttEstimate = initialRttEstimate()): number[] {
    const out: number[] = [];
    const declare = (sequence: number): void => {
      this.gaps.delete(sequence);
      this.lost.add(sequence);
      out.push(sequence);
    };
    for (const sequence of this.repairs) {
      if (sequence > this.delivered && !this.lost.has(sequence)) declare(sequence);
    }
    this.repairs.clear();
    const lossDelay = rtt.lossDelayMs();
    for (const [sequence, since] of [...this.gaps]) {
      if (sequence <= this.delivered || this.hasComplete(sequence)) {
        this.gaps.delete(sequence);
      } else if (sequence + REMOTE_TRANSPORT_PACKET_THRESHOLD <= this.highestArrived || now - since >= lossDelay) {
        declare(sequence);
      }
    }
    for (const sequence of [...this.lost]) if (sequence <= this.delivered) this.lost.delete(sequence);
    if (out.length > 0) {
      this.ptoArmedAt = now;
    } else if (
      this.lost.size > 0 &&
      this.ptoArmedAt !== null &&
      now - this.ptoArmedAt >= rtt.ptoMs() * 2 ** this.ptoCount
    ) {
      const probes = [...this.lost]
        .filter((sequence) => !this.hasComplete(sequence))
        .sort((a, b) => a - b)
        .slice(0, REMOTE_TRANSPORT_PTO_PROBES);
      if (probes.length > 0) {
        out.push(...probes);
        this.ptoCount += 1;
        this.ptoArmedAt = now;
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** The carrier changed (promotion or demotion): the resume point goes out
   *  at once, on the surviving carrier, with the selective ranges. */
  carrierChanged(now: number): void {
    this.forceAck = true;
    this.unackedSince ??= now;
  }

  /** Complete records above the delivered point, as ascending ranges (most
   *  REMOTE_TRANSPORT_MAX_ACK_RANGES, lowest first). */
  private heldRanges(): Array<[number, number]> {
    const held = [...this.slots]
      .filter(([sequence, slot]) => sequence > this.delivered && slot.candidates.some(complete))
      .map(([sequence]) => sequence)
      .sort((a, b) => a - b);
    const ranges: Array<[number, number]> = [];
    for (const sequence of held) {
      const last = ranges.at(-1);
      if (last && sequence === last[1] + 1) last[1] = sequence;
      else if (ranges.length < REMOTE_TRANSPORT_MAX_ACK_RANGES) ranges.push([sequence, sequence]);
      else break;
    }
    return ranges;
  }

  /** The ack to send now, or null (RFC 9000 §13.2): after
   *  REMOTE_TRANSPORT_ACK_ELICITING_THRESHOLD accepted records, after
   *  max_ack_delay, or at once for a duplicate of a delivered record or a
   *  carrier change. `through` is cumulative over OPENED records; `ranges`
   *  name complete-but-unopened ones (hints, see RemoteTransportAck). Seal
   *  `remoteTransportAck(through, ranges)` and call `ackSent(through)`. */
  ackDue(now: number): { through: number; ranges: Array<[number, number]> } | null {
    if (this.delivered === this.ackedThrough && !this.forceAck) return null;
    if (
      this.forceAck ||
      this.unackedRecords >= REMOTE_TRANSPORT_ACK_ELICITING_THRESHOLD ||
      (this.unackedSince !== null && now - this.unackedSince >= REMOTE_TRANSPORT_MAX_ACK_DELAY_MS)
    ) {
      return { through: this.delivered, ranges: this.heldRanges() };
    }
    return null;
  }

  ackSent(through: number): void {
    this.ackedThrough = Math.max(this.ackedThrough, through);
    this.unackedRecords = 0;
    this.unackedSince = null;
    this.forceAck = false;
  }

  stats(): RemoteTransportReceiverStats {
    return {
      deliveredThrough: this.delivered,
      bufferedRecords: this.slots.size,
      bufferedBytes: this.bytes,
      headBytes: this.headBytes(),
      futureBytes: this.bytes - this.headBytes(),
      duplicates: this.duplicates,
      discarded: this.discarded,
      evicted: this.evicted,
    };
  }
}

// ---------------------------------------------------------------------------
// Path health: RFC 9002 RTT estimation, PTO, idle timeout, stall detection
// ---------------------------------------------------------------------------

export type RemoteTransportStall = 'silent' | 'no-progress';

/** What loss recovery needs from a carrier's RTT state (RFC 9002 §5, §6). */
export interface RemoteTransportRttEstimate {
  /** kTimeThreshold × max(smoothed_rtt, latest_rtt), at least kGranularity (§6.1.2). */
  lossDelayMs(): number;
  /** smoothed_rtt + max(4 × rttvar, kGranularity) + max_ack_delay (§6.2.1). */
  ptoMs(): number;
}

/** One carrier's health, reset whenever the carrier changes (RFC 9000 §9.4:
 *  a new path starts with fresh RTT state, here RFC 9002 §6.2.2's initial
 *  values). Demotion is decided on PROGRESS, never on a record's age: a slow
 *  uplink behind a full queue is healthy as long as its queue drains or acks
 *  advance.
 *    silent       no authenticated inbound (records, acks, pongs) for the idle
 *                 timeout: max(max_idle_timeout, 3 × PTO) (RFC 9000 §10.1);
 *    no-progress  an APPLICATION-PROGRESS POLICY (Mixdog's, not an RFC
 *                 rule): records outstanding, and for the relay's own 6 s
 *                 bound (REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS, the source the
 *                 `silent` rule uses) since the work became outstanding,
 *                 neither has the ack advanced nor `bufferedAmount` actually
 *                 decreased. It does not depend on the RTT, so a fast path
 *                 whose peer is slow to accept is not demoted early. An
 *                 empty queue is not progress.
 *  Pure: time is passed in. */
export class RemoteTransportPathMonitor implements RemoteTransportRttEstimate {
  private lastInbound = 0;
  private lastAckAdvance = 0;
  private lastDrain = 0;
  private lastBuffered = 0;
  private outstandingSince: number | null = null;
  private sampled = false;
  private smoothedRtt = REMOTE_TRANSPORT_INITIAL_RTT_MS;
  private rttvar = REMOTE_TRANSPORT_INITIAL_RTT_MS / 2;
  private latestRtt = 0;
  private minRtt = Number.POSITIVE_INFINITY;

  constructor(now: number) {
    this.reset(now);
  }

  /** A new carrier (promotion, demotion, ICE restart): forget everything;
   *  RTT state returns to RFC 9002 §6.2.2 (smoothed_rtt = kInitialRtt,
   *  rttvar = kInitialRtt / 2). */
  reset(now: number): void {
    this.lastInbound = now;
    this.lastAckAdvance = now;
    this.lastDrain = now;
    this.lastBuffered = 0;
    this.outstandingSince = null;
    this.sampled = false;
    this.smoothedRtt = REMOTE_TRANSPORT_INITIAL_RTT_MS;
    this.rttvar = REMOTE_TRANSPORT_INITIAL_RTT_MS / 2;
    this.latestRtt = 0;
    this.minRtt = Number.POSITIVE_INFINITY;
  }

  /** The sender's outstanding bytes after every push and ack
   *  (`RemoteTransportSender.stats().outstandingBytes`): the no-progress
   *  interval starts the moment work becomes outstanding, never at an older
   *  ack or drain. */
  outstanding(bytes: number, now: number): void {
    if (bytes <= 0) this.outstandingSince = null;
    else this.outstandingSince ??= now;
  }

  /** Authenticated traffic arrived on this carrier (RFC 9000 §10.1 restarts
   *  the idle timer on every successfully processed packet). */
  inbound(now: number): void {
    this.lastInbound = now;
  }

  /** An ack released records. */
  ackAdvanced(now: number): void {
    this.lastAckAdvance = now;
  }

  /** A `bufferedAmount` sample of this carrier's channel. Only an actual
   *  decrease is drain progress. */
  buffered(amount: number, now: number): void {
    if (amount < this.lastBuffered) this.lastDrain = now;
    this.lastBuffered = amount;
  }

  /** One ping/pong round trip, estimated as RFC 9002 §5.3 says. A pong is
   *  sent at once, so its ack_delay is 0 and adjusted_rtt = latest_rtt. */
  rttSample(latestRtt: number): void {
    this.latestRtt = latestRtt;
    if (!this.sampled) {
      this.sampled = true;
      this.minRtt = latestRtt;
      this.smoothedRtt = latestRtt;
      this.rttvar = latestRtt / 2;
      return;
    }
    this.minRtt = Math.min(this.minRtt, latestRtt);
    const adjustedRtt = latestRtt;
    this.rttvar = (3 / 4) * this.rttvar + (1 / 4) * Math.abs(this.smoothedRtt - adjustedRtt);
    this.smoothedRtt = (7 / 8) * this.smoothedRtt + (1 / 8) * adjustedRtt;
  }

  smoothedRttMs(): number {
    return this.smoothedRtt;
  }

  lossDelayMs(): number {
    return Math.max(
      (REMOTE_TRANSPORT_TIME_THRESHOLD_NUM * Math.max(this.smoothedRtt, this.latestRtt)) /
        REMOTE_TRANSPORT_TIME_THRESHOLD_DEN,
      REMOTE_TRANSPORT_GRANULARITY_MS
    );
  }

  ptoMs(): number {
    return (
      this.smoothedRtt + Math.max(4 * this.rttvar, REMOTE_TRANSPORT_GRANULARITY_MS) + REMOTE_TRANSPORT_MAX_ACK_DELAY_MS
    );
  }

  /** RFC 9000 §10.1: at least three times the current PTO. */
  idleTimeoutMs(): number {
    return Math.max(REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS, 3 * this.ptoMs());
  }

  stalled(now: number, outstandingBytes: number): RemoteTransportStall | null {
    this.outstanding(outstandingBytes, now);
    if (now - this.lastInbound >= this.idleTimeoutMs()) return 'silent';
    if (this.outstandingSince === null) return null;
    const progress = Math.max(this.outstandingSince, this.lastAckAdvance, this.lastDrain);
    return now - progress >= REMOTE_TRANSPORT_MAX_IDLE_TIMEOUT_MS ? 'no-progress' : null;
  }
}

/** The estimate of a carrier with no sample yet (RFC 9002 §6.2.2). */
function initialRttEstimate(): RemoteTransportRttEstimate {
  return new RemoteTransportPathMonitor(0);
}

// ---------------------------------------------------------------------------
// Diagnostics (never content)
// ---------------------------------------------------------------------------

export type RemoteTransportPath = 'relay' | 'direct' | 'turn';
export type RemoteTransportPathReason =
  | 'channel-open'
  | 'fingerprint-mismatch'
  | 'message-size'
  | 'stall'
  | 'channel-failed'
  | 'ice-failed'
  | 'negotiation-timeout'
  | 'peer-host-unavailable'
  | 'suspended'
  | 'session-ended';

export interface RemoteTransportDiagnostics {
  path: RemoteTransportPath;
  reason: RemoteTransportPathReason | null;
  bytesSent: number;
  bytesReceived: number;
  queueDepth: number;
  outstandingBytes: number;
  retransmits: number;
}
