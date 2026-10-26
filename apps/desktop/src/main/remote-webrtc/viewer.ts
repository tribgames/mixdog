/**
 * One viewer (paired client × source) of the WebRTC live view: the transport
 * state machine of shared/remote-webrtc.ts, desktop-authoritative. It keeps
 * the JPEG relay view as the fallback that is never torn down first, moves
 * input ownership only across an epoch barrier, and never applies a channel
 * input twice or after its epoch ended.
 */
import { REMOTE_CLIENT_PENDING_FRAMES } from '../../shared/remote-frame-budget';
import {
  REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
  REMOTE_WEBRTC_VERSION,
  canRemoteWebrtcTransition,
  parseRemoteWebrtcChannelFromClient,
  readRemoteWebrtcScreenHelperEnroll,
  remoteWebrtcCertificateMatches,
  remoteWebrtcSdpFingerprints,
  type RemoteWebrtcCandidate,
  type RemoteWebrtcChannelFromClient,
  type RemoteWebrtcClientSignal,
  type RemoteWebrtcCloseReason,
  type RemoteWebrtcConnectionRef,
  type RemoteWebrtcDesktopSignal,
  type RemoteWebrtcFingerprint,
  type RemoteWebrtcGeometry,
  type RemoteWebrtcIceServer,
  type RemoteWebrtcPageInput,
  type RemoteScreenHelperGrant,
  type RemoteScreenHelperCredential,
  type RemoteWebrtcReceiverStats,
  type RemoteWebrtcScreenHelperEnrollMessage,
  type RemoteWebrtcSourceInput,
  type RemoteWebrtcSource,
  type RemoteWebrtcTransportState,
} from '../../shared/remote-webrtc';
import type { RemoteWebrtcSenderFailure } from '../../shared/remote-webrtc-sender';
import { REMOTE_BROWSER_FRAME_ACK_TIMEOUT_MS } from '../remote-browser-streams';

/** Offer to promotion: the STUN transaction timeout of RFC 5389 §7.2.1 with
 *  its defaults (RTO 500 ms, Rc 7, Rm 16 → 39.5 s), the longest a single
 *  connectivity check may take. JPEG stays on screen meanwhile. */
export const REMOTE_WEBRTC_NEGOTIATION_TIMEOUT_MS = 39_500;
/** `demote` to `demote-ack`: the relay frame ack window (remote-browser-streams.ts). */
export const REMOTE_WEBRTC_DEMOTE_ACK_TIMEOUT_MS = REMOTE_BROWSER_FRAME_ACK_TIMEOUT_MS;
/** Channel input held or queued per viewer: the per-client outstanding frame
 *  budget the relay path enforces (shared/remote-frame-budget.ts). */
const REMOTE_WEBRTC_INPUT_LIMIT = REMOTE_CLIENT_PENDING_FRAMES;

/** What main knows of the source right now. */
interface RemoteWebrtcViewerPage {
  documentId: string | null;
  geometry: RemoteWebrtcGeometry | null;
  /** Frames the sender took for this document and geometry generation. */
  framesSinceCurrent: number;
}

interface RemoteWebrtcViewerEffects {
  /** To this viewer's phone, over the E2EE relay. */
  signal(signal: RemoteWebrtcDesktopSignal): void;
  /** Sender renderer: a new peer connection for this source. */
  open(connection: { connectionId: string; iceServers: RemoteWebrtcIceServer[]; receiveCodecs: string[] }): void;
  answer(connectionId: string, sdp: string): void;
  candidate(connectionId: string, candidate: RemoteWebrtcCandidate | null): void;
  channelSend(connectionId: string, text: string): void;
  close(connectionId: string): void;
  /** The source's own input path (a page: the relay's guard, authorization and
   *  serialization); page input for a browser source, screen input for a screen. */
  dispatch(control: RemoteWebrtcSourceInput): Promise<void>;
  /** Input left the channel: release what it holds (`releases`: the mouse
   *  releases the channel still owes a page). */
  release(releases: RemoteWebrtcPageInput[]): Promise<void>;
  page(): RemoteWebrtcViewerPage;
  newConnectionId(): string;
  now(): number;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  report(event: string, data: Record<string, unknown>): void;
  receiverStats?(stats: RemoteWebrtcReceiverStats): void;
  /** The phone rendered a frame of the screen's video run `epoch`. */
  frameSeen?(epoch: number): void;
  /** The phone signed a screen's helper challenge. */
  helperGrant?(grant: RemoteScreenHelperGrant): void;
  /** The phone asks for a screen's secure-desktop helper, with its key. */
  helperInstall?(controllerKey: string): void;
  /** The phone asks for the same with its Windows password (an install or
   *  enroll carrying a `credential`): no UAC prompt on the PC. */
  helperCredential?(controllerKey: string, credential: RemoteScreenHelperCredential): void;
  /** The connection was promoted: its channel is open for desktop pushes. */
  promoted?(): void;
}

