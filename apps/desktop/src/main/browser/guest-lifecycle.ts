/**
 * Every page runs outside the shell's focus tree on the shared partition.
 * Primary pages outlive panel visibility; named support pages retain their
 * bounded, session-scoped lifetimes.
 */
import type { WebContents } from 'electron';
import { BrowserWindow } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import {
  BROWSER_PARTITION,
  NAVIGATE_SETTLE_TIMEOUT_MS,
  OFFSCREEN_VIEWPORT,
} from './command';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import {
  type BrowserSessionRegistry,
  DEFAULT_BROWSER_SESSION_ID,
} from './session-registry';
import { createBrowserPageOwner } from './page-owner';
import {
  assertBackgroundTabCapacity,
  backgroundPageIdle,
  normalizeBackgroundTabName,
} from './tab-policy';
import type { BackgroundPage } from './tabs';
import { type BrowserUrlPolicy, normalizePageUrl, normalizeRestoredPageUrl } from './url-policy';

export interface BrowserGuestLifecycleHost {
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
  waitForLoadSettle(guest: WebContents, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
}

export function createBrowserGuestLifecycle(host: BrowserGuestLifecycleHost) {
  const {
    window,
    state,
    sessions,
    cdp,
    urlPolicy,
    bridgeWanted,
    isBackgroundBusy,
    waitForLoadSettle,
  } = host;
  const nextPopupIdsBySession = new Map<string, number>();
  type SavedPage = {
    name?: string;
    kind: 'primary' | BackgroundPage['kind'];
    url: string;
    active: boolean;
    keepAlive?: boolean;
    zoom: number;
    size: [number, number];
  };
  // Only small navigation descriptors survive runtime eviction, never
  // WebContents, screenshots, DOM state, or a second browser idle timer.
  const suspendedSessions = new Map<string, SavedPage[]>();
  const restoringSessions = new Map<string, Promise<void>>();

  const offscreenWindowOptions = (): Electron.BrowserWindowConstructorOptions => ({
    show: false,
    focusable: false,
    width: OFFSCREEN_VIEWPORT.width,
    height: OFFSCREEN_VIEWPORT.height,
    webPreferences: {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // These page owners are never shown. Offscreen rendering gives Chromium
      // a live compositor without activating a native window.
      offscreen: true,
      // Keep rendering/timers running while the window is hidden.
      backgroundThrottling: false,
    },
  });

  function initializeGuest(guest: WebContents, deferDebugger = false): void {
    state.for(guest);
    const blockUnsafeNavigation = (event: Electron.Event, url: string) => {
      if (url === 'about:blank') return;
      try {
        normalizePageUrl(url, urlPolicy);
      } catch (error) {
        event.preventDefault();
        pushBounded(
          state.for(guest).networkFailures,
          `Blocked page navigation: ${(error as Error).message}`,
        );
      }
    };
    guest.on('will-navigate', blockUnsafeNavigation);
    guest.on('will-redirect', blockUnsafeNavigation);
    guest.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) state.beginDocument(guest);
    });
    guest.setWindowOpenHandler(({ url }) => {
      try {
        if (url !== 'about:blank') normalizePageUrl(url, urlPolicy);
        reclaimIdleBackgroundPages();
        assertBackgroundTabCapacity(sessions.backgroundCount());
        const options = offscreenWindowOptions();
        return {
          action: 'allow',
          outlivesOpener: true,
          // Keep popup windows hidden and non-focusable, but use their native
          // view: inherited offscreen popup views can remain at zero size.
          overrideBrowserWindowOptions: {
            ...options,
            webPreferences: { ...options.webPreferences, offscreen: false },
          },
        };
      } catch (error) {
        pushBounded(
          state.for(guest).networkFailures,
          `Blocked popup navigation: ${(error as Error).message}`,
        );
        return { action: 'deny' };
      }
    });
    guest.on('did-create-window', (child) => {
      reclaimIdleBackgroundPages();
      try {
        assertBackgroundTabCapacity(sessions.backgroundCount());
      } catch (error) {
        pushBounded(
          state.for(guest).networkFailures,
          `Blocked popup creation: ${(error as Error).message}`,
        );
        try { child.destroy(); } catch { /* creation already failed */ }
        return;
      }
      const ownerSessionId = sessions.sessionIdForGuest(guest) ?? DEFAULT_BROWSER_SESSION_ID;
      trackBackgroundPage(
        ownerSessionId,
        nextPopupTabName(ownerSessionId),
        child,
        'popup',
        state.pageId(guest),
      );
    });
    guest.on('render-process-gone', (_event, details) => {
      state.markCrashed(
        guest,
        `renderer ${details.reason}${details.exitCode ? ` (exit ${details.exitCode})` : ''}`,
      );
    });
    guest.on('unresponsive', () => {
      state.for(guest).fault = 'page became unresponsive';
    });
    guest.on('responsive', () => {
      state.for(guest).fault = '';
    });
    guest.on('did-finish-load', () => {
      const record = state.for(guest);
      record.fault = '';
      record.network.finishDocument(guest.getURL());
    });
    if (deferDebugger) {
      // A popup already has a navigation owned by window.open. Attaching
      // before its first document can load about:blank over that navigation.
      guest.once('dom-ready', () => {
        if (bridgeWanted() && !guest.isDestroyed()) attachDebuggerEagerly(guest);
      });
    } else if (bridgeWanted()) attachDebuggerEagerly(guest);
  }

  /** Bring CDP up ahead of the first command; a failure is a page diagnostic,
   *  not a host error. */
  function attachDebuggerEagerly(guest: WebContents): void {
    void cdp.guestDebugger(guest).catch((error) => state.for(guest).console.recordError(
      `CDP initialization failed: ${(error as Error).message}`,
    ));
  }

  // A legacy/misconfigured renderer must not reintroduce the shared input tree.
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  const primaryPages = createBrowserPageOwner({
    sessions,
    windowOptions: offscreenWindowOptions,
    initialize: initializeGuest,
  });

  function backgroundEntryByPageId(
    sessionId: string,
    pageId: string,
  ): [string, BackgroundPage] | null {
    for (const entry of sessions.backgroundPages(sessionId)) {
      if (!entry[1].window.isDestroyed()
        && state.pageId(entry[1].window.webContents).toLowerCase() === pageId.toLowerCase()) {
        return entry;
      }
    }
    return null;
  }

  function destroyBackgroundPage(
    sessionId: string,
    name: string,
    entry: BackgroundPage,
  ): void {
    if (!entry.window.isDestroyed()) {
      try { entry.window.destroy(); } catch { /* teardown already won */ }
    }
    sessions.deleteBackgroundPage(sessionId, name, entry);
  }

  /** Unload follows the daemon runtime; deletion also forgets navigation. */
  function releaseSession(sessionId: string, restore = false): void {
    if (restore && !restoringSessions.has(sessionId)) {
      const selected = sessions.currentGuest(sessionId);
      const save = (guest: WebContents, kind: SavedPage['kind'], name?: string, keepAlive?: boolean): SavedPage => ({
        name, kind, keepAlive, url: guest.getURL() || 'about:blank',
        active: guest === selected, zoom: guest.getZoomFactor(),
        size: (BrowserWindow.fromWebContents(guest)?.getContentSize()
          ?? [OFFSCREEN_VIEWPORT.width, OFFSCREEN_VIEWPORT.height]) as [number, number],
      });
      const pages = [
        ...sessions.visibleGuests(sessionId).map(guest => save(guest, 'primary')),
        ...[...sessions.backgroundPages(sessionId)].filter(([, page]) => !page.guest.isDestroyed())
          .map(([name, page]) => save(page.guest, page.kind, name, page.keepAlive)),
      ];
      if (pages.length) suspendedSessions.set(sessionId, pages);
    } else if (!restore) {
      suspendedSessions.delete(sessionId);
    }
    restoringSessions.delete(sessionId);
    primaryPages.release(sessionId);
    for (const [name, entry] of [...sessions.backgroundPages(sessionId)]) {
      destroyBackgroundPage(sessionId, name, entry);
    }
    nextPopupIdsBySession.delete(sessionId);
  }

  function restoreSession(sessionId: string): Promise<void> {
    const existing = restoringSessions.get(sessionId);
    if (existing) return existing;
    const saved = suspendedSessions.get(sessionId);
    if (!saved) return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      const urls = new Map(saved.map(page => [page, normalizeRestoredPageUrl(page.url, urlPolicy)]));
      const backgrounds = saved.filter(page => page.kind !== 'primary');
      if (backgrounds.length) {
        assertBackgroundTabCapacity(sessions.backgroundCount() + backgrounds.length - 1);
      }
      const primary = await primaryPages.ensure(sessionId);
      if (restoringSessions.get(sessionId) !== work || suspendedSessions.get(sessionId) !== saved) {
        throw new Error('Browser page changed during restore.');
      }
      let selected = primary;
      const apply = (guest: WebContents, page: SavedPage) => {
        BrowserWindow.fromWebContents(guest)?.setContentSize(page.size[0], page.size[1]);
        guest.setZoomFactor(page.zoom);
        if (page.active) selected = guest;
        // Restoration is a normal reload, not form/JS/opener resurrection.
        // Admission still runs through the partition and navigation handlers.
        void guest.loadURL(urls.get(page)!).catch(() => {});
      };
      const primaryState = saved.find(page => page.kind === 'primary');
      if (primaryState) apply(primary, primaryState);
      for (const page of backgrounds) {
        const win = new BrowserWindow(offscreenWindowOptions());
        const entry = trackBackgroundPage(sessionId, page.name!, win,
          page.kind === 'popup' ? 'user' : page.kind as BackgroundPage['kind'], undefined, true);
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
    }).catch(error => {
      // Preserve descriptors for a retry, but release a partially recreated
      // set. An obsolete restore may never tear down its successor.
      if (restoringSessions.get(sessionId) === work) releaseSession(sessionId, true);
      throw error;
    });
    restoringSessions.set(sessionId, work);
    void work.finally(() => {
      if (restoringSessions.get(sessionId) === work) restoringSessions.delete(sessionId);
    }).catch(() => {});
    return work;
  }

  function destroyAllBackgroundPages(): void {
    for (const [sessionId, name, page] of sessions.allBackgroundEntries()) {
      destroyBackgroundPage(sessionId, name, page);
    }
    sessions.clearBackgroundPages();
  }

  function reclaimIdleBackgroundPages(now = Date.now()): void {
    for (const [sessionId, name, entry] of sessions.allBackgroundEntries()) {
      if (entry.window.isDestroyed()) {
        sessions.deleteBackgroundPage(sessionId, name, entry);
        continue;
      }
      if (entry.kind === 'agent' && !entry.keepAlive
        && sessions.currentGuest(sessionId) !== entry.guest
        && backgroundPageIdle(entry.lastUsedAt, now) && !isBackgroundBusy(sessionId, name)) {
        destroyBackgroundPage(sessionId, name, entry);
      }
    }
  }

  function nextPopupTabName(sessionId: string): string {
    let nextPopupId = nextPopupIdsBySession.get(sessionId) ?? 0;
    let name = '';
    do {
      name = `popup-${++nextPopupId}`;
    } while (sessions.backgroundPages(sessionId).has(name));
    nextPopupIdsBySession.set(sessionId, nextPopupId);
    return name;
  }

  function trackBackgroundPage(
    sessionId: string,
    name: string,
    win: BrowserWindow,
    kind: BackgroundPage['kind'],
    openerPageId?: string,
    deferDebugger = kind === 'popup',
  ): BackgroundPage {
    const entry: BackgroundPage = {
      window: win,
      guest: win.webContents,
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
    reclaimIdleBackgroundPages();
    assertBackgroundTabCapacity(sessions.backgroundCount());
    // Never shown: the page runs fully (navigate/click/snapshot are JS, not
    // frames). Screenshots go through CDP Page.captureScreenshot, which renders
    // server-side in the Blink compositor and does not need an on-screen
    // surface — an invalidate() before capture forces the frame.
    const win = new BrowserWindow(offscreenWindowOptions());
    return trackBackgroundPage(sessionId, name, win, 'agent');
  }

  function requestBrowserSurface(sessionId: string, reveal: boolean | 'hide'): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error('desktop window is unavailable');
    }
    window.webContents.send(DESKTOP_IPC.browserOpenRequested, {
      sessionId,
      ...(reveal === 'hide' ? { hide: true } : { reveal }),
    });
  }

  /** Visibility requests only affect the display client, never page ownership
   * or OS focus. Creation works even when the owning session is not mounted. */
  async function ensureGuest(
    sessionId: string,
    options: { reveal?: boolean } = {},
  ): Promise<WebContents> {
    await restoreSession(sessionId);
    const guest = sessions.liveGuest(sessionId) ?? await primaryPages.ensure(sessionId);
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
    backgroundEntryByPageId,
    destroyBackgroundPage,
    destroyAllBackgroundPages,
    releaseSession,
    restoreSession,
    reclaimIdleBackgroundPages,
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
