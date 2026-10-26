/**
 * Live view over WebRTC: the wire contract between the desktop (main and its
 * hidden sender renderer) and a paired phone. Signaling rides the existing
 * end-to-end encrypted relay channel; video and page input ride a direct peer
 * connection once it has proved itself, and the JPEG relay view stays up until
 * then and comes back on any failure. docs/remote-webrtc.md is the spec.
 */
import type { DesktopRemoteBrowserPageInput } from './contract';
import { normalizeRemoteBrowserControl } from './remote-browser';
import { isSecureDesktopControllerKey } from './secure-desktop-grant';

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

/** RTCIceCandidateInit as it travels: a host, srflx, prflx or relay
 *  candidate in strict RFC 8839 syntax, or the empty end-of-candidates line. */
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

/** Direct first, this deployment's TURN as the fallback: both ends gather and
 *  try host, srflx, prflx and relay candidates, and ICE's own pair priorities
 *  prefer a direct pair over a relayed one (docs/remote-webrtc.md). When no
 *  pair works, the JPEG relay view stays. */
export const REMOTE_WEBRTC_ICE_TRANSPORT_POLICY = 'all' as const;

/** The policies an offer may carry: hosts before direct-first sent `'relay'`
 *  (TURN only); the phone applies whichever its host sent. */
export type RemoteWebrtcIceTransportPolicy = typeof REMOTE_WEBRTC_ICE_TRANSPORT_POLICY | 'relay';

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
  /** Sent only by hosts before direct-first ICE, when no TURN server was
   *  available; still understood (JPEG stays). */
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
      iceTransportPolicy: RemoteWebrtcIceTransportPolicy;
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
  | { v: typeof REMOTE_WEBRTC_VERSION; kind: 'stats'; stats: RemoteWebrtcReceiverStats }
  /** A screen viewer rendered a frame of video run `epoch` (see
   *  `RemoteWebrtcScreenVideoMessage`): the receipt evidence that grants
   *  control on the helper path. Not input: never acked, never gated. */
  | RemoteWebrtcScreenFrameSeenMessage
  /** Screen sources only, and not input either (never acked, never gated by
   *  the input epoch): a signed helper grant, and the install request. */
  | RemoteWebrtcScreenHelperGrantMessage
  | RemoteWebrtcScreenHelperInstallMessage;

/** Phone → desktop: the first frame the phone presented
 *  (`requestVideoFrameCallback`) whose `metadata.receiveTime` is later than
 *  the arrival of `screen-video` run `epoch` was rendered. Sent once per run,
 *  for every run (the desktop ignores it where no evidence is needed). A
 *  phone whose frame metadata has no `receiveTime` does not send it. */
export interface RemoteWebrtcScreenFrameSeenMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-frame-seen';
  epoch: number;
}

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

/** The secure-desktop helper for this viewer: `failed` is an installed
 *  service that could not be started; `in-use` is a helper another viewer's
 *  session holds (it serves one at a time), so this one can't use it until
 *  that session lets go. */
export type RemoteScreenHelperState = 'not-needed' | 'active' | 'starting' | 'missing' | 'failed' | 'in-use';

export type RemoteScreenStopReason =
  | 'user'
  | 'disabled'
  | 'revoked'
  | 'viewer-left'
  | 'superseded'
  | 'display-removed'
  | 'error';

/** What the phone may ask of the PC's secure-desktop helper: an install, an
 *  update of an outdated one, or nothing (installed, another Windows
 *  account's, not available on this build, or not known yet). */
export type RemoteScreenHelperOffer = 'install' | 'update' | 'none';

/** How the last install request ended (main/secure-desktop/install-request.ts).
 *  The `*-credentials`/`*-admin`/account/policy values are the remote
 *  batch-logon path's refusals; the UAC path never produces them. */
export type RemoteScreenHelperInstallOutcome =
  | 'installed'
  | 'updated'
  | 'enrolled'
  | 'revoked'
  | 'declined'
  | 'failed'
  | 'in-progress'
  | 'other-user'
  | 'unavailable'
  | 'bad-credentials'
  | 'not-admin'
  | 'logon-type-denied'
  | 'account-locked'
  | 'account-disabled'
  | 'policy-blocked';

/** The helper's advisory codes the phone is told about
 *  (native/mixdog-secure-desktop/docs/ipc-spec.md, "Error codes"). */
