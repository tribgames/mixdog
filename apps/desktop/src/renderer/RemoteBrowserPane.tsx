import { ArrowLeft, ArrowRight, ExternalLink, Keyboard, KeyRound, Link2, RotateCw, X } from 'lucide-react';
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

import type {
  DesktopBrowserTab,
  DesktopRemoteBrowserControl,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserTab,
} from '../shared/contract';
import { MAIN_BROWSER_PAGE_PREFIX } from '../shared/contract-browser';
import { remoteBrowserImagePoint } from '../shared/remote-browser';
import { useBrowserCredentials, useHistorySuggestions } from './browser-pane-hooks';
import { BrowserImportDialog } from './BrowserImportDialog';
import { BrowserTabStrip } from './BrowserTabStrip';
import { DockOverflowMenu, type DockAction } from './pane-dock-chrome';
import { browserInputNotice } from '../shared/browser-input-policy';
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
const TOUCH_INDICATOR_MS = 450;
const FALLBACK_STREAM_BOX = { maxWidth: 1280, maxHeight: 720 };

type StreamFrameMeta = Omit<DesktopRemoteBrowserStreamFrame, 'image'>;

async function decodeImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode === 'function') await image.decode();
}

/** Panes watching the tab list share one host-side watch per client. */
let tabWatchers = 0;

