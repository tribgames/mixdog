// Direct transport, phone side (docs/remote-transport.md, stage 1C): one
// transport session of the E2EE channel. Application messages go split →
// `canAdmit` → seal → sender → carrier; carrier messages come back receiver →
// open → commit or discard → assembler. The relay socket is always a carrier;
// the PC's offer adds a direct one (this side always answers), promoted only
// after its certificate, both channels, the message-size gate and one ping/pong
// round trip check out. Loss recovery, probing and demotion follow RFC 9002 as
// the shared stream core implements it. The PC→PC window runs this same page.
import { RELAY_E2EE_RELAY_LANE, type RelayE2EEChannel, type RelayE2EEControlLane } from '../shared/remote-e2ee';
import {
  REMOTE_TRANSPORT_MAX_DETAIL_CHARS,
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_BUFFER_LOW_BYTES,
  REMOTE_TRANSPORT_CHANNEL_LABEL,
  REMOTE_TRANSPORT_CONTROL_CHANNEL_LABEL,
  REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES,
  REMOTE_TRANSPORT_MAX_ACK_DELAY_MS,
  REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES,
  REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES,
  REMOTE_TRANSPORT_PREFIX_BYTES,
  remoteTransportControlBytes,
  REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS,
  REMOTE_TRANSPORT_PING_MS,
  REMOTE_TRANSPORT_VERSION,
  RemoteTransportMessageAssembler,
  RemoteTransportPathMonitor,
  RemoteTransportReceiver,
  RemoteTransportSender,
  assertRemoteTransportControlFits,
  decodeRemoteTransportMessage,
  encodeRemoteTransportControl,
  encodeRemoteTransportRecord,
  readRemoteTransportControl,
  remoteTransportAck,
  remoteTransportCarrierFits,
  remoteTransportPing,
  remoteTransportRepair,
  splitRemoteTransportPayload,
  type RemoteTransportAdmission,
  type RemoteTransportCarrierId,
  type RemoteTransportCloseReason,
  type RemoteTransportControl,
  type RemoteTransportDiagnostics,
  type RemoteTransportMessage,
  type RemoteTransportPathReason,
  type RemoteTransportReceiverStats,
  type RemoteTransportSenderStats,
  type RemoteTransportSignal,
  type RemoteTransportSignalRef,
} from '../shared/remote-transport';
import {
  REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
  remoteWebrtcCandidatePath,
  remoteWebrtcCertificateMatches,
  remoteWebrtcSdpFingerprints,
  type RemoteWebrtcFingerprint,
} from '../shared/remote-webrtc';
import { addIceCandidate, iceCandidateSignal } from './remote-ice-candidate';
import { remoteWebrtcPeerCertificate, remoteWebrtcSelectedPair } from './remote-webrtc-stats';

/** The phone's gate (docs/remote-transport.md §6): whether this page opts
 *  into `transportWebrtc` on its E2EE hello. It does so only when the PC
 *  itself offered it in this leg's challenge, with binary frames. Against a PC
 *  that did not (an older one), the hello, its proof and every frame are the
 *  legacy ones byte for byte. No separate
 *  consent is asked: the transport adds no authority (same E2EE session, the
 *  relay stays the fallback); the page only needs WebRTC to carry it. */
export function remoteTransportOptIn(
  challenge: { transportWebrtc?: unknown; binaryFrames?: unknown },
  webrtcAvailable: boolean = typeof RTCPeerConnection === 'function'
): boolean {
  return challenge.transportWebrtc === 1 && challenge.binaryFrames === 1 && webrtcAvailable;
}

const RELAY: RemoteTransportCarrierId = 'relay';
/** Outstanding pings remembered for RTT matching: the control anti-replay
 *  window (remote-e2ee.ts RELAY_E2EE_CONTROL_REPLAY_WINDOW); an older pong is
 *  stale there anyway. */
const MAX_PINGS = 64;
/** Control boxes that arrive before the handshake is confirmed, held until it
 *  is (same window). */
const MAX_EARLY_CONTROL = 64;
const MXE = [0x4d, 0x58, 0x45, 0x01] as const;

export interface RemoteTransportRelayCarrier {
  /** Hands one carrier message to the relay socket. Never droppable: the
   *  phone uplink has no droppable lane, and nothing here skips a send. */
  send(data: Uint8Array): void;
  bufferedAmount(): number;
}

export interface RemoteTransportPeerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** How often a carrier's buffer is looked at while a claim waits and nothing else prompts a look (the plain WebSocket has no event). */
const REMOTE_TRANSPORT_DEPARTURE_LOOK_MS = 50;

/** What one carrier's FIFO buffer says about a frame: it has left once the carrier's buffered amount is no greater than the bytes
 *  handed to the carrier AFTER that frame. Traffic sent later therefore never postpones it, and a frame still behind earlier unsent
 *  bytes has not left. It is a fact about this frame's bytes — local departure, never the far end's acknowledgement, which a dead link
 *  does not give. A claim is re-evaluated whenever more is enqueued, whenever the carrier reports its buffer draining (`check`), and by
 *  a local read while one waits (a plain WebSocket has no drain event, and a data channel's event fires only at its low mark, which
 *  does not settle a frame sitting above it). It rejects when the carrier stops being usable first: the bytes then did not leave. */
export class CarrierDeparture {
  private enqueued = 0;
  private waiters: Array<{ after: number; resolve(): void; reject(error: Error): void }> = [];
  private timer: unknown = null;
  constructor(
    private readonly read: () => number,
    private readonly usable: () => boolean,
    private readonly timers: RemoteTransportPeerTimers,
    private readonly everyMs: number = REMOTE_TRANSPORT_DEPARTURE_LOOK_MS
  ) {}

  /** Where the carrier's queue stands now: a frame enqueued up to here has everything after this behind it. */
  position(): number {
    return this.enqueued;
  }

  /** `bytes` were handed to the carrier. */
  enqueue(bytes: number): void {
    this.enqueued += bytes;
    this.check();
  }

  /** Resolves once everything handed to the carrier up to `position` has left it. */
  since(position: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ after: position, resolve, reject });
      this.check();
    });
  }

  /** Looks at the carrier again (it enqueued, it reported draining, or the look timer ran). */
  check(): void {
    if (this.waiters.length === 0) return;
    if (!this.usable()) {
      this.stop();
      for (const waiter of this.waiters.splice(0))
        waiter.reject(new Error('The carrier closed before the frame left it.'));
      return;
    }
    const buffered = this.read();
    // Oldest first: a later frame has more behind it never, less always, so claims resolve in the order they were made.
    while (this.waiters.length > 0 && buffered <= this.enqueued - this.waiters[0].after)
      this.waiters.shift()!.resolve();
    if (this.waiters.length === 0) {
      this.stop();
      return;
    }
    if (this.timer === null) {
      this.timer = this.timers.setTimeout(() => {
        this.timer = null;
        this.check();
      }, this.everyMs);
    }
  }

  private stop(): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** The carrier or session is over: whoever waits is told it did not leave. */
  end(): void {
    this.stop();
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('Relay transport session ended.'));
  }
}