export type RemoteScreenHelperIssue =
  | 'grant_key_missing'
  | 'grant_expired'
  | 'input_failed'
  | 'desktop_unavailable'
  | 'sas_disabled_by_policy';

export const REMOTE_SCREEN_HELPER_ISSUES: readonly RemoteScreenHelperIssue[] = [
  'grant_key_missing',
  'grant_expired',
  'input_failed',
  'desktop_unavailable',
  'sas_disabled_by_policy',
];

/** An install outcome's diagnostic, at most this long: the installer's own
 *  are under 140 characters; a launch error's message is cut to it. */
export const MAX_REMOTE_SCREEN_HELPER_DETAIL = 256;

/** The secure-desktop helper part of `screen-status`. */
export interface RemoteScreenHelperInfo {
  offer: RemoteScreenHelperOffer;
  /** How this session's last install request ended; null before one. */
  outcome: RemoteScreenHelperInstallOutcome | null;
  /** That outcome's short diagnostic (`failed`, `in-progress`); null without one. */
  detail: string | null;
  /** The helper's standing advisory code; null when none stands. */
  issue: RemoteScreenHelperIssue | null;
  /** Which secure screen is up: the lock / sign-in screen, or an elevation
   *  prompt; null on the ordinary desktop or when it can't be told. */
  secure: 'lock' | 'uac' | null;
}

/** A screen source's state, pushed on the data channel as `screen-status`. */
export interface RemoteScreenStatus {
  state: 'live' | 'elevation-prompt' | 'secure-desktop' | 'stopped';
  reason?: 'uac' | 'lock' | 'secure' | RemoteScreenStopReason;
  helper: RemoteScreenHelperState;
  /** Input is currently accepted from this viewer. */
  control: boolean;
  helperInfo: RemoteScreenHelperInfo;
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

/** Where a screen's picture comes from: the desktop capture, or the
 *  secure-desktop helper's frames. */
export type RemoteScreenVideoPath = 'capture' | 'helper';

/** Desktop → phone on the channel: video run `epoch` (a positive integer,
 *  increasing per session) of `path` is on the track from now on. A new run
 *  starts on every path change, when the helper's frames stall, and when the
 *  viewer's channel goes (demote, viewer left). A `capture` run is announced
 *  at once; a `helper` run once its first frame is in the track the
 *  connection sends. Also sent once when the channel is promoted. The phone
 *  answers each run with `screen-frame-seen`. */
export interface RemoteWebrtcScreenVideoMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-video';
  epoch: number;
  path: RemoteScreenVideoPath;
}

/**
 * Desktop → phone: a secure-desktop helper challenge (protocol v4 control
 * grants) to sign for video run `epoch`, the run the desktop declared to the
 * helper when it forwarded it. The phone signs it with
 * `signSecureDesktopGrant(privateKey, {nonce, challenge}, epoch)`
 * (shared/secure-desktop-grant.ts) and answers `screen-helper-grant`. Sent
 * while the helper's control is active (at once, then every 2 s); never in
 * the promotion snapshot (a challenge lives 5 s, the next comes sooner).
 * `nonce` and `challenge`: 16 bytes each, canonical padded base64.
 */
export interface RemoteWebrtcScreenHelperChallengeMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-helper-challenge';
  epoch: number;
  nonce: string;
  challenge: string;
}

/** Phone → desktop: a signed answer to `screen-helper-challenge`, relayed to
 *  the helper only when `epoch` is the current video run. `challenge` as it
 *  came; `signature`: the 64-byte P-256 `r ‖ s`, canonical padded base64 (what
 *  `signSecureDesktopGrant` returns). */
export interface RemoteWebrtcScreenHelperGrantMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-helper-grant';
  epoch: number;
  challenge: string;
  signature: string;
}

/** A Windows administrator credential the phone types for the remote install
 *  path (no one is at the PC to answer UAC). It rides the DTLS-encrypted,
 *  fingerprint-verified screen channel. `user` is optional: omitted, the PC
 *  uses the account running the app (it is never sent to or taken from the
 *  phone). The desktop never echoes a credential back in any message. */
export interface RemoteScreenHelperCredential {
  /** Windows account password, at most `CREDUI_MAX_PASSWORD_LENGTH` UTF-16 units. */
  password: string;
  /** Optional account name, at most `CREDUI_MAX_USERNAME_LENGTH` UTF-16 units. */
  user?: string;
}

