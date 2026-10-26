import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import type { DesktopRemoteBrowserStreamFrame } from '../shared/contract';
import { remoteBrowserDriveViewport } from '../shared/remote-browser';
import type { RemoteInputFrame } from './remote-browser-input-client';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';
import { isMobileDeviceSurface } from './mobile-surface';

/** The desktop stops a stream that is not renewed for 4s. */
export const STREAM_RENEW_MS = 2_000;
/** A drag-resize or rotation settles before the host page is resized. */
export const VIEWPORT_DEBOUNCE_MS = 150;
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

/** The visible window height: a raised soft keyboard shortens it. */
function windowHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

/** A phone or tablet with a text field focused and the window shorter than
 *  `sentHeight` (the height when the size was last sent): its soft keyboard
 *  is what shortens the pane. Never on a desktop, whose window resizes. */
function softKeyboardUp(sentHeight: number): boolean {
  if (!isMobileDeviceSurface() || !(windowHeight() < sentHeight)) return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  if (active.tagName === 'TEXTAREA' || active.isContentEditable) return true;
  return (
    active.tagName === 'INPUT' &&
    !['button', 'checkbox', 'radio', 'range', 'submit'].includes((active as HTMLInputElement).type)
  );
}

async function decodeImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode === 'function') await image.decode();
}

/** The live frame stream of one remote page: subscription, decode/present/ACK,
 *  and the start/renew/stop lifecycle. */
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
}: {
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
}): void {
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
    };
    const unsubscribe = api.onRemoteBrowserFrame((next) => {
      if (next.sessionId !== ownerSessionId) return;
      applyMetadata(next);
      if (!next.image) {
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
        api.remoteBrowserStreamAck?.(ownerSessionId, next.seq);
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
    let resizeTimer = 0;
    let running = false;
    /** The box last sent; kept while the soft keyboard is what shrank it. */
    let sentBox: { width: number; height: number } | null = null;
    /** The window height when `sentBox` was measured. */
    let sentWindowHeight = 0;
    const renew = () => {
      const measured = contentRef.current?.getBoundingClientRect();
      // Typing on a phone raises the soft keyboard, which only shortens the
      // box; like a phone browser (its layout viewport stays), the host page
      // keeps its size instead of re-laying out and restarting the stream on
      // every keyboard show and hide. The frame fits the shorter box meanwhile.
      const held = Boolean(
        sentBox &&
          measured &&
          measured.width === sentBox.width &&
          measured.height < sentBox.height &&
          softKeyboardUp(sentWindowHeight)
      );
      const box = held ? sentBox : measured;
      if (!held && measured && measured.width > 0 && measured.height > 0) {
        sentBox = { width: measured.width, height: measured.height };
        sentWindowHeight = windowHeight();
      }
      const scale = window.devicePixelRatio || 1;
      const options =
        box && box.width > 0 && box.height > 0
          ? { maxWidth: Math.round(box.width * scale), maxHeight: Math.round(box.height * scale) }
          : FALLBACK_STREAM_BOX;
      // A host advertising browserDrive renders the page at this pane's size.
      // The viewport rides every renewal once the stream exists, so a host
      // whose lease lapsed gets it back; the host ignores an unchanged one.
      const viewport = api.remoteBrowserDrive === true ? remoteBrowserDriveViewport(box, scale) : null;
      api.remoteBrowserStream!(ownerSessionId, options).then(
        () => {
          if (running && viewport) {
            api.remoteBrowserControl?.(ownerSessionId, { type: 'viewport', ...viewport }).catch(() => {});
          }
        },
        (error: unknown) => {
          if (running) setFailure(error instanceof Error ? error.message : String(error));
        }
      );
    };
    // Resizes and rotations re-send the size at once (debounced) rather than
    // at the next renewal; an older host keeps today's renewal-only stream.
    const resized = () => {
      if (!running || api.remoteBrowserDrive !== true) return;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(renew, VIEWPORT_DEBOUNCE_MS);
    };
    const content = contentRef.current;
    const observer = content && typeof ResizeObserver === 'function' ? new ResizeObserver(resized) : null;
    if (content) observer?.observe(content);
    window.addEventListener('resize', resized);
    window.addEventListener('orientationchange', resized);
    // The keyboard went down with the field: the held size gives way.
    document.addEventListener('focusout', resized);
    const begin = () => {
      if (running) return;
      running = true;
      renew();
      timer = window.setInterval(renew, STREAM_RENEW_MS);
    };
    const end = () => {
      if (!running) return;
      running = false;
      window.clearInterval(timer);
      window.clearTimeout(resizeTimer);
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
      observer?.disconnect();
      window.removeEventListener('resize', resized);
      window.removeEventListener('orientationchange', resized);
      document.removeEventListener('focusout', resized);
      end();
    };
  }, [active, api, ownerSessionId]);
}
