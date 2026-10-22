import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Keyboard,
  KeyRound,
  Link2,
  RotateCw,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { ProgressSpinner } from './ProgressSpinner';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from 'react';

import type { DesktopBrowserTab, DesktopRemoteBrowserControl } from '../shared/contract';
import { remoteBrowserImagePoint } from '../shared/remote-browser';
import { useBrowserCredentials, useHistorySuggestions } from './browser-pane-hooks';
import { BrowserImportDialog } from './BrowserImportDialog';
import { BrowserPagePrompts } from './BrowserPagePrompts';
import { BrowserTabStrip } from './BrowserTabStrip';
import { DockHeaderRow, DockOverflowMenu, requestPaneDockClose, type DockAction } from './pane-dock-chrome';
import { useMobileRemoteSurface } from './mobile-surface';
import { browserInputNotice } from '../shared/browser-input-policy';
import { normalizeAddressInput } from './browser-address';
import { onBrowserPageAddressTaken } from './browser-page-request';
import { isLoopbackWebUrl } from './remote-external-link';
import { createRemoteBrowserInputQueue } from './remote-browser-input';
import { createRemoteBrowserInputClient, type RemoteInputFrame } from './remote-browser-input-client';
import { createRemoteTouchController } from './remote-browser-touch';
import { useBrowserPageInput } from './use-browser-page-input';
import {
  REMOTE_CONNECTION_READY_EVENT,
  useRemoteBrowserStream,
  type StreamFrameMeta,
} from './use-remote-browser-stream';
import { useRemoteBrowserTabs } from './use-remote-browser-tabs';
import {
  BROWSER_ZOOM_MAX,
  BROWSER_ZOOM_MIN,
  readBrowserZoom,
  stepBrowserZoom,
  writeBrowserZoom,
} from './browser-zoom-level';
import { BrowserZoomPill } from './BrowserZoomPill';
import { useZoomBarVisible, zoomBarAction } from './zoom-bar-pref';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import type { BrowserPaneProps } from './BrowserPane.lazy';

/** Keep a zoomed frame's edges inside the box: the image may pan only as far
 *  as its overflow on each axis. */
function clampPan(offset: number, size: number, zoom: number): number {
  const reach = Math.max(0, (size * (zoom - 1)) / 2);
  return Math.min(reach, Math.max(-reach, offset));
}

/** Narrow (non-phone) toolbar: the less-used "Open in system browser" moves into the
 *  More menu so the address field keeps the room (same split as the PC pane's
 *  browserNavLayout). */
function useNarrowToolbar(): boolean {
  const query = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const update = () => setNarrow(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, []);
  return narrow;
}

/** Client-side zoom of the frame image: the desktop keeps streaming the same
 *  frame; the phone scales and pans it. Pointer coordinates read the image's
 *  transformed box, so they stay exact. */
function useRemoteFrameZoom(sessionId: string, ownerSessionId: string, imageRef: RefObject<HTMLImageElement | null>) {
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
    [ownerSessionId, imageRef]
  );
  return { zoomLevel, setZoomLevel, zoomRef, pan, setPan, changeZoomLevel };
}

type TouchDot = { x: number; y: number; key: number };

/** Touch on the frame image: taps and drags reach the page in its CSS pixels,
 *  a zoomed frame pans instead, and each touch shows a short indicator. */
