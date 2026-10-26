/**
 * Live view over WebRTC: the wire contract between the desktop (main and its
 * hidden sender renderer) and a paired phone. Signaling rides the existing
 * end-to-end encrypted relay channel; video and page input ride a direct peer
 * connection once it has proved itself, and the JPEG relay view stays up until
 * then and comes back on any failure. docs/remote-webrtc.md is the spec.
 */
import type { DesktopRemoteBrowserPageInput } from './contract';
import { normalizeRemoteBrowserControl } from './remote-browser';

export const REMOTE_WEBRTC_VERSION = 1 as const;
/** E2EE challenge flag (`RelayE2EEChallenge.browserWebrtc`): this host speaks
 *  this contract; its value is REMOTE_WEBRTC_VERSION. */
export const REMOTE_WEBRTC_CAPABILITY = 'browserWebrtc' as const;
/** E2EE challenge flag (`RelayE2EEChallenge.browserFit`, value 1): this host
 *  honours a take-over's `fit` on the stream request
 *  (`DesktopRemoteBrowserStreamOptions.fit`): it fits the page once, by
 *  viewport emulation only, and marks every frame whose picture is of that
 *  settled layout `fitSettled: true` (`DesktopRemoteBrowserStreamFrame`). A
 *  phone waits for such a frame instead of judging by size; without the flag
 *  the host ignores `fit`, so the phone must not wait for one. */
export const REMOTE_BROWSER_FIT_CAPABILITY = 'browserFit' as const;
/** Phone → desktop: a client-bound relay call, params `[RemoteWebrtcClientSignal]`. */
export const REMOTE_WEBRTC_SIGNAL_METHOD = 'browserRemoteWebrtcSignal';
/** Desktop → phone: an encrypted push to that one client, payload `RemoteWebrtcDesktopSignal`. */
export const REMOTE_WEBRTC_SIGNAL_EVENT = 'browserRemoteWebrtc';
/** The one data channel: created by the desktop before its offer, reliable and ordered. */
export const REMOTE_WEBRTC_INPUT_CHANNEL = 'mixdog-input';

/** Validation bounds, far above what a browser produces and far below a relay frame. */
const MAX_SDP_LENGTH = 65_536;
const MAX_CANDIDATE_LENGTH = 1_024;
/** ICE server list bounds; main/remote-ice-servers.ts applies the same two to
 *  the relay's list, so a list it returns always passes this validator. */
export const MAX_ICE_SERVERS = 16;
export const MAX_ICE_URLS = 16;
const MAX_ICE_TEXT = 512;
const MAX_CODECS = 32;
const MAX_REASON_DETAIL = 200;
/** The live view's pixel bound (remote-browser.ts MAX_STREAM_DIMENSION). */
const MAX_PIXEL_DIMENSION = 4_096;
/** An explicit fit-client resize stays inside the emulated-viewport bounds the
 *  pane's device presets use (remote-browser.ts remoteBrowserDriveViewport). */
const MIN_CSS_DIMENSION = 200;
const MAX_CSS_DIMENSION = 3_840;
const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
/** A locked geometry reports the page as it is (the PC pane may be any size,
 *  zoom and display scale), so it is only bounded to sane, positive values. */
const MAX_PAGE_CSS_DIMENSION = 16_384;
const MAX_PAGE_SCALE = 32;
/** Digest sizes of the DTLS certificate fingerprints accepted (RFC 8122 §5;
 *  SHA-1 is refused, RFC 8827 §6.5 requires SHA-256 support). */
const FINGERPRINT_BYTES: Readonly<Record<RemoteWebrtcFingerprintAlgorithm, number>> = {
  'sha-256': 32,
  'sha-384': 48,
  'sha-512': 64,
};

// ---------------------------------------------------------------------------
// Identity, ordering and geometry
// ---------------------------------------------------------------------------

/** What is streamed. `screen` is reserved for the whole-PC capture source; a
 *  host that does not serve it closes with `unsupported`. */
export type RemoteWebrtcSource = { kind: 'browser'; sessionId: string } | { kind: 'screen'; screenId: string };

/** Every message of one peer connection carries it. `connectionId` is minted
 *  by the desktop per attempt; `generation` rises per viewer (client × source)
 *  with every new attempt, so anything older than the current one is stale. */
export interface RemoteWebrtcConnectionRef {
  v: typeof REMOTE_WEBRTC_VERSION;
  source: RemoteWebrtcSource;
  connectionId: string;
  generation: number;
}

/** Transport-independent messages name only the source. */
export interface RemoteWebrtcSourceRef {
  v: typeof REMOTE_WEBRTC_VERSION;
  source: RemoteWebrtcSource;
}

/** The page geometry main locks when a source's stream starts and keeps across
 *  renewals, reconnects, keyboard and rotation. Only an explicit resize makes a
 *  new generation; coordinate input is accepted for a generation only after
 *  the viewer acknowledged it. */
export interface RemoteWebrtcGeometry {
  generation: number;
  /** CSS viewport the page lays out at; pointer and wheel coordinates use it. */
  cssWidth: number;
  cssHeight: number;
  deviceScaleFactor: number;
  /** Encoded video size. Even: 4:2:0 chroma halves each dimension. */
  pixelWidth: number;
  pixelHeight: number;
}

/** An explicit resize: fit the page to the client's box (as the drive viewport
 *  does), or return to the page's own geometry. Never sent for keyboard,
 *  rotation, zoom or pan, which are presentation only. */
export type RemoteWebrtcResize =
  | { mode: 'fit-client'; cssWidth: number; cssHeight: number; deviceScaleFactor: number }
  | { mode: 'page' };

export type RemoteWebrtcFingerprintAlgorithm = 'sha-256' | 'sha-384' | 'sha-512';

/** A DTLS certificate fingerprint as SDP `a=fingerprint` carries it: lower-case
 *  algorithm, upper-case colon-separated hex. Sent beside the SDP inside the
 *  E2EE envelope and checked against the SDP and the connected certificate. */
export interface RemoteWebrtcFingerprint {
  algorithm: RemoteWebrtcFingerprintAlgorithm;
  value: string;
}

/** RTCIceCandidateInit as it travels. Under the relay-only policy every
 *  candidate is a TURN `typ relay` one (or the empty end-of-candidates line). */
export interface RemoteWebrtcCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
}

