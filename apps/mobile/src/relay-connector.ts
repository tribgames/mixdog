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
import type { Connector, Target, TransportSink, TransportWriter } from '../../../packages/protocol-client/src/index.ts';
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

export interface RelayConnectorDeps {
  /** Read on every open: the pairing may have been renewed since the last one. */
  pairing(target: Target): RelayE2EEPairingMaterial;
  socketUrl(target: Target): string;
  createSocket(url: string): RelaySocket;
  /** Every socket end, before it reaches the client (pre-ready ends included), so the phone can tell a revoked pairing from a lost network. */
  closed?(code: number, reason: string): void;
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
  /** Visible again: probe both paths at once. */
  wake(): void;
}

/** Challenges a joining socket may answer again after its first one: each is one desktop leg replaced mid-handshake. */
const MAX_HANDSHAKE_RESTARTS = 2;
/** Socket opening and the E2EE handshake must each finish within these (today's deadlines). */
const OPEN_DEADLINE_MS = 12_000;
const HANDSHAKE_DEADLINE_MS = 10_000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_HANDSHAKE_TIMEOUT = 4408;

const timers = {
  setTimeout: (callback: () => void, ms: number): unknown => setTimeout(callback, ms),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createRelayConnector(deps: RelayConnectorDeps): RelayConnector {
  let active: RemoteTransportPeer | null = null;
  return {
    hidden: () => active?.hidden(),
    wake: () => active?.wake(),
    open: (target, sink) =>
      new Promise<TransportWriter>((resolve, reject) => {
        const ws = deps.createSocket(deps.socketUrl(target));
        ws.binaryType = 'arraybuffer';
        const pairing = deps.pairing(target);
        let channel: RelayE2EEChannel | null = null;
        let binaryFrames = false;
        let peer: RemoteTransportPeer | null = null;
        // The current challenge offered the transport: a transcript in `e2ee-ready` is then expected, and without the offer forbidden.
        let offerSeen = false;
        let ready = false;
        let finished = false;
        let challengesSeen = 0;
        let generation = 0;
        let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(
          () => fail(CLOSE_HANDSHAKE_TIMEOUT, 'relay connection timed out'),
          OPEN_DEADLINE_MS
        );
        const arm = (ms: number): void => {
          clearTimeout(deadline);
          deadline = setTimeout(() => fail(CLOSE_HANDSHAKE_TIMEOUT, 'relay handshake timed out'), ms);
        };
        // Ends this attempt exactly once: before ready it rejects the open, after ready it is the sink's one `closed`.
        const finish = (code: number, reason: string): void => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          deadline = undefined;
          closePeer();
          deps.closed?.(code, reason);
          if (ready) sink.closed(code, reason);
          else reject(new Error(`relay socket closed before ready (${code}${reason ? ` ${reason}` : ''})`));
        };
        // A new handshake or the end of the socket ends the transport stream with it.
        const closePeer = (): void => {
          peer?.close();
          if (active === peer) active = null;
          peer = null;
        };
        const fail = (code: number, reason: string): void => {
          if (finished) return;
          try {
            ws.close(code, reason);
          } catch {
            // the socket is already gone; finish() below still ends the attempt
          }
          finish(code, reason);
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
            resolve(writer);
            return;
          }
          sink.frame(JSON.stringify(message));
        };
        const handle = async (data: unknown): Promise<void> => {
          let sealed: unknown = data;
          if (typeof data === 'string') {
            const parsed: unknown = JSON.parse(data);
            if (isRelayE2EEChallenge(parsed)) {
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
          // A challenge after ready means the desktop leg was replaced: the session ended with it and the ladder redials.
          if (ready) throw new Error('desktop leg replaced');
          challengesSeen += 1;
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
          send: (text) => {
            // Sealing is asynchronous: chaining keeps wire order equal to send order.
            outbound = outbound
              .then(async () => {
                if (finished || !channel) return;
                const value: unknown = JSON.parse(text);
                if (peer) {
                  await peer.send(value);
                  return;
                }
                ws.send(binaryFrames ? await channel.encryptBinary(value) : await channel.encryptJson(value));
              })
              .catch(() => fail(CLOSE_PROTOCOL_ERROR, 'frame failed'));
          },
          close: (code, reason) => fail(code, reason),
        };

        ws.onmessage = (event) => {
          inbound = inbound.then(() => (finished ? undefined : handle(event.data))).catch(() => fail(CLOSE_PROTOCOL_ERROR, 'frame failed'));
        };
        ws.onclose = (event) => finish(event.code, event.reason);
        ws.onerror = () => {};
        ws.onopen = () => arm(HANDSHAKE_DEADLINE_MS);
      }),
  };
}
