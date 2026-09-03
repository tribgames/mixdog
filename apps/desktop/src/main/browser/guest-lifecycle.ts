/**
 * Where guest pages come from and when they go away. Visible tabs are
 * <webview>s the renderer's BrowserPane mounts on the shared partition; this
 * module vets and registers each one. Background pages are never-shown
 * BrowserWindows on the SAME partition, so offscreen work stays logged in,
 * with names and lifetimes scoped to the owning conversation session.
 */
import type { WebContents } from 'electron';
import { BrowserWindow } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract';
import type { BrowserGuestCdp } from './cdp';
import {
  BROWSER_PARTITION,
  NAVIGATE_SETTLE_TIMEOUT_MS,
  OFFSCREEN_VIEWPORT,
  OPEN_SURFACE_TIMEOUT_MS,
} from './command';
import { type BrowserGuestStateStore, pushBounded } from './guest-state';
import {
  type BrowserSessionRegistry,
  DEFAULT_BROWSER_SESSION_ID,
} from './session-registry';
import { pause } from './settle';
import {
  assertBackgroundTabCapacity,
  backgroundPageIdle,
  normalizeBackgroundTabName,
} from './tab-policy';
import type { BackgroundPage } from './tabs';
import { type BrowserUrlPolicy, normalizePageUrl } from './url-policy';

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
    partitionSession,
    state,
    sessions,
    cdp,
    urlPolicy,
    bridgeWanted,
    isBackgroundBusy,
    waitForLoadSettle,
  } = host;
  const nextPopupIdsBySession = new Map<string, number>();

  const offscreenWindowOptions = (): Electron.BrowserWindowConstructorOptions => ({
    show: false,
    width: OFFSCREEN_VIEWPORT.width,
    height: OFFSCREEN_VIEWPORT.height,
    webPreferences: {
      partition: BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep rendering/timers running while the window is hidden.
      backgroundThrottling: false,
    },
  });

  function initializeGuest(guest: WebContents): void {
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
        return {
          action: 'allow',
          outlivesOpener: true,
          overrideBrowserWindowOptions: offscreenWindowOptions(),
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
    if (bridgeWanted()) attachDebuggerEagerly(guest);
  }

  /** Bring CDP up ahead of the first command; a failure is a page diagnostic,
   *  not a host error. */
  function attachDebuggerEagerly(guest: WebContents): void {
    void cdp.guestDebugger(guest).catch((error) => state.for(guest).console.recordError(
      `CDP initialization failed: ${(error as Error).message}`,
    ));
  }

  // Only the browser pane's own partition may attach a webview, and never
  // with a preload or node access, no matter what the renderer asked for.
  window.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    if (params.partition !== BROWSER_PARTITION) {
      event.preventDefault();
      return;
    }
    delete (webPreferences as { preload?: string }).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  window.webContents.on('did-attach-webview', (_event, guest) => {
    if (guest.session !== partitionSession) return;
    initializeGuest(guest);
    sessions.registerVisibleGuest(guest);
    guest.on('focus', () => {
      const sessionId = sessions.sessionIdForGuest(guest);
      if (sessionId) sessions.selectGuest(sessionId, guest);
    });
    guest.once('destroyed', () => {
      sessions.unregisterVisibleGuest(guest);
    });
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

  /** Drop every agent-owned page a conversation session created. */
  function releaseSession(sessionId: string): void {
    for (const [name, entry] of [...sessions.backgroundPages(sessionId)]) {
      destroyBackgroundPage(sessionId, name, entry);
    }
    nextPopupIdsBySession.delete(sessionId);
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
      if (backgroundPageIdle(entry.lastUsedAt, now) && !isBackgroundBusy(sessionId, name)) {
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
  ): BackgroundPage {
    const entry: BackgroundPage = {
      window: win,
      guest: win.webContents,
      lastUsedAt: Date.now(),
      kind,
      openerPageId,
    };
    sessions.setBackgroundPage(sessionId, name, entry);
    initializeGuest(entry.guest);
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

  async function hasUsableViewport(guest: WebContents): Promise<boolean> {
    if (guest.isDestroyed()) return false;
    try {
      return await guest.executeJavaScript(
        'window.innerWidth > 0 && window.innerHeight > 0',
        true,
      ) === true;
    } catch {
      return false;
    }
  }

  function requestBrowserSurface(sessionId: string, reveal: boolean): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error('desktop window is unavailable');
    }
    window.webContents.send(DESKTOP_IPC.browserOpenRequested, { sessionId, reveal });
  }

  /** Create a parked session surface when no live guest exists. Foreground
   * agent actions also reveal an existing guest beside its owner session. */
  async function ensureGuest(
    sessionId: string,
    options: { reveal?: boolean } = {},
  ): Promise<WebContents> {
    const reveal = options.reveal !== false;
    const existing = sessions.liveGuest(sessionId);
    if (existing && await hasUsableViewport(existing)) {
      if (reveal) requestBrowserSurface(sessionId, true);
      return existing;
    }
    let cancelWaiter = () => {};
    const attached = existing ? null : new Promise<WebContents>((resolve) => {
      cancelWaiter = sessions.waitForGuest(sessionId, resolve);
    });
    requestBrowserSurface(sessionId, reveal);
    let guest = existing;
    try {
      if (attached) {
        guest = await Promise.race([
          attached,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), OPEN_SURFACE_TIMEOUT_MS)),
        ]);
      }
    } finally {
      cancelWaiter();
    }
    const deadline = Date.now() + OPEN_SURFACE_TIMEOUT_MS;
    while (guest && Date.now() < deadline) {
      const current = sessions.liveGuest(sessionId) || guest;
      if (await hasUsableViewport(current)) return current;
      await pause(25);
      guest = sessions.liveGuest(sessionId) || guest;
    }
    throw new Error(`Browser Use for session ${sessionId} did not create a usable page`);
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
    reclaimIdleBackgroundPages,
    ensureOffscreen,
    requestBrowserSurface,
    ensureGuest,
    recoverCrashedGuest,
  };
}
