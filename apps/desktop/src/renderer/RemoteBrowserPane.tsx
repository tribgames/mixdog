import {
  ArrowLeft,
  ArrowUp,
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
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from 'react';

import type { DesktopBrowserTab, DesktopRemoteBrowserControl } from '../shared/contract';
import { remoteBrowserDriveViewport, remoteBrowserImagePoint } from '../shared/remote-browser';
import { useCompositionFinisher } from './remote-composition';
import { remoteWebrtcHost } from './remote-webrtc-bridge';
import { remotePinchMaxZoom } from './remote-view-zoom';
import { useNarrowToolbar, useRemoteFrameZoom, useRemoteView, type RemoteZoom } from './remote-browser-view';
import { useRemoteWebrtc } from './use-remote-webrtc';
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
import { createPhoneTouchController, createRemoteTouchController } from './remote-browser-touch';
import { useBrowserPageInput } from './use-browser-page-input';
import {
  REMOTE_CONNECTION_READY_EVENT,
  STREAM_RENEW_MS,
  useRemoteBrowserStream,
  type StreamFrameMeta,
} from './use-remote-browser-stream';
import { useRemoteBrowserTabs } from './use-remote-browser-tabs';
import { browserTakeoverCovers } from './browser-takeover-input';
import { stepZoom } from './zoom-range';
import { BrowserZoomPill } from './BrowserZoomPill';
import { useZoomBarVisible, zoomBarAction } from './zoom-bar-pref';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import type { BrowserPaneProps } from './BrowserPane.lazy';
import { emptyStateHost } from './empty-state-host';

type TouchDot = { x: number; y: number; size?: number; key: number };

/** The gestures the picture's touch surface takes, on either controller. */
type RemoteTouch = Pick<
  ReturnType<typeof createPhoneTouchController>,
  'down' | 'move' | 'up' | 'cancel' | 'contacts' | 'dispose'
>;

/** The view's side of touch, read per gesture: the phone's viewport, or the
 *  desktop pane's fitted zoom (which also pans only when zoomed in, and fits
 *  back on a double tap). */
type TouchView = {
  pinch(scale: number, x: number, y: number, dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  panning(): boolean;
  fitted(): boolean;
  fit(): void;
  press(): void;
};

function useRemoteTouch({
  phone,
  client,
  frameRef,
  imageRef,
  contentRef,
  setTouchDot,
  tapRef,
  gestureRef,
}: {
  phone: boolean;
  client: ReturnType<typeof createRemoteBrowserInputClient>;
  frameRef: RefObject<RemoteInputFrame | null>;
  imageRef: RefObject<HTMLElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  setTouchDot: Dispatch<SetStateAction<TouchDot | null>>;
  /** Called after each tap that reached the page. */
  tapRef: RefObject<() => void>;
  /** The view's side and the pre-press hook (composition), read per gesture. */
  gestureRef: RefObject<TouchView>;
}): RemoteTouch {
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
    const dot = (x: number, y: number, size?: number) => {
      const box = contentRef.current?.getBoundingClientRect();
      setTouchDot({ x: x - (box?.left ?? 0), y: y - (box?.top ?? 0), size, key: Date.now() + Math.random() });
      window.clearTimeout(dotTimer);
      dotTimer = window.setTimeout(() => setTouchDot(null), TOUCH_INDICATOR_MS);
    };
    const pageDelta = (dx: number, dy: number) => {
      const picture = frameRef.current;
      const bounds = imageRef.current?.getBoundingClientRect();
      if (!picture || !bounds || !(picture.width > 0) || !(picture.height > 0)) return { x: 0, y: 0 };
      const scale = Math.min(bounds.width / picture.width, bounds.height / picture.height);
      return {
        x: (dx * picture.viewportWidth) / (picture.width * scale),
        y: (dy * picture.viewportHeight) / (picture.height * scale),
      };
    };
    const shared = {
      page: viewportPoint,
      pageDelta,
      send: (action: Parameters<typeof client.fire>[0]) => client.fire(action),
      tapped: () => tapRef.current(),
      press: () => gestureRef.current.press(),
      pinch: (scale: number, x: number, y: number, dx: number, dy: number) =>
        gestureRef.current.pinch(scale, x, y, dx, dy),
      pan: (dx: number, dy: number) => gestureRef.current.pan(dx, dy),
    };
    if (!phone) {
      return createRemoteTouchController({
        ...shared,
        fitted: () => gestureRef.current.fitted(),
        fit: () => gestureRef.current.fit(),
        panning: () => gestureRef.current.panning(),
        indicator: (x, y) => dot(x, y),
      });
    }
    return createPhoneTouchController({
      ...shared,
      screen: () => ({ width: window.innerWidth, height: window.innerHeight }),
      indicator: (x, y, radius) => dot(x, y, radius * 2),
    });
  }, [phone, client, viewportPoint, frameRef, imageRef, contentRef, setTouchDot, tapRef, gestureRef]);
}

