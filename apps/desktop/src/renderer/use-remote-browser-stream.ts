import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import type {
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserStreamOptions,
  DesktopRemoteBrowserViewport,
} from '../shared/contract';
import { remoteBrowserDriveViewport } from '../shared/remote-browser';
import { browserTakeoverPending, onBrowserTakeoverChange } from './browser-takeover-input';
import type { RemoteInputFrame } from './remote-browser-input-client';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { REMOTE_VIDEO_LIMIT_MAX } from './remote-view-zoom';
import { remoteBrowserFitState } from './remote-webrtc-bridge';

/** The desktop stops a stream that is not renewed for 4s. */
export const STREAM_RENEW_MS = 2_000;
/** How long a take-over stays covered waiting for its fit to settle (or
 *  fail): the host stops a stream it was not renewed for within two renewals
 *  (STREAM_EXPIRY_MS, 4 s, main/browser/remote-control.ts), so a fit that has
 *  not pictured by then is treated as lost: the pane watches instead. */
export const FIT_WAIT_MS = 2 * STREAM_RENEW_MS;
export { REMOTE_CONNECTION_READY_EVENT };
const FALLBACK_STREAM_BOX = { maxWidth: 1280, maxHeight: 720 };

export type StreamFrameMeta = Omit<DesktopRemoteBrowserStreamFrame, 'image'>;

const NO_INPUT_GEOMETRY = { width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 };

/** Input maps through the image shown only while it is the picture the
 *  newest frame describes. A frame describing none (0×0: its size's first
 *  image is still to come) or another size than the one shown refuses input
 *  (0×0) rather than mapping it through stale geometry; the old image may
 *  stay on screen meanwhile. */
function inputGeometry(
  described: Pick<DesktopRemoteBrowserStreamFrame, 'width' | 'height' | 'viewportWidth' | 'viewportHeight'>,
  shown: { width: number; height: number } | null
): Omit<RemoteInputFrame, 'documentId'> {
  const { width, height, viewportWidth, viewportHeight } = described;
  const valid =
    width > 0 &&
    height > 0 &&
    viewportWidth > 0 &&
    viewportHeight > 0 &&
    shown?.width === width &&
    shown.height === height;
  return valid ? { width, height, viewportWidth, viewportHeight } : NO_INPUT_GEOMETRY;
}

/** The stream request: a take-over's carries its fit (the opening box) and a
 *  frame bound covering it in device pixels; a watching one only the box's. */
function streamOptions(
  box: { width: number; height: number } | null | undefined,
  scale: number,
  fit: DesktopRemoteBrowserViewport | null
): DesktopRemoteBrowserStreamOptions {
  if (fit) {
    return {
      maxWidth: Math.min(REMOTE_VIDEO_LIMIT_MAX, Math.ceil(fit.width * fit.deviceScaleFactor)),
      maxHeight: Math.min(REMOTE_VIDEO_LIMIT_MAX, Math.ceil(fit.height * fit.deviceScaleFactor)),
      fit,
    };
  }
  return box && box.width > 0 && box.height > 0
    ? { maxWidth: Math.round(box.width * scale), maxHeight: Math.round(box.height * scale) }
    : FALLBACK_STREAM_BOX;
}

async function decodeImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode === 'function') await image.decode();
}

/** The live frame stream of one remote page: subscription, decode/present/ACK,
 *  and the start/renew/stop lifecycle. A take-over view (a browser takeover of
 *  the session waits on the user) asks the host to fit the page to this pane
 *  once, and shows no frame until one of the fitted page arrives
 *  (`awaitingFit`: the pane stays covered meanwhile); a watching view keeps
 *  the page's own geometry. */
