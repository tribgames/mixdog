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
import { remoteWebrtcPeerCertificate, remoteWebrtcSelectedPair } from './remote-webrtc-stats';

/** The phone's rollout gate (docs/remote-transport.md §6): whether this page
 *  opts into `transportWebrtc` on its E2EE hello. It does so only when the PC
 *  itself offered it in this leg's challenge, with binary frames — a member
 *  the PC sends only while its local "Direct phone connection (test)" switch
 *  is on. Against any other PC (older, or with the switch off) the hello, its
 *  proof and every frame are the legacy ones byte for byte. No separate
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

export interface RemoteTransportPeerOptions {
  channel: RelayE2EEChannel;
  /** The E2EE challenge (the signals' `sessionId`, the media lane's `sid`). */
  sessionId: string;
  relay: RemoteTransportRelayCarrier;
  /** One whole application message, in order. The first one of a session
   *  must be `e2ee-ready`; the caller confirms it and then calls `confirm()`. */
  deliver(payload: unknown): void;
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

export function createRemoteTransportPeer(options: RemoteTransportPeerOptions): RemoteTransportPeer {
  const { channel, sessionId, timers } = options;
  const clock = options.now ?? (() => Date.now());
  const sender = new RemoteTransportSender();
  const receiver = new RemoteTransportReceiver();
  // The page's own assembler on the process pool (this page is one session).
  const assembler = new RemoteTransportMessageAssembler();
  const relayPath: Path = { carrier: RELAY, monitor: new RemoteTransportPathMonitor(clock()), epoch: 0 };
  let current: Path = relayPath;
  let direct: Direct | null = null;
  let generation = 0;
  let confirmed = false;
  let ended = false;
  let inbound: Promise<void> = Promise.resolve();
  let sending: Promise<unknown> = Promise.resolve();
  const early: Array<[Uint8Array, RemoteTransportCarrierId]> = [];
  const roomWaiters: Array<() => void> = [];
  const pings = new Map<number, PingEntry>();
  let pingId = 0;
  let fragmentId = 0;
  /** An opened payload the process pool could not take yet (`wait`). */
  let held: { value: unknown } | null = null;
  let ackPending = false;
  let hiddenSeen = false;
  /** Since this wake, nothing is proven until a wake ping is answered: record
   *  expiry, which counts time the page could not act in, waits for that. */
  let wakeAt: number | null = null;
  let timer: unknown = null;
  let timerAt = 0;
  let reason: RemoteTransportPathReason | null = null;
  let bytesSent = 0;
  let bytesReceived = 0;
  /** The part of the totals above that moved on a direct carrier. */
  let directBytesSent = 0;
  let directBytesReceived = 0;
  /** The first application record written to a direct carrier is logged once. */
  let directCarried = false;
  /** Messages handed to `send` and not yet sealed and pushed. */
  let pendingSends = 0;
  /** Highest sequence handed to a carrier (first sends go in order). */
  let highestHanded = 0;
  /** The newest connection the PC offered, kept for `close{suspended}`. */
  let lastRef: RemoteTransportSignalRef | null = null;

  const pathOf = (carrier: RemoteTransportCarrierId): Path | null =>
    carrier === RELAY ? relayPath : direct?.carrier === carrier ? direct : null;
  /** Both channels' send buffers of a direct carrier. */
  const channelsBuffered = (d: Direct): number => (d.app?.bufferedAmount ?? 0) + (d.control?.bufferedAmount ?? 0);
  /** What a carrier holds queued: the relay socket's buffer, or a direct
   *  carrier's aggregate (both channels plus the control held or being
   *  sealed here). */
  const load = (path: Path): number =>
    path === relayPath
      ? options.relay.bufferedAmount()
      : channelsBuffered(path as Direct) + (path as Direct).heldBytes + (path as Direct).reservedBytes;
  /** The app bytes still queued on a carrier: what `probeThrough` subtracts. */
  const appQueued = (path: Path): number =>
    path === relayPath ? options.relay.bufferedAmount() : ((path as Direct).app?.bufferedAmount ?? 0);
  const outstanding = (): number => sender.stats().outstandingBytes;

  const end = (error: unknown): void => {
    if (ended) return;
    close();
    options.fatal(error instanceof Error ? error : new Error(String(error)));
  };

  const wakeRoom = (): void => {
    for (const resolve of roomWaiters.splice(0)) resolve();
  };
  const room = (): Promise<void> => new Promise((resolve) => roomWaiters.push(resolve));

  const schedule = (): void => {
    if (ended || !options.visible()) return;
    const busy =
      confirmed &&
      (ackPending ||
        held !== null ||
        roomWaiters.length > 0 ||
        sender.stats().retainedRecords > 0 ||
        receiver.stats().bufferedRecords > 0);
    const delay = busy ? REMOTE_TRANSPORT_MAX_ACK_DELAY_MS : REMOTE_TRANSPORT_PING_MS;
    const at = clock() + delay;
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) timers.clearTimeout(timer);
    timerAt = at;
    timer = timers.setTimeout(tick, delay);
  };

  const carrierSend = (path: Path, kind: 'app' | 'control', message: Uint8Array): void => {
    if (path === relayPath) {
      options.relay.send(message);
    } else {
      const target = kind === 'app' ? (path as Direct).app : (path as Direct).control;
      if (!isOpen(target)) throw new Error(`transport ${kind} channel is not open`);
      target.send(message as Uint8Array<ArrayBuffer>);
      directBytesSent += message.byteLength;
      if (kind === 'app' && !directCarried) {
        directCarried = true;
        options.log(`[mixdog-remote-transport] carrying path=${(path as Direct).turn ? 'turn' : 'direct'}`);
      }
    }
    bytesSent += message.byteLength;
  };

  const laneOf = (path: Path): RelayE2EEControlLane =>
    path === relayPath ? RELAY_E2EE_RELAY_LANE : (path as Direct).lane;

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
  const sendControl = async (message: RemoteTransportControl, path: Path, onSent?: () => void): Promise<void> => {
    if (!confirmed || ended || (path !== relayPath && path !== direct)) return;
    assertRemoteTransportControlFits(message);
    if (path === relayPath) {
      const box = await channel.sealControl(message, RELAY_E2EE_RELAY_LANE);
      if (ended) return;
      onSent?.();
      carrierSend(relayPath, 'control', encodeRemoteTransportControl(box));
      return;
    }
    const d = path as Direct;
    const size = controlWireBytes(message);
    if (load(d) + size > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) {
      if (message.t === 'ack' || message.t === 'ping' || message.t === 'pong') {
        d.coalesced.set(message.t, { message, onSent });
        awaitDrain(d);
        return;
      }
      failDirect(d, 'stall', 'control-backlog');
      await sendControl(message, relayPath);
      return;
    }
    d.reservedBytes += size;
    let box: Uint8Array;
    try {
      box = await channel.sealControl(message, d.lane);
    } catch {
      // The lane was retired meanwhile: nothing to send on it.
      d.reservedBytes -= size;
      return;
    }
    d.reservedBytes -= size;
    if (ended || direct !== d) return;
    // Seal results resolve in sequence order, so appending here keeps the
    // lane order; whatever is already held goes first.
    const bytes = encodeRemoteTransportControl(box);
    d.heldControl.push({ bytes, onSent });
    d.heldBytes += bytes.byteLength;
    releaseControl(d);
  };

  /** Writes held control boxes, in lane order, while the channels have room
   *  for the next one, then seals what was coalesced while there was none;
   *  otherwise waits for either channel to drain. */
  const releaseControl = (d: Direct): void => {
    while (direct === d && d.heldControl.length > 0) {
      const head = d.heldControl[0];
      if (channelsBuffered(d) + head.bytes.byteLength > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) {
        awaitDrain(d);
        return;
      }
      d.heldControl.shift();
      d.heldBytes -= head.bytes.byteLength;
      head.onSent?.();
      try {
        carrierSend(d, 'control', head.bytes);
      } catch (error) {
        failDirect(d, 'channel-failed', String(error));
        return;
      }
    }
    for (const [kind, entry] of [...d.coalesced]) {
      if (direct !== d) return;
      if (load(d) + controlWireBytes(entry.message) > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) {
        awaitDrain(d);
        return;
      }
      d.coalesced.delete(kind);
      void sendControl(entry.message, d, entry.onSent).catch(end);
    }
  };
  const control = (message: RemoteTransportControl, path: Path): void => {
    void sendControl(message, path).catch(end);
  };

  const ref = (d: Direct): RemoteTransportSignalRef => ({
    v: REMOTE_TRANSPORT_VERSION,
    sessionId,
    connectionId: d.connectionId,
    generation: d.generation,
  });

  const ping = (path: Path, kind: { validation?: boolean; wake?: boolean } = {}): number => {
    pingId += 1;
    const id = pingId;
    const now = clock();
    // Every ping carries `sent`: what has certainly left this carrier's queue.
    const sent = sender.probeThrough(path.carrier, appQueued(path));
    const entry: PingEntry = {
      carrier: path.carrier,
      epoch: path.epoch,
      sentAt: now,
      validation: kind.validation === true,
      wake: kind.wake === true,
    };
    pings.set(id, entry);
    for (const old of pings.keys()) {
      if (pings.size <= MAX_PINGS) break;
      pings.delete(old);
    }
    if (path !== relayPath) (path as Direct).lastPingAt = now;
    void sendControl(remoteTransportPing(id, sent), path, () => {
      entry.sentAt = clock();
    }).catch(end);
    return id;
  };

  const handed = (sequence: number, path: Path, now: number): void => {
    sender.markSent(sequence, path.carrier, now);
    highestHanded = Math.max(highestHanded, sequence);
  };

  const flush = (): void => {
    if (!confirmed || ended) return;
    const path = current;
    const now = clock();
    // A validating (not current) direct lane still drains its held control.
    if (direct && direct !== path) releaseControl(direct);
    if (path === relayPath) {
      const queue = options.relay.bufferedAmount();
      if (queue < REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) {
        for (const { sequence, box } of sender.due(now, REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - queue)) {
          for (const message of encodeRemoteTransportRecord(box)) carrierSend(path, 'app', message);
          handed(sequence, path, now);
        }
      }
    } else {
      const d = path as Direct;
      // Control first, in lane order; then app records, budgeted against the
      // aggregate of both channels and the held control, short of the
      // control reserve, and never past it (a record that does not fit waits).
      releaseControl(d);
      if (direct !== d) return;
      let room = REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES - load(d);
      for (const { sequence, box } of sender.due(now, Math.max(0, room))) {
        const messages = encodeRemoteTransportRecord(box);
        const wire = messages.reduce((sum, message) => sum + message.byteLength, 0);
        if (wire > room) break;
        try {
          for (const message of messages) carrierSend(d, 'app', message);
        } catch (error) {
          failDirect(d, 'channel-failed', String(error));
          return;
        }
        room -= wire;
        handed(sequence, d, now);
      }
      if (d.heldControl.length > 0 || d.coalesced.size > 0 || sender.due(now, 1).length > 0) awaitDrain(d);
    }
    schedule();
  };

  /** A direct carrier is at its bound: resume when EITHER channel fires its
   *  low event. The listeners are attached FIRST and the buffers read again
   *  right after, so a drain that happened in between is not missed. */
  const awaitDrain = (d: Direct): void => {
    const before = channelsBuffered(d);
    for (const ch of [d.app, d.control]) if (isOpen(ch)) ch.onbufferedamountlow = () => flush();
    if (channelsBuffered(d) < before) queueMicrotask(flush);
  };

  const ack = (now: number): void => {
    const due = receiver.ackDue(now);
    if (!due) return;
    receiver.ackSent(due.through);
    ackPending = false;
    control(remoteTransportAck(due.through, due.ranges), current);
  };

  const promote = (d: Direct, now: number): void => {
    current = d;
    // Once per connection: a re-promotion after a wake or an ICE restart
    // keeps the lane as it is.
    if (!d.laneActive) {
      d.laneActive = true;
      channel.activateControlLane(d.lane);
    }
    d.monitor.reset(now);
    d.epoch += 1;
    d.lastPingAt = now;
    receiver.carrierChanged(now);
    ackPending = true;
    reason = 'channel-open';
    options.log(`[mixdog-remote-transport] path=${d.turn ? 'turn' : 'direct'} reason=channel-open`);
    ack(now);
    flush();
  };

  /** The direct carrier stops being used: what was last handed to it is
   *  re-sent on the relay after one relay PTO, or from the resume ack. */
  const toRelay = (now: number, why: RemoteTransportPathReason): void => {
    if (current === relayPath) return;
    const failed = current;
    current = relayPath;
    sender.carrierFailed(failed.carrier, now, relayPath.monitor.ptoMs());
    relayPath.monitor.reset(now);
    relayPath.epoch += 1;
    receiver.carrierChanged(now);
    ackPending = true;
    reason = why;
    options.log(`[mixdog-remote-transport] path=relay reason=${why}`);
    ack(now);
    flush();
  };

  const closePeer = (d: Direct, why: RemoteTransportPathReason): void => {
    if (direct !== d) return;
    if (current === d) toRelay(clock(), why);
    direct = null;
    // Boxes sealed for this lane and never sent are dropped, never moved to
    // the relay: their acks, repairs and pings are regenerated there.
    d.heldControl = [];
    d.heldBytes = 0;
    d.coalesced.clear();
    channel.retireControlLane(d.lane);
    for (const [id, entry] of pings) if (entry.carrier === d.carrier) pings.delete(id);
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

  const PATH_REASONS: Partial<Record<RemoteTransportCloseReason, RemoteTransportPathReason>> = {
    'fingerprint-mismatch': 'fingerprint-mismatch',
    'ice-failed': 'ice-failed',
    'negotiation-timeout': 'negotiation-timeout',
    stall: 'stall',
    suspended: 'suspended',
    'peer-host-unavailable': 'peer-host-unavailable',
    'session-ended': 'session-ended',
  };

  /** A failure this side saw: the PC hears why (on the relay), the peer closes. */
  const failDirect = (d: Direct, why: RemoteTransportCloseReason, detail?: string): void => {
    if (direct !== d) return;
    options.log(`[mixdog-remote-transport] closing ${d.connectionId}: ${why}${detail ? ` (${detail})` : ''}`);
    control(
      {
        ...ref(d),
        t: 'close',
        reason: why,
        ...(detail ? { detail: detail.slice(0, REMOTE_TRANSPORT_MAX_DETAIL_CHARS) } : {}),
      },
      relayPath
    );
    closePeer(d, detail === 'max-message-size' ? 'message-size' : (PATH_REASONS[why] ?? 'channel-failed'));
  };

  /** Promotion gate (§5): certificate, both channels open, the SCTP message
   *  size, then one ping/pong round trip on the direct carrier. */
  const maybeValidate = (d: Direct): void => {
    if (direct !== d || current === d || !d.verified || d.validating !== null) return;
    if (!isOpen(d.app) || !isOpen(d.control)) return;
    if (!remoteTransportCarrierFits(d.pc.sctp?.maxMessageSize)) {
      failDirect(d, 'channel-failed', 'max-message-size');
      return;
    }
    d.validatingAt = clock();
    d.validating = ping(d, { validation: true });
  };

  const verify = async (d: Direct): Promise<void> => {
    const report = await d.pc.getStats();
    if (direct !== d || d.verified) return;
    const certificate = remoteWebrtcPeerCertificate(report);
    if (!certificate || !remoteWebrtcCertificateMatches(d.fingerprints, certificate)) {
      failDirect(d, 'fingerprint-mismatch');
      return;
    }
    const pair = remoteWebrtcSelectedPair(report);
    d.turn = pair ? remoteWebrtcCandidatePath(pair) === 'relay' : false;
    d.verified = true;
    maybeValidate(d);
  };

  const bindChannel = (d: Direct, ch: RTCDataChannel): void => {
    const isApp = ch.label === REMOTE_TRANSPORT_CHANNEL_LABEL;
    const isControl = ch.label === REMOTE_TRANSPORT_CONTROL_CHANNEL_LABEL;
    // Both reliable and ordered (§3): the control channel is a FIFO lane.
    if ((!isApp && !isControl) || (isApp ? d.app : d.control) || !ch.ordered) {
      failDirect(d, 'protocol-error', `unexpected channel ${ch.label}`);
      return;
    }
    ch.binaryType = 'arraybuffer';
    // Before anything is ever sent on it.
    ch.bufferedAmountLowThreshold = REMOTE_TRANSPORT_BUFFER_LOW_BYTES;
    if (isApp) d.app = ch;
    else d.control = ch;
    ch.onmessage = (event: MessageEvent) => receive(event.data, d.carrier);
    ch.onclose = () => failDirect(d, 'channel-failed');
    ch.onerror = () => failDirect(d, 'channel-failed');
    ch.onopen = () => maybeValidate(d);
    ch.onbufferedamountlow = () => flush();
    maybeValidate(d);
  };

  const addCandidate = (d: Direct, candidate: RTCIceCandidateInit | null): void => {
    if (!d.remoteSet) {
      d.candidates.push(candidate);
      return;
    }
    // One bad candidate is not the connection's failure; ICE decides that.
    d.pc.addIceCandidate(candidate).catch((error: unknown) => {
      options.log(`[mixdog-remote-transport] candidate refused: ${String(error)}`);
    });
  };

  const answer = async (d: Direct, sdp: string): Promise<void> => {
    await d.pc.setRemoteDescription({ type: 'offer', sdp });
    if (direct !== d) return;
    d.remoteSet = true;
    for (const candidate of d.candidates.splice(0)) addCandidate(d, candidate);
    const local = await d.pc.createAnswer();
    await d.pc.setLocalDescription(local);
    if (direct !== d) return;
    const answerSdp = d.pc.localDescription?.sdp ?? local.sdp ?? '';
    const fingerprints = remoteWebrtcSdpFingerprints(answerSdp);
    if (!fingerprints.length) throw new Error('answer without a fingerprint');
    await sendControl({ ...ref(d), t: 'answer', sdp: answerSdp, fingerprints }, relayPath);
  };

  const acceptOffer = (offer: Extract<RemoteTransportSignal, { t: 'offer' }>, now: number): void => {
    if (offer.generation <= generation) return;
    generation = offer.generation;
    const previous = direct;
    if (previous && previous.connectionId === offer.connectionId) {
      // ICE restart on the same connection: traffic stays on the relay until
      // the path is validated again.
      if (current === previous) toRelay(now, 'channel-failed');
      previous.generation = offer.generation;
      lastRef = ref(previous);
      previous.validating = null;
      previous.offeredAt = now;
      void answer(previous, offer.sdp).catch((error: unknown) => failDirect(previous, 'protocol-error', String(error)));
      return;
    }
    if (previous) closePeer(previous, 'channel-failed');
    const pc = options.createPeer({
      // ICE servers and TURN credentials come only from the PC's offer.
      iceServers: offer.iceServers,
      iceTransportPolicy: REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
    });
    const d: Direct = {
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
    };
    direct = d;
    lastRef = ref(d);
    // Pending until promotion (a previous pending lane is retired by it).
    channel.registerControlLane(d.lane);
    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (direct !== d) return;
      const found = event.candidate;
      control(
        {
          ...ref(d),
          t: 'candidate',
          candidate: found
            ? {
                candidate: found.candidate,
                sdpMid: found.sdpMid,
                sdpMLineIndex: found.sdpMLineIndex,
                usernameFragment: found.usernameFragment,
              }
            : null,
        },
        relayPath
      );
    };
    pc.ondatachannel = (event: RTCDataChannelEvent) => {
      if (direct === d) bindChannel(d, event.channel);
    };
    pc.onconnectionstatechange = () => {
      if (direct !== d) return;
      if (pc.connectionState === 'connected') {
        void verify(d).catch((error: unknown) => failDirect(d, 'fingerprint-mismatch', String(error)));
      } else if (pc.connectionState === 'failed') {
        failDirect(d, pc.iceConnectionState === 'failed' ? 'ice-failed' : 'dtls-failed');
      }
    };
    void answer(d, offer.sdp).catch((error: unknown) => failDirect(d, 'protocol-error', String(error)));
  };

  const signal = (message: RemoteTransportSignal, now: number): void => {
    if (message.sessionId !== sessionId) return;
    if (message.t === 'offer') {
      acceptOffer(message, now);
      return;
    }
    const d = direct;
    if (!d || d.connectionId !== message.connectionId || message.generation !== d.generation) return;
    if (message.t === 'candidate') addCandidate(d, message.candidate);
    else if (message.t === 'close') {
      options.log(`[mixdog-remote-transport] closed by the PC ${d.connectionId}: ${message.reason}`);
      closePeer(d, PATH_REASONS[message.reason] ?? 'channel-failed');
    }
  };

  const pong = (id: number, carrier: RemoteTransportCarrierId, now: number): void => {
    const entry = pings.get(id);
    if (!entry) return;
    // Consumed once, whatever follows.
    pings.delete(id);
    const path = pathOf(carrier);
    // Only a ping timed locally on this carrier since its last reset matches.
    if (!path || entry.carrier !== carrier || entry.epoch !== path.epoch) return;
    // Only the current carrier's estimator takes samples.
    if (path === current) path.monitor.rttSample(now - entry.sentAt);
    if (entry.wake) wakeAt = null;
    if (entry.validation && path === direct && direct.validating === id) {
      direct.validating = null;
      if (current !== direct) promote(direct, now);
    }
  };

  const onControl = async (box: Uint8Array, carrier: RemoteTransportCarrierId): Promise<void> => {
    const arrived = pathOf(carrier);
    // Its connection closed meanwhile: that lane is retired.
    if (!arrived) return;
    let opened;
    try {
      // Opened on the lane it came on (replay is per FIFO lane).
      opened = await channel.openControl(box, laneOf(arrived));
    } catch {
      // Not authentic: whoever forged it gets nothing.
      return;
    }
    // Authentic but malformed: a protocol error (thrown, ends the session).
    const message = readRemoteTransportControl(opened, 'desktop');
    if (!message || ended) return;
    const now = clock();
    pathOf(carrier)?.monitor.inbound(now);
    switch (message.t) {
      case 'ack': {
        if (sender.acknowledge(message, now) > 0) {
          current.monitor.ackAdvanced(now);
          wakeRoom();
        }
        current.monitor.outstanding(outstanding(), now);
        flush();
        return;
      }
      case 'repair':
        if (sender.repair(message)) flush();
        return;
      case 'ping': {
        if (message.sent !== undefined) receiver.probe(message.sent, now);
        const path = pathOf(carrier);
        if (path) control({ v: REMOTE_TRANSPORT_VERSION, t: 'pong', id: message.id }, path);
        schedule();
        return;
      }
      case 'pong':
        pong(message.id, carrier, now);
        return;
      default:
        signal(message, now);
    }
  };

  const offerPayload = (value: unknown, now: number): void => {
    const result = assembler.accept(value, now);
    if (result.state === 'wait') held = { value };
    else if (result.state === 'complete') options.deliver(result.payload);
  };

  const pump = async (carrier: RemoteTransportCarrierId): Promise<void> => {
    while (held === null && !ended) {
      const next = receiver.next();
      if (!next) return;
      let value: unknown;
      try {
        value = await channel.decryptJson(next.box);
      } catch {
        // Failed authentication: that copy goes; `repairDue` asks again.
        receiver.discard(next.sequence);
        continue;
      }
      if (ended) return;
      const now = clock();
      receiver.commit(next.sequence, now);
      pathOf(carrier)?.monitor.inbound(now);
      ackPending = true;
      offerPayload(value, now);
      if (confirmed) ack(now);
    }
  };

  const handle = async (raw: unknown, carrier: RemoteTransportCarrierId): Promise<void> => {
    if (ended || (carrier !== RELAY && direct?.carrier !== carrier)) return;
    const bytes = bytesOf(raw);
    if (!bytes) return;
    bytesReceived += bytes.byteLength;
    if (carrier !== RELAY) directBytesReceived += bytes.byteLength;
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
      if (confirmed) await onControl(message.box, carrier);
      else if (early.length < MAX_EARLY_CONTROL) early.push([message.box, carrier]);
      return;
    }
    receiver.accept(message, clock());
    await pump(carrier);
    schedule();
  };

  const receive = (raw: unknown, carrier: RemoteTransportCarrierId): void => {
    inbound = inbound.then(() => handle(raw, carrier)).catch(end);
  };

  const directTick = (d: Direct, now: number): void => {
    if ((!isOpen(d.app) || !isOpen(d.control)) && now - d.offeredAt >= REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS) {
      failDirect(d, 'negotiation-timeout');
      return;
    }
    if (current === d) {
      d.monitor.buffered(channelsBuffered(d), now);
      const stall = d.monitor.stalled(now, outstanding());
      if (stall) {
        failDirect(d, 'stall', stall);
        return;
      }
      if (now - d.lastPingAt >= REMOTE_TRANSPORT_PING_MS) ping(d);
      return;
    }
    if (d.validating !== null && now - d.validatingAt >= d.monitor.idleTimeoutMs()) {
      failDirect(d, 'stall', 'validation');
      return;
    }
    maybeValidate(d);
  };

  const tick = (): void => {
    timer = null;
    // No timer work while hidden: everything is re-proven on wake.
    if (ended || !options.visible()) return;
    if (!confirmed) {
      schedule();
      return;
    }
    const now = clock();
    if (assembler.stalled(now)) {
      end(new Error('Relay transport message stalled.'));
      return;
    }
    if (wakeAt !== null && now - wakeAt >= relayPath.monitor.idleTimeoutMs()) wakeAt = null;
    if (wakeAt === null && sender.expired(now)) {
      end(new Error('Relay transport records expired unacknowledged.'));
      return;
    }
    const path = current;
    receiver.sweep(now, path.monitor.idleTimeoutMs());
    // One round's repairs travel in one control box.
    const repairs = receiver.repairDue(now, path.monitor);
    if (repairs.length > 0) control(remoteTransportRepair(repairs), path);
    if (sender.probeDue(now, path.monitor.ptoMs())) ping(path);
    ack(now);
    if (held !== null) {
      inbound = inbound
        .then(async () => {
          if (held === null || ended) return;
          const value = held.value;
          held = null;
          offerPayload(value, clock());
          await pump(RELAY);
        })
        .catch(end);
    }
    if (direct) directTick(direct, now);
    if (ended) return;
    wakeRoom();
    flush();
  };

  /** Seals and pushes one message; the last sequence it took, or null when
   *  a droppable message found no room (nothing sealed). */
  const admit = async (payload: unknown, sendOptions: RemoteTransportSendOptions): Promise<number | null> => {
    if (ended) throw new Error('Relay transport session ended.');
    fragmentId += 1;
    // Refuses an oversize message BEFORE anything is sealed.
    const parts = splitRemoteTransportPayload(payload, fragmentId);
    let last = 0;
    for (let index = 0; index < parts.length; index += 1) {
      const admission = (): RemoteTransportAdmission =>
        sendOptions.stream === undefined ? {} : { stream: sendOptions.stream, bufferedAmount: load(current) };
      while (!sender.canAdmit(admission())) {
        // Dropped before sealing: the next sequence is untouched.
        if (sendOptions.droppable && index === 0) return null;
        schedule();
        await room();
        if (ended) throw new Error('Relay transport session ended.');
      }
      const now = clock();
      let box: Uint8Array;
      try {
        box = await channel.encryptBinary(parts[index]);
      } catch (error) {
        // Sealing failed after its sequence was assigned: the stream is broken.
        end(error);
        throw error;
      }
      if (ended) throw new Error('Relay transport session ended.');
      last = sender.push(box, admission());
      current.monitor.outstanding(outstanding(), now);
      flush();
    }
    return last;
  };

  const enqueue = (payload: unknown, sendOptions: RemoteTransportSendOptions): Promise<number | null> => {
    pendingSends += 1;
    const result = sending
      .then(() => admit(payload, sendOptions))
      .finally(() => {
        pendingSends -= 1;
      });
    sending = result.catch(() => undefined);
    return result;
  };

  function close(): void {
    if (ended) return;
    ended = true;
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (direct) closePeer(direct, 'session-ended');
    assembler.close();
    held = null;
    wakeRoom();
    options.log(
      `[mixdog-remote-transport] ended tx=${bytesSent} rx=${bytesReceived}` +
        ` direct-tx=${directBytesSent} direct-rx=${directBytesReceived}`
    );
  }

  return {
    receiveRelay(data) {
      receive(data, RELAY);
    },
    confirm() {
      if (confirmed || ended) return;
      confirmed = true;
      for (const [box, carrier] of early.splice(0)) {
        inbound = inbound.then(() => onControl(box, carrier)).catch(end);
      }
      ack(clock());
      flush();
    },
    send(payload, sendOptions = {}) {
      return enqueue(payload, sendOptions).then((last) => last !== null);
    },
    sendPromptly(payload) {
      // Right away: nothing queued ahead of it (a fragmented upload, a
      // message waiting for room) and window room now.
      const prompt = pendingSends === 0 && !ended && sender.canAdmit();
      const result = enqueue(payload, {});
      if (!prompt) {
        void result.catch(() => undefined);
        return Promise.resolve(false);
      }
      // Sealed and pushed; handed only if the carrier had room for it too.
      return result.then(
        (last) => last !== null && highestHanded >= last,
        () => false
      );
    },
    hidden() {
      hiddenSeen = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    wake() {
      if (ended) return;
      const now = clock();
      if (hiddenSeen) {
        hiddenSeen = false;
        wakeAt = now;
        // SCTP never aborts a dead path on its own: an `open` channel proves
        // nothing after a hidden period. New sends use the relay until the
        // direct carrier answers a fresh ping.
        if (direct) {
          if (current === direct) toRelay(now, 'suspended');
          direct.validating = null;
        }
      }
      if (confirmed) {
        ping(relayPath, { wake: true });
        const d = direct;
        if (d && current === d) ping(d, { wake: true });
        else if (d && d.verified && isOpen(d.app) && isOpen(d.control)) {
          d.validatingAt = now;
          d.validating = ping(d, { validation: true, wake: true });
        }
      }
      schedule();
    },
    async suspend() {
      // The PC takes `close{suspended}` itself as going to the background, so
      // it names the current connection, or the last one offered.
      const target = direct ? ref(direct) : lastRef;
      if (target && confirmed && !ended) {
        await sendControl({ ...target, t: 'close', reason: 'suspended' }, relayPath).catch(() => {});
      }
      close();
    },
    close,
    diagnostics() {
      const senderStats = sender.stats();
      return {
        path: current === relayPath ? 'relay' : direct?.turn ? 'turn' : 'direct',
        reason,
        bytesSent,
        bytesReceived,
        directBytesSent,
        directBytesReceived,
        queueDepth: load(current),
        outstandingBytes: senderStats.outstandingBytes,
        retransmits: senderStats.retransmits,
        sender: senderStats,
        receiver: receiver.stats(),
        relayRttMs: relayPath.monitor.smoothedRttMs(),
        directRttMs: direct ? direct.monitor.smoothedRttMs() : null,
      };
    },
  };
}