function useRemoteTouch({
  client,
  frameRef,
  imageRef,
  contentRef,
  zoomRef,
  setPan,
  setTouchDot,
}: {
  client: ReturnType<typeof createRemoteBrowserInputClient>;
  frameRef: RefObject<RemoteInputFrame | null>;
  imageRef: RefObject<HTMLImageElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  zoomRef: RefObject<number>;
  setPan: Dispatch<SetStateAction<{ x: number; y: number }>>;
  setTouchDot: Dispatch<SetStateAction<TouchDot | null>>;
}) {
  /** Client pixel → page CSS pixel through the (possibly zoomed) image box. */
  const viewportPoint = useCallback(
    (clientX: number, clientY: number) => {
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
    },
    [frameRef, imageRef]
  );
  return useMemo(() => {
    let dotTimer = 0;
    return createRemoteTouchController({
      page: viewportPoint,
      pageDelta: (dx, dy) => {
        const picture = frameRef.current;
        const bounds = imageRef.current?.getBoundingClientRect();
        if (!picture || !bounds || !(picture.width > 0) || !(picture.height > 0)) return { x: 0, y: 0 };
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
  }, [client, viewportPoint, frameRef, imageRef, contentRef, zoomRef, setPan, setTouchDot]);
}

/** Human input to the streamed page: one ordered queue to the host, the
 *  keyboard/mouse client, page shortcuts, and touch on the frame image. */
function useRemotePageInput({
  api,
  active,
  ownerSessionId,
  setActionFailure,
  frameRef,
  imageRef,
  keyboardRef,
  contentRef,
  addressRef,
  zoomRef,
  changeZoomLevel,
  setPan,
  setTouchDot,
}: {
  api: typeof window.mixdogDesktop;
  active: boolean;
  ownerSessionId: string;
  setActionFailure: Dispatch<SetStateAction<string>>;
  frameRef: RefObject<RemoteInputFrame | null>;
  imageRef: RefObject<HTMLImageElement | null>;
  keyboardRef: RefObject<HTMLTextAreaElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  addressRef: RefObject<HTMLInputElement | null>;
  zoomRef: RefObject<number>;
  changeZoomLevel(level: number): void;
  setPan: Dispatch<SetStateAction<{ x: number; y: number }>>;
  setTouchDot: Dispatch<SetStateAction<TouchDot | null>>;
}) {
  const inputQueue = useMemo(
    () =>
      createRemoteBrowserInputQueue({
        send: async (input) => {
          await api?.remoteBrowserControl?.(ownerSessionId, input);
        },
        failure: (message) => setActionFailure(browserInputNotice(message)),
        settled: () => {},
      }),
    [api, ownerSessionId, setActionFailure]
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
        failure: (message) => setActionFailure(browserInputNotice(message)),
        shortcut: (name) => shortcutRef.current(name),
      }),
    [inputQueue, frameRef, setActionFailure]
  );
  const input = useBrowserPageInput(client, imageRef, keyboardRef);
  const inputRef = useRef(input);
  inputRef.current = input;

  const touch = useRemoteTouch({ client, frameRef, imageRef, contentRef, zoomRef, setPan, setTouchDot });

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

  const resetDocumentInput = useCallback(() => {
    inputQueue.reset();
    client.reset();
    touch.dispose();
    inputRef.current?.onPointerCancel();
  }, [inputQueue, client, touch]);
  return { inputQueue, input, touch, resetDocumentInput };
}

/** The pane's tab strip actions on top of the host's tabs. */
function useRemoteDockTabs({
  setAddress,
  addressRef,
  ...options
}: Parameters<typeof useRemoteBrowserTabs>[0] & {
  setAddress: Dispatch<SetStateAction<string>>;
  addressRef: RefObject<HTMLInputElement | null>;
}) {
  const { sessionTabsSupported, closeTab, createSessionTab, closeSessionTab, ...remoteTabs } =
    useRemoteBrowserTabs(options);
  const { tabs, tabsSupported, setNewTab } = remoteTabs;

  // Closing the only tab closes the side panel; the host keeps its page.
  const closeDockTab = async (id: string) => {
    if (sessionTabsSupported) {
      // Like the PC pane, the panel closes with the last tab, but that is the
      // host's count after the close: the strip may be stale, and the PC may
      // have added or closed a tab meanwhile.
      const reply = await closeSessionTab(id);
      if (reply?.remainingTabs === 0) requestPaneDockClose('browser');
    } else if (tabs.length < 2) requestPaneDockClose('browser');
    else await closeTab(id);
  };
  /** "+" on a main-workspace strip: the address field opens the new tab. */
  const addressNewTab = async () => {
    setNewTab(true);
    setAddress('');
    addressRef.current?.focus();
  };
  // A conversation's "+" opens a tab in its own browser (host-supported only).
  let createStripTab: (() => Promise<void>) | undefined;
  if (tabsSupported) createStripTab = addressNewTab;
  else if (sessionTabsSupported) {
    createStripTab = async () => {
      if ((await createSessionTab()) !== null) {
        setAddress('');
        addressRef.current?.focus();
      }
    };
  }
  return { ...remoteTabs, closeDockTab, addressNewTab, createStripTab };
}

/** Phone row 1 is the PC browser dock's header row: tab strip, ⋯, close. */
function RemotePhoneHeader({
  streamId,
  frame,
  externalUrl,
  stripTabs,
  moreActions,
  selectTab,
  closeDockTab,
  createStripTab,
}: {
  streamId: string;
  frame: StreamFrameMeta | null;
  externalUrl: string;
  stripTabs: DesktopBrowserTab[];
  moreActions: DockAction[];
  selectTab(id: string): void;
  closeDockTab(id: string): Promise<void>;
  createStripTab: (() => Promise<void>) | undefined;
}) {
  // PC always shows the page's tab pill (a blank tab when empty); a host that lists no tabs still gets one.
  const currentTab: DesktopBrowserTab[] = [
    {
      id: streamId,
      title: frame?.title || externalUrl || t('New tab'),
      url: externalUrl,
      active: true,
      loading: Boolean(frame?.loading),
      kind: 'page',
    },
  ];
  return (
    <DockHeaderRow
      onClose={() => requestPaneDockClose('browser')}
      actions={moreActions}
      left={
        <BrowserTabStrip
          tabs={stripTabs.length ? stripTabs : currentTab}
          onSelect={async (id) => selectTab(id)}
          onClose={closeDockTab}
          onCreate={createStripTab}
        />
      }
    />
  );
}

type MoreActionOptions = {
  api: typeof window.mixdogDesktop;
  phone: boolean;
  narrow: boolean;
  keyboardOpen: boolean;
  setKeyboardOpen: Dispatch<SetStateAction<boolean>>;
  zoomLevel: number;
  changeZoomLevel(level: number): void;
  externalUrl: string;
  openImport(): void;
};

/** Stored logins for the page, refreshed whenever a page finishes loading,
 *  as the first entries of the ⋯ menu. */
function useRemoteMoreActions({
  ownerSessionId,
  active,
  frame,
  ...options
}: MoreActionOptions & { ownerSessionId: string; active: boolean; frame: StreamFrameMeta | null }): DockAction[] {
  const {
    credentialBusy,
    credentialStatus,
    credentialSuggestions,
    fillStoredCredential,
    refreshCredentialSuggestions,
  } = useBrowserCredentials(options.api, ownerSessionId);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the page's address and loading state are the triggers; the body only asks the host.
  useEffect(() => {
    if (active && frame && !frame.loading) refreshCredentialSuggestions();
  }, [active, frame?.url, frame?.loading, refreshCredentialSuggestions]);
  useZoomBarVisible();
  return remoteBrowserMoreActions({
    ...options,
    credentials: { credentialBusy, credentialStatus, credentialSuggestions, fillStoredCredential },
  });
}

/** The ⋯ menu: stored-credential fills first, then the surface's extras. */
function remoteBrowserMoreActions({
  api,
  credentials: { credentialBusy, credentialStatus, credentialSuggestions, fillStoredCredential },
  phone,
  narrow,
  keyboardOpen,
  setKeyboardOpen,
  zoomLevel,
  changeZoomLevel,
  externalUrl,
  openImport,
}: MoreActionOptions & {
  credentials: Pick<
    ReturnType<typeof useBrowserCredentials>,
    'credentialBusy' | 'credentialStatus' | 'credentialSuggestions' | 'fillStoredCredential'
  >;
}): DockAction[] {
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
  if (phone) {
    // The PC pane has no keyboard, zoom or external-open button; on the phone
    // they live in ⋯ (typing needs the soft keyboard).
    moreActions.push(
      {
        id: 'type-on-page',
        label: t('Type on page'),
        icon: Keyboard,
        checked: keyboardOpen,
        checkbox: true,
        separatorBefore: moreActions.length > 0,
        onSelect: () => setKeyboardOpen((open) => !open),
      },
      {
        id: 'zoom-in',
        label: t('Zoom in'),
        icon: ZoomIn,
        separatorBefore: true,
        disabled: zoomLevel >= BROWSER_ZOOM_MAX,
        onSelect: () => changeZoomLevel(stepBrowserZoom(zoomLevel, 1)),
      },
      {
        id: 'zoom-out',
        label: t('Zoom out'),
        icon: ZoomOut,
        disabled: zoomLevel <= BROWSER_ZOOM_MIN,
        onSelect: () => changeZoomLevel(stepBrowserZoom(zoomLevel, -1)),
      },
      {
        id: 'zoom-reset',
        label: t('Reset zoom'),
        detail: `${Math.round(zoomLevel * 100)}%`,
        disabled: zoomLevel === 1,
        onSelect: () => changeZoomLevel(1),
      },
      {
        id: 'open-external',
        label: t('Open in system browser'),
        icon: ExternalLink,
        separatorBefore: true,
        disabled: !externalUrl,
        onSelect: () => {
          if (externalUrl) void api?.openExternal(externalUrl);
        },
      }
    );
    return moreActions;
  }
  if (api?.browserProfileImportSources) {
    moreActions.push({
      id: 'import-profile',
      label: t('Import from browser'),
      icon: Link2,
      separatorBefore: credentialSuggestions.length > 0,
      onSelect: openImport,
    });
  }
  if (narrow) {
    moreActions.push({
      id: 'open-external',
      label: t('Open in system browser'),
      icon: ExternalLink,
      separatorBefore: moreActions.length > 0,
      disabled: !externalUrl,
      onSelect: () => {
        if (externalUrl) void api?.openExternal(externalUrl);
      },
    });
  }
  moreActions.push(zoomBarAction(moreActions.length > 0));
  return moreActions;
}

function RemoteAddressForm({
  addressRef,
  addressFocused,
  address,
  setAddress,
  setAddressHasFocus,
  newTab,
  setNewTab,
  externalUrl,
  historySuggestions,
  go,
}: {
  addressRef: RefObject<HTMLInputElement | null>;
  addressFocused: RefObject<boolean>;
  address: string;
  setAddress(address: string): void;
  setAddressHasFocus(focused: boolean): void;
  newTab: boolean;
  setNewTab(newTab: boolean): void;
  externalUrl: string;
  historySuggestions: ReturnType<typeof useHistorySuggestions>['historySuggestions'];
  go(raw: string): void;
}) {
  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    go(address);
    addressFocused.current = false;
  };
  return (
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
  );
}