/** RTCIceServer as it travels to the phone (shape-compatible with it). */
export interface RemoteWebrtcIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** One path, through this deployment's own TURN: both ends build their
 *  RTCPeerConnection with `iceTransportPolicy: 'relay'`, so neither gathers
 *  nor tries host, srflx or prflx candidates. Without a TURN server there is
 *  no WebRTC; the JPEG relay view is the fallback. */
export const REMOTE_WEBRTC_ICE_TRANSPORT_POLICY = 'relay' as const;

/** Whether `servers` holds a TURN server with credentials: WebRTC needs one. */
export function remoteWebrtcHasTurn(servers: readonly RemoteWebrtcIceServer[]): boolean {
  return servers.some(
    (server) =>
      !!server.username &&
      !!server.credential &&
      server.urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'))
  );
}

// ---------------------------------------------------------------------------
// Transport state machine (desktop-authoritative, per viewer)
// ---------------------------------------------------------------------------

/**
 * relay        JPEG view and relay input; no peer connection.
 * negotiating  Offer out, ICE/DTLS running, bounded; JPEG still shown.
 * connected    DTLS up, peer certificate matched; waiting for `media-ready`.
 * promoting    `promote` sent; JPEG still produced, data-channel input of the
 *              new epoch held until `promote-ack` arrives on the relay.
 * webrtc       Video and input on the peer connection; JPEG production stopped.
 * demoting     `demote` sent; JPEG resumed; waiting for `demote-ack`.
 * cooldown     Relay view after a failure; no new attempt until it lapses.
 * closed       The viewer left; terminal.
 */
export type RemoteWebrtcTransportState =
  | 'relay'
  | 'negotiating'
  | 'connected'
  | 'promoting'
  | 'webrtc'
  | 'demoting'
  | 'cooldown'
  | 'closed';

export const REMOTE_WEBRTC_TRANSITIONS: Readonly<
  Record<RemoteWebrtcTransportState, readonly RemoteWebrtcTransportState[]>
> = {
  relay: ['negotiating', 'closed'],
  // Nothing moved yet: a failure here goes straight to cooldown.
  negotiating: ['connected', 'cooldown', 'closed'],
  connected: ['promoting', 'cooldown', 'closed'],
  // The phone may already route input to the channel: failure must demote.
  promoting: ['webrtc', 'demoting', 'closed'],
  webrtc: ['demoting', 'closed'],
  demoting: ['cooldown', 'closed'],
  cooldown: ['negotiating', 'relay', 'closed'],
  closed: [],
};

export function canRemoteWebrtcTransition(from: RemoteWebrtcTransportState, to: RemoteWebrtcTransportState): boolean {
  return REMOTE_WEBRTC_TRANSITIONS[from].includes(to);
}

/** JPEG frames are produced in every live state but `webrtc`. */
export function remoteWebrtcJpegActive(state: RemoteWebrtcTransportState): boolean {
  return state !== 'webrtc' && state !== 'closed';
}

/** Which path's page input main dispatches; none while a barrier is open
 *  past the point of no return (`demoting`) or after close. */
export function remoteWebrtcInputOwner(state: RemoteWebrtcTransportState): 'relay' | 'channel' | null {
  if (state === 'webrtc') return 'channel';
  if (state === 'demoting' || state === 'closed') return null;
  return 'relay';
}

export type RemoteWebrtcCloseReason =
  /** The viewer stopped streaming or left. */
  | 'viewer-left'
  /** A newer generation replaced this connection. */
  | 'superseded'
  /** This side cannot serve the source, codec or version. */
  | 'unsupported'
  /** No TURN server (with credentials) is available: JPEG stays. */
  | 'turn-unavailable'
  /** Offer/answer/ICE/DTLS did not complete within the negotiation bound. */
  | 'negotiation-timeout'
  | 'ice-failed'
  | 'dtls-failed'
  /** The SDP or the connected certificate does not match the E2EE-sent fingerprint. */
  | 'fingerprint-mismatch'
  /** Connected, but no frame of the current document/geometry arrived in time. */
  | 'media-timeout'
  /** The data channel closed or errored. */
  | 'channel-failed'
  /** The sender renderer crashed or was destroyed. */
  | 'sender-failed'
  /** Main refused the client or session. */
  | 'unauthorized'
  /** A message violated this contract. */
  | 'protocol-error';

const CLOSE_REASONS: ReadonlySet<string> = new Set<RemoteWebrtcCloseReason>([
  'viewer-left',
  'superseded',
  'unsupported',
  'turn-unavailable',
  'negotiation-timeout',
  'ice-failed',
  'dtls-failed',
  'fingerprint-mismatch',
  'media-timeout',
  'channel-failed',
  'sender-failed',
  'unauthorized',
  'protocol-error',
]);

// ---------------------------------------------------------------------------
// Signaling (over the E2EE relay)
// ---------------------------------------------------------------------------

export type RemoteWebrtcDesktopSignal =
  /** The source's locked geometry, sent on stream start and on each explicit
   *  resize; the viewer answers `geometry-ack`. */
  | (RemoteWebrtcSourceRef & { type: 'geometry'; geometry: RemoteWebrtcGeometry })
  /** Desktop-originated offer. `inputEpoch` is the viewer's current (relay) epoch. */
  | (RemoteWebrtcConnectionRef & {
      type: 'offer';
      sdp: string;
      fingerprints: RemoteWebrtcFingerprint[];
      iceServers: RemoteWebrtcIceServer[];
      /** The phone must build its peer connection with this policy. */
      iceTransportPolicy: typeof REMOTE_WEBRTC_ICE_TRANSPORT_POLICY;
      geometry: RemoteWebrtcGeometry;
      inputEpoch: number;
    })
  /** null: end of candidates. */
  | (RemoteWebrtcConnectionRef & { type: 'candidate'; candidate: RemoteWebrtcCandidate | null })
  /** Video owns the view from now; send input only on the channel with `inputEpoch`. */
  | (RemoteWebrtcConnectionRef & { type: 'promote'; inputEpoch: number; geometryGeneration: number })
  /** Back to JPEG: drop unsent channel input (never replay it), answer
   *  `demote-ack`, then send input on the relay again. */
  | (RemoteWebrtcConnectionRef & { type: 'demote'; inputEpoch: number; reason: RemoteWebrtcCloseReason })
  | (RemoteWebrtcConnectionRef & {
      type: 'close';
      reason: RemoteWebrtcCloseReason;
      /** Present: the phone may send `ready` again after this many ms (the
       *  desktop sends 0 — it never retries on a timer; it only says whether
       *  another attempt is welcome). Absent: no new attempt for this viewer
       *  until it comes back (a new stream or relay connection). */
      retryAfterMs?: number;
    });

