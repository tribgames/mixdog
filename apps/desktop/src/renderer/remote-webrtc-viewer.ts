// The phone's side of one live-view viewer (paired client × source) over
// WebRTC (shared/remote-webrtc.ts, docs/remote-webrtc.md). The desktop is
// authoritative: it offers, promotes and demotes; this side answers, proves
// the connection (DTLS fingerprint, a decoded frame of the current document
// and geometry), routes page input to exactly one owner per epoch, and drops
// back to the JPEG relay view without duplicating or replaying input.
import {
  REMOTE_WEBRTC_INPUT_CHANNEL,
  REMOTE_WEBRTC_VERSION,
  isRemoteWebrtcPageInput,
  readRemoteWebrtcChannelFromDesktop,
  encodeRemoteWebrtcScreenHelperGrant,
  encodeRemoteWebrtcScreenHelperEnroll,
  encodeRemoteWebrtcScreenHelperInstall,
  readRemoteWebrtcScreenCursor,
  readRemoteWebrtcScreenHelperChallenge,
  readRemoteWebrtcScreenStatus,
  readRemoteWebrtcScreenVideo,
  remoteWebrtcCandidatePath,
  remoteWebrtcCertificateMatches,
  remoteWebrtcSdpFingerprints,
  remoteWebrtcSourceKey,
  type RemoteWebrtcChannelFromClient,
  type RemoteWebrtcClientSignal,
  type RemoteWebrtcCloseReason,
  type RemoteWebrtcConnectionRef,
  type RemoteWebrtcDesktopSignal,
  type RemoteWebrtcFingerprint,
  type RemoteWebrtcGeometry,
  type RemoteScreenStatus,
  type RemoteWebrtcResize,
  type RemoteWebrtcSource,
  type RemoteWebrtcSourceInput,
  type RemoteWebrtcTransportState,
  type RemoteWebrtcVideoLimit,
} from '../shared/remote-webrtc';
import { browserTypingInput } from '../shared/browser-input-policy';
import { addIceCandidate, iceCandidateSignal } from './remote-ice-candidate';
import type { ScreenHelperClientMessage } from './remote-screen-helper';
import { readRemoteWebrtcReceiverStats, remoteWebrtcPeerCertificate } from './remote-webrtc-stats';
import { remoteVideoBelowLimit, remoteVideoLimit } from './remote-view-zoom';

/** Who carries page input now. `held`: the channel failed while it owned
 *  input and the desktop has not demoted yet; input is refused, not queued. */
export type RemoteWebrtcInputOwner = 'relay' | 'channel' | 'held';

/** One frame the video element presented (requestVideoFrameCallback metadata). */
export interface RemoteWebrtcPresentedFrame {
  width: number;
  height: number;
  /** Remote capture time in this clock, when the sender's RTP carries it. */
  captureTime?: number;
  expectedDisplayTime?: number;
  /** When the frame's last packet arrived, in this clock; absent where the
   *  browser does not report it (no screen receipt is sent then). */
  receiveTime?: number;
}

export const REMOTE_WEBRTC_SWITCHING_MESSAGE = 'Remote Browser Use connection is switching; input was not sent.';
export const REMOTE_WEBRTC_REJECTED_MESSAGE = 'Remote Browser Use did not apply the typed input.';