const noFinish = () => {};

/** Human input to the streamed page: one ordered queue to the host, the
 *  keyboard/mouse client, page shortcuts, and touch on the frame image. */
function useRemotePageInput({
  phone,
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
  setTouchDot,
  tapRef,
  gestureRef,
  routeRef,
}: {
  tapRef: RefObject<() => void>;
  gestureRef: RefObject<TouchView>;
  /** Phone touch (the shared gesture layer) or the desktop pane's. */
  phone: boolean;
  /** Page input's owner (WebRTC channel or relay queue); null: the queue. */
  routeRef: RefObject<((control: DesktopRemoteBrowserControl) => Promise<void>) | null>;
  api: typeof window.mixdogDesktop;
  active: boolean;
  ownerSessionId: string;
  setActionFailure: Dispatch<SetStateAction<string>>;
  frameRef: RefObject<RemoteInputFrame | null>;
  imageRef: RefObject<HTMLElement | null>;
  keyboardRef: RefObject<HTMLTextAreaElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  addressRef: RefObject<HTMLInputElement | null>;
  /** The view's zoom, read when a shortcut asks for it. */
  zoomRef: RefObject<RemoteZoom | null>;
  setTouchDot: Dispatch<SetStateAction<TouchDot | null>>;
}) {
  const inputQueue = useMemo(
    () =>
      createRemoteBrowserInputQueue({
        send: async (input, order) => {
          // A host serving ordered input takes each control as it comes.
          if (order && remoteWebrtcHost(api)) await api.remoteBrowserControlOrdered!(ownerSessionId, input, order);
          else await api?.remoteBrowserControl?.(ownerSessionId, input);
        },
        pipelined: () => remoteWebrtcHost(api),
        failure: (message) => setActionFailure(browserInputNotice(message)),
        settled: () => {},
      }),
    [api, ownerSessionId, setActionFailure]
  );
  const shortcutRef = useRef((_name: string) => {});
  shortcutRef.current = (name) => {
    const zoom = zoomRef.current;
    if (name === 'address') addressRef.current?.focus();
    else if (!zoom) return;
    else if (name === 'zoom-in') zoom.set(stepZoom(zoom.level, 1, zoom.range));
    else if (name === 'zoom-out') zoom.set(stepZoom(zoom.level, -1, zoom.range));
    else if (name === 'zoom-reset') zoom.reset();
  };
  const client = useMemo(
    () =>
      createRemoteBrowserInputClient({
        frame: () => frameRef.current,
        send: (input) => {
          setActionFailure('');
          return routeRef.current ? routeRef.current(input) : inputQueue.enqueue(input);
        },
        failure: (message) => setActionFailure(browserInputNotice(message)),
        shortcut: (name) => shortcutRef.current(name),
      }),
    [inputQueue, frameRef, setActionFailure, routeRef]
  );
  // The phone's typing bar sends at once (what is typed stays in the bar until
  // send), so no half-typed syllable ever needs finishing before a touch; the
  // desktop's bar types live and does.
  const pageInput = useBrowserPageInput(client, imageRef, keyboardRef, { sendAtOnce: phone });
  const composition = useCompositionFinisher(pageInput, keyboardRef);
  const input = phone ? pageInput : composition.handlers;
  const finishComposition = phone ? noFinish : composition.finish;
  const inputRef = useRef(input);
  inputRef.current = input;

  const touch = useRemoteTouch({
    client,
    frameRef,
    phone,
    imageRef,
    contentRef,
    setTouchDot,
    tapRef,
    gestureRef,
  });

  // Declared before the queue effect so an unmount releases a held press
  // (and flushes coalesced motion) before the queue stops accepting input.
  useEffect(
    () => () => {
      touch.dispose();
      client.flush();
    },
    [touch, client]
  );
  const dropTouch = useCallback(() => {
    touch.dispose();
    client.flush();
  }, [touch, client]);
  const touchLost = useCallback(
    (pointerId: number) => {
      touch.cancel(pointerId);
      client.flush();
    },
    [touch, client]
  );
  useEffect(() => {
    if (!phone) return undefined;
    const hidden = () => {
      if (document.visibilityState === 'hidden') dropTouch();
    };
    window.addEventListener('blur', dropTouch);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', dropTouch);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [phone, dropTouch]);
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
  return {
    inputQueue,
    input,
    touch,
    touchLost: phone ? touchLost : undefined,
    resetDocumentInput,
    finishComposition,
  };
}

/** The pane's tab strip actions on top of the host's tabs. */
function useRemoteDockTabs({
  setAddress,
  addressRef,
  closeDock,
  borrowed,
  ...options
}: Parameters<typeof useRemoteBrowserTabs>[0] & {
  setAddress: Dispatch<SetStateAction<string>>;
  addressRef: RefObject<HTMLInputElement | null>;
  closeDock(): void;
  /** The panel shows another session's page: a tab ✕ only dismisses it. */
  borrowed: boolean;
}) {
  const { sessionTabsSupported, closeTab, createSessionTab, closeSessionTab, ...remoteTabs } =
    useRemoteBrowserTabs(options);
  const { tabs, tabsSupported, setNewTab } = remoteTabs;

  // Closing the only tab closes the side panel; the host keeps its page.
  const closeDockTab = async (id: string) => {
    if (borrowed) closeDock();
    else if (sessionTabsSupported) {
      // Like the PC pane, the panel closes with the last tab, but that is the
      // host's count after the close: the strip may be stale, and the PC may
      // have added or closed a tab meanwhile.
      const reply = await closeSessionTab(id);
      if (reply?.remainingTabs === 0) closeDock();
    } else if (tabs.length < 2) closeDock();
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
  closeDock,
}: {
  closeDock(): void;
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
      onClose={closeDock}
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
  zoom: RemoteZoom;
  externalUrl: string;
  openImport(): void;
  /** A host that locks the page geometry: fit it to this screen, or back to
   *  its own size, only on this explicit choice. */
  fitPage: { fitted: boolean; toggle(): void } | null;
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
  zoom,
  externalUrl,
  openImport,
  fitPage,
}: MoreActionOptions & {
  credentials: Pick<
    ReturnType<typeof useBrowserCredentials>,
    'credentialBusy' | 'credentialStatus' | 'credentialSuggestions' | 'fillStoredCredential'
  >;
}): DockAction[] {
  const openExternalAction = (separatorBefore: boolean): DockAction => ({
    id: 'open-external',
    label: t('Open in system browser'),
    icon: ExternalLink,
    separatorBefore,
    disabled: !externalUrl,
    onSelect: () => {
      if (externalUrl) void api?.openExternal(externalUrl);
    },
  });
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
  if (fitPage) {
    moreActions.push({
      id: 'fit-page',
      label: t('Fit page to screen'),
      checked: fitPage.fitted,
      checkbox: true,
      separatorBefore: moreActions.length > 0,
      onSelect: fitPage.toggle,
    });
  }
  if (phone) {
    // The PC pane has no zoom or external-open button; on the phone they live
    // in ⋯ (the typing bar is always docked under the page).
    moreActions.push(
      {
        id: 'zoom-in',
        label: t('Zoom in'),
        icon: ZoomIn,
        separatorBefore: moreActions.length > 0,
        disabled: zoom.level >= zoom.range.max,
        onSelect: () => zoom.set(stepZoom(zoom.level, 1, zoom.range)),
      },
      {
        id: 'zoom-out',
        label: t('Zoom out'),
        icon: ZoomOut,
        disabled: zoom.level <= zoom.range.min,
        onSelect: () => zoom.set(stepZoom(zoom.level, -1, zoom.range)),
      },
      {
        id: 'zoom-reset',
        label: t('Reset zoom'),
        detail: `${Math.round(zoom.level * 100)}%`,
        disabled: zoom.initial,
        onSelect: () => zoom.reset(),
      },
      openExternalAction(true)
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
  if (narrow) moreActions.push(openExternalAction(moreActions.length > 0));
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
  phone,
  onClose,
  onSend,
  input,
}: {
  keyboardRef: RefObject<HTMLTextAreaElement | null>;
  open: boolean;
  phone: boolean;
  onClose(): void;
  /** Send: a running composition is committed, then the bar's whole text goes
   *  to the page in one piece (an Enter key when the bar is empty). */
  onSend(): void;
  input: PageInput;
}) {
  return (
    <div className={`browser-remote-keyboard${phone ? ' is-composer' : ''}`} data-open={open ? 'true' : 'false'}>
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
        onKeyUp={input.onKeyUp}
        onInput={input.onInput}
        onPaste={input.onPaste}
        onFocus={input.onFocus}
        onBlur={input.onBlur}
        onCompositionStart={input.onCompositionStart}
        onCompositionUpdate={input.onCompositionUpdate}
        onCompositionEnd={input.onCompositionEnd}
      />
      {phone ? (
        <button
          type="button"
          className="send-button"
          aria-label={t('Send')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onSend}
        >
          <ArrowUp size={16} />
        </button>
      ) : (
        <button type="button" onClick={onClose} aria-label={t('Close')}>
          <X size={16} />
        </button>
      )}
    </div>
  );
}

/** Reads every contact of a touch gesture from its touch lists. */
function useTouchContactReader(contentRef: RefObject<HTMLDivElement | null>, touch: RemoteTouch) {
  // iOS WebKit takes a touch on the frame for its own scroll or zoom despite
  // `touch-action: none`; React registers touch listeners passive, so they are
  // bound here to cancel it. A touch list carries every contact, a pointer event one.
  const touchRef = useRef(touch);
  touchRef.current = touch;
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    const hold = (event: TouchEvent) => {
      if (event.target === content && event.cancelable) event.preventDefault();
    };
    const moved = (event: TouchEvent) => {
      hold(event);
      const points = Array.from(event.touches)
        .filter((contact) => content.contains(contact.target as Node))
        .map((contact) => ({ x: contact.clientX, y: contact.clientY }));
      touchRef.current.contacts(points);
    };
    // touchstart too: a gesture whose touch lists arrive is known before its
    // first move, so its motion never rides the pointer-only fallback.
    content.addEventListener('touchstart', moved, { passive: false });
    content.addEventListener('touchmove', moved, { passive: false });
    return () => {
      content.removeEventListener('touchstart', moved);
      content.removeEventListener('touchmove', moved);
    };
  }, [contentRef]);
}

/** The "fit page to this device" choice, offered only where the host locks
 *  the page geometry. */
function useRemotePageFit(
  webrtc: ReturnType<typeof useRemoteWebrtc>,
  contentRef: RefObject<HTMLDivElement | null>,
  fitView: ReturnType<typeof useRemoteBrowserStream>['fitView']
) {
  // The menu's choice holds only while the stream's fit is the one it was made over.
  const [explicitFit, setExplicitFit] = useState<{ fitted: boolean; basis: typeof fitView } | null>(null);
  const pageFitted = explicitFit?.basis === fitView ? explicitFit.fitted : fitView.asked;
  const fitPage = webrtc.geometryLocked
    ? {
        fitted: pageFitted,
        toggle: () => {
          const box = contentRef.current?.getBoundingClientRect();
          const viewport = pageFitted ? null : remoteBrowserDriveViewport(box, window.devicePixelRatio || 1);
          if (!pageFitted && !viewport) return;
          webrtc.requestResize(
            viewport
              ? {
                  mode: 'fit-client',
                  cssWidth: viewport.width,
                  cssHeight: viewport.height,
                  deviceScaleFactor: viewport.deviceScaleFactor,
                }
              : { mode: 'page' }
          );
          setExplicitFit({ fitted: !pageFitted, basis: fitView });
        },
      }
    : null;
  return fitPage;
}
/** The streamed frame: mouse input goes to the page as is, touch through the
 *  touch controller; connection and action failures show over it. */
function RemoteBrowserContent({
  contentRef,
  imageRef,
  input,
  touch,
  touchLost,
  imageUrl,
  title,
  pictureStyle,
  zoom,
  failure,
  actionFailure,
  setActionFailure,
  touchDot,
  zoomPill,
  videoRef,
  showsVideo,
  covered,
  finishComposition,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The WebRTC video is the picture (the image stays underneath, hidden). */
  showsVideo: boolean;
  /** A take-over waits for its fitted page: the loading state covers the pane. */
  covered: boolean;
  /** A press reaches the page: typing's composition is finished first. */
  finishComposition(): void;
  contentRef: RefObject<HTMLDivElement | null>;
  imageRef: RefObject<HTMLImageElement | null>;
  input: PageInput;
  touch: RemoteTouch;
  /** A touch pointer's capture was lost (its stream may end unseen): absent
   *  where touch keeps no state that a lost stream could leave held. */
  touchLost?(pointerId: number): void;
  imageUrl: string;
  title: string | undefined;
  /** The picture's box and view transform; null: plain fit (no view yet). */
  pictureStyle: CSSProperties | null;
  zoom: RemoteZoom;
  failure: string;
  actionFailure: string;
  setActionFailure(failure: string): void;
  touchDot: TouchDot | null;
  zoomPill: boolean;
}) {
  const zoomBarVisible = useZoomBarVisible();
  useTouchContactReader(contentRef, touch);
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') {
      finishComposition();
      return input.onPointerDown(event);
    }
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
        else touchLost?.(event.pointerId);
      }}
      onWheel={input.onWheel}
      onContextMenu={(event) => event.preventDefault()}
    >
      {imageUrl && (
        <img
          ref={imageRef}
          src={imageUrl}
          draggable={false}
          style={{ ...pictureStyle, ...(showsVideo ? { visibility: 'hidden' } : {}) }}
          alt={title || 'Browser Use'}
        />
      )}
      {/* The WebRTC picture: decoding (and reporting frames) under the JPEG
          view until it is promoted, then the picture itself at its decoded
          resolution. */}
      <video
        ref={videoRef}
        className="browser-remote-video"
        muted
        playsInline
        autoPlay
        disablePictureInPicture
        aria-hidden={showsVideo ? undefined : true}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          pointerEvents: 'none',
          opacity: showsVideo ? 1 : 0,
          ...pictureStyle,
        }}
      />
      {(covered || (!imageUrl && !showsVideo)) && (
        <div className="browser-remote-empty mx-empty-state mx-empty-state-cover" ref={emptyStateHost}>
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
          style={
            touchDot.size === undefined
              ? { left: touchDot.x, top: touchDot.y }
              : {
                  left: touchDot.x,
                  top: touchDot.y,
                  width: touchDot.size,
                  height: touchDot.size,
                  margin: -touchDot.size / 2,
                }
          }
          aria-hidden="true"
        />
      )}
      {zoomPill && zoomBarVisible && imageUrl && <BrowserZoomPill level={zoom.level} onChange={zoom.set} />}
    </div>
  );
}

