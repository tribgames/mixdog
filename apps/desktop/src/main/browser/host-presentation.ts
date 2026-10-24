/**
 * How people see and steer pages: the remote drive of a streaming phone, the
 * session tab strip, the prompts a person answers, remote control and tabs for
 * paired clients, the page surface the pane draws, scale following, and the
 * pane's presentation reads.
 */
import type { BrowserWindow, WebContents } from 'electron';
import { dialog, screen } from 'electron';

import { DESKTOP_IPC, type DesktopRemoteBrowserStreamFrame, type DesktopRemoteBrowserTab } from '../../shared/contract';
import type { createBrowserGuestCdp } from './cdp';
import type { createBrowserCommandToolkit } from './command-toolkit';
import { createBrowserDisplayCapture } from './display-capture';
import type { createBrowserDisplayTracking } from './display-tracking';
import { browserSharedTextureRendering, type createBrowserGuestLifecycle } from './guest-lifecycle';
import type { BrowserGuestStateStore } from './guest-state';
import type { BrowserHostFoundation } from './host-foundation';
import { browserViewportEmulation } from './host-policy';
import { closePage, type createBrowserLeaveConfirmation } from './leave-confirmation';
import { createBrowserLocalPrompts } from './local-prompts';
import { browserPageGeometry } from './page-geometry';
import { createBrowserPageSurface } from './page-surface';
import { createPageInputDispatcher } from './page-surface-control';
import { createBrowserPresentationReads } from './presentation-reads';
import { createBrowserRemoteControl } from './remote-control';
import { createBrowserRemoteDrive } from './remote-drive';
import { createBrowserRemoteTabs } from './remote-tabs';
import { followBrowserDisplayScale } from './scale-follower';
import type { BrowserSessionRegistry } from './session-registry';
import { createBrowserSessionTabStrip } from './session-tab-strip';
import { createBrowserTabs } from './tabs';
import type { SessionTabStrip } from './tabs-close-result';
import type { createBrowserUrlAdmission } from './url-admission';
import type { BrowserUrlPolicy } from './url-policy';
import { createUserTakesPage } from './user-takes-page';

type Toolkit = ReturnType<typeof createBrowserCommandToolkit>;
type Lifecycle = ReturnType<typeof createBrowserGuestLifecycle>;
type Leave = ReturnType<typeof createBrowserLeaveConfirmation>;
type Cdp = ReturnType<typeof createBrowserGuestCdp>;
type Display = ReturnType<typeof createBrowserDisplayTracking>;
type Send = (channel: string, ...args: unknown[]) => void;

/** The agent's tab commands and the session tab strip over them. */
function createBrowserHostTabs(
  sessions: BrowserSessionRegistry,
  state: BrowserGuestStateStore,
  lifecycle: Lifecycle,
  leave: Leave,
  retainGuest: (guest: WebContents) => void,
  onCreate?: (sessionId: string, pageId: string, requestId?: string) => void
) {
  const tabs = createBrowserTabs({
    visibleGuests: (sessionId) => sessions.visibleGuests(sessionId),
    backgroundPages: (sessionId) => sessions.backgroundPages(sessionId),
    backgroundEntryByPageId: lifecycle.backgroundEntryByPageId,
    ensureOffscreen: lifecycle.ensureOffscreen,
    destroyBackgroundPage: lifecycle.destroyBackgroundPage,
    pageId: (guest) => state.pageId(guest),
    currentGuest: (sessionId) => sessions.currentGuest(sessionId),
    selectGuest: (sessionId, guest) => sessions.selectGuest(sessionId, guest),
    // The page closes before its window, so beforeunload can protect edits.
    closeGuest: (guest) => leave.request(guest, () => closePage(guest)),
  });
  const sessionTabs = createBrowserSessionTabStrip({
    tabs,
    currentGuest: (sessionId) => sessions.currentGuest(sessionId),
    agentFollow: {
      isPaused: (sessionId) => sessions.agentPage(sessionId)?.paused === true,
      pause: (sessionId) => sessions.pauseAgentFollow(sessionId),
      resume: (sessionId) => sessions.resumeAgentFollow(sessionId),
    },
    lifecycle,
    pageId: (guest) => state.pageId(guest),
    retainGuest,
    onCreate,
  });
  return { tabs, sessionTabs };
}

