// One relay socket's life for the phone's connector: the E2EE handshake, the sealed frame lanes (plain relay, or the transport peer),
// the keepalive and wake probes, and the ways the socket ends (closed, recycled, parked for the desktop's return).
import type { SentClaim, TransportSink, TransportWriter } from '../../../packages/protocol-client/src/index.ts';
import {
  createRelayE2EEClientHandshake,
  isRelayE2EEChallenge,
  type RelayE2EEChannel,
  type RelayE2EEChallenge,
  type RelayE2EEPairingMaterial,
} from '../../desktop/src/shared/remote-e2ee.ts';
import {
  createRemoteTransportPeer,
  remoteTransportOptIn,
  CarrierDeparture,
  type RemoteTransportPeer,
} from '../../desktop/src/renderer/remote-transport-peer.ts';
import { FRAME_NOT_SENT_MESSAGE } from '../../desktop/src/shared/remote-transport.ts';
import type { RelayConnectorDeps, RelaySocket } from './relay-connector.ts';

/** A socket whose desktop leg went away while the relay kept it: the relay re-challenges it when the desktop returns, so the
 *  next open takes it over instead of dialing again. Frames that arrive meanwhile (the new challenge) wait in `inbox`. */
export interface ParkedSocket {
  readonly ws: RelaySocket;
  readonly inbox: unknown[];
}

/** What the connector's sessions share: the transport peer and session that own the socket now, and the parked socket, if any. */
export interface ConnectorState {
  active: RemoteTransportPeer | null;
  current: RelaySession | null;
  parked: ParkedSocket | null;
}

/** Challenges a joining socket may answer again after its first one: each is one desktop leg replaced mid-handshake. */
const MAX_HANDSHAKE_RESTARTS = 2;
/** Socket opening and the E2EE handshake must each finish within these. */
const OPEN_DEADLINE_MS = 12_000;
const HANDSHAKE_DEADLINE_MS = 10_000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_HANDSHAKE_TIMEOUT = 4408;
export const CLOSE_NORMAL = 1000;
/** The logical end of a session whose desktop leg went away while the relay kept the socket. */
const CLOSE_DESKTOP_LEG_GONE = 1012;
/** This page ended a socket for a reason of its own (keepalive, wake probe, failed view sync, a broken frame); the reason says which. */
const CLOSE_PHONE_ENDED = 4000;
/** What a close frame may say. The frame is cleartext to the relay, and a caller's reason can carry feed ids or exception text
 *  (`feed gap on <feed>`, `reducer failed on <feed>: <error>`, `transport failed: <error>`): only its category leaves this page. */
const CLOSE_CATEGORIES: readonly string[] = [
  'background',
  'aborted',
  'frame failed',
  'transport failed',
  'keepalive timed out',
  'wake probe unanswered',
  'wake dial restarted',
  'view sync failed',
  'relay connection timed out',
  'relay handshake timed out',
  'feed gap',
  'reducer failed',
  'invalid json',
  'frame is not an object',
  'bad notification',
  'response to unknown request',
  'bad error body',
  'core silent',
  'feed restore failed',
  'feed restore refused',
  'handshake failed',
  'version refused',
  'attempt failed',
  'connect timed out',
  'abandoned',
  'client closed',
];
const closeCategory = (reason: string): string =>
  CLOSE_CATEGORIES.find((c) => reason === c || reason.startsWith(`${c} `) || reason.startsWith(`${c}:`)) ?? 'other';
/** Keepalive: the relay answers a cleartext `{"ping":1}` with `{"pong":1}`; a socket silent this long is probed, and one
 *  whose probe stays unanswered is recycled. */
