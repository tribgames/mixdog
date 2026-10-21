/**
 * The browser host's public methods, grouped by what they serve: the local
 * pane's display, paired clients' remote control, and the host's session and
 * bridge lifecycle.
 */
import { randomUUID } from 'node:crypto';

import { DESKTOP_IPC, MAIN_BROWSER_PAGE_PREFIX } from '../../shared/contract';
import type { createBrowserAgentBridge } from './agent-bridge';
import type { createBrowserGuestCdp } from './cdp';
import type { createBrowserCommandQueue } from './command-queue';
import type { createBrowserCookieJar } from './cookie-jar';
import type { createBrowserDisplayTracking } from './display-tracking';
import type { createBrowserGuestLifecycle } from './guest-lifecycle';
import type { BrowserHost } from './host';
import type { createBrowserHostPageIdentity } from './host-page-identity';
import type { createBrowserHostPresentation } from './host-presentation';
import type { createBrowserNativeViews } from './native-view';
import type { createPageFullscreen } from './page-fullscreen';
import type { createBrowserPartition } from './partition';
import type { createBrowserSessionStore } from './browser-session-store';
import { type BrowserSessionRegistry, browserSessionId } from './session-registry';
import { isSessionTabControl } from './tabs-close-result';
import type { createBrowserTaskLifecycle } from './task-lifecycle';
import type { WebContents } from 'electron';

type Presentation = ReturnType<typeof createBrowserHostPresentation>;
type Display = ReturnType<typeof createBrowserDisplayTracking>;
type NativeViews = ReturnType<typeof createBrowserNativeViews> | null;
type PageIdentity = ReturnType<typeof createBrowserHostPageIdentity>;
type CommandQueue = ReturnType<typeof createBrowserCommandQueue>;

export function createBrowserHostDisplayMethods(options: {
  sessions: BrowserSessionRegistry;
  presentationReads: Presentation['presentationReads'];
  pageSurface: Presentation['pageSurface'];
  remoteDrive: Presentation['remoteDrive'];
  nativeViews: NativeViews;
  fullscreen: Pick<ReturnType<typeof createPageFullscreen>, 'reconcile'> | null;
  display: Display;
  pageIdentity: PageIdentity['store'];
  pagePreviews: PageIdentity['previews'];
}): Pick<
  BrowserHost,
  | 'browserPageFrame'
  | 'browserPageMetadata'
  | 'browserPresentNative'
  | 'setGuestActive'
  | 'configureGuestViewport'
  | 'browserPageIdentity'
> {
  const { sessions, nativeViews, display } = options;
  return {
    browserPageFrame(sessionId, previousFrameId = '', texture = false) {
      const owner = browserSessionId(sessionId);
      options.fullscreen?.reconcile(owner);
      return options.presentationReads.read(owner, previousFrameId, texture);
    },
    browserPageMetadata(sessionId) {
      options.fullscreen?.reconcile(browserSessionId(sessionId));
      return options.pageSurface.metadata(browserSessionId(sessionId));
    },
    browserPresentNative(sessionId, rect) {
      if (!nativeViews) return { enabled: false, shown: false };
      const owner = browserSessionId(sessionId);
      const shown = nativeViews.present(owner, rect);
      display.setNativeShown(owner, shown ? sessions.currentGuest(owner) : null);
      return { enabled: true, shown };
    },
    setGuestActive(sessionId, webContentsId, active) {
      const owner = browserSessionId(sessionId);
      let guest = sessions.guestForSession(owner, webContentsId);
      if (!guest) {
        sessions.bindVisibleGuest(owner, webContentsId, active);
        guest = sessions.guestForSession(owner, webContentsId);
      }
      if (!guest) return;
      // Restore a shown page before repainting it; a hidden one throttles.
      display.setPanelActive(guest, active);
      // A late display report must never undo a newer tab selection.
      if (active && guest === sessions.currentGuest(owner)) guest.invalidate();
    },
    async configureGuestViewport(sessionId, webContentsId, config) {
      const owner = browserSessionId(sessionId);
      const guest = sessions.guestForSession(owner, webContentsId);
      if (!guest || guest.id !== webContentsId) {
        throw new Error('Browser guest is unavailable.');
      }
      await options.remoteDrive.configurePane(guest, config);
    },
    browserPageIdentity(url, preview = false) {
      const identity = options.pageIdentity.lookup(url);
      if (preview && !identity?.thumbnail) options.pagePreviews.request(url);
      return identity;
    },
  };
}

export function createBrowserRemoteHostMethods(options: {
  remote: Presentation['remote'];
  remoteTabs: Presentation['remoteTabs'];
  display: Display;
  executeSerialized: CommandQueue['executeSerialized'];
  /** The finished host, whose own methods these delegate to. */
  host: () => BrowserHost;
}): Pick<
  BrowserHost,
  'remoteBrowserStream' | 'remoteBrowserControl' | 'remoteTabs' | 'remoteTabsWatch' | 'remoteTabOpen'