/** The largest video the phone wants, in device pixels, independent of its
 *  JPEG frame bound: a desktop-sized page the phone zooms into keeps its
 *  detail. Bounded by the contract's 4096. */
export interface RemoteWebrtcVideoLimit {
  maxWidth: number;
  maxHeight: number;
}

export type RemoteWebrtcClientSignal =
  /** The phone can receive video for this source: the desktop answers with an offer. */
  | (RemoteWebrtcSourceRef & { type: 'ready'; receiveCodecs: string[]; videoLimit?: RemoteWebrtcVideoLimit })
  | (RemoteWebrtcSourceRef & { type: 'geometry-ack'; geometryGeneration: number })
  | (RemoteWebrtcSourceRef & { type: 'resize-request'; resize: RemoteWebrtcResize })
  | (RemoteWebrtcConnectionRef & { type: 'answer'; sdp: string; fingerprints: RemoteWebrtcFingerprint[] })
  | (RemoteWebrtcConnectionRef & { type: 'candidate'; candidate: RemoteWebrtcCandidate | null })
  /** A decoded frame at the locked pixel size was presented while this
   *  document and geometry were current. */
  | (RemoteWebrtcConnectionRef & {
      type: 'media-ready';
      /** The page document; null for a source without documents (a screen). */
      documentId: string | null;
      geometryGeneration: number;
      pixelWidth: number;
      pixelHeight: number;
    })
  /** Sent on the relay after the last relay input of the old epoch. */
  | (RemoteWebrtcConnectionRef & { type: 'promote-ack'; inputEpoch: number })
  /** Sent on the relay before the first relay input of the new epoch. */
  | (RemoteWebrtcConnectionRef & { type: 'demote-ack'; inputEpoch: number })
  | (RemoteWebrtcConnectionRef & { type: 'close'; reason: RemoteWebrtcCloseReason; detail?: string });

// ---------------------------------------------------------------------------
// Data channel (REMOTE_WEBRTC_INPUT_CHANNEL, JSON text messages)
// ---------------------------------------------------------------------------

/** The document-bound page input the relay path takes, minus dialog answers. */
export type RemoteWebrtcPageInput = Exclude<DesktopRemoteBrowserPageInput, { type: 'answer-dialog' }>;

export type RemoteWebrtcChannelFromClient =
  | {
      v: typeof REMOTE_WEBRTC_VERSION;
      kind: 'input';
      epoch: number;
      /** Strictly increasing within the epoch; a repeat is never applied twice. */
      seq: number;
      /** Pointer and wheel need the current, acknowledged generation. */
      geometryGeneration: number;
      /** The phone's clock (performance.now()), echoed in the ack. */
      sentAt: number;
      control: RemoteWebrtcPageInput;
    }
  /** Input to a `screen` source (pointer and wheel in video pixels). */
  | {
      v: typeof REMOTE_WEBRTC_VERSION;
      kind: 'screen-input';
      epoch: number;
      seq: number;
      geometryGeneration: number;
      sentAt: number;
      control: RemoteScreenInput;
    }
  | { v: typeof REMOTE_WEBRTC_VERSION; kind: 'stats'; stats: RemoteWebrtcReceiverStats };

/** What a viewer's channel input is, per source kind. */
export type RemoteWebrtcSourceInput = RemoteWebrtcPageInput | RemoteScreenInput;

export function isRemoteWebrtcPageInput(control: RemoteWebrtcSourceInput): control is RemoteWebrtcPageInput {
  return !control.type.startsWith('screen-');
}

// ---------------------------------------------------------------------------
// Screen source (`{kind: 'screen'}`, docs/remote-screen.md)
// ---------------------------------------------------------------------------

/** Bounds the parser enforces; the injector enforces its own as well. */
export const MAX_REMOTE_SCREEN_TEXT = 256;
/** Keys in one `screen-keys` combo: the eight sided modifiers (Ctrl, Shift,
 *  Alt, Win, left and right) are the most a combo can hold besides its key;
 *  a real shortcut uses far fewer. */
export const MAX_REMOTE_SCREEN_COMBO_KEYS = 8;
/** 40 notches of 120 Windows wheel units. */
const MAX_SCREEN_WHEEL_UNITS = 120 * 40;

export type RemoteScreenButton = 'left' | 'right' | 'middle';

/** A key by Windows virtual-key code and set-1 scan code. `extended` is the
 *  E0 prefix (right Ctrl/Alt, arrows, navigation block, numpad Enter/Divide). */
export interface RemoteScreenKey {
  vk: number;
  scan: number;
  extended: boolean;
}

/**
 * Pointer and wheel coordinates are video pixels of the source's locked
 * geometry (0 ≤ x ≤ pixelWidth, 0 ≤ y ≤ pixelHeight, fractions allowed). Wheel
 * deltas follow WheelEvent's sign in Windows wheel units (120 = one notch).
 */
export type RemoteScreenInput =
  | { type: 'screen-pointer'; action: 'move'; x: number; y: number }
  | { type: 'screen-pointer'; action: 'down' | 'up'; button: RemoteScreenButton; x: number; y: number }
  | { type: 'screen-wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | ({ type: 'screen-key'; action: 'down' | 'up' } & RemoteScreenKey)
  /** An atomic combo: the keys pressed in order, then released in reverse,
   *  as one step on the PC (1..MAX_REMOTE_SCREEN_COMBO_KEYS, no repeats). */
  | { type: 'screen-keys'; keys: RemoteScreenKey[] }
  | { type: 'screen-text'; text: string }
  /** Release every key and button this viewer holds. */
  | { type: 'screen-release' };

export type RemoteScreenHelperState = 'not-needed' | 'active' | 'starting' | 'missing' | 'failed';

export type RemoteScreenStopReason =
  | 'user'
  | 'disabled'
  | 'revoked'
  | 'viewer-left'
  | 'superseded'
  | 'display-removed'
  | 'error';

/** A screen source's state, pushed on the data channel as `screen-status`. */
export interface RemoteScreenStatus {
  state: 'live' | 'elevation-prompt' | 'secure-desktop' | 'stopped';
  reason?: 'uac' | 'lock' | 'secure' | RemoteScreenStopReason;
  helper: RemoteScreenHelperState;
  /** Input is currently accepted from this viewer. */
  control: boolean;
}

/** A display a phone may choose (`browserRemoteScreenDisplays`). */
export interface RemoteScreenDisplaySummary {
  screenId: string;
  label: string;
  primary: boolean;
  pixelWidth: number;
  pixelHeight: number;
  scaleFactor: number;
}

/** Phone → desktop: the displays this client may view (authorized like a
 *  screen source); answers RemoteScreenDisplaySummary[]. */
export const REMOTE_WEBRTC_SCREEN_DISPLAYS_METHOD = 'browserRemoteScreenDisplays';

/** What the sender renderer opens a screen source's video track from. */
export interface RemoteScreenCapturePlan {
  /** desktopCapturer source id (`screen:<n>:0`) of the chosen display. */
  sourceId: string;
  /** Exact encoded size; even in both dimensions. */
  width: number;
  height: number;
  maxFrameRate: number;
}

/** getUserMedia constraints for a plan: the size pinned so the geometry holds. */
export function remoteScreenCaptureConstraints(plan: RemoteScreenCapturePlan): MediaStreamConstraints {
  return {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: plan.sourceId,
        minWidth: plan.width,
        maxWidth: plan.width,
        minHeight: plan.height,
        maxHeight: plan.height,
        maxFrameRate: plan.maxFrameRate,
      },
    } as MediaTrackConstraints,
  };
}