/** Windows' documented credential-field maxima (wincred.h / the
 *  *CredUIPromptForCredentials* docs), in UTF-16 units; the bounds on a
 *  credential's fields on the wire, so an oversized field is rejected. */
export const CREDUI_MAX_USERNAME_LENGTH = 513;
export const CREDUI_MAX_PASSWORD_LENGTH = 256;

/** Phone → desktop: install (or update) the secure-desktop helper, enrolling
 *  this controller key (`generateSecureDesktopControllerKey().publicKey`:
 *  unpadded base64url of the 65-byte uncompressed P-256 point) and any extra
 *  `keys` (other paired phones, each a controller key; at most the pairing cap
 *  `MAX_REMOTE_SCREEN_HELPER_KEYS`). With no `credential`, one UAC prompt on
 *  the PC; with one, the remote batch-logon path and no prompt. The outcome
 *  arrives in `screen-status`. */
export interface RemoteWebrtcScreenHelperInstallMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-helper-install';
  publicKey: string;
  keys?: string[];
  credential?: RemoteScreenHelperCredential;
}

/** Phone → desktop: enroll this phone's controller key into an already-installed
 *  helper (with a `credential`, the batch-logon path; otherwise the PC decides
 *  UAC or the app-delegated path). The outcome arrives in `screen-status`. */
export interface RemoteWebrtcScreenHelperEnrollMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-helper-enroll';
  publicKey: string;
  credential?: RemoteScreenHelperCredential;
}

/** Phone → desktop: revoke this phone's controller key. Same authorization
 *  options as enroll. */
export interface RemoteWebrtcScreenHelperRevokeMessage {
  v: typeof REMOTE_WEBRTC_VERSION;
  kind: 'screen-helper-revoke';
  publicKey: string;
  credential?: RemoteScreenHelperCredential;
}

/** The most controller keys one `screen-helper-install` may carry, the relay's
 *  cap on phones paired to one desktop (`MAX_PAIRED_CLIENTS_PER_DEVICE`). */
export const MAX_REMOTE_SCREEN_HELPER_KEYS = 256;

/** A signed grant as main relays it (`screen-helper-grant` without its envelope). */
export type RemoteScreenHelperGrant = Omit<RemoteWebrtcScreenHelperGrantMessage, 'v' | 'kind'>;

/** What a source pushes to its viewer's channel (desktop → phone). */
export type RemoteWebrtcChannelPush =
  | RemoteWebrtcScreenStatusMessage
  | RemoteWebrtcScreenCursorMessage
  | RemoteWebrtcScreenVideoMessage
  | RemoteWebrtcScreenHelperChallengeMessage;

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

/** Which path the selected pair settled on: `relay` when either end is a TURN
 *  relay candidate, `direct` otherwise (host, srflx or prflx on both ends). */
