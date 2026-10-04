import { ArrowLeft, ArrowRight, ExternalLink, Keyboard, RotateCw, X } from 'lucide-react';
import { ProgressSpinner } from './ProgressSpinner';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { DesktopRemoteBrowserControl, DesktopRemoteBrowserStreamFrame } from '../shared/contract';
import { remoteBrowserImagePoint } from '../shared/remote-browser';
import { normalizeAddressInput } from './browser-address';
import { createRemoteBrowserInputQueue } from './remote-browser-input';
import { createRemoteBrowserInputClient, type RemoteInputFrame } from './remote-browser-input-client';
import { createRemoteTouchController } from './remote-browser-touch';
import { useBrowserPageInput } from './use-browser-page-input';
import { readBrowserZoom, stepBrowserZoom, writeBrowserZoom } from './browser-zoom-level';
import { BrowserZoomPill } from './BrowserZoomPill';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import type { BrowserPaneProps } from './BrowserPane.lazy';

/** Keep a zoomed frame's edges inside the box: the image may pan only as far
 *  as its overflow on each axis. */
function clampPan(offset: number, size: number, zoom: number): number {
  const reach = Math.max(0, (size * (zoom - 1)) / 2);
  return Math.min(reach, Math.max(-reach, offset));
}

/** The desktop stops a stream that is not renewed for 4s. */
export const STREAM_RENEW_MS = 2_000;
/** Same value as REMOTE_CONNECTION_READY_EVENT (remote-shim-state), which the
 * pane must not import: it would pull the whole shim into this chunk. */
const REMOTE_CONNECTION_READY_EVENT = 'mixdog:remote-connection-ready';
/** A control rejected because the page moved on is not an error to show: the
 * next frame carries the new document. */
const PAGE_CHANGED = /\b(stale|changed)\b/i;
const reportable = (message: string) => (PAGE_CHANGED.test(message) ? '' : message);
const TOUCH_INDICATOR_MS = 450;
const FALLBACK_STREAM_BOX = { maxWidth: 1280, maxHeight: 720 };

type StreamFrameMeta = Omit<DesktopRemoteBrowserStreamFrame, 'image'>;

async function decodeImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode === 'function') await image.decode();
}