export default function RemoteBrowserPane({ sessionId, active }: BrowserPaneProps) {
  const api = window.mixdogDesktop;
  // The page this client streams: its own tab until another is selected.
  const [streamId, setStreamId] = useState(sessionId);
  const ownerSessionId = streamId;
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
  const [addressHasFocus, setAddressHasFocus] = useState(false);
  const [newTab, setNewTab] = useState(false);
  const [tabs, setTabs] = useState<DesktopRemoteBrowserTab[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [, setConnectionEpoch] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is window.mixdogDesktop; keeping it as a dependency rebuilds the queue if the bridge object is replaced.
  const inputQueue = useMemo(
    () =>
      createRemoteBrowserInputQueue({
        send: async (input) => {
          await api?.remoteBrowserControl?.(ownerSessionId, input);
        },
        failure: (message) => setActionFailure(browserInputNotice(message)),
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

  // Another page: nothing of the previous one (frame, image, pan, zoom) carries over.
  const shownStream = useRef(streamId);
  useEffect(() => {
    if (shownStream.current === streamId) return;
    shownStream.current = streamId;
    frameRef.current = null;
    imageSize.current = null;
    setFrame(null);
    setImageUrl('');
    setFailure('');
    setActionFailure('');
    setAddress('');
    setPan({ x: 0, y: 0 });
    setZoomLevel(readBrowserZoom(window.localStorage, streamId));
  }, [streamId]);
  // The pane's own tab is the page it starts from again if it is retargeted.
  useEffect(() => {
    setStreamId(sessionId);
  }, [sessionId]);

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
        failure: (message) => setActionFailure(browserInputNotice(message)),
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is window.mixdogDesktop; keeping it as a dependency re-subscribes if the bridge object is replaced.
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is window.mixdogDesktop; keeping it as a dependency restarts the stream if the bridge object is replaced.
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: api is window.mixdogDesktop; keeping it as a dependency refreshes the callback if the bridge object is replaced.
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
  const go = (raw: string) => {
    setHistorySuggestions([]);
    if (newTab) void openTab(raw);
    else navigate(raw);
  };

  // The host's extras (tabs, history, saved logins, import) appear only once
  // the connected host advertises them; a reconnect may reach another host.
  useEffect(() => {
    const ready = () => setConnectionEpoch((epoch) => epoch + 1);
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, ready);
    return () => window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, ready);
  }, []);
  // Only a main-workspace tab may roam over its siblings; a conversation's
  // dock page stays its own.
  const tabsSupported =
    sessionId.startsWith(MAIN_BROWSER_PAGE_PREFIX) && Boolean(api?.remoteBrowserTabs && api.onRemoteBrowserTabs);
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is window.mixdogDesktop; tabsSupported reflects its gated members.
  useEffect(() => {
    if (!active || !tabsSupported || !api?.remoteBrowserTabs || !api.onRemoteBrowserTabs) {
      setTabs([]);
      return undefined;
    }
    let live = true;
    const watch = () => {
      api.remoteBrowserTabs?.(true).then(
        (list) => {
          if (live) setTabs(list);
        },
        () => {}
      );
    };
    const unsubscribe = api.onRemoteBrowserTabs((list) => {
      if (live) setTabs(list);
    });
    tabWatchers += 1;
    watch();
    window.addEventListener(REMOTE_CONNECTION_READY_EVENT, watch);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, watch);
      tabWatchers -= 1;
      if (tabWatchers === 0) api.remoteBrowserTabs?.(false).catch(() => {});
    };
  }, [active, api, tabsSupported]);

  const selectTab = useCallback((id: string) => {
    setNewTab(false);
    setStreamId(id);
  }, []);
  const reportFailure = (error: unknown) => setActionFailure(error instanceof Error ? error.message : String(error));
  const openTab = async (raw: string) => {
    const url = normalizeAddressInput(raw);
    if (!url || !api?.remoteBrowserOpenTab) return;
    setNewTab(false);
    try {
      const tab = await api.remoteBrowserOpenTab(url);
      setTabs((current) => (current.some((item) => item.id === tab.id) ? current : [...current, tab]));
      selectTab(tab.id);
    } catch (error) {
      reportFailure(error);
    }
  };
  const closeTab = async (id: string) => {
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0 || tabs.length < 2 || !api?.remoteBrowserCloseTab) return;
    // Leave the page before it is released, or the live stream would recreate it.
    if (id === streamId) selectTab((tabs[index + 1] ?? tabs[index - 1]).id);
    try {
      await api.remoteBrowserCloseTab(id);
      setTabs((current) => current.filter((tab) => tab.id !== id));
    } catch (error) {
      reportFailure(error);
    }
  };
  const stripTabs = useMemo<DesktopBrowserTab[]>(
    () => tabs.map((tab) => ({ ...tab, active: tab.id === streamId, kind: 'page' })),
    [tabs, streamId]
  );

  const { historySuggestions, setHistorySuggestions } = useHistorySuggestions(api, address, addressHasFocus);
  const { credentialBusy, credentialStatus, credentialSuggestions, fillStoredCredential, refreshCredentialSuggestions } =
    useBrowserCredentials(api, ownerSessionId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page's address and loading state are the triggers; the body only asks the host.
  useEffect(() => {
    if (active && frame && !frame.loading) refreshCredentialSuggestions();
  }, [active, frame?.url, frame?.loading, refreshCredentialSuggestions]);

  const externalUrl = frame?.url && frame.url !== 'about:blank' ? frame.url : '';
  let credentialLabel = t('Fill with stored credentials');
  if (credentialStatus === 'success') credentialLabel = t('Filled stored credentials');
  else if (credentialStatus === 'error') credentialLabel = t('Could not fill stored credentials');
  const moreActions: DockAction[] = credentialSuggestions.map((credential) => ({
    id: `credential-${credential.id}`,
    label:
      credentialSuggestions.length === 1
        ? credentialLabel
        : `${t('Fill with stored credentials')}: ${credential.label}`,
    icon: KeyRound,
    disabled: credentialBusy,
    onSelect: () => fillStoredCredential(credential.id),
  }));
  if (api?.browserProfileImportSources) {
    moreActions.push({
      id: 'import-profile',
      label: t('Import from browser'),
      icon: Link2,
      separatorBefore: credentialSuggestions.length > 0,
      onSelect: () => setImportOpen(true),
    });
  }

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
    go(address);
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
            placeholder={newTab ? t('Address for new tab') : t('Search or enter address')}
            aria-label={t('Address bar')}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => {
              addressFocused.current = true;
              setAddressHasFocus(true);
              event.target.select();
            }}
            onBlur={() => {
              addressFocused.current = false;
              setAddressHasFocus(false);
              setNewTab(false);
              if (externalUrl) setAddress(externalUrl);
            }}
          />
          {historySuggestions.length > 0 && (
            <div className="browser-pane-history-suggestions">
              {historySuggestions.map((entry) => (
                <button
                  type="button"
                  key={entry.url}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    go(entry.url);
                    setAddressHasFocus(false);
                  }}
                >
                  <span>{entry.title || entry.url}</span>
                  <code>{entry.url}</code>
                </button>
              ))}
            </div>
          )}
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
        {moreActions.length > 0 && <DockOverflowMenu items={moreActions} />}
      </div>
      {tabsSupported && tabs.length > 0 && (
        <div className="browser-pane-popup-tabs">
          <BrowserTabStrip
            tabs={stripTabs}
            onSelect={async (id) => selectTab(id)}
            onClose={closeTab}
            onCreate={async () => {
              setNewTab(true);
              setAddress('');
              addressRef.current?.focus();
            }}
          />
        </div>
      )}
      <BrowserImportDialog open={importOpen} onClose={() => setImportOpen(false)} />      {/* One persistent textarea: the visible phone keyboard bar when open,
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: remote-page touch/pointer surface; keyboard input goes through the dedicated textarea above. */}
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
