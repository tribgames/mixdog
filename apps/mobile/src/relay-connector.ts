// The phone's `Connector` for packages/protocol-client over the relay.
//
// The relay forwards opaque E2EE envelopes to the desktop's relay leg, which
// decrypts and bridges each frame byte-for-byte to the core (lifecycle-remote
// §9). This module owns only the phone half: answer the leg's challenge, wait
// for its authenticated `e2ee-ready`, then carry one JSON-RPC message per
// sealed frame. Reconnects, resume positions and op reconciliation belong to
// the client library; a closed socket is reported once through the sink.
//
// When the desktop offers the MXT transport (challenge `transportWebrtc` +
// `binaryFrames`) and the page can run WebRTC, the session upgrades exactly as
// before: the stream core in `remote-transport-peer` carries every message over
// the relay lane and, once negotiated, the direct data-channel carrier. The
// desktop side of that negotiation is the core's carrier (SPEC §4.7); this side
// is unchanged on the wire (DS-REM-9).
import type { Connector, Target, TransportWriter } from '../../../packages/protocol-client/src/index.ts';
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
  type RemoteTransportPeer,
} from '../../desktop/src/renderer/remote-transport-peer.ts';

/** The browser WebSocket surface this connector uses. */
export interface RelaySocket {
  binaryType: string;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** How a socket ended: `ready` it had finished the handshake; `remote` the network or the relay ended it (this page did not);
 *  `quiet` this page recycled it on purpose (keepalive, wake probe, background), so no outage should be shown. */
export interface CloseInfo {
  readonly ready: boolean;
  readonly remote: boolean;
  readonly quiet: boolean;
}

export interface RelayConnectorDeps {
  /** Read on every open: the pairing may have been renewed since the last one. */
  pairing(target: Target): RelayE2EEPairingMaterial;
  socketUrl(target: Target): string;
  createSocket(url: string): RelaySocket;
  /** Every socket end, before it reaches the client (pre-ready ends included), so the phone can tell a revoked pairing from a lost network. */
  closed?(code: number, reason: string, info: CloseInfo): void;
  /** The desktop's authenticated `e2ee-ready` (host name, open access, routing caps), once per ready session. */
  ready?(hello: Readonly<Record<string, unknown>>): void;
  /** Whether the page is visible; the keepalive does not run while it is not. */
  visible?(): boolean;
  /** A dial (or the takeover of a parked socket) is starting. */
  dialing?(): void;
  /** A parked socket is being re-keyed for the desktop's return. */
  reused?(): void;
  /** The connection entered a stage: the socket is open and the encryption handshake runs (a new challenge restarts it). */
  encrypting?(): void;
  /** The page gives up on a socket that stopped answering (keepalive or wake probe), just before it closes it. */
  unresponsive?(): void;
  /** The relay answered a wake probe (its pong, or traffic that proves the leg live): the page's wake recovery may go on. */
  probeAnswered?(): void;
  /** The relay's cleartext resync hint (any resync but desktop-gone). */
  resyncHint?(): void;
  /** Present only where `RTCPeerConnection` exists: its absence is the transport opt-out. */
  webrtc?: {
    createPeer(configuration: RTCConfiguration): RTCPeerConnection;
    visible(): boolean;
    log(line: string): void;
  };
}

/** The page lifecycle hooks of the active transport session; no-ops when there is none. */
export interface RelayConnector extends Connector {
  /** The page went hidden: no transport timer runs until `wake`. */
  hidden(): void;
  /** Visible again: release a suspension and probe the live socket (and both transport paths) at once. True when a socket was probed. */
  wake(): boolean;
  /** Nothing has arrived on the live socket since `since`, and no probe is out: a call sent then is worth a probe (Node: remote-shim-calls.ts:264-267). */
  silentSince(since: number): boolean;
  /** The page stayed in the background: end the socket with 1000 `background` once what was handed to it is sent, and hold every open until `wake`. */
  suspend(): void;
  readonly suspended: boolean;
  /** The socket is alive but unusable (a view sync that keeps failing): close it without a status; the redial that follows is the ordinary, visible one. */
  retire(): void;
}

/** Challenges a joining socket may answer again after its first one: each is one desktop leg replaced mid-handshake. */
const MAX_HANDSHAKE_RESTARTS = 2;
/** Socket opening and the E2EE handshake must each finish within these (today's deadlines). */
const OPEN_DEADLINE_MS = 12_000;
const HANDSHAKE_DEADLINE_MS = 10_000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_HANDSHAKE_TIMEOUT = 4408;
const CLOSE_NORMAL = 1000;
/** The logical end of a session whose desktop leg went away while the relay kept the socket. */
const CLOSE_DESKTOP_LEG_GONE = 1012;
/** Keepalive: the relay answers a cleartext `{"ping":1}` with `{"pong":1}`; a socket silent this long is probed, and one
 *  whose probe stays unanswered is recycled. */
const KEEPALIVE_TICK_MS = 5_000;
const SILENCE_BEFORE_PING_MS = 25_000;
const PONG_DEADLINE_MS = 10_000;
/** A foreground wake probes at once; frames still arriving this long after the probe prove a live leg, earlier ones may be a frozen page's backlog. */
const WAKE_PROBE_MS = 2_500;
const WAKE_TRAFFIC_PROOF_MS = 1_000;
const PING = '{"ping":1}';

const timers = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createRelayConnector(deps: RelayConnectorDeps): RelayConnector {
  let active: RemoteTransportPeer | null = null;
  // The session that owns the socket now: the page lifecycle hooks act on it.
  let current: Session | null = null;
  // A socket whose desktop leg went away while the relay kept it: the relay re-challenges it when the desktop returns, so the
  // next open takes it over instead of dialing again. Frames that arrive meanwhile (the new challenge) wait here.
  let parked: { readonly ws: RelaySocket; readonly inbox: unknown[] } | null = null;
  let suspended = false;
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;

  interface Session {
    probe(): void;
    silentSince(since: number): boolean;
    unprove(): void;
    recycle(code: number, reason: string): void;
    retire(): void;
    suspend(): void;
  }

  const hold = (): Promise<void> => {
    held ??= new Promise<void>((resolve) => {
      release = resolve;
    });
    return held;
  };

  const connector: RelayConnector = {
    hidden: () => {
      active?.hidden();
      current?.unprove();
    },
    wake: () => {
      if (suspended) {
        suspended = false;
        const resume = release;
        release = null;
        held = null;
        resume?.();
        return false;
      }
      const probing = current !== null;
      current?.probe();
      active?.wake();
      return probing;
    },
    retire: () => current?.retire(),
    silentSince: (since) => current?.silentSince(since) ?? false,
    suspend: () => {
      suspended = true;
      hold();
      current?.suspend();
    },
    get suspended() {
      return suspended;
    },
    open: async (target, sink) => {
      while (suspended) await hold();
      deps.dialing?.();
      return new Promise<TransportWriter>((resolve, reject) => {
        const reuse = parked;
        parked = null;
        const ws = reuse?.ws ?? deps.createSocket(deps.socketUrl(target));
        ws.binaryType = 'arraybuffer';
        const pairing = deps.pairing(target);
        let channel: RelayE2EEChannel | null = null;
        let binaryFrames = false;
        let peer: RemoteTransportPeer | null = null;
        // The current challenge offered the transport: a transcript in `e2ee-ready` is then expected, and without the offer forbidden.
        let offerSeen = false;
        let ready = false;
        let finished = false;
        let quiet = false;
        // Hidden or probed since it last proved itself: its death is the cost of the background, not an outage.
        let unproven = false;
        // Requests sent and not yet answered: a keepalive recycle is invisible only while nothing waits on the socket.
        const inflight = new Set<unknown>();
        let challengesSeen = 0;
        let generation = 0;
        let lastTrafficAt = Date.now();
        let pingSentAt = 0;
        let awaitingPong = false;
        let wakeTimer: ReturnType<typeof setTimeout> | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(
          () => fail(CLOSE_HANDSHAKE_TIMEOUT, 'relay connection timed out'),
          reuse ? HANDSHAKE_DEADLINE_MS : OPEN_DEADLINE_MS
        );
        const arm = (ms: number): void => {
          clearTimeout(deadline);
          deadline = setTimeout(() => fail(CLOSE_HANDSHAKE_TIMEOUT, 'relay handshake timed out'), ms);
        };
        const stopTimers = (): void => {
          clearTimeout(deadline);
          deadline = undefined;
          clearTimeout(wakeTimer);
          wakeTimer = undefined;
          clearInterval(keepalive);
          if (current === session) current = null;
        };
        // Ends this attempt exactly once: before ready it rejects the open, after ready it is the sink's one `closed`.
        const finish = (code: number, reason: string, remote: boolean): void => {
          if (finished) return;
          finished = true;
          stopTimers();
          closePeer();
          if (unproven) quiet = true;
          deps.closed?.(code, reason, { ready, remote, quiet });
          if (ready) sink.closed(code, reason);
          else reject(new Error(`relay socket closed before ready (${code}${reason ? ` ${reason}` : ''})`));
        };
        // A new handshake or the end of the socket ends the transport stream with it.
        const closePeer = (): void => {
          peer?.close();
          if (active === peer) active = null;
          peer = null;
        };
        // are: close without a status, as the page's own recycles always did (the relay then reads 1005).
        const fail = (code: number, reason: string, bare = false): void => {
          if (finished) return;
          try {
            if (bare) ws.close();
            else ws.close(code, reason);
          } catch {
            // the socket is already gone; finish() below still ends the attempt
          }
          finish(code, reason, false);
        };
        // The desktop leg behind this ready session is gone but the relay kept the socket: the session ends (its calls fail
        // as for any lost connection) and the socket waits for the desktop's next challenge.
        const park = (waiting: unknown[]): void => {
          if (finished || !ready) return;
          finished = true;
          quiet = waiting.length > 0;
          stopTimers();
          closePeer();
          const mine = { ws, inbox: [...waiting] };
          parked = mine;
          ws.onmessage = (event) => {
            if (typeof event.data === 'string') mine.inbox.push(event.data);
          };
          ws.onclose = (event) => {
            if (parked === mine) parked = null;
            deps.closed?.(event.code, event.reason, { ready: false, remote: true, quiet: false });
          };
          const reason = quiet ? 'desktop leg replaced' : 'desktop leg gone';
          deps.closed?.(CLOSE_DESKTOP_LEG_GONE, reason, { ready: true, remote: false, quiet });
          sink.closed(CLOSE_DESKTOP_LEG_GONE, reason);
        };
        const recycle = (code: number, reason: string): void => {
          if (inflight.size === 0) quiet = true;
          fail(code, reason, true);
        };

        let inbound: Promise<void> = Promise.resolve();
        // One authenticated application message, whichever lane carried it.
        const deliver = (message: unknown): void => {
          if (finished) return;
          if (!ready) {
            const hello = message as { type?: unknown; version?: unknown; transcript?: unknown } | null;
            if (hello?.type !== 'e2ee-ready' || hello.version !== 1) throw new Error('relay data before encryption was ready');
            // A transcript answers an offer; one with no offer means the relay stripped the offer.
            if (hello.transcript !== undefined && !offerSeen) throw new Error('relay encryption handshake transcript mismatch');
            channel!.confirmHandshake(hello);
            peer?.confirm();
            ready = true;
            clearTimeout(deadline);
            deadline = undefined;
            deps.ready?.(hello as Record<string, unknown>);
            resolve(writer);
            return;
          }
          const answered = message as { id?: unknown; method?: unknown } | null;
          if (answered && answered.id !== undefined && answered.method === undefined) inflight.delete(answered.id);
          sink.frame(JSON.stringify(message));
        };
        // The relay's own cleartext words: a pong answers a probe, `resync: desktop-gone` says the desktop leg left.
        const clearWord = (word: Record<string, unknown>): boolean => {
          awaitingPong = false;
          if ('pong' in word) {
            if (wakeTimer !== undefined) {
              clearTimeout(wakeTimer);
              wakeTimer = undefined;
              proven();
            }
            return true;
          }
          if ('resync' in word) {
            if (word.resync === 'desktop-gone') park([]);
            else deps.resyncHint?.();
            return true;
          }
          return false;
        };
        // The leg answered a wake probe: it is live again.
        const proven = (): void => {
          unproven = false;
          deps.probeAnswered?.();
        };
        const handle = async (data: unknown): Promise<void> => {
          let sealed: unknown = data;
          if (typeof data === 'string') {
            const parsed: unknown = JSON.parse(data);
            if (parsed && typeof parsed === 'object' && clearWord(parsed as Record<string, unknown>)) return;
            if (isRelayE2EEChallenge(parsed)) {
              // A challenge after ready means the desktop leg was replaced: the session ends and the next open answers it.
              if (ready) {
                park([data]);
                return;
              }
              await answerChallenge(parsed);
              return;
            }
            sealed = parsed;
          } else if (peer) {
            peer.receiveRelay(data);
            return;
          }
          if (!channel) throw new Error('relay data before the encryption handshake');
          if (peer) throw new Error('relay sent a plain frame on a transport session');
          deliver(await channel.decryptJson(sealed));
        };
        const answerChallenge = async (challenge: RelayE2EEChallenge): Promise<void> => {
          challengesSeen += 1;
          if (reuse && challengesSeen === 1) deps.reused?.();
          deps.encrypting?.();
          if (challengesSeen > MAX_HANDSHAKE_RESTARTS + 1) throw new Error('duplicate relay encryption challenge');
          const mine = ++generation;
          channel = null;
          closePeer();
          binaryFrames = challenge.binaryFrames === 1;
          offerSeen = challenge.transportWebrtc === 1 && challenge.binaryFrames === 1;
          arm(HANDSHAKE_DEADLINE_MS);
          const optIn = deps.webrtc !== undefined && remoteTransportOptIn(challenge, true);
          const handshake = await createRelayE2EEClientHandshake(pairing, challenge, optIn ? { transportWebrtc: true } : {});
          // A newer challenge arrived while this one was being answered.
          if (finished || mine !== generation) return;
          channel = handshake.channel;
          if (channel.transportEnabled) {
            const webrtc = deps.webrtc!;
            const created = createRemoteTransportPeer({
              channel,
              sessionId: challenge.challenge,
              relay: { send: (bytes) => ws.send(bytes), bufferedAmount: () => ws.bufferedAmount },
              deliver,
              fatal: (error) => {
                if (peer === created) fail(CLOSE_PROTOCOL_ERROR, `transport failed: ${error.message}`);
              },
              createPeer: webrtc.createPeer,
              visible: webrtc.visible,
              timers,
              log: webrtc.log,
            });
            peer = created;
            active = created;
          }
          ws.send(JSON.stringify(handshake.hello));
        };

        let outbound: Promise<void> = Promise.resolve();
        const writer: TransportWriter = {
          send: (text, claim) => {
            // The call that wrote this request frame handed its own claim down with it; that call alone learns when the frame left
            // (Node: its sendApplicationFrame settling, remote-shim-calls.ts:258-273). A frame no call claimed has no one to tell.
            const request = JSON.parse(text) as { id?: unknown; method?: unknown } | null;
            const isRequest = request !== null && request.id !== undefined && request.method !== undefined;
            let left: (() => void) | undefined;
            if (isRequest && claim) claim(new Promise<void>((resolve) => (left = resolve)));
            // Sealing is asynchronous: chaining keeps wire order equal to send order.
            outbound = outbound
              .then(async () => {
                if (finished || !channel) return;
                if (isRequest) inflight.add(request?.id);
                if (peer) await peer.send(request);
                else {
                  const sealed = binaryFrames ? await channel.encryptBinary(request) : await channel.encryptJson(request);
                  // The leg may have ended while the frame was sealing: it never reaches the relay, and its call is not told it left.
                  if (finished) return;
                  ws.send(sealed);
                }
                if (finished) return;
                left?.();
              })
              .catch(() => fail(CLOSE_PROTOCOL_ERROR, 'frame failed'));
          },
          close: (code, reason) => fail(code, reason),
        };

        const sendPing = (): void => {
          try {
            ws.send(PING);
          } catch {
            // surfaces as a close
          }
        };
        // A socket silent for a while is probed; one whose probe stays unanswered is half dead and is recycled.
        const keepalive = setInterval(() => {
          if (finished || !(deps.visible?.() ?? true)) {
            awaitingPong = false;
            return;
          }
          const now = Date.now();
          if (awaitingPong) {
            if (now - pingSentAt >= PONG_DEADLINE_MS) {
              awaitingPong = false;
              deps.unresponsive?.();
              recycle(CLOSE_NORMAL, 'keepalive timed out');
            }
            return;
          }
          if (now - Math.max(lastTrafficAt, pingSentAt) >= SILENCE_BEFORE_PING_MS) {
            pingSentAt = now;
            awaitingPong = true;
            sendPing();
          }
        }, KEEPALIVE_TICK_MS);
        const session: Session = {
          unprove: () => {
            if (!finished) unproven = true;
          },
          probe: () => {
            if (finished) return;
            unproven = true;
            pingSentAt = Date.now();
            awaitingPong = true;
            sendPing();
            clearTimeout(wakeTimer);
            const sentAt = pingSentAt;
            wakeTimer = setTimeout(() => {
              wakeTimer = undefined;
              // A leg still delivering a backlog queues the pong behind it.
              if (lastTrafficAt - sentAt >= WAKE_TRAFFIC_PROOF_MS) {
                proven();
                return;
              }
              awaitingPong = false;
              deps.unresponsive?.();
              recycle(CLOSE_NORMAL, 'wake probe unanswered');
            }, WAKE_PROBE_MS);
          },
          silentSince: (since) => wakeTimer === undefined && lastTrafficAt < since,
          recycle,
          retire: () => fail(CLOSE_NORMAL, 'view sync failed', true),
          // What was handed to the socket (the background report) leaves first, then the transport says it is suspended.
          suspend: () => {
            quiet = true;
            outbound = outbound
              .then(() => peer?.suspend())
              .catch(() => undefined)
              .finally(() => fail(CLOSE_NORMAL, 'background'));
          },
        };
        current = session;

        ws.onmessage = (event) => {
          lastTrafficAt = Date.now();
          inbound = inbound.then(() => (finished ? undefined : handle(event.data))).catch(() => fail(CLOSE_PROTOCOL_ERROR, 'frame failed', true));
        };
        ws.onclose = (event) => finish(event.code, event.reason, true);
        ws.onerror = () => {};
        ws.onopen = () => {
          arm(HANDSHAKE_DEADLINE_MS);
          deps.encrypting?.();
        };
        if (reuse) for (const data of reuse.inbox) ws.onmessage({ data });
      });
    },
  };
  return connector;
}
