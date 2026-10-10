/**
 * Every page runs outside the shell's focus tree on the shared partition.
 * Primary pages outlive panel visibility; named support pages retain their
 * bounded, session-scoped lifetimes.
 */
import type { BaseWindow, BrowserWindow, WebContents } from 'electron';
import { app } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import { BROWSER_PARTITION, NAVIGATE_SETTLE_TIMEOUT_MS, OFFSCREEN_VIEWPORT } from './command';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import { redactBrowserUrl } from './redaction';
import { type BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID } from './session-registry';
import { createBrowserPageOwner } from './page-owner';
import { injectPageScrollbarCss } from './page-scrollbar-css';
import { adoptBrowserPageWindow, browserPageWindow, createBrowserPageWindow } from './page-window';
import { assertBackgroundTabCapacity, backgroundPageIdle, normalizeBackgroundTabName } from './tab-policy';
import type { BackgroundPage } from './tabs-contract';
import { type BrowserUrlPolicy, normalizePageUrl, normalizeRestoredPageUrl } from './url-policy';

/** Prefix of a fault set by a failed main-frame load; a new load clears it. */
const LOAD_FAULT = 'page failed to load: ';

interface BrowserGuestLifecycleHost {
  window: BrowserWindow;
  partitionSession: Electron.Session;
  state: BrowserGuestStateStore;
  sessions: BrowserSessionRegistry;
  cdp: Pick<BrowserGuestCdp, 'guestDebugger'>;
  urlPolicy: BrowserUrlPolicy;
  /** Whether the agent bridge is on, so new guests get a debugger eagerly. */
  bridgeWanted(): boolean;
  /** A background page mid-command must not be reclaimed as idle. */
  isBackgroundBusy(sessionId: string, name: string): boolean;
  onPopup?(opener: WebContents, popup: WebContents): void;
  onGuest?(guest: WebContents): void;
  /** The display client was asked to reveal or hide the session's surface. */
  onSurfaceRequest?(request: { sessionId: string; reveal?: boolean; hide?: boolean }): void;
  waitForLoadSettle(guest: WebContents, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
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
function offscreenWindowOptions(nativeView = false): Electron.BrowserWindowConstructorOptions {
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

/** Agent pages nobody selected, kept alive or is driving expire on their own;
 *  user and popup pages never do. */
function reclaimIdleBackgroundPages(
  sessions: BrowserSessionRegistry,
  isBackgroundBusy: BrowserGuestLifecycleHost['isBackgroundBusy'],
  now = Date.now()
): void {
  for (const [sessionId, name, entry] of sessions.allBackgroundEntries()) {
    if (entry.window.isDestroyed()) {
      sessions.deleteBackgroundPage(sessionId, name, entry);
      continue;
    }
    if (
      entry.kind === 'agent' &&
      !entry.keepAlive &&
      sessions.currentGuest(sessionId) !== entry.guest &&
      backgroundPageIdle(entry.lastUsedAt, now) &&
      !isBackgroundBusy(sessionId, name)
    ) {
      closeBackgroundPage(sessions, sessionId, name, entry);
    }
  }
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
  const { window, state, sessions, cdp, urlPolicy, bridgeWanted, isBackgroundBusy, waitForLoadSettle } = host;
  const createPage = () => createBrowserPageWindow(offscreenWindowOptions(host.nativeView === true), host.nativeView);
  const nextPopupIdsBySession = new Map<string, number>();
  const suspendedSessions = new Map<string, SavedPage[]>();
  const restoringSessions = new Map<string, Promise<void>>();

  function initializeGuest(guest: WebContents, deferDebugger = false): void {
    state.for(guest);
    host.onGuest?.(guest);
    injectPageScrollbarCss(guest);
    const blockNavigation = blockUnsafeNavigation(state, urlPolicy, guest);
    guest.on('will-navigate', blockNavigation);
    guest.on('will-redirect', blockNavigation);
    guest.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame) state.beginDocument(guest, isInPlace);
    });
    guest.setWindowOpenHandler(({ url }) => {
      try {
        if (url !== 'about:blank') normalizePageUrl(url, urlPolicy);
        reclaimIdleBackgroundPages(sessions, isBackgroundBusy);
        assertBackgroundTabCapacity(sessions.backgroundCount());
        if (host.nativeView) {
          // A native page's popup is a hosted page of its own, so the pane can
          // present it like any tab. Electron then emits no did-create-window.
          return {
            action: 'allow',
            outlivesOpener: true,
            createWindow: (options) => {
              const popup = createBrowserPageWindow(
                popupWindowOptions(true),
                true,
                (options as { webContents?: WebContents }).webContents
              );
              setImmediate(() => adoptPopup(guest, popup));
              return popup.guest;
            },
          };
        }
        return {
          action: 'allow',
          outlivesOpener: true,
          overrideBrowserWindowOptions: popupWindowOptions(),
        };
      } catch (error) {
        pushBounded(state.for(guest).networkFailures, `Blocked popup navigation: ${(error as Error).message}`);
        return { action: 'deny' };
      }
    });
    guest.on('did-create-window', (child) =>
      adoptPopup(guest, { window: adoptBrowserPageWindow(child), guest: child.webContents })
    );
    guest.on('render-process-gone', (_event, details) => {
      state.markCrashed(guest, `renderer ${details.reason}${details.exitCode ? ` (exit ${details.exitCode})` : ''}`);
    });
    guest.on('unresponsive', () => {
      state.for(guest).fault = 'page became unresponsive';
    });
    guest.on('responsive', () => {
      state.for(guest).fault = '';
    });
    guest.on('did-finish-load', () => {
      const record = state.for(guest);
      // The error document of a failed load also finishes loading; only the
      // next navigation clears that failure.
      if (!record.fault.startsWith(LOAD_FAULT)) record.fault = '';
      record.network.finishDocument(guest.getURL());
    });
    // A page that never arrived (refused, unreachable, bad certificate) is a
    // fault the pane shows; without it the pane sits on an empty document.
    // A superseded navigation (-3) is not a failure.
    // The address keeps two failures in a row distinct for the pane.
    guest.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      state.for(guest).fault = `${LOAD_FAULT}${description || 'unknown error'} (${code}) ${redactBrowserUrl(url)}`;
    });
    guest.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      const record = state.for(guest);
      if (record.fault.startsWith(LOAD_FAULT)) record.fault = '';
    });
    if (deferDebugger) {
      // A popup already has a navigation owned by window.open. Attaching
      // before its first document can load about:blank over that navigation.
      guest.once('dom-ready', () => {
        if (bridgeWanted() && !guest.isDestroyed()) attachDebuggerEagerly(guest);
      });
    } else if (bridgeWanted()) attachDebuggerEagerly(guest);
  }

  /** Track a popup as its opener session's page, unless capacity is gone. */
  function adoptPopup(opener: WebContents, popup: { window: BaseWindow; guest: WebContents }): void {
    if (popup.window.isDestroyed()) return;
    reclaimIdleBackgroundPages(sessions, isBackgroundBusy);
    try {
      assertBackgroundTabCapacity(sessions.backgroundCount());
    } catch (error) {
      pushBounded(state.for(opener).networkFailures, `Blocked popup creation: ${(error as Error).message}`);
      try {
        popup.window.destroy();
      } catch {
        /* creation already failed */
      }
      return;
    }
    const ownerSessionId = sessions.sessionIdForGuest(opener) ?? DEFAULT_BROWSER_SESSION_ID;
    const popupName = nextPopupTabName(sessions, nextPopupIdsBySession, ownerSessionId);
    trackBackgroundPage(ownerSessionId, popupName, popup, 'popup', state.pageId(opener));
    // The opener's next reply has to mention it: a click that opened a tab
    // changes nothing in this document and would otherwise be reported as a
    // click the page ignored.
    pushBounded(state.for(opener).openedPopups, popupName);
    host.onPopup?.(opener, popup.guest);
  }

  /** Bring CDP up ahead of the first command; a failure is a page diagnostic,
   *  not a host error. */
  function attachDebuggerEagerly(guest: WebContents): void {
    void cdp
      .guestDebugger(guest)
      .catch((error) =>
        state.for(guest).console.recordInternal(`CDP initialization failed: ${(error as Error).message}`)
      );
  }

  // A legacy/misconfigured renderer must not reintroduce the shared input tree.
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const primaryPages = createBrowserPageOwner({
    sessions,
    create: createPage,
    initialize: initializeGuest,
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
    const work = Promise.resolve()
      .then(async () => {
        const urls = new Map(saved.map((page) => [page, normalizeRestoredPageUrl(page.url, urlPolicy)]));
        const backgrounds = saved.filter((page) => page.kind !== 'primary');
        if (backgrounds.length) {
          assertBackgroundTabCapacity(sessions.backgroundCount() + backgrounds.length - 1);
        }
        const primary = await primaryPages.ensure(sessionId);
        if (restoringSessions.get(sessionId) !== work || suspendedSessions.get(sessionId) !== saved) {
          throw new Error('Browser page changed during restore.');
        }
        let selected = primary;
        const apply = (guest: WebContents, page: SavedPage) => {
          browserPageWindow(guest)?.setContentSize(page.size[0], page.size[1]);
          guest.setZoomFactor(page.zoom);
          if (page.active) selected = guest;
          // Restoration is a normal reload, not form/JS/opener resurrection.
          // Admission still runs through the partition and navigation handlers.
          void guest.loadURL(urls.get(page)!).catch(() => {});
        };
        const primaryState = saved.find((page) => page.kind === 'primary');
        if (primaryState) apply(primary, primaryState);
        for (const page of backgrounds) {
          const entry = trackBackgroundPage(
            sessionId,
            page.name!,
            createPage(),
            page.kind === 'popup' ? 'user' : (page.kind as BackgroundPage['kind']),
            undefined,
            true
          );
          // Commit a document before CDP may attach; otherwise its blank-page
          // initialization aborts the URL reload we are trying to restore.
          await entry.guest.loadURL('about:blank');
          if (restoringSessions.get(sessionId) !== work || suspendedSessions.get(sessionId) !== saved) {
            throw new Error('Browser page changed during restore.');
          }
          entry.keepAlive = page.keepAlive || page.kind === 'popup';
          apply(entry.guest, page);
        }
        sessions.selectGuest(sessionId, selected);
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
    openerPageId?: string,
    deferDebugger = kind === 'popup'
  ): BackgroundPage {
    const win = page.window;
    const entry: BackgroundPage = {
      window: win,
      guest: page.guest,
      lastUsedAt: Date.now(),
      kind,
      openerPageId,
    };
    sessions.setBackgroundPage(sessionId, name, entry);
    initializeGuest(entry.guest, deferDebugger);
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
    reclaimIdleBackgroundPages(sessions, isBackgroundBusy);
    assertBackgroundTabCapacity(sessions.backgroundCount());
    // Never shown: the page runs fully (navigate/click/snapshot are JS, not
    // frames). Screenshots go through CDP Page.captureScreenshot, which renders
    // server-side in the Blink compositor and does not need an on-screen
    // surface — an invalidate() before capture forces the frame.
    return trackBackgroundPage(sessionId, name, createPage(), 'agent');
  }

  function requestBrowserSurface(sessionId: string, reveal: boolean | 'hide'): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error('desktop window is unavailable');
    }
    const request = { sessionId, ...(reveal === 'hide' ? { hide: true } : { reveal }) };
    window.webContents.send(DESKTOP_IPC.browserOpenRequested, request);
    // An explicit reveal or hide is an agent handoff paired clients must see too.
    host.onSurfaceRequest?.(request);
  }

  /** Visibility requests only affect the display client, never page ownership
   * or OS focus. Creation works even when the owning session is not mounted. */
  async function ensureGuest(sessionId: string, options: { reveal?: boolean } = {}): Promise<WebContents> {
    await restoreSession(sessionId);
    const guest = sessions.liveGuest(sessionId) ?? (await primaryPages.ensure(sessionId));
    if (options.reveal !== false) requestBrowserSurface(sessionId, true);
    return guest;
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
    reclaimIdleBackgroundPages: (now?: number) => reclaimIdleBackgroundPages(sessions, isBackgroundBusy, now),
    ensureOffscreen,
    requestBrowserSurface,
    ensureGuest,
    recoverCrashedGuest,
    destroyAllPrimaryPages: () => {
      suspendedSessions.clear();
      restoringSessions.clear();
      primaryPages.dispose();
    },
  };
}