const KEEPALIVE_TICK_MS = 5_000;
const SILENCE_BEFORE_PING_MS = 25_000;
const PONG_DEADLINE_MS = 10_000;
/** A foreground wake probes at once; frames still arriving this long after the probe prove a live leg, earlier ones may be a frozen page's backlog. */
const WAKE_PROBE_MS = 2_500;
export const WAKE_TRAFFIC_PROOF_MS = 1_000;
const PING = '{"ping":1}';
const monotonicNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const timers = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Closes the parked socket (if any) and forgets it; a code and reason are sent only when given. */
export function closeParked(state: ConnectorState, code?: number, reason?: string): void {
  const parked = state.parked;
  if (!parked) return;
  state.parked = null;
  try {
    if (code === undefined) parked.ws.close();
    else parked.ws.close(code, reason);
  } catch {
    // already gone
  }
}

export interface RelaySessionInit {
  readonly state: ConnectorState;
  readonly deps: RelayConnectorDeps;
  readonly ws: RelaySocket;
  readonly pairing: RelayE2EEPairingMaterial;
  /** The parked socket this session takes over; its queued frames are replayed first. */
  readonly reuse: ParkedSocket | null;
  readonly sink: TransportSink;
  /** Settle the open: the writer once the desktop's `e2ee-ready` is authenticated, an error if the socket ends first. */
  readonly resolve: (writer: TransportWriter) => void;
  readonly reject: (error: Error) => void;
}

export class RelaySession {
  private readonly state: ConnectorState;
  private readonly deps: RelayConnectorDeps;
  private readonly ws: RelaySocket;
  private readonly pairing: RelayE2EEPairingMaterial;
  private readonly reuse: ParkedSocket | null;
  private readonly sink: TransportSink;
  private readonly resolveOpen: (writer: TransportWriter) => void;
  private readonly rejectOpen: (error: Error) => void;
  private readonly writer: TransportWriter;
  private readonly wsDeparture: CarrierDeparture;
  private readonly keepalive: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  private channel: RelayE2EEChannel | null = null;
  private mediaSid = '';
  private binaryFrames = false;
  private peer: RemoteTransportPeer | null = null;
  // The current challenge offered the transport: a transcript in `e2ee-ready` is then expected, and without the offer forbidden.
  private offerSeen = false;
  private ready = false;
  private finished = false;
  private quiet = false;
  // Hidden or probed since it last proved itself: its death is the cost of the background, not an outage.
  private unproven = false;
  // Requests sent and not yet answered: a keepalive recycle is invisible only while nothing waits on the socket.
  private readonly inflight = new Set<unknown>();
  private challengesSeen = 0;
  private generation = 0;
  private wakeGeneration = 0;
  private lastTrafficGeneration = 0;
  private lastTrafficAt = Date.now();
  private lastTrafficMono: number;
  private pingSentMono: number;
  private awaitingPong = false;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private inbound: Promise<void> = Promise.resolve();
  private outbound: Promise<void> = Promise.resolve();