export interface RemoteTransportPeerOptions {
  channel: RelayE2EEChannel;
  /** The E2EE challenge (the signals' `sessionId`, the media lane's `sid`). */
  sessionId: string;
  relay: RemoteTransportRelayCarrier;
  /** One whole application message, in order. The first one of a session
   *  must be `e2ee-ready`; the caller confirms it and then calls `confirm()`. */
  deliver(payload: unknown): void;
  /** One newly authenticated application record has arrived, before it is assembled into a message: called once per record when it
   *  is accepted, and not again when a held fragment is retried. Never for the relay's pong, an acknowledgement or repair request,
   *  a copy that failed authentication, or a record already accepted (a replay). The protocol client's health machine reads it as
   *  proof that the peer is alive while a large message is still arriving. */
  progress?(): void;
  /** The session must end (protocol error, expiry, stalled assembly). */
  fatal(error: Error): void;
  createPeer(configuration: RTCConfiguration): RTCPeerConnection;
  visible(): boolean;
  now?(): number;
  timers: RemoteTransportPeerTimers;
  log(line: string): void;
}

export interface RemoteTransportSendOptions {
  /** Coalescible traffic: refused (false) BEFORE sealing when the window has
   *  no room, instead of waiting. Nothing sealed is ever dropped. */
  droppable?: boolean;
  /** Media adapter stream id (bulk admission). */
  stream?: string;
}

export type RemoteTransportPeerDiagnostics = RemoteTransportDiagnostics & {
  sender: RemoteTransportSenderStats;
  receiver: RemoteTransportReceiverStats;
  relayRttMs: number;
  directRttMs: number | null;
};

export interface RemoteTransportPeer {
  /** One binary relay frame of this session. */
  receiveRelay(data: unknown): void;
  /** Resolves once the receive work already accepted (authentication, assembly: the peer's own promise chain) has been processed;
   *  work that arrives meanwhile is waited for too. */
  settled(): Promise<void>;
  /** The host's `e2ee-ready` passed `confirmHandshake`: sending may start. */
  confirm(): void;
  /** Resolves true once every part is sealed and handed to the sender; false
   *  when a droppable message found no room (nothing was sealed). Throws
   *  before sealing for a message over the 64 MiB cap. */
  send(payload: unknown, options?: RemoteTransportSendOptions): Promise<boolean>;
  /** Sends like `send`. Resolves true once its records were sealed AND
   *  handed to a carrier; false at once when that cannot happen right away
   *  (a message still queued ahead of it, no window room, no carrier room) —
   *  the message still goes when it can, nobody waits for it. */
  sendPromptly(payload: unknown): Promise<boolean>;
  /** Sends like `send`; resolves at admission (sealed, pushed) with the promise of DEPARTURE: it resolves once every record of the
   *  message was handed to a carrier and that carrier reports nothing of its app traffic still buffered (a local fact, never the far
   *  end's acknowledgement), and rejects when the session or that carrier ended first. Admission alone is not departure. */
  sendDeparting(payload: unknown): Promise<{ readonly departed: Promise<void> }>;
  /** The page went hidden: no timer runs from here until `wake`. */
  hidden(): void;
  /** Visible again (`visibilitychange`, `pageshow`, `resume`, `online`):
   *  ping at once on the direct control channel and the relay. */
  wake(): void;
  /** Background suspension: `close{suspended}` to the PC, then the peer closes. */
  suspend(): Promise<void>;
  close(): void;
  diagnostics(): RemoteTransportPeerDiagnostics;
}

interface Path {
  carrier: RemoteTransportCarrierId;
  monitor: RemoteTransportPathMonitor;
  /** Raised by every monitor reset: a ping timed before it is not a sample. */
  epoch: number;
}

interface Direct extends Path {
  /** Its control lane: the connection and the generation that created it. */
  lane: RelayE2EEControlLane;
  laneActive: boolean;
  connectionId: string;
  generation: number;
  pc: RTCPeerConnection;
  fingerprints: RemoteWebrtcFingerprint[];
  app: RTCDataChannel | null;
  control: RTCDataChannel | null;
  remoteSet: boolean;
  candidates: Array<RTCIceCandidateInit | null>;
  verified: boolean;
  turn: boolean;
  offeredAt: number;
  /** The path-validation ping in flight, and when it left. */
  validating: number | null;
  validatingAt: number;
  lastPingAt: number;
  /** Control boxes sealed for this lane and held, in lane order, while the
   *  aggregate bound has no room for them. */
  heldControl: Array<{ bytes: Uint8Array; onSent?: () => void }>;
  heldBytes: number;
  /** Wire bytes of control messages being sealed for this lane right now. */
  reservedBytes: number;
  /** The latest ack, ping and pong that found no room: not sealed yet. */
  coalesced: Map<'ack' | 'ping' | 'pong', { message: RemoteTransportControl; onSent?: () => void }>;
}

interface PingEntry {
  carrier: RemoteTransportCarrierId;
  epoch: number;
  sentAt: number;
  validation: boolean;
  wake: boolean;
}

const isOpen = (channel: RTCDataChannel | null): channel is RTCDataChannel => channel?.readyState === 'open';

/** Exact carrier bytes of one sealed control message: its JSON (never
 *  compressed), the box header and tag, and the transport prefix. */
const controlWireBytes = (message: RemoteTransportControl): number =>
  remoteTransportControlBytes(message) +
  (REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES - REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES) +
  REMOTE_TRANSPORT_PREFIX_BYTES;

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Both channels' send buffers of a direct carrier. */
const channelsBuffered = (d: Direct): number => (d.app?.bufferedAmount ?? 0) + (d.control?.bufferedAmount ?? 0);

const PATH_REASONS: Partial<Record<RemoteTransportCloseReason, RemoteTransportPathReason>> = {
  'fingerprint-mismatch': 'fingerprint-mismatch',
  'ice-failed': 'ice-failed',
  'negotiation-timeout': 'negotiation-timeout',
  stall: 'stall',
  suspended: 'suspended',
  'peer-host-unavailable': 'peer-host-unavailable',
  'session-ended': 'session-ended',
};

/** The state of a direct carrier the PC's offer opens, before any channel. */
const newDirect = (
  offer: Extract<RemoteTransportSignal, { t: 'offer' }>,
  pc: RTCPeerConnection,
  now: number
): Direct => ({
  carrier: `direct:${offer.connectionId}`,
  monitor: new RemoteTransportPathMonitor(now),
  epoch: 0,
  lane: { kind: 'direct', epoch: offer.generation, connectionId: offer.connectionId },
  laneActive: false,
  connectionId: offer.connectionId,
  generation: offer.generation,
  pc,
  fingerprints: offer.fingerprints,
  app: null,
  control: null,
  remoteSet: false,
  candidates: [],
  verified: false,
  turn: false,
  offeredAt: now,
  validating: null,
  validatingAt: 0,
  lastPingAt: now,
  heldControl: [],
  heldBytes: 0,
  reservedBytes: 0,
  coalesced: new Map(),
});

