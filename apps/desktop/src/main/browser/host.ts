/**
 * Agent browser host — main-process owner of session-isolated Chromium pages
 * and the local bridge that lets the runtime's `browser` tool drive them.
 *
 * Architecture: guest-lifecycle owns non-activating page windows on the shared
 * persistent partition; BrowserPane displays pixels and sends bounded human
 * input. CDP drives the current page over the Chrome
 * DevTools Protocol, the action registry answers each command, reply turns
 * outcomes into text, and this module wires those parts together and hosts
 * the loopback HTTP server whose port+token ride a discovery file in the
 * Mixdog data directory. The runtime tool reads that file, so the tool
 * surface only exists while this desktop app runs — no daemon protocol
 * changes.
 *
 * background:true commands run against hidden offscreen BrowserWindows on the
 * SAME partition (named through `tab` for parallel pages), so the agent can
 * work invisibly while staying logged in.
 */
import type { BrowserWindow } from 'electron';

import type {
  DesktopBrowserImportProgress,
  DesktopRemoteBrowserTab,
  DesktopBrowserViewportConfig,
  DesktopBrowserPageFrame,
  DesktopBrowserPageIdentity,
  DesktopBrowserPageResample,
  DesktopBrowserPageControl,
  DesktopBrowserTabControlResult,
  DesktopRemoteBrowserControl,
  DesktopBrowserOpenRequest,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserStreamOptions,
} from '../../shared/contract';
import type { BrowserApprovalRequest } from './action-approval';
import { BACKGROUND_RECLAIM_INTERVAL_MS } from './command';
import { createBrowserCommandToolkit } from './command-toolkit';
import type { BrowserCredentialFillResult } from './credential-autofill';
import { createBrowserHostAgent } from './host-agent';
import { createBrowserHostFoundation } from './host-foundation';
import {
  createBrowserHostDisplayMethods,
  createBrowserHostLifecycleMethods,
  createBrowserRemoteHostMethods,
  createBrowserSessionRelease,
} from './host-methods';
import { createBrowserHostPages } from './host-pages';
import { createBrowserHostPresentation } from './host-presentation';
import { createBrowserLocalPageControl } from './local-page-control';
import type { BrowserNativeRect } from './native-view';
import { reclaimIdleUserSessions } from './page-power';
import { createBrowserProfileHostMethods } from './profile-host-methods';
import type {
  BrowserCredentialSuggestion,
  BrowserHistoryEntry,
  BrowserImportRequest,
  BrowserImportResult,
  BrowserImportSource,
} from './profile-import';

export type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserSnapshotResultOptions,
} from './command';

export interface BrowserHost {
  browserPageFrame(
    sessionId: string,
    previousFrameId?: string,
    texture?: boolean
  ): Promise<DesktopBrowserPageFrame | DesktopBrowserPageResample>;
  browserPageControl(
    sessionId: string,
    input: DesktopBrowserPageControl
  ): Promise<DesktopBrowserTabControlResult | void>;
  /** Page facts without pixels, for a pane whose page is natively presented. */
  browserPageMetadata(sessionId: string): Promise<DesktopBrowserPageFrame>;
  /** Show the session's current page natively at `rect` (shell CSS pixels), or
   *  park it. `enabled` is false when native presentation is not turned on. */
  browserPresentNative(sessionId: string, rect: BrowserNativeRect | null): { enabled: boolean; shown: boolean };
  /** Opt-in agent bridge: on serves the runtime's `browser` tool, off tears
   *  it down (server, discovery file, agent offscreen pages). The browser
   *  pane infrastructure stays live either way. */
  setBridgeEnabled(enabled: boolean): void;
  releaseSession(sessionId: string, options?: { restore?: boolean }): void;
  setGuestActive(sessionId: string, webContentsId: number, active: boolean): void;
  configureGuestViewport(sessionId: string, webContentsId: number, config: DesktopBrowserViewportConfig): Promise<void>;
  browserImportSources(): Promise<BrowserImportSource[]>;
  browserImport(request: BrowserImportRequest): Promise<BrowserImportResult>;
  browserHistorySearch(query: string): Promise<BrowserHistoryEntry[]>;
  browserCredentialSuggestions(sessionId: string): Promise<BrowserCredentialSuggestion[]>;
  browserCredentialFill(sessionId: string, credentialId: string): Promise<BrowserCredentialFillResult>;
  /** Title, site icon and thumbnail this browser recorded for `url`, or null.
   *  `preview`: a page card asks; without a thumbnail, the page's own preview
   *  is read in the background and announced as a change. */
  browserPageIdentity(url: string, preview?: boolean): DesktopBrowserPageIdentity | null;
  /** Start/renew (options) or stop (null) streaming a session's live frames. */
  remoteBrowserStream(sessionId: string, options: DesktopRemoteBrowserStreamOptions | null): Promise<void>;
  remoteBrowserControl(
    sessionId: string,
    input: DesktopRemoteBrowserControl
  ): Promise<DesktopBrowserTabControlResult | void>;
  /** The main-workspace browser tabs a paired client may switch between. */
  remoteTabs(): DesktopRemoteBrowserTab[];
  /** Start/stop publishing tab changes; returns the current list. */
  remoteTabsWatch(on: boolean): DesktopRemoteBrowserTab[];
  /** Open a new main-workspace tab on `url`. */
  remoteTabOpen(url: string): Promise<DesktopRemoteBrowserTab>;
  dispose(): Promise<void>;
}