/** Desktop → phone on the channel: a screen source's status. */
export interface RemoteWebrtcScreenStatusMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-status';
  status: RemoteScreenStatus;
}

/** Desktop → phone on the channel: where the PC's cursor is, in video pixels
 *  of geometry `generation` (integers, 0 ≤ x < pixelWidth, 0 ≤ y <
 *  pixelHeight). The cursor itself stays baked into the video; this only
 *  anchors trackpad-mode movement. Sent on change, at most once per capture
 *  frame interval, and once when the channel is promoted; only while the
 *  cursor is on this display and the ordinary desktop is shown. */
export interface RemoteWebrtcScreenCursorMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-cursor';
  x: number;
  y: number;
  generation: number;
}

/** What a source pushes to its viewer's channel (desktop → phone). */
export type RemoteWebrtcChannelPush = RemoteWebrtcScreenStatusMessage | RemoteWebrtcScreenCursorMessage;

export type RemoteWebrtcChannelFromDesktop = {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'input-ack';
  epoch: number;
  seq: number;
  outcome: 'applied' | 'rejected';
  sentAt: number;
  /** Desktop-side durations: channel receipt → dispatch start, dispatch itself. */
  queuedMs: number;
  dispatchMs: number;
};

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export type RemoteWebrtcCandidateType = 'host' | 'srflx' | 'prflx' | 'relay';

/** The selected candidate pair (RTCIceCandidatePairStats + its two candidates). */
export interface RemoteWebrtcCandidatePairStats {
  localType: RemoteWebrtcCandidateType;
  remoteType: RemoteWebrtcCandidateType;
  protocol: 'udp' | 'tcp';
  /** The local relay candidate's transport to TURN, when local is `relay`. */
  relayProtocol?: 'udp' | 'tcp' | 'tls';
  currentRoundTripTimeMs?: number;
  availableOutgoingBitrate?: number;
}

/** The sender's view (outbound-rtp + media-source + its own capture counters). */
export interface RemoteWebrtcSenderStats {
  connectionId: string;
  generation: number;
  /** Wall-clock ms the sample was taken. */
  at: number;
  codec?: string;
  /** The encoder actually in use (e.g. a hardware or `libvpx`/`OpenH264` name). */
  encoderImplementation?: string;
  powerEfficientEncoder?: boolean;
  /** Frames capture handed to the sender, and those superseded before encode. */
  framesCaptured: number;
  framesSuperseded: number;
  framesEncoded: number;
  framesSent: number;
  totalEncodeTimeMs: number;
  qualityLimitationReason?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  targetBitrate?: number;
  bytesSent: number;
  candidatePair?: RemoteWebrtcCandidatePairStats;
}

/** The phone's view (inbound-rtp), sent on the channel for the desktop's log. */
export interface RemoteWebrtcReceiverStats {
  connectionId: string;
  generation: number;
  at: number;
  codec?: string;
  decoderImplementation?: string;
  framesReceived: number;
  framesDecoded: number;
  framesDropped: number;
  totalDecodeTimeMs: number;
  jitterBufferDelayMs?: number;
  freezeCount?: number;
  /** Mean channel input round trip (sent → ack) over the sample window. */
  inputRoundTripMs?: number;
  /** Mean input → first presented frame after its dispatch, over the window. */
  inputToVisibleMs?: number;
  /** The decoded frame size. */
  frameWidth?: number;
  frameHeight?: number;
  candidatePair?: RemoteWebrtcCandidatePairStats;
}

// ---------------------------------------------------------------------------
// Ordered relay input (`browserRemoteControl([sessionId, control, order])`)
// ---------------------------------------------------------------------------

/**
 * The order a phone sends beside each relay control on a host that advertises
 * `browserWebrtc`, so relay input can be pipelined. Kept per client × session,
 * judged in decode order:
 * - a new `stream` starts fresh (run and seq forgotten);
 * - `run` older than the newest seen: refused, not dispatched;
 * - `run` newer: adopted, and the run is no longer poisoned;
 * - `seq` not above the last seen: refused (never applied twice);
 * - a poisoned run: refused; otherwise dispatched, and a dispatch that throws
 *   poisons the run (its error is the reply), so nothing sent behind an
 *   uncertain failure is applied.
 * A control without an order keeps the unordered behaviour.
 */
export interface RemoteWebrtcRelayInputOrder {
  v: typeof REMOTE_WEBRTC_VERSION;
  /** Opaque id of one input queue (one pane's page view). */
  stream: string;
  run: number;
  seq: number;
}

// ---------------------------------------------------------------------------
// Validation. parse* throws TypeError (desktop answers the call with it);
// read* returns null (the phone drops the message).
// ---------------------------------------------------------------------------

type Fields = Record<string, unknown>;

function fail(what: string): never {
  throw new TypeError(`remote webrtc ${what} is invalid.`);
}

function record(value: unknown, what: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(what);
  return value as Fields;
}

function positiveInteger(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(what);
  return value as number;
}

function boundedNumber(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(what);
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, what: string): number {
  if (!Number.isSafeInteger(value)) fail(what);
  return boundedNumber(value, min, max, what);
}

function boundedText(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string' || value.length > max) fail(what);
  return value;
}

function opaqueId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(value)) fail(what);
  return value;
}