/** Unhooks and closes a direct carrier's connection and channels. */
const closeDirectConnection = (d: Direct): void => {
  const { pc } = d;
  pc.onicecandidate = null;
  pc.ondatachannel = null;
  pc.onconnectionstatechange = null;
  for (const ch of [d.app, d.control]) {
    if (!ch) continue;
    ch.onopen = null;
    ch.onmessage = null;
    ch.onclose = null;
    ch.onerror = null;
    ch.onbufferedamountlow = null;
    ch.close();
  }
  pc.close();
};

/** The pings in flight, for RTT matching. */
const createPingBook = () => {
  const pings = new Map<number, PingEntry>();
  let lastId = 0;
  return {
    add(entry: PingEntry): number {
      lastId += 1;
      pings.set(lastId, entry);
      for (const old of pings.keys()) {
        if (pings.size <= MAX_PINGS) break;
        pings.delete(old);
      }
      return lastId;
    },
    /** Consumed once, whatever follows. */
    take(id: number): PingEntry | undefined {
      const entry = pings.get(id);
      pings.delete(id);
      return entry;
    },
    dropCarrier(carrier: RemoteTransportCarrierId): void {
      for (const [id, entry] of pings) if (entry.carrier === carrier) pings.delete(id);
    },
  };
};

/** Everything the parts of one peer share: the collaborators, the paths and the mutable session state. */
interface PeerState {
  readonly options: RemoteTransportPeerOptions;
  readonly channel: RemoteTransportPeerOptions['channel'];
  readonly sessionId: RemoteTransportPeerOptions['sessionId'];
  readonly timers: RemoteTransportPeerOptions['timers'];
  readonly clock: () => number;
  readonly sender: RemoteTransportSender;
  readonly receiver: RemoteTransportReceiver;
  /** The page's own assembler on the process pool (this page is one session). */
  readonly assembler: RemoteTransportMessageAssembler;
  readonly relayPath: Path;
  readonly early: Array<[Uint8Array, RemoteTransportCarrierId]>;
  readonly roomWaiters: Array<() => void>;
  readonly pings: ReturnType<typeof createPingBook>;
  /** Per carrier, the bytes handed to its app queue (the relay's one buffer, or a data channel's app channel) and who waits on them. */
  readonly departures: Map<Path, CarrierDeparture>;
  /** Departure claims on sequences not yet handed to a carrier; a claim lives only until its sequence is first handed. */
  readonly handWaiters: Map<number, { hand(at: { path: Path; position: number }): void; fail(error: Error): void }>;
  current: Path;
  direct: Direct | null;
  generation: number;
  confirmed: boolean;
  ended: boolean;
  inbound: Promise<void>;
  sending: Promise<unknown>;
  fragmentId: number;
  /** An opened payload the process pool could not take yet (`wait`). */
  held: { value: unknown } | null;
  ackPending: boolean;
  hiddenSeen: boolean;
  /** Since this wake, nothing is proven until a wake ping is answered: record
   *  expiry, which counts time the page could not act in, waits for that. */
  wakeAt: number | null;
  timer: unknown;
  timerAt: number;
  reason: RemoteTransportPathReason | null;
  bytesSent: number;
  bytesReceived: number;
  /** The part of the totals above that moved on a direct carrier. */
  directBytesSent: number;
  directBytesReceived: number;
  /** The first application record written to a direct carrier is logged once. */
  directCarried: boolean;
  /** Messages handed to `send` and not yet sealed and pushed. */
  pendingSends: number;
  /** Highest sequence handed to a carrier (first sends go in order). */
  highestHanded: number;
  /** The newest connection the PC offered, kept for `close{suspended}`. */
  lastRef: RemoteTransportSignalRef | null;
}

const createPeerState = (options: RemoteTransportPeerOptions): PeerState => {
  const { channel, sessionId, timers } = options;
  const clock = options.now ?? (() => Date.now());
  const sender = new RemoteTransportSender();
  const receiver = new RemoteTransportReceiver();
  const assembler = new RemoteTransportMessageAssembler();
  const relayPath: Path = { carrier: RELAY, monitor: new RemoteTransportPathMonitor(clock()), epoch: 0 };
  return {
    options,
    channel,
    sessionId,
    timers,
    clock: () => clock(),
    sender,
    receiver,
    assembler,
    relayPath,
    early: [],
    roomWaiters: [],
    pings: createPingBook(),
    departures: new Map(),
    handWaiters: new Map(),
    current: relayPath,
    direct: null,
    generation: 0,
    confirmed: false,
    ended: false,
    inbound: Promise.resolve(),
    sending: Promise.resolve(),
    fragmentId: 0,
    held: null,
    ackPending: false,
    hiddenSeen: false,
    wakeAt: null,
    timer: null,
    timerAt: 0,
    reason: null,
    bytesSent: 0,
    bytesReceived: 0,
    directBytesSent: 0,
    directBytesReceived: 0,
    directCarried: false,
    pendingSends: 0,
    highestHanded: 0,
    lastRef: null,
  };
};

// --- Carrier access: paths, queue loads, departure books, raw carrier writes ---

const pathOf = (s: PeerState, carrier: RemoteTransportCarrierId): Path | null =>
  carrier === RELAY ? s.relayPath : s.direct?.carrier === carrier ? s.direct : null;

/** What a carrier holds queued: the relay socket's buffer, or a direct
 *  carrier's aggregate (both channels plus the control held or being
 *  sealed here). */
const load = (s: PeerState, path: Path): number =>
  path === s.relayPath
    ? s.options.relay.bufferedAmount()
    : channelsBuffered(path as Direct) + (path as Direct).heldBytes + (path as Direct).reservedBytes;

/** The app bytes still queued on a carrier: what `probeThrough` subtracts. */
const appQueued = (s: PeerState, path: Path): number =>
  path === s.relayPath ? s.options.relay.bufferedAmount() : ((path as Direct).app?.bufferedAmount ?? 0);

const outstanding = (s: PeerState): number => s.sender.stats().outstandingBytes;

const laneOf = (s: PeerState, path: Path): RelayE2EEControlLane =>
  path === s.relayPath ? RELAY_E2EE_RELAY_LANE : (path as Direct).lane;

const departureOf = (s: PeerState, path: Path): CarrierDeparture => {
  let found = s.departures.get(path);
  if (!found) {
    found =
      path === s.relayPath
        ? new CarrierDeparture(
            () => s.options.relay.bufferedAmount(),
            () => !s.ended,
            s.timers
          )
        : new CarrierDeparture(
            () => appQueued(s, path),
            () => !s.ended && isOpen((path as Direct).app),
            s.timers
          );
    s.departures.set(path, found);
  }
  return found;
};