export function createBrowserHost(
  window: BrowserWindow,
  options: {
    /** The session's work runs on a remote server (ssh window), not this PC;
     *  private-network navigation stays blocked for it. */
    remoteSession: boolean;
    onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
    requestApproval?: (request: BrowserApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
    chooseBrowserFiles?: (multiple: boolean) => Promise<{ canceled: boolean; filePaths: string[] }>;
    /** An explicit reveal or hide of a session's surface, for paired clients. */
    onSurfaceRequest?: (request: DesktopBrowserOpenRequest) => void;
    /** One live frame of a remotely streamed session, handed to the service. */
    publishRemoteFrame?: (frame: DesktopRemoteBrowserStreamFrame) => Promise<void>;
    /** The main-workspace tab list changed, for watching paired clients. */
    publishRemoteTabs?: (tabs: DesktopRemoteBrowserTab[]) => Promise<void>;
    /** Profile-import progress, for the paired client that may have started it. */
    publishRemoteImportProgress?: (progress: DesktopBrowserImportProgress) => Promise<void>;
  }
): BrowserHost {
  const base = createBrowserHostFoundation(window, {
    remoteSession: options.remoteSession,
    onDiagnostic: options.onDiagnostic,
    requestApproval: options.requestApproval,
  });
  const { state, sessions, cdp, display, sendToRenderer } = base;
  const { lifecycle, nativeViews, taskLifecycle, retainGuest } = createBrowserHostPages({
    window,
    base,
    onSurfaceRequest: options.onSurfaceRequest,
    interruptForLocal: (command) => agent.interruptForLocal(command),
  });
  const tools = createBrowserCommandToolkit({
    state,
    cdp,
    documents: base.documents,
    settle: base.settle,
    sessions,
    downloadsForSession: base.partition.downloadLedger.downloadsForSession,
    partitionSession: base.partition.session,
    urlPolicy: base.urlPolicy,
    sendToRenderer,
    beginViewportChange: (guest) => shown.pageSurface.beginViewportChange(guest),
  });
  const shown = createBrowserHostPresentation({
    window,
    base,
    lifecycle,
    tools,
    retainGuest,
    chooseBrowserFiles: options.chooseBrowserFiles,
    publishRemoteFrame: options.publishRemoteFrame,
    publishRemoteTabs: options.publishRemoteTabs,
    onDiagnostic: options.onDiagnostic,
  });
  const agent = createBrowserHostAgent({
    base,
    tools,
    lifecycle,
    tabs: shown.tabs,
    taskLifecycle,
    retainGuest,
    onDiagnostic: options.onDiagnostic,
  });

  // Pages nobody displays or drives for long are unloaded (URLs kept) and
  // restore when the panel or an agent command returns — unless a person
  // entered something there, which only the live document holds.
  const userReclaimTimer = setInterval(
    () =>
      reclaimIdleUserSessions({
        sessions,
        power: display.power,
        isBackgroundBusy: base.isBackgroundBusy,
        holdsUserInput: (guest) => state.peek(guest)?.userInput === true,
        unload: (sessionId) => browserHost.releaseSession(sessionId, { restore: true }),
      }),
    BACKGROUND_RECLAIM_INTERVAL_MS
  );
  userReclaimTimer.unref?.();

  const browserHost: BrowserHost = {
    ...createBrowserHostDisplayMethods({
      sessions,
      presentationReads: shown.presentationReads,
      pageSurface: shown.pageSurface,
      remoteDrive: shown.remoteDrive,
      nativeViews,
      display,
      pageIdentity: base.pageIdentity.store,
      pagePreviews: base.pageIdentity.previews,
    }),
    browserPageControl: createBrowserLocalPageControl({
      currentGuest: (sessionId) => sessions.currentGuest(sessionId),
      state,
      retainGuest,
      queue: {
        executeLocal: agent.executeLocal,
        interruptForLocal: agent.interruptForLocal,
        holdLocal: agent.holdLocal,
      },
      control: shown.pageSurface.control,
      bounded: cdp.bounded,
    }),
    releaseSession: createBrowserSessionRelease({
      display,
      remote: shown.remote,
      presentationReads: shown.presentationReads,
      nativeViews,
      releaseLocal: agent.releaseLocal,
      pageSurface: shown.pageSurface,
      lifecycle,
      taskLifecycle,
      downloadLedger: base.partition.downloadLedger,
      sendToRenderer,
      remoteTabs: shown.remoteTabs,
    }),
    ...createBrowserProfileHostMethods({
      profileImporter: base.profileImporter,
      liveGuest: (sessionId) => sessions.liveGuest(sessionId),
      fillCredentialInGuest: (guest, credential) => tools.credentialFill.fillCredentialInGuest(guest, credential),
      sendToRenderer,
      publishRemoteImportProgress: options.publishRemoteImportProgress,
    }),
    ...createBrowserRemoteHostMethods({
      remote: shown.remote,
      remoteTabs: shown.remoteTabs,
      display,
      executeSerialized: agent.executeSerialized,
      host: () => browserHost,
    }),
    ...createBrowserHostLifecycleMethods({
      bridge: agent.bridge,
      remoteTabs: shown.remoteTabs,
      userReclaimTimer,
      stopFollowingScale: shown.stopFollowingScale,
      presentationReads: shown.presentationReads,
      stopSessionAutosave: base.stopSessionAutosave,
      sessionStore: base.sessionStore,
      pagePreviews: base.pageIdentity.previews,
      pageIdentityFile: base.pageIdentity.file,
      cookieJar: base.cookieJar,
      partition: base.partition,
      visibleGuests: () => sessions.visibleGuests(),
      detach: (guest) => cdp.detach(guest),
      lifecycle,
    }),
  };
  return browserHost;
}
