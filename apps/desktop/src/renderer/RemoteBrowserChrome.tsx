import { ArrowLeft, ArrowRight, ArrowUp, ExternalLink, Keyboard, RotateCw, X } from 'lucide-react';
import {
  useEffect,
  useRef,
  type CSSProperties,
  type Dispatch,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type SetStateAction,
} from 'react';

import type { DesktopBrowserTab, DesktopRemoteBrowserControl } from '../shared/contract';
import type { useHistorySuggestions } from './browser-pane-hooks';
import { BrowserTabStrip } from './BrowserTabStrip';
import { BrowserZoomPill } from './BrowserZoomPill';
import { emptyStateHost } from './empty-state-host';
import { ErrorNotice } from './ErrorNotice';
import { t } from './i18n';
import { DockHeaderRow, DockOverflowMenu, type DockAction } from './pane-dock-chrome';
import { ProgressSpinner } from './ProgressSpinner';
import type { RemoteZoom } from './remote-browser-view';
import type { createPhoneTouchController } from './remote-browser-touch';
import type { useBrowserPageInput } from './use-browser-page-input';
import type { StreamFrameMeta } from './use-remote-browser-stream';
import { useZoomBarVisible } from './zoom-bar-pref';

export type TouchDot = { x: number; y: number; size?: number; key: number };

/** The gestures the picture's touch surface takes, on either controller. */
export type RemoteTouch = Pick<
  ReturnType<typeof createPhoneTouchController>,
  'down' | 'move' | 'up' | 'cancel' | 'contacts' | 'dispose'
>;

/** Phone row 1 is the PC browser dock's header row: tab strip, ⋯, close. */
export function RemotePhoneHeader({
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

export function RemoteAddressForm({
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

export function RemoteNavButtons({
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
export function RemoteToolbarActions({
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
export function RemoteKeyboardBar({
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

/** The streamed frame: mouse input goes to the page as is, touch through the
 *  touch controller; connection and action failures show over it. */
export function RemoteBrowserContent({
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
