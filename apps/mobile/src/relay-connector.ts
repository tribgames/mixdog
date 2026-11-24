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
// `binaryFrames`) and the page can run WebRTC, the session upgrades: the stream
// core in `remote-transport-peer` carries every message over the relay lane and,
// once negotiated, the direct data-channel carrier (the desktop side of that
// negotiation is the core's carrier, SPEC §4.7).
import type { Connector, Target, TransportWriter } from '../../../packages/protocol-client/src/index.ts';
import type { RelayE2EEPairingMaterial } from '../../desktop/src/shared/remote-e2ee.ts';
import { CLOSE_NORMAL, RelaySession, closeParked, type ConnectorState } from './relay-session.ts';

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
  ready?(hello: Readonly<Record<string, unknown>>, media?: { sid: string; key: CryptoKey }): void;
  /** Whether the page is visible; the keepalive does not run while it is not. */
  visible?(): boolean;
  /** The attempt's end: aborted, nothing is dialed, held or kept open for it. */
  readonly signal?: AbortSignal;
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
  resyncHint?(word: Readonly<Record<string, unknown>>): void;
  /** Present only where `RTCPeerConnection` exists: its absence is the transport opt-out. */
  webrtc?: {
    createPeer(configuration: RTCConfiguration): RTCPeerConnection;
    /** The first peer of a page load: settles when the page can afford the direct path's first `RTCPeerConnection`, and the PC's
     *  offer waits for it. Undefined for every later peer (a reconnect), which is never held. */
    holdSignals?(): Promise<unknown> | undefined;
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
  /** Nothing has arrived on the live socket since `since`, and no probe is out: a call sent then is worth a probe. */
  silentSince(since: number): boolean;
  /** The page stayed in the background: end the socket with 1000 `background` once what was handed to it is sent, and hold every open until `wake`. */
  suspend(): void;
  readonly suspended: boolean;
  /** The socket is alive but unusable (a view sync that keeps failing): close it without a status; the redial that follows is the ordinary, visible one. */
  retire(): void;
}

export function createRelayConnector(deps: RelayConnectorDeps): RelayConnector {
  const state: ConnectorState = { active: null, current: null, parked: null };
  let suspended = false;
  let release: (() => void) | null = null;
  let held: Promise<void> | null = null;

  const away = (): boolean => suspended || (deps.visible ? !deps.visible() : false);
  deps.signal?.addEventListener('abort', () => {
    release?.();
    // The abort ends every socket the connector still owns, a parked one (no session, no listener of its own) included.
    closeParked(state);
  });
  const hold = (): Promise<void> => {
    held ??= new Promise<void>((resolve) => {
      release = resolve;
    });
    return held;
  };

  return {
    hidden: () => {
      state.active?.hidden();
      state.current?.unprove();
    },
    wake: () => {
      if (suspended || held) {
        suspended = false;
        const resume = release;
        release = null;
        held = null;
        resume?.();
        return false;
      }
      const probing = state.current?.probe() ?? false;
      state.active?.wake();
      return probing;
    },
    retire: () => state.current?.retire(),
    silentSince: (since) => state.current?.silentSince(since) ?? false,
    suspend: () => {
      suspended = true;
      hold();
      state.current?.suspend();
      // A socket parked on `desktop-gone` has no session; the background ends it too.
      closeParked(state, CLOSE_NORMAL, 'background');
    },
    get suspended() {
      return suspended;
    },
    open: async (target, sink) => {
      // No socket while the page is hidden or suspended; the wake that brings it back (or an abort) ends the hold.
      while (away() && !deps.signal?.aborted) await hold();
      if (deps.signal?.aborted) throw new Error('aborted');
      deps.dialing?.();
      return new Promise<TransportWriter>((resolve, reject) => {
        const reuse = state.parked;
        state.parked = null;
        const ws = reuse?.ws ?? deps.createSocket(deps.socketUrl(target));
        ws.binaryType = 'arraybuffer';
        new RelaySession({ state, deps, ws, pairing: deps.pairing(target), reuse, sink, resolve, reject });
      });
    },
  };
}
