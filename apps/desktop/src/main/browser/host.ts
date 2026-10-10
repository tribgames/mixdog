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
import type { WebContents } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateBrowserToolArgs } from '../../../../../src/runtime/browser-bridge/action-schema.mjs';
import { app, type BrowserWindow, dialog, screen, sharedTexture, webContents } from 'electron';

import {
  DESKTOP_IPC,
  MAIN_BROWSER_PAGE_PREFIX,
  type DesktopBrowserImportProgress,
  type DesktopRemoteBrowserTab,
  type DesktopBrowserViewportConfig,
  type DesktopBrowserPageFrame,
  type DesktopBrowserPageResample,
  type DesktopBrowserPageControl,
  type DesktopRemoteBrowserControl,
  type DesktopBrowserOpenRequest,
  type DesktopRemoteBrowserStreamFrame,
  type DesktopRemoteBrowserStreamOptions,
} from '../../shared/contract';
import { createBrowserActionApproval, type BrowserApprovalRequest } from './action-approval';
import { requestBrowserApproval } from './approval-dialog';
import type { BrowserActionServices } from './actions';
import { createBrowserCommandRunner } from './command-runner';
import { createBrowserTaskLifecycle } from './task-lifecycle';
import { bridgeDiscoveryDirectory } from '../bridge/discovery-file';
import { BrowserBridgeServer } from './bridge-server';
import { createBrowserGuestCdp } from './cdp';
import { createBrowserCookieJar } from './cookie-jar';
import {
  ACTION_SETTLE_DOM_TIMEOUT_MS,
  ACTION_SETTLE_LOAD_TIMEOUT_MS,
  ACTION_SETTLE_QUIET_MS,
  BACKGROUND_RECLAIM_INTERVAL_MS,
  type BrowserCommand,
  COMMAND_TIMEOUT_MS,
  CUSTOM_DROPDOWN_POLL_MS,
  CUSTOM_DROPDOWN_TIMEOUT_MS,
  DOWNLOAD_ATTACH_MAX_BYTES,
  READ_MAX_CHARS,
  READ_ONLY_ACTIONS,
  SCREENSHOT_FALLBACK_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  SNAPSHOT_MAX_ELEMENTS,
  snapshotTextLimit,
} from './command';
import { createBrowserCommandQueue } from './command-queue';
import { createBrowserPresentationReads } from './presentation-reads';
import { type BrowserCredentialFillResult, createBrowserCredentialFill } from './credential-autofill';
import { DIALOG_BRIDGE_UNINSTALL_SCRIPT } from './dialog-bridge';
import { createBrowserDialogReport } from './dialog-report';
import { createBrowserDocuments } from './documents';
import { createBrowserDownloads } from './downloads';
import { createBrowserEmulation } from './emulation';
import { browserSharedTextureRendering, createBrowserGuestLifecycle } from './guest-lifecycle';
import { browserDocumentId, BrowserGuestStateStore } from './guest-state';
import { createBrowserInitScripts } from './init-scripts';
import { createBrowserInputDriver } from './input';
import { createBrowserIntercept } from './intercept';
import { createBrowserNetworkReports } from './network-report';
import { createBrowserPageState } from './page-state';
import { createBrowserPageSurface } from './page-surface';
import { createBrowserLocalPrompts } from './local-prompts';
import {
  BROWSER_INPUT_WAIT_MS,
  browserInputImmediate,
  browserInputPresentation,
  browserTypingInput,
} from '../../shared/browser-input-policy';
import { createBrowserDisplayCapture } from './display-capture';
import { browserFramePixels } from './frame-pixels';
import { createBrowserDisplayTextures } from './display-textures';
import { createBrowserPartition } from './partition';
import { createBrowserPerformanceCommands } from './performance';
import {
  BrowserProfileImportService,
  defaultNativeBrowserImporterPath,
  type BrowserCredentialSuggestion,
  type BrowserHistoryEntry,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserImportSource,
} from './profile-import';
import { createBrowserRefActions } from './ref-actions';
import { redactBrowserText } from './redaction';
import { createBrowserRefPoints } from './ref-points';
import { createBrowserRemoteControl } from './remote-control';
import { createBrowserRemoteTabs } from './remote-tabs';
import { createPageInputDispatcher } from './page-surface-control';
import { createBrowserReply } from './reply';
import { createBrowserScreenshotService } from './screenshot';
import { createBrowserVisualPrivacy } from './visual-privacy';
import { BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID, browserSessionId } from './session-registry';
import { createBrowserSettle, pause } from './settle';
import { createBrowserSessionStore } from './browser-session-store';
import { createBrowserSnapshotCapture } from './snapshot-capture';
import { createBrowserTabs } from './tabs';
import { createBrowserTargetResolver } from './target-resolve';
import { createBrowserUrlAdmission } from './url-admission';
import { browserPageGuardScripts } from './webrtc-guard';
import type { BrowserUrlPolicy } from './url-policy';
import { createBrowserInputDispatch } from './input-dispatch';
import { createBrowserNativeViews, type BrowserNativeRect } from './native-view';
import { browserPageWindow } from './page-window';
import { createBrowserPagePower, reclaimIdleUserSessions } from './page-power';

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
  browserPageControl(sessionId: string, input: DesktopBrowserPageControl): Promise<void>;
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
  /** Start/renew (options) or stop (null) streaming a session's live frames. */
  remoteBrowserStream(sessionId: string, options: DesktopRemoteBrowserStreamOptions | null): Promise<void>;
  remoteBrowserControl(sessionId: string, input: DesktopRemoteBrowserControl): Promise<void>;
  /** The main-workspace browser tabs a paired client may switch between. */
  remoteTabs(): DesktopRemoteBrowserTab[];
  /** Start/stop publishing tab changes; returns the current list. */
  remoteTabsWatch(on: boolean): DesktopRemoteBrowserTab[];
  /** Open a new main-workspace tab on `url`. */
  remoteTabOpen(url: string): Promise<DesktopRemoteBrowserTab>;
  dispose(): Promise<void>;
}

