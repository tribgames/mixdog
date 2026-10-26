// The whole-PC screen's WebRTC viewer: one `{kind:'screen', screenId}` source
// over the same viewer the browser pane uses. A screen has no JPEG relay view
// underneath, so the viewer offers to receive as soon as it exists, offers
// again whenever it falls back to the relay state, and any failure is shown
// (with a retry) instead of being covered by another picture.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DesktopApi } from '../shared/contract';
import type { RemoteScreenInput, RemoteScreenStatus } from '../shared/remote-webrtc';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { remoteWebrtcHost } from './remote-webrtc-bridge';
import { createRemoteWebrtcViewer, type RemoteWebrtcViewer } from './remote-webrtc-viewer';
import { createControllerKeys } from './remote-screen-controller-key';
import {
  createScreenHelperGrants,
  createScreenHelperInstall,
  readScreenHelperBlock,
  screenGrantSurfaceActive,
} from './remote-screen-helper';
import { createScreenCursorTracker, screenInputAllowed, screenView, type ScreenView } from './remote-screen-state';
import { STREAM_RENEW_MS } from './use-remote-browser-stream';
import { receiveCodecs } from './use-remote-webrtc';

const RELEASE: RemoteScreenInput = { type: 'screen-release' };

/** How long a pressed install button waits for the PC's status before it can
 *  be pressed again (the person at the PC may be slow, the request may be lost). */
const HELPER_REQUEST_WAIT_MS = 15_000;

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
  // The secure-desktop helper: this pairing's controller key, and the install
  // request that enrolls it. A request in flight lasts until the PC's next
  // status (its answer) or the wait runs out.
  const keysRef = useRef<ReturnType<typeof createControllerKeys> | null>(null);
  keysRef.current ??= createControllerKeys();
  const keys = keysRef.current;
  const [helperPending, setHelperPending] = useState(false);
  const viewRef = useRef<ScreenView>({ kind: 'connecting' });
  // Signs the PC's helper challenges for the run on screen, right away, and
  // only while this pane is shown and the page visible.
  const grantsRef = useRef<ReturnType<typeof createScreenHelperGrants<RemoteWebrtcViewer>> | null>(null);
  grantsRef.current ??= createScreenHelperGrants<RemoteWebrtcViewer>({
    key: keys.load,
    epoch: () => viewerRef.current?.videoEpoch ?? null,
    active: () => screenGrantSurfaceActive(viewRef.current, document.visibilityState),
    origin: () => viewerRef.current,
    // Through the viewer the challenge came from, never whichever is current.
    send: (message, origin) => origin.sendHelperMessage(message),
  });
  const grants = grantsRef.current;
  // The helper is asked for only by the phone's password sheet (the other way
  // is the PC's own Computer Use setup); a screen session never asks by itself.
  const requestInstall = useMemo(
    () =>
      createScreenHelperInstall({
        ensureKey: keys.ensure,
        send: (message) => viewerRef.current?.sendHelperMessage(message) ?? false,
      }),
    [keys]
  );
  const installHelper = useCallback(
    async (
      action: Parameters<typeof requestInstall>[0],
      credential: Parameters<typeof requestInstall>[1]
    ): Promise<boolean> => {
      setHelperPending(true);
      const sent = await requestInstall(action, credential);
      if (!sent) setHelperPending(false);
      return sent;
    },
    [requestInstall]
  );
  useEffect(() => {
    if (!helperPending) return undefined;
    const timer = window.setTimeout(() => setHelperPending(false), HELPER_REQUEST_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [helperPending]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger; the viewer follows the host and the display.
  useEffect(() => {
    if (!supported || !remoteWebrtcHost(api)) return undefined;
    setStatus(null);
    setHelperPending(false);
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
        // The PC's status is its answer to a pending helper request.
        setHelperPending(false);
      },
      screenCursor: cursor.set,
      screenHelperChallenge: (challenge) => void grants.challenge(challenge, viewer),
      screenInputRejected: () => rejectedRef.current?.(),
      sessionEnded: () => {
        grants.invalidate();
        cursor.clear();
      },
      failure: () => {},
      statsIntervalMs: STREAM_RENEW_MS,
      log: (line) => console.info(line),
    });
    // A replaced viewer ends every challenge the old one began.
    grants.invalidate();
    viewerRef.current = viewer;
    const unsubscribe = api.onRemoteBrowserWebrtc!((signal) => viewer.handle(signal));
    const visibility = () => {
      grants.invalidate();
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
      grants.invalidate();
      viewer.sendInput(RELEASE);
      viewer.dispose();
      viewerRef.current = null;
      setStream(null);
    };
  }, [supported, api, screenId, attempt, cursor, grants]);

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
        receiveTime: frame.receiveTime,
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
  viewRef.current = view;
  // Any change of the signing surface (shown ↔ not shown) ends the challenges
  // begun before it, whichever way it went.
  const grantSurface = screenGrantSurfaceActive(view, document.visibilityState);
  useEffect(() => {
    grants.invalidate();
  }, [grantSurface, grants]);
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
    geometry: viewer?.geometry ?? null,
    send,
    retry,
    /** The helper block of the latest status, or null (an older PC). */
    helper: readScreenHelperBlock(status),
    /** An install / update request was sent and the PC has not answered. */
    helperPending,
    /** The password sheet's submit: enroll this phone's key and ask the PC to
     *  install (or update) the helper with the typed Windows password. False
     *  when the request could not be sent. */
    installHelper,
    /** The PC cursor in video pixels, or null until it is reported. */
    cursor: cursor.read,
    /** Changes when a cursor kept by the touch layer goes stale. */
    cursorStamp: cursor.stamp,
  };
}
