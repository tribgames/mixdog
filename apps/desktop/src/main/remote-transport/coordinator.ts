// Direct transport, desktop side (docs/remote-transport.md §3–§5, §9 row 1A):
// one coordinator per transport session (one E2EE session that negotiated
// `transportWebrtc`). It owns that session's stream cores and carriers:
//   outbound  split → canAdmit → seal (app domain) → sender → the current
//             carrier, as MXT messages; nothing is ever re-sent on a timer;
//   inbound   carrier message → receiver → open → commit | discard →
//             assembler → the application (or the media adapter route);
//   control   acks, repairs, pings and pongs sealed in the control domain;
//             signaling on the relay lane only;
//   carriers  the relay (always there, the fallback) and at most one direct
//             peer connection from the hidden peer renderer (stage 1B),
//             promoted only after a fresh ping/pong on it and demoted only
//             on RemoteTransportPathMonitor.stalled or a hard failure.
// Without a peer host the session simply stays on the relay (a supported
// mode: the desktop service is a machine daemon).
import { randomBytes } from 'node:crypto';
import { RELAY_E2EE_RELAY_LANE, type RelayE2EEChannel, type RelayE2EEControlLane } from '../../shared/remote-e2ee';
import { relayFrameCallId } from '../../shared/remote-payload-limit';
import {
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_CHUNK_BYTES,
  REMOTE_TRANSPORT_CHUNK_HEADER_BYTES,
  REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES,
  REMOTE_TRANSPORT_FRAGMENT_TYPE,
  REMOTE_TRANSPORT_MAX_ACK_DELAY_MS,
  REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES,
  REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT,
  REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS,
  REMOTE_TRANSPORT_PING_MS,
  REMOTE_TRANSPORT_PREFIX_BYTES,
  REMOTE_TRANSPORT_VERSION,
  RemoteTransportMessageAssembler,
  RemoteTransportPathMonitor,
  RemoteTransportReceiver,
  RemoteTransportSender,
  decodeRemoteTransportMessage,
  encodeRemoteTransportControl,
  encodeRemoteTransportRecord,
  parseRemoteTransportSignal,
  readRemoteTransportControl,
  remoteTransportAck,
  remoteTransportCarrierFits,
  remoteTransportPing,
  remoteTransportRepair,
  splitRemoteTransportPayload,
  type RemoteTransportCloseReason,
  type RemoteTransportDiagnostics,
  type RemoteTransportPathReason,
  type RemoteTransportReceiverStats,
  type RemoteTransportSignal,
  type RemoteTransportSignalRef,
} from '../../shared/remote-transport';
import {
  parseRemoteWebrtcIceServers,
  type RemoteWebrtcCandidate,
  type RemoteWebrtcFingerprint,
  type RemoteWebrtcIceServer,
} from '../../shared/remote-webrtc';
import { resolveRemoteIceServers } from '../remote-ice-servers';
import type { RemoteTransportMediaAdapter, RemoteTransportMediaLink } from './media';
import type { RemoteTransportPeerBridge } from './peer-window';

/** ROLLOUT SWITCH (docs/remote-transport.md §6). While false the desktop's
 *  E2EE challenge does not offer `transportWebrtc`, so every session is
 *  legacy, byte for byte, and this coordinator never runs (step 3: "the offer
 *  stays off; the coordinator and peer host ship dormant"). Step 4 (enable)
 *  sets it to true; nothing else gates the offer
 *  (remote-relay-client-lifecycle.ts reads only this). */
export const REMOTE_TRANSPORT_OFFER_ENABLED = false;

// ---------------------------------------------------------------------------
// Stage 1B bridge: the hidden peer renderer (main/remote-transport/peer-window.ts)
// ---------------------------------------------------------------------------

/** What the coordinator asks of the hidden peer renderer. One host per
 *  process; one peer per transport session at a time. The desktop is always
 *  the offerer. */
export interface RemoteTransportPeerHost {
  /** Creates the offering RTCPeerConnection of one session with BOTH data
   *  channels (`mixdog-transport` and `mixdog-transport-control`, both
   *  ordered) and `bufferedAmountLowThreshold` = REMOTE_TRANSPORT_BUFFER_LOW_BYTES
   *  set before the first send. Throws when the renderer cannot run (the
   *  session stays on the relay and retries once per negotiation window).
   *  Every event below is for this peer only. The production host is
   *  `createRemoteTransportPeerHost(bridge)` below, over the daemon's
   *  stand-in bridge (peer-link.ts), which crosses to the app's peer window. */
  create(init: RemoteTransportPeerInit, events: RemoteTransportPeerEvents): RemoteTransportPeer;
}

export interface RemoteTransportPeerInit {
  /** The transport session (E2EE challenge). */
  sessionId: string;
  /** Minted by the coordinator per peer; names the carrier `direct:<id>`. */
  connectionId: string;
  /** The session's ICE/TURN set, from the process cache the live view
   *  shares (remote-ice-servers.ts); policy `all`. */
  iceServers: RemoteWebrtcIceServer[];
}

export interface RemoteTransportPeer {
  /** createOffer + setLocalDescription: the SDP to signal and its own
   *  `a=fingerprint` set. */
  offer(): Promise<{ sdp: string; fingerprints: RemoteWebrtcFingerprint[] }>;
  /** setRemoteDescription(answer). The host keeps `fingerprints` and, once
   *  DTLS connects, closes with `fingerprint-mismatch` unless the connected
   *  certificate is one of them (remoteWebrtcCertificateMatches). */
  answer(sdp: string, fingerprints: RemoteWebrtcFingerprint[]): Promise<void>;
  /** addIceCandidate; null is end-of-candidates. */
  candidate(candidate: RemoteWebrtcCandidate | null): Promise<void>;
  /** Queues one carrier message: `app` on `mixdog-transport` (kinds 1 and
   *  2), `control` on `mixdog-transport-control` (kind 3). Both channels
   *  share ONE bound (§3 Backpressure): an app message is refused (false,
   *  nothing queued) past HIGH − REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES of
   *  load, a control message past HIGH. The coordinator keeps app records
   *  under their share, so a refusal means the peer is gone or not open. */
  send(channel: 'app' | 'control', message: Uint8Array): boolean;
  /** The connection's aggregate load: BOTH channels' `bufferedAmount` plus
   *  their bytes still on the main → hidden-renderer IPC hop — the figure
   *  `send` admits against. */
  bufferedAmount(): number;
  /** Closes the peer; no event follows. */
  close(reason: RemoteTransportCloseReason): void;
}