/** Remote control of a session's page for a paired client. */
function createBrowserHostRemoteControl(options: {
  sessionTabs: SessionTabStrip;
  prompts: ReturnType<typeof createBrowserLocalPrompts>;
  remoteDrive: ReturnType<typeof createBrowserRemoteDrive>;
  state: BrowserGuestStateStore;
  cdp: Cdp;
  urlPolicy: BrowserUrlPolicy;
  lifecycle: Lifecycle;
  sessions: BrowserSessionRegistry;
  display: Display;
  sendToRenderer: Send;
  retainGuest: (guest: WebContents) => void;
  leave: Leave;
  urls: ReturnType<typeof createBrowserUrlAdmission>;
  dispatchInput: Toolkit['dispatchInput'];
  dialogOwner: (guest: WebContents) => WebContents | null;
  publishRemoteFrame?: (frame: DesktopRemoteBrowserStreamFrame) => Promise<void>;
}) {
  const { state, cdp, leave, urls } = options;
  return createBrowserRemoteControl({
    tabs: options.sessionTabs,
    dialog: (guest) => options.prompts.describe(guest).dialog,
    drive: options.remoteDrive,
    state,
    cdp,
    urlPolicy: options.urlPolicy,
    ensureGuest: options.lifecycle.ensureGuest,
    currentGuest: (sessionId) => options.sessions.currentGuest(sessionId) ?? null,
    viewerChanged: (sessionId, active) => {
      // Lease expiry ends a stream without remoteBrowserStream(null), so the
      // power classification follows the stream lifecycle itself.
      options.display.setRemoteViewing(sessionId, active);
      options.sendToRenderer(DESKTOP_IPC.browserRemoteViewerChanged, { sessionId, active });
    },
    onUserControl: createUserTakesPage({
      sessionIdForGuest: (guest) => options.sessions.sessionIdForGuest(guest),
      claimPage: options.lifecycle.claimPage,
      retain: options.retainGuest,
    }),
    leave,
    assertResolvedUrlAllowed: urls.assertResolvedUrlAllowed,
    dispatchPageInput: createPageInputDispatcher({
      state,
      cdp,
      dispatchInput: options.dispatchInput,
      dialogOwner: options.dialogOwner,
      leave,
      urlPolicy: options.urlPolicy,
      assertUrl: urls.assertResolvedUrlAllowed,
    }),
    publishFrame: (frame) => options.publishRemoteFrame?.(frame) ?? Promise.resolve(),
  });
}

