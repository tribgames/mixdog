/**
 * Every page runs outside the shell's focus tree on the shared partition.
 * Primary pages outlive panel visibility; named support pages retain their
 * bounded, session-scoped lifetimes.
 */
import type { BaseWindow, BrowserWindow, WebContents } from 'electron';
import { app } from 'electron';

import { DESKTOP_IPC, type DesktopBrowserOpenRequest } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import { BROWSER_PARTITION, NAVIGATE_SETTLE_TIMEOUT_MS, OFFSCREEN_VIEWPORT } from './command';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import { type BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID } from './session-registry';
import { createBrowserPageOwner } from './page-owner';
import { watchPageFaults } from './page-faults';
import { injectPageScrollbarCss } from './page-scrollbar-css';
import { injectJsonViewerTweaks } from './page-json-viewer';
import { adoptBrowserPageWindow, browserPageWindow, createBrowserPageWindow } from './page-window';
import { setBrowserPageZoom } from './page-zoom';
import { builtPreloadPath } from './preload-path';
import { type PopupOpeningHost, handleWindowOpens } from './popup-opening';
import { createBackgroundReclaimer } from './background-reclaim';
import { pageHasEditedFields } from './login-takeover';
import { normalizeBackgroundTabName } from './tab-policy';
import type { BackgroundPage } from './tabs-contract';
import { type BrowserOpenDetail, browserOpenRequest, revealBrowserPage } from './page-reveal';
import { restorablePages } from './restore-pages';
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';

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

/** How long an `open` waits for a panel to show its page before it reports
 *  the reveal as pending: a first open loads the pane and attaches the page. */
const REVEAL_SETTLE_MS = 3_000;

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
  let offscreen: boolean | { useSharedTexture: true } = true;
  if (nativeView) offscreen = false;
  else if (browserSharedTextureRendering()) offscreen = { useSharedTexture: true };
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

// Only small navigation descriptors survive runtime eviction, never
// WebContents, screenshots, DOM state, or a second browser idle timer.
type SavedPage = {
  name?: string;
  kind: 'primary' | BackgroundPage['kind'];
  url: string;
  active: boolean;
  keepAlive?: boolean;
  zoom: number;
  size: [number, number];
};

/** One live page as the descriptor a later restore replays: where it was, how
 *  it was sized and zoomed, and whether it was the selected page. */
function savedPageDescriptor(
  guest: WebContents,
  selected: WebContents | null,
  kind: SavedPage['kind'],
  name?: string,
  keepAlive?: boolean
): SavedPage {
  return {
    name,
    kind,
    keepAlive,
    url: guest.getURL() || 'about:blank',
    active: guest === selected,
    zoom: guest.getZoomFactor(),
    size: (browserPageWindow(guest)?.getContentSize() ?? [OFFSCREEN_VIEWPORT.width, OFFSCREEN_VIEWPORT.height]) as [
      number,
      number,
    ],
  };
}

/** Navigation admission for one page: whatever the URL policy rejects is
 *  prevented and recorded where the page's own failures are reported. */
function blockUnsafeNavigation(
  state: BrowserGuestStateStore,
  urlPolicy: BrowserUrlPolicy,
  guest: WebContents
): (event: Electron.Event, url: string) => void {
  return (event, url) => {
    if (url === 'about:blank') return;
    try {
      normalizePageUrl(url, urlPolicy);
    } catch (error) {
      event.preventDefault();
      pushBounded(state.for(guest).networkFailures, `Blocked page navigation: ${(error as Error).message}`);
    }
  };
}

/** Popup windows stay hidden and non-focusable, but use their native view:
 *  inherited offscreen popup views can remain at zero size. */
function popupWindowOptions(nativeView = false): Electron.BrowserWindowConstructorOptions {
  const options = offscreenWindowOptions(nativeView);
  return { ...options, webPreferences: { ...options.webPreferences, offscreen: false } };
}

/** Background pages are addressed by page id; only a live window can answer. */
function backgroundEntryForPageId(
  sessions: BrowserSessionRegistry,
  state: BrowserGuestStateStore,
  sessionId: string,
  pageId: string
): [string, BackgroundPage] | null {
  for (const entry of sessions.backgroundPages(sessionId)) {
    if (!entry[1].window.isDestroyed() && state.pageId(entry[1].guest).toLowerCase() === pageId.toLowerCase()) {
      return entry;
    }
  }
  return null;
}