export interface RemoteTransportPeerEvents {
  /** A local ICE candidate (null: gathering complete), signaled as is. */
  candidate(candidate: RemoteWebrtcCandidate | null): void;
  /** Both channels are open and the certificate matched the answer's
   *  fingerprints. `maxMessageSize` is `pc.sctp.maxMessageSize` (+∞ when
   *  unlimited); `relayed` is whether the selected pair uses TURN. */
  open(info: { maxMessageSize: number | null; relayed: boolean }): void;
  /** One carrier message from either channel. */
  message(message: Uint8Array): void;
  /** Either channel's `bufferedamountlow` fired, or its IPC hop drained:
   *  the aggregate `bufferedAmount()` fell. */
  drain(): void;
  /** The peer is gone: the channel closed or failed, ICE failed, DTLS or the
   *  fingerprint check failed, or the renderer crashed
   *  (`peer-host-unavailable`). Never fired after `close()`. */
  closed(reason: RemoteTransportCloseReason): void;
}

/**
 * The peer host over the stage 1B bridge (peer-window.ts
 * `createRemoteTransportPeerWindow`, or anything with its interface). The
 * bridge has a single listener, so one adapter per bridge; its events are
 * dispatched by `connectionId`:
 *   offer     → resolves the outstanding `peer.offer()`
 *   candidate → `candidate`; open → `open` (`relayed` = the `turn` path; the
 *               coordinator checks `maxMessageSize` itself)
 *   message   → `message`, from either channel (the coordinator decodes kind)
 *   drain     → `drain`, from EITHER channel
 *   failed    → `closed(reason)` (every bridge failure, `peer-host-unavailable`
 *               included, is a close reason: the carrier-failed path), then a
 *               pending offer rejects
 * `bufferedAmount()` is `bridge.queued(connectionId)` WITHOUT a channel: the
 * connection's load over both channels, which `send` admits against.
 */