export function normalizeRemoteWebrtcSource(value: unknown): RemoteWebrtcSource {
  const input = record(value, 'source');
  if (input.kind === 'browser') return { kind: 'browser', sessionId: opaqueId(input.sessionId, 'session id') };
  if (input.kind === 'screen') return { kind: 'screen', screenId: opaqueId(input.screenId, 'screen id') };
  return fail('source');
}

/** One key per source, for maps keyed by viewer. */
export function remoteWebrtcSourceKey(source: RemoteWebrtcSource): string {
  return source.kind === 'browser' ? `browser:${source.sessionId}` : `screen:${source.screenId}`;
}

function sourceRef(input: Fields): RemoteWebrtcSourceRef {
  if (input.v !== REMOTE_WEBRTC_VERSION) fail('version');
  return { v: REMOTE_WEBRTC_VERSION, source: normalizeRemoteWebrtcSource(input.source) };
}

function connectionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/u.test(value)) fail('connection id');
  return value;
}

function connectionRef(input: Fields): RemoteWebrtcConnectionRef {
  return {
    ...sourceRef(input),
    connectionId: connectionId(input.connectionId),
    generation: positiveInteger(input.generation, 'generation'),
  };
}

function evenPixels(value: unknown, what: string): number {
  const pixels = boundedInteger(value, 2, MAX_PIXEL_DIMENSION, what);
  if (pixels % 2 !== 0) fail(what);
  return pixels;
}

export function normalizeRemoteWebrtcGeometry(value: unknown): RemoteWebrtcGeometry {
  const input = record(value, 'geometry');
  const scale = boundedNumber(input.deviceScaleFactor, 0, MAX_PAGE_SCALE, 'geometry scale');
  if (scale === 0) fail('geometry scale');
  return {
    generation: positiveInteger(input.generation, 'geometry generation'),
    cssWidth: boundedInteger(input.cssWidth, 1, MAX_PAGE_CSS_DIMENSION, 'geometry width'),
    cssHeight: boundedInteger(input.cssHeight, 1, MAX_PAGE_CSS_DIMENSION, 'geometry height'),
    deviceScaleFactor: scale,
    pixelWidth: evenPixels(input.pixelWidth, 'geometry pixel width'),
    pixelHeight: evenPixels(input.pixelHeight, 'geometry pixel height'),
  };
}

function resize(value: unknown): RemoteWebrtcResize {
  const input = record(value, 'resize');
  if (input.mode === 'page') return { mode: 'page' };
  if (input.mode !== 'fit-client') fail('resize mode');
  return {
    mode: 'fit-client',
    cssWidth: boundedInteger(input.cssWidth, MIN_CSS_DIMENSION, MAX_CSS_DIMENSION, 'resize width'),
    cssHeight: boundedInteger(input.cssHeight, MIN_CSS_DIMENSION, MAX_CSS_DIMENSION, 'resize height'),
    deviceScaleFactor: boundedNumber(input.deviceScaleFactor, MIN_SCALE, MAX_SCALE, 'resize scale'),
  };
}

function fingerprint(value: unknown): RemoteWebrtcFingerprint {
  const input = record(value, 'fingerprint');
  const algorithm = typeof input.algorithm === 'string' ? input.algorithm.toLowerCase() : '';
  if (!Object.hasOwn(FINGERPRINT_BYTES, algorithm)) fail('fingerprint algorithm');
  const bytes = FINGERPRINT_BYTES[algorithm as RemoteWebrtcFingerprintAlgorithm];
  const hex = typeof input.value === 'string' ? input.value.toUpperCase() : '';
  if (!new RegExp(`^[0-9A-F]{2}(?::[0-9A-F]{2}){${bytes - 1}}$`, 'u').test(hex)) fail('fingerprint value');
  return { algorithm: algorithm as RemoteWebrtcFingerprintAlgorithm, value: hex };
}

function fingerprints(value: unknown): RemoteWebrtcFingerprint[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > Object.keys(FINGERPRINT_BYTES).length) {
    fail('fingerprints');
  }
  return value.map(fingerprint);
}

const fingerprintKey = (entry: RemoteWebrtcFingerprint): string => `${entry.algorithm} ${entry.value}`;

/** The `a=fingerprint` attributes of an SDP, session and media level, deduplicated. */
export function remoteWebrtcSdpFingerprints(sdp: string): RemoteWebrtcFingerprint[] {
  const found = new Map<string, RemoteWebrtcFingerprint>();
  for (const line of sdp.split(/\r?\n/u)) {
    const match = /^a=fingerprint:(\S+) (\S+)\s*$/u.exec(line);
    if (!match) continue;
    const entry = fingerprint({ algorithm: match[1], value: match[2] });
    found.set(fingerprintKey(entry), entry);
  }
  return [...found.values()];
}

/** Throws unless the SDP names exactly the fingerprints sent beside it. */
export function assertRemoteWebrtcSdpFingerprints(sdp: string, declared: readonly RemoteWebrtcFingerprint[]): void {
  const inSdp = new Set(remoteWebrtcSdpFingerprints(sdp).map(fingerprintKey));
  const sent = new Set(declared.map(fingerprintKey));
  if (!inSdp.size || inSdp.size !== sent.size || [...sent].some((key) => !inSdp.has(key))) {
    throw new TypeError('remote webrtc fingerprint-mismatch: SDP and signaled fingerprints differ.');
  }
}

/** The connected peer's certificate (RTCCertificateStats `fingerprint` /
 *  `fingerprintAlgorithm`) is one the E2EE channel delivered. */
export function remoteWebrtcCertificateMatches(
  declared: readonly RemoteWebrtcFingerprint[],
  certificate: unknown
): boolean {
  try {
    const stats = record(certificate, 'certificate');
    const actual = fingerprint({ algorithm: stats.fingerprintAlgorithm, value: stats.fingerprint });
    return declared.some((entry) => fingerprintKey(entry) === fingerprintKey(actual));
  } catch {
    return false;
  }
}

function sdp(value: unknown): string {
  const text = boundedText(value, MAX_SDP_LENGTH, 'sdp');
  if (!text.startsWith('v=0')) fail('sdp');
  // Both ends run full ICE.
  if (/^a=ice-lite\b/mu.test(text)) fail('sdp ice-lite');
  return text;
}