type Timers = {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export interface RemoteWebrtcViewerOptions {
  source: RemoteWebrtcSource;
  /** A relay call (`browserRemoteWebrtcSignal`). */
  signal(signal: RemoteWebrtcClientSignal): Promise<void>;
  /** The relay input queue's fence: `work` goes out after every relay input
   *  sent before it has been answered; relay input after it waits for it. */
  fence(work: () => Promise<void>): Promise<void>;
  createPeer(configuration: RTCConfiguration): RTCPeerConnection;
  receiveCodecs(): string[];
  /** The document the newest relay frame names; '' before one. */
  documentId(): string;
  /** Drop coalesced and held input (a demotion: never move it to the relay). */
  dropInput(): void;
  /** State, owner, geometry or the presented size changed. */
  changed(): void;
  stream(stream: MediaStream | null): void;
  /** A screen source's `screen-status` push (a screen source only). */
  screenStatus?(status: RemoteScreenStatus): void;
  /** A screen source's PC cursor, in video pixels of the current geometry
   *  (a `screen-cursor` of any other generation never arrives here). */
  screenCursor?(cursor: { x: number; y: number }): void;
  /** A screen source's secure-desktop helper challenge, to sign for its run. */
  screenHelperChallenge?(challenge: { epoch: number; nonce: string; challenge: string }): void;
  /** The host acknowledged a screen key, combo or text as `rejected`. */
  screenInputRejected?(): void;
  /** The desktop session behind the current connection ended (stop, hide,
   *  reconnect, retry, fallback): anything it reported is void, even under
   *  an unchanged geometry generation. */
  sessionEnded?(): void;
  failure(message: string): void;
  /** Receiver stats cadence: the stream renewal's. */
  statsIntervalMs: number;
  log(line: string): void;
  now?(): number;
  timers?: Timers;
}

interface Attempt {
  connectionId: string;
  generation: number;
  fingerprints: RemoteWebrtcFingerprint[];
  peer: RTCPeerConnection;
  channel: RTCDataChannel | null;
  remoteSet: boolean;
  candidates: Array<RTCIceCandidateInit | null>;
  verified: boolean;
  mediaReadyKey: string;
  mediaReadyAt: number;
  closed: boolean;
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
};

const mean = (values: number[]): number | undefined =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

type ReceiverStats = NonNullable<ReturnType<typeof readRemoteWebrtcReceiverStats>>;

const receiverStatsLine = (stats: ReceiverStats): string => {
  const pair = stats.candidatePair;
  return (
    `[mixdog-remote-webrtc] connection=${stats.connectionId} generation=${stats.generation}` +
    ` codec=${stats.codec ?? '?'} decoder=${stats.decoderImplementation ?? '?'}` +
    ` decoded=${stats.frameWidth ?? '?'}x${stats.frameHeight ?? '?'}` +
    ` frames=${stats.framesDecoded}/${stats.framesReceived} dropped=${stats.framesDropped}` +
    ` jitterBufferMs=${stats.jitterBufferDelayMs?.toFixed(1) ?? '?'} freezes=${stats.freezeCount ?? '?'}` +
    ` path=${pair ? remoteWebrtcCandidatePath(pair) : '?'}` +
    ` pair=${pair ? `${pair.localType}/${pair.remoteType}/${pair.protocol}` : '?'}` +
    ` pairRttMs=${pair?.currentRoundTripTimeMs?.toFixed(1) ?? '?'}` +
    ` inputRttMs=${stats.inputRoundTripMs?.toFixed(1) ?? '-'} inputVisibleMs=${stats.inputToVisibleMs?.toFixed(1) ?? '-'}`
  );
};

/** The channel text of a helper message, or null when it is malformed (not a
 *  controller key, not a canonical grant, an over-long password or account
 *  name): such a message is never sent. */
const encodeHelperMessage = (message: ScreenHelperClientMessage): string | null => {
  try {
    if (message.kind === 'screen-helper-install') {
      return encodeRemoteWebrtcScreenHelperInstall(message.publicKey, { credential: message.credential });
    }
    if (message.kind === 'screen-helper-enroll') {
      return encodeRemoteWebrtcScreenHelperEnroll(message.publicKey, { credential: message.credential });
    }
    return encodeRemoteWebrtcScreenHelperGrant(message);
  } catch {
    return null;
  }
};

/** Channel input in flight and the latencies measured from it: the round trip
 *  to the desktop's ack, and from the input to a frame showing its effect. */
const createInputLedger = () => {
  /** Channel input sent and not yet acknowledged: seq → its kind. */
  const unacked = new Map<number, string>();
  let roundTrips: number[] = [];
  /** Applied input waiting for a frame captured after it was dispatched. */
  let awaitingVisible: Array<{ sentAt: number; dispatchedAt: number }> = [];
  let visibleSamples: number[] = [];
  return {
    sent(seq: number, kind: string): void {
      unacked.set(seq, kind);
    },
    clearUnacked(): void {
      unacked.clear();
    },
    clearAwaiting(): void {
      awaitingVisible = [];
    },
    /** Settles the input an ack answers: its kind and whether the desktop
     *  rejected it, or null for an ack of nothing in flight. */
    acknowledge(
      ack: { seq: number; sentAt: number; outcome: string; queuedMs: number; dispatchMs: number },
      clock: () => number
    ): { kind: string; rejected: boolean } | null {
      const kind = unacked.get(ack.seq);
      if (kind === undefined) return null;
      unacked.delete(ack.seq);
      const receivedAt = clock();
      const roundTrip = receivedAt - ack.sentAt;
      roundTrips.push(roundTrip);
      if (ack.outcome === 'rejected') return { kind, rejected: true };
      // The desktop finished dispatching about one return trip before the ack
      // arrived: half the round trip the desktop did not spend.
      const returnTrip = Math.max(0, roundTrip - ack.queuedMs - ack.dispatchMs) / 2;
      awaitingVisible.push({ sentAt: ack.sentAt, dispatchedAt: receivedAt - returnTrip });
      return { kind, rejected: false };
    },
    /** A frame captured at `captured` shows every input dispatched before it. */
    shown(captured: number | undefined, shownAt: () => number): void {
      if (captured === undefined || !awaitingVisible.length) return;
      const at = shownAt();
      awaitingVisible = awaitingVisible.filter((input) => {
        if (input.dispatchedAt > captured) return true;
        visibleSamples.push(at - input.sentAt);
        return false;
      });
    },
    means: () => ({ inputRoundTripMs: mean(roundTrips), inputToVisibleMs: mean(visibleSamples) }),
    resetSamples(): void {
      roundTrips = [];
      visibleSamples = [];
    },
  };
};

const newAttempt = (
  offer: Extract<RemoteWebrtcDesktopSignal, { type: 'offer' }>,
  peer: RTCPeerConnection
): Attempt => ({
  connectionId: offer.connectionId,
  generation: offer.generation,
  fingerprints: offer.fingerprints,
  peer,
  channel: null,
  remoteSet: false,
  candidates: [],
  verified: false,
  mediaReadyKey: '',
  mediaReadyAt: 0,
  closed: false,
});

export function createRemoteWebrtcViewer(options: RemoteWebrtcViewerOptions) {
  const now = options.now ?? (() => performance.now());
  const timers = options.timers ?? defaultTimers;
  const sourceKey = remoteWebrtcSourceKey(options.source);
  let state: RemoteWebrtcTransportState = 'relay';
  let owner: RemoteWebrtcInputOwner = 'relay';
  /** The newest acknowledged geometry. */
  let geometry: RemoteWebrtcGeometry | null = null;
  let presented: { width: number; height: number } | null = null;
  /** The screen video run the desktop announced last, when (in this clock) its
   *  announcement arrived, and whether its receipt went out. */
  let videoRun: { epoch: number; arrivedAt: number; seen: boolean } | null = null;
  let showsVideo = false;
  let current: Attempt | null = null;
  /** The newest connection the desktop named; later signals must match it. */
  let known: Pick<RemoteWebrtcConnectionRef, 'connectionId' | 'generation'> | null = null;
  /** Every connection the desktop named: one never comes back. */
  const seen = new Set<string>();
  /** Kept on screen after a demotion until the relay view shows a frame. */
  let lingering: Attempt | null = null;
  let epoch = 0;
  let seq = 0;
  let started = false;
  let readySent = false;
  /** The widest video limit sent in this stream (the desktop keeps it). */
  let askedLimit: RemoteWebrtcVideoLimit | null = null;
  let disposed = false;
  let retryTimer: unknown = null;
  let statsTimer: unknown = null;
  const ledger = createInputLedger();

  const ref = (attempt: Pick<Attempt, 'connectionId' | 'generation'>): RemoteWebrtcConnectionRef => ({
    v: REMOTE_WEBRTC_VERSION,
    source: options.source,
    connectionId: attempt.connectionId,
    generation: attempt.generation,
  });
  const send = (signal: RemoteWebrtcClientSignal): Promise<void> =>
    options.signal(signal).catch((error: unknown) => {
      options.log(`[mixdog-remote-webrtc] ${signal.type} not delivered: ${String(error)}`);
    });
  const setState = (next: RemoteWebrtcTransportState): void => {
    if (state === next) return;
    state = next;
    options.changed();
  };

  const stopStats = (): void => {
    if (statsTimer !== null) timers.clearInterval(statsTimer);
    statsTimer = null;
  };
  const release = (attempt: Attempt): void => {
    attempt.closed = true;
    const { peer, channel } = attempt;
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.ondatachannel = null;
    peer.onconnectionstatechange = null;
    if (channel) {
      channel.onopen = null;
      channel.onmessage = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    }
    peer.close();
  };
  /** Ends `attempt`; the picture stays up while it is still the one shown. */
  const teardown = (attempt: Attempt, keepPicture = false): void => {
    if (current === attempt) {
      current = null;
      stopStats();
      ledger.clearUnacked();
      ledger.clearAwaiting();
      videoRun = null;
      // The desktop session this attempt spoke for is over; a replacement may
      // reuse the geometry generation, so what it reported is not carried over.
      options.sessionEnded?.();
    }
    if (keepPicture && showsVideo) {
      if (!attempt.closed) {
        attempt.closed = true;
        lingering = attempt;
      }
      return;
    }
    release(attempt);
    if (lingering === attempt) lingering = null;
    if (!lingering && !current) {
      showsVideo = false;
      presented = null;
      options.stream(null);
    }
  };
  const dropLingering = (): void => {
    const attempt = lingering;
    lingering = null;
    if (attempt) {
      release(attempt);
      if (!current) {
        showsVideo = false;
        presented = null;
        options.stream(null);
      }
    }
  };

  const sendReady = (): void => {
    if (!started || disposed || readySent || state !== 'relay') return;
    const receiveCodecs = options.receiveCodecs();
    if (!receiveCodecs.length) return;
    readySent = true;
    sendReadySignal(receiveCodecs);
  };
  /** `ready`, with the page's native size as the video limit once a geometry
   *  told it (the desktop widens the capture to it, never shrinks it). */
  const sendReadySignal = (receiveCodecs: string[], page: RemoteWebrtcGeometry | null = geometry): void => {
    const videoLimit = page ? remoteVideoLimit(page) : null;
    if (videoLimit) {
      askedLimit = {
        maxWidth: Math.max(askedLimit?.maxWidth ?? 0, videoLimit.maxWidth),
        maxHeight: Math.max(askedLimit?.maxHeight ?? 0, videoLimit.maxHeight),
      };
    }
    void send({
      v: REMOTE_WEBRTC_VERSION,
      source: options.source,
      type: 'ready',
      receiveCodecs,
      ...(videoLimit ? { videoLimit } : {}),
    });
  };
  /** An offer whose video is below the page's native size this side has not
   *  asked for yet: `ready` again with it (the desktop supersedes the offer
   *  and offers the wider capture) instead of answering. Once per size. */
  const widenBeforeAnswer = (offered: RemoteWebrtcGeometry): boolean => {
    const wanted = remoteVideoLimit(offered);
    if (!wanted || !remoteVideoBelowLimit(offered, wanted)) return false;
    if (askedLimit && askedLimit.maxWidth >= wanted.maxWidth && askedLimit.maxHeight >= wanted.maxHeight) return false;
    const receiveCodecs = options.receiveCodecs();
    if (!receiveCodecs.length) return false;
    sendReadySignal(receiveCodecs, offered);
    return true;
  };

  /** A failure this side saw (or a refusal of what the desktop sent). */
  const fail = (attempt: Attempt, reason: RemoteWebrtcCloseReason, detail?: string): void => {
    if (current !== attempt || attempt.closed) return;
    options.log(`[mixdog-remote-webrtc] closing ${attempt.connectionId}: ${reason}${detail ? ` (${detail})` : ''}`);
    const closing = send({
      ...ref(attempt),
      type: 'close',
      reason,
      ...(detail ? { detail: detail.slice(0, 200) } : {}),
    });
    if (owner === 'channel') {
      // Input may already be on the channel: only the desktop's demotion
      // returns it to the relay. It is pushed before this call is answered;
      // a desktop that answers without one no longer streams this viewer.
      owner = 'held';
      teardown(attempt, true);
      options.changed();
      void closing.then(() => {
        if (owner !== 'held') return;
        owner = 'relay';
        dropLingering();
        setState('cooldown');
        options.changed();
      });
      return;
    }
    teardown(attempt);
    setState('cooldown');
  };

  const maybeMediaReady = (): void => {
    const attempt = current;
    if (!attempt || !attempt.verified || state !== 'connected' || attempt.channel?.readyState !== 'open') return;
    if (!geometry || presented?.width !== geometry.pixelWidth || presented.height !== geometry.pixelHeight) return;
    // A screen has no documents: its media-ready names none (null).
    const documentId = options.source.kind === 'screen' ? null : options.documentId();
    if (documentId === '') return;
    const key = `${documentId ?? 'screen'} ${geometry.generation}`;
    // The desktop drops a media-ready it cannot take yet (its geometry ack or
    // first frame of the document still in flight): repeated, at most once per
    // stats interval, while the connection waits to be promoted.
    const sentAt = now();
    if (attempt.mediaReadyKey === key && sentAt - attempt.mediaReadyAt < options.statsIntervalMs) return;
    attempt.mediaReadyKey = key;
    attempt.mediaReadyAt = sentAt;
    void send({
      ...ref(attempt),
      type: 'media-ready',
      documentId,
      geometryGeneration: geometry.generation,
      pixelWidth: geometry.pixelWidth,
      pixelHeight: geometry.pixelHeight,
    });
  };

  /** Every geometry adopted is acknowledged, from `geometry` or an offer: the
   *  same generation again too, since a new desktop viewer starts unacked. */
  const acceptGeometry = (next: RemoteWebrtcGeometry): void => {
    if (geometry && next.generation < geometry.generation) return;
    const changed = geometry?.generation !== next.generation;
    geometry = next;
    void send({
      v: REMOTE_WEBRTC_VERSION,
      source: options.source,
      type: 'geometry-ack',
      geometryGeneration: next.generation,
    });
    if (changed) options.changed();
    maybeMediaReady();
  };

  const sampleStats = async (attempt: Attempt): Promise<void> => {
    const report = await attempt.peer.getStats();
    if (current !== attempt) return;
    const stats = readRemoteWebrtcReceiverStats(report, attempt, Date.now(), ledger.means());
    ledger.resetSamples();
    // Input no frame showed within the window made no visible change.
    ledger.clearAwaiting();
    if (!stats) return;
    const channel = attempt.channel;
    if (channel?.readyState === 'open') {
      const message: RemoteWebrtcChannelFromClient = { v: REMOTE_WEBRTC_VERSION, kind: 'stats', stats };
      channel.send(JSON.stringify(message));
    }
    options.log(receiverStatsLine(stats));
  };

  const verify = async (attempt: Attempt): Promise<void> => {
    if (attempt.verified) return;
    const report = await attempt.peer.getStats();
    if (current !== attempt || attempt.closed || attempt.verified) return;
    const certificate = remoteWebrtcPeerCertificate(report);
    if (!certificate || !remoteWebrtcCertificateMatches(attempt.fingerprints, certificate)) {
      fail(attempt, 'fingerprint-mismatch');
      return;
    }
    attempt.verified = true;
    if (state === 'negotiating') setState('connected');
    stopStats();
    statsTimer = timers.setInterval(() => {
      void sampleStats(attempt).catch(() => {});
    }, options.statsIntervalMs);
    maybeMediaReady();
  };

  const onChannelMessage = (data: unknown, ended = false): void => {
    const pushed = readRemoteWebrtcScreenStatus(data);
    if (pushed) {
      options.screenStatus?.(pushed.status);
      return;
    }
    const video = readRemoteWebrtcScreenVideo(data);
    if (video) {
      // A run is announced once; an older (or repeated) epoch, one of a session
      // that has ended, or any push for a browser source is not a new run.
      if (!ended && options.source.kind === 'screen' && (!videoRun || video.epoch > videoRun.epoch)) {
        videoRun = { epoch: video.epoch, arrivedAt: now(), seen: false };
      }
      return;
    }
    const challenge = readRemoteWebrtcScreenHelperChallenge(data);
    if (challenge) {
      // Answered at once or not at all (a grant lapses in seconds), and never
      // for a session that has ended or a browser source.
      if (!ended && options.source.kind === 'screen') {
        options.screenHelperChallenge?.({
          epoch: challenge.epoch,
          nonce: challenge.nonce,
          challenge: challenge.challenge,
        });
      }
      return;
    }
    const cursor = readRemoteWebrtcScreenCursor(data);
    if (cursor) {
      // Pixels of an older (or not yet adopted) geometry point somewhere else,
      // and so do those of a session that has ended (a lingering connection).
      if (!ended && geometry && cursor.generation === geometry.generation)
        options.screenCursor?.({ x: cursor.x, y: cursor.y });
      return;
    }
    const ack = readRemoteWebrtcChannelFromDesktop(data);
    if (!ack || ack.epoch !== epoch) return;
    const settled = ledger.acknowledge(ack, now);
    if (!settled?.rejected) return;
    // A refused click or scroll is dropped quietly, as on the relay; text
    // the page did not take is said. A screen key, combo or text refused
    // after it was queued is said by the screen pane, not the browser's.
    const { kind } = settled;
    if (kind === 'screen-key' || kind === 'screen-keys' || kind === 'screen-text') options.screenInputRejected?.();
    else if (browserTypingInput({ type: kind })) options.failure(REMOTE_WEBRTC_REJECTED_MESSAGE);
  };

  const bindChannel = (attempt: Attempt, channel: RTCDataChannel): void => {
    attempt.channel = channel;
    channel.onopen = () => maybeMediaReady();
    channel.onmessage = (event) => onChannelMessage(event.data, attempt.closed);
    const lost = () => fail(attempt, 'channel-failed');
    channel.onclose = lost;
    channel.onerror = lost;
    if (channel.readyState === 'open') maybeMediaReady();
  };

  const addCandidate = (attempt: Attempt, candidate: RTCIceCandidateInit | null): void => {
    addIceCandidate(attempt.peer, attempt, candidate, (error) => {
      options.log(`[mixdog-remote-webrtc] candidate refused: ${String(error)}`);
    });
  };

  /**
   * A connection the desktop has not named before. Within an attempt a lower
   * generation is stale; between attempts (relay or cooldown) the desktop's
   * viewer may have been replaced (the stream ended, the client left the
   * relay) and counts generations from 1 again, so only a connection already
   * seen is stale then.
   */
  const fresh = (signal: Pick<RemoteWebrtcConnectionRef, 'connectionId' | 'generation'>): boolean => {
    if (seen.has(signal.connectionId)) return false;
    const between = state === 'relay' || state === 'cooldown';
    return between || !known || signal.generation > known.generation;
  };

  const acceptOffer = (offer: Extract<RemoteWebrtcDesktopSignal, { type: 'offer' }>): void => {
    seen.add(offer.connectionId);
    if (owner !== 'relay') {
      // Video still owns input: the desktop must demote before a new attempt.
      void send({ ...ref(offer), type: 'close', reason: 'protocol-error', detail: 'offer while promoted' });
      return;
    }
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
    // Left unanswered: the desktop's close of it is then stale here.
    if (widenBeforeAnswer(offer.geometry)) return;
    known = { connectionId: offer.connectionId, generation: offer.generation };
    dropLingering();
    if (current) teardown(current);
    acceptGeometry(offer.geometry);
    epoch = offer.inputEpoch;
    // The offer's policy: `all` (direct pairs first, the deployment's TURN as
    // the fallback), or `relay` from a host before direct-first.
    const peer = options.createPeer({ iceServers: offer.iceServers, iceTransportPolicy: offer.iceTransportPolicy });
    const attempt = newAttempt(offer, peer);
    current = attempt;
    setState('negotiating');
    peer.onicecandidate = (event) => {
      if (current !== attempt) return;
      void send({ ...ref(attempt), type: 'candidate', candidate: iceCandidateSignal(event.candidate) });
    };
    peer.ontrack = (event) => {
      if (current !== attempt) return;
      // A screen is read, not watched as a film: ask for the smallest
      // playout delay the jitter buffer allows (RTCRtpReceiver.jitterBufferTarget).
      if ('jitterBufferTarget' in event.receiver) {
        (event.receiver as RTCRtpReceiver & { jitterBufferTarget: number | null }).jitterBufferTarget = 0;
      }
      options.stream(event.streams[0] ?? new MediaStream([event.track]));
    };
    peer.ondatachannel = (event) => {
      if (current !== attempt) return;
      if (event.channel.label !== REMOTE_WEBRTC_INPUT_CHANNEL || attempt.channel) {
        fail(attempt, 'protocol-error', `unexpected channel ${event.channel.label}`);
        return;
      }
      bindChannel(attempt, event.channel);
    };
    peer.onconnectionstatechange = () => {
      if (current !== attempt) return;
      if (peer.connectionState === 'connected') {
        void verify(attempt).catch((error: unknown) => fail(attempt, 'fingerprint-mismatch', String(error)));
      } else if (peer.connectionState === 'failed') {
        fail(attempt, peer.iceConnectionState === 'failed' ? 'ice-failed' : 'dtls-failed');
      }
    };
    void (async () => {
      await peer.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
      if (current !== attempt) return;
      attempt.remoteSet = true;
      for (const candidate of attempt.candidates.splice(0)) addCandidate(attempt, candidate);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (current !== attempt) return;
      const sdp = peer.localDescription?.sdp ?? answer.sdp ?? '';
      const fingerprints = remoteWebrtcSdpFingerprints(sdp);
      if (!fingerprints.length) {
        fail(attempt, 'protocol-error', 'answer without a fingerprint');
        return;
      }
      await send({ ...ref(attempt), type: 'answer', sdp, fingerprints });
    })().catch((error: unknown) => fail(attempt, 'unsupported', String(error)));
  };

  const promote = (signal: Extract<RemoteWebrtcDesktopSignal, { type: 'promote' }>): void => {
    const attempt = current;
    if (!attempt || state !== 'connected') {
      if (attempt) fail(attempt, 'protocol-error', `promote in ${state}`);
      return;
    }
    // The barrier: every relay input already sent is answered before the ack
    // goes out; input from now on rides the channel with the new epoch, and
    // the desktop holds it until the ack is decoded.
    epoch = signal.inputEpoch;
    seq = 0;
    ledger.clearUnacked();
    owner = 'channel';
    showsVideo = true;
    setState('promoting');
    options.changed();
    void options
      .fence(async () => {
        // Ended meanwhile (a reconnect reset it): nothing is acknowledged.
        if (current !== attempt) return;
        await options.signal({ ...ref(attempt), type: 'promote-ack', inputEpoch: signal.inputEpoch });
      })
      .then(
        () => {
          if (current === attempt && state === 'promoting') setState('webrtc');
        },
        (error: unknown) => {
          // The desktop may or may not hold the ack: who owns input is
          // uncertain. Hand back (close; only a demotion or the close's
          // answer returns input to the relay); nothing sent is replayed.
          fail(attempt, 'protocol-error', `promote-ack not delivered: ${String(error)}`);
        }
      );
  };

  const demote = (signal: Extract<RemoteWebrtcDesktopSignal, { type: 'demote' }>): void => {
    // Nothing unsent moves to the relay: coalesced motion and held buttons
    // are dropped while input has no owner.
    owner = 'held';
    options.dropInput();
    epoch = signal.inputEpoch;
    ledger.clearUnacked();
    // The ack leaves after every earlier relay call; relay input after it
    // waits for it, so the desktop sees none of it before the ack.
    // The desktop answers the ack with this connection's `close`, which says
    // whether another attempt is welcome; the view stays `demoting` until then.
    // An undelivered ack: the desktop closes on its ack timeout; the relay
    // input queued behind the ack was dropped with it.
    void options
      .fence(() => options.signal({ ...ref(signal), type: 'demote-ack', inputEpoch: signal.inputEpoch }))
      .catch(() => {});
    owner = 'relay';
    if (current) teardown(current, true);
    setState('demoting');
    options.changed();
  };

  const closedByDesktop = (signal: Extract<RemoteWebrtcDesktopSignal, { type: 'close' }>): void => {
    if (owner !== 'relay') {
      // Closed without a demotion: the viewer is gone on the desktop, and so
      // is any epoch the channel owned.
      owner = 'held';
      options.dropInput();
      owner = 'relay';
    }
    if (current) teardown(current, true);
    readySent = false;
    setState('cooldown');
    options.changed();
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
    // Absent: no new attempt until the view comes back (a new stream or relay
    // connection). Present: another attempt is welcome after it — `ready`
    // goes out with the next relay frame, which proves the stream is still on.
    if (signal.retryAfterMs === undefined) return;
    if (signal.retryAfterMs === 0) {
      setState('relay');
      return;
    }
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      if (state === 'cooldown') setState('relay');
    }, signal.retryAfterMs);
  };

  /** Forget the desktop's viewer: it ends with the relay stream (the stream's
   *  stop, or this client leaving the relay), and a new one counts its
   *  connection generations from the start. Nothing is signaled: a `close`
   *  here would only make the desktop demote a viewer it is ending anyway. */
  const forget = (): void => {
    readySent = false;
    if (retryTimer !== null) timers.clearTimeout(retryTimer);
    retryTimer = null;
    if (current) teardown(current);
    dropLingering();
    known = null;
    owner = 'relay';
    state = 'relay';
    options.changed();
  };
  const stop = (): void => {
    started = false;
    // A new stream starts at the frame bound again.
    askedLimit = null;
    forget();
  };

  return {
    get state(): RemoteWebrtcTransportState {
      return state;
    },
    get owner(): RemoteWebrtcInputOwner {
      return owner;
    },
    get geometry(): RemoteWebrtcGeometry | null {
      return geometry;
    },
    get presented(): { width: number; height: number } | null {
      return presented;
    },
    /** The video is the picture (input maps through it). */
    get showsVideo(): boolean {
      return showsVideo;
    },
    /** The relay view is streaming: offer to receive video. */
    start(): void {
      if (disposed) return;
      started = true;
      sendReady();
    },
    /** The viewer left (pane hidden or closed). */
    stop,
    /** A fresh relay connection: the desktop may have lost this viewer. Off
     *  WebRTC the relay view offers again with the next relay frame (which
     *  proves the stream subscription `ready` is checked against is back); a
     *  live peer connection does not depend on the relay and stays. */
    reconnected(): void {
      if (state === 'promoting' || owner === 'held') {
        // Ownership is uncertain (a promote-ack or the channel's close in
        // flight on the old relay): end the attempt here. Unsent input is
        // dropped, nothing is replayed; the next `ready` makes the desktop
        // demote or close whatever it still holds of it.
        owner = 'held';
        options.dropInput();
        if (current) teardown(current);
        dropLingering();
        owner = 'relay';
        state = 'cooldown';
      }
      // `demoting`: the hand-back is done; its `close` may have been lost with the old relay.
      if (state !== 'relay' && state !== 'cooldown' && state !== 'demoting') return;
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
      readySent = false;
      setState('relay');
    },
    handle(signal: RemoteWebrtcDesktopSignal): void {
      // Only a started viewer takes the desktop's signals: one never started
      // (a replacement whose start a deliberate stop refused), stopped or
      // disposed asked for no session, so a late offer opens no peer.
      if (!started || disposed || remoteWebrtcSourceKey(signal.source) !== sourceKey) return;
      if (signal.type === 'geometry') {
        acceptGeometry(signal.geometry);
        return;
      }
      if (signal.type === 'offer') {
        if (fresh(signal)) acceptOffer(signal);
        return;
      }
      // A close of an attempt the desktop ended before offering (an older
      // host without TURN, or one that could not start the attempt).
      if (signal.type === 'close' && fresh(signal)) {
        seen.add(signal.connectionId);
        known = { connectionId: signal.connectionId, generation: signal.generation };
        closedByDesktop(signal);
        return;
      }
      // Anything else not of the newest connection is stale.
      if (!known || signal.connectionId !== known.connectionId || signal.generation !== known.generation) return;
      if (signal.type === 'candidate') {
        if (current && current.connectionId === signal.connectionId) addCandidate(current, signal.candidate);
      } else if (signal.type === 'promote') promote(signal);
      else if (signal.type === 'demote') demote(signal);
      else closedByDesktop(signal);
    },
    /** Channel input, when the channel owns it; false: not sent. */
    sendInput(control: RemoteWebrtcSourceInput): boolean {
      const attempt = current;
      const channel = attempt?.channel;
      if (owner !== 'channel' || !attempt || !channel || channel.readyState !== 'open' || !geometry) return false;
      seq += 1;
      const envelope = { v: REMOTE_WEBRTC_VERSION, epoch, seq, geometryGeneration: geometry.generation, sentAt: now() };
      const message: RemoteWebrtcChannelFromClient = isRemoteWebrtcPageInput(control)
        ? { ...envelope, kind: 'input', control }
        : { ...envelope, kind: 'screen-input', control };
      try {
        channel.send(JSON.stringify(message));
      } catch (error) {
        fail(attempt, 'channel-failed', String(error));
        return false;
      }
      ledger.sent(seq, control.type);
      return true;
    },
    /** The video element presented a frame. */
    framePresented(frame: RemoteWebrtcPresentedFrame): void {
      if (!current && !lingering) return;
      if (presented?.width !== frame.width || presented.height !== frame.height) {
        presented = { width: frame.width, height: frame.height };
        options.changed();
      }
      // The receipt: the first frame received after the run's announcement.
      const attempt = current;
      const channel = attempt?.channel;
      if (
        attempt &&
        videoRun &&
        !videoRun.seen &&
        frame.receiveTime !== undefined &&
        frame.receiveTime > videoRun.arrivedAt &&
        channel?.readyState === 'open'
      ) {
        videoRun.seen = true;
        const receipt: RemoteWebrtcChannelFromClient = {
          v: REMOTE_WEBRTC_VERSION,
          kind: 'screen-frame-seen',
          epoch: videoRun.epoch,
        };
        try {
          channel.send(JSON.stringify(receipt));
        } catch (error) {
          fail(attempt, 'channel-failed', String(error));
        }
      }
      ledger.shown(frame.captureTime, () => frame.expectedDisplayTime ?? now());
      maybeMediaReady();
    },
    /** The newest relay frame names another document. */
    documentChanged(): void {
      maybeMediaReady();
    },
    /** The JPEG view presented a frame: after a demotion it is the picture again. */
    relayPresented(): void {
      if (owner === 'channel' || !lingering) return;
      dropLingering();
      options.changed();
    },
    /** The newest video run the desktop announced on this connection, or null. */
    get videoEpoch(): number | null {
      return videoRun?.epoch ?? null;
    },
    /** A secure-desktop helper message (an install or enroll request, a signed grant)
     *  on the verified channel of a screen source. Never queued: a grant that
     *  cannot go now is useless a moment later. False when it did not go. */
    sendHelperMessage(message: ScreenHelperClientMessage): boolean {
      const attempt = current;
      const channel = attempt?.channel;
      if (options.source.kind !== 'screen' || !attempt?.verified || channel?.readyState !== 'open') return false;
      const text = encodeHelperMessage(message);
      if (text === null) return false;
      try {
        channel.send(text);
        return true;
      } catch (error) {
        fail(attempt, 'channel-failed', String(error));
        return false;
      }
    },
    /** A deliberate resize (never keyboard, rotation, zoom or pan). */
    requestResize(resize: RemoteWebrtcResize): Promise<void> {
      return send({ v: REMOTE_WEBRTC_VERSION, source: options.source, type: 'resize-request', resize });
    },
    dispose(): void {
      if (disposed) return;
      // Disposed first: the stop below reports the relay state through
      // `changed`, and a listener that offers again on it must find nothing
      // to start (a disposed viewer never sends another `ready`).
      disposed = true;
      stop();
      state = 'closed';
    },
  };
}

export type RemoteWebrtcViewer = ReturnType<typeof createRemoteWebrtcViewer>;