function RemoteNavButtons({
  frame,
  iconSize,
  control,
}: {
  frame: StreamFrameMeta | null;
  iconSize: number;
  control(next: DesktopRemoteBrowserControl): Promise<void>;
}) {
  return (
    <>
      <button
        type="button"
        className="browser-pane-nav-button"
        disabled={!frame?.canGoBack}
        onClick={() => void control({ type: 'back' })}
        aria-label={t('Back')}
        data-tooltip={t('Back')}
      >
        <ArrowLeft size={iconSize} />
      </button>
      <button
        type="button"
        className="browser-pane-nav-button"
        disabled={!frame?.canGoForward}
        onClick={() => void control({ type: 'forward' })}
        aria-label={t('Forward')}
        data-tooltip={t('Forward')}
      >
        <ArrowRight size={iconSize} />
      </button>
      <button
        type="button"
        className="browser-pane-nav-button"
        onClick={() => void control({ type: frame?.loading ? 'stop' : 'reload' })}
        aria-label={frame?.loading ? t('Stop loading') : t('Reload')}
        data-tooltip={frame?.loading ? t('Stop loading') : t('Reload')}
      >
        {frame?.loading ? <X size={iconSize} /> : <RotateCw size={iconSize} />}
      </button>
    </>
  );
}

/** The non-phone toolbar's end: keyboard toggle, external open, and ⋯. */
function RemoteToolbarActions({
  api,
  keyboardOpen,
  setKeyboardOpen,
  narrow,
  externalUrl,
  moreActions,
}: {
  api: typeof window.mixdogDesktop;
  keyboardOpen: boolean;
  setKeyboardOpen: Dispatch<SetStateAction<boolean>>;
  narrow: boolean;
  externalUrl: string;
  moreActions: DockAction[];
}) {
  return (
    <>
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
      {!narrow && (
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
      )}
      {moreActions.length > 0 && <DockOverflowMenu items={moreActions} />}
    </>
  );
}