export function remoteWebrtcCandidatePath(pair: RemoteWebrtcCandidatePairStats): 'direct' | 'relay' {
  return pair.localType === 'relay' || pair.remoteType === 'relay' ? 'relay' : 'direct';
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

/** An SDP blob as signaled: a string of at most 64 KiB starting `v=0`, never
 *  ice-lite. Returns it unchanged; throws on anything else. */
export function parseRemoteWebrtcSdp(value: unknown): string {
  const text = boundedText(value, MAX_SDP_LENGTH, 'sdp');
  if (!text.startsWith('v=0')) fail('sdp');
  // Both ends run full ICE.
  if (/^a=ice-lite\b/mu.test(text)) fail('sdp ice-lite');
  return text;
}

/** RFC 8839 §5.1 candidate-attribute: foundation, component, transport,
 *  priority, address, port, type, the optional related address and port, then
 *  name/value extensions (`generation`, `ufrag`, `network-id`, `tcptype`…). */
const CANDIDATE_LINE = new RegExp(
  '^candidate:[A-Za-z0-9+/]{1,32} (\\d{1,3}) (udp|tcp) (\\d{1,10}) (\\S+) (\\d{1,5}) typ (?:host|srflx|prflx|relay)' +
    '(?: raddr (\\S+) rport (\\d{1,5}))?((?: (?!raddr |rport |typ )[a-z][a-z0-9-]{0,31} [\\x21-\\x7e]{1,256})*)$',
  'iu'
);

/** RFC 6544 §4.5 tcp-type values. */
const TCP_TYPES: ReadonlySet<string> = new Set(['active', 'passive', 'so']);

/** A TCP candidate carries exactly one `tcptype` of a known value, a UDP one
 *  none. `extensions` is the matched ` name value` run; neither name nor value
 *  holds a space, so its fields alternate name, value. */
function tcpTypeFits(transport: string, extensions: string): boolean {
  const fields = extensions.split(' ').slice(1);
  const tcpTypes: string[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    if (fields[index]!.toLowerCase() === 'tcptype') tcpTypes.push(fields[index + 1]!.toLowerCase());
  }
  return transport.toLowerCase() === 'tcp'
    ? tcpTypes.length === 1 && TCP_TYPES.has(tcpTypes[0]!)
    : tcpTypes.length === 0;
}

function ipv4Address(text: string): boolean {
  const parts = text.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
}

function ipv6Address(text: string): boolean {
  if (!/^[0-9A-Fa-f:.]{2,45}$/u.test(text)) return false;
  // An embedded IPv4 address may only be the last 32 bits of the text itself
  // (RFC 4291 §2.2): checked there, then counted as the two groups it stands
  // for, so a dotted group anywhere else fails the hex check below.
  const tail = text.slice(text.lastIndexOf(':') + 1);
  const embedded = tail.includes('.');
  if (embedded && !ipv4Address(tail)) return false;
  const hex = embedded ? `${text.slice(0, text.length - tail.length)}0:0` : text;
  const halves = hex.split('::');
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half ? half.split(':') : []));
  if (!groups.every((group) => /^[0-9A-Fa-f]{1,4}$/u.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

/** An IP address, or the `.local` name a browser puts in place of a private
 *  host address (mDNS, draft-ietf-mmusic-mdns-ice-candidates). */
function candidateAddress(text: string): boolean {
  return (
    ipv4Address(text) ||
    ipv6Address(text) ||
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){1,4}local$/iu.test(text)
  );
}

/** Whether `line` is one well-formed RFC 8839 candidate attribute value of type
 *  host, srflx, prflx or relay: component 1–256, 32-bit priority, an IPv4/IPv6
 *  address or mDNS `.local` name, ports ≤ 65535, `tcptype` exactly on TCP. The
 *  empty end-of-candidates line is not a candidate line. */
export function isRemoteWebrtcCandidateLine(line: string): boolean {
  const match = CANDIDATE_LINE.exec(line);
  if (!match) return false;
  const [, component, transport, priority, address, port, relatedAddress, relatedPort, extensions] = match;
  return (
    tcpTypeFits(transport!, extensions!) &&
    Number(component) >= 1 &&
    Number(component) <= 256 &&
    Number(priority) <= 0xffff_ffff &&
    candidateAddress(address) &&
    Number(port) <= 65_535 &&
    (relatedAddress === undefined || (candidateAddress(relatedAddress) && Number(relatedPort) <= 65_535))
  );
}

/** A signaled `RTCIceCandidateInit`: `null` (end of all candidates), or a line
 *  that is empty (end of one generation) or passes
 *  `isRemoteWebrtcCandidateLine`, with bounded `sdpMid` / `sdpMLineIndex`
 *  (at least one) and `usernameFragment`. Throws on anything else. */
export function parseRemoteWebrtcCandidate(value: unknown): RemoteWebrtcCandidate | null {
  if (value === null) return null;
  const input = record(value, 'candidate');
  const line = boundedText(input.candidate, MAX_CANDIDATE_LENGTH, 'candidate');
  if (line && !isRemoteWebrtcCandidateLine(line)) fail('candidate');
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

/** A signaled ICE server list (empty allowed, at most `MAX_ICE_SERVERS`):
 *  each entry's `urls` is normalized to an array (a scalar becomes one
 *  element) of 1–`MAX_ICE_URLS` stun:/stuns:/turn:/turns: URIs; `username` and
 *  `credential` are kept when given, bounded. Throws on anything else. */
export function parseRemoteWebrtcIceServers(value: unknown): RemoteWebrtcIceServer[] {
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

function transportPolicy(value: unknown): RemoteWebrtcIceTransportPolicy {
  if (value !== REMOTE_WEBRTC_ICE_TRANSPORT_POLICY && value !== 'relay') fail('ice transport policy');
  return value as RemoteWebrtcIceTransportPolicy;
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
      const answer = { sdp: parseRemoteWebrtcSdp(input.sdp), fingerprints: fingerprints(input.fingerprints) };
      assertRemoteWebrtcSdpFingerprints(answer.sdp, answer.fingerprints);
      return { ...connectionRef(input), type: 'answer', ...answer };
    }
    case 'candidate':
      return { ...connectionRef(input), type: 'candidate', candidate: parseRemoteWebrtcCandidate(input.candidate) };
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
      const offer = { sdp: parseRemoteWebrtcSdp(input.sdp), fingerprints: fingerprints(input.fingerprints) };
      assertRemoteWebrtcSdpFingerprints(offer.sdp, offer.fingerprints);
      return {
        ...connectionRef(input),
        type: 'offer',
        ...offer,
        // Any list, even an empty one: host candidates alone connect on one LAN.
        iceServers: parseRemoteWebrtcIceServers(input.iceServers),
        iceTransportPolicy: transportPolicy(input.iceTransportPolicy),
        geometry: normalizeRemoteWebrtcGeometry(input.geometry),
        inputEpoch: positiveInteger(input.inputEpoch, 'input epoch'),
      };
    }
    case 'candidate':
      return { ...connectionRef(input), type: 'candidate', candidate: parseRemoteWebrtcCandidate(input.candidate) };
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
  if (input.kind === 'screen-frame-seen') {
    return { v: REMOTE_WEBRTC_VERSION, kind: 'screen-frame-seen', epoch: positiveInteger(input.epoch, 'video epoch') };
  }
  if (input.kind === 'screen-helper-grant') return helperGrantMessage(input);
  if (input.kind === 'screen-helper-install') return helperInstallMessage(input);
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
const SCREEN_HELPER: ReadonlySet<string> = new Set(['not-needed', 'active', 'starting', 'missing', 'failed', 'in-use']);
const HELPER_OFFERS: ReadonlySet<string> = new Set(['install', 'update', 'none']);
const HELPER_OUTCOMES: ReadonlySet<string> = new Set([
  'installed',
  'updated',
  'enrolled',
  'revoked',
  'declined',
  'failed',
  'in-progress',
  'other-user',
  'unavailable',
  'bad-credentials',
  'not-admin',
  'logon-type-denied',
  'account-locked',
  'account-disabled',
  'policy-blocked',
]);
const HELPER_ISSUES: ReadonlySet<string> = new Set(REMOTE_SCREEN_HELPER_ISSUES);
const SECURE_SCREENS: ReadonlySet<string> = new Set(['lock', 'uac']);

/** A string in `allowed`. Checked as a string first: `String(['x'])` is
 *  `'x'`, so a stringified membership test would let an array through. */
function isMember(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}

/** `value` when it is null or in `allowed`; throws otherwise. */
function nullableMember<T extends string>(value: unknown, allowed: ReadonlySet<string>, what: string): T | null {
  if (value === null) return null;
  if (!isMember(value, allowed)) fail(what);
  return value as T;
}

function helperInfo(value: unknown): RemoteScreenHelperInfo {
  const input = record(value, 'helper info');
  if (!isMember(input.offer, HELPER_OFFERS)) fail('helper offer');
  return {
    offer: input.offer as RemoteScreenHelperOffer,
    outcome: nullableMember<RemoteScreenHelperInstallOutcome>(input.outcome, HELPER_OUTCOMES, 'helper outcome'),
    detail: input.detail === null ? null : boundedText(input.detail, MAX_REMOTE_SCREEN_HELPER_DETAIL, 'helper detail'),
    issue: nullableMember<RemoteScreenHelperIssue>(input.issue, HELPER_ISSUES, 'helper issue'),
    secure: nullableMember<'lock' | 'uac'>(input.secure, SECURE_SCREENS, 'secure screen'),
  };
}

/** A `screen-status` channel message from the desktop, as the phone receives it. */
export function readRemoteWebrtcScreenStatus(text: unknown): RemoteWebrtcScreenStatusMessage | null {
  try {
    const input = parseChannelText(text);
    if (input.kind !== 'screen-status') return null;
    const status = record(input.status, 'screen status');
    if (!isMember(status.state, SCREEN_STATES) || !isMember(status.helper, SCREEN_HELPER)) return null;
    if (status.reason !== undefined && !isMember(status.reason, SCREEN_REASONS)) return null;
    if (typeof status.control !== 'boolean') return null;
    return {
      v: REMOTE_WEBRTC_VERSION,
      kind: 'screen-status',
      status: {
        state: status.state as RemoteScreenStatus['state'],
        ...(status.reason === undefined ? {} : { reason: status.reason as NonNullable<RemoteScreenStatus['reason']> }),
        helper: status.helper as RemoteScreenHelperState,
        control: status.control,
        helperInfo: helperInfo(status.helperInfo),
      },
    };
  } catch {
    return null;
  }
}

/** The helper's 16-byte nonce and challenge, and the phone's 64-byte P-256
 *  `r ‖ s` signature: canonical padded base64, the helper's own wire encoding
 *  (native/mixdog-secure-desktop/docs/ipc-spec.md) and what
 *  `signSecureDesktopGrant` takes and returns. 16 and 64 bytes both leave one
 *  byte over a multiple of three: a last group of two characters (the second
 *  with its four low bits zero) and `==`. */
const HELPER_NONCE = /^[A-Za-z0-9+/]{21}[AQgw]==$/u;
const HELPER_SIGNATURE = /^[A-Za-z0-9+/]{85}[AQgw]==$/u;

function helperBase64(value: unknown, pattern: RegExp, what: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(what);
  return value;
}

function helperChallengeMessage(input: Fields): RemoteWebrtcScreenHelperChallengeMessage {
  return {
    v: REMOTE_WEBRTC_VERSION,
    kind: 'screen-helper-challenge',
    epoch: positiveInteger(input.epoch, 'video epoch'),
    nonce: helperBase64(input.nonce, HELPER_NONCE, 'helper nonce'),
    challenge: helperBase64(input.challenge, HELPER_NONCE, 'helper challenge'),
  };
}

function helperGrantMessage(input: Fields): RemoteWebrtcScreenHelperGrantMessage {
  return {
    v: REMOTE_WEBRTC_VERSION,
    kind: 'screen-helper-grant',
    epoch: positiveInteger(input.epoch, 'video epoch'),
    challenge: helperBase64(input.challenge, HELPER_NONCE, 'helper challenge'),
    signature: helperBase64(input.signature, HELPER_SIGNATURE, 'helper signature'),
  };
}

/** A credential's fields on the wire, length-bounded by the Windows maxima.
 *  Never echoed back by the desktop. Absent → undefined (the UAC path). */
function helperCredential(value: unknown): RemoteScreenHelperCredential | undefined {
  if (value === undefined || value === null) return undefined;
  const input = record(value, 'credential');
  if (typeof input.password !== 'string' || !input.password || input.password.length > CREDUI_MAX_PASSWORD_LENGTH) {
    fail('credential password');
  }
  const credential: RemoteScreenHelperCredential = { password: input.password as string };
  if (input.user !== undefined && input.user !== null) {
    if (typeof input.user !== 'string' || input.user.length > CREDUI_MAX_USERNAME_LENGTH) fail('credential user');
    if (input.user) credential.user = input.user;
  }
  return credential;
}

/** The optional extra controller keys of an install, each validated; at most
 *  the pairing cap. */
function helperKeys(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_REMOTE_SCREEN_HELPER_KEYS) fail('helper keys');
  const keys = value.map((entry) => {
    if (!isSecureDesktopControllerKey(entry)) fail('controller key');
    return entry as string;
  });
  return keys;
}

function helperInstallMessage(input: Fields): RemoteWebrtcScreenHelperInstallMessage {
  if (!isSecureDesktopControllerKey(input.publicKey)) fail('controller key');
  const keys = helperKeys(input.keys);
  const credential = helperCredential(input.credential);
  return {
    v: REMOTE_WEBRTC_VERSION,
    kind: 'screen-helper-install',
    publicKey: input.publicKey,
    ...(keys ? { keys } : {}),
    ...(credential ? { credential } : {}),
  };
}

function helperEnrollMessage(input: Fields): RemoteWebrtcScreenHelperEnrollMessage {
  if (!isSecureDesktopControllerKey(input.publicKey)) fail('controller key');
  const credential = helperCredential(input.credential);
  return {
    v: REMOTE_WEBRTC_VERSION,
    kind: 'screen-helper-enroll',
    publicKey: input.publicKey,
    ...(credential ? { credential } : {}),
  };
}

function helperRevokeMessage(input: Fields): RemoteWebrtcScreenHelperRevokeMessage {
  if (!isSecureDesktopControllerKey(input.publicKey)) fail('controller key');
  const credential = helperCredential(input.credential);
  return {
    v: REMOTE_WEBRTC_VERSION,
    kind: 'screen-helper-revoke',
    publicKey: input.publicKey,
    ...(credential ? { credential } : {}),
  };
}

/** Desktop: the `screen-helper-challenge` for a helper challenge and the
 *  current video run; throws TypeError on a malformed one (never forwarded). */
export function remoteWebrtcScreenHelperChallenge(
  epoch: number,
  challenge: { nonce: string; challenge: string }
): RemoteWebrtcScreenHelperChallengeMessage {
  return helperChallengeMessage({ epoch, nonce: challenge.nonce, challenge: challenge.challenge });
}

/** A `screen-helper-challenge` channel message from the desktop, as the phone receives it. */
export function readRemoteWebrtcScreenHelperChallenge(text: unknown): RemoteWebrtcScreenHelperChallengeMessage | null {
  try {
    const input = parseChannelText(text);
    return input.kind === 'screen-helper-challenge' ? helperChallengeMessage(input) : null;
  } catch {
    return null;
  }
}

/** Phone: the channel text of a `screen-helper-grant`; throws TypeError on a
 *  malformed grant. */
export function encodeRemoteWebrtcScreenHelperGrant(grant: RemoteScreenHelperGrant): string {
  return JSON.stringify(helperGrantMessage({ ...grant }));
}

/** Phone: the channel text of a `screen-helper-install`. `keys` are extra
 *  controller keys to enroll, `credential` the Windows password for the remote
 *  (no-prompt) path. Throws TypeError on an invalid key, an over-long
 *  credential field, or too many keys. */
export function encodeRemoteWebrtcScreenHelperInstall(
  publicKey: string,
  options: { keys?: string[]; credential?: RemoteScreenHelperCredential } = {},
): string {
  return JSON.stringify(
    helperInstallMessage({ publicKey, keys: options.keys, credential: options.credential }),
  );
}

/** Phone: the channel text of a `screen-helper-enroll`. */
export function encodeRemoteWebrtcScreenHelperEnroll(
  publicKey: string,
  options: { credential?: RemoteScreenHelperCredential } = {},
): string {
  return JSON.stringify(helperEnrollMessage({ publicKey, credential: options.credential }));
}

/** Phone: the channel text of a `screen-helper-revoke`. */
export function encodeRemoteWebrtcScreenHelperRevoke(
  publicKey: string,
  options: { credential?: RemoteScreenHelperCredential } = {},
): string {
  return JSON.stringify(helperRevokeMessage({ publicKey, credential: options.credential }));
}

/** Desktop: read a phone's `screen-helper-enroll` (null when it is not one or
 *  is malformed). Enroll/revoke are read with their own functions rather than
 *  through `parseRemoteWebrtcChannelFromClient`: they are not input and carry
 *  no epoch/seq, so they stay off the input dispatch path. */
export function readRemoteWebrtcScreenHelperEnroll(text: unknown): RemoteWebrtcScreenHelperEnrollMessage | null {
  try {
    const input = parseChannelText(text);
    return input.kind === 'screen-helper-enroll' ? helperEnrollMessage(input) : null;
  } catch {
    return null;
  }
}

/** Desktop: read a phone's `screen-helper-revoke` (null when not one or malformed). */
export function readRemoteWebrtcScreenHelperRevoke(text: unknown): RemoteWebrtcScreenHelperRevokeMessage | null {
  try {
    const input = parseChannelText(text);
    return input.kind === 'screen-helper-revoke' ? helperRevokeMessage(input) : null;
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

/** A `screen-video` channel message from the desktop, as the phone receives it. */
export function readRemoteWebrtcScreenVideo(text: unknown): RemoteWebrtcScreenVideoMessage | null {
  try {
    const input = parseChannelText(text);
    if (input.kind !== 'screen-video' || (input.path !== 'capture' && input.path !== 'helper')) return null;
    return {
      v: REMOTE_WEBRTC_VERSION,
      kind: 'screen-video',
      epoch: positiveInteger(input.epoch, 'video epoch'),
      path: input.path,
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
