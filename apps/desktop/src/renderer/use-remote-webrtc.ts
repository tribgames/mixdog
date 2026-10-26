// The remote browser pane's WebRTC live view: one viewer per streamed page
// while the connected host serves `browserWebrtc` and this device has
// RTCPeerConnection; the JPEG relay view runs underneath and takes over on
// any failure. Page input goes to whichever path owns it.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { DesktopApi, DesktopRemoteBrowserControl } from '../shared/contract';
import type { RemoteWebrtcPageInput, RemoteWebrtcResize } from '../shared/remote-webrtc';
import type { createRemoteBrowserInputQueue } from './remote-browser-input';
import type { RemoteInputFrame } from './remote-browser-input-client';
import { remoteWebrtcHost } from './remote-webrtc-bridge';
import {
  REMOTE_WEBRTC_SWITCHING_MESSAGE,
  createRemoteWebrtcViewer,
  type RemoteWebrtcViewer,
} from './remote-webrtc-viewer';
import { remoteVideoInputFrame } from './remote-view-zoom';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';

type InputQueue = ReturnType<typeof createRemoteBrowserInputQueue>;

const PAGE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'pointer',
  'wheel',
  'text',
  'key',
  'composition',
  'composition-end',
]);

/** The page input a data channel may carry (dialog answers and navigation stay on the relay). */
export function remoteWebrtcPageInput(control: DesktopRemoteBrowserControl): control is RemoteWebrtcPageInput {
  return PAGE_INPUT_TYPES.has(control.type);
}

/** One owner per input: the channel while the video owns it, nothing while
 *  ownership is switching after a channel failure, otherwise the relay. */
export function routeRemoteInput(
  viewer: Pick<RemoteWebrtcViewer, 'owner' | 'sendInput'> | null,
  queue: Pick<InputQueue, 'enqueue'>,
  control: DesktopRemoteBrowserControl,
  failure: (message: string) => void
): Promise<void> {
  if (viewer && remoteWebrtcPageInput(control)) {
    if (viewer.owner === 'channel') {
      if (!viewer.sendInput(control)) failure(REMOTE_WEBRTC_SWITCHING_MESSAGE);
      return Promise.resolve();
    }
    if (viewer.owner === 'held') {
      failure(REMOTE_WEBRTC_SWITCHING_MESSAGE);
      return Promise.resolve();
    }
  }
  return queue.enqueue(control);
}

/** The video codecs this device decodes, as `ready` names them. */
function receiveCodecs(): string[] {
  const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs ?? [];
  return [...new Set(codecs.map((codec) => codec.mimeType))].filter((type) =>
    /^video\/[A-Za-z0-9.+-]{1,32}$/u.test(type)
  );
}

export function useRemoteWebrtc({
  api,
  active,
  sessionId,
  queue,
  frameRef,
  dropInput,
  failure,
  statsIntervalMs,
}: {
  api: DesktopApi | undefined;
  active: boolean;
  sessionId: string;
  queue: InputQueue;
  /** The newest relay frame's facts (its document names media-ready). */
  frameRef: RefObject<RemoteInputFrame | null>;
  dropInput: () => void;
  failure: (message: string) => void;
  statsIntervalMs: number;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [, setVersion] = useState(0);
  const viewerRef = useRef<RemoteWebrtcViewer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const dropRef = useRef(dropInput);
  dropRef.current = dropInput;
  const failureRef = useRef(failure);
  failureRef.current = failure;
  // The host locks the page geometry whether or not this device can take video.
  const geometryLocked = remoteWebrtcHost(api);
  const enabled = active && geometryLocked && typeof RTCPeerConnection === 'function';

  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable; the viewer follows the host, page and queue.
  useEffect(() => {
    if (!enabled || !remoteWebrtcHost(api)) return undefined;
    const viewer = createRemoteWebrtcViewer({
      source: { kind: 'browser', sessionId },
      signal: (signal) => api.remoteBrowserWebrtcSignal!(signal),
      fence: (work) => queue.fence(work),
      createPeer: (configuration) => new RTCPeerConnection(configuration),
      receiveCodecs,
      documentId: () => frameRef.current?.documentId ?? '',
      dropInput: () => dropRef.current(),
      changed: () => setVersion((version) => version + 1),
      stream: setStream,
      failure: (message) => failureRef.current(message),
      statsIntervalMs,
      log: (line) => console.info(line),
    });
    viewerRef.current = viewer;
    const unsubscribe = api.onRemoteBrowserWebrtc!((signal) => viewer.handle(signal));
    // Offered once the relay view streams (the first frame), as the stream runs.
    const visibility = () => {
      if (document.visibilityState === 'hidden') viewer.stop();
      else if (frameRef.current) viewer.start();
    };
    const reconnected = () => viewer.reconnected();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, reconnected);
    visibility();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, reconnected);
      unsubscribe();
      viewer.dispose();
      viewerRef.current = null;
      setStream(null);
    };
  }, [enabled, api, sessionId, queue, statsIntervalMs]);

  // The track plays muted inline; each presented frame reports its size
  // (media-ready, input geometry) and capture time (input → visible).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream;
    if (!stream) return undefined;
    void Promise.resolve(video.play()).catch(() => {});
    if (typeof video.requestVideoFrameCallback !== 'function') return undefined;
    let handle = 0;
    const presented: VideoFrameRequestCallback = (_now, frame) => {
      viewerRef.current?.framePresented({
        width: frame.width,
        height: frame.height,
        captureTime: frame.captureTime,
        expectedDisplayTime: frame.expectedDisplayTime,
      });
      handle = video.requestVideoFrameCallback(presented);
    };
    handle = video.requestVideoFrameCallback(presented);
    return () => video.cancelVideoFrameCallback(handle);
  }, [stream]);

  const viewer = viewerRef.current;
  const showsVideo = Boolean(viewer?.showsVideo && stream);
  const route = useCallback(
    (control: DesktopRemoteBrowserControl) =>
      routeRemoteInput(viewerRef.current, queue, control, (message) => failureRef.current(message)),
    [queue]
  );
  return useMemo(
    () => ({
      videoRef,
      showsVideo,
      geometryLocked,
      /** Input geometry: the video's while it is the picture, else `fallback`. */
      inputFrame(fallback: RemoteInputFrame | null): RemoteInputFrame | null {
        const current = viewerRef.current;
        if (!current?.showsVideo || !fallback) return fallback;
        return remoteVideoInputFrame(fallback.documentId, current.geometry, current.presented);
      },
      /** The decoded picture size, for the pinch ceiling. */
      videoSource(): { width: number; height: number } | null {
        return viewerRef.current?.presented ?? null;
      },
      route,
      requestResize(resize: RemoteWebrtcResize): void {
        void viewerRef.current?.requestResize(resize);
      },
      /** A relay frame arrived (metadata applied). */
      relayFrame(documentChanged: boolean): void {
        const current = viewerRef.current;
        if (!current) return;
        if (document.visibilityState !== 'hidden') current.start();
        if (documentChanged) current.documentChanged();
      },
      relayPresented(): void {
        viewerRef.current?.relayPresented();
      },
    }),
    [showsVideo, geometryLocked, route]
  );
}