type PageInput = ReturnType<typeof useBrowserPageInput>;

/** One persistent textarea: the visible phone keyboard bar when open,
 *  otherwise an invisible focus target for desktop key/IME/paste. */
function RemoteKeyboardBar({
  keyboardRef,
  open,
  onClose,
  input,
}: {
  keyboardRef: RefObject<HTMLTextAreaElement | null>;
  open: boolean;
  onClose(): void;
  input: PageInput;
}) {
  return (
    <div className="browser-remote-keyboard" data-open={open ? 'true' : 'false'}>
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
      <button type="button" onClick={onClose} aria-label={t('Close')}>
        <X size={16} />
      </button>
    </div>
  );
}

/** The streamed frame: mouse input goes to the page as is, touch through the
 *  touch controller; connection and action failures show over it. */
function RemoteBrowserContent({
  contentRef,
  imageRef,
  input,
  touch,
  imageUrl,
  title,
  zoomLevel,
  pan,
  failure,
  actionFailure,
  setActionFailure,
  touchDot,
  zoomPill,
  changeZoomLevel,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
  imageRef: RefObject<HTMLImageElement | null>;
  input: PageInput;
  touch: ReturnType<typeof createRemoteTouchController>;
  imageUrl: string;
  title: string | undefined;
  zoomLevel: number;
  pan: { x: number; y: number };
  failure: string;
  actionFailure: string;
  setActionFailure(failure: string): void;
  touchDot: TouchDot | null;
  zoomPill: boolean;
  changeZoomLevel(level: number): void;
}) {
  const zoomBarVisible = useZoomBarVisible();
  // `touch-action: none` alone does not keep iOS WebKit from taking a touch
  // on the frame for its own scroll, zoom, selection or callout, and that
  // cancels the pointer stream the touch controller reads. React registers
  // touchstart/touchmove passive, so the frame cancels them itself; touches
  // on controls over it (zoom pill, notices) keep their native tap.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const hold = (event: TouchEvent) => {
      if (event.target === content && event.cancelable) event.preventDefault();
    };
    content.addEventListener('touchstart', hold, { passive: false });
    content.addEventListener('touchmove', hold, { passive: false });
    return () => {
      content.removeEventListener('touchstart', hold);
      content.removeEventListener('touchmove', hold);
    };
  }, [contentRef]);
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
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: remote-page touch/pointer surface; keyboard input goes through the dedicated textarea.
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
          alt={title || 'Browser Use'}
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
      {zoomPill && zoomBarVisible && imageUrl && <BrowserZoomPill level={zoomLevel} onChange={changeZoomLevel} />}
    </div>
  );
}