export function createRemoteTransportPeerHost(bridge: RemoteTransportPeerBridge): RemoteTransportPeerHost {
  interface Entry {
    events: RemoteTransportPeerEvents;
    offer: {
      resolve(local: { sdp: string; fingerprints: RemoteWebrtcFingerprint[] }): void;
      reject(error: Error): void;
    } | null;
  }
  const entries = new Map<string, Entry>();
  const settleOffer = (entry: Entry): Entry['offer'] => {
    const pending = entry.offer;
    entry.offer = null;
    return pending;
  };
  bridge.onEvent((event) => {
    const entry = entries.get(event.connectionId);
    if (!entry) return;
    switch (event.type) {
      case 'offer':
        settleOffer(entry)?.resolve({ sdp: event.sdp, fingerprints: event.fingerprints });
        return;
      case 'candidate':
        entry.events.candidate(event.candidate);
        return;
      case 'open':
        entry.events.open({ maxMessageSize: event.maxMessageSize, relayed: event.path === 'turn' });
        return;
      case 'message':
        entry.events.message(event.data);
        return;
      case 'drain':
        entry.events.drain();
        return;
      case 'failed': {
        entries.delete(event.connectionId);
        const pending = settleOffer(entry);
        entry.events.closed(event.reason);
        pending?.reject(new Error(event.reason));
        return;
      }
      default:
        return;
    }
  });
  return {
    create(init, events) {
      const id = init.connectionId;
      // `session` is a diagnostics label only: never the whole challenge.
      if (!bridge.create({ connectionId: id, session: init.sessionId.slice(0, 8), iceServers: init.iceServers })) {
        throw new Error('peer-host-unavailable');
      }
      const entry: Entry = { events, offer: null };
      entries.set(id, entry);
      const refused = (what: string): Error => new Error(`${what} refused`);
      return {
        offer: () =>
          new Promise((resolve, reject) => {
            if (entries.get(id) !== entry || entry.offer) {
              reject(refused('offer'));
              return;
            }
            entry.offer = { resolve, reject };
            if (!bridge.offer(id)) settleOffer(entry)?.reject(refused('offer'));
          }),
        // A refused answer already failed the connection (`failed` first).
        answer: async (sdp, fingerprints) => {
          if (!bridge.answer(id, { sdp, fingerprints })) throw refused('answer');
        },
        candidate: async (candidate) => {
          if (!bridge.candidate(id, candidate)) throw refused('candidate');
        },
        send: (channel, message) => bridge.send(id, channel, message),
        bufferedAmount: () => bridge.queued(id),
        close: () => {
          if (entries.get(id) === entry) entries.delete(id);
          settleOffer(entry)?.reject(refused('offer'));
          bridge.close(id);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Stage 1D hook: media adapter records (main/remote-transport/media.ts)
// ---------------------------------------------------------------------------

/** Builds the session's media adapter on its link. Every assembled inbound
 *  payload is offered to `adapter.receive` first (true: a media message,
 *  consumed); `adapter.close()` runs when the session ends. The link's
 *  `send` runs in the same serialized admit → seal → push path as RPCs, so
 *  media never jumps or starves them. */
export type RemoteTransportMediaFactory = (link: RemoteTransportMediaLink) => RemoteTransportMediaAdapter;

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

/** The E2EE channel operations the stream needs. */
export type RemoteTransportChannel = Pick<
  RelayE2EEChannel,
  | 'encryptBinary'
  | 'decryptJson'
  | 'sealControl'
  | 'openControl'
  | 'registerControlLane'
  | 'activateControlLane'
  | 'retireControlLane'
> & { readonly mediaKey?: CryptoKey | null };

/** The relay carrier of one session: writes one MXT message as one binary
 *  relay frame on the NON-droppable path, resolving once the socket took it. */
export interface RemoteTransportRelayCarrier {
  send(message: Uint8Array): Promise<void>;
}

export type RemoteTransportEndReason =
  | 'session-ended'
  | 'revoked'
  | 'record-expiry'
  | 'assembly-stalled'
  | 'protocol-error'
  | 'seal-failed';

export interface RemoteTransportEnded {
  reason: RemoteTransportEndReason;
  /** Calls whose answers were sealed but never acked, or never sealed: the
   *  client fails them as ambiguous (never replayed into a new session). */
  ambiguousCallIds: number[];
}

/** A send refused because the session ended (nothing more will be sealed). */
export class RemoteTransportEndedError extends Error {
  constructor(readonly reason: RemoteTransportEndReason) {
    super(`Remote transport session ended (${reason}).`);
    this.name = 'RemoteTransportEndedError';
  }
}

/** A message refused BEFORE sealing: its JSON exceeds
 *  REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES (the relay's frame ceiling). */
export class RemoteTransportOversizeError extends RangeError {
  constructor(readonly bytes: number) {
    super(`Remote transport message exceeds ${REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES} bytes.`);
    this.name = 'RemoteTransportOversizeError';
  }
}

export interface RemoteTransportCoordinatorDeps {
  /** The E2EE challenge of this session. */
  sessionId: string;
  channel: RemoteTransportChannel;
  relay: RemoteTransportRelayCarrier;
  /** One complete application message from the client, in stream order.
   *  `bytes` is its serialized size. Awaited before the next one. */
  deliver(payload: unknown, bytes: number): Promise<void> | void;
  /** The coordinator ended the session itself (expiry, stalled assembly,
   *  protocol error): the caller closes the client. Not called for `close()`. */
  ended(ended: RemoteTransportEnded): void;
  /** Authenticated inbound arrived (a record opened, a control box opened). */
  authenticated?(): void;
  /** An authenticated `close{reason:'suspended'}` arrived: the leg is in the
   *  background from now on. */
  suspended?(): void;
  /** The hidden peer renderer; absent: relay-only. */
  peerHost?: RemoteTransportPeerHost | null;
  /** Stage 1D's media adapter; absent: no media lane on the stream. */
  media?: RemoteTransportMediaFactory | null;
  /** ICE servers for a new peer; defaults to the process cache the live
   *  view uses (one credential set serves both peers of the session). */
  resolveIceServers?(): Promise<unknown>;
  now?(): number;
  /** Runs `tick` periodically; returns the stop. Defaults to every
   *  REMOTE_TRANSPORT_MAX_ACK_DELAY_MS (the delayed-ack timer). */
  schedule?(tick: () => void): () => void;
  log?(line: string): void;
}

export interface RemoteTransportCoordinatorDiagnostics extends RemoteTransportDiagnostics {
  receiver: RemoteTransportReceiverStats;
  turnAllocations: number;
  /** Carrier messages that failed to decode, and control boxes that failed
   *  to authenticate (forged or corrupted). */
  malformed: number;
  forged: number;
  /** Offered connections a client may still name (at most 2). */
  retainedOffers: number;
}

export interface RemoteTransportCoordinator {
  readonly sessionId: string;
  /** Seals one application message and hands it to the stream. Resolves
   *  with its wire bytes once every record is in the sender, or null when a
   *  droppable message was dropped BEFORE sealing (window closed). Rejects
   *  with RemoteTransportOversizeError (refused before sealing) or
   *  RemoteTransportEndedError. */
  send(
    payload: unknown,
    options?: {
      droppable?: boolean;
      stream?: string;
      /** Called with the bytes of each carrier message of this payload's
       *  records once the RELAY socket took it (re-sends included; none for
       *  messages a direct carrier moved). Can fire after `send` resolved. */
      onRelayWrite?(bytes: number): void;
    }
  ): Promise<number | null>;
  /** Whether a (non-bulk) record would be admitted now. */
  canAdmit(): boolean;
  /** One carrier message as received: `relay`, or `direct:<connectionId>`. */
  receive(carrier: string, message: Uint8Array): void;
  /** Timers: delayed acks, loss recovery, probes, keep-alive, path health. */
  tick(): void;
  /** Ends the session from outside (client removed, revoked, replaced). */
  close(reason?: RemoteTransportEndReason): RemoteTransportEnded;
  nextSequence(): number;
  diagnostics(): RemoteTransportCoordinatorDiagnostics;
}

const RELAY = 'relay';

interface DirectCarrier {
  id: string;
  /** Its control lane: epoch = the generation of the offer that created it. */
  lane: RelayE2EEControlLane;
  connectionId: string;
  generation: number;
  peer: RemoteTransportPeer | null;
  monitor: RemoteTransportPathMonitor;
  startedAt: number;
  /** Channels open, certificate matched, max message size fits. */
  open: boolean;
  relayed: boolean;
}

type Carrier = typeof RELAY | DirectCarrier;

/** An offered connection; `closedAt` is set when it closes here. */
interface OfferRef {
  connectionId: string;
  generation: number;
  closedAt: number | null;
}

interface Outgoing {
  pieces: unknown[];
  index: number;
  stream: string | undefined;
  droppable: boolean;
  callId: number | null;
  wireBytes: number;
  onRelayWrite: ((bytes: number) => void) | undefined;
  resolve(bytes: number | null): void;
  reject(error: unknown): void;
}

/** Wire bytes of one sealed box once framed (encodeRemoteTransportRecord). */
function recordWireBytes(boxBytes: number): number {
  if (boxBytes <= REMOTE_TRANSPORT_CHUNK_BYTES) return REMOTE_TRANSPORT_PREFIX_BYTES + boxBytes;
  return boxBytes + Math.ceil(boxBytes / REMOTE_TRANSPORT_CHUNK_BYTES) * REMOTE_TRANSPORT_CHUNK_HEADER_BYTES;
}

/** Serialized bytes a fragment carries (base64url without padding). */
function fragmentBytes(value: unknown): number {
  const data = (value as { data?: unknown } | null)?.data;
  return typeof data === 'string' ? Math.floor((data.length * 3) / 4) : 0;
}

function isFragment(value: unknown): boolean {
  return (
    Boolean(value) && typeof value === 'object' && (value as { type?: unknown }).type === REMOTE_TRANSPORT_FRAGMENT_TYPE
  );
}

function pathReasonOf(reason: RemoteTransportCloseReason): RemoteTransportPathReason {
  switch (reason) {
    case 'fingerprint-mismatch':
    case 'ice-failed':
    case 'negotiation-timeout':
    case 'peer-host-unavailable':
    case 'suspended':
    case 'stall':
    case 'session-ended':
      return reason;
    default:
      return 'channel-failed';
  }
}

const isControlTag = (value: unknown): boolean => {
  const tag = (value as { t?: unknown } | null)?.t;
  return tag === 'ack' || tag === 'repair' || tag === 'ping' || tag === 'pong';
};

export function createRemoteTransportCoordinator(deps: RemoteTransportCoordinatorDeps): RemoteTransportCoordinator {
  const now = deps.now ?? (() => performance.now());
  const log = deps.log ?? ((line: string) => console.info(line));
  const label = `[mixdog-remote-transport] session=${deps.sessionId.slice(0, 8)}`;
  const resolveIce = deps.resolveIceServers ?? resolveRemoteIceServers;
  const sender = new RemoteTransportSender();
  const receiver = new RemoteTransportReceiver();
  // The process pool every desktop session shares (REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES).
  const assembler = new RemoteTransportMessageAssembler();
  const relayMonitor = new RemoteTransportPathMonitor(now());

  let closed = false;
  let ended: RemoteTransportEnded | null = null;
  let current: Carrier = RELAY;
  let direct: DirectCarrier | null = null;
  let generation = 0;
  let nextAttemptAt = now();
  /** The direct path cannot carry this contract (max message size). */
  let directUnfit = false;
  /** The client suspended: no new peer until it asks for a restart. */
  let suspended = false;
  let reason: RemoteTransportPathReason | null = null;
  let turnAllocations = 0;
  let fragmentId = 0;
  let relayInFlight = 0;
  let bytesSent = 0;
  let bytesReceived = 0;
  let malformed = 0;
  let forged = 0;
  let pendingOpens = 0;
  let pingId = 0;
  const pings = new Map<number, { carrier: string; at: number }>();
  const lastPingAt = new Map<string, number>();
  const queue: Outgoing[] = [];
  /**
   * The offered connections a client may still name in a `close`, and
   * nothing else (§3 signaling: anything below the current generation is
   * stale):
   * - `lastOffer`: the newest offer, live or closed. The client names it
   *   while it is current, and after it closed (its last offered connection).
   * - `previousOffer`: the offer before it, only while its close is younger
   *   than one negotiation window. A client close naming it was sent before
   *   the newer offer reached the client and crossed it on the ordered relay
   *   lane. Offers start at least one negotiation window apart
   *   (`closeDirect`), so a crossing close arrives within that window.
   * So the history is at most two entries, however long the session lives.
   */
  let lastOffer: OfferRef | null = null;
  let previousOffer: OfferRef | null = null;
  const namesOffer = (ref: OfferRef | null, signal: { connectionId: string; generation: number }): boolean =>
    ref !== null && ref.connectionId === signal.connectionId && ref.generation === signal.generation;
  /** Expires `previousOffer` once its crossing window has passed. */
  const retainedOffer = (signal: { connectionId: string; generation: number }, at: number): OfferRef | null => {
    const previous = previousOffer;
    if (previous && previous.closedAt !== null && at - previous.closedAt >= REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS) {
      previousOffer = null;
    }
    if (namesOffer(lastOffer, signal)) return lastOffer;
    if (namesOffer(previousOffer, signal)) return previousOffer;
    return null;
  };
  /** Sealed answers to calls, by the sequence of their last record, until acked. */
  const callIds = new Map<number, number>();
  /** Relay-write callbacks of sent payloads, by record sequence, until acked. */
  const relayWriters = new Map<number, (bytes: number) => void>();
  /** Carrier each buffered record arrived on, until it opens. */
  const arrivedOn = new Map<number, string>();
  const writableListeners = new Set<() => void>();
  /** A payload the assembler could not take yet (`wait`): offered again
   *  before any further record is pulled. */
  let held: { value: unknown; bytes: number } | null = null;
  let assemblingBytes = 0;

  const carrierId = (carrier: Carrier): string => (carrier === RELAY ? RELAY : carrier.id);
  const laneOf = (carrier: Carrier): RelayE2EEControlLane => (carrier === RELAY ? RELAY_E2EE_RELAY_LANE : carrier.lane);
  const retireLane = (state: DirectCarrier): void => {
    try {
      deps.channel.retireControlLane(state.lane);
    } catch {
      // Never registered (the peer failed before its lane was).
    }
  };
  const monitorOf = (key: string): RemoteTransportPathMonitor | null =>
    key === RELAY ? relayMonitor : direct?.id === key ? direct.monitor : null;
  const currentMonitor = (): RemoteTransportPathMonitor => (current === RELAY ? relayMonitor : current.monitor);
  const bufferedOf = (carrier: Carrier): number =>
    carrier === RELAY ? relayInFlight : (carrier.peer?.bufferedAmount() ?? 0);
  const live = (state: DirectCarrier): boolean => !closed && direct === state;
  const noteOutstanding = (at: number): void => currentMonitor().outstanding(sender.stats().outstandingBytes, at);

  // -- carriers -------------------------------------------------------------

  let woken = false;
  const wake = (): void => {
    if (woken || closed) return;
    woken = true;
    queueMicrotask(() => {
      woken = false;
      if (closed) return;
      flushCarrier();
      void pumpOutbound();
      for (const listener of [...writableListeners]) listener();
    });
  };

  const writeRelay = (message: Uint8Array, onWritten?: (bytes: number) => void): void => {
    relayInFlight += message.byteLength;
    bytesSent += message.byteLength;
    const done = (): void => {
      relayInFlight -= message.byteLength;
      wake();
    };
    // A failed write means the relay leg is gone; the registry ends every
    // session on it, so there is nothing to re-route here.
    deps.relay.send(message).then(() => {
      try {
        // Diagnostics only: nothing the callback does may touch delivery, and
        // none runs once the session is closed.
        if (!closed) onWritten?.(message.byteLength);
      } catch {
        // A failing meter never changes in-flight accounting or the write.
      } finally {
        done();
      }
    }, done);
  };

  /** False: the direct peer refused it (nothing queued). `onRelayWrite` runs
   *  only for a message the relay socket took. */
  const write = (
    carrier: Carrier,
    channel: 'app' | 'control',
    message: Uint8Array,
    onRelayWrite?: (bytes: number) => void
  ): boolean => {
    if (carrier === RELAY) {
      writeRelay(message, onRelayWrite);
      return true;
    }
    if (!carrier.peer?.send(channel, message)) return false;
    bytesSent += message.byteLength;
    return true;
  };

  /** Hands every due record to the current carrier, within its room. On a
   *  direct carrier app records take at most HIGH − CONTROL_RESERVE of the
   *  connection's aggregate load (both channels), so control boxes always
   *  find room; a record that does not fit whole waits for `drain`. */
  const flushCarrier = (): void => {
    if (closed) return;
    const at = now();
    const carrier = current;
    const key = carrierId(carrier);
    const limit =
      carrier === RELAY
        ? REMOTE_TRANSPORT_BUFFER_HIGH_BYTES
        : REMOTE_TRANSPORT_BUFFER_HIGH_BYTES - REMOTE_TRANSPORT_CONTROL_RESERVE_BYTES;
    for (const record of sender.due(at, limit - bufferedOf(carrier))) {
      const messages = encodeRemoteTransportRecord(record.box);
      if (carrier !== RELAY) {
        const bytes = messages.reduce((sum, message) => sum + message.byteLength, 0);
        if (bufferedOf(carrier) + bytes > limit) break;
      }
      let sent = true;
      const onRelayWrite = relayWriters.get(record.sequence);
      for (const message of messages) {
        if (!write(carrier, 'app', message, onRelayWrite)) {
          sent = false;
          break;
        }
      }
      if (!sent) break;
      sender.markSent(record.sequence, key, at);
    }
  };

  /** Seals one control message FOR `carrier`'s lane and writes it there the
   *  moment the seal resolves (seals resolve in sequence order, so every lane
   *  carries ascending control sequences). A box sealed for a direct carrier
   *  that is gone by then is dropped, never moved to the relay: acks are
   *  regenerated on the surviving carrier (`carrierChanged`), repairs by the
   *  receiver's PTO, pings by the keep-alive. A box the peer refuses (the
   *  whole shared bound in use) is dropped the same way. */
  const sendControl = (message: unknown, carrier: Carrier): void => {
    if (closed || (carrier !== RELAY && direct !== carrier)) return;
    deps.channel.sealControl(message, laneOf(carrier)).then(
      (box) => {
        if (closed || (carrier !== RELAY && (direct !== carrier || !carrier.peer))) return;
        write(carrier, 'control', encodeRemoteTransportControl(box));
      },
      () => fail('seal-failed')
    );
  };

  const flushAck = (at: number): void => {
    if (closed) return;
    const due = receiver.ackDue(at);
    if (!due) return;
    receiver.ackSent(due.through);
    sendControl(remoteTransportAck(due.through, due.ranges), current);
  };

  const clearPings = (key: string): void => {
    for (const [id, entry] of pings) if (entry.carrier === key) pings.delete(id);
  };

  /** Every ping carries `sent`, so the receiver can find a lost final record. */
  const ping = (carrier: Carrier, at: number): void => {
    const key = carrierId(carrier);
    const monitor = monitorOf(key);
    if (!monitor) return;
    const horizon = at - monitor.idleTimeoutMs();
    for (const [id, entry] of pings) if (entry.carrier === key && entry.at < horizon) pings.delete(id);
    pingId = pingId >= Number.MAX_SAFE_INTEGER ? 1 : pingId + 1;
    pings.set(pingId, { carrier: key, at });
    lastPingAt.set(key, at);
    sendControl(remoteTransportPing(pingId, sender.probeThrough(key, bufferedOf(carrier))), carrier);
  };

  // -- path changes -----------------------------------------------------------

  const promote = (state: DirectCarrier, at: number): void => {
    deps.channel.activateControlLane(state.lane);
    current = state;
    // RFC 9000 §9.4: a new path starts from fresh RTT and progress state.
    state.monitor.reset(at);
    clearPings(state.id);
    reason = 'channel-open';
    log(`${label} path=${state.relayed ? 'turn' : 'direct'} reason=channel-open generation=${state.generation}`);
    receiver.carrierChanged(at);
    flushAck(at);
    wake();
  };

  const demote = (state: DirectCarrier, at: number, why: RemoteTransportPathReason, detail = ''): void => {
    if (current !== state) return;
    current = RELAY;
    // Held for one PTO of the surviving carrier, or until the resume ack.
    sender.carrierFailed(state.id, at, relayMonitor.ptoMs());
    relayMonitor.reset(at);
    clearPings(RELAY);
    reason = why;
    log(`${label} path=relay reason=${why}${detail ? ` detail=${detail}` : ''}`);
    receiver.carrierChanged(at);
    flushAck(at);
    noteOutstanding(at);
    wake();
  };

  const signalRef = (state: DirectCarrier): RemoteTransportSignalRef => ({
    v: REMOTE_TRANSPORT_VERSION,
    sessionId: deps.sessionId,
    connectionId: state.connectionId,
    generation: state.generation,
  });

  /** Drops the direct carrier: demotes it first when it carried traffic. */
  const closeDirect = (
    state: DirectCarrier,
    closeReason: RemoteTransportCloseReason,
    options: { signal: boolean; why?: RemoteTransportPathReason; detail?: string }
  ): void => {
    if (!live(state)) return;
    const at = now();
    const why = options.why ?? pathReasonOf(closeReason);
    if (current === state) demote(state, at, why, options.detail);
    else {
      reason = why;
      log(`${label} direct-closed reason=${closeReason}${options.detail ? ` detail=${options.detail}` : ''}`);
    }
    direct = null;
    if (lastOffer?.connectionId === state.connectionId) lastOffer.closedAt = at;
    clearPings(state.id);
    lastPingAt.delete(state.id);
    retireLane(state);
    state.peer?.close(closeReason);
    if (options.signal) sendControl({ ...signalRef(state), t: 'close', reason: closeReason }, RELAY);
    // A new attempt runs in parallel to the relay, at most one per
    // negotiation window, so a path that fails at once cannot spin. Nothing
    // shortens this deadline, a client `restart` included.
    nextAttemptAt = Math.max(at, state.startedAt + REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS);
  };

  const peerEvents = (state: DirectCarrier): RemoteTransportPeerEvents => ({
    candidate: (candidate) => {
      if (live(state)) sendControl({ ...signalRef(state), t: 'candidate', candidate }, RELAY);
    },
    open: ({ maxMessageSize, relayed }) => {
      if (!live(state) || state.open) return;
      if (!remoteTransportCarrierFits(maxMessageSize)) {
        directUnfit = true;
        closeDirect(state, 'channel-failed', { signal: true, why: 'message-size', detail: String(maxMessageSize) });
        return;
      }
      const at = now();
      state.open = true;
      state.relayed = relayed;
      if (relayed) {
        turnAllocations += 1;
        log(`${label} turn-allocations=${turnAllocations} path=turn generation=${state.generation}`);
      }
      // Path validation (RFC 9000 §8.2): one ping/pong round trip on it
      // since it became healthy; promotion follows the matched pong.
      state.monitor.reset(at);
      clearPings(state.id);
      ping(state, at);
    },
    message: (message) => {
      if (live(state)) receive(state.id, message);
    },
    drain: () => {
      if (live(state)) wake();
    },
    closed: (closeReason) => {
      if (!live(state)) return;
      closeDirect(state, closeReason, { signal: true });
    },
  });

  const startPeer = async (at: number): Promise<void> => {
    const host = deps.peerHost;
    if (!host) return;
    generation += 1;
    // 128 random bits: unguessable, 22 chars, within the signal token limit.
    const connectionId = randomBytes(16).toString('base64url');
    const state: DirectCarrier = {
      id: `direct:${connectionId}`,
      lane: { kind: 'direct', epoch: generation, connectionId },
      connectionId,
      generation,
      peer: null,
      monitor: new RemoteTransportPathMonitor(at),
      startedAt: at,
      open: false,
      relayed: false,
    };
    direct = state;
    let iceServers: RemoteWebrtcIceServer[];
    try {
      iceServers = parseRemoteWebrtcIceServers(await resolveIce());
    } catch {
      iceServers = [];
    }
    if (!live(state)) return;
    try {
      state.peer = host.create({ sessionId: deps.sessionId, connectionId, iceServers }, peerEvents(state));
    } catch {
      // No peer host right now (no desktop app attached to this daemon, or
      // its renderer is gone): the session stays on the relay and tries
      // again once per negotiation window, so an app that attaches later
      // serves the next offer.
      closeDirect(state, 'peer-host-unavailable', { signal: false });
      return;
    }
    let local: { sdp: string; fingerprints: RemoteWebrtcFingerprint[] };
    try {
      local = await state.peer.offer();
    } catch {
      closeDirect(state, 'channel-failed', { signal: false });
      return;
    }
    if (!live(state)) return;
    let offer: RemoteTransportSignal;
    try {
      // What the client will parse, held to one control box before sealing.
      offer = parseRemoteTransportSignal(
        { ...signalRef(state), t: 'offer', sdp: local.sdp, fingerprints: local.fingerprints, iceServers },
        'desktop'
      );
    } catch {
      closeDirect(state, 'protocol-error', { signal: false, why: 'message-size' });
      return;
    }
    // The new connection's lane, pending until promotion (epoch = this
    // offer's generation); nothing at or below it can come back.
    deps.channel.registerControlLane(state.lane);
    // Only one direct carrier at a time: the previous offer is closed here.
    previousOffer = lastOffer;
    lastOffer = { connectionId, generation: state.generation, closedAt: null };
    sendControl(offer, RELAY);
  };

  const maybeStartPeer = (at: number): void => {
    if (direct || !deps.peerHost || directUnfit || suspended || at < nextAttemptAt) return;
    void startPeer(at).catch(() => {
      if (direct) closeDirect(direct, 'channel-failed', { signal: false });
    });
  };

  const handleSignal = (signal: RemoteTransportSignal): void => {
    if (signal.sessionId !== deps.sessionId) return;
    const state = direct;
    const matches =
      state !== null && signal.connectionId === state.connectionId && signal.generation === state.generation;
    switch (signal.t) {
      case 'answer':
        if (matches && state.peer) {
          state.peer.answer(signal.sdp, signal.fingerprints).catch(() => {
            closeDirect(state, 'channel-failed', { signal: true });
          });
        }
        return;
      case 'candidate':
        if (matches && state.peer) state.peer.candidate(signal.candidate).catch(() => undefined);
        return;
      case 'close': {
        const at = now();
        const named = retainedOffer(signal, at);
        // The backstop for a `setForeground(false)` stuck behind a full
        // window: the leg stops counting as foreground first. It may name a
        // connection already closed here (`retainedOffer`); the rest is then
        // a no-op below.
        if (signal.reason === 'suspended' && named) deps.suspended?.();
        if (signal.reason === 'restart') {
          // Only the newest offer, live or closed; a stale or unknown
          // reference is a no-op. The next offer keeps the negotiation
          // pacing, so restarts cannot force offers in a loop.
          if (named !== lastOffer || named === null) return;
          suspended = false;
          if (matches) closeDirect(state, 'superseded', { signal: false, why: 'channel-failed', detail: 'restart' });
          maybeStartPeer(at);
          return;
        }
        if (!matches) return;
        if (signal.reason === 'suspended') suspended = true;
        closeDirect(state, signal.reason, { signal: false });
        return;
      }
      default:
        return;
    }
  };

  // -- control inbound ---------------------------------------------------------

  const matchPong = (key: string, id: number, at: number): void => {
    const entry = pings.get(id);
    // Only a pong for a locally timed ping still outstanding on THIS carrier,
    // consumed once.
    if (!entry || entry.carrier !== key) return;
    pings.delete(id);
    if (key === carrierId(current)) monitorOf(key)?.rttSample(at - entry.at);
    const state = direct;
    if (state && state.id === key && state.open && current !== state) promote(state, at);
  };

  const handleOpened = (key: string, opened: Awaited<ReturnType<RemoteTransportChannel['openControl']>>): void => {
    if (closed || opened.stale) return;
    let control: ReturnType<typeof readRemoteTransportControl>;
    try {
      control = readRemoteTransportControl(opened, 'client');
    } catch {
      // An authentic stream message the client could not have meant is the
      // end of the session; a signal it could not express ends this attempt.
      if (isControlTag(opened.value)) fail('protocol-error');
      else if (direct) closeDirect(direct, 'protocol-error', { signal: true });
      return;
    }
    if (!control) return;
    const at = now();
    monitorOf(key)?.inbound(at);
    deps.authenticated?.();
    switch (control.t) {
      case 'ack': {
        let released: number;
        try {
          released = sender.acknowledge(control, at);
        } catch {
          fail('protocol-error');
          return;
        }
        if (released > 0) {
          currentMonitor().ackAdvanced(at);
          const through = sender.stats().ackedThrough;
          for (const sequence of callIds.keys()) {
            if (sequence > through) break;
            callIds.delete(sequence);
          }
          for (const sequence of relayWriters.keys()) {
            if (sequence > through) break;
            relayWriters.delete(sequence);
          }
        }
        noteOutstanding(at);
        wake();
        return;
      }
      case 'repair':
        if (sender.repair(control) > 0) wake();
        return;
      case 'ping': {
        const carrier: Carrier | null = key === RELAY ? RELAY : direct?.id === key ? direct : null;
        if (carrier) sendControl({ v: REMOTE_TRANSPORT_VERSION, t: 'pong', id: control.id }, carrier);
        if (control.sent !== undefined) receiver.probe(control.sent, at);
        return;
      }
      case 'pong':
        matchPong(key, control.id, at);
        return;
      default:
        // Signaling travels on the relay lane only.
        if (key === RELAY) handleSignal(control);
    }
  };

  const openControl = (key: string, box: Uint8Array): void => {
    // An honest client has far fewer control boxes in flight than records;
    // a flood beyond the reorder span is dropped (acks are cumulative, pings
    // repeat, repairs are re-requested by PTO).
    const lane = key === RELAY ? RELAY_E2EE_RELAY_LANE : direct?.id === key ? direct.lane : null;
    if (!lane || pendingOpens >= REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT) {
      forged += 1;
      return;
    }
    pendingOpens += 1;
    deps.channel.openControl(box, lane).then(
      (opened) => {
        pendingOpens -= 1;
        handleOpened(key, opened);
      },
      () => {
        pendingOpens -= 1;
        forged += 1;
      }
    );
  };

  // -- application inbound ------------------------------------------------------

  /** False when the stream must stop pulling records (held, or ended). */
  const assemble = async (value: unknown, recordBytes: number): Promise<boolean> => {
    let result: ReturnType<RemoteTransportMessageAssembler['accept']>;
    try {
      result = assembler.accept(value, now());
    } catch {
      fail('protocol-error');
      return false;
    }
    if (result.state === 'wait') {
      held = { value, bytes: recordBytes };
      return false;
    }
    held = null;
    const fragment = isFragment(value);
    if (fragment) assemblingBytes += fragmentBytes(value);
    if (result.state === 'partial') return true;
    const bytes = fragment ? assemblingBytes : recordBytes;
    assemblingBytes = 0;
    if (!mediaAdapter?.receive(result.payload)) {
      try {
        await deps.deliver(result.payload, bytes);
      } catch {
        // The application answers its own failures; the stream goes on.
      }
    }
    return !closed;
  };

  let draining = false;
  let drainAgain = false;
  const drainInbound = async (): Promise<void> => {
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = true;
    try {
      do {
        drainAgain = false;
        while (!closed) {
          if (held) {
            if (!(await assemble(held.value, held.bytes))) break;
            continue;
          }
          const next = receiver.next();
          if (!next) break;
          let value: unknown;
          try {
            value = await deps.channel.decryptJson(next.box);
          } catch {
            if (closed) return;
            // Failed authentication: that copy goes; a rival or the repair
            // the receiver asks for refills the slot.
            receiver.discard(next.sequence);
            continue;
          }
          if (closed) return;
          const at = now();
          receiver.commit(next.sequence, at);
          const key = arrivedOn.get(next.sequence);
          for (const sequence of arrivedOn.keys()) if (sequence <= next.sequence) arrivedOn.delete(sequence);
          if (key) monitorOf(key)?.inbound(at);
          deps.authenticated?.();
          if (!(await assemble(value, next.box.byteLength))) break;
        }
      } while (drainAgain && !closed && !held);
    } finally {
      draining = false;
    }
    flushAck(now());
  };

  const receive = (key: string, raw: Uint8Array): void => {
    if (closed || (key !== RELAY && direct?.id !== key)) return;
    bytesReceived += raw.byteLength;
    let message: ReturnType<typeof decodeRemoteTransportMessage>;
    try {
      message = decodeRemoteTransportMessage(raw);
    } catch {
      // Nothing a conforming client produces; a carrier (the relay) may.
      malformed += 1;
      return;
    }
    if (message.kind === 'control') {
      openControl(key, message.box);
      return;
    }
    const at = now();
    const result = receiver.accept(message, at);
    if (result === 'buffered') arrivedOn.set(message.sequence, key);
    if (result === 'duplicate') flushAck(at);
    void drainInbound();
  };

  // -- application outbound -------------------------------------------------------

  let pumping = false;
  const pumpOutbound = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (!closed && queue.length > 0) {
        const item = queue[0];
        const admission = item.stream === undefined ? {} : { stream: item.stream, bufferedAmount: bufferedOf(current) };
        if (!sender.canAdmit(admission)) {
          // Dropping happens here, BEFORE sealing, never after.
          if (item.index === 0 && (item.droppable || item.stream !== undefined)) {
            queue.shift();
            item.resolve(null);
            continue;
          }
          break;
        }
        let box: Uint8Array;
        try {
          box = await deps.channel.encryptBinary(item.pieces[item.index]);
        } catch (error) {
          if (closed) return;
          // A size refusal runs before the sequence is assigned: nothing was
          // consumed. Anything else broke the stream.
          if (error instanceof RangeError && item.index === 0) {
            queue.shift();
            item.reject(error);
            continue;
          }
          fail('seal-failed');
          return;
        }
        if (closed) return;
        let sequence: number;
        try {
          sequence = sender.push(box, item.stream === undefined ? {} : { stream: item.stream });
        } catch {
          fail('seal-failed');
          return;
        }
        if (item.onRelayWrite) relayWriters.set(sequence, item.onRelayWrite);
        item.wireBytes += recordWireBytes(box.byteLength);
        item.index += 1;
        if (item.index === item.pieces.length) {
          queue.shift();
          if (item.callId !== null) callIds.set(sequence, item.callId);
          item.resolve(item.wireBytes);
        }
        noteOutstanding(now());
        flushCarrier();
      }
    } finally {
      pumping = false;
    }
  };

  const send: RemoteTransportCoordinator['send'] = (payload, options = {}) => {
    if (closed) return Promise.reject(new RemoteTransportEndedError(ended?.reason ?? 'session-ended'));
    let pieces: unknown[];
    try {
      pieces = splitRemoteTransportPayload(payload, fragmentId + 1);
    } catch (error) {
      const text = (() => {
        try {
          return JSON.stringify(payload);
        } catch {
          return undefined;
        }
      })();
      const bytes = typeof text === 'string' ? Buffer.byteLength(text) : 0;
      return Promise.reject(
        bytes > REMOTE_TRANSPORT_MAX_APPLICATION_MESSAGE_BYTES ? new RemoteTransportOversizeError(bytes) : error
      );
    }
    if (pieces.length > 1) fragmentId += 1;
    const droppable = options.droppable === true;
    if (droppable && !sender.canAdmit()) return Promise.resolve(null);
    return new Promise<number | null>((resolve, reject) => {
      queue.push({
        pieces,
        index: 0,
        stream: options.stream,
        droppable,
        callId: relayFrameCallId(payload),
        wireBytes: 0,
        onRelayWrite: options.onRelayWrite,
        resolve,
        reject,
      });
      void pumpOutbound();
    });
  };

  // -- lifecycle ---------------------------------------------------------------

  const tick = (): void => {
    if (closed) return;
    const at = now();
    if (sender.expired(at)) {
      fail('record-expiry');
      return;
    }
    if (assembler.stalled(at)) {
      fail('assembly-stalled');
      return;
    }
    const state = direct;
    if (state) {
      if (!state.open) {
        if (at - state.startedAt >= REMOTE_TRANSPORT_NEGOTIATION_TIMEOUT_MS) {
          closeDirect(state, 'negotiation-timeout', { signal: true });
        }
      } else if (current === state) {
        state.monitor.buffered(bufferedOf(state), at);
        const stall = state.monitor.stalled(at, sender.stats().outstandingBytes);
        if (stall) closeDirect(state, 'stall', { signal: true, detail: stall });
      } else if (state.monitor.stalled(at, 0)) {
        // Open but never validated, and silent for the idle timeout.
        closeDirect(state, 'stall', { signal: true, detail: 'silent' });
      }
    }
    relayMonitor.buffered(relayInFlight, at);
    maybeStartPeer(at);
    if (held) void drainInbound();
    receiver.sweep(at, currentMonitor().idleTimeoutMs());
    const repairs = receiver.repairDue(at, currentMonitor());
    if (repairs.length > 0) sendControl(remoteTransportRepair(repairs), current);
    flushAck(at);
    if (sender.probeDue(at, currentMonitor().ptoMs())) ping(current, at);
    const carriers: Carrier[] = direct?.open ? [RELAY, direct] : [RELAY];
    for (const carrier of carriers) {
      const last = lastPingAt.get(carrierId(carrier));
      if (last === undefined || at - last >= REMOTE_TRANSPORT_PING_MS) ping(carrier, at);
    }
    flushCarrier();
    void pumpOutbound();
  };

  const stopTimer = (
    deps.schedule ??
    ((run: () => void) => {
      const timer = setInterval(run, REMOTE_TRANSPORT_MAX_ACK_DELAY_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    })
  )(tick);

  const close = (endReason: RemoteTransportEndReason = 'session-ended'): RemoteTransportEnded => {
    if (ended) return ended;
    closed = true;
    stopTimer();
    const state = direct;
    direct = null;
    current = RELAY;
    if (state) retireLane(state);
    state?.peer?.close(endReason === 'revoked' ? 'revoked' : 'session-ended');
    assembler.close();
    held = null;
    const acked = sender.stats().ackedThrough;
    const ambiguousCallIds = [...callIds].filter(([sequence]) => sequence > acked).map(([, id]) => id);
    for (const item of queue) if (item.callId !== null) ambiguousCallIds.push(item.callId);
    callIds.clear();
    relayWriters.clear();
    ended = { reason: endReason, ambiguousCallIds };
    const error = new RemoteTransportEndedError(endReason);
    for (const item of queue.splice(0)) item.reject(error);
    // Every media pump stops; nothing more is sent.
    mediaAdapter?.close();
    writableListeners.clear();
    log(`${label} ended reason=${endReason} ambiguous-calls=${ambiguousCallIds.length}`);
    return ended;
  };

  function fail(endReason: RemoteTransportEndReason): void {
    if (closed) return;
    deps.ended(close(endReason));
  }

  const link: RemoteTransportMediaLink = {
    canAdmit: (stream) =>
      !closed && queue.length === 0 && sender.canAdmit({ stream, bufferedAmount: bufferedOf(current) }),
    // Bulk admission is re-checked at seal time in the serialized path; a
    // refusal there seals nothing (null → false).
    // Without `admission` it is an ordinary record (a refusal), sealed like an RPC answer.
    send: (message, admission?: { stream: string }) => send(message, admission ?? {}).then((bytes) => bytes !== null),
    protocolError: () => fail('protocol-error'),
    onWritable: (listener) => {
      writableListeners.add(listener);
      return () => {
        writableListeners.delete(listener);
      };
    },
  };
  const mediaAdapter: RemoteTransportMediaAdapter | null = deps.media?.(link) ?? null;

  return {
    sessionId: deps.sessionId,
    send,
    canAdmit: () => !closed && sender.canAdmit(),
    receive,
    tick,
    close,
    nextSequence: () => sender.nextSequence(),
    diagnostics: () => {
      const stats = sender.stats();
      return {
        path: current === RELAY ? 'relay' : current.relayed ? 'turn' : 'direct',
        reason,
        bytesSent,
        bytesReceived,
        queueDepth: queue.length,
        outstandingBytes: stats.outstandingBytes,
        retransmits: stats.retransmits,
        receiver: receiver.stats(),
        turnAllocations,
        malformed,
        forged,
        retainedOffers: (lastOffer ? 1 : 0) + (previousOffer ? 1 : 0),
      };
    },
  };
}
