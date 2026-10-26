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
import type { BrowserWindow, WebContents } from 'electron';

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
import {
  isRemoteWebrtcPageInput,
  remoteWebrtcSourceKey,
  type RemoteScreenDisplaySummary,
  type RemoteWebrtcDesktopSignal,
} from '../../shared/remote-webrtc';
import { createRemoteWebrtcHost, type RemoteWebrtcHost } from '../remote-webrtc/host';
import { createRemoteWebrtcSenderWindow, type RemoteWebrtcSenderPage } from '../remote-webrtc/sender-window';
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
import { reloadPageAfterSignIn } from './login-takeover';
import type { BrowserNativeRect } from './native-view';
import { createNewTabWaiters, type NewTabWatch } from './new-tab-waiters';
import { createHandedOverPage } from './user-takes-page';
import { takeoverRevealDetail } from './page-reveal';
import { reclaimIdleUserSessions } from './page-power';
import { createBrowserProfileHostMethods } from './profile-host-methods';
import type { BrowserSignedInSite } from './signed-in-sites';
import type { VaultLoginSummary } from './credential-vault';
import type { LinkedSignIn } from './linked-sign-in';
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
  /** Takeover `id` starts: the page it hands over (`tab` of the request, else
   *  the agent's page) is fixed now, whatever tabs move later. */
  captureTakeoverPage(sessionId: string, id: string, tab: string): void;
  /** The session's pending takeover is now `current` ('' for none): the
   *  page recorded for any other one is forgotten. */
  endTakeoverPage(sessionId: string, current: string): void;
  /** Takeover `id` hands that page to the user: the panel opens on it now,
   *  the one time Browser Use opens it without a click. */
  openForTakeover(sessionId: string, id: string): void;
  /** After a sign-in in the login window: the page takeover `id` handed over
   *  reloads when it still exists and nothing would be lost
   *  (login-takeover.ts); true when it did. */
  reloadAfterSignIn(sessionId: string, id: string): Promise<boolean>;
  setGuestActive(sessionId: string, webContentsId: number, active: boolean): void;
  /** Pane `pane` of shell `sender` started (`true`) or stopped reading the
   *  session's pages: opening asks for its page (the blank start page if it
   *  has none), and the last one closing confirms a fold (panel-fold). */
  browserPanelShown(sessionId: string, shown: boolean, sender: Pick<WebContents, 'id' | 'on'>, pane: string): void;
  configureGuestViewport(sessionId: string, webContentsId: number, config: DesktopBrowserViewportConfig): Promise<void>;
  browserImportSources(): Promise<BrowserImportSource[]>;
  browserImport(request: BrowserImportRequest): Promise<BrowserImportResult>;
  browserHistorySearch(query: string): Promise<BrowserHistoryEntry[]>;
  browserCredentialSuggestions(sessionId: string): Promise<BrowserCredentialSuggestion[]>;
  /** With `fillId`: a login takeover's card, into the page it was bound to. */
  browserCredentialFill(sessionId: string, credentialId: string, fillId?: string): Promise<BrowserCredentialFillResult>;
  /** Sites the managed profile stays signed in to (names and counts only). */
  browserSignedInSites(): Promise<BrowserSignedInSite[]>;
  /** Sign out of one site: its cookies and its pages' storage. */
  browserSignOutSite(site: string): Promise<number>;
  /** Every sign-in, all site storage, and the data imported from Chrome. */
  browserClearSignIns(): Promise<void>;
  /** 설정 › 인증 관리: the saved logins, with no passwords or authenticator keys. */
  browserVaultLogins(): Promise<VaultLoginSummary[]>;
  /** Add (no id) or edit (id) a saved login; secrets flow in only. */
  browserVaultSave(input: {
    id?: string;
    origin: string;
    username: string;
    password?: string;
    totpSecret?: string;
    note?: string;
  }): Promise<void>;
  /** Delete a saved login by id. */
  browserVaultDelete(id: string): Promise<boolean>;
  /** 설정 › 인증 관리: which identity provider (and account, when known) each
   *  site was last signed in with through Browser Use (no token, ever). */
  browserLinkedSignIns(): Promise<LinkedSignIn[]>;
  /** Forget one linked sign-in by id. */
  browserLinkedSignInDelete(id: string): Promise<boolean>;
  /** Title, site icon and thumbnail this browser recorded for `url`, or null.
   *  `preview`: a page card asks; without a thumbnail, the page's own preview
   *  is read in the background and announced as a change. */
  browserPageIdentity(url: string, preview?: boolean): DesktopBrowserPageIdentity | null;
  /** Wait for the pane to create the tab that request `requestId` asked for
   *  (resolves with its agent-facing page id, `p…`). Call before asking the
   *  pane, and send the same id with the request. */
  watchNewTab(sessionId: string, requestId: string): NewTabWatch;
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
  /** A paired client's WebRTC live-view signal (shared/remote-webrtc.ts), with
   *  the ICE servers the service resolved for a `ready`. */
  remoteWebrtcSignal(clientId: string, signal: unknown, iceServers: unknown): Promise<void>;
  /** That client stopped streaming the source. */
  remoteWebrtcViewerLeft(clientId: string, sourceKey: string): void;
  /** The displays a screen source may show; absent until the screen source
   *  is wired into this host. */
  remoteScreenDisplays?(): RemoteScreenDisplaySummary[];
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
    /** Every page (guest) the host creates, as it appears. */
    onGuest?: (guest: WebContents) => void;
    /** One live frame of a remotely streamed session, handed to the service. */
    publishRemoteFrame?: (frame: DesktopRemoteBrowserStreamFrame) => Promise<void>;
    /** The main-workspace tab list changed, for watching paired clients. */
    publishRemoteTabs?: (tabs: DesktopRemoteBrowserTab[]) => Promise<void>;
    /** Profile-import progress, for the paired client that may have started it. */
    publishRemoteImportProgress?: (progress: DesktopBrowserImportProgress) => Promise<void>;
    /** Sign in with a saved login by itself (the `browserAutoSignIn` setting). */
    autoSignIn?: () => boolean;
    /** The WebRTC live view: a signal to one paired client, through the
     *  service, and where the sender renderer's page is. Absent: JPEG only. */
    remoteWebrtc?: {
      sendSignal(clientId: string, signal: RemoteWebrtcDesktopSignal): Promise<unknown>;
      senderPage: RemoteWebrtcSenderPage;
    };
  }
): BrowserHost {
  // Bound once the host exists; the streams' taps reach it through these.
  let webrtc: RemoteWebrtcHost | null = null;
  let disposeSender = (): void => undefined;
  const base = createBrowserHostFoundation(window, {
    remoteSession: options.remoteSession,
    onDiagnostic: options.onDiagnostic,
    requestApproval: options.requestApproval,
  });
  const { state, sessions, cdp, display, sendToRenderer } = base;
  const { lifecycle, nativeViews, fullscreen, taskLifecycle, retainGuest } = createBrowserHostPages({
    window,
    base,
    onSurfaceRequest: options.onSurfaceRequest,
    onGuest: options.onGuest,
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
  const newTabs = createNewTabWaiters();
  const shown = createBrowserHostPresentation({
    onTabCreated: newTabs.created,
    window,
    base,
    lifecycle,
    tools,
    retainGuest,
    chooseBrowserFiles: options.chooseBrowserFiles,
    publishRemoteFrame: options.publishRemoteFrame,
    publishRemoteTabs: options.publishRemoteTabs,
    remoteMedia: {
      geometryChanged: (sessionId, geometry) =>
        webrtc?.geometryChanged(remoteWebrtcSourceKey({ kind: 'browser', sessionId }), geometry),
      captured: (sessionId, picture) => webrtc?.frame(remoteWebrtcSourceKey({ kind: 'browser', sessionId }), picture),
    },
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
    autoSignInEnabled: options.autoSignIn,
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

  // The page a takeover hands over, never merely the panel's selected tab.
  const handedOver = createHandedOverPage({
    resolveTab: (sessionId, tab) => shown.tabs.resolveTargetGuest(sessionId, false, tab)?.guest ?? null,
    agentPage: (sessionId) => sessions.agentPage(sessionId),
    liveGuest: (sessionId) => sessions.liveGuest(sessionId),
    owns: (sessionId, guest) => sessions.sessionIdForGuest(guest) === sessionId,
    selectGuest: (sessionId, guest) => sessions.selectGuest(sessionId, guest),
    setAgentPage: (sessionId, guest, turn) => sessions.setAgentPage(sessionId, guest, turn),
    resumeAgentFollow: (sessionId) => sessions.resumeAgentFollow(sessionId),
  });

  const browserHost: BrowserHost = {
    ...createBrowserHostDisplayMethods({
      sessions,
      presentationReads: shown.presentationReads,
      pageSurface: shown.pageSurface,
      remoteDrive: shown.remoteDrive,
      nativeViews,
      fullscreen,
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
    watchNewTab: newTabs.watch,
    remoteWebrtcSignal: async (clientId, signal, iceServers) => {
      if (!webrtc) throw new Error('Remote WebRTC is unavailable.');
      await webrtc.signal(clientId, signal, iceServers);
    },
    remoteWebrtcViewerLeft: (clientId, sourceKey) => webrtc?.viewerLeft(clientId, sourceKey),
    browserPanelShown: (sessionId, shown, sender, pane) => lifecycle.panelShown(sessionId, shown, sender, pane),
    captureTakeoverPage: (sessionId, id, tab) => {
      handedOver.capture(sessionId, id, tab);
    },
    endTakeoverPage: (sessionId, current) => handedOver.end(sessionId, current),
    openForTakeover: (sessionId, id) => {
      // The request names the handed-over page (never a guessed tab), so a
      // child session's takeover opens it in the delegating conversation.
      const guest = handedOver.show(sessionId, id);
      lifecycle.requestBrowserSurface(
        sessionId,
        'handoff',
        takeoverRevealDetail(guest, (page) => state.pageId(page))
      );
    },
    reloadAfterSignIn: (sessionId, id) => {
      // Only the handed-over page; gone, nothing reloads in its place.
      const guest = handedOver.page(sessionId, id);
      return reloadPageAfterSignIn(guest, guest ? state.peek(guest) : undefined);
    },
    ...createBrowserProfileHostMethods({
      profileImporter: base.profileImporter,
      signIns: base.signIns,
      vault: base.vault,
      linkedSignIns: base.linkedSignInStore,
      liveGuest: (sessionId) => sessions.liveGuest(sessionId),
      fillCredentialInGuest: (guest, credential, signal, boundUrl) =>
        tools.credentialFill.fillCredentialInGuest(guest, credential, signal, boundUrl),
      fillBoundLogin: agent.loginFill,
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
  if (options.remoteWebrtc) {
    const sender = createRemoteWebrtcSenderWindow(options.remoteWebrtc.senderPage);
    disposeSender = () => sender.dispose();
    webrtc = createRemoteWebrtcHost({
      sender,
      sendSignal: options.remoteWebrtc.sendSignal,
      // A browser source is a session a paired client streams now; its input
      // takes the relay's own page-input path (document guard, serialized).
      sources: (source) => {
        if (source.kind !== 'browser') return null;
        const sessionId = source.sessionId;
        if (!shown.remote.streamedPage(sessionId)) return null;
        return {
          source,
          start: () => undefined,
          stop: () => undefined,
          page: () => shown.remote.streamedPage(sessionId) ?? { documentId: null, geometry: null },
          dispatch: async (control) => {
            if (!isRemoteWebrtcPageInput(control)) throw new TypeError('A browser source takes page input only.');
            await browserHost.remoteBrowserControl(sessionId, control);
          },
          resize: (request) => shown.remote.resize(sessionId, request),
          videoLimit: (limit) => shown.remote.widenVideo(sessionId, limit),
        };
      },
      report: (event, data) => options.onDiagnostic?.(`remote-webrtc-${event}`, data),
    });
  }
  // A released session or a disposed host never creates the tabs still asked for.
  const { releaseSession, dispose } = browserHost;
  browserHost.releaseSession = (sessionId, releaseOptions) => {
    newTabs.cancelSession(sessionId);
    handedOver.forget(sessionId);
    releaseSession(sessionId, releaseOptions);
  };
  browserHost.dispose = () => {
    newTabs.cancelAll();
    handedOver.dispose();
    webrtc?.dispose();
    disposeSender();
    return dispose();
  };
  return browserHost;
}
