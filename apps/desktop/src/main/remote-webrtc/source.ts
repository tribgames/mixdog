/**
 * A video source the WebRTC sender streams: the browser page of a session, or
 * the whole PC screen (remote-screen/screen-webrtc-sources.ts). Main owns
 * capture; the sender only encodes what a source hands it.
 */
import type {
  RemoteScreenCapturePlan,
  RemoteWebrtcChannelPush,
  RemoteWebrtcClientSignal,
  RemoteWebrtcGeometry,
  RemoteWebrtcSourceInput,
  RemoteWebrtcResize,
  RemoteWebrtcSource,
  RemoteWebrtcVideoLimit,
} from '../../shared/remote-webrtc';

/** One captured picture, at any size: the sender scales it to the geometry. */
export interface RemoteWebrtcPicture {
  /** The document it shows; null for a source without documents (a screen). */
  documentId: string | null;
  geometry: RemoteWebrtcGeometry;
  mimeType: 'image/jpeg' | 'image/png';
  /** Base64 image bytes. */
  data: string;
}

/** How a source reaches the WebRTC host. */
export interface RemoteWebrtcSourceSink {
  /** The source locked a new geometry generation, or ended (null). */
  geometryChanged(sourceKey: string, geometry: RemoteWebrtcGeometry | null): void;
  /** A new picture; the host keeps only the newest per source. */
  frame(sourceKey: string, picture: RemoteWebrtcPicture): void;
  /** A captured source's plan changed (display changed): reopen its track. */
  captureChanged(sourceKey: string): void;
  /** A desktop → phone channel message (a screen's status or cursor) to each
   *  viewer of the source whose channel is up (promoting or webrtc); dropped
   *  for the others, which get `channelState()` when they promote. */
  channelPush(sourceKey: string, message: RemoteWebrtcChannelPush): void;
}

export interface RemoteWebrtcVideoSource {
  readonly source: RemoteWebrtcSource;
  /** A WebRTC viewer needs frames (idempotent). A browser page is captured by
   *  its stream already, so this is a no-op there. */
  start(): void;
  /** No WebRTC viewer of this source remains (idempotent). */
  stop(): void;
  /** What the source shows now; documentId null for a source without documents. */
  page(): { documentId: string | null; geometry: RemoteWebrtcGeometry | null };
  /** A validated channel input, through the source's own authorization and
   *  dispatch path (for a browser page: the relay path's, serialized; for a
   *  screen: its input host). Page input for a browser source, screen input
   *  for a screen — the viewer never mixes them. Rejects when not applied. */
  dispatch(control: RemoteWebrtcSourceInput): Promise<void>;
  /** A source whose track is a desktop capture: its current plan. The sender
   *  opens the track from it instead of drawing pushed pictures. */
  capturePlan?(): RemoteScreenCapturePlan | null;
  /** An explicit resize-request; a source that cannot resize ignores it. */
  resize?(request: RemoteWebrtcResize): Promise<void>;
  /** The phone's video limit (`ready`): a source may capture larger than its
   *  frame bound, up to it, locking a new geometry. */
  videoLimit?(limit: RemoteWebrtcVideoLimit): void;
  /** Input left the channel (demotion or the viewer leaving): release every
   *  key and button this source holds for the viewer. Without it, the host
   *  dispatches the mouse releases the viewer tracked. */
  release?(): Promise<void>;
  /** What a channel gets when it is promoted (a screen: its status and
   *  cursor), before any later `channelPush`. */
  channelState?(): RemoteWebrtcChannelPush[];
}

/** The paired client a signal came from, and that signal's type. A screen
 *  source is opened per client, and only by its `ready`. */
export interface RemoteWebrtcSourceViewer {
  clientId: string;
  signal: RemoteWebrtcClientSignal['type'];
}

/** Finds the source a viewer names, or null when it is not streamed now (or
 *  not to this client). */
export type RemoteWebrtcSourceResolver = (
  source: RemoteWebrtcSource,
  viewer: RemoteWebrtcSourceViewer
) => RemoteWebrtcVideoSource | null;