export function createBrowserHostPresentation(options: {
  window: BrowserWindow;
  base: Pick<
    BrowserHostFoundation,
    | 'sessions'
    | 'state'
    | 'cdp'
    | 'leave'
    | 'display'
    | 'displayTextures'
    | 'urls'
    | 'urlPolicy'
    | 'sendToRenderer'
    | 'partition'
  >;
  lifecycle: Lifecycle;
  tools: Pick<Toolkit, 'emulation' | 'dispatchInput' | 'dialogs' | 'refActions'>;
  retainGuest: (guest: WebContents) => void;
  /** A tab the session strip created, with its page id and the request that asked. */
  onTabCreated?: (sessionId: string, pageId: string, requestId?: string) => void;
  chooseBrowserFiles?: (multiple: boolean) => Promise<{ canceled: boolean; filePaths: string[] }>;
  publishRemoteFrame?: (frame: DesktopRemoteBrowserStreamFrame) => Promise<void>;
  publishRemoteTabs?: (tabs: DesktopRemoteBrowserTab[]) => Promise<void>;
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
}) {
  const { window, lifecycle, tools } = options;
  const { sessions, state, cdp, leave, urls, display, sendToRenderer, urlPolicy } = options.base;
  // A streaming phone's viewport wins over the PC pane's size and preset; the
  // pane's come back when the phone stops (explicit stop or lapsed lease).
  const remoteDrive = createBrowserRemoteDrive({
    setGeometry: (guest, size, zoom) => pageSurface.setGeometry(guest, size, zoom),
    paneGeometry: (sessionId) => pageSurface.paneGeometry(sessionId),
    emulate: async (guest, config) => {
      await tools.emulation.configureEmulation(guest, browserViewportEmulation(config));
    },
    drivingChanged: (sessionId, driving) =>
      sendToRenderer(DESKTOP_IPC.browserRemoteViewerChanged, {
        sessionId,
        active: display.isRemoteViewing(sessionId),
        driving,
      }),
  });
  // A page sharing this one's renderer whose dialog blocks it as well, in any
  // session. Those pages are presented and guarded like the dialog page
  // itself; only a view in the dialog page's own session shows and answers it.
  const dialogOwner = (guest: WebContents): WebContents | null => state.dialogOwner(guest);
  const { tabs, sessionTabs } = createBrowserHostTabs(
    sessions,
    state,
    lifecycle,
    leave,
    options.retainGuest,
    options.onTabCreated
  );
  // The prompts a person answers, at the pane and on a paired client alike.
  const prompts = createBrowserLocalPrompts({
    state,
    dialogs: tools.dialogs,
    uploads: tools.refActions,
    chooseFiles:
      options.chooseBrowserFiles ??
      ((multiple) =>
        dialog.showOpenDialog(window, {
          properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
        })),
    controller: (guest) => sessions.sessionIdForGuest(guest),
    leave,
    permissions: options.base.partition.permissions,
  });
  const remote = createBrowserHostRemoteControl({
    sessionTabs,
    prompts,
    remoteDrive,
    state,
    cdp,
    urlPolicy,
    lifecycle,
    sessions,
    display,
    sendToRenderer,
    retainGuest: options.retainGuest,
    leave,
    urls,
    dispatchInput: tools.dispatchInput,
    dialogOwner,
    publishRemoteFrame: options.publishRemoteFrame,
  });
  const remoteTabs = createBrowserRemoteTabs({
    sessionIds: () => sessions.sessionIds(),
    liveGuest: (sessionId) => sessions.liveGuest(sessionId),
    publish: (tabs) => options.publishRemoteTabs?.(tabs) ?? Promise.resolve(),
  });
  // Fixed at startup: the live acceleration flag can flip after a GPU-crash
  // fallback while the capture path and window options do not.
  const sharedTextureRendering = browserSharedTextureRendering();
  const displayCapture = createBrowserDisplayCapture(sharedTextureRendering);
  const pageSurface = createBrowserPageSurface({
    ensureGuest: lifecycle.ensureGuest,
    currentGuest: (sessionId) => sessions.currentGuest(sessionId),
    agentPage: (sessionId) => sessions.agentPage(sessionId),
    userTouched: (sessionId, guest) => lifecycle.claimPage(sessionId, guest),
    remoteDriven: (guest) => remoteDrive.driven(guest),
    dialogOwner,
    leave,
    tabs: sessionTabs,
    state,
    cdp,
    dispatchInput: tools.dispatchInput,
    urlPolicy,
    prompts,
    assertUrl: urls.assertResolvedUrlAllowed,
    capture: (guest, geometryKey, pixels, signal) =>
      cdp.bounded(displayCapture(guest, geometryKey, pixels), 2000, 'Browser display capture', signal),
    captureTexture: (guest, documentId, pixels) =>
      options.base.displayTextures.acquire(guest, documentId, pixels.width, pixels.height),
    ...browserPageGeometry(sharedTextureRendering),
  });
  const stopFollowingScale = followBrowserDisplayScale(screen, () => pageSurface.refreshScale(), options.onDiagnostic);
  const presentationReads = createBrowserPresentationReads({
    capture: (owner, signal, texture) => pageSurface.frame(owner, '', signal, texture),
    bounded: cdp.bounded,
  });
  return { remoteDrive, tabs, remote, remoteTabs, pageSurface, stopFollowingScale, presentationReads };
}