export function useRemoteBrowserStream({
  api,
  active,
  ownerSessionId,
  contentRef,
  frameRef,
  imageSize,
  addressFocused,
  resetDocumentInput,
  setFrame,
  setImageUrl,
  setFailure,
  setActionFailure,
  setAddress,
  onFrame,
  onPresented,
}: {
  /** A frame's metadata was applied; whether it named another document. */
  onFrame?: (documentChanged: boolean) => void;
  /** A frame's image is now shown. */
  onPresented?: () => void;
  api: typeof window.mixdogDesktop;
  active: boolean;
  ownerSessionId: string;
  contentRef: MutableRefObject<HTMLDivElement | null>;
  /** Geometry of the newest displayed frame; the input adapter reads it. */
  frameRef: MutableRefObject<RemoteInputFrame | null>;
  imageSize: MutableRefObject<{ width: number; height: number } | null>;
  addressFocused: MutableRefObject<boolean>;
  /** Drops the old document's queued/coalesced input and held buttons. */
  resetDocumentInput: () => void;
  setFrame: Dispatch<SetStateAction<StreamFrameMeta | null>>;
  setImageUrl: Dispatch<SetStateAction<string>>;
  setFailure: Dispatch<SetStateAction<string>>;
  setActionFailure: Dispatch<SetStateAction<string>>;
  setAddress: Dispatch<SetStateAction<string>>;
}) {
  /** The fit a take-over waits to see the first frame of; null: not waiting. */
  const fitRef = useRef<DesktopRemoteBrowserViewport | null>(null);
  /** While waiting: the viewport the newest `fitSettled` frame described. */
  const settledRef = useRef<{ viewportWidth: number; viewportHeight: number } | null>(null);
  const [awaitingFit, setAwaitingFit] = useState(false);
  /** The bound on the cover (FIT_WAIT_MS); 0: none armed. */
  const fitTimerRef = useRef(0);
  /** This subscription's take-over: `fit` is the opening box sent on every
   *  renewal; `abandoned` gives the fit up while the takeover still waits
   *  (it failed or never pictured), so it is not asked for again; `release`
   *  (nonzero) is a `fit: null` the host has not confirmed, resent on every
   *  renewal until a request carrying it succeeds — a renewal without `fit`
   *  keeps a take-over. */
  const takeoverRef = useRef({
    fit: null as DesktopRemoteBrowserViewport | null,
    abandoned: false,
    release: 0,
    serial: 0,
  });
  /** Lift the cover (the wait ended, either way). */
  const uncover = () => {
    if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = 0;
    fitRef.current = null;
    settledRef.current = null;
    setAwaitingFit(false);
  };
  /** Give up this subscription's fit: the pane watches, and the host is told
   *  (`release`). `giveUp`: the takeover still waits, so do not fit again. */
  const abandonFit = (giveUp: boolean) => {
    uncover();
    const takeover = takeoverRef.current;
    if (takeover.fit) {
      takeover.fit = null;
      takeover.serial += 1;
      takeover.release = takeover.serial;
    }
    takeover.abandoned = giveUp;
  };
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const onPresentedRef = useRef(onPresented);
  onPresentedRef.current = onPresented;
  // Newest frame for this session only. A metadata-only frame keeps the last
  // image; a frame is acknowledged once its image is decoded and displayed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and state setters are stable; the subscription follows the session and its input owners.
  useEffect(() => {
    if (!active || !api?.onRemoteBrowserFrame) return undefined;
    let disposed = false;
    let imageToken = 0;
    /** The newest frame's facts; its described picture gates input. */
    let latest: StreamFrameMeta | null = null;
    /** Metadata is applied the moment a frame arrives, image or not. */
    const applyMetadata = (next: DesktopRemoteBrowserStreamFrame) => {
      const { image: _image, ...meta } = next;
      const previous = frameRef.current;
      if (previous && previous.documentId !== next.documentId) {
        // The old document's queued/coalesced input and held buttons must not
        // reach the new page. Releases still name the document they pressed.
        resetDocumentInput();
        setActionFailure('');
      }
      latest = meta;
      frameRef.current = { documentId: next.documentId, ...inputGeometry(next, imageSize.current) };
      setFrame(meta);
      setFailure('');
      if (!addressFocused.current) setAddress(next.url === 'about:blank' ? '' : next.url);
      onFrameRef.current?.(previous?.documentId !== next.documentId);
    };
    const unsubscribe = api.onRemoteBrowserFrame((next) => {
      if (next.sessionId !== ownerSessionId) return;
      applyMetadata(next);
      // The fit could not be applied: no settled frame will come, so the
      // take-over stops waiting and shows the page as when watching.
      if (takeoverRef.current.fit && next.fitFailed === true) abandonFit(true);
      const awaited = fitRef.current;
      // The host marks frames of the settled (fitted) layout; the video's
      // picture is the fitted page once it shows this viewport.
      if (awaited && next.fitSettled === true && next.viewportWidth > 0 && next.viewportHeight > 0) {
        settledRef.current = { viewportWidth: next.viewportWidth, viewportHeight: next.viewportHeight };
      }
      // A take-over never shows the page before its layout settled (another
      // viewer's stream, or a frame still in flight): such frames are
      // acknowledged, not shown.
      if (!next.image || (awaited && next.fitSettled !== true)) {
        api.remoteBrowserStreamAck?.(ownerSessionId, next.seq);
        return;
      }
      const token = ++imageToken;
      const url = `data:${next.image.mimeType};base64,${next.image.data}`;
      const present = () => {
        if (disposed || token !== imageToken) return;
        imageSize.current = { width: next.width, height: next.height };
        // The newest frame's picture may be this one, now shown.
        if (latest) frameRef.current = { documentId: latest.documentId, ...inputGeometry(latest, imageSize.current) };
        setImageUrl(url);
        if (awaited && fitRef.current === awaited) uncover();
        api.remoteBrowserStreamAck?.(ownerSessionId, next.seq);
        onPresentedRef.current?.();
      };
      decodeImage(url).then(present, present);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [active, api, ownerSessionId, resetDocumentInput]);

  // Live view: start, renew every ~2s while shown, stop when hidden/inactive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs and state setters are stable; the stream follows the session.
  useEffect(() => {
    if (!active || !api?.remoteBrowserStream) return undefined;
    setFailure('');
    setActionFailure('');
    let timer = 0;
    let running = false;
    const takeover = takeoverRef.current;
    /** Cover the pane until `fit` settles, for at most FIT_WAIT_MS. */
    const cover = (fit: DesktopRemoteBrowserViewport) => {
      fitRef.current = fit;
      settledRef.current = null;
      imageSize.current = null;
      setImageUrl('');
      setAwaitingFit(true);
      if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
      fitTimerRef.current = window.setTimeout(() => {
        fitTimerRef.current = 0;
        if (!running || fitRef.current !== fit) return;
        // Neither settled nor failed in time: watch, and tell the host now.
        abandonFit(true);
        renew();
      }, FIT_WAIT_MS);
    };
    const renew = () => {
      const box = contentRef.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      // Only a host advertising `browserFit` fits the page (once; then
      // nothing — keyboard, rotation, renewals — moves it) and marks its
      // frames; elsewhere the view watches and is never covered.
      // While no host is authenticated ('unknown') nothing that depends on
      // the capability changes: a fit is kept, and so is a pending release,
      // which is resent once the host is back.
      const fitState = remoteBrowserFitState(api);
      const waiting = browserTakeoverPending(ownerSessionId);
      if (!waiting || fitState === 'unsupported') {
        // The take-over ended (or the host does not fit): watching again;
        // the host restores the page and its next frames show it.
        if (takeover.fit) abandonFit(false);
        takeover.abandoned = false;
      }
      // An authenticated host without `browserFit` has no take-over to release.
      if (fitState === 'unsupported') takeover.release = 0;
      if (fitState === 'supported' && waiting && !takeover.fit && !takeover.abandoned) {
        const fit = remoteBrowserDriveViewport(box, scale);
        if (fit) {
          takeover.fit = fit;
          takeover.release = 0;
          cover(fit);
        }
      }
      const options = streamOptions(box, scale, takeover.fit);
      const release = takeover.fit ? 0 : takeover.release;
      api.remoteBrowserStream!(ownerSessionId, release ? { ...options, fit: null } : options).then(
        () => {
          // Confirmed by the host's reply to a request that carried it.
          if (release && takeover.release === release) takeover.release = 0;
        },
        (error: unknown) => {
          if (running) setFailure(error instanceof Error ? error.message : String(error));
        }
      );
    };
    // A takeover beginning or ending switches the view at once, not at the next renewal.
    const offTakeover = onBrowserTakeoverChange((sessionId) => {
      if (sessionId !== ownerSessionId) return;
      const pending = browserTakeoverPending(sessionId);
      // A given-up fit belongs to the takeover that ended; the next may fit.
      if (!pending) takeover.abandoned = false;
      if (running && Boolean(takeover.fit) !== pending) renew();
    });
    const begin = () => {
      if (running) return;
      running = true;
      // A new stream (the host ended the last one): a take-over keeps its
      // opening box and waits for it again; one that ended while hidden is
      // abandoned by `renew`.
      if (
        takeover.fit &&
        remoteBrowserFitState(api) !== 'unsupported' &&
        browserTakeoverPending(ownerSessionId)
      ) {
        cover(takeover.fit);
      }
      renew();
      timer = window.setInterval(renew, STREAM_RENEW_MS);
    };
    const end = () => {
      if (!running) return;
      running = false;
      window.clearInterval(timer);
      if (fitTimerRef.current) window.clearTimeout(fitTimerRef.current);
      fitTimerRef.current = 0;
      api.remoteBrowserStream!(ownerSessionId, null).catch(() => {});
    };
    const visibility = () => (document.visibilityState === 'hidden' ? end() : begin());
    // A fresh relay connection lost the desktop's stream state: start again so
    // the view resyncs at once instead of waiting for the next renewal.
    const reconnected = () => {
      if (running) renew();
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, reconnected);
    visibility();
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, reconnected);
      offTakeover();
      end();
      uncover();
      // Ending the subscription ends its take-over: nothing left to release.
      takeoverRef.current = { fit: null, abandoned: false, release: 0, serial: takeover.serial };
    };
  }, [active, api, ownerSessionId]);
  return {
    awaitingFit,
    /** The WebRTC video (promoted, so no JPEG image comes) shows a frame of
     *  this geometry: once it is the settled layout a `fitSettled` frame
     *  described, the pane uncovers. */
    videoShown(frame: Pick<RemoteInputFrame, 'width' | 'height' | 'viewportWidth' | 'viewportHeight'>): void {
      const settled = settledRef.current;
      if (!fitRef.current || !settled || !(frame.width > 0) || !(frame.height > 0)) return;
      if (frame.viewportWidth !== settled.viewportWidth || frame.viewportHeight !== settled.viewportHeight) return;
      uncover();
    },
  };
}
