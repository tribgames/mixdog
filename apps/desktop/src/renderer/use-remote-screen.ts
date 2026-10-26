// The whole-PC screen's WebRTC viewer: one `{kind:'screen', screenId}` source
// over the same viewer the browser pane uses. A screen has no JPEG relay view
// underneath, so the viewer offers to receive as soon as it exists, offers
// again whenever it falls back to the relay state, and any failure is shown
// (with a retry) instead of being covered by another picture.
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesktopApi } from '../shared/contract';
import type { RemoteScreenInput, RemoteScreenStatus } from '../shared/remote-webrtc';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { remoteWebrtcHost } from './remote-webrtc-bridge';
import { createRemoteWebrtcViewer, type RemoteWebrtcViewer } from './remote-webrtc-viewer';
import { createScreenCursorTracker, screenInputAllowed, screenView, type ScreenView } from './remote-screen-state';
import { STREAM_RENEW_MS } from './use-remote-browser-stream';
import { receiveCodecs } from './use-remote-webrtc';

const RELEASE: RemoteScreenInput = { type: 'screen-release' };

export function useRemoteScreen({
  api,
  screenId,
  onInputRejected,
}: {
  api: DesktopApi | undefined;
  screenId: string;
  /** The host acknowledged a screen key, combo or text as rejected. */
  onInputRejected?(): void;
}) {
  const rejectedRef = useRef(onInputRejected);
  rejectedRef.current = onInputRejected;
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<RemoteScreenStatus | null>(null);
  const [, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const viewerRef = useRef<RemoteWebrtcViewer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const supported = remoteWebrtcHost(api) && typeof RTCPeerConnection === 'function';
  // The tracker reads the viewer's newest geometry, so it never answers with a
  // cursor of an older one.
  const cursorRef = useRef<ReturnType<typeof createScreenCursorTracker> | null>(null);
  if (!cursorRef.current) {
    cursorRef.current = createScreenCursorTracker(() => viewerRef.current?.geometry?.generation ?? null);
  }
  const cursor = cursorRef.current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger; the viewer follows the host and the display.
  useEffect(() => {
    if (!supported || !remoteWebrtcHost(api)) return undefined;
    setStatus(null);
    cursor.clear();
    const viewer: RemoteWebrtcViewer = createRemoteWebrtcViewer({
      source: { kind: 'screen', screenId },
      signal: (signal) => api.remoteBrowserWebrtcSignal!(signal),
      // No relay input exists for a screen: nothing to order behind.
      fence: (work) => work(),
      createPeer: (configuration) => new RTCPeerConnection(configuration),
      receiveCodecs,
      documentId: () => '',
      dropInput: () => {},
      changed: () => {
        setVersion((version) => version + 1);
        // Back at the relay state (a cooldown lapsed): offer again.
        if (viewer.state === 'relay' && document.visibilityState !== 'hidden') viewer.start();
      },
      stream: setStream,
      screenStatus: (next) => {
        cursor.status(next);
        setStatus(next);
      },
      screenCursor: cursor.set,
      screenInputRejected: () => rejectedRef.current?.(),
      sessionEnded: cursor.clear,
      failure: () => {},
      statsIntervalMs: STREAM_RENEW_MS,
      log: (line) => console.info(line),
    });
    viewerRef.current = viewer;
    const unsubscribe = api.onRemoteBrowserWebrtc!((signal) => viewer.handle(signal));
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        // Nothing stays pressed on the PC while this page is away.
        viewer.sendInput(RELEASE);
        viewer.stop();
      } else viewer.start();
    };
    const reconnected = () => {
      viewer.reconnected();
      viewer.start();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, reconnected);
    visibility();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, reconnected);
      unsubscribe();
      viewer.sendInput(RELEASE);
      viewer.dispose();
      viewerRef.current = null;
      setStream(null);
    };
  }, [supported, api, screenId, attempt]);

  // The track plays muted inline; each presented frame reports its size, which
  // the desktop's media-ready check needs before it promotes the connection.
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
  const view: ScreenView = supported
    ? screenView({ transport: viewer?.state ?? 'relay', showsVideo, status })
    : { kind: 'failed' };
  const viewRef = useRef(view);
  viewRef.current = view;
  // Gated on the newest view, not the one a callback was made in.
  const send = useCallback(
    (input: RemoteScreenInput): boolean =>
      screenInputAllowed(input, viewRef.current) && (viewerRef.current?.sendInput(input) ?? false),
    []
  );
  const retry = useCallback(() => setAttempt((count) => count + 1), []);
  // The viewer is a ref: its state reaches this render through `setVersion`.
  return {
    videoRef,
    view,
    status,
    showsVideo,
    geometry: viewer?.geometry ?? null,
    send,
    retry,
    /** The PC cursor in video pixels, or null until it is reported. */
    cursor: cursor.read,
    /** Changes when a cursor kept by the touch layer goes stale. */
    cursorStamp: cursor.stamp,
  };
}