export default function RemoteBrowserPane({ sessionId, active }: BrowserPaneProps) {
  const api = window.mixdogDesktop;
  const ownerSessionId = sessionId;
  const addressFocused = useRef(false);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  /** Geometry of the newest displayed frame; the input adapter reads it. */
  const frameRef = useRef<RemoteInputFrame | null>(null);
  const imageSize = useRef<{ width: number; height: number } | null>(null);
  const [address, setAddress] = useState('');
  const [frame, setFrame] = useState<StreamFrameMeta | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [failure, setFailure] = useState('');
  const [actionFailure, setActionFailure] = useState('');
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [touchDot, setTouchDot] = useState<{ x: number; y: number; key: number } | null>(null);
  const inputQueue = useMemo(
    () =>
      createRemoteBrowserInputQueue({
        send: async (input) => {
          await api?.remoteBrowserControl?.(ownerSessionId, input);
        },
        failure: (message) => setActionFailure(reportable(message)),
        settled: () => {},
      }),
    [api, ownerSessionId]
  );
  // Client-side zoom of the frame image: the desktop keeps streaming the same
  // frame; the phone scales and pans it. Pointer coordinates read the image's
  // transformed box, so they stay exact.
  const [zoomLevel, setZoomLevel] = useState(() => readBrowserZoom(window.localStorage, sessionId));
  const zoomRef = useRef(zoomLevel);
  zoomRef.current = zoomLevel;
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const changeZoomLevel = useCallback(
    (level: number) => {
      const next = writeBrowserZoom(window.localStorage, ownerSessionId, level);
      setZoomLevel(next);
      const image = imageRef.current;
      setPan((current) =>
        next <= 1 || !image
          ? { x: 0, y: 0 }
          : {
              x: clampPan(current.x, image.clientWidth, next),
              y: clampPan(current.y, image.clientHeight, next),
            }
      );
    },
    [ownerSessionId]
  );

  const shortcutRef = useRef((_name: string) => {});
  shortcutRef.current = (name) => {
    if (name === 'address') addressRef.current?.focus();
    else if (name === 'zoom-in') changeZoomLevel(stepBrowserZoom(zoomRef.current, 1));
    else if (name === 'zoom-out') changeZoomLevel(stepBrowserZoom(zoomRef.current, -1));
    else if (name === 'zoom-reset') changeZoomLevel(1);
  };
  const client = useMemo(
    () =>
      createRemoteBrowserInputClient({
        frame: () => frameRef.current,
        send: (input) => {
          setActionFailure('');
          return inputQueue.enqueue(input);
        },
        failure: (message) => setActionFailure(reportable(message)),
        shortcut: (name) => shortcutRef.current(name),
      }),
    [inputQueue]
  );
  const input = useBrowserPageInput(client, imageRef, keyboardRef);
  const inputRef = useRef(input);
  inputRef.current = input;

  /** Client pixel → page CSS pixel through the (possibly zoomed) image box. */
  const viewportPoint = useCallback((clientX: number, clientY: number) => {
    const picture = frameRef.current;
    const bounds = imageRef.current?.getBoundingClientRect();
    if (!picture || !bounds) return null;
    const pixel = remoteBrowserImagePoint(bounds, picture, { x: clientX, y: clientY });
    return pixel
      ? {
          x: (pixel.x * picture.viewportWidth) / picture.width,
          y: (pixel.y * picture.viewportHeight) / picture.height,
        }
      : null;
  }, []);
  const touch = useMemo(() => {
    let dotTimer = 0;
    return createRemoteTouchController({
      page: viewportPoint,
      pageDelta: (dx, dy) => {
        const picture = frameRef.current;
        const bounds = imageRef.current?.getBoundingClientRect();
        if (!picture || !bounds) return { x: 0, y: 0 };
        const scale = Math.min(bounds.width / picture.width, bounds.height / picture.height);
        return {
          x: (dx * picture.viewportWidth) / (picture.width * scale),
          y: (dy * picture.viewportHeight) / (picture.height * scale),
        };
      },
      send: (action) => client.fire(action),
      panning: () => zoomRef.current > 1,
      pan: (dx, dy) => {
        const image = imageRef.current;
        if (!image) return;
        setPan((current) => ({
          x: clampPan(current.x + dx, image.clientWidth, zoomRef.current),
          y: clampPan(current.y + dy, image.clientHeight, zoomRef.current),
        }));
      },
      indicator: (x, y) => {
        const box = contentRef.current?.getBoundingClientRect();
        setTouchDot({ x: x - (box?.left ?? 0), y: y - (box?.top ?? 0), key: Date.now() + Math.random() });
        window.clearTimeout(dotTimer);
        dotTimer = window.setTimeout(() => setTouchDot(null), TOUCH_INDICATOR_MS);
      },
    });
  }, [client, viewportPoint]);

  // Declared before the queue effect so an unmount releases a held press
  // (and flushes coalesced motion) before the queue stops accepting input.
  useEffect(
    () => () => {
      touch.dispose();
      client.flush();
    },
    [touch, client]
  );
  useEffect(() => {
    if (active) inputQueue.activate();
    else inputQueue.dispose();
    return () => inputQueue.dispose();
  }, [active, inputQueue]);

  // Newest frame for this session only. A metadata-only frame keeps the last
  // image; a frame is acknowledged once its image is decoded and displayed.
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
        inputQueue.reset();
        client.reset();
        touch.dispose();
        inputRef.current?.onPointerCancel();
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
  }, [active, api, ownerSessionId, inputQueue, client, touch]);

  // Live view: start, renew every ~2s while shown, stop when hidden/inactive.
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

  useEffect(() => {
    if (keyboardOpen) keyboardRef.current?.focus();
  }, [keyboardOpen]);

  const control = useCallback(
    async (next: DesktopRemoteBrowserControl) => {
      if (!api?.remoteBrowserControl) return;
      setActionFailure('');
      await inputQueue.enqueue(next);
    },
    [api, inputQueue]
  );

  const navigate = useCallback(
    (raw: string) => {
      const url = normalizeAddressInput(raw);
      if (!url) return;
      setAddress(url);
      void control({ type: 'navigate', url });
    },
    [control]
  );

  const externalUrl = frame?.url && frame.url !== 'about:blank' ? frame.url : '';

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return input.onPointerDown(event);
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    touch.down(event.pointerId, event.clientX, event.clientY);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return input.onPointerMove(event);
    event.preventDefault();
    touch.move(event.pointerId, event.clientX, event.clientY);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return input.onPointerUp(event);
    event.preventDefault();
    touch.up(event.pointerId, event.clientX, event.clientY);
  };
  const pointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return input.onPointerCancel();
    touch.cancel(event.pointerId);
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    navigate(address);
    addressFocused.current = false;
  };

  return (
    <div className="browser-pane browser-remote-pane" data-surface-active={active ? 'true' : 'false'}>
      <div className="browser-pane-toolbar">
        <button
          type="button"
          className="browser-pane-nav-button"
          disabled={!frame?.canGoBack}
          onClick={() => void control({ type: 'back' })}
          aria-label={t('Back')}
          data-tooltip={t('Back')}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="browser-pane-nav-button"
          disabled={!frame?.canGoForward}
          onClick={() => void control({ type: 'forward' })}
          aria-label={t('Forward')}
          data-tooltip={t('Forward')}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className="browser-pane-nav-button"
          onClick={() => void control({ type: frame?.loading ? 'stop' : 'reload' })}
          aria-label={frame?.loading ? t('Stop loading') : t('Reload')}
          data-tooltip={frame?.loading ? t('Stop loading') : t('Reload')}
        >
          {frame?.loading ? <X size={16} /> : <RotateCw size={16} />}
        </button>
        <form className="browser-pane-address-form" onSubmit={submitAddress}>
          <input
            ref={addressRef}
            className="browser-pane-address"
            type="text"
            value={address}
            spellCheck={false}
            placeholder={t('Search or enter address')}
            aria-label={t('Address bar')}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              addressFocused.current = true;
              event.target.select();
            }}
            onBlur={() => {
              addressFocused.current = false;
              if (externalUrl) setAddress(externalUrl);
            }}
          />
        </form>
        <button
          type="button"
          className={`browser-pane-nav-button browser-remote-keyboard-button${keyboardOpen ? ' is-active' : ''}`}
          onClick={() => setKeyboardOpen((open) => !open)}
          aria-pressed={keyboardOpen}
          aria-label={t('Type on page')}
          data-tooltip={t('Type on page')}
        >
          <Keyboard size={16} />
        </button>
        <button
          type="button"
          className="browser-pane-nav-button"
          disabled={!externalUrl}
          onClick={() => {
            if (externalUrl) void api?.openExternal(externalUrl);
          }}
          aria-label={t('Open in system browser')}
          data-tooltip={t('Open in system browser')}
        >
          <ExternalLink size={16} />
        </button>
      </div>
      {/* One persistent textarea: the visible phone keyboard bar when open,
          otherwise an invisible focus target for desktop key/IME/paste. */}
      <div className="browser-remote-keyboard" data-open={keyboardOpen ? 'true' : 'false'}>
        <textarea
          ref={keyboardRef}
          rows={1}
          maxLength={2_000}
          inputMode="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={t('Type on page')}
          placeholder={t('Type into selected page element')}
          onKeyDown={input.onKeyDown}
          onInput={input.onInput}
          onPaste={input.onPaste}
          onBlur={input.onBlur}
          onCompositionStart={input.onCompositionStart}
          onCompositionUpdate={input.onCompositionUpdate}
          onCompositionEnd={input.onCompositionEnd}
        />
        <button type="button" onClick={() => setKeyboardOpen(false)} aria-label={t('Close')}>
          <X size={16} />
        </button>
      </div>
      <div
        ref={contentRef}
        className="browser-pane-content browser-remote-content"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerCancel}
        onLostPointerCapture={(event) => {
          if (event.pointerType !== 'touch') input.onPointerCancel();
        }}
        onWheel={input.onWheel}
        onContextMenu={(event) => event.preventDefault()}
      >
        {imageUrl && (
          <img
            ref={imageRef}
            src={imageUrl}
            draggable={false}
            style={
              zoomLevel !== 1 || pan.x || pan.y
                ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoomLevel})` }
                : undefined
            }
            alt={frame?.title || 'Browser Use'}
          />
        )}
        {!imageUrl && (
          <div className="browser-remote-empty">
            {failure ? (
              <ErrorNotice error={failure} title={t('Could not connect to browser screen')} role="status" />
            ) : (
              <>
                <ProgressSpinner size={24} />
                <span>{t('Connecting to desktop Browser Use…')}</span>
              </>
            )}
          </div>
        )}
        {(actionFailure || (failure && imageUrl)) && (
          <div className="browser-remote-status">
            <ErrorNotice
              errors={[imageUrl ? failure : '', actionFailure]}
              role="status"
              onDismiss={actionFailure ? () => setActionFailure('') : undefined}
            />
          </div>
        )}
        {touchDot && (
          <span
            key={touchDot.key}
            className="browser-remote-touch-dot"
            style={{ left: touchDot.x, top: touchDot.y }}
            aria-hidden="true"
          />
        )}
        {imageUrl && <BrowserZoomPill level={zoomLevel} onChange={changeZoomLevel} />}
      </div>
    </div>
  );
}