const carrierSend = (s: PeerState, path: Path, kind: 'app' | 'control', message: Uint8Array): void => {
  if (path === s.relayPath) {
    s.options.relay.send(message);
    departureOf(s, path).enqueue(message.byteLength);
  } else {
    const target = kind === 'app' ? (path as Direct).app : (path as Direct).control;
    if (!isOpen(target)) throw new Error(`transport ${kind} channel is not open`);
    target.send(message as Uint8Array<ArrayBuffer>);
    if (kind === 'app') departureOf(s, path).enqueue(message.byteLength);
    s.directBytesSent += message.byteLength;
    if (kind === 'app' && !s.directCarried) {
      s.directCarried = true;
      s.options.log(`[mixdog-remote-transport] carrying path=${(path as Direct).turn ? 'turn' : 'direct'}`);
    }
  }
  s.bytesSent += message.byteLength;
};

const ref = (s: PeerState, d: Direct): RemoteTransportSignalRef => ({
  v: REMOTE_TRANSPORT_VERSION,
  sessionId: s.sessionId,
  connectionId: d.connectionId,
  generation: d.generation,
});

// --- Session end, send-room waiters and the timer ---

const end = (s: PeerState, error: unknown): void => {
  if (s.ended) return;
  closeSession(s);
  s.options.fatal(error instanceof Error ? error : new Error(String(error)));
};

const wakeRoom = (s: PeerState): void => {
  for (const resolve of s.roomWaiters.splice(0)) resolve();
};
const waitForRoom = (s: PeerState): Promise<void> => new Promise((resolve) => s.roomWaiters.push(resolve));

const schedule = (s: PeerState): void => {
  if (s.ended || !s.options.visible()) return;
  const busy =
    s.confirmed &&
    (s.ackPending ||
      s.held !== null ||
      s.roomWaiters.length > 0 ||
      s.sender.stats().retainedRecords > 0 ||
      s.receiver.stats().bufferedRecords > 0);
  const delay = busy ? REMOTE_TRANSPORT_MAX_ACK_DELAY_MS : REMOTE_TRANSPORT_PING_MS;
  const at = s.clock() + delay;
  if (s.timer !== null && s.timerAt <= at) return;
  if (s.timer !== null) s.timers.clearTimeout(s.timer);
  s.timerAt = at;
  s.timer = s.timers.setTimeout(() => tick(s), delay);
};

// --- Control lane: sealing, ordered release, pings and acks ---

/** Seals one control message FOR `path`'s lane and hands it to that lane
 *  in seal order (signals: the relay lane only). On a direct lane its wire
 *  bytes are reserved inside the aggregate bound BEFORE sealing (concurrent
 *  seals count), so channels, held and sealing control together never pass
 *  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES. Without room nothing more is sealed:
 *  an ack, ping or pong — idempotent, regenerable — is coalesced to the
 *  latest of its kind; a repair cannot wait, so the direct carrier fails
 *  (its records and the repair go to the relay lane). A box sealed for a
 *  direct carrier that failed meanwhile is dropped, never moved to the
 *  relay: its content is regenerated on the surviving carrier. */
const sendControl = async (
  s: PeerState,
  message: RemoteTransportControl,
  path: Path,
  onSent?: () => void
): Promise<void> => {
  if (!s.confirmed || s.ended || (path !== s.relayPath && path !== s.direct)) return;
  assertRemoteTransportControlFits(message);
  if (path === s.relayPath) {
    const box = await s.channel.sealControl(message, RELAY_E2EE_RELAY_LANE);
    if (s.ended) return;
    onSent?.();
    carrierSend(s, s.relayPath, 'control', encodeRemoteTransportControl(box));
    return;
  }
  const d = path as Direct;
  const size = controlWireBytes(message);
  if (load(s, d) + size > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) {
    if (message.t === 'ack' || message.t === 'ping' || message.t === 'pong') {
      d.coalesced.set(message.t, { message, onSent });
      awaitDrain(s, d);
      return;
    }
    failDirect(s, d, 'stall', 'control-backlog');
    await sendControl(s, message, s.relayPath);
    return;
  }
  d.reservedBytes += size;
  let box: Uint8Array;
  try {
    box = await s.channel.sealControl(message, d.lane);
  } catch {
    // The lane was retired meanwhile: nothing to send on it.
    d.reservedBytes -= size;
    return;
  }
  d.reservedBytes -= size;
  if (s.ended || s.direct !== d) return;
  // Seal results resolve in sequence order, so appending here keeps the
  // lane order; whatever is already held goes first.
  const bytes = encodeRemoteTransportControl(box);
  d.heldControl.push({ bytes, onSent });
  d.heldBytes += bytes.byteLength;
  releaseControl(s, d);
};

/** Writes held control boxes, in lane order, while the channels have room
 *  for the next one, then seals what was coalesced while there was none;
 *  otherwise waits for either channel to drain. */
const releaseControl = (s: PeerState, d: Direct): void => {
  while (s.direct === d && d.heldControl.length > 0) {
    const head = d.heldControl[0];
    if (channelsBuffered(d) + head.bytes.byteLength > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) {
      awaitDrain(s, d);
      return;
    }
    d.heldControl.shift();
    d.heldBytes -= head.bytes.byteLength;
    head.onSent?.();
    try {
      carrierSend(s, d, 'control', head.bytes);
    } catch (error) {
      failDirect(s, d, 'channel-failed', String(error));
      return;
    }
  }
  for (const [kind, entry] of [...d.coalesced]) {
    if (s.direct !== d) return;
    if (load(s, d) + controlWireBytes(entry.message) > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) {
      awaitDrain(s, d);
      return;
    }
    d.coalesced.delete(kind);
    void sendControl(s, entry.message, d, entry.onSent).catch((e) => end(s, e));
  }
};

const control = (s: PeerState, message: RemoteTransportControl, path: Path): void => {
  void sendControl(s, message, path).catch((e) => end(s, e));
};

const ping = (s: PeerState, path: Path, kind: { validation?: boolean; wake?: boolean } = {}): number => {
  const now = s.clock();
  // Every ping carries `sent`: what has certainly left this carrier's queue.
  const sent = s.sender.probeThrough(path.carrier, appQueued(s, path));
  const entry: PingEntry = {
    carrier: path.carrier,
    epoch: path.epoch,
    sentAt: now,
    validation: kind.validation === true,
    wake: kind.wake === true,
  };
  const id = s.pings.add(entry);
  if (path !== s.relayPath) (path as Direct).lastPingAt = now;
  void sendControl(s, remoteTransportPing(id, sent), path, () => {
    entry.sentAt = s.clock();
  }).catch((e) => end(s, e));
  return id;
};