function candidate(value: unknown): RemoteWebrtcCandidate | null {
  if (value === null) return null;
  const input = record(value, 'candidate');
  const line = boundedText(input.candidate, MAX_CANDIDATE_LENGTH, 'candidate');
  // An empty line is the per-generation end-of-candidates marker; any other
  // must be a TURN relay candidate (RFC 8839 §5.1 `typ relay`).
  if (line && (!line.startsWith('candidate:') || !/ typ relay(?: |$)/u.test(line))) fail('candidate');
  const nullable = <T>(field: unknown, read: (field: unknown) => T): T | null =>
    field === null || field === undefined ? null : read(field);
  const candidateInit: RemoteWebrtcCandidate = {
    candidate: line,
    sdpMid: nullable(input.sdpMid, (field) => boundedText(field, 32, 'candidate mid')),
    sdpMLineIndex: nullable(input.sdpMLineIndex, (field) => boundedInteger(field, 0, 255, 'candidate line')),
    usernameFragment: nullable(input.usernameFragment, (field) => boundedText(field, 256, 'candidate ufrag')),
  };
  if (candidateInit.sdpMid === null && candidateInit.sdpMLineIndex === null) fail('candidate');
  return candidateInit;
}

function iceServers(value: unknown): RemoteWebrtcIceServer[] {
  if (!Array.isArray(value) || value.length > MAX_ICE_SERVERS) fail('ice servers');
  return value.map((entry) => {
    const input = record(entry, 'ice server');
    const urls = Array.isArray(input.urls) ? input.urls : [input.urls];
    if (urls.length < 1 || urls.length > MAX_ICE_URLS) fail('ice server urls');
    const server: RemoteWebrtcIceServer = {
      // RFC 7064 (stun:, stuns:) and RFC 7065 (turn:, turns:) URIs.
      urls: urls.map((url) => {
        const text = boundedText(url, MAX_ICE_TEXT, 'ice server url');
        if (!/^(?:stuns?|turns?):[^\s]+$/u.test(text)) fail('ice server url');
        return text;
      }),
    };
    if (input.username !== undefined) server.username = boundedText(input.username, MAX_ICE_TEXT, 'ice username');
    if (input.credential !== undefined) {
      server.credential = boundedText(input.credential, MAX_ICE_TEXT, 'ice credential');
    }
    return server;
  });
}

/** An offer's ICE servers: they must include TURN, the only path allowed. */
function turnServers(value: unknown): RemoteWebrtcIceServer[] {
  const servers = iceServers(value);
  if (!remoteWebrtcHasTurn(servers)) fail('ice servers (no TURN)');
  return servers;
}

function relayPolicy(value: unknown): typeof REMOTE_WEBRTC_ICE_TRANSPORT_POLICY {
  if (value !== REMOTE_WEBRTC_ICE_TRANSPORT_POLICY) fail('ice transport policy');
  return REMOTE_WEBRTC_ICE_TRANSPORT_POLICY;
}

function closeReason(value: unknown): RemoteWebrtcCloseReason {
  if (typeof value !== 'string' || !CLOSE_REASONS.has(value)) fail('close reason');
  return value as RemoteWebrtcCloseReason;
}

function documentId(value: unknown): string {
  // The page document token the relay frames carry (`p<page>:<navigation>`).
  if (typeof value !== 'string' || value.length > 64 || !/^p[1-9]\d*:\d+$/u.test(value)) fail('document id');
  return value;
}

/** A phone's signal, as main receives it from the relay. */
export function parseRemoteWebrtcClientSignal(value: unknown): RemoteWebrtcClientSignal {
  const input = record(value, 'signal');
  switch (input.type) {
    case 'ready': {
      if (!Array.isArray(input.receiveCodecs) || input.receiveCodecs.length > MAX_CODECS) fail('receive codecs');
      const receiveCodecs = input.receiveCodecs.map((codec) => {
        if (typeof codec !== 'string' || !/^video\/[A-Za-z0-9.+-]{1,32}$/u.test(codec)) fail('receive codec');
        return codec;
      });
      if (input.videoLimit === undefined) return { ...sourceRef(input), type: 'ready', receiveCodecs };
      const limit = record(input.videoLimit, 'video limit');
      return {
        ...sourceRef(input),
        type: 'ready',
        receiveCodecs,
        videoLimit: {
          maxWidth: boundedInteger(limit.maxWidth, 64, MAX_PIXEL_DIMENSION, 'video limit width'),
          maxHeight: boundedInteger(limit.maxHeight, 64, MAX_PIXEL_DIMENSION, 'video limit height'),
        },
      };
    }
    case 'geometry-ack':
      return {
        ...sourceRef(input),
        type: 'geometry-ack',
        geometryGeneration: positiveInteger(input.geometryGeneration, 'geometry generation'),
      };
    case 'resize-request':
      return { ...sourceRef(input), type: 'resize-request', resize: resize(input.resize) };
    case 'answer': {
      const answer = { sdp: sdp(input.sdp), fingerprints: fingerprints(input.fingerprints) };
      assertRemoteWebrtcSdpFingerprints(answer.sdp, answer.fingerprints);
      return { ...connectionRef(input), type: 'answer', ...answer };
    }
    case 'candidate':
      return { ...connectionRef(input), type: 'candidate', candidate: candidate(input.candidate) };
    case 'media-ready':
      return {
        ...connectionRef(input),
        type: 'media-ready',
        // A screen has no documents: null there, a page document id otherwise.
        documentId:
          input.source && (input.source as Fields).kind === 'screen'
            ? input.documentId === null
              ? null
              : fail('document id')
            : documentId(input.documentId),
        geometryGeneration: positiveInteger(input.geometryGeneration, 'geometry generation'),
        pixelWidth: evenPixels(input.pixelWidth, 'media width'),
        pixelHeight: evenPixels(input.pixelHeight, 'media height'),
      };
    case 'promote-ack':
      return { ...connectionRef(input), type: 'promote-ack', inputEpoch: positiveInteger(input.inputEpoch, 'input epoch') };
    case 'demote-ack':
      return { ...connectionRef(input), type: 'demote-ack', inputEpoch: positiveInteger(input.inputEpoch, 'input epoch') };
    case 'close':
      return {
        ...connectionRef(input),
        type: 'close',
        reason: closeReason(input.reason),
        ...(input.detail === undefined ? {} : { detail: boundedText(input.detail, MAX_REASON_DETAIL, 'close detail') }),
      };
    default:
      return fail('signal type');
  }
}

