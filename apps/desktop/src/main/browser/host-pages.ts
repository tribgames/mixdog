/**
 * The host's page windows: the guest lifecycle with what every new guest is
 * wired to, optional native presentation, and the per-turn task lifecycle that
 * decides which agent-opened pages close when a turn finishes.
 */
import type { BrowserWindow, WebContents } from 'electron';

import { DESKTOP_IPC, type DesktopBrowserOpenRequest } from '../../shared/contract';
import type { BrowserCommand } from './command';
import type { createBrowserDisplayTextures } from './display-textures';
import type { createBrowserDisplayTracking } from './display-tracking';
import { createBrowserGuestLifecycle } from './guest-lifecycle';
import type { BrowserGuestStateStore } from './guest-state';
import type { BrowserHostFoundation } from './host-foundation';
import type { createBrowserHostPageIdentity } from './host-page-identity';
import type { createBrowserLeaveConfirmation } from './leave-confirmation';
import { createBrowserNativeViews } from './native-view';
import { createPageFullscreen } from './page-fullscreen';
import { trackBrowserPageIdentity } from './page-identity';
import { captureBrowserPageThumbnail, readBrowserFavicon } from './page-identity-capture';
import { browserPageWindow } from './page-window';
import { type BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID } from './session-registry';
import { createBrowserTaskLifecycle } from './task-lifecycle';
import { createUserTakesPage } from './user-takes-page';

/** What every new guest is wired to as it appears. */
function watchBrowserGuest(
  guest: WebContents,
  watchers: {
    display: ReturnType<typeof createBrowserDisplayTracking>;
    displayTextures: ReturnType<typeof createBrowserDisplayTextures>;
    nativeViews: ReturnType<typeof createBrowserNativeViews> | null;
    fullscreen: ReturnType<typeof createPageFullscreen> | null;
    leave: ReturnType<typeof createBrowserLeaveConfirmation>;
    pageIdentity: ReturnType<typeof createBrowserHostPageIdentity>['store'];
  }
): void {
  const { leave } = watchers;
  watchers.display.track(guest);
  watchers.displayTextures.attach(guest);
  watchers.nativeViews?.watch(guest);
  watchers.fullscreen?.watch(guest);
  // Without a listener Electron keeps the page silently; a person's
  // request is asked about instead (see leave-confirmation).
  guest.on('will-prevent-unload', (event) => leave.vetoed(guest, () => event.preventDefault()));
  guest.on('did-start-navigation', (details) => {
    if (details.isMainFrame) leave.settled(guest, details.isSameDocument);
  });
  trackBrowserPageIdentity(guest, watchers.pageIdentity, {
    // The page's own session: its cookies and cache, as the page loads it.
    favicon: (url, pageUrl) => readBrowserFavicon(guest.session, url, pageUrl),
    thumbnail: captureBrowserPageThumbnail,
  });
}

function createBrowserHostTaskLifecycle(sessions: BrowserSessionRegistry, state: BrowserGuestStateStore) {
  return createBrowserTaskLifecycle<WebContents>({
    close: (guest) => browserPageWindow(guest)?.destroy(),
    canClose: (guest) => !state.for(guest).pendingDialog,
    preserve: (guest) => {
      const owner = sessions.sessionIdForGuest(guest);
      const page = owner ? sessions.backgroundPageForGuest(owner, guest) : undefined;
      if (page) page.keepAlive = true;
    },
  });
}

export function createBrowserHostPages(options: {
  window: BrowserWindow;
  base: Pick<
    BrowserHostFoundation,
    | 'partition'
    | 'state'
    | 'sessions'
    | 'cdp'
    | 'urlPolicy'
    | 'isBackgroundBusy'
    | 'isForegroundBusy'
    | 'settle'
    | 'display'
    | 'displayTextures'
    | 'leave'
    | 'pageIdentity'
    | 'nativeView'
    | 'sendToRenderer'
  >;
  onSurfaceRequest?: (request: DesktopBrowserOpenRequest) => void;
  onGuest?: (guest: WebContents) => void;
  /** Cancel the agent on a page a person took over natively. */
  interruptForLocal: (command: BrowserCommand) => void;
}) {
  const { window, base } = options;
  const { state, sessions } = base;
  const lifecycle = createBrowserGuestLifecycle({
    window,
    partitionSession: base.partition.session,
    state,
    sessions,
    cdp: base.cdp,
    urlPolicy: base.urlPolicy,
    isBackgroundBusy: base.isBackgroundBusy,
    // A page with a queued or running command, or a download of its session,
    // is still in use: a stand-in is not tidied away under it.
    isPageBusy: (sessionId) =>
      base.isForegroundBusy(sessionId) ||
      base.partition.downloadLedger.downloadsForSession(sessionId).some((download) => download.state === 'in_progress'),
    waitForLoadSettle: base.settle.waitForLoadSettle,
    waitUntilShown: (guest, timeoutMs, signal) => base.display.waitUntilShown(guest, timeoutMs, signal),
    // A popup the person brought up is theirs: no agent turn closes it.
    onPopup: (opener, popup, selected) => {
      taskLifecycle.inherit(opener, popup);
      if (selected) retainGuest(popup);
    },
    onGuest: (guest) => {
      watchBrowserGuest(guest, {
        display: base.display,
        displayTextures: base.displayTextures,
        nativeViews,
        fullscreen,
        leave: base.leave,
        pageIdentity: base.pageIdentity.store,
      });
      options.onGuest?.(guest);
    },
    onSurfaceRequest: (request) => {
      // A failed open reveals nothing, so paired clients are not told.
      if (request.hide || (request.reveal === true && !request.error)) options.onSurfaceRequest?.(request);
    },
    nativeView: base.nativeView,
  });
  const nativeViews = base.nativeView
    ? createBrowserNativeViews({
        shell: window,
        currentGuest: (sessionId) => sessions.currentGuest(sessionId),
        // Native input bypasses browserPageControl, so it takes over from the
        // agent here, exactly as a relayed local gesture would.
        humanInput: (guest) => {
          if (guest.isDestroyed()) return;
          const owner = sessions.sessionIdForGuest(guest) ?? DEFAULT_BROWSER_SESSION_ID;
          state.for(guest).userInput = true;
          state.for(guest).actor = 'person';
          state.for(guest).personDialogAnswerAt = undefined;
          userTakesPage(guest);
          options.interruptForLocal({ action: 'remote_control', session_id: owner, tab: state.pageId(guest) });
        },
      })
    : null;
  // A natively presented page is the shell's own view; Electron fullscreens it.
  const fullscreen = base.nativeView
    ? null
    : createPageFullscreen({
        shell: window,
        sessionIdForGuest: (guest) => sessions.sessionIdForGuest(guest),
        currentGuest: (sessionId) => sessions.currentGuest(sessionId),
        changed: (sessionId, active) =>
          base.sendToRenderer(DESKTOP_IPC.browserFullscreenChanged, { sessionId, active }),
      });
  const taskLifecycle = createBrowserHostTaskLifecycle(sessions, state);
  const retainGuest = taskLifecycle.retain;
  const userTakesPage = createUserTakesPage({
    sessionIdForGuest: (guest) => sessions.sessionIdForGuest(guest),
    claimPage: lifecycle.claimPage,
    retain: retainGuest,
  });
  return { lifecycle, nativeViews, fullscreen, taskLifecycle, retainGuest };
}
