/**
 * Every page runs outside the shell's focus tree on the shared partition.
 * Primary pages outlive panel visibility; named support pages retain their
 * bounded, session-scoped lifetimes.
 */
import type { BrowserWindow, WebContents } from 'electron';
import { app, screen } from 'electron';

import type { DesktopBrowserOpenRequest } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import { BROWSER_PARTITION, NAVIGATE_SETTLE_TIMEOUT_MS, OFFSCREEN_VIEWPORT } from './command';
import { createBrowserBackgroundPages } from './guest-background-pages';
import { createBrowserGuestInitializer } from './guest-initialize';
import { createBrowserSessionRestore } from './guest-session-restore';
import type { BrowserGuestStateStore } from './guest-state';
import { createBrowserSurfaceRequests } from './guest-surface-requests';
import { type BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID } from './session-registry';
import { createBrowserPageOwner } from './page-owner';
import { adoptBrowserPageWindow, createBrowserPageWindow } from './page-window';
import { builtPreloadPath } from './preload-path';
import type { PopupOpeningHost } from './popup-opening';
import { createBrowserPanelFold } from './panel-fold';
import type { BrowserUrlPolicy } from './url-policy';

interface BrowserGuestLifecycleHost {
  window: BrowserWindow;
  partitionSession: Electron.Session;
  state: BrowserGuestStateStore;
  sessions: BrowserSessionRegistry;
  cdp: Pick<BrowserGuestCdp, 'guestDebugger' | 'attachOpenedPage'>;
  urlPolicy: BrowserUrlPolicy;
  /** A background page mid-command must not be reclaimed as idle. */
  isBackgroundBusy(sessionId: string, name: string): boolean;
  /** Whether work is still running against the session's visible page. */
  isPageBusy?(sessionId: string): boolean;
  /** `selected`: a person's gesture opened it, and it is now their selected tab. */
  onPopup?(opener: WebContents, popup: WebContents, selected: boolean): void;
  onGuest?(guest: WebContents): void;
  /** The display client was asked to reveal or hide the session's surface. */
  onSurfaceRequest?(request: DesktopBrowserOpenRequest): void;
  waitForLoadSettle(guest: WebContents, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
  /** True once a panel (or native view) on this PC shows the page; false
   *  when none does within `timeoutMs` (display-tracking). */
  waitUntilShown?(guest: WebContents, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  /** Native presentation: pages compose as views in their own parked,
   *  frameless windows; the shell adopts the view the pane shows (see
   *  native-view and page-window). */
  nativeView?: boolean;
}

/** Guests always compose offscreen; where Chromium can hand that composited
 *  frame to the GPU directly, every display read takes the shared texture
 *  instead of a bitmap. One predicate keeps the window options and the display
 *  capture path from disagreeing about which frames a guest produces. */
export function browserSharedTextureRendering(): boolean {
  return process.platform === 'win32' && app.isHardwareAccelerationEnabled();
}

/** Every page owner runs on the shared partition, so its window options are
 *  fixed: hidden, unfocusable, offscreen-composited (unless natively presented)
 *  and throttled unless displayed or driven (see page-power). */
export function offscreenWindowOptions(nativeView = false): Electron.BrowserWindowConstructorOptions {
  // Electron 42+ renders an offscreen view at scale 1 unless told otherwise;
  // keep the primary display's scale it took before (see frame-pixels).
  const deviceScaleFactor = screen.getPrimaryDisplay().scaleFactor;
  let offscreen: boolean | Electron.Offscreen = { deviceScaleFactor };
  if (nativeView) offscreen = false;
  else if (browserSharedTextureRendering()) offscreen = { useSharedTexture: true, deviceScaleFactor };
  const toolWindowType = process.platform === 'win32' ? { type: 'toolbar' as const } : {};
  return {
    show: false,
    focusable: false,
    // A page's own default, like its view (page-window.ts): the window's
    // default would be black between pages.
    backgroundColor: '#ffffff',
    // A native page's window holds nothing but the page, at exactly its
    // content size, and as a tool window never appears in Alt+Tab.
    ...(nativeView
      ? {
          frame: false,
          thickFrame: false,
          resizable: false,
          roundedCorners: false,
          hasShadow: false,
          skipTaskbar: true,
          ...toolWindowType,
        }
      : {}),
    width: OFFSCREEN_VIEWPORT.width,
    height: OFFSCREEN_VIEWPORT.height,
    webPreferences: {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // These page owners are never shown. Offscreen rendering gives Chromium
      // a live compositor without activating a native window.
      offscreen,
      // Pages are throttled by default; page-power lifts it while a panel
      // displays the page or an agent command drives it.
      backgroundThrottling: true,
      // A page's own JavaScript dialog is an OS dialog box in Electron, outside
      // the pane and nobody's to answer. Dialogs reach the pane through the
      // dialog bridge; anything that slips past it is dismissed instead.
      disableDialogs: true,
      // Only its own zoom, never the one Chromium shares across a site's
      // pages (page-zoom.ts); nothing of it reaches the page's world.
      preload: builtPreloadPath('browser-page.js'),
    },
  };
}

/** Popup windows stay hidden and non-focusable, but use their native view:
 *  inherited offscreen popup views can remain at zero size. */
function popupWindowOptions(nativeView = false): Electron.BrowserWindowConstructorOptions {
  const options = offscreenWindowOptions(nativeView);
  return { ...options, webPreferences: { ...options.webPreferences, offscreen: false } };
}

export function createBrowserGuestLifecycle(host: BrowserGuestLifecycleHost) {
  const { window, state, sessions, urlPolicy, waitForLoadSettle } = host;
  const createPage = () => createBrowserPageWindow(offscreenWindowOptions(host.nativeView === true), host.nativeView);
  const backgroundPages = createBrowserBackgroundPages(host, {
    create: createPage,
    initialize: (guest, attach) => guests.initializeGuest(guest, attach),
  });
  const popupOpening: PopupOpeningHost = {
    state,
    urlPolicy,
    admit: (opener) => backgroundPages.admit(sessions.sessionIdForGuest(opener) ?? DEFAULT_BROWSER_SESSION_ID),
    nativeView: () => Boolean(host.nativeView),
    popupWindowOptions,
    createPage: createBrowserPageWindow,
    adoptWindow: adoptBrowserPageWindow,
    adoptPopup: (opener, popup, select) => backgroundPages.adoptPopup(opener, popup, select),
  };
  const guests = createBrowserGuestInitializer(host, popupOpening);
  const surface = createBrowserSurfaceRequests(host);
  const { requestBrowserSurface } = surface;

  const panelFold = createBrowserPanelFold({
    sessions,
    hide: (sessionId) => {
      try {
        requestBrowserSurface(sessionId, 'hide');
      } catch {
        /* the window is gone: no panel is left to fold */
      }
    },
  });

  // A legacy/misconfigured renderer must not reintroduce the shared input tree.
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const primaryPages = createBrowserPageOwner({
    sessions,
    create: createPage,
    initialize: guests.initializeGuest,
    // A pending page dialog or file chooser, or running work, defers tidying.
    busy: (sessionId, guest) => {
      const record = state.peek(guest);
      return Boolean(record?.pendingDialog || record?.pendingFileChooser || host.isPageBusy?.(sessionId));
    },
  });

  const sessionRestore = createBrowserSessionRestore({
    sessions,
    urlPolicy,
    ensurePrimaryPage: (sessionId) => primaryPages.ensure(sessionId),
    admitBackgroundPages: (sessionId, adding) => backgroundPages.admit(sessionId, adding),
    restoreBackgroundPage: (sessionId, name, kind) => backgroundPages.restorePage(sessionId, name, kind),
    closeSessionPages: (sessionId) => {
      sessions.clearAgentPage(sessionId);
      // The shell hears of a release on its own (browserSessionReleased); an
      // unloaded session's panel stays for its restore.
      panelFold.quietly(() => {
        primaryPages.release(sessionId);
        backgroundPages.closeSession(sessionId);
      });
      backgroundPages.forgetPopupNames(sessionId);
    },
  });
  const { restoreSession } = sessionRestore;

  /** Visibility requests only affect the display client, never page ownership
   * or OS focus. Creation works even when the owning session is not mounted. */
  async function ensureGuest(
    sessionId: string,
    options: { reveal?: boolean; adopt?: boolean; user?: boolean } = {}
  ): Promise<WebContents> {
    await restoreSession(sessionId);
    // A page another caller is still creating is registered before its
    // initial document commits; wait for it instead of driving it early.
    await primaryPages.settled(sessionId);
    // `adopt: false` (an agent command with no tab) wants a visible page of
    // its own; a pane shows whichever page the session already has.
    // A pane's frame read never makes a page while the panel folds for a lost
    // last page; the person's own request (`user`) does.
    const guest =
      options.adopt === false
        ? (sessions.liveGuest(sessionId) ?? (await primaryPages.ensure(sessionId)))
        : await panelFold.panePage(sessionId, () => primaryPages.ensure(sessionId), { user: options.user });
    if (options.reveal !== false) requestBrowserSurface(sessionId, true);
    return guest;
  }

  /** Close a page a failed command created before it held any document, so
   *  a refused address (or an open with nothing to show) leaves no blank tab. */
  function discardCreatedPage(sessionId: string, guest: WebContents): boolean {
    if (guest.isDestroyed()) return false;
    const url = guest.getURL();
    if (url && url !== 'about:blank') return false;
    for (const [name, entry] of sessions.backgroundPages(sessionId)) {
      if (entry.guest !== guest) continue;
      backgroundPages.close(sessionId, name, entry);
      return true;
    }
    if (!sessions.visibleGuests(sessionId).includes(guest)) return false;
    primaryPages.release(sessionId);
    return true;
  }

  /** Recover a crashed page on the next command instead of failing it. The
   *  reloaded document carries none of the dead page's refs, so callers get a
   *  live surface and a fresh snapshot rather than an unusable one. */
  async function recoverCrashedGuest(guest: WebContents, signal?: AbortSignal): Promise<void> {
    if (!state.takeCrashed(guest)) return;
    if (guest.isDestroyed()) throw new Error('browser page is unavailable');
    state.invalidateInteraction(guest);
    try {
      guest.reload();
      await waitForLoadSettle(guest, NAVIGATE_SETTLE_TIMEOUT_MS, signal);
      state.for(guest).fault = '';
    } catch (error) {
      state.for(guest).fault = `page recovery failed: ${(error as Error).message}`;
    }
  }

  return {
    initializeGuest: guests.initializeGuest,
    attachDebuggerEagerly: guests.attachDebuggerEagerly,
    backgroundEntryByPageId: backgroundPages.entryByPageId,
    destroyBackgroundPage: backgroundPages.close,
    destroyAllBackgroundPages: () => panelFold.quietly(() => backgroundPages.closeAll()),
    releaseSession: sessionRestore.releaseSession,
    restoreSession,
    reclaimIdleBackgroundPages: backgroundPages.sweep,
    ensureOffscreen: backgroundPages.ensureOffscreen,
    requestBrowserSurface,
    revealPage: surface.revealPage,
    reportOpenFailure: surface.reportOpenFailure,
    discardCreatedPage,
    ensureGuest,
    panelShown: panelFold.panelShown,
    replacementPage: (sessionId: string) => primaryPages.replacement(sessionId),
    claimPage: (sessionId: string, guest: WebContents) => primaryPages.claim(sessionId, guest),
    discardUntouchedBlank: (sessionId: string, keep: WebContents) =>
      primaryPages.discardUntouchedBlank(sessionId, keep),
    recoverCrashedGuest,
    destroyAllPrimaryPages: () => {
      sessionRestore.forgetAll();
      panelFold.quietly(() => primaryPages.dispose());
    },
  };
}