/** The desktop's signal, as the phone receives it. */
export function parseRemoteWebrtcDesktopSignal(value: unknown): RemoteWebrtcDesktopSignal {
  const input = record(value, 'signal');
  switch (input.type) {
    case 'geometry':
      return { ...sourceRef(input), type: 'geometry', geometry: normalizeRemoteWebrtcGeometry(input.geometry) };
    case 'offer': {
      const offer = { sdp: sdp(input.sdp), fingerprints: fingerprints(input.fingerprints) };
      assertRemoteWebrtcSdpFingerprints(offer.sdp, offer.fingerprints);
      return {
        ...connectionRef(input),
        type: 'offer',
        ...offer,
        iceServers: turnServers(input.iceServers),
        iceTransportPolicy: relayPolicy(input.iceTransportPolicy),
        geometry: normalizeRemoteWebrtcGeometry(input.geometry),
        inputEpoch: positiveInteger(input.inputEpoch, 'input epoch'),
      };
    }
    case 'candidate':
      return { ...connectionRef(input), type: 'candidate', candidate: candidate(input.candidate) };
    case 'promote':
      return {
        ...connectionRef(input),
        type: 'promote',
        inputEpoch: positiveInteger(input.inputEpoch, 'input epoch'),
        geometryGeneration: positiveInteger(input.geometryGeneration, 'geometry generation'),
      };
    case 'demote':
      return {
        ...connectionRef(input),
        type: 'demote',
        inputEpoch: positiveInteger(input.inputEpoch, 'input epoch'),
        reason: closeReason(input.reason),
      };
    case 'close':
      return {
        ...connectionRef(input),
        type: 'close',
        reason: closeReason(input.reason),
        ...(input.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: boundedInteger(input.retryAfterMs, 0, Number.MAX_SAFE_INTEGER, 'retry after') }),
      };
    default:
      return fail('signal type');
  }
}

export function readRemoteWebrtcDesktopSignal(value: unknown): RemoteWebrtcDesktopSignal | null {
  try {
    return parseRemoteWebrtcDesktopSignal(value);
  } catch {
    return null;
  }
}

const PAGE_INPUT_TYPES: ReadonlySet<string> = new Set<RemoteWebrtcPageInput['type']>([
  'pointer',
  'wheel',
  'text',
  'key',
  'composition',
  'composition-end',
]);

function parseChannelText(text: unknown): Fields {
  if (typeof text !== 'string') fail('channel message');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('channel message');
  }
  const input = record(value, 'channel message');
  if (input.v !== REMOTE_WEBRTC_VERSION) fail('version');
  return input;
}

function count(value: unknown, what: string): number {
  return boundedNumber(value, 0, Number.MAX_SAFE_INTEGER, what);
}

function optional<T>(input: Fields, name: string, read: (value: unknown) => T): Partial<Record<string, T>> {
  return input[name] === undefined ? {} : { [name]: read(input[name]) };
}

const CANDIDATE_TYPES: ReadonlySet<string> = new Set(['host', 'srflx', 'prflx', 'relay']);

function candidatePair(value: unknown): RemoteWebrtcCandidatePairStats {
  const input = record(value, 'candidate pair');
  const type = (field: unknown): RemoteWebrtcCandidateType => {
    if (typeof field !== 'string' || !CANDIDATE_TYPES.has(field)) fail('candidate type');
    return field as RemoteWebrtcCandidateType;
  };
  if (input.protocol !== 'udp' && input.protocol !== 'tcp') fail('candidate protocol');
  if (input.relayProtocol !== undefined && !['udp', 'tcp', 'tls'].includes(String(input.relayProtocol))) {
    fail('relay protocol');
  }
  return {
    localType: type(input.localType),
    remoteType: type(input.remoteType),
    protocol: input.protocol,
    ...(input.relayProtocol === undefined
      ? {}
      : { relayProtocol: input.relayProtocol as RemoteWebrtcCandidatePairStats['relayProtocol'] }),
    ...optional(input, 'currentRoundTripTimeMs', (field) => count(field, 'round trip')),
    ...optional(input, 'availableOutgoingBitrate', (field) => count(field, 'outgoing bitrate')),
  };
}

function receiverStats(value: unknown): RemoteWebrtcReceiverStats {
  const input = record(value, 'stats');
  const label = (field: unknown): string => boundedText(field, 128, 'stats label');
  return {
    connectionId: connectionId(input.connectionId),
    generation: positiveInteger(input.generation, 'generation'),
    at: count(input.at, 'stats time'),
    ...optional(input, 'codec', label),
    ...optional(input, 'decoderImplementation', label),
    framesReceived: count(input.framesReceived, 'frames received'),
    framesDecoded: count(input.framesDecoded, 'frames decoded'),
    framesDropped: count(input.framesDropped, 'frames dropped'),
    totalDecodeTimeMs: count(input.totalDecodeTimeMs, 'decode time'),
    ...optional(input, 'jitterBufferDelayMs', (field) => count(field, 'jitter buffer delay')),
    ...optional(input, 'freezeCount', (field) => count(field, 'freeze count')),
    ...optional(input, 'inputRoundTripMs', (field) => count(field, 'input round trip')),
    ...optional(input, 'inputToVisibleMs', (field) => count(field, 'input to visible')),
    ...optional(input, 'frameWidth', (field) => count(field, 'frame width')),
    ...optional(input, 'frameHeight', (field) => count(field, 'frame height')),
    ...optional(input, 'candidatePair', candidatePair),
  } as RemoteWebrtcReceiverStats;
}

/** The order beside a relay control (throws when present but malformed). */
export function parseRemoteWebrtcRelayInputOrder(value: unknown): RemoteWebrtcRelayInputOrder {
  const input = record(value, 'input order');
  if (input.v !== REMOTE_WEBRTC_VERSION) fail('input order version');
  return {
    v: REMOTE_WEBRTC_VERSION,
    stream: opaqueId(input.stream, 'input stream'),
    run: positiveInteger(input.run, 'input run'),
    seq: positiveInteger(input.seq, 'input seq'),
  };
}

/** A data-channel message from the phone, as main receives it. Coordinate
 *  input is bounded by the local pane's own validator. */
export function parseRemoteWebrtcChannelFromClient(text: unknown): RemoteWebrtcChannelFromClient {
  const input = parseChannelText(text);
  if (input.kind === 'stats') return { v: REMOTE_WEBRTC_VERSION, kind: 'stats', stats: receiverStats(input.stats) };
  const envelope = {
    epoch: positiveInteger(input.epoch, 'input epoch'),
    seq: positiveInteger(input.seq, 'input seq'),
    geometryGeneration: positiveInteger(input.geometryGeneration, 'geometry generation'),
    sentAt: count(input.sentAt, 'input time'),
  };
  if (input.kind === 'screen-input') {
    return { v: REMOTE_WEBRTC_VERSION, kind: 'screen-input', ...envelope, control: parseRemoteScreenInput(input.control) };
  }
  if (input.kind !== 'input') fail('channel message kind');
  const control = record(input.control, 'input');
  if (!PAGE_INPUT_TYPES.has(String(control.type))) fail('input type');
  return {
    v: REMOTE_WEBRTC_VERSION,
    kind: 'input',
    ...envelope,
    control: normalizeRemoteBrowserControl(control) as RemoteWebrtcPageInput,
  };
}