> {
  const { remote, remoteTabs } = options;
  return {
    remoteBrowserStream(sessionId, streamOptions) {
      const owner = browserSessionId(sessionId);
      options.display.setRemoteViewing(owner, Boolean(streamOptions));
      return remote.remoteBrowserStream(owner, streamOptions);
    },
    remoteBrowserControl(sessionId, control) {
      // Sizing the view is presentation, like the pane's own resize: it neither
      // waits behind nor interrupts an agent command. Tab chrome is the same,
      // as the local pane's tab controls are.
      if (control.type === 'viewport' || isSessionTabControl(control)) {
        return remote.remoteBrowserControl(browserSessionId(sessionId), control);
      }
      // A dialog answer takes the pane's own path: bound to the shown
      // document and prompt, and never queued behind the command it blocks.
      if (control.type === 'answer-dialog') return options.host().browserPageControl(sessionId, control);
      return options.executeSerialized(
        { action: 'remote_control', session_id: browserSessionId(sessionId) },
        undefined,
        () => remote.remoteBrowserControl(browserSessionId(sessionId), control)
      );
    },
    remoteTabs: () => remoteTabs.list(),
    remoteTabsWatch: (on) => remoteTabs.watch(on),
    async remoteTabOpen(url) {
      const id = `${MAIN_BROWSER_PAGE_PREFIX}${randomUUID().replaceAll('-', '')}`;
      await options.host().remoteBrowserControl(id, { type: 'navigate', url });
      remoteTabs.changed();
      return remoteTabs.list().find((tab) => tab.id === id) ?? { id, title: '', url, loading: true };
    },
  };
}

export function createBrowserSessionRelease(options: {
  display: Display;
  remote: Presentation['remote'];
  presentationReads: Presentation['presentationReads'];
  nativeViews: NativeViews;
  releaseLocal: CommandQueue['releaseLocal'];
  pageSurface: Presentation['pageSurface'];
  lifecycle: ReturnType<typeof createBrowserGuestLifecycle>;
  taskLifecycle: ReturnType<typeof createBrowserTaskLifecycle<WebContents>>;
  downloadLedger: ReturnType<typeof createBrowserPartition>['downloadLedger'];
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  remoteTabs: Presentation['remoteTabs'];
}): BrowserHost['releaseSession'] {
  return (sessionId: string, releaseOptions: { restore?: boolean } = {}): void => {
    const ownerSessionId = browserSessionId(sessionId);
    options.display.release(ownerSessionId);
    options.remote.releaseViewer(ownerSessionId);
    options.presentationReads.release(ownerSessionId);
    options.nativeViews?.present(ownerSessionId, null);
    options.releaseLocal({ action: 'remote_control', session_id: ownerSessionId });
    options.pageSurface.release(ownerSessionId);
    options.lifecycle.releaseSession(ownerSessionId, releaseOptions.restore === true);
    options.taskLifecycle.forget(ownerSessionId);
    options.downloadLedger.release(ownerSessionId);
    options.sendToRenderer(
      DESKTOP_IPC.browserSessionReleased,
      ownerSessionId,
      releaseOptions.restore === true ? 'unloaded' : 'gone'
    );
    options.remoteTabs.changed();
  };
}

/** The bridge toggle and teardown share one disposed flag. */
export function createBrowserHostLifecycleMethods(options: {
  bridge: ReturnType<typeof createBrowserAgentBridge>;
  remoteTabs: Presentation['remoteTabs'];
  userReclaimTimer: NodeJS.Timeout;
  stopFollowingScale: () => void;
  presentationReads: Presentation['presentationReads'];
  stopSessionAutosave: () => void;
  sessionStore: ReturnType<typeof createBrowserSessionStore>;
  pagePreviews: PageIdentity['previews'];
  pageIdentityFile: PageIdentity['file'];
  cookieJar: ReturnType<typeof createBrowserCookieJar>;
  partition: ReturnType<typeof createBrowserPartition>;
  visibleGuests: () => WebContents[];
  detach: ReturnType<typeof createBrowserGuestCdp>['detach'];
  lifecycle: ReturnType<typeof createBrowserGuestLifecycle>;
}): Pick<BrowserHost, 'setBridgeEnabled' | 'dispose'> {
  const { bridge } = options;
  let disposed = false;
  let bridgeWanted = false;
  return {
    setBridgeEnabled(enabled: boolean): void {
      if (disposed || bridgeWanted === enabled) return;
      bridgeWanted = enabled;
      if (enabled) bridge.start();
      // A failed stop leaves nothing to undo here; a later enable starts afresh.
      else void bridge.stop().catch(() => undefined);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      options.remoteTabs.dispose();
      clearInterval(options.userReclaimTimer);
      options.stopFollowingScale();
      options.presentationReads.dispose();
      options.stopSessionAutosave();
      // Teardown goes on past a failed final save or flush.
      await options.sessionStore.save().catch(() => undefined);
      options.pagePreviews.dispose();
      await options.pageIdentityFile.flush().catch(() => undefined);
      await options.cookieJar.dispose();
      options.partition.dispose();
      for (const guest of options.visibleGuests()) {
        await options.detach(guest);
      }
      await bridge.stop();
      options.lifecycle.destroyAllPrimaryPages();
    },
  };
}