  constructor(init: RelaySessionInit) {
    this.state = init.state;
    this.deps = init.deps;
    this.ws = init.ws;
    this.pairing = init.pairing;
    this.reuse = init.reuse;
    this.sink = init.sink;
    this.resolveOpen = init.resolve;
    this.rejectOpen = init.reject;
    this.now = init.deps.now ?? monotonicNow;
    this.lastTrafficMono = this.now();
    this.pingSentMono = this.lastTrafficMono;
    this.deadline = setTimeout(
      () => this.fail(CLOSE_HANDSHAKE_TIMEOUT, 'relay connection timed out'),
      init.reuse ? HANDSHAKE_DEADLINE_MS : OPEN_DEADLINE_MS
    );
    this.deps.signal?.addEventListener('abort', this.onAbort, { once: true });
    // The plain (untransported) leg's own queue: a frame has left once the socket's buffer holds no more than what was sent after it.
    this.wsDeparture = new CarrierDeparture(
      () => this.ws.bufferedAmount,
      () => !this.finished,
      timers
    );
    this.writer = {
      send: (text, claim) => this.send(text, claim),
      close: (code, reason) => this.fail(code, reason),
      // The receive work already accepted: this session's own chain, then the transport peer's (authentication, assembly).
      settled: async () => {
        for (let chain = this.inbound; ; chain = this.inbound) {
          await chain.catch(() => undefined);
          await this.peer?.settled().catch(() => undefined);
          if (chain === this.inbound) return;
        }
      },
    };
    // A socket silent for a while is probed; one whose probe stays unanswered is half dead and is recycled.
    this.keepalive = setInterval(() => this.keepaliveTick(), KEEPALIVE_TICK_MS);
    this.state.current = this;

    const ws = this.ws;
    ws.onmessage = (event) => {
      const wakeGeneration = this.wakeGeneration;
      this.lastTrafficAt = Date.now();
      this.lastTrafficMono = this.now();
      this.lastTrafficGeneration = wakeGeneration;
      this.inbound = this.inbound
        .then(() => (this.finished ? undefined : this.handle(event.data, wakeGeneration)))
        .catch(() => this.fail(CLOSE_PROTOCOL_ERROR, 'frame failed', true));
    };
    ws.onclose = (event) => this.finish(event.code, event.reason, true);
    ws.onerror = () => {};
    ws.onopen = () => {
      this.arm(HANDSHAKE_DEADLINE_MS);
      this.deps.encrypting?.();
    };
    if (init.reuse) for (const data of init.reuse.inbox) ws.onmessage({ data });
  }

  // Page lifecycle hooks, reached through the connector.

  unprove(): void {
    if (this.finished) return;
    this.unproven = true;
    this.wakeGeneration += 1;
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
  }

