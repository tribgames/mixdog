/**
 * Main ↔ sender renderer: the hidden trusted window that owns every
 * RTCPeerConnection of the live view. Main decides; the sender only runs the
 * peer connections, feeds the per-source video tracks and reports back.
 */
import type {
  REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
  RemoteScreenCapturePlan,
  RemoteWebrtcCandidate,
  RemoteWebrtcIceServer,
  RemoteWebrtcSenderStats,
} from './remote-webrtc';

export const REMOTE_WEBRTC_SENDER_IPC = {
  /** main → sender: RemoteWebrtcSenderCommand. */
  command: 'remote-webrtc-sender:command',
  /** sender → main: RemoteWebrtcSenderEvent. */
  event: 'remote-webrtc-sender:event',
} as const;

/** One captured picture of a source, newest only. */
export type RemoteWebrtcSenderFrame = {
  sourceKey: string;
  /** Monotonic per source; the sender answers `frame-done` with it. */
  frameId: number;
  /** The locked geometry's pixel size: the track's frame size. */
  pixelWidth: number;
  pixelHeight: number;
} & (
  | {
      mimeType: 'image/jpeg' | 'image/png';
      /** Base64 image bytes. */
      data: string;
    }
  | {
      /** A screen's secure-desktop helper frame, raw: `height` rows `stride`
       *  bytes apart, `width` pixels of B, G, R, X bytes (the fourth
       *  ignored). The sender crops `source` out of them and scales it onto
       *  `target` of the `pixelWidth × pixelHeight` picture; the rest is black. */
      mimeType: 'image/x-bgrx';
      pixels: Uint8Array;
      width: number;
      height: number;
      stride: number;
      source: { x: number; y: number; width: number; height: number };
      target: { x: number; y: number; width: number; height: number };
    }
);

export type RemoteWebrtcSenderCommand =
  | {
      type: 'open';
      connectionId: string;
      sourceKey: string;
      iceServers: RemoteWebrtcIceServer[];
      iceTransportPolicy: typeof REMOTE_WEBRTC_ICE_TRANSPORT_POLICY;
      /** The receiver's decodable codecs; the sender offers only these. */
      receiveCodecs: string[];
    }
  | { type: 'answer'; connectionId: string; sdp: string }
  | { type: 'candidate'; connectionId: string; candidate: RemoteWebrtcCandidate | null }
  | { type: 'channel-send'; connectionId: string; text: string }
  /** Applied with RTCRtpSender.setParameters: no renegotiation, no restart. */
  | { type: 'encoding'; connectionId: string; maxBitrate?: number; maxFramerate?: number }
  | { type: 'stats'; connectionId: string; requestId: number }
  | { type: 'close'; connectionId: string }
  | ({ type: 'frame' } & RemoteWebrtcSenderFrame)
  /** A source whose track is a desktop capture (a screen), opened from its
   *  plan instead of drawn from pictures; re-sent with a new plan when the
   *  display geometry changes. Must precede that source's `open`. */
  | { type: 'source-capture'; sourceKey: string; plan: RemoteScreenCapturePlan }
  /** A captured source switches to a drawn track (a screen while the
   *  secure-desktop helper serves): every connection's sender is moved onto
   *  it with replaceTrack, and `frame` pictures draw into it. A later
   *  `source-capture` switches back. */
  | { type: 'source-draw'; sourceKey: string }
  | { type: 'source-close'; sourceKey: string };

export type RemoteWebrtcSenderFailure = 'ice-failed' | 'dtls-failed' | 'channel-failed' | 'unsupported';

export type RemoteWebrtcSenderEvent =
  | { type: 'ready' }
  | { type: 'offer'; connectionId: string; sdp: string }
  | { type: 'candidate'; connectionId: string; candidate: RemoteWebrtcCandidate | null }
  /** DTLS is up; the peer certificate the transport negotiated. */
  | {
      type: 'connected';
      connectionId: string;
      remoteCertificate: { fingerprint?: string; fingerprintAlgorithm?: string } | null;
    }
  | { type: 'failed'; connectionId: string; reason: RemoteWebrtcSenderFailure; detail?: string }
  | { type: 'channel'; connectionId: string; text: string; receivedAt: number }
  | {
      type: 'stats';
      connectionId: string;
      requestId: number;
      stats: Omit<RemoteWebrtcSenderStats, 'framesCaptured' | 'framesSuperseded'> | null;
    }
  | { type: 'frame-done'; sourceKey: string; frameId: number; ok: boolean }
  /** A `source-capture` track opened (or failed: its connections fail too). */
  | { type: 'source-captured'; sourceKey: string; ok: boolean; detail?: string };