const ack = (s: PeerState, now: number): void => {
  const due = s.receiver.ackDue(now);
  if (!due) return;
  s.receiver.ackSent(due.through);
  s.ackPending = false;
  control(s, remoteTransportAck(due.through, due.ranges), s.current);
};

// --- Outbound records: departure claims, flushing, drain ---

const handed = (s: PeerState, sequence: number, path: Path, now: number): void => {
  s.sender.markSent(sequence, path.carrier, now);
  s.highestHanded = Math.max(s.highestHanded, sequence);
  const waiter = s.handWaiters.get(sequence);
  if (!waiter) return;
  s.handWaiters.delete(sequence);
  waiter.hand({ path, position: departureOf(s, path).position() });
};

/** The record `sequence` has left: it is handed to a carrier, and everything handed to that carrier up to and including it has left
 *  the carrier's buffer, whatever was queued behind it since. Claimed before the sequence can be handed. */
const departure = (s: PeerState, sequence: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    s.handWaiters.set(sequence, {
      hand: ({ path, position }) => departureOf(s, path).since(position).then(resolve, reject),
      fail: reject,
    });
  });

const flush = (s: PeerState): void => {
  if (!s.confirmed || s.ended) return;
  const path = s.current;
  const now = s.clock();
  // A validating (not current) direct lane still drains its held control.
  if (s.direct && s.direct !== path) releaseControl(s, s.direct);
  if (path === s.relayPath) {
    const queue = s.options.relay.bufferedAmount();
    if (queue < REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) {
      for (const { sequence, box } of s.sender.due(now, REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - queue)) {
        for (const message of encodeRemoteTransportRecord(box)) carrierSend(s, path, 'app', message);
        handed(s, sequence, path, now);
      }
    }
  } else {
    const d = path as Direct;
    // Control first, in lane order; then app records, budgeted against the
    // aggregate of both channels and the held control, short of the
    // control reserve, and never past it (a record that does not fit waits).
    releaseControl(s, d);
    if (s.direct !== d) return;
    let room = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES - load(s, d);
    for (const { sequence, box } of s.sender.due(now, Math.max(0, room))) {
      const messages = encodeRemoteTransportRecord(box);
      const wire = messages.reduce((sum, message) => sum + message.byteLength, 0);
      if (wire > room) break;
      try {
        for (const message of messages) carrierSend(s, d, 'app', message);
      } catch (error) {
        failDirect(s, d, 'channel-failed', String(error));
        return;
      }
      room -= wire;
      handed(s, sequence, d, now);
    }
    if (d.heldControl.length > 0 || d.coalesced.size > 0 || s.sender.due(now, 1).length > 0) awaitDrain(s, d);
  }
  schedule(s);
};

/** A direct channel's buffer fell: send on, then tell who waits on this carrier. The flush can close the carrier (a
 *  send that throws), which ends and removes its departure book: it is only looked up, never made again here. */
const drained = (s: PeerState, d: Direct): void => {
  flush(s);
  s.departures.get(d)?.check();
};

/** A direct carrier is at its bound: resume when EITHER channel fires its
 *  low event. The listeners are attached FIRST and the buffers read again
 *  right after, so a drain that happened in between is not missed. */
const awaitDrain = (s: PeerState, d: Direct): void => {
  const before = channelsBuffered(d);
  for (const ch of [d.app, d.control]) if (isOpen(ch)) ch.onbufferedamountlow = () => drained(s, d);
  if (channelsBuffered(d) < before) queueMicrotask(() => flush(s));
};

// --- Path switching: promotion, fallback to the relay, closing a direct carrier ---

const promote = (s: PeerState, d: Direct, now: number): void => {
  s.current = d;
  // Once per connection: a re-promotion after a wake or an ICE restart
  // keeps the lane as it is.
  if (!d.laneActive) {
    d.laneActive = true;
    s.channel.activateControlLane(d.lane);
  }
  d.monitor.reset(now);
  d.epoch += 1;
  d.lastPingAt = now;
  s.receiver.carrierChanged(now);
  s.ackPending = true;
  s.reason = 'channel-open';
  s.options.log(`[mixdog-remote-transport] path=${d.turn ? 'turn' : 'direct'} reason=channel-open`);
  ack(s, now);
  flush(s);
};

/** The direct carrier stops being used: what was last handed to it is
 *  re-sent on the relay after one relay PTO, or from the resume ack. */
const toRelay = (s: PeerState, now: number, why: RemoteTransportPathReason): void => {
  if (s.current === s.relayPath) return;
  const failed = s.current;
  s.current = s.relayPath;
  s.sender.carrierFailed(failed.carrier, now, s.relayPath.monitor.ptoMs());
  s.relayPath.monitor.reset(now);
  s.relayPath.epoch += 1;
  s.receiver.carrierChanged(now);
  s.ackPending = true;
  s.reason = why;
  s.options.log(`[mixdog-remote-transport] path=relay reason=${why}`);
  ack(s, now);
  flush(s);
};

const closePeer = (s: PeerState, d: Direct, why: RemoteTransportPathReason): void => {
  if (s.direct !== d) return;
  if (s.current === d) toRelay(s, s.clock(), why);
  s.direct = null;
  // Boxes sealed for this lane and never sent are dropped, never moved to
  // the relay: their acks, repairs and pings are regenerated there.
  d.heldControl = [];
  d.heldBytes = 0;
  d.coalesced.clear();
  s.channel.retireControlLane(d.lane);
  s.pings.dropCarrier(d.carrier);
  // Nothing can still need this carrier's departure book but its own claims, which fail: its bytes did not leave.
  s.departures.get(d)?.end();
  s.departures.delete(d);
  closeDirectConnection(d);
};

/** A failure this side saw: the PC hears why (on the relay), the peer closes. */
const failDirect = (s: PeerState, d: Direct, why: RemoteTransportCloseReason, detail?: string): void => {
  if (s.direct !== d) return;
  s.options.log(`[mixdog-remote-transport] closing ${d.connectionId}: ${why}${detail ? ` (${detail})` : ''}`);
  control(
    s,
    {
      ...ref(s, d),
      t: 'close',
      reason: why,
      ...(detail ? { detail: detail.slice(0, REMOTE_TRANSPORT_MAX_DETAIL_CHARS) } : {}),
    },
    s.relayPath
  );
  closePeer(s, d, detail === 'max-message-size' ? 'message-size' : (PATH_REASONS[why] ?? 'channel-failed'));
};

// --- Direct connection setup: validation, channels, offer/answer, signals ---

/** Promotion gate (§5): certificate, both channels open, the SCTP message
 *  size, then one ping/pong round trip on the direct carrier. */