  /** False for a socket that is still opening or handshaking: nothing to prove yet, and a wake must not recycle a healthy first dial. */
  probe(): boolean {
    if (this.finished || !this.ready) return false;
    if (this.wakeTimer !== undefined) return true;
    this.unproven = true;
    this.wakeGeneration += 1;
    const wakeGeneration = this.wakeGeneration;
    const sentAt = this.now();
    this.pingSentMono = sentAt;
    this.awaitingPong = true;
    this.sendPing();
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      if (this.wakeGeneration !== wakeGeneration) return;
      // A leg still delivering a backlog queues the pong behind it.
      if (this.lastTrafficGeneration === wakeGeneration && this.lastTrafficMono - sentAt >= WAKE_TRAFFIC_PROOF_MS) {
        this.proven();
        return;
      }
      this.awaitingPong = false;
      this.deps.unresponsive?.();
      this.recycle(CLOSE_NORMAL, 'wake probe unanswered');
    }, WAKE_PROBE_MS);
    return true;
  }

  restartIfStale(force: boolean): boolean {
    if (this.finished || this.ready || (!force && !this.unproven)) return false;
    this.quiet = true;
    this.fail(CLOSE_NORMAL, 'wake dial restarted', true);
    return true;
  }

  silentSince(since: number): boolean {
    return this.wakeTimer === undefined && this.lastTrafficAt < since;
  }

  silentFor(windowMs: number): boolean {
    if (!this.ready) return true;
    return this.wakeTimer === undefined && this.now() - this.lastTrafficMono >= windowMs;
  }

  retire(): void {
    this.fail(CLOSE_NORMAL, 'view sync failed', true);
  }

  /** What was handed to the socket (the background report) leaves first, then the transport says it is suspended. */
  suspend(): void {
    this.quiet = true;
    this.wakeGeneration += 1;
    if (this.wakeTimer !== undefined) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = undefined;
    }
    this.outbound = this.outbound
      .then(() => this.peer?.suspend())
      .catch(() => undefined)
      .finally(() => this.fail(CLOSE_NORMAL, 'background'));
  }

  // Ending the socket.

  private readonly onAbort = (): void => this.fail(CLOSE_NORMAL, 'aborted', true);

  private arm(ms: number): void {
    clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.fail(CLOSE_HANDSHAKE_TIMEOUT, 'relay handshake timed out'), ms);
  }

  private stopTimers(): void {
    clearTimeout(this.deadline);
    this.deadline = undefined;
    clearTimeout(this.wakeTimer);
    this.wakeTimer = undefined;
    clearInterval(this.keepalive);
    if (this.state.current === this) this.state.current = null;
  }

  /** A new handshake or the end of the socket ends the transport stream with it. */
  private closePeer(): void {
    this.peer?.close();
    if (this.state.active === this.peer) this.state.active = null;
    this.peer = null;
  }

  /** Ends this attempt exactly once: before ready it rejects the open, after ready it is the sink's one `closed`. */
  private finish(code: number, reason: string, remote: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.deps.signal?.removeEventListener('abort', this.onAbort);
    this.stopTimers();
    this.closePeer();
    if (this.unproven) this.quiet = true;
    this.deps.closed?.(code, reason, { ready: this.ready, remote, quiet: this.quiet });
    if (this.ready) this.sink.closed(code, reason);
    else this.rejectOpen(new Error(`relay socket closed before ready (${code}${reason ? ` ${reason}` : ''})`));
  }

  /** With `bare` (a recycle, not a normal close), the socket is closed with {@link CLOSE_PHONE_ENDED}. The frame carries the
   *  reason's category so the PC's log names why this page ended it; the whole reason stays here (`finish`). */
  private fail(code: number, reason: string, bare = false): void {
    if (this.finished) return;
    try {
      // A browser WebSocket throws on any code but 1000 and 3000-4999 (1002 included), leaving the socket open.
      const wire = bare || (code !== CLOSE_NORMAL && (code < 3000 || code > 4999)) ? CLOSE_PHONE_ENDED : code;
      this.ws.close(wire, closeCategory(reason));
    } catch {
      // the socket is already gone; finish() below still ends the attempt
    }
    this.finish(code, reason, false);
  }

  private recycle(code: number, reason: string): void {
    if (this.inflight.size === 0) this.quiet = true;
    this.fail(code, reason, true);
  }

  /** The desktop leg behind this ready session is gone but the relay kept the socket: the session ends (its calls fail
   *  as for any lost connection) and the socket waits for the desktop's next challenge. */
  private park(waiting: unknown[]): void {
    if (this.finished || !this.ready) return;
    this.finished = true;
    this.deps.signal?.removeEventListener('abort', this.onAbort);
    this.quiet = waiting.length > 0;
    this.stopTimers();
    this.closePeer();
    const mine: ParkedSocket = { ws: this.ws, inbox: [...waiting] };
    this.state.parked = mine;
    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') mine.inbox.push(event.data);
    };
    this.ws.onclose = (event) => {
      // A socket the connector no longer owns (taken over, or closed by a suspension) says nothing.
      if (this.state.parked !== mine) return;
      this.state.parked = null;
      this.deps.closed?.(event.code, event.reason, { ready: false, remote: true, quiet: false });
    };
    const reason = this.quiet ? 'desktop leg replaced' : 'desktop leg gone';
    this.deps.closed?.(CLOSE_DESKTOP_LEG_GONE, reason, { ready: true, remote: false, quiet: this.quiet });
    this.sink.closed(CLOSE_DESKTOP_LEG_GONE, reason);
  }

  // Keepalive.

  private sendPing(): void {
    try {
      this.sendPlain(PING);
    } catch {
      // surfaces as a close
    }
  }

  private keepaliveTick(): void {
    if (this.finished || !(this.deps.visible?.() ?? true)) {
      this.awaitingPong = false;
      return;
    }
    const now = this.now();
    if (this.awaitingPong) {
      if (now - this.pingSentMono >= PONG_DEADLINE_MS) {
        this.awaitingPong = false;
        this.deps.unresponsive?.();
        this.recycle(CLOSE_NORMAL, 'keepalive timed out');
      }
      return;
    }
    if (now - Math.max(this.lastTrafficMono, this.pingSentMono) >= SILENCE_BEFORE_PING_MS) {
      this.pingSentMono = now;
      this.awaitingPong = true;
      this.sendPing();
    }
  }

  /** The leg answered a wake probe: it is live again. */
  private proven(): void {
    this.unproven = false;
    this.deps.probeAnswered?.();
  }

  // Receiving.

  /** The relay's own cleartext words: a pong answers a probe, `resync: desktop-gone` says the desktop leg left. */
  private clearWord(word: Record<string, unknown>, wakeGeneration: number): boolean {
    if (wakeGeneration === this.wakeGeneration) this.awaitingPong = false;
    if ('pong' in word) {
      if (this.wakeTimer !== undefined && wakeGeneration === this.wakeGeneration) {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = undefined;
        this.proven();
      }
      return true;
    }
    if ('resync' in word) {
      if (word.resync === 'desktop-gone') this.park([]);
      else this.deps.resyncHint?.(word);
      return true;
    }
    return false;
  }

  private async handle(data: unknown, wakeGeneration: number): Promise<void> {
    let sealed: unknown = data;
    if (typeof data === 'string') {
      const parsed: unknown = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && this.clearWord(parsed as Record<string, unknown>, wakeGeneration))
        return;
      if (isRelayE2EEChallenge(parsed)) {
        // A challenge after ready means the desktop leg was replaced: the session ends and the next open answers it.
        if (this.ready) {
          this.park([data]);
          return;
        }
        await this.answerChallenge(parsed);
        return;
      }
      sealed = parsed;
    } else if (this.peer) {
      this.peer.receiveRelay(data);
      return;
    }
    if (!this.channel) throw new Error('relay data before the encryption handshake');
    if (this.peer) throw new Error('relay sent a plain frame on a transport session');
    this.deliver(await this.channel.decryptJson(sealed));
  }

  private async answerChallenge(challenge: RelayE2EEChallenge): Promise<void> {
    this.challengesSeen += 1;
    if (this.reuse && this.challengesSeen === 1) this.deps.reused?.();
    this.deps.encrypting?.();
    if (this.challengesSeen > MAX_HANDSHAKE_RESTARTS + 1) throw new Error('duplicate relay encryption challenge');
    const mine = ++this.generation;
    this.channel = null;
    this.closePeer();
    this.binaryFrames = challenge.binaryFrames === 1;
    this.offerSeen = challenge.transportWebrtc === 1 && challenge.binaryFrames === 1;
    this.arm(HANDSHAKE_DEADLINE_MS);
    const optIn = this.deps.webrtc !== undefined && remoteTransportOptIn(challenge, true);
    const handshake = await createRelayE2EEClientHandshake(
      this.pairing,
      challenge,
      optIn ? { transportWebrtc: true } : {}
    );
    // A newer challenge arrived while this one was being answered.
    if (this.finished || mine !== this.generation) return;
    const channel = handshake.channel;
    this.channel = channel;
    this.mediaSid = challenge.challenge;
    if (channel.transportEnabled) this.startPeer(channel, challenge.challenge);
    this.ws.send(JSON.stringify(handshake.hello));
  }

  private startPeer(channel: RelayE2EEChannel, sessionId: string): void {
    const webrtc = this.deps.webrtc!;
    const hold = webrtc.holdSignals?.();
    const created = createRemoteTransportPeer({
      channel,
      sessionId,
      relay: { send: (bytes) => this.ws.send(bytes), bufferedAmount: () => this.ws.bufferedAmount },
      deliver: (message) => this.deliver(message),
      // Each newly authenticated record of a message still arriving is the core's progress (the peer reports it once, before
      // assembly); the relay's pong and the transport's acknowledgements never reach here.
      progress: () => {
        if (!this.finished) this.sink.progress?.();
      },
      fatal: (error) => {
        if (this.peer === created) this.fail(CLOSE_PROTOCOL_ERROR, `transport failed: ${error.message}`);
      },
      createPeer: webrtc.createPeer,
      ...(hold ? { holdSignals: hold } : {}),
      visible: webrtc.visible,
      timers,
      log: webrtc.log,
    });
    this.peer = created;
    this.state.active = created;
  }

  /** One authenticated application message, whichever lane carried it. */
  private deliver(message: unknown): void {
    if (this.finished) return;
    if (!this.ready) {
      this.confirmReady(message);
      return;
    }
    const answered = message as { id?: unknown; method?: unknown } | null;
    if (answered && answered.id !== undefined && answered.method === undefined) this.inflight.delete(answered.id);
    this.sink.frame(JSON.stringify(message));
  }

  private confirmReady(message: unknown): void {
    const hello = message as { type?: unknown; version?: unknown; transcript?: unknown } | null;
    if (hello?.type !== 'e2ee-ready' || hello.version !== 1) throw new Error('relay data before encryption was ready');
    // A transcript answers an offer; one with no offer means the relay stripped the offer.
    if (hello.transcript !== undefined && !this.offerSeen)
      throw new Error('relay encryption handshake transcript mismatch');
    const channel = this.channel!;
    channel.confirmHandshake(hello);
    this.peer?.confirm();
    this.ready = true;
    clearTimeout(this.deadline);
    this.deadline = undefined;
    const key = channel.mediaKey;
    this.deps.ready?.(hello as Record<string, unknown>, key ? { sid: this.mediaSid, key } : undefined);
    this.resolveOpen(this.writer);
  }

  // Sending.

  private sendPlain(data: string | Uint8Array): void {
    this.ws.send(data);
    this.wsDeparture.enqueue(typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength);
  }

  private send(text: string, claim?: SentClaim): void {
    // The call that wrote this request frame handed its own claim down with it; that call alone learns when the frame left.
    // "Left" is local departure: the frame handed to the carrier and the carrier's own buffer empty again (the socket's
    // `bufferedAmount`, or the peer's carrier), never the admission of the frame to a queue and never the core's answer.
    const request = JSON.parse(text) as { id?: unknown; method?: unknown } | null;
    const isRequest = request !== null && request.id !== undefined && request.method !== undefined;
    let left: (() => void) | undefined;
    let notLeft: ((error: Error) => void) | undefined;
    if (isRequest && claim) {
      const receipt = new Promise<void>((resolve, reject) => {
        left = resolve;
        notLeft = reject;
      });
      receipt.catch(() => {});
      claim(receipt);
    }
    // Sealing is asynchronous: chaining keeps wire order equal to send order.
    this.outbound = this.outbound
      .then(async () => {
        const channel = this.channel;
        if (this.finished || !channel) return notLeft?.(new Error(FRAME_NOT_SENT_MESSAGE));
        if (isRequest) this.inflight.add(request?.id);
        if (this.peer) {
          // Admission resolves here, so later frames keep their order; the departure follows on its own.
          const { departed } = await this.peer.sendDeparting(request);
          if (left) departed.then(left, notLeft);
        } else {
          const sealed = this.binaryFrames ? await channel.encryptBinary(request) : await channel.encryptJson(request);
          // The leg may have ended while the frame was sealing: it never reaches the relay, and its call is not told it left.
          if (this.finished) return notLeft?.(new Error(FRAME_NOT_SENT_MESSAGE));
          this.sendPlain(sealed);
          if (left) this.wsDeparture.since(this.wsDeparture.position()).then(left, notLeft);
        }
      })
      .catch((error: unknown) => {
        notLeft?.(error instanceof Error ? error : new Error(String(error)));
        this.fail(CLOSE_PROTOCOL_ERROR, 'frame failed');
      });
  }
}
