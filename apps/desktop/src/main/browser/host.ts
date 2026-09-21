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
import { validateBrowserToolArgs } from '../../../../../src/runtime/browser-bridge/action-schema.mjs';
import { app, BrowserWindow, dialog, sharedTexture } from 'electron';

import {
  DESKTOP_IPC,
  type DesktopBrowserViewportConfig,
  type DesktopBrowserPageFrame,
  type DesktopBrowserPageResample,
  type DesktopBrowserPageControl,
  type DesktopRemoteBrowserControl,
  type DesktopRemoteBrowserFrame,
} from '../../shared/contract';
import { createBrowserActionApproval, type BrowserApprovalRequest } from './action-approval';
import { requestBrowserApproval } from './approval-dialog';
import { browserActionHandler, type BrowserActionServices } from './actions';
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
  type BrowserCommandResult,
  COMMAND_TIMEOUT_MS,
  CUSTOM_DROPDOWN_POLL_MS,
  CUSTOM_DROPDOWN_TIMEOUT_MS,
  DIALOG_TOLERANT_ACTIONS,
  DOWNLOAD_ATTACH_MAX_BYTES,
  normalizeBrowserAction,
  POSTCONDITION_ACTIONS,
  READ_MAX_CHARS,
  READ_ONLY_ACTIONS,
  SCREENSHOT_FALLBACK_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  SNAPSHOT_MAX_ELEMENTS,
  TABLESS_ACTIONS,
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
import { createBrowserNetworkReports } from './network';
import { createBrowserPageState } from './page-state';
import { createBrowserPageSurface } from './page-surface';
import { createBrowserLocalPrompts } from './local-prompts';
import { BROWSER_INPUT_WAIT_MS, browserInputImmediate, browserTypingInput } from '../../shared/browser-input-policy';
import { createBrowserDisplayCapture } from './display-capture';
import { createBrowserDisplayTextures } from './display-textures';
import { createBrowserPartition } from './partition';
import type { BrowserDataClearResult, BrowserDataScope } from './browsing-data';
import { createBrowserPerformanceCommands } from './performance';
import { normalizeBrowserPostcondition, normalizeBrowserSettleMs } from './postcondition';
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
import { createBrowserReply } from './reply';
import { createBrowserScreenshotService } from './screenshot';
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
  browserClearData(scopes: readonly BrowserDataScope[]): Promise<BrowserDataClearResult>;
  browserCredentialSuggestions(sessionId: string): Promise<BrowserCredentialSuggestion[]>;
  browserCredentialFill(sessionId: string, credentialId: string): Promise<BrowserCredentialFillResult>;
  remoteBrowserFrame(sessionId: string, previousFrameId?: string): Promise<DesktopRemoteBrowserFrame>;
  remoteBrowserControl(sessionId: string, input: DesktopRemoteBrowserControl): Promise<void>;
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