function browserUrlPolicyFromEnvironment(): BrowserUrlPolicy {
  return {
    allowPrivateNetwork: /^(?:1|true|yes)$/i.test(String(process.env.MIXDOG_BROWSER_ALLOW_PRIVATE_NETWORK || '')),
    allowedDomains: String(process.env.MIXDOG_BROWSER_ALLOWED_DOMAINS || '')
      .split(',')
      .map((domain) => domain.trim())
      .filter(Boolean),
  };
}

/** A fixed pane viewport becomes a full emulation command; a cleared one resets
 *  emulation so the guest goes back to following the pane's own size. */
function browserViewportEmulation(config: DesktopBrowserViewportConfig): BrowserCommand {
  const fixedViewport =
    config.width !== null && config.height !== null ? { width: config.width, height: config.height } : null;
  const orientation = fixedViewport && fixedViewport.width > fixedViewport.height ? 'landscape' : 'portrait';
  return {
    action: 'emulate',
    reset: true,
    ...(fixedViewport
      ? {
          ...fixedViewport,
          deviceScaleFactor: config.deviceScaleFactor,
          mobile: config.mobile,
          touch: config.touch,
          userAgent: config.userAgent ?? '',
          orientation,
        }
      : {}),
  };
}

/** A task cleanup context must name a session and a real turn, and carry
 *  nothing beyond its abort flag. */
function assertBrowserTaskCleanupContext(sessionId: unknown, turnId: unknown, input: Record<string, unknown>): void {
  if (
    !sessionId ||
    !Number.isSafeInteger(turnId) ||
    Number(turnId) <= 0 ||
    Object.keys(input).some((key) => key !== 'action' && key !== 'aborted')
  ) {
    throw new Error('Invalid browser task cleanup context.');
  }
}

/** Everything still running for one session — queued commands and in-flight
 *  reads — which a turn's cleanup waits out before closing its pages. */
function pendingSessionWork(
  prefix: string,
  chains: Map<string, Promise<unknown>>,
  reads: Map<string, Set<Promise<unknown>>>
): Promise<unknown>[] {
  return [
    ...[...chains].filter(([key]) => key.startsWith(prefix)).map(([, task]) => task),
    ...[...reads].filter(([key]) => key.startsWith(prefix)).flatMap(([, tasks]) => [...tasks]),
  ];
}

/** How a queued human input competes with agent commands: releases must still
 *  finish an already-sent press, even after a slow command. Typing retains its
 *  order behind that input; only pointer gestures expire while queued. */
function browserLocalInputOptions(input: DesktopBrowserPageControl): {
  takeover: boolean;
  dropIfBusy?: boolean;
  held?: boolean;
  maxWaitMs?: number;
} {
  const release = input.type === 'pointer' && input.phase === 'mouseReleased';
  const hover = input.type === 'pointer' && input.phase === 'mouseMoved' && input.buttons === 0;
  return {
    takeover: !hover,
    dropIfBusy: hover,
    ...(input.type === 'pointer' && input.phase !== 'mouseMoved' ? { held: !release } : {}),
    maxWaitMs: release || browserTypingInput(input) ? undefined : BROWSER_INPUT_WAIT_MS,
  };
}

/** Chromium keeps persistent cookies and localStorage for the partition on
 *  its own; session cookies — most sign-ins — die with the process unless
 *  the host carries them across a restart itself. */
function createBrowserRestartState(
  cookieJar: ReturnType<typeof createBrowserCookieJar>,
  onDiagnostic?: (event: string, data: Record<string, unknown>) => void
) {
  const sessionStore = createBrowserSessionStore({
    cookies: cookieJar,
    directory: join(app.getPath('userData'), 'browser-state'),
  });
  void sessionStore.restore().catch((error) => {
    onDiagnostic?.('browser-session-restore-failed', {
      error: redactBrowserText((error as Error).message || String(error)),
    });
  });
  return { sessionStore, stopSessionAutosave: sessionStore.startAutosave() };
}