const maybeValidate = (s: PeerState, d: Direct): void => {
  if (s.direct !== d || s.current === d || !d.verified || d.validating !== null) return;
  if (!isOpen(d.app) || !isOpen(d.control)) return;
  if (!remoteTransportCarrierFits(d.pc.sctp?.maxMessageSize)) {
    failDirect(s, d, 'channel-failed', 'max-message-size');
    return;
  }
  d.validatingAt = s.clock();
  d.validating = ping(s, d, { validation: true });
};

const verify = async (s: PeerState, d: Direct): Promise<void> => {
  const report = await d.pc.getStats();
  if (s.direct !== d || d.verified) return;
  const certificate = remoteWebrtcPeerCertificate(report);
  if (!certificate || !remoteWebrtcCertificateMatches(d.fingerprints, certificate)) {
    failDirect(s, d, 'fingerprint-mismatch');
    return;
  }
  const pair = remoteWebrtcSelectedPair(report);
  d.turn = pair ? remoteWebrtcCandidatePath(pair) === 'relay' : false;
  d.verified = true;
  maybeValidate(s, d);
};

const bindChannel = (s: PeerState, d: Direct, ch: RTCDataChannel): void => {
  const isApp = ch.label === REMOTE_TRANSPORT_CHANNEL_LABEL;
  const isControl = ch.label === REMOTE_TRANSPORT_CONTROL_CHANNEL_LABEL;
  // Both reliable and ordered (§3): the control channel is a FIFO lane.
  if ((!isApp && !isControl) || (isApp ? d.app : d.control) || !ch.ordered) {
    failDirect(s, d, 'protocol-error', `unexpected channel ${ch.label}`);
    return;
  }
  ch.binaryType = 'arraybuffer';
  // Before anything is ever sent on it.
  ch.bufferedAmountLowThreshold = REMOTE_TRANSPORT_BUFFER_LOW_BYTES;
  if (isApp) d.app = ch;
  else d.control = ch;
  ch.onmessage = (event: MessageEvent) => receive(s, event.data, d.carrier);
  ch.onclose = () => failDirect(s, d, 'channel-failed');
  ch.onerror = () => failDirect(s, d, 'channel-failed');
  ch.onopen = () => maybeValidate(s, d);
  ch.onbufferedamountlow = () => drained(s, d);
  maybeValidate(s, d);
};

const addCandidate = (s: PeerState, d: Direct, candidate: RTCIceCandidateInit | null): void => {
  addIceCandidate(d.pc, d, candidate, (error) => {
    s.options.log(`[mixdog-remote-transport] candidate refused: ${String(error)}`);
  });
};

const answer = async (s: PeerState, d: Direct, sdp: string): Promise<void> => {
  await d.pc.setRemoteDescription({ type: 'offer', sdp });
  if (s.direct !== d) return;
  d.remoteSet = true;
  for (const candidate of d.candidates.splice(0)) addCandidate(s, d, candidate);
  const local = await d.pc.createAnswer();
  await d.pc.setLocalDescription(local);
  if (s.direct !== d) return;
  const answerSdp = d.pc.localDescription?.sdp ?? local.sdp ?? '';
  const fingerprints = remoteWebrtcSdpFingerprints(answerSdp);
  if (!fingerprints.length) throw new Error('answer without a fingerprint');
  await sendControl(s, { ...ref(s, d), t: 'answer', sdp: answerSdp, fingerprints }, s.relayPath);
};

const acceptOffer = (s: PeerState, offer: Extract<RemoteTransportSignal, { t: 'offer' }>, now: number): void => {
  if (offer.generation <= s.generation) return;
  s.generation = offer.generation;
  const previous = s.direct;
  if (previous && previous.connectionId === offer.connectionId) {
    // ICE restart on the same connection: traffic stays on the relay until
    // the path is validated again.
    if (s.current === previous) toRelay(s, now, 'channel-failed');
    previous.generation = offer.generation;
    s.lastRef = ref(s, previous);
    previous.validating = null;
    previous.offeredAt = now;
    void answer(s, previous, offer.sdp).catch((error: unknown) =>
      failDirect(s, previous, 'protocol-error', String(error))
    );
    return;
  }
  if (previous) closePeer(s, previous, 'channel-failed');
  const pc = s.options.createPeer({
    // ICE servers and TURN credentials come only from the PC's offer.
    iceServers: offer.iceServers,
    iceTransportPolicy: REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
  });
  const d = newDirect(offer, pc, now);
  s.direct = d;
  s.lastRef = ref(s, d);
  // Pending until promotion (a previous pending lane is retired by it).
  s.channel.registerControlLane(d.lane);
  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (s.direct !== d) return;
    control(s, { ...ref(s, d), t: 'candidate', candidate: iceCandidateSignal(event.candidate) }, s.relayPath);
  };
  pc.ondatachannel = (event: RTCDataChannelEvent) => {
    if (s.direct === d) bindChannel(s, d, event.channel);
  };
  pc.onconnectionstatechange = () => {
    if (s.direct !== d) return;
    if (pc.connectionState === 'connected') {
      void verify(s, d).catch((error: unknown) => failDirect(s, d, 'fingerprint-mismatch', String(error)));
    } else if (pc.connectionState === 'failed') {
      failDirect(s, d, pc.iceConnectionState === 'failed' ? 'ice-failed' : 'dtls-failed');
    }
  };
  void answer(s, d, offer.sdp).catch((error: unknown) => failDirect(s, d, 'protocol-error', String(error)));
};

const signal = (s: PeerState, message: RemoteTransportSignal, now: number): void => {
  if (message.sessionId !== s.sessionId) return;
  if (message.t === 'offer') {
    acceptOffer(s, message, now);
    return;
  }
  const d = s.direct;
  if (!d || d.connectionId !== message.connectionId || message.generation !== d.generation) return;
  if (message.t === 'candidate') addCandidate(s, d, message.candidate);
  else if (message.t === 'close') {
    s.options.log(`[mixdog-remote-transport] closed by the PC ${d.connectionId}: ${message.reason}`);
    closePeer(s, d, PATH_REASONS[message.reason] ?? 'channel-failed');
  }
};

// --- Inbound messages: control, records, payload delivery ---

const pong = (s: PeerState, id: number, carrier: RemoteTransportCarrierId, now: number): void => {
  const entry = s.pings.take(id);
  if (!entry) return;
  const path = pathOf(s, carrier);
  // Only a ping timed locally on this carrier since its last reset matches.
  if (!path || entry.carrier !== carrier || entry.epoch !== path.epoch) return;
  // Only the current carrier's estimator takes samples.
  if (path === s.current) path.monitor.rttSample(now - entry.sentAt);
  if (entry.wake) s.wakeAt = null;
  const d = s.direct;
  if (entry.validation && d && path === d && d.validating === id) {
    d.validating = null;
    if (s.current !== d) promote(s, d, now);
  }
};