export function createBrowserHost(
  window: BrowserWindow,
  options: {
    onDiagnostic?: (event: string, data: Record<string, unknown>) => void;
    requestApproval?: (request: BrowserApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
    chooseBrowserFiles?: (multiple: boolean) => Promise<{ canceled: boolean; filePaths: string[] }>;
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

  const partition = createBrowserPartition({
    assertResolvedResourceUrlAllowed: urls.assertResolvedResourceUrlAllowed,
    downloadsDirectory: () => app.getPath('downloads'),
    sessionIdForGuest: (guest) => browserSessions.sessionIdForGuest(guest),
    defaultSessionId: DEFAULT_BROWSER_SESSION_ID,
  });
  const { session: partitionSession, downloadLedger } = partition;
  const cookieJar = createBrowserCookieJar(partitionSession);
  // Chromium keeps persistent cookies and localStorage for the partition on
  // its own; session cookies — most sign-ins — die with the process unless
  // the host carries them across a restart itself.
  const sessionStore = createBrowserSessionStore({
    cookies: cookieJar,
    directory: join(app.getPath('userData'), 'browser-state'),
  });
  void sessionStore.restore().catch((error) => {
    options.onDiagnostic?.('browser-session-restore-failed', {
      error: redactBrowserText((error as Error).message || String(error)),
    });
  });
  const stopSessionAutosave = sessionStore.startAutosave();
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
  const lifecycle = createBrowserGuestLifecycle({
    window,
    partitionSession,
    state,
    sessions: browserSessions,
    cdp,
    urlPolicy: browserUrlPolicy,
    bridgeWanted: () => bridgeWanted,
    isBackgroundBusy: (sessionId, name) => commandChains.has(`session:${sessionId}:background:${name}`),
    waitForLoadSettle: settle.waitForLoadSettle,
    onPopup: (opener, popup) => taskLifecycle.inherit(opener, popup),
    onGuest: (guest) => displayTextures.attach(guest),
  });
  const taskLifecycle = createBrowserTaskLifecycle<WebContents>({
    current: (sessionId) => browserSessions.currentGuest(sessionId),
    select: (sessionId, guest) => browserSessions.selectGuest(sessionId, guest),
    close: (guest) => BrowserWindow.fromWebContents(guest)?.destroy(),
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
      reset: (guest) => {
        state.for(guest).interceptedDrag = undefined;
      },
      take: (guest) => {
        const pending = state.peek(guest)?.interceptedDrag;
        if (pending) state.for(guest).interceptedDrag = undefined;
        return pending ?? null;
      },
    },
  });
  const screenshots = createBrowserScreenshotService(cdp, SCREENSHOT_TIMEOUT_MS, SCREENSHOT_FALLBACK_TIMEOUT_MS);
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
    captureScreenshot: screenshots.capture,
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
    // An agent `emulate` viewport used to resize the page only; the pane kept
    // drawing a responsive guest, so the emulated page sat top-left in a
    // larger box (user: 브라우저 왜 가운데 정렬 안 되냐). The pane now hears
    // every metrics change and frames the guest at that size.
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
    input,
    urlPolicy: browserUrlPolicy,
    ensureGuest: lifecycle.ensureGuest,
    viewerChanged: (sessionId, active) => sendToRenderer(DESKTOP_IPC.browserRemoteViewerChanged, { sessionId, active }),
    onUserControl: retainGuest,
    captureScreenshot: screenshots.capture,
    assertResolvedUrlAllowed: urls.assertResolvedUrlAllowed,
    revision: documents.revision,
  });
  const displayCapture = createBrowserDisplayCapture(browserSharedTextureRendering());
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
    capture: (guest, geometryKey, viewport, signal) =>
      cdp.bounded(displayCapture(guest, geometryKey, viewport), 2000, 'Browser display capture', signal),
    captureTexture: (guest, documentId, viewport) =>
      displayTextures.acquire(guest, documentId, viewport.width, viewport.height),
    resize: (guest, width, height) => BrowserWindow.fromWebContents(guest)?.setContentSize(width, height),
    viewport: (guest) => {
      const owner = BrowserWindow.fromWebContents(guest);
      if (!owner || owner.isDestroyed() || guest.isDestroyed()) {
        throw new Error('Browser page changed during capture.');
      }
      const [width, height] = owner.getContentSize();
      return { width, height, zoom: guest.getZoomFactor() };
    },
  });
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
    closeGuest: (guest) => BrowserWindow.fromWebContents(guest)?.close(),
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
    screenshots,
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

  async function runCommand(command: BrowserCommand, signal?: AbortSignal): Promise<BrowserCommandResult> {
    const action = normalizeBrowserAction(command);
    if (!action) throw new Error('browser command requires action');
    const ownerSessionId = browserSessionId(command.session_id);
    const hasScreenshotOptions = ['fullPage', 'format', 'quality'].some((name) => Object.hasOwn(command, name));
    if (action !== 'snapshot' && hasScreenshotOptions && command.includeScreenshot !== true) {
      throw new Error(`${action} screenshot options require includeScreenshot=true`);
    }
    normalizeBrowserSettleMs(command.settleMs);
    const expected = normalizeBrowserPostcondition(command.expect);
    if (expected && !POSTCONDITION_ACTIONS.has(action)) {
      throw new Error(`expect is not supported for browser action "${action}"`);
    }
    // Foreground drives and reveals the visible tab; background drives a
    // hidden offscreen page on the same partition without taking the screen.
    const background = action === 'open' && command.background !== true ? false : command.background;
    const tab = String(command.tab || '').trim();
    // Tab-less bookkeeping actions never open or create a page.
    if (TABLESS_ACTIONS.has(action)) {
      await approvals.approve(command, () => ({ url: '', identity: ownerSessionId }), signal);
    }
    if (!['hide', 'downloads'].includes(action)) await lifecycle.restoreSession(ownerSessionId);
    if (action === 'list_tabs') return tabs.listTabs(ownerSessionId);
    if (action === 'downloads') return downloads.listDownloads(ownerSessionId, command, signal);
    if (action === 'close_tab') return tabs.closeBackgroundTab(ownerSessionId, tab);
    if (action === 'hide') {
      lifecycle.requestBrowserSurface(ownerSessionId, 'hide');
      return { text: 'Browser panel hide requested; tabs and page state are preserved.' };
    }
    const handler = browserActionHandler(action);
    if (!handler) throw new Error(`unknown browser action "${action}"`);
    const turnId = Number(command.turn_id) || 0;
    taskLifecycle.begin(ownerSessionId, turnId);
    const previousGuest = browserSessions.liveGuest(ownerSessionId);
    const target = tabs.resolveTargetGuest(ownerSessionId, background, tab);
    const targetIsBackground = target?.background === true;
    if (!target && !previousGuest && action !== 'navigate' && action !== 'open') {
      throw new Error('No browser page is open; navigate or use background:true.');
    }
    const guest = target?.guest ?? (await lifecycle.ensureGuest(ownerSessionId, { reveal: false }));
    const backgroundPage = browserSessions.backgroundPageForGuest(ownerSessionId, guest);
    taskLifecycle.use(
      ownerSessionId,
      turnId,
      guest,
      backgroundPage ? backgroundPage.kind === 'agent' && !backgroundPage.keepAlive : !previousGuest
    );
    if (action === 'open' && !targetIsBackground) {
      retainGuest(guest);
      lifecycle.requestBrowserSurface(ownerSessionId, true);
    } else if (
      !targetIsBackground &&
      (action === 'navigate' || command.background === false) &&
      !taskLifecycle.reveal(ownerSessionId, turnId, guest)
    ) {
      lifecycle.requestBrowserSurface(ownerSessionId, true);
    }
    await lifecycle.recoverCrashedGuest(guest, signal);
    if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
    // Explicit navigation and dialog handling can release a blocked execution.
    // Other commands, including non-CDP storage mutations, wait for cleanup.
    if (!['navigate', 'handle_dialog', 'status'].includes(action)) {
      await cdp.waitForIdle(guest, signal);
    }
    // A blocked page accepts no gesture: CDP would queue the input behind the
    // dialog and replay it after handle_dialog, which nobody asked for.
    if (!DIALOG_TOLERANT_ACTIONS.has(action)) {
      const blocked = reply.dialogResult(guest);
      if (blocked) return blocked;
    }
    const refRecovery = reply.refRecoveryFor(guest);
    const reportBaseline = state.peek(guest)?.refSet;
    // The latest observation of this page is what the gesture starts from; a
    // target resolution inside the handler moves it to the fresher one.
    const effectBaseline = { current: state.peek(guest)?.refSet };
    const preexistingPostcondition = Boolean(
      expected &&
        action !== 'navigate' &&
        !state.for(guest).pendingDialog &&
        (await settle.postconditionMatchesGuest(guest, expected, signal))
    );
    const actionSnapshot = () =>
      command.internalStep === true
        ? settle.stepSettleResult(guest, signal, targetIsBackground)
        : reply.snapshotResult(guest, command, signal, {
            expected,
            preexistingPostcondition,
            settleAction: true,
            targetIsBackground,
            baseline: effectBaseline.current,
            reportBaseline,
          });
    try {
      if (!command.internalStep) {
        await approvals.approve(
          command,
          () => ({
            url: guest.getURL(),
            identity: browserDocumentId(state, guest),
          }),
          signal
        );
      }
      const result = await handler({
        guest,
        command,
        action,
        signal,
        ownerSessionId,
        targetIsBackground,
        expected,
        preexistingPostcondition,
        hasScreenshotOptions,
        refRecovery,
        effectBaseline,
        actionSnapshot,
        services,
      });
      return { ...result, text: state.redactText(guest, result.text) };
    } catch (error) {
      throw new Error(state.redactText(guest, (error as Error).message || String(error)));
    }
  }

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
        if (
          !session_id ||
          !Number.isSafeInteger(turn_id) ||
          Number(turn_id) <= 0 ||
          Object.keys(input).some((key) => key !== 'action')
        ) {
          throw new Error('Invalid browser task cleanup context.');
        }
        const prefix = `session:${owner}:`;
        const pending = [
          ...[...commandChains].filter(([key]) => key.startsWith(prefix)).map(([, task]) => task),
          ...[...pendingReads].filter(([key]) => key.startsWith(prefix)).flatMap(([, tasks]) => [...tasks]),
        ];
        return Promise.allSettled(pending).then(() => ({
          text: `Browser task cleanup complete: ${taskLifecycle.finish(owner, Number(turn_id))} temporary page(s) closed.`,
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

  return {
    browserPageFrame(sessionId, previousFrameId = '', texture = false) {
      const owner = browserSessionId(sessionId);
      return presentationReads.read(owner, previousFrameId, texture);
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
        if (input.type !== 'resize') interruptForLocal(command);
        const signal = AbortSignal.timeout(COMMAND_TIMEOUT_MS);
        return cdp.bounded(
          pageSurface.control(owner, input, signal),
          COMMAND_TIMEOUT_MS,
          'Browser recovery control',
          signal
        );
      }
      // Releases must still finish an already-sent press, even after a slow
      // command. Typing retains its order behind that input; only pointer
      // gestures expire while queued. Dispatch itself remains bounded.
      const release = input.type === 'pointer' && input.phase === 'mouseReleased';
      const hover = input.type === 'pointer' && input.phase === 'mouseMoved' && input.buttons === 0;
      return executeLocal(command, (signal) => pageSurface.control(owner, input, signal), {
        takeover: !hover && input.type !== 'zoom',
        dropIfBusy: hover,
        ...(input.type === 'pointer' && input.phase !== 'mouseMoved' ? { held: !release } : {}),
        maxWaitMs: release || browserTypingInput(input) ? undefined : BROWSER_INPUT_WAIT_MS,
      });
    },
    setBridgeEnabled(enabled: boolean): void {
      if (disposed || bridgeWanted === enabled) return;
      bridgeWanted = enabled;
      if (enabled) startBridge();
      else void stopBridge().catch(() => {});
    },
    releaseSession(sessionId: string, options: { restore?: boolean } = {}): void {
      const ownerSessionId = browserSessionId(sessionId);
      remote.releaseViewer(ownerSessionId);
      presentationReads.release(ownerSessionId);
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
    },
    setGuestActive(sessionId: string, webContentsId: number, active: boolean): void {
      const owner = browserSessionId(sessionId);
      const guest = browserSessions.guestForSession(owner, webContentsId);
      if (guest) {
        // A late display report must never undo a newer tab selection.
        if (active && guest === browserSessions.currentGuest(owner)) guest.invalidate();
      } else {
        browserSessions.bindVisibleGuest(owner, webContentsId, active);
      }
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
      const fixedViewport =
        config.width !== null && config.height !== null ? { width: config.width, height: config.height } : null;
      const orientation = fixedViewport && fixedViewport.width > fixedViewport.height ? 'landscape' : 'portrait';
      await emulation.configureEmulation(guest, {
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
      });
    },
    browserClearData(scopes: readonly BrowserDataScope[]): Promise<BrowserDataClearResult> {
      return partition.clearBrowsingData(scopes, {
        // Session sign-ins are carried across restarts by this store; leaving
        // its file untouched would restore what the user just cleared.
        persistCookieState: () => sessionStore.save().then(() => undefined),
      });
    },
    async browserImportSources(): Promise<BrowserImportSource[]> {
      return await profileImporter.sources();
    },
    async browserImport(request: BrowserImportRequest): Promise<BrowserImportResult> {
      return await profileImporter.importProfile(request, (progress) => {
        sendToRenderer(DESKTOP_IPC.browserProfileImportProgress, progress);
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
    remoteBrowserFrame(sessionId: string, previousFrameId = ''): Promise<DesktopRemoteBrowserFrame> {
      return executeSerialized({ action: 'remote_frame', session_id: browserSessionId(sessionId) }, undefined, () =>
        remote.remoteBrowserFrame(browserSessionId(sessionId), previousFrameId)
      );
    },
    remoteBrowserControl(sessionId: string, control: DesktopRemoteBrowserControl): Promise<void> {
      return executeSerialized({ action: 'remote_control', session_id: browserSessionId(sessionId) }, undefined, () =>
        remote.remoteBrowserControl(browserSessionId(sessionId), control)
      );
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
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
}