interface Connection {
  id: string;
  generation: number;
  iceServers: RemoteWebrtcIceServer[];
  offered: boolean;
  answer: RemoteWebrtcFingerprint[] | null;
}

type InputEnvelope = Extract<RemoteWebrtcChannelFromClient, { kind: 'input' | 'screen-input' }>;
type Held = { envelope: InputEnvelope; receivedAt: number };

/** Input that names a position in the picture: it needs the current, acknowledged geometry. */
const COORDINATE_INPUT: ReadonlySet<string> = new Set(['pointer', 'wheel', 'screen-pointer', 'screen-wheel']);

export function createRemoteWebrtcViewer(source: RemoteWebrtcSource, effects: RemoteWebrtcViewerEffects) {
  let state: RemoteWebrtcTransportState = 'relay';
  let generation = 0;
  let connection: Connection | null = null;
  /** The input epoch; relay owns epoch 1. */
  let epoch = 1;
  let lastSeq = 0;
  let ackedGeometry = 0;
  /** A failed attempt that never reached `webrtc` means the path does not
   *  work: no new attempt until the viewer comes back. One that did may retry. */
  let retryAllowed = true;
  let timer: unknown = null;
  let pendingReady: { receiveCodecs: string[]; iceServers: RemoteWebrtcIceServer[] } | null = null;
  let held: Held[] = [];
  let queued = 0;
  let dispatchChain: Promise<void> = Promise.resolve();
  /** Mouse buttons channel input pressed and has not released, as the release each needs. */
  const pressed = new Map<string, RemoteWebrtcPageInput>();
  let demoteReason: RemoteWebrtcCloseReason = 'protocol-error';

  const move = (to: RemoteWebrtcTransportState): void => {
    if (!canRemoteWebrtcTransition(state, to)) throw new Error(`remote webrtc: ${state} → ${to} is not a transition.`);
    effects.report('state', { from: state, to, generation, epoch });
    state = to;
  };
  const clearTimer = (): void => {
    if (timer !== null) effects.clearTimer(timer);
    timer = null;
  };
  const arm = (ms: number, run: () => void): void => {
    clearTimer();
    timer = effects.setTimer(() => {
      timer = null;
      run();
    }, ms);
  };
  const ref = (): RemoteWebrtcConnectionRef => ({
    v: REMOTE_WEBRTC_VERSION,
    source,
    connectionId: connection!.id,
    generation: connection!.generation,
  });
  /** A message of the current connection, by id and generation. */
  const current = (message: { connectionId: string; generation: number }): boolean =>
    !!connection && message.connectionId === connection.id && message.generation === connection.generation;
  const geometrySignal = (geometry: RemoteWebrtcGeometry): RemoteWebrtcDesktopSignal => ({
    v: REMOTE_WEBRTC_VERSION,
    source,
    type: 'geometry',
    geometry,
  });

  function start(receiveCodecs: string[], iceServers: RemoteWebrtcIceServer[]): void {
    if (!effects.page().geometry) {
      // The offer carries the locked geometry; it starts once there is one.
      pendingReady = { receiveCodecs, iceServers };
      return;
    }
    pendingReady = null;
    generation += 1;
    const id = effects.newConnectionId();
    // Attempted with whatever ICE servers there are, none included: direct
    // pairs need no TURN (host candidates alone connect on one LAN), and a
    // failed attempt ends in the JPEG view that is showing meanwhile.
    connection = { id, generation, iceServers, offered: false, answer: null };
    move('negotiating');
    arm(REMOTE_WEBRTC_NEGOTIATION_TIMEOUT_MS, () => fail('negotiation-timeout'));
    effects.open({ connectionId: connection.id, iceServers, receiveCodecs });
  }

  /** Back to JPEG. Before promotion nothing moved; after, input crosses a
   *  new epoch and unsent or late channel input is never applied. */
  function fail(reason: RemoteWebrtcCloseReason): void {
    if (!connection) return;
    const failed = connection;
    effects.close(failed.id);
    if (state === 'negotiating' || state === 'connected') {
      clearTimer();
      retryAllowed = reason === 'superseded';
      closeConnection(reason);
      move('cooldown');
      return;
    }
    if (state === 'promoting' || state === 'webrtc') {
      retryAllowed = state === 'webrtc' || reason === 'superseded';
      demoteReason = reason;
      handBack();
      effects.signal({ ...ref(), type: 'demote', inputEpoch: epoch, reason });
      move('demoting');
      arm(REMOTE_WEBRTC_DEMOTE_ACK_TIMEOUT_MS, () => {
        // No answer (the phone may already have dropped this connection):
        // close it so relay input is not held back for ever, and start a
        // `ready` that arrived meanwhile.
        closeConnection(reason);
        move('cooldown');
        startPending();
      });
    }
  }

  /** A held `ready` starts once the hand-back ended, when retry is welcome. */
  function startPending(): void {
    if (pendingReady && retryAllowed) start(pendingReady.receiveCodecs, pendingReady.iceServers);
  }

  /** `close` for the current connection; `retryAfterMs: 0` exactly when another
   *  attempt is welcome (never a timer of ours). */
  function closeConnection(reason: RemoteWebrtcCloseReason): void {
    effects.signal({ ...ref(), type: 'close', reason, ...(retryAllowed ? { retryAfterMs: 0 } : {}) });
    connection = null;
  }

  /** Input leaves the channel (demotion, or the viewer leaving while it owned
   *  input): a new epoch, nothing held or queued is applied, and every mouse
   *  button the channel pressed is released — the phone drops the release it
   *  still had. The one place the source's release runs. */
  function handBack(): void {
    epoch += 1;
    lastSeq = 0;
    held = [];
    // Collected in the dispatch lane, once every dispatch already running has
    // settled: a press that lands meanwhile is released too.
    dispatchChain = dispatchChain
      .then(() => {
        const releases = [...pressed.values()];
        pressed.clear();
        return effects.release(releases);
      })
      .catch(() => undefined);
  }

  /** Track what an applied channel pointer input leaves pressed (page input;
   *  a screen source tracks its own holds and releases them all). */
  function track(control: RemoteWebrtcSourceInput): void {
    if (control.type !== 'pointer' || control.button === 'none') return;
    if (control.phase === 'mousePressed') {
      pressed.set(control.button, {
        type: 'pointer',
        phase: 'mouseReleased',
        x: control.x,
        y: control.y,
        button: control.button,
        buttons: 0,
        modifiers: 0,
        clickCount: control.clickCount,
        documentId: control.documentId,
      });
    } else if (control.phase === 'mouseReleased') pressed.delete(control.button);
  }

  function ack(envelope: InputEnvelope, outcome: 'applied' | 'rejected', queuedMs = 0, dispatchMs = 0): void {
    if (!connection) return;
    effects.channelSend(
      connection.id,
      JSON.stringify({
        v: REMOTE_WEBRTC_VERSION,
        kind: 'input-ack',
        epoch: envelope.epoch,
        seq: envelope.seq,
        outcome,
        sentAt: envelope.sentAt,
        queuedMs,
        dispatchMs,
      })
    );
  }

  function enqueue({ envelope, receivedAt }: Held): void {
    if (queued >= REMOTE_WEBRTC_INPUT_LIMIT) {
      fail('protocol-error');
      return;
    }
    queued += 1;
    const inputEpoch = epoch;
    dispatchChain = dispatchChain.then(async () => {
      queued -= 1;
      // Demoted meanwhile: this epoch's input is never applied.
      if (epoch !== inputEpoch || state !== 'webrtc') {
        ack(envelope, 'rejected');
        return;
      }
      const geometry = effects.page().geometry;
      if (
        COORDINATE_INPUT.has(envelope.control.type) &&
        (!geometry || envelope.geometryGeneration !== geometry.generation || ackedGeometry !== geometry.generation)
      ) {
        ack(envelope, 'rejected');
        return;
      }
      const startedAt = effects.now();
      try {
        await effects.dispatch(envelope.control);
        track(envelope.control);
        ack(envelope, 'applied', startedAt - receivedAt, effects.now() - startedAt);
      } catch {
        ack(envelope, 'rejected', startedAt - receivedAt, effects.now() - startedAt);
      }
    });
  }

  return {
    get state(): RemoteWebrtcTransportState {
      return state;
    },
    get epoch(): number {
      return epoch;
    },
    get connectionId(): string | null {
      return connection?.id ?? null;
    },
    get generation(): number {
      return connection?.generation ?? 0;
    },
    /** A desktop → phone channel message: sent while the channel is up
     *  (promoting or webrtc), dropped otherwise. */
    push(text: string): void {
      if (connection && (state === 'promoting' || state === 'webrtc')) effects.channelSend(connection.id, text);
    },
    /** Settles once every queued channel input has been dispatched (tests, teardown). */
    settled: (): Promise<void> => dispatchChain,

    /** The phone can receive video: offer, unless a failure holds it back. */
    ready(receiveCodecs: string[], iceServers: RemoteWebrtcIceServer[]): void {
      if (state === 'closed') return;
      if (state === 'relay' || (state === 'cooldown' && retryAllowed)) {
        start(receiveCodecs, iceServers);
        return;
      }
      if (state === 'cooldown') return;
      // The phone started over: the old connection is superseded.
      pendingReady = { receiveCodecs, iceServers };
      if (state === 'negotiating' || state === 'connected') {
        fail('superseded');
        start(receiveCodecs, iceServers);
      } else if (state === 'promoting' || state === 'webrtc') {
        fail('superseded');
      }
    },

    /** The source's geometry changed or was locked: tell the phone. */
    geometryChanged(): void {
      const geometry = effects.page().geometry;
      if (state === 'closed' || !geometry) return;
      effects.signal(geometrySignal(geometry));
      if (pendingReady && (state === 'relay' || (state === 'cooldown' && retryAllowed))) {
        start(pendingReady.receiveCodecs, pendingReady.iceServers);
      }
    },

    geometryAck(geometryGeneration: number): void {
      if (effects.page().geometry?.generation === geometryGeneration) ackedGeometry = geometryGeneration;
    },

    /** A validated phone signal of a connection (`ready`/geometry ones excluded). */
    signal(message: Exclude<RemoteWebrtcClientSignal, { type: 'ready' | 'geometry-ack' | 'resize-request' }>): void {
      if (!current(message)) return;
      switch (message.type) {
        case 'answer':
          if (state !== 'negotiating' || !connection!.offered || connection!.answer) return;
          connection!.answer = message.fingerprints;
          effects.answer(connection!.id, message.sdp);
          return;
        case 'candidate':
          if (state === 'negotiating' || state === 'connected' || state === 'promoting' || state === 'webrtc') {
            effects.candidate(connection!.id, message.candidate);
          }
          return;
        case 'media-ready': {
          if (state !== 'connected') return;
          const page = effects.page();
          const geometry = page.geometry;
          if (
            !geometry ||
            message.documentId !== page.documentId ||
            message.geometryGeneration !== geometry.generation ||
            ackedGeometry !== geometry.generation ||
            message.pixelWidth !== geometry.pixelWidth ||
            message.pixelHeight !== geometry.pixelHeight ||
            page.framesSinceCurrent < 1
          ) {
            return;
          }
          epoch += 1;
          lastSeq = 0;
          move('promoting');
          effects.signal({ ...ref(), type: 'promote', inputEpoch: epoch, geometryGeneration: geometry.generation });
          // Both ends' channel is open (the phone sends media-ready only then).
          effects.promoted?.();
          return;
        }
        case 'promote-ack': {
          if (state !== 'promoting' || message.inputEpoch !== epoch) return;
          clearTimer();
          retryAllowed = true;
          move('webrtc');
          const waiting = held;
          held = [];
          for (const entry of waiting) enqueue(entry);
          return;
        }
        case 'demote-ack': {
          if (state !== 'demoting' || message.inputEpoch !== epoch) return;
          clearTimer();
          // The hand-back is complete: the connection closes, saying whether
          // another attempt is welcome.
          closeConnection(demoteReason);
          move('cooldown');
          startPending();
          return;
        }
        case 'close':
          fail(message.reason);
          return;
      }
    },

    senderOffer(connectionId: string, sdp: string): void {
      if (!connection || connection.id !== connectionId || state !== 'negotiating' || connection.offered) return;
      const geometry = effects.page().geometry;
      const fingerprints = remoteWebrtcSdpFingerprints(sdp);
      if (!fingerprints.length || !geometry) {
        fail('protocol-error');
        return;
      }
      connection.offered = true;
      effects.signal({
        ...ref(),
        type: 'offer',
        sdp,
        fingerprints,
        iceServers: connection.iceServers,
        iceTransportPolicy: REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
        geometry,
        inputEpoch: epoch,
      });
    },

    senderCandidate(connectionId: string, candidate: RemoteWebrtcCandidate | null): void {
      if (connection?.id !== connectionId || state === 'demoting' || state === 'cooldown') return;
      effects.signal({ ...ref(), type: 'candidate', candidate });
    },

    /** DTLS is up: the peer certificate must be the one the E2EE answer named. */
    senderConnected(
      connectionId: string,
      certificate: { fingerprint?: unknown; fingerprintAlgorithm?: unknown } | null
    ): void {
      if (connection?.id !== connectionId || state !== 'negotiating' || !connection.answer) return;
      if (!certificate || !remoteWebrtcCertificateMatches(connection.answer, certificate)) {
        fail('fingerprint-mismatch');
        return;
      }
      move('connected');
    },

    senderFailed(connectionId: string, reason: RemoteWebrtcSenderFailure): void {
      if (connection?.id === connectionId) fail(reason);
    },

    /** A data-channel message of this connection. */
    channel(connectionId: string, text: string, receivedAt: number): void {
      if (connection?.id !== connectionId || (state !== 'promoting' && state !== 'webrtc')) return;
      let message: RemoteWebrtcChannelFromClient | RemoteWebrtcScreenHelperEnrollMessage;
      try {
        message = parseRemoteWebrtcChannelFromClient(text);
      } catch {
        // `screen-helper-enroll` is not input: it has its own reader. Anything
        // else that did not parse ends the connection (the text is not kept:
        // it may carry a password).
        const enroll = readRemoteWebrtcScreenHelperEnroll(text);
        if (!enroll) {
          fail('protocol-error');
          return;
        }
        message = enroll;
      }
      if (message.kind === 'stats') {
        effects.receiverStats?.(message.stats);
        return;
      }
      // A screen's receipt evidence, helper grant and install or enroll
      // request: not input, so not gated by the input epoch and never acked.
      if (
        message.kind === 'screen-frame-seen' ||
        message.kind === 'screen-helper-grant' ||
        message.kind === 'screen-helper-install' ||
        message.kind === 'screen-helper-enroll'
      ) {
        if (source.kind !== 'screen') {
          fail('protocol-error');
          return;
        }
        if (message.kind === 'screen-frame-seen') effects.frameSeen?.(message.epoch);
        else if (message.kind === 'screen-helper-grant') {
          effects.helperGrant?.({ epoch: message.epoch, challenge: message.challenge, signature: message.signature });
        } else if (message.credential) {
          // The phone's Windows password: no UAC prompt on the PC. The install's
          // extra `keys` are not used: PC access enrolls the phones paired now.
          effects.helperCredential?.(message.publicKey, message.credential);
        } else effects.helperInstall?.(message.publicKey);
        return;
      }
      // Page input is a browser source's; screen input a screen's.
      if ((message.kind === 'screen-input') !== (source.kind === 'screen')) {
        fail('protocol-error');
        return;
      }
      if (message.epoch !== epoch) {
        ack(message, 'rejected');
        return;
      }
      // A repeat (or a reorder, which an ordered channel never produces).
      if (message.seq <= lastSeq) return;
      lastSeq = message.seq;
      const entry = { envelope: message, receivedAt };
      if (state === 'webrtc') {
        enqueue(entry);
        return;
      }
      // Promoting: held until the relay's promote-ack proves every earlier
      // relay input settled.
      if (held.length >= REMOTE_WEBRTC_INPUT_LIMIT) {
        fail('protocol-error');
        return;
      }
      held.push(entry);
    },

    /** A failure seen by main (sender crash, source gone). */
    fail,

    /** The viewer left: everything ends. */
    stop(): void {
      if (state === 'closed') return;
      clearTimer();
      // Leaving while the channel owned input hands it back like a demotion,
      // without one: the viewer is closed, not demoted.
      if (state === 'promoting' || state === 'webrtc') handBack();
      else {
        held = [];
        epoch += 1;
      }
      if (connection) {
        effects.close(connection.id);
        effects.signal({ ...ref(), type: 'close', reason: 'viewer-left' });
        connection = null;
      }
      pendingReady = null;
      move('closed');
    },
  };
}

export type RemoteWebrtcViewer = ReturnType<typeof createRemoteWebrtcViewer>;