export { STREAM_RENEW_MS } from './use-remote-browser-stream';
const TOUCH_INDICATOR_MS = 450;

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
  const [touchDot, setTouchDot] = useState<TouchDot | null>(null);
  const [addressHasFocus, setAddressHasFocus] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const narrow = useNarrowToolbar();
  // The phone sheet takes the PC browser dock's structure (header row with the
  // tab strip, ⋯ and close); every other surface keeps the pane as it was.
  const phone = useMobileRemoteSurface();
  const [, setConnectionEpoch] = useState(0);
  const { zoomLevel, setZoomLevel, zoomRef, pan, setPan, changeZoomLevel } = useRemoteFrameZoom(
    sessionId,
    ownerSessionId,
    imageRef
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
  }, [streamId, setPan, setZoomLevel]);
  // The pane's own tab is the page it starts from again if it is retargeted.
  useEffect(() => {
    setStreamId(sessionId);
  }, [sessionId]);

  const { inputQueue, input, touch, resetDocumentInput } = useRemotePageInput({
    api,
    active,
    ownerSessionId,
    setActionFailure,
    frameRef,
    imageRef,
    keyboardRef,
    contentRef,
    addressRef,
    zoomRef,
    changeZoomLevel,
    setPan,
    setTouchDot,
  });
  useRemoteBrowserStream({
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
  });

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
  const {
    newTab,
    setNewTab,
    tabs,
    tabsSupported,
    selectTab,
    openTab,
    stripTabs,
    closeDockTab,
    addressNewTab,
    createStripTab,
  } = useRemoteDockTabs({
    api,
    active,
    sessionId,
    streamId,
    setStreamId,
    setActionFailure,
    frameTabs: frame?.tabs,
    setAddress,
    addressRef,
  });

  // A chat link or page card asks this session's pane for an address; the
  // host page loads it (the tap usually reveals the pane in the same press).
  const takeAddress = useRef((_request: { url: string; newTab: boolean }) => {});
  takeAddress.current = ({ url, newTab: inNewTab }) => {
    if (inNewTab && tabsSupported) void openTab(url);
    else navigate(url);
  };
  useEffect(() => {
    if (!active) return undefined;
    return onBrowserPageAddressTaken(sessionId, (request) => takeAddress.current(request));
  }, [active, sessionId]);

  const { historySuggestions, setHistorySuggestions } = useHistorySuggestions(api, address, addressHasFocus);
  // A loopback page is the PC's own and already shown here; this device's
  // browser would reach itself, so it has no "system browser" to go to.
  const externalUrl = frame?.url && frame.url !== 'about:blank' && !isLoopbackWebUrl(frame.url) ? frame.url : '';
  const moreActions = useRemoteMoreActions({
    api,
    ownerSessionId,
    active,
    frame,
    phone,
    narrow,
    keyboardOpen,
    setKeyboardOpen,
    zoomLevel,
    changeZoomLevel,
    externalUrl,
    openImport: () => setImportOpen(true),
  });

  return (
    <div className="browser-pane browser-remote-pane" data-surface-active={active ? 'true' : 'false'}>
      {phone && (
        <RemotePhoneHeader
          streamId={streamId}
          frame={frame}
          externalUrl={externalUrl}
          stripTabs={stripTabs}
          moreActions={moreActions}
          selectTab={selectTab}
          closeDockTab={closeDockTab}
          createStripTab={createStripTab}
        />
      )}
      <div className="browser-pane-toolbar">
        <RemoteNavButtons frame={frame} iconSize={phone ? 15 : 16} control={control} />
        <RemoteAddressForm
          addressRef={addressRef}
          addressFocused={addressFocused}
          address={address}
          setAddress={setAddress}
          setAddressHasFocus={setAddressHasFocus}
          newTab={newTab}
          setNewTab={setNewTab}
          externalUrl={externalUrl}
          historySuggestions={historySuggestions}
          go={go}
        />
        {phone && api?.browserProfileImportSources && (
          <button
            type="button"
            className="browser-pane-nav-button browser-pane-import-button"
            onClick={() => setImportOpen(true)}
            aria-label={t('Import from browser')}
            data-tooltip={t('Import from browser')}
          >
            <Link2 size={15} />
          </button>
        )}
        {!phone && (
          <RemoteToolbarActions
            api={api}
            keyboardOpen={keyboardOpen}
            setKeyboardOpen={setKeyboardOpen}
            narrow={narrow}
            externalUrl={externalUrl}
            moreActions={moreActions}
          />
        )}{' '}
      </div>
      {!phone && tabsSupported && tabs.length > 0 && (
        <div className="browser-pane-popup-tabs">
          <BrowserTabStrip
            tabs={stripTabs}
            onSelect={async (id) => selectTab(id)}
            onClose={closeDockTab}
            onCreate={addressNewTab}
          />
        </div>
      )}
      <BrowserImportDialog open={importOpen} onClose={() => setImportOpen(false)} />{' '}
      <RemoteKeyboardBar
        keyboardRef={keyboardRef}
        open={keyboardOpen}
        onClose={() => setKeyboardOpen(false)}
        input={input}
      />
      <div className="browser-remote-stage">
        <RemoteBrowserContent
          contentRef={contentRef}
          imageRef={imageRef}
          input={input}
          touch={touch}
          imageUrl={imageUrl}
          title={frame?.title}
          zoomLevel={zoomLevel}
          pan={pan}
          failure={failure}
          actionFailure={actionFailure}
          setActionFailure={setActionFailure}
          touchDot={touchDot}
          zoomPill={!phone}
          changeZoomLevel={changeZoomLevel}
        />
        {frame?.dialog && (
          <BrowserPagePrompts
            key={`${frame.documentId}:${frame.dialog.id}`}
            frame={frame}
            control={async (action) => {
              if (action.type === 'answer-dialog') await control({ ...action, documentId: frame.documentId });
            }}
          />
        )}
      </div>
    </div>
  );
}