export { STREAM_RENEW_MS } from './use-remote-browser-stream';
export const TOUCH_INDICATOR_MS = 450;

/** `onDockClose` is given when the panel shows another session's page: it
 *  replaces the default close (the focused dock) with the viewer's own dock,
 *  and a tab ✕ then only dismisses the view, leaving the page's tab. */
export default function RemoteBrowserPane({
  sessionId,
  active,
  onDockClose,
}: BrowserPaneProps & { onDockClose?: () => void }) {
  const api = window.mixdogDesktop;
  const closeDock = onDockClose ?? (() => requestPaneDockClose('browser'));
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
  // The picture input maps through and zoom transforms: the WebRTC video
  // while it is shown, else the frame image; and the geometry that goes with it.
  const webrtcRef = useRef<ReturnType<typeof useRemoteWebrtc> | null>(null);
  const surfaceRef = useMemo(
    () =>
      ({
        get current(): HTMLElement | null {
          return webrtcRef.current?.showsVideo ? webrtcRef.current.videoRef.current : imageRef.current;
        },
      }) as RefObject<HTMLElement | null>,
    []
  );
  const inputFrameRef = useMemo(
    () =>
      ({
        get current(): RemoteInputFrame | null {
          return webrtcRef.current ? webrtcRef.current.inputFrame(frameRef.current) : frameRef.current;
        },
      }) as RefObject<RemoteInputFrame | null>,
    []
  );
  const routeRef = useRef<((control: DesktopRemoteBrowserControl) => Promise<void>) | null>(null);
  // The view's picture is the page's CSS size, the same for the JPEG and the
  // video (a refused, mid-resize video geometry keeps the frame's).
  const shownGeometry = inputFrameRef.current;
  const pictureGeometry = shownGeometry && shownGeometry.viewportWidth > 0 ? shownGeometry : frame;
  // The phone's view (remote-viewport.ts); the desktop pane keeps its fitted zoom.
  const remoteView = useRemoteView(
    contentRef,
    phone,
    pictureGeometry?.viewportWidth ?? 0,
    pictureGeometry?.viewportHeight ?? 0
  );
  const frameZoom = useRemoteFrameZoom(sessionId, ownerSessionId, surfaceRef);
  const zoom = phone ? remoteView.zoom : frameZoom.zoom;
  const pictureStyle = phone ? remoteView.pictureStyle : frameZoom.pictureStyle;
  const zoomRef = useRef<RemoteZoom | null>(null);
  zoomRef.current = zoom;

  // Another page: nothing of the previous one (frame, image, view) carries over.
  const shownStream = useRef(streamId);
  const forgetView = remoteView.forget;
  const forgetFrameZoom = useRef(frameZoom.forget);
  forgetFrameZoom.current = frameZoom.forget;
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
    forgetView();
    forgetFrameZoom.current(streamId);
  }, [streamId, forgetView]);
  // The pane's own tab is the page it starts from again if it is retargeted.
  useEffect(() => {
    setStreamId(sessionId);
  }, [sessionId]);

  const tapRef = useRef(() => {});
  tapRef.current = () => {
    const field = keyboardRef.current;
    if (!field || !browserTakeoverCovers(ownerSessionId, frameRef.current?.documentId ?? '')) return;
    // Already focused after the keyboard was dismissed: focus again to re-raise it.
    if (document.activeElement === field) field.blur();
    field.focus({ preventScroll: true });
  };
  const gestureRef = useRef<TouchView>({
    pinch: () => {},
    pan: () => {},
    panning: () => false,
    fitted: () => true,
    fit: () => {},
    press: () => {},
  });
  const { inputQueue, input, touch, touchLost, resetDocumentInput, finishComposition } = useRemotePageInput({
    phone,
    tapRef,
    gestureRef,
    routeRef,
    api,
    active,
    ownerSessionId,
    setActionFailure,
    frameRef: inputFrameRef,
    imageRef: surfaceRef,
    keyboardRef,
    contentRef,
    addressRef,
    zoomRef,
    setTouchDot,
  });
  const webrtc = useRemoteWebrtc({
    api,
    active,
    sessionId: ownerSessionId,
    queue: inputQueue,
    frameRef,
    dropInput: resetDocumentInput,
    failure: (message) => setActionFailure(browserInputNotice(message)),
    statsIntervalMs: STREAM_RENEW_MS,
  });
  webrtcRef.current = webrtc;
  routeRef.current = webrtc.route;
  gestureRef.current = phone
    ? {
        pinch: remoteView.pinch,
        pan: remoteView.pan,
        panning: () => true,
        fitted: () => true,
        fit: () => {},
        press: finishComposition,
      }
    : {
        pinch: (scale, x, y, dx, dy) => {
          const box = contentRef.current?.getBoundingClientRect() ?? { width: 0, height: 0 };
          const source = webrtc.showsVideo
            ? webrtc.videoSource()
            : frameRef.current && { width: frameRef.current.width, height: frameRef.current.height };
          frameZoom.pinch(scale, x, y, dx, dy, remotePinchMaxZoom(box, source, window.devicePixelRatio || 1));
        },
        pan: frameZoom.panBy,
        panning: () => frameZoom.zoomRef.current > 1,
        fitted: () => frameZoom.zoomRef.current === 1,
        fit: () => frameZoom.zoom.set(1),
        press: finishComposition,
      };
  // Geometry is the host's; a phone takes the page at its own size on open
  // (fitOnOpen), any other device only when told to.
  const { awaitingFit, videoShown, fitView } = useRemoteBrowserStream({
    onFrame: webrtc.relayFrame,
    onPresented: webrtc.relayPresented,
    api,
    active,
    ownerSessionId,
    fitOnOpen: phone,
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
  const fitPage = useRemotePageFit(webrtc, contentRef, fitView);
  // A promoted video carries the picture (no JPEG image comes): its frame of
  // the fitted page uncovers a take-over too. Checked as the viewer changes.
  useEffect(() => {
    const shown = awaitingFit && webrtc.showsVideo ? webrtc.inputFrame(frameRef.current) : null;
    if (shown) videoShown(shown);
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
    closeDock,
    borrowed: Boolean(onDockClose),
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
  // The phone docks the typing bar under the page, always shown, in the
  // chat composer's look with a send button; the soft keyboard lowers with the
  // system back / keyboard dismiss. Elsewhere the toolbar button toggles it.
  const keyboardBar = (
    <RemoteKeyboardBar
      keyboardRef={keyboardRef}
      open={phone || keyboardOpen}
      phone={phone}
      onClose={() => setKeyboardOpen(false)}
      onSend={input.submit}
      input={input}
    />
  );
  const moreActions = useRemoteMoreActions({
    api,
    ownerSessionId,
    active,
    frame,
    phone,
    narrow,
    zoom,
    externalUrl,
    openImport: () => setImportOpen(true),
    fitPage,
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
          closeDock={closeDock}
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
      <BrowserImportDialog open={importOpen} onClose={() => setImportOpen(false)} /> {!phone && keyboardBar}
      <div className="browser-remote-stage">
        <RemoteBrowserContent
          contentRef={contentRef}
          imageRef={imageRef}
          input={input}
          touch={touch}
          touchLost={touchLost}
          imageUrl={imageUrl}
          title={frame?.title}
          pictureStyle={pictureStyle}
          zoom={zoom}
          failure={failure}
          actionFailure={actionFailure}
          setActionFailure={setActionFailure}
          touchDot={touchDot}
          zoomPill={!phone}
          videoRef={webrtc.videoRef}
          showsVideo={webrtc.showsVideo && !awaitingFit}
          covered={awaitingFit}
          finishComposition={finishComposition}
        />
        {/* Every touch on the page drives the PC page, so the phone's
            swipe that pushes this sheet away starts on its own edge strip. */}
        {phone && <div className="browser-remote-swipe-grip" data-edge-swipe-grip="" aria-hidden="true" />}
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
      {phone && keyboardBar}
    </div>
  );
}