const screenKey = (input: Fields): RemoteScreenKey => {
  const vk = boundedInteger(input.vk ?? 0, 0, 254, 'virtual key');
  const scan = boundedInteger(input.scan ?? 0, 0, 0xff, 'scan code');
  if (vk === 0 && scan === 0) fail('key');
  if (input.extended !== undefined && typeof input.extended !== 'boolean') fail('key extended');
  return { vk, scan, extended: input.extended === true };
};

const screenButton = (value: unknown): RemoteScreenButton => {
  if (value !== 'left' && value !== 'right' && value !== 'middle') fail('pointer button');
  return value;
};

/** One screen input (`control` of a `screen-input` message). */
export function parseRemoteScreenInput(value: unknown): RemoteScreenInput {
  const input = record(value, 'screen input');
  const coordinate = (field: unknown, what: string) => boundedNumber(field, 0, MAX_PIXEL_DIMENSION, what);
  switch (input.type) {
    case 'screen-pointer': {
      const x = coordinate(input.x, 'pointer x');
      const y = coordinate(input.y, 'pointer y');
      if (input.action === 'move') return { type: 'screen-pointer', action: 'move', x, y };
      if (input.action !== 'down' && input.action !== 'up') fail('pointer action');
      return { type: 'screen-pointer', action: input.action, button: screenButton(input.button), x, y };
    }
    case 'screen-wheel':
      return {
        type: 'screen-wheel',
        x: coordinate(input.x, 'wheel position'),
        y: coordinate(input.y, 'wheel position'),
        deltaX: boundedInteger(input.deltaX ?? 0, -MAX_SCREEN_WHEEL_UNITS, MAX_SCREEN_WHEEL_UNITS, 'wheel x'),
        deltaY: boundedInteger(input.deltaY ?? 0, -MAX_SCREEN_WHEEL_UNITS, MAX_SCREEN_WHEEL_UNITS, 'wheel y'),
      };
    case 'screen-key': {
      if (input.action !== 'down' && input.action !== 'up') fail('key action');
      return { type: 'screen-key', action: input.action, ...screenKey(input) };
    }
    case 'screen-keys': {
      if (!Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > MAX_REMOTE_SCREEN_COMBO_KEYS) {
        fail('key combo');
      }
      const keys = (input.keys as unknown[]).map((entry) => screenKey(record(entry, 'combo key')));
      const distinct = new Set(keys.map((key) => `${key.vk}:${key.scan}:${key.extended}`));
      if (distinct.size !== keys.length) fail('key combo repeats a key');
      return { type: 'screen-keys', keys };
    }
    case 'screen-text':
      if (typeof input.text !== 'string' || !input.text || input.text.length > MAX_REMOTE_SCREEN_TEXT) fail('text');
      return { type: 'screen-text', text: input.text };
    case 'screen-release':
      return { type: 'screen-release' };
    default:
      return fail('screen input type');
  }
}

const SCREEN_STATES: ReadonlySet<string> = new Set(['live', 'elevation-prompt', 'secure-desktop', 'stopped']);
const SCREEN_REASONS: ReadonlySet<string> = new Set([
  'uac',
  'lock',
  'secure',
  'user',
  'disabled',
  'revoked',
  'viewer-left',
  'superseded',
  'display-removed',
  'error',
]);
const SCREEN_HELPER: ReadonlySet<string> = new Set(['not-needed', 'active', 'starting', 'missing', 'failed']);

/** A `screen-status` channel message from the desktop, as the phone receives it. */
export function readRemoteWebrtcScreenStatus(text: unknown): RemoteWebrtcScreenStatusMessage | null {
  try {
    const input = parseChannelText(text);
    if (input.kind !== 'screen-status') return null;
    const status = record(input.status, 'screen status');
    if (!SCREEN_STATES.has(String(status.state)) || !SCREEN_HELPER.has(String(status.helper))) return null;
    if (status.reason !== undefined && !SCREEN_REASONS.has(String(status.reason))) return null;
    if (typeof status.control !== 'boolean') return null;
    return {
      v: REMOTE_WEBRTC_VERSION,
      kind: 'screen-status',
      status: {
        state: status.state as RemoteScreenStatus['state'],
        ...(status.reason === undefined ? {} : { reason: status.reason as NonNullable<RemoteScreenStatus['reason']> }),
        helper: status.helper as RemoteScreenHelperState,
        control: status.control,
      },
    };
  } catch {
    return null;
  }
}

/** A `screen-cursor` channel message from the desktop, as the phone receives it. */
export function readRemoteWebrtcScreenCursor(text: unknown): RemoteWebrtcScreenCursorMessage | null {
  try {
    const input = parseChannelText(text);
    if (input.kind !== 'screen-cursor') return null;
    return {
      v: REMOTE_WEBRTC_VERSION,
      kind: 'screen-cursor',
      x: boundedInteger(input.x, 0, MAX_PIXEL_DIMENSION - 1, 'cursor x'),
      y: boundedInteger(input.y, 0, MAX_PIXEL_DIMENSION - 1, 'cursor y'),
      generation: positiveInteger(input.generation, 'geometry generation'),
    };
  } catch {
    return null;
  }
}

/** A data-channel message from the desktop, as the phone receives it. */
export function readRemoteWebrtcChannelFromDesktop(text: unknown): RemoteWebrtcChannelFromDesktop | null {
  try {
    const input = parseChannelText(text);
    if (input.kind !== 'input-ack' || (input.outcome !== 'applied' && input.outcome !== 'rejected')) return null;
    return {
      v: REMOTE_WEBRTC_VERSION,
      kind: 'input-ack',
      epoch: positiveInteger(input.epoch, 'input epoch'),
      seq: positiveInteger(input.seq, 'input seq'),
      outcome: input.outcome,
      sentAt: count(input.sentAt, 'input time'),
      queuedMs: count(input.queuedMs, 'queued time'),
      dispatchMs: count(input.dispatchMs, 'dispatch time'),
    };
  } catch {
    return null;
  }
}