const onControl = async (s: PeerState, box: Uint8Array, carrier: RemoteTransportCarrierId): Promise<void> => {
  const arrived = pathOf(s, carrier);
  // Its connection closed meanwhile: that lane is retired.
  if (!arrived) return;
  let opened: Awaited<ReturnType<typeof s.channel.openControl>>;
  try {
    // Opened on the lane it came on (replay is per FIFO lane).
    opened = await s.channel.openControl(box, laneOf(s, arrived));
  } catch {
    // Not authentic: whoever forged it gets nothing.
    return;
  }
  // Authentic but malformed: a protocol error (thrown, ends the session).
  const message = readRemoteTransportControl(opened, 'desktop');
  if (!message || s.ended) return;
  const now = s.clock();
  pathOf(s, carrier)?.monitor.inbound(now);
  switch (message.t) {
    case 'ack': {
      if (s.sender.acknowledge(message, now) > 0) {
        s.current.monitor.ackAdvanced(now);
        wakeRoom(s);
      }
      s.current.monitor.outstanding(outstanding(s), now);
      flush(s);
      return;
    }
    case 'repair':
      if (s.sender.repair(message)) flush(s);
      return;
    case 'ping': {
      if (message.sent !== undefined) s.receiver.probe(message.sent, now);
      const path = pathOf(s, carrier);
      if (path) control(s, { v: REMOTE_TRANSPORT_VERSION, t: 'pong', id: message.id }, path);
      schedule(s);
      return;
    }
    case 'pong':
      pong(s, message.id, carrier, now);
      return;
    default:
      signal(s, message, now);
  }
};

const offerPayload = (s: PeerState, value: unknown, now: number): void => {
  const result = s.assembler.accept(value, now);
  if (result.state === 'wait') s.held = { value };
  else if (result.state === 'complete') s.options.deliver(result.payload);
};

const pump = async (s: PeerState, carrier: RemoteTransportCarrierId): Promise<void> => {
  while (s.held === null && !s.ended) {
    const next = s.receiver.next();
    if (!next) return;
    let value: unknown;
    try {
      value = await s.channel.decryptJson(next.box);
    } catch {
      // Failed authentication: that copy goes; `repairDue` asks again.
      s.receiver.discard(next.sequence);
      continue;
    }
    if (s.ended) return;
    const now = s.clock();
    s.receiver.commit(next.sequence, now);
    pathOf(s, carrier)?.monitor.inbound(now);
    s.ackPending = true;
    s.options.progress?.();
    offerPayload(s, value, now);
    if (s.confirmed) ack(s, now);
  }
};

const handle = async (s: PeerState, raw: unknown, carrier: RemoteTransportCarrierId): Promise<void> => {
  if (s.ended || (carrier !== RELAY && s.direct?.carrier !== carrier)) return;
  const bytes = bytesOf(raw);
  if (!bytes) return;
  s.bytesReceived += bytes.byteLength;
  if (carrier !== RELAY) s.directBytesReceived += bytes.byteLength;
  // Every record of a transport session, `e2ee-ready` (record 1) included,
  // comes through the receiver as `MXT`. A bare E2EE box here is a legacy
  // frame on a transport session: the session ends.
  if (MXE.every((byte, index) => bytes[index] === byte)) {
    throw new Error('Relay sent a bare box on a transport session.');
  }
  let message: RemoteTransportMessage;
  try {
    message = decodeRemoteTransportMessage(bytes);
  } catch {
    // Unauthenticated framing a conforming peer cannot produce: dropped.
    return;
  }
  if (message.kind === 'control') {
    if (s.confirmed) await onControl(s, message.box, carrier);
    else if (s.early.length < MAX_EARLY_CONTROL) s.early.push([message.box, carrier]);
    return;
  }
  s.receiver.accept(message, s.clock());
  await pump(s, carrier);
  schedule(s);
};

const receive = (s: PeerState, raw: unknown, carrier: RemoteTransportCarrierId): void => {
  s.inbound = s.inbound.then(() => handle(s, raw, carrier)).catch((e) => end(s, e));
};

// --- Timer tick ---

const directTick = (s: PeerState, d: Direct, now: number): void => {
  if ((!isOpen(d.app) || !isOpen(d.control)) && now - d.offeredAt >= REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS) {
    failDirect(s, d, 'negotiation-timeout');
    return;
  }
  if (s.current === d) {
    d.monitor.buffered(channelsBuffered(d), now);
    const stall = d.monitor.stalled(now, outstanding(s));
    if (stall) {
      failDirect(s, d, 'stall', stall);
      return;
    }
    if (now - d.lastPingAt >= REMOTE_TRANSPORT_PING_MS) ping(s, d);
    return;
  }
  if (d.validating !== null && now - d.validatingAt >= d.monitor.idleTimeoutMs()) {
    failDirect(s, d, 'stall', 'validation');
    return;
  }
  maybeValidate(s, d);
};

const tick = (s: PeerState): void => {
  s.timer = null;
  // No timer work while hidden: everything is re-proven on wake.
  if (s.ended || !s.options.visible()) return;
  if (!s.confirmed) {
    schedule(s);
    return;
  }
  const now = s.clock();
  if (s.assembler.stalled(now)) {
    end(s, new Error('Relay transport message stalled.'));
    return;
  }
  if (s.wakeAt !== null && now - s.wakeAt >= s.relayPath.monitor.idleTimeoutMs()) s.wakeAt = null;
  if (s.wakeAt === null && s.sender.expired(now)) {
    end(s, new Error('Relay transport records expired unacknowledged.'));
    return;
  }
  const path = s.current;
  s.receiver.sweep(now, path.monitor.idleTimeoutMs());
  // One round's repairs travel in one control box.
  const repairs = s.receiver.repairDue(now, path.monitor);
  if (repairs.length > 0) control(s, remoteTransportRepair(repairs), path);
  if (s.sender.probeDue(now, path.monitor.ptoMs())) ping(s, path);
  ack(s, now);
  if (s.held !== null) {
    s.inbound = s.inbound
      .then(async () => {
        if (s.held === null || s.ended) return;
        const value = s.held.value;
        s.held = null;
        offerPayload(s, value, s.clock());
        await pump(s, RELAY);
      })
      .catch((e) => end(s, e));
  }
  if (s.direct) directTick(s, s.direct, now);
  if (s.ended) return;
  wakeRoom(s);
  flush(s);
};

// --- Outbound messages: admit, enqueue and the public send flavours ---

/** Seals and pushes one message; the last sequence it took, or null when
 *  a droppable message found no room (nothing sealed). */