/** Destroy one background page's window and forget its registry entry. */
function closeBackgroundPage(
  sessions: BrowserSessionRegistry,
  sessionId: string,
  name: string,
  entry: BackgroundPage
): void {
  if (!entry.window.isDestroyed()) {
    try {
      entry.window.destroy();
    } catch {
      /* teardown already won */
    }
  }
  sessions.deleteBackgroundPage(sessionId, name, entry);
}

function closeAllBackgroundPages(sessions: BrowserSessionRegistry): void {
  for (const [sessionId, name, page] of sessions.allBackgroundEntries()) {
    closeBackgroundPage(sessions, sessionId, name, page);
  }
  sessions.clearBackgroundPages();
}

/** The session's next popup name, never colliding with a page it still holds. */
function nextPopupTabName(sessions: BrowserSessionRegistry, counters: Map<string, number>, sessionId: string): string {
  let nextPopupId = counters.get(sessionId) ?? 0;
  let name = '';
  do {
    name = `popup-${++nextPopupId}`;
  } while (sessions.backgroundPages(sessionId).has(name));
  counters.set(sessionId, nextPopupId);
  return name;
}

export function createBrowserGuestLifecycle(host: BrowserGuestLifecycleHost) {
  const { window, state, sessions, cdp, urlPolicy, isBackgroundBusy, waitForLoadSettle } = host;
  const createPage = () => createBrowserPageWindow(offscreenWindowOptions(host.nativeView === true), host.nativeView);
  const nextPopupIdsBySession = new Map<string, number>();
  const suspendedSessions = new Map<string, SavedPage[]>();
  const restoringSessions = new Map<string, Promise<void>>();
  const reclaimer = createBackgroundReclaimer({
    sessions,
    isBackgroundBusy,
    holdsUnfinishedWork: (guest) => {
      const record = state.peek(guest);
      return Boolean(
        record && (record.userInput || record.pendingDialog || record.pendingFileChooser || record.sensitiveValues?.size)
      );
    },
    documentGeneration: (guest) => state.peek(guest)?.documentGeneration ?? 0,
    hasEditedFields: pageHasEditedFields,
    close: (sessionId, name, entry) => closeBackgroundPage(sessions, sessionId, name, entry),
  });
  const popupOpening: PopupOpeningHost = {
    state,
    urlPolicy,
    admit: (opener) => reclaimer.admit(sessions.sessionIdForGuest(opener) ?? DEFAULT_BROWSER_SESSION_ID),
    nativeView: () => Boolean(host.nativeView),
    popupWindowOptions,
    createPage: createBrowserPageWindow,
    adoptWindow: adoptBrowserPageWindow,
    adoptPopup: (opener, popup, select) => adoptPopup(opener, popup, select),
  };

  /** `attach`: when the page's debugger comes up — at once (`now`), at once for a
   *  page window.open is navigating (`opened`), or after a restored page's
   *  first document (`restored`). */
  function initializeGuest(guest: WebContents, attach: 'now' | 'opened' | 'restored' = 'now'): void {
    state.for(guest);
    host.onGuest?.(guest);
    injectPageScrollbarCss(guest);
    injectJsonViewerTweaks(guest);
    const blockNavigation = blockUnsafeNavigation(state, urlPolicy, guest);
    guest.on('will-navigate', blockNavigation);
    guest.on('will-redirect', blockNavigation);
    guest.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame) state.beginDocument(guest, isInPlace);
    });
    // Emitted only once a main-frame navigation commits a new document.
    guest.on('did-navigate', () => state.commitDocument(guest));
    handleWindowOpens(guest, popupOpening);
    watchPageFaults(state, guest);
    // Every page gets its debugger up front, agent bridge or not: a page
    // dialog only reaches the pane through it. A popup is attached at once
    // too, without the blank first load (its navigation is window.open's):
    // a dialog its first document opens while parsing would otherwise slip
    // past the bridge.
    if (attach === 'restored') {
      // A restored page commits its own blank document first; attaching
      // earlier would load about:blank over the URL being restored.
      guest.once('dom-ready', () => {
        if (!guest.isDestroyed()) attachDebuggerEagerly(guest);
      });
    } else attachDebuggerEagerly(guest, attach === 'opened');
  }

  /** Track a popup as its opener session's page, unless capacity is gone.
   *  `select`: a person's gesture opened it in front (popup-focus), so it
   *  becomes the selected tab as their own pick would; an agent's stays
   *  behind and is reported to the agent. */
  function adoptPopup(opener: WebContents, popup: { window: BaseWindow; guest: WebContents }, select: boolean): void {
    if (popup.window.isDestroyed()) return;
    const ownerSessionId = sessions.sessionIdForGuest(opener) ?? DEFAULT_BROWSER_SESSION_ID;
    try {
      reclaimer.admit(ownerSessionId);
    } catch (error) {
      pushBounded(state.for(opener).networkFailures, `Blocked popup creation: ${(error as Error).message}`);
      try {
        popup.window.destroy();
      } catch {
        /* creation already failed */
      }
      return;
    }
    const popupName = nextPopupTabName(sessions, nextPopupIdsBySession, ownerSessionId);
    trackBackgroundPage(ownerSessionId, popupName, popup, 'popup', opener);
    // The opener's next reply has to mention it: a click that opened a tab
    // changes nothing in this document and would otherwise be reported as a
    // click the page ignored.
    pushBounded(state.for(opener).openedPopups, popupName);
    host.onPopup?.(opener, popup.guest, select);
    if (select) {
      sessions.selectGuest(ownerSessionId, popup.guest);
      // Like a tab the person picked: panes stop following the agent's page.
      sessions.pauseAgentFollow(ownerSessionId);
    }
  }

  /** Bring CDP up ahead of the first command; a failure is a page diagnostic,
   *  not a host error. */
  function attachDebuggerEagerly(guest: WebContents, openedByPage = false): void {
    void (openedByPage ? cdp.attachOpenedPage(guest) : cdp.guestDebugger(guest)).catch((error) =>
      state.for(guest).console.recordInternal(`CDP initialization failed: ${(error as Error).message}`)
    );
  }

  // A legacy/misconfigured renderer must not reintroduce the shared input tree.
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const primaryPages = createBrowserPageOwner({
    sessions,
    create: createPage,
    initialize: initializeGuest,
    // A pending page dialog or file chooser, or running work, defers tidying.
    busy: (sessionId, guest) => {
      const record = state.peek(guest);
      return Boolean(record?.pendingDialog || record?.pendingFileChooser || host.isPageBusy?.(sessionId));
    },
  });

  /** Unload follows the daemon runtime; deletion also forgets navigation. */
  function releaseSession(sessionId: string, restore = false): void {
    if (restore && !restoringSessions.has(sessionId)) {
      const selected = sessions.currentGuest(sessionId);
      const pages = [
        ...sessions.visibleGuests(sessionId).map((guest) => savedPageDescriptor(guest, selected, 'primary')),
        ...[...sessions.backgroundPages(sessionId)]
          .filter(([, page]) => !page.guest.isDestroyed())
          .map(([name, page]) => savedPageDescriptor(page.guest, selected, page.kind, name, page.keepAlive)),
      ];
      if (pages.length) suspendedSessions.set(sessionId, pages);
    } else if (!restore) {
      suspendedSessions.delete(sessionId);
    }
    restoringSessions.delete(sessionId);
    sessions.clearAgentPage(sessionId);
    primaryPages.release(sessionId);
    for (const [name, entry] of [...sessions.backgroundPages(sessionId)]) {
      closeBackgroundPage(sessions, sessionId, name, entry);
    }
    nextPopupIdsBySession.delete(sessionId);
  }

  function restoreSession(sessionId: string): Promise<void> {
    const existing = restoringSessions.get(sessionId);
    if (existing) return existing;
    const saved = suspendedSessions.get(sessionId);
    if (!saved) return Promise.resolve();
    const assertStillRestoring = () => {
      if (restoringSessions.get(sessionId) !== work || suspendedSessions.get(sessionId) !== saved) {
        throw new Error('Browser page changed during restore.');
      }
    };
    const work = Promise.resolve()
      .then(async () => {
        // Pages with nothing to come back to are dropped, never shown blank.
        const restorable = restorablePages(saved, urlPolicy);
        const urls = new Map(restorable.map(({ page, url }) => [page, url]));
        const backgrounds = restorable.map(({ page }) => page).filter((page) => page.kind !== 'primary');
        if (backgrounds.length) reclaimer.admit(sessionId, backgrounds.length);
        const primaryState = restorable.find(({ page }) => page.kind === 'primary')?.page;
        const primary = primaryState ? await primaryPages.ensure(sessionId) : null;
        assertStillRestoring();
        let selected: WebContents | null = primary;
        const apply = (guest: WebContents, page: SavedPage) => {
          browserPageWindow(guest)?.setContentSize(page.size[0], page.size[1]);
          setBrowserPageZoom(guest, page.zoom);
          if (page.active) selected = guest;
          // Restoration is a normal reload, not form/JS/opener resurrection.
          // Admission still runs through the partition and navigation handlers.
          void guest.loadURL(urls.get(page)!).catch(() => {});
        };
        if (primary && primaryState) apply(primary, primaryState);
        for (const page of backgrounds) {
          const entry = trackBackgroundPage(
            sessionId,
            page.name!,
            createPage(),
            page.kind === 'popup' ? 'user' : (page.kind as BackgroundPage['kind']),
            undefined,
            'restored'
          );
          // Commit a document before CDP may attach; otherwise its blank-page
          // initialization aborts the URL reload we are trying to restore.
          await entry.guest.loadURL('about:blank');
          assertStillRestoring();
          entry.keepAlive = page.keepAlive || page.kind === 'popup';
          selected ??= entry.guest;
          apply(entry.guest, page);
        }
        if (selected) sessions.selectGuest(sessionId, selected);
        suspendedSessions.delete(sessionId);
      })
      .catch((error) => {
        // Preserve descriptors for a retry, but release a partially recreated
        // set. An obsolete restore may never tear down its successor.
        if (restoringSessions.get(sessionId) === work) releaseSession(sessionId, true);
        throw error;
      });
    restoringSessions.set(sessionId, work);
    void work
      .finally(() => {
        if (restoringSessions.get(sessionId) === work) restoringSessions.delete(sessionId);
      })
      .catch(() => {});
    return work;
  }

  function trackBackgroundPage(
    sessionId: string,
    name: string,
    page: { window: BaseWindow; guest: WebContents },
    kind: BackgroundPage['kind'],
    opener?: WebContents,
    attach: 'now' | 'opened' | 'restored' = kind === 'popup' ? 'opened' : 'now'
  ): BackgroundPage {
    const win = page.window;
    const entry: BackgroundPage = {
      window: win,
      guest: page.guest,
      lastUsedAt: Date.now(),
      kind,
      ...(opener ? { openerPageId: state.pageId(opener), opener } : {}),
    };
    sessions.setBackgroundPage(sessionId, name, entry);
    initializeGuest(entry.guest, attach);
    win.once('closed', () => {
      sessions.deleteBackgroundPage(sessionId, name, entry);
    });
    return entry;
  }

  function ensureOffscreen(sessionId: string, rawName = ''): BackgroundPage {
    const name = normalizeBackgroundTabName(rawName);
    const existing = sessions.backgroundPages(sessionId).get(name);
    if (existing && !existing.window.isDestroyed()) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    reclaimer.admit(sessionId);
    // Never shown: the page runs fully (navigate/click/snapshot are JS, not
    // frames). Screenshots go through CDP Page.captureScreenshot, which renders
    // server-side in the Blink compositor and does not need an on-screen
    // surface — an invalidate() before capture forces the frame.
    return trackBackgroundPage(sessionId, name, createPage(), 'agent');
  }

  /** `handoff`: a takeover needs the user on the page, so the panel opens even
   *  where they closed it. `detail`: what an agent's `open` showed, or why it
   *  failed (browserOpenRequest). */
  function requestBrowserSurface(
    sessionId: string,
    reveal: boolean | 'hide' | 'handoff',
    detail?: BrowserOpenDetail
  ): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error('desktop window is unavailable');
    }
    const request: DesktopBrowserOpenRequest = browserOpenRequest(sessionId, reveal, detail);
    window.webContents.send(DESKTOP_IPC.browserOpenRequested, request);
    // An explicit reveal or hide is an agent handoff paired clients must see too.
    host.onSurfaceRequest?.(request);
  }

  /** Visibility requests only affect the display client, never page ownership
   * or OS focus. Creation works even when the owning session is not mounted. */
  async function ensureGuest(
    sessionId: string,
    options: { reveal?: boolean; adopt?: boolean } = {}
  ): Promise<WebContents> {
    await restoreSession(sessionId);
    // A page another caller is still creating is registered before its
    // initial document commits; wait for it instead of driving it early.
    await primaryPages.settled(sessionId);
    // `adopt: false` (an agent command with no tab) wants a visible page of
    // its own; a pane shows whichever page the session already has.
    const existing = options.adopt === false ? sessions.liveGuest(sessionId) : sessions.paneGuest(sessionId);
    const guest = existing ?? (await primaryPages.ensure(sessionId));
    if (options.reveal !== false) requestBrowserSurface(sessionId, true);
    return guest;
  }

  /** `open`: `shown` once a panel on screen displays the page; `pending` when
   *  the session is not on screen (the shell holds the reveal until it is,
   *  see use-agent-browser-surface-requests) or the user keeps its panel
   *  closed. Throws when no panel can be asked or the page closes meanwhile. */
  function revealPage(sessionId: string, guest: WebContents, signal?: AbortSignal): Promise<'shown' | 'pending'> {
    return revealBrowserPage(
      {
        sessionIdForGuest: (page) => sessions.sessionIdForGuest(page),
        selectGuest: (id, page) => sessions.selectGuest(id, page),
        resumeAgentFollow: (id) => sessions.resumeAgentFollow(id),
        requestSurface: (id, detail) => requestBrowserSurface(id, true, detail),
        pageId: (page) => state.pageId(page),
        waitUntilShown: host.waitUntilShown,
      },
      sessionId,
      guest,
      REVEAL_SETTLE_MS,
      signal
    );
  }

  /** A failed `open` tells the shell why (its owner conversation's line);
   *  nothing is revealed for it. With no window to tell, there is no line. */
  function reportOpenFailure(sessionId: string, error: string, tabId?: string): void {
    try {
      requestBrowserSurface(sessionId, true, { error, tabId });
    } catch {
      /* the window is gone: the tool reply still carries the failure */
    }
  }

  /** Close a page a failed command created before it held any document, so
   *  a refused address (or an open with nothing to show) leaves no blank tab. */
  function discardCreatedPage(sessionId: string, guest: WebContents): boolean {
    if (guest.isDestroyed()) return false;
    const url = guest.getURL();
    if (url && url !== 'about:blank') return false;
    for (const [name, entry] of sessions.backgroundPages(sessionId)) {
      if (entry.guest !== guest) continue;
      closeBackgroundPage(sessions, sessionId, name, entry);
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
    initializeGuest,
    attachDebuggerEagerly,
    backgroundEntryByPageId: (sessionId: string, pageId: string) =>
      backgroundEntryForPageId(sessions, state, sessionId, pageId),
    destroyBackgroundPage: (sessionId: string, name: string, entry: BackgroundPage) =>
      closeBackgroundPage(sessions, sessionId, name, entry),
    destroyAllBackgroundPages: () => closeAllBackgroundPages(sessions),
    releaseSession,
    restoreSession,
    reclaimIdleBackgroundPages: (now?: number) => reclaimer.sweep(now),
    ensureOffscreen,
    requestBrowserSurface,
    revealPage,
    reportOpenFailure,
    discardCreatedPage,
    ensureGuest,
    replacementPage: (sessionId: string) => primaryPages.replacement(sessionId),
    claimPage: (sessionId: string, guest: WebContents) => primaryPages.claim(sessionId, guest),
    discardUntouchedBlank: (sessionId: string, keep: WebContents) =>
      primaryPages.discardUntouchedBlank(sessionId, keep),
    recoverCrashedGuest,
    destroyAllPrimaryPages: () => {
      suspendedSessions.clear();
      restoringSessions.clear();
      primaryPages.dispose();
    },
  };
}
