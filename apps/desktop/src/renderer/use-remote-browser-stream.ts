import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import type { DesktopRemoteBrowserStreamFrame } from '../shared/contract';
import type { RemoteInputFrame } from './remote-browser-input-client';
import { REMOTE_CONNECTION_READY_EVENT } from './remote-connection-state';

/** The desktop stops a stream that is not renewed for 4s. */
export const STREAM_RENEW_MS = 2_000;
export { REMOTE_CONNECTION_READY_EVENT };
const FALLBACK_STREAM_BOX = { maxWidth: 1280, maxHeight: 720 };

export type StreamFrameMeta = Omit<DesktopRemoteBrowserStreamFrame, 'image'>;

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
      const size = imageSize.current ?? next;
      frameRef.current = {
        documentId: next.documentId,
        width: size.width,
        height: size.height,
        viewportWidth: next.viewportWidth,
        viewportHeight: next.viewportHeight,
      };
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
        if (frameRef.current?.documentId === next.documentId) {
          frameRef.current = { ...frameRef.current, width: next.width, height: next.height };
        }
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
    let running = false;
    const renew = () => {
      const box = contentRef.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const options =
        box && box.width > 0 && box.height > 0
          ? { maxWidth: Math.round(box.width * scale), maxHeight: Math.round(box.height * scale) }
          : FALLBACK_STREAM_BOX;
      api.remoteBrowserStream!(ownerSessionId, options).catch((error: unknown) => {
        if (running) setFailure(error instanceof Error ? error.message : String(error));
      });
    };
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
      end();
    };
  }, [active, api, ownerSessionId]);
}