const admit = async (
  s: PeerState,
  payload: unknown,
  sendOptions: RemoteTransportSendOptions,
  claim?: (sequence: number) => void
): Promise<number | null> => {
  if (s.ended) throw new Error('Relay transport session ended.');
  s.fragmentId += 1;
  // Refuses an oversize message BEFORE anything is sealed.
  const parts = splitRemoteTransportPayload(payload, s.fragmentId);
  let last = 0;
  for (let index = 0; index < parts.length; index += 1) {
    const admission = (): RemoteTransportAdmission =>
      sendOptions.stream === undefined ? {} : { stream: sendOptions.stream, bufferedAmount: load(s, s.current) };
    while (!s.sender.canAdmit(admission())) {
      // Dropped before sealing: the next sequence is untouched.
      if (sendOptions.droppable && index === 0) return null;
      schedule(s);
      await waitForRoom(s);
      if (s.ended) throw new Error('Relay transport session ended.');
    }
    const now = s.clock();
    let box: Uint8Array;
    try {
      box = await s.channel.encryptBinary(parts[index]);
    } catch (error) {
      // Sealing failed after its sequence was assigned: the stream is broken.
      end(s, error);
      throw error;
    }
    if (s.ended) throw new Error('Relay transport session ended.');
    last = s.sender.push(box, admission());
    claim?.(last);
    s.current.monitor.outstanding(outstanding(s), now);
    flush(s);
  }
  return last;
};

const enqueue = (
  s: PeerState,
  payload: unknown,
  sendOptions: RemoteTransportSendOptions,
  claim?: (sequence: number) => void
): Promise<number | null> => {
  s.pendingSends += 1;
  const result = s.sending
    .then(() => admit(s, payload, sendOptions, claim))
    .finally(() => {
      s.pendingSends -= 1;
    });
  s.sending = result.catch(() => undefined);
  return result;
};

const sendDeparting = async (s: PeerState, payload: unknown): Promise<{ departed: Promise<void> }> => {
  // Every fragment is claimed as it is pushed, before it can be handed: each leaves on whichever carrier took it.
  const fragments: Array<Promise<void>> = [];
  await enqueue(s, payload, {}, (sequence) => {
    const left = departure(s, sequence);
    left.catch(() => {});
    fragments.push(left);
  });
  const departed = Promise.all(fragments).then(() => undefined);
  departed.catch(() => {});
  return { departed };
};

const sendPromptly = (s: PeerState, payload: unknown): Promise<boolean> => {
  // Right away: nothing queued ahead of it (a fragmented upload, a
  // message waiting for room) and window room now.
  const prompt = s.pendingSends === 0 && !s.ended && s.sender.canAdmit();
  const result = enqueue(s, payload, {});
  if (!prompt) {
    void result.catch(() => undefined);
    return Promise.resolve(false);
  }
  // Sealed and pushed; handed only if the carrier had room for it too.
  return result.then(
    (last) => last !== null && s.highestHanded >= last,
    () => false
  );
};

// --- Lifecycle: confirm, hidden/wake, suspend, close, diagnostics ---

function closeSession(s: PeerState): void {
  if (s.ended) return;
  s.ended = true;
  for (const waiter of s.handWaiters.values()) waiter.fail(new Error('Relay transport session ended.'));
  s.handWaiters.clear();
  for (const carrier of s.departures.values()) carrier.end();
  if (s.timer !== null) s.timers.clearTimeout(s.timer);
  s.timer = null;
  if (s.direct) closePeer(s, s.direct, 'session-ended');
  s.assembler.close();
  s.held = null;
  wakeRoom(s);
  s.options.log(
    `[mixdog-remote-transport] ended tx=${s.bytesSent} rx=${s.bytesReceived}` +
      ` direct-tx=${s.directBytesSent} direct-rx=${s.directBytesReceived}`
  );
}

const confirm = (s: PeerState): void => {
  if (s.confirmed || s.ended) return;
  s.confirmed = true;
  for (const [box, carrier] of s.early.splice(0)) {
    s.inbound = s.inbound.then(() => onControl(s, box, carrier)).catch((e) => end(s, e));
  }
  ack(s, s.clock());
  flush(s);
};

const hidden = (s: PeerState): void => {
  s.hiddenSeen = true;
  if (s.timer !== null) s.timers.clearTimeout(s.timer);
  s.timer = null;
};

const wake = (s: PeerState): void => {
  if (s.ended) return;
  const now = s.clock();
  if (s.hiddenSeen) {
    s.hiddenSeen = false;
    s.wakeAt = now;
    // SCTP never aborts a dead path on its own: an `open` channel proves
    // nothing after a hidden period. New sends use the relay until the
    // direct carrier answers a fresh ping.
    if (s.direct) {
      if (s.current === s.direct) toRelay(s, now, 'suspended');
      s.direct.validating = null;
    }
  }
  if (s.confirmed) {
    ping(s, s.relayPath, { wake: true });
    const d = s.direct;
    if (d && s.current === d) ping(s, d, { wake: true });
    else if (d?.verified && isOpen(d.app) && isOpen(d.control)) {
      d.validatingAt = now;
      d.validating = ping(s, d, { validation: true, wake: true });
    }
  }
  schedule(s);
};

const suspend = async (s: PeerState): Promise<void> => {
  // The PC takes `close{suspended}` itself as going to the background, so
  // it names the current connection, or the last one offered.
  const target = s.direct ? ref(s, s.direct) : s.lastRef;
  if (target && s.confirmed && !s.ended) {
    await sendControl(s, { ...target, t: 'close', reason: 'suspended' }, s.relayPath).catch(() => {});
  }
  closeSession(s);
};

const settled = async (s: PeerState): Promise<void> => {
  for (let chain = s.inbound; ; chain = s.inbound) {
    await chain;
    if (chain === s.inbound) return;
  }
};

const diagnostics = (s: PeerState) => {
  const senderStats = s.sender.stats();
  return {
    path: s.current === s.relayPath ? 'relay' : s.direct?.turn ? 'turn' : 'direct',
    reason: s.reason,
    bytesSent: s.bytesSent,
    bytesReceived: s.bytesReceived,
    directBytesSent: s.directBytesSent,
    directBytesReceived: s.directBytesReceived,
    queueDepth: load(s, s.current),
    outstandingBytes: senderStats.outstandingBytes,
    retransmits: senderStats.retransmits,
    sender: senderStats,
    receiver: s.receiver.stats(),
    relayRttMs: s.relayPath.monitor.smoothedRttMs(),
    directRttMs: s.direct ? s.direct.monitor.smoothedRttMs() : null,
  } as const;
};

export function createRemoteTransportPeer(options: RemoteTransportPeerOptions): RemoteTransportPeer {
  const s = createPeerState(options);
  return {
    receiveRelay: (data) => receive(s, data, RELAY),
    confirm: () => confirm(s),
    send: (payload, sendOptions = {}) => enqueue(s, payload, sendOptions).then((last) => last !== null),
    sendDeparting: (payload) => sendDeparting(s, payload),
    sendPromptly: (payload) => sendPromptly(s, payload),
    hidden: () => hidden(s),
    wake: () => wake(s),
    suspend: () => suspend(s),
    settled: () => settled(s),
    close: () => closeSession(s),
    diagnostics: () => diagnostics(s),
  };
}