export function createBrowserHost(
  window: BrowserWindow,
  options: {
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
  } = {}
): BrowserHost {
  const state = new BrowserGuestStateStore();
  const approvals = createBrowserActionApproval({
    ask: options.requestApproval || ((request, signal) => requestBrowserApproval(window, request, signal)),
    confirmActions: process.env.MIXDOG_BROWSER_CONFIRM_ACTIONS,
    denyActions: process.env.MIXDOG_BROWSER_DENY_ACTIONS,
  });
  const browserSessions = new BrowserSessionRegistry();
  let backgroundReclaimTimer: NodeJS.Timeout | null = null;
  let disposed = false;
  let bridgeWanted = false;
  let bridgeStartedAt = 0;
  /** Foreground gestures serialize together; named background pages get their
   *  own queues so independent research tabs can actually run concurrently. */
  const commandChains = new Map<string, Promise<unknown>>();
  const isBackgroundBusy = (sessionId: string, name: string) =>
    commandChains.has(`session:${sessionId}:background:${name}`);
  /** Read-only commands observe without changing the page, so they run
   *  together; a write waits for the previous write AND every in-flight read. */
  const pendingReads = new Map<string, Set<Promise<unknown>>>();
  /** The single edge to the display client: a window already torn down simply
   *  stops hearing about browser state, and never fails the work reporting it. */
  const sendToRenderer = (channel: string, ...args: unknown[]): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, ...args);
  };

  const browserUrlPolicy = browserUrlPolicyFromEnvironment();
  const urls = createBrowserUrlAdmission({ policy: browserUrlPolicy });
  const nativeView = /^(?:1|true|yes)$/i.test(String(process.env.MIXDOG_BROWSER_NATIVE_VIEW || ''));

  const partition = createBrowserPartition({
    assertResolvedResourceUrlAllowed: urls.assertResolvedResourceUrlAllowed,
    downloadsDirectory: () => app.getPath('downloads'),
    sessionIdForGuest: (guest) => browserSessions.sessionIdForGuest(guest),
    defaultSessionId: DEFAULT_BROWSER_SESSION_ID,
    onRequestRefused: (webContentsId, url, reason) => {
      const guest = webContentsId === undefined ? null : webContents.fromId(webContentsId);
      if (guest) state.recordRefusedRequest(guest, url, reason);
    },
  });
  const { session: partitionSession, downloadLedger } = partition;
  const cookieJar = createBrowserCookieJar(partitionSession);
  const { sessionStore, stopSessionAutosave } = createBrowserRestartState(cookieJar, options.onDiagnostic);
  const profileImporter = new BrowserProfileImportService({
    userDataDirectory: app.getPath('userData'),
    temporaryDirectory: app.getPath('temp'),
    partition: partitionSession,
    cookieJar,
    nativeImporterPath: defaultNativeBrowserImporterPath(),
  });

  const intercept = createBrowserIntercept();
  const cdp = createBrowserGuestCdp({
    state,
    interceptFetchPatterns: intercept.interceptFetchPatterns,
    matchInterceptRule: intercept.matchInterceptRule,
    pageGuardScripts: () => browserPageGuardScripts(browserUrlPolicy),
  });
  const diagnosticsFor = (guest: WebContents) => state.for(guest);
  const documents = createBrowserDocuments({
    cdp,
    sessions: (guest) => state.for(guest).cdpSessions,
  });
  const settle = createBrowserSettle({
    diagnostics: diagnosticsFor,
    evaluate: cdp.evaluate,
    renderCheckpoint: documents.renderCheckpoint,
    pageText: documents.pageText,
    quietMs: ACTION_SETTLE_QUIET_MS,
    domTimeoutMs: ACTION_SETTLE_DOM_TIMEOUT_MS,
    loadTimeoutMs: ACTION_SETTLE_LOAD_TIMEOUT_MS,
  });
  const displayTextures = createBrowserDisplayTextures({
    document: (guest) => browserDocumentId(state, guest),
    importTexture: (texture, released) =>
      sharedTexture.importSharedTexture({
        textureInfo: texture.textureInfo,
        allReferencesReleased: released,
      }),
    send: (texture, sessionId, id) =>
      sharedTexture.sendSharedTexture(
        {
          frame: window.webContents.mainFrame,
          importedSharedTexture: texture,
        },
        sessionId,
        id
      ),
  });
  // What displays a page: a mounted panel (reported per guest), a natively
  // presented view, or a remote viewer streaming the session's current page.
  const panelActiveGuests = new Set<WebContents>();
  const nativeShownGuests = new Map<string, WebContents>();
  const remoteViewingSessions = new Set<string>();
  const pagePower = createBrowserPagePower<WebContents>({
    isDisplayed: (guest) => {
      if (panelActiveGuests.has(guest)) return true;
      if ([...nativeShownGuests.values()].includes(guest)) return true;
      const owner = browserSessions.sessionIdForGuest(guest);
      return owner !== undefined && remoteViewingSessions.has(owner) && browserSessions.currentGuest(owner) === guest;
    },
  });
  const refreshSessionPower = (sessionId: string) => {
    for (const guest of browserSessions.visibleGuests(sessionId)) pagePower.refresh(guest);
    for (const page of browserSessions.backgroundPages(sessionId).values()) pagePower.refresh(page.guest);
  };
  const lifecycle = createBrowserGuestLifecycle({
    window,
    partitionSession,
    state,
    sessions: browserSessions,
    cdp,
    urlPolicy: browserUrlPolicy,
    bridgeWanted: () => bridgeWanted,
    isBackgroundBusy,
    waitForLoadSettle: settle.waitForLoadSettle,
    onPopup: (opener, popup) => taskLifecycle.inherit(opener, popup),
    onGuest: (guest) => {
      pagePower.track(guest);
      guest.once('destroyed', () => panelActiveGuests.delete(guest));
      displayTextures.attach(guest);
      nativeViews?.watch(guest);
    },
    onSurfaceRequest: (request) => {
      if (request.hide || request.reveal === true) options.onSurfaceRequest?.(request);
    },
    nativeView,
  });
  const nativeViews = nativeView
    ? createBrowserNativeViews({
        shell: window,
        currentGuest: (sessionId) => browserSessions.currentGuest(sessionId),
        // Native input bypasses browserPageControl, so it takes over from the
        // agent here, exactly as a relayed local gesture would.
        humanInput: (guest) => {
          if (guest.isDestroyed()) return;
          const owner = browserSessions.sessionIdForGuest(guest) ?? DEFAULT_BROWSER_SESSION_ID;
          retainGuest(guest);
          interruptForLocal({ action: 'remote_control', session_id: owner, tab: state.pageId(guest) });
        },
      })
    : null;
  const taskLifecycle = createBrowserTaskLifecycle<WebContents>({
    current: (sessionId) => browserSessions.currentGuest(sessionId),
    select: (sessionId, guest) => browserSessions.selectGuest(sessionId, guest),
    close: (guest) => browserPageWindow(guest)?.destroy(),
    canClose: (guest) => !state.for(guest).pendingDialog,
    preserve: (guest) => {
      const owner = browserSessions.sessionIdForGuest(guest);
      const page = owner ? browserSessions.backgroundPageForGuest(owner, guest) : undefined;
      if (page) page.keepAlive = true;
    },
    surface: (sessionId, request) => sendToRenderer(DESKTOP_IPC.browserOpenRequested, { sessionId, ...request }),
  });
  const retainGuest = taskLifecycle.retain;
  const dispatchInput = createBrowserInputDispatch({
    cdp,
    documentId: (guest) => browserDocumentId(state, guest),
    frames: (guest) => state.for(guest).cdpSessions,
    frameOffset: (guest, sessionId, signal) => snapshots.frameOffsetForSession(guest, sessionId, signal),
  });
  const input = createBrowserInputDriver(dispatchInput, {
    drags: {
      slots: {
        for: (guest) => state.for(guest),
        peek: (guest) => state.peek(guest),
      },
      evaluate: (guest, expression, signal) => cdp.evaluate(guest, expression, signal),
    },
  });
  const agentScreenshots = createBrowserScreenshotService(
    cdp,
    SCREENSHOT_TIMEOUT_MS,
    SCREENSHOT_FALLBACK_TIMEOUT_MS,
    createBrowserVisualPrivacy({ state, documents })
  );
  const snapshots = createBrowserSnapshotCapture({
    evaluate: cdp.evaluate,
    cdp,
    diagnostics: diagnosticsFor,
    snapshotTextLimit,
    nextSnapshotId: (guest) => state.nextSnapshotId(guest),
    documentGeneration: (guest) => state.for(guest).documentGeneration,
    revision: documents.revision,
    accessibilityRefs: state.slot('accessibilityRefs'),
    refSets: state.slot('refSet'),
    visualGrounding: state.slot('visualGrounding'),
    maxElements: SNAPSHOT_MAX_ELEMENTS,
  });
  const refPoints = createBrowserRefPoints({
    callAccessibilityRef: snapshots.callAccessibilityRef,
    evaluate: cdp.evaluate,
    cdp,
    frameOffsetForSession: snapshots.frameOffsetForSession,
    captureSnapshotPayload: snapshots.captureSnapshotPayload,
    diagnostics: diagnosticsFor,
    accessibilityRefs: state.slot('accessibilityRefs'),
    visualGrounding: state.slot('visualGrounding'),
    revision: documents.revision,
    frames: (guest) => state.for(guest).cdpSessions,
  });
  const reply = createBrowserReply({
    state,
    settleAfterAction: settle.settleAfterAction,
    postconditionMatchesGuest: settle.postconditionMatchesGuest,
    captureSnapshotPayload: snapshots.captureSnapshotPayload,
    captureScreenshot: agentScreenshots.capture,
    bindVisualGrounding: refPoints.bindVisualGrounding,
    downloadsForGuest: (guest) =>
      downloadLedger.downloadsForSession(browserSessions.sessionIdForGuest(guest) ?? DEFAULT_BROWSER_SESSION_ID),
  });
  const refActions = createBrowserRefActions({
    rememberSecret: (guest, value) => {
      state.rememberSecret(guest, value);
    },
    accessibilityRefs: (guest) => state.peek(guest)?.accessibilityRefs,
    callAccessibilityRef: snapshots.callAccessibilityRef,
    evaluate: cdp.evaluate,
    evaluateInFrames: documents.collect,
    cdp,
    resolveRefPoint: refPoints.resolveRefPoint,
    input,
    pause,
    pendingFileChooser: (guest) => state.for(guest).pendingFileChooser,
    clearFileChooser: (guest) => {
      state.for(guest).pendingFileChooser = null;
    },
    dropdownTimeoutMs: CUSTOM_DROPDOWN_TIMEOUT_MS,
    dropdownPollMs: CUSTOM_DROPDOWN_POLL_MS,
  });
  const dialogs = createBrowserDialogReport({
    diagnostics: diagnosticsFor,
    cdp,
    pageId: (guest) => state.pageId(guest),
  });
  const downloads = createBrowserDownloads({
    downloads: downloadLedger.downloadsForSession,
    pause,
    attachMaxBytes: DOWNLOAD_ATTACH_MAX_BYTES,
  });
  const network = createBrowserNetworkReports({
    ledgerFor: (guest) => state.for(guest).network,
    cdp,
    maxBodyChars: READ_MAX_CHARS,
  });
  const performance = createBrowserPerformanceCommands({
    cdp,
    tracesByGuest: state.slot('performanceTrace'),
    settleAfterAction: settle.settleAfterAction,
    pause,
    traceDirectory: () => join(app.getPath('userData'), 'browser-traces'),
    redactText: (guest, value) => state.redactText(guest, value),
    processMemoryMb: (guest) => {
      if (guest.isDestroyed()) return undefined;
      const pid = guest.getOSProcessId();
      const metrics = app.getAppMetrics().find((entry) => entry.pid === pid);
      const workingSetKb = metrics?.memory?.workingSetSize;
      return Number.isFinite(Number(workingSetKb)) ? Number(workingSetKb) / 1024 : undefined;
    },
  });
  const initScripts = createBrowserInitScripts({ cdp });
  const emulation = createBrowserEmulation({
    cdp,
    invalidateInteractionState: (guest) => state.invalidateInteraction(guest),
    snapshotResult: reply.snapshotResult,
    // The pane hears every emulated metrics change and frames the guest at
    // that size; resizing only the page would leave it drawn top-left inside
    // a larger responsive box.
    onViewportChanged: (guest, viewport) => {
      const sessionId = browserSessions.sessionIdForGuest(guest);
      // Only the selected page may reframe the pane, including a selected popup.
      if (!sessionId || browserSessions.currentGuest(sessionId) !== guest) return;
      sendToRenderer(DESKTOP_IPC.browserGuestViewportChanged, {
        sessionId,
        webContentsId: guest.id,
        viewport,
      });
    },
    beginViewportChange: (guest) => pageSurface.beginViewportChange(guest),
  });
  const pageState = createBrowserPageState({
    partitionSession,
    urlPolicy: () => browserUrlPolicy,
    evaluate: cdp.evaluate,
    invalidateInteractionState: (guest) => state.invalidateInteraction(guest),
    formatEvaluationValue: reply.formatEvaluationValue,
  });
  const credentialFill = createBrowserCredentialFill({
    cdp,
    rememberSecret: (guest, secret) => state.rememberSecret(guest, secret),
    forgetSecret: (guest, secret) => state.forgetSecret(guest, secret),
    redactText: (guest, value) => state.redactText(guest, value),
  });
  const remote = createBrowserRemoteControl({
    state,
    cdp,
    urlPolicy: browserUrlPolicy,
    ensureGuest: lifecycle.ensureGuest,
    currentGuest: (sessionId) => browserSessions.currentGuest(sessionId) ?? null,
    viewerChanged: (sessionId, active) => {
      // Lease expiry ends a stream without remoteBrowserStream(null), so the
      // power classification follows the stream lifecycle itself.
      if (active) remoteViewingSessions.add(sessionId);
      else remoteViewingSessions.delete(sessionId);
      refreshSessionPower(sessionId);
      sendToRenderer(DESKTOP_IPC.browserRemoteViewerChanged, { sessionId, active });
    },
    onUserControl: retainGuest,
    assertResolvedUrlAllowed: urls.assertResolvedUrlAllowed,
    dispatchPageInput: createPageInputDispatcher({
      state,
      cdp,
      dispatchInput,
      urlPolicy: browserUrlPolicy,
      assertUrl: urls.assertResolvedUrlAllowed,
    }),
    publishFrame: (frame) => options.publishRemoteFrame?.(frame) ?? Promise.resolve(),
  });
  const remoteTabs = createBrowserRemoteTabs({
    sessionIds: () => browserSessions.sessionIds(),
    liveGuest: (sessionId) => browserSessions.liveGuest(sessionId),
    publish: (tabs) => options.publishRemoteTabs?.(tabs) ?? Promise.resolve(),
  });
  // Fixed at startup: the live acceleration flag can flip after a GPU-crash
  // fallback while the capture path and window options do not.
  const sharedTextureRendering = browserSharedTextureRendering();
  const displayCapture = createBrowserDisplayCapture(sharedTextureRendering);
  const pageSurface = createBrowserPageSurface({
    ensureGuest: lifecycle.ensureGuest,
    currentGuest: (sessionId) => browserSessions.currentGuest(sessionId),
    tabs: {
      list: (sessionId) => tabs.displayTabs(sessionId),
      select: (sessionId, tabId) => {
        tabs.selectDisplayTab(sessionId, tabId);
        const guest = browserSessions.currentGuest(sessionId);
        if (guest) retainGuest(guest);
      },
      create: (sessionId) => tabs.createDisplayTab(sessionId),
      close: (sessionId, tabId) => tabs.closeDisplayTab(sessionId, tabId),
    },
    state,
    cdp,
    dispatchInput,
    urlPolicy: browserUrlPolicy,
    prompts: createBrowserLocalPrompts({
      state,
      dialogs,
      uploads: refActions,
      chooseFiles:
        options.chooseBrowserFiles ??
        ((multiple) =>
          dialog.showOpenDialog(window, {
            properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
          })),
    }),
    assertUrl: urls.assertResolvedUrlAllowed,
    capture: (guest, geometryKey, pixels, signal) =>
      cdp.bounded(displayCapture(guest, geometryKey, pixels), 2000, 'Browser display capture', signal),
    captureTexture: (guest, documentId, pixels) =>
      displayTextures.acquire(guest, documentId, pixels.width, pixels.height),
    resize: (guest, width, height) => {
      const owner = browserPageWindow(guest);
      if (!owner) return null;
      owner.setContentSize(width, height);
      const [landedWidth, landedHeight] = owner.getContentSize();
      return { width: landedWidth, height: landedHeight };
    },
    viewport: (guest) => {
      const owner = browserPageWindow(guest);
      if (!owner || guest.isDestroyed()) {
        throw new Error('Browser page changed during capture.');
      }
      const [width, height] = owner.getContentSize();
      const pixels = browserFramePixels(owner, guest.isOffscreen(), sharedTextureRendering, screen);
      return { width, height, zoom: guest.getZoomFactor(), pixels };
    },
  });
  let primaryScale = screen.getPrimaryDisplay().scaleFactor;
  const followPrimaryScale = () => {
    const scale = screen.getPrimaryDisplay().scaleFactor;
    if (scale === primaryScale) return;
    primaryScale = scale;
    try {
      pageSurface.refreshScale();
    } catch (error) {
      // A screen event must not become an uncaught main-process exception;
      // report the first failure through diagnostics.
      if (scaleRefreshFailureReported) return;
      scaleRefreshFailureReported = true;
      options.onDiagnostic?.('browser-scale-refresh-failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
  let scaleRefreshFailureReported = false;
  screen.on('display-metrics-changed', followPrimaryScale);
  screen.on('display-added', followPrimaryScale);
  screen.on('display-removed', followPrimaryScale);
  const presentationReads = createBrowserPresentationReads({
    capture: (owner, signal, texture) => pageSurface.frame(owner, '', signal, texture),
    bounded: cdp.bounded,
  });
  const targets = createBrowserTargetResolver({
    captureSnapshotPayload: snapshots.captureSnapshotPayload,
    state,
    cdp,
    evaluate: cdp.evaluate,
  });
  const tabs = createBrowserTabs({
    visibleGuests: (sessionId) => browserSessions.visibleGuests(sessionId),
    backgroundPages: (sessionId) => browserSessions.backgroundPages(sessionId),
    backgroundEntryByPageId: lifecycle.backgroundEntryByPageId,
    ensureOffscreen: lifecycle.ensureOffscreen,
    destroyBackgroundPage: lifecycle.destroyBackgroundPage,
    pageId: (guest) => state.pageId(guest),
    currentGuest: (sessionId) => browserSessions.currentGuest(sessionId),
    selectGuest: (sessionId, guest) => browserSessions.selectGuest(sessionId, guest),
    closeGuest: (guest) => browserPageWindow(guest)?.close(),
  });

  const services: BrowserActionServices = {
    documents,
    state,
    cdp,
    reply,
    settle,
    input,
    refActions,
    refPoints,
    snapshots,
    screenshots: agentScreenshots,
    emulation,
    pageState,
    performance,
    intercept,
    initScripts,
    network,
    dialogs,
    urls,
    targets,
    credentials: {
      fillStored: (guest, account, signal) => {
        signal?.throwIfAborted();
        const url = guest.getURL();
        return profileImporter.useCredentialByAccount(
          url,
          account,
          (credential) => {
            signal?.throwIfAborted();
            if (guest.isDestroyed() || guest.getURL() !== url) {
              throw new Error('The page changed before stored credential input; input was not sent.');
            }
            return credentialFill.fillCredentialInGuest(guest, credential, signal);
          },
          signal
        );
      },
    },
    downloadsForSession: downloadLedger.downloadsForSession,
    runCommand: (command, signal) => runCommand(command, signal),
  };

  const runCommand = createBrowserCommandRunner({
    state,
    approvals,
    browserSessions,
    lifecycle,
    tabs,
    downloads,
    taskLifecycle,
    retainGuest,
    drivePage: pagePower.drive,
    services,
  });

  const { executeSerialized, executeLocal, releaseLocal, interruptForLocal, holdLocal } = createBrowserCommandQueue({
    chains: commandChains,
    pendingReads,
    sessionId: (command) => browserSessionId(command.session_id),
    currentPageId: (sessionId) => {
      const guest = browserSessions.currentGuest(sessionId);
      return guest && !guest.isDestroyed() ? state.pageId(guest) : undefined;
    },
    backgroundEntryByPageId: lifecycle.backgroundEntryByPageId,
    run: runCommand,
    bounded: cdp.bounded,
    readOnlyActions: READ_ONLY_ACTIONS,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  });

  // Loopback command server + discovery file — the pair that exposes the
  // runtime's `browser` tool. Opt-in via Settings, mirroring Computer Use;
  // the pane infrastructure above runs regardless of the toggle.
  const bridgeServer = new BrowserBridgeServer<BrowserCommand>({
    dataDirectory: bridgeDiscoveryDirectory,
    execute: (command, signal) => {
      const { session_id, turn_id, internalStep, ...input } = command;
      if (internalStep !== undefined) throw new Error('internalStep is not a bridge input');
      // Runtime-only lifecycle message: deliberately absent from tool schemas.
      if (command.action === 'finish_turn') {
        const owner = browserSessionId(session_id);
        assertBrowserTaskCleanupContext(session_id, turn_id, input as Record<string, unknown>);
        const aborted = (input as Record<string, unknown>).aborted === true;
        const pending = pendingSessionWork(`session:${owner}:`, commandChains, pendingReads);
        return Promise.allSettled(pending).then(() => ({
          text: `Browser task cleanup complete: ${taskLifecycle.finish(owner, Number(turn_id), { aborted })} temporary page(s) closed.`,
        }));
      }
      const validated = validateBrowserToolArgs(input);
      if (!validated.ok) throw new Error(validated.error);
      return executeSerialized({ ...validated.input, action: validated.action, session_id, turn_id }, signal);
    },
    redactError: redactBrowserText,
    onReady: () => {
      options.onDiagnostic?.('browser-bridge-ready', {
        durationMs: bridgeStartedAt > 0 ? Date.now() - bridgeStartedAt : 0,
      });
      backgroundReclaimTimer = setInterval(
        () => lifecycle.reclaimIdleBackgroundPages(),
        BACKGROUND_RECLAIM_INTERVAL_MS
      );
      backgroundReclaimTimer.unref?.();
    },
    onInactive: () => {
      if (backgroundReclaimTimer) clearInterval(backgroundReclaimTimer);
      backgroundReclaimTimer = null;
    },
  });

  function startBridge(): void {
    if (disposed) return;
    bridgeStartedAt = Date.now();
    options.onDiagnostic?.('browser-bridge-start', {});
    for (const guest of browserSessions.visibleGuests()) {
      lifecycle.attachDebuggerEagerly(guest);
    }
    bridgeServer.start();
  }

  async function stopBridge(): Promise<void> {
    await bridgeServer.stop();
    commandChains.clear();
    pendingReads.clear();
    for (const guest of browserSessions.visibleGuests()) {
      await cdp.detach(guest, { uninstallScript: DIALOG_BRIDGE_UNINSTALL_SCRIPT });
    }
    // Agent-only surfaces die with the bridge; visible pane tabs belong to
    // the user and stay open.
    lifecycle.destroyAllBackgroundPages();
  }

  // Pages nobody displays or drives for long are unloaded (URLs kept) and
  // restore when the panel or an agent command returns.
  const userReclaimTimer = setInterval(
    () =>
      reclaimIdleUserSessions({
        sessions: browserSessions,
        power: pagePower,
        isBackgroundBusy,
        unload: (sessionId) => browserHost.releaseSession(sessionId, { restore: true }),
      }),
    BACKGROUND_RECLAIM_INTERVAL_MS
  );
  userReclaimTimer.unref?.();

  const browserHost: BrowserHost = {
    browserPageFrame(sessionId, previousFrameId = '', texture = false) {
      const owner = browserSessionId(sessionId);
      return presentationReads.read(owner, previousFrameId, texture);
    },
    browserPageMetadata(sessionId) {
      return pageSurface.metadata(browserSessionId(sessionId));
    },
    browserPresentNative(sessionId, rect) {
      if (!nativeViews) return { enabled: false, shown: false };
      const owner = browserSessionId(sessionId);
      const shown = nativeViews.present(owner, rect);
      const guest = shown ? browserSessions.currentGuest(owner) : null;
      if (guest) nativeShownGuests.set(owner, guest);
      else nativeShownGuests.delete(owner);
      refreshSessionPower(owner);
      return { enabled: true, shown };
    },
    browserPageControl(sessionId, input) {
      const owner = browserSessionId(sessionId);
      // Validate ownership before allowing an input to cancel this session's
      // automation. A stale frame must not take over a different document.
      const guest = browserSessions.currentGuest(owner);
      if (
        !guest ||
        guest.isDestroyed() ||
        (!['new-tab', 'select-tab', 'close-tab'].includes(input.type) &&
          input.documentId !== browserDocumentId(state, guest))
      ) {
        return Promise.reject(new Error('Browser page changed; input was not sent.'));
      }
      // A selected support tab keeps its own queue. Local takeover must
      // cancel the agent using that page, not the session's primary page.
      const command = { action: 'remote_control', session_id: owner, tab: state.pageId(guest) };
      if (input.type !== 'resize' && !(input.type === 'pointer' && input.phase === 'mouseMoved' && input.buttons === 0))
        retainGuest(guest);
      if (browserInputImmediate(input)) {
        if (input.type === 'answer-dialog' || input.type === 'choose-files') {
          const release = holdLocal(command);
          // Human file selection has no tool-command deadline. The exact
          // document/prompt is revalidated after the native picker returns.
          return pageSurface.control(owner, input).finally(release);
        }
        if (!browserInputPresentation(input)) interruptForLocal(command);
        const signal = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
        return cdp.bounded(
          pageSurface.control(owner, input, signal),
          COMMAND_TIMEOUT_MS,
          'Browser recovery control',
          signal
        );
      }
      // Dispatch itself remains bounded.
      return executeLocal(
        command,
        (signal) => pageSurface.control(owner, input, signal),
        browserLocalInputOptions(input)
      );
    },
    setBridgeEnabled(enabled: boolean): void {
      if (disposed || bridgeWanted === enabled) return;
      bridgeWanted = enabled;
      if (enabled) startBridge();
      else void stopBridge().catch(() => {});
    },
    releaseSession(sessionId: string, options: { restore?: boolean } = {}): void {
      const ownerSessionId = browserSessionId(sessionId);
      nativeShownGuests.delete(ownerSessionId);
      remoteViewingSessions.delete(ownerSessionId);
      remote.releaseViewer(ownerSessionId);
      presentationReads.release(ownerSessionId);
      nativeViews?.present(ownerSessionId, null);
      releaseLocal({ action: 'remote_control', session_id: ownerSessionId });
      pageSurface.release(ownerSessionId);
      lifecycle.releaseSession(ownerSessionId, options.restore === true);
      taskLifecycle.forget(ownerSessionId);
      downloadLedger.release(ownerSessionId);
      sendToRenderer(
        DESKTOP_IPC.browserSessionReleased,
        ownerSessionId,
        options.restore === true ? 'unloaded' : 'gone'
      );
      remoteTabs.changed();
    },
    setGuestActive(sessionId: string, webContentsId: number, active: boolean): void {
      const owner = browserSessionId(sessionId);
      let guest = browserSessions.guestForSession(owner, webContentsId);
      if (!guest) {
        browserSessions.bindVisibleGuest(owner, webContentsId, active);
        guest = browserSessions.guestForSession(owner, webContentsId);
      }
      if (!guest) return;
      if (active) panelActiveGuests.add(guest);
      else panelActiveGuests.delete(guest);
      // Restore a shown page before repainting it; a hidden one throttles.
      pagePower.refresh(guest);
      // A late display report must never undo a newer tab selection.
      if (active && guest === browserSessions.currentGuest(owner)) guest.invalidate();
    },
    async configureGuestViewport(
      sessionId: string,
      webContentsId: number,
      config: DesktopBrowserViewportConfig
    ): Promise<void> {
      const owner = browserSessionId(sessionId);
      const guest = browserSessions.guestForSession(owner, webContentsId);
      if (!guest || guest.id !== webContentsId) {
        throw new Error('Browser guest is unavailable.');
      }
      await emulation.configureEmulation(guest, browserViewportEmulation(config));
    },
    async browserImportSources(): Promise<BrowserImportSource[]> {
      return await profileImporter.sources();
    },
    async browserImport(request: BrowserImportRequest): Promise<BrowserImportResult> {
      return await profileImporter.importProfile(request, (progress) => {
        sendToRenderer(DESKTOP_IPC.browserProfileImportProgress, progress);
        void options.publishRemoteImportProgress?.(progress)?.catch(() => undefined);
      });
    },
    async browserHistorySearch(query: string): Promise<BrowserHistoryEntry[]> {
      return await profileImporter.searchHistory(query);
    },
    async browserCredentialSuggestions(sessionId: string): Promise<BrowserCredentialSuggestion[]> {
      const guest = browserSessions.liveGuest(browserSessionId(sessionId));
      if (!guest) return [];
      return await profileImporter.credentialSuggestions(guest.getURL());
    },
    async browserCredentialFill(sessionId: string, credentialId: string): Promise<BrowserCredentialFillResult> {
      const guest = browserSessions.liveGuest(browserSessionId(sessionId));
      if (!guest) throw new Error('Open a Browser Use page before filling a stored credential.');
      return await profileImporter.useCredential(guest.getURL(), credentialId, (credential) =>
        credentialFill.fillCredentialInGuest(guest, credential)
      );
    },
    remoteBrowserStream(sessionId: string, streamOptions: DesktopRemoteBrowserStreamOptions | null): Promise<void> {
      const owner = browserSessionId(sessionId);
      if (streamOptions) remoteViewingSessions.add(owner);
      else remoteViewingSessions.delete(owner);
      refreshSessionPower(owner);
      return remote.remoteBrowserStream(owner, streamOptions);
    },
    remoteBrowserControl(sessionId: string, control: DesktopRemoteBrowserControl): Promise<void> {
      return executeSerialized({ action: 'remote_control', session_id: browserSessionId(sessionId) }, undefined, () =>
        remote.remoteBrowserControl(browserSessionId(sessionId), control)
      );
    },
    remoteTabs: () => remoteTabs.list(),
    remoteTabsWatch: (on) => remoteTabs.watch(on),
    async remoteTabOpen(url: string): Promise<DesktopRemoteBrowserTab> {
      const id = `${MAIN_BROWSER_PAGE_PREFIX}${randomUUID().replaceAll('-', '')}`;
      await browserHost.remoteBrowserControl(id, { type: 'navigate', url });
      remoteTabs.changed();
      return remoteTabs.list().find((tab) => tab.id === id) ?? { id, title: '', url, loading: true };
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      remoteTabs.dispose();
      clearInterval(userReclaimTimer);
      screen.removeListener('display-metrics-changed', followPrimaryScale);
      screen.removeListener('display-added', followPrimaryScale);
      screen.removeListener('display-removed', followPrimaryScale);
      presentationReads.dispose();
      stopSessionAutosave();
      await sessionStore.save().catch(() => undefined);
      await cookieJar.dispose();
      partition.dispose();
      for (const guest of browserSessions.visibleGuests()) {
        await cdp.detach(guest);
      }
      await stopBridge();
      lifecycle.destroyAllPrimaryPages();
    },
  };
  return browserHost;
}
