/**
 * Agent browser host — main-process owner of the in-app browser pane's guest
 * webviews and of the local bridge that lets the session runtime's `browser`
 * tool drive them.
 *
 * Architecture: the renderer's BrowserPane mounts a <webview> on the shared
 * persistent partition that `partition` guards; guest-lifecycle vets and
 * registers every such guest, cdp drives the CURRENT guest over the Chrome
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
import { app, BrowserWindow } from 'electron';

import {
  DESKTOP_IPC,
  type DesktopBrowserViewportConfig,
  type DesktopRemoteBrowserControl,
  type DesktopRemoteBrowserFrame,
} from '../../shared/contract';
import { BrowserActionBudget, resolveBrowserActionsPerTurn } from './action-budget';
import { browserActionHandler, type BrowserActionServices } from './actions';
import { bridgeDiscoveryDirectory } from '../bridge/discovery-file';
import { BrowserBridgeServer } from './bridge-server';
import { createBrowserGuestCdp } from './cdp';
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
  snapshotTextLimit,
} from './command';
import { createBrowserCommandQueue } from './command-queue';
import {
  type BrowserCredentialFillResult,
  createBrowserCredentialFill,
} from './credential-autofill';
import { DIALOG_BRIDGE_UNINSTALL_SCRIPT } from './dialog-bridge';
import { createBrowserDialogReport } from './dialog-report';
import { createBrowserDownloads } from './downloads';
import { createBrowserEmulation } from './emulation';
import { createBrowserGuestLifecycle } from './guest-lifecycle';
import { BrowserGuestStateStore } from './guest-state';
import { createBrowserInitScripts } from './init-scripts';
import { createBrowserInputDriver } from './input';
import { createBrowserIntercept } from './intercept';
import { createBrowserNetworkReports } from './network';
import { createBrowserPageState } from './page-state';
import { createBrowserPartition } from './partition';
import { createBrowserPerformanceCommands } from './performance';
import {
  normalizeBrowserPostcondition,
  normalizeBrowserSettleMs,
} from './postcondition';
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
import {
  BrowserSessionRegistry,
  DEFAULT_BROWSER_SESSION_ID,
  browserSessionId,
} from './session-registry';
import { createBrowserSettle, pause } from './settle';
import { createBrowserSnapshotCapture } from './snapshot-capture';
import { createBrowserTabs } from './tabs';
import { createBrowserUrlAdmission } from './url-admission';
import type { BrowserUrlPolicy } from './url-policy';

export type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserSnapshotResultOptions,
} from './command';

export interface BrowserHost {
  /** Opt-in agent bridge: on serves the runtime's `browser` tool, off tears
   *  it down (server, discovery file, agent offscreen pages). The browser
   *  pane infrastructure stays live either way. */
  setBridgeEnabled(enabled: boolean): void;
  releaseSession(sessionId: string): void;
  setGuestActive(sessionId: string, webContentsId: number, active: boolean): void;
  configureGuestViewport(
    sessionId: string,
    webContentsId: number,
    config: DesktopBrowserViewportConfig,
  ): Promise<void>;
  browserImportSources(): Promise<BrowserImportSource[]>;
  browserImport(request: BrowserImportRequest): Promise<BrowserImportResult>;
  browserHistorySearch(query: string): Promise<BrowserHistoryEntry[]>;
  browserCredentialSuggestions(sessionId: string): Promise<BrowserCredentialSuggestion[]>;
  browserCredentialFill(
    sessionId: string,
    credentialId: string,
  ): Promise<BrowserCredentialFillResult>;
  remoteBrowserFrame(
    sessionId: string,
    previousFrameId?: string,
  ): Promise<DesktopRemoteBrowserFrame>;
  remoteBrowserControl(
    sessionId: string,
    input: DesktopRemoteBrowserControl,
  ): Promise<void>;
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
  } = {},
): BrowserHost {
  const state = new BrowserGuestStateStore();
  const browserSessions = new BrowserSessionRegistry();
  const actionBudget = new BrowserActionBudget(
    resolveBrowserActionsPerTurn(process.env.MIXDOG_BROWSER_MAX_ACTIONS_PER_TURN),
  );
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

  const browserUrlPolicy = browserUrlPolicyFromEnvironment();
  const urls = createBrowserUrlAdmission({ policy: browserUrlPolicy });

  // ---- Partition: permissions, request admission, downloads -----------------
  const partition = createBrowserPartition({
    assertResolvedResourceUrlAllowed: urls.assertResolvedResourceUrlAllowed,
    downloadsDirectory: () => app.getPath('downloads'),
    sessionIdForGuest: (guest) => browserSessions.sessionIdForGuest(guest),
    defaultSessionId: DEFAULT_BROWSER_SESSION_ID,
  });
  const { session: partitionSession, downloadLedger } = partition;
  const profileImporter = new BrowserProfileImportService({
    userDataDirectory: app.getPath('userData'),
    temporaryDirectory: app.getPath('temp'),
    partition: partitionSession,
    nativeImporterPath: defaultNativeBrowserImporterPath(),
  });

  // ---- Page services --------------------------------------------------------
  const intercept = createBrowserIntercept();
  const cdp = createBrowserGuestCdp({
    state,
    interceptFetchPatterns: intercept.interceptFetchPatterns,
    matchInterceptRule: intercept.matchInterceptRule,
  });
  const diagnosticsFor = (guest: WebContents) => state.for(guest);
  const settle = createBrowserSettle({
    diagnostics: diagnosticsFor,
    evaluate: cdp.evaluate,
    quietMs: ACTION_SETTLE_QUIET_MS,
    domTimeoutMs: ACTION_SETTLE_DOM_TIMEOUT_MS,
    loadTimeoutMs: ACTION_SETTLE_LOAD_TIMEOUT_MS,
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
  });
  const input = createBrowserInputDriver(async (guest, method, params, signal) => (
    cdp.sendCdpInput(guest, await cdp.guestDebugger(guest), method, params, signal)
  ));
  const screenshots = createBrowserScreenshotService(
    cdp,
    SCREENSHOT_TIMEOUT_MS,
    SCREENSHOT_FALLBACK_TIMEOUT_MS,
  );
  const snapshots = createBrowserSnapshotCapture({
    evaluate: cdp.evaluate,
    cdp,
    diagnostics: diagnosticsFor,
    snapshotTextLimit,
    nextSnapshotId: (guest) => state.nextSnapshotId(guest),
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
  });
  const reply = createBrowserReply({
    state,
    settleAfterAction: settle.settleAfterAction,
    postconditionMatchesGuest: settle.postconditionMatchesGuest,
    captureSnapshotPayload: snapshots.captureSnapshotPayload,
    captureScreenshot: screenshots.capture,
    bindVisualGrounding: refPoints.bindVisualGrounding,
    downloadsForGuest: (guest) => downloadLedger.downloadsForSession(
      browserSessions.sessionIdForGuest(guest) ?? DEFAULT_BROWSER_SESSION_ID,
    ),
  });
  const refActions = createBrowserRefActions({
    accessibilityRefs: (guest) => state.peek(guest)?.accessibilityRefs,
    callAccessibilityRef: snapshots.callAccessibilityRef,
    evaluate: cdp.evaluate,
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
  });
  const initScripts = createBrowserInitScripts({ cdp });
  const emulation = createBrowserEmulation({
    cdp,
    invalidateInteractionState: (guest) => state.invalidateInteraction(guest),
    snapshotResult: reply.snapshotResult,
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
    captureScreenshot: screenshots.capture,
    assertResolvedUrlAllowed: urls.assertResolvedUrlAllowed,
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
  });

  const services: BrowserActionServices = {
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
    downloadsForSession: downloadLedger.downloadsForSession,
    runCommand: (command, signal) => runCommand(command, signal),
  };

  // ---- Dispatch -------------------------------------------------------------
  async function runCommand(
    command: BrowserCommand,
    signal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const action = normalizeBrowserAction(command);
    if (!action) throw new Error('browser command requires action');
    const ownerSessionId = browserSessionId(command.session_id);
    const hasScreenshotOptions = ['fullPage', 'format', 'quality'].some(
      (name) => Object.hasOwn(command, name),
    );
    if (action !== 'snapshot' && hasScreenshotOptions && command.includeScreenshot !== true) {
      throw new Error(`${action} screenshot options require includeScreenshot=true`);
    }
    normalizeBrowserSettleMs(command.settleMs);
    const expected = normalizeBrowserPostcondition(command.expect);
    if (expected && !POSTCONDITION_ACTIONS.has(action)) {
      throw new Error(`expect is not supported for browser action "${action}"`);
    }
    // A sequence pays one budget unit; its steps ARE that unit.
    if (command.internalStep !== true) actionBudget.consume(command, action);
    // Foreground drives and reveals the visible tab; background drives a
    // hidden offscreen page on the same partition without taking the screen.
    const background = command.background === true;
    const tab = String(command.tab || '').trim();
    // Tab-less bookkeeping actions never open or create a page.
    if (action === 'list_tabs') return tabs.listTabs(ownerSessionId);
    if (action === 'downloads') return downloads.listDownloads(ownerSessionId, command, signal);
    if (action === 'close_tab') return tabs.closeBackgroundTab(ownerSessionId, tab);
    const handler = browserActionHandler(action);
    if (!handler) throw new Error(`unknown browser action "${action}"`);
    const target = tabs.resolveTargetGuest(ownerSessionId, background, tab);
    const targetIsBackground = target?.background === true;
    if (target && !targetIsBackground) lifecycle.requestBrowserSurface(ownerSessionId, true);
    const guest = target?.guest ?? await lifecycle.ensureGuest(ownerSessionId);
    await lifecycle.recoverCrashedGuest(guest, signal);
    if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
    // A blocked page accepts no gesture: CDP would queue the input behind the
    // dialog and replay it after handle_dialog, which nobody asked for.
    if (!DIALOG_TOLERANT_ACTIONS.has(action)) {
      const blocked = reply.dialogResult(guest);
      if (blocked) return blocked;
    }
    const refRecovery = reply.refRecoveryFor(guest);
    const preexistingPostcondition = Boolean(
      expected
      && action !== 'navigate'
      && !state.for(guest).pendingDialog
      && await settle.postconditionMatchesGuest(guest, expected, signal),
    );
    const actionSnapshot = () => (command.internalStep === true
      ? settle.stepSettleResult(guest, signal)
      : reply.snapshotResult(guest, command, signal, {
        expected,
        preexistingPostcondition,
        settleAction: true,
        targetIsBackground,
      }));
    return handler({
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
      actionSnapshot,
      services,
    });
  }

  const { executeSerialized } = createBrowserCommandQueue({
    chains: commandChains,
    pendingReads,
    sessionId: (command) => browserSessionId(command.session_id),
    backgroundEntryByPageId: lifecycle.backgroundEntryByPageId,
    run: runCommand,
    bounded: cdp.bounded,
    readOnlyActions: READ_ONLY_ACTIONS,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  });

  // ---- Agent bridge ---------------------------------------------------------
  // Loopback command server + discovery file — the pair that exposes the
  // runtime's `browser` tool. Opt-in via Settings, mirroring Computer Use;
  // the pane infrastructure above runs regardless of the toggle.
  const bridgeServer = new BrowserBridgeServer<BrowserCommand>({
    dataDirectory: bridgeDiscoveryDirectory,
    execute: (command, signal) => executeSerialized(command, signal),
    redactError: redactBrowserText,
    onReady: () => {
      options.onDiagnostic?.('browser-bridge-ready', {
        durationMs: bridgeStartedAt > 0 ? Date.now() - bridgeStartedAt : 0,
      });
      backgroundReclaimTimer = setInterval(
        () => lifecycle.reclaimIdleBackgroundPages(),
        BACKGROUND_RECLAIM_INTERVAL_MS,
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
    actionBudget.clear();
    for (const guest of browserSessions.visibleGuests()) {
      await cdp.detach(guest, { uninstallScript: DIALOG_BRIDGE_UNINSTALL_SCRIPT });
    }
    // Agent-only surfaces die with the bridge; visible pane tabs belong to
    // the user and stay open.
    lifecycle.destroyAllBackgroundPages();
  }

  return {
    setBridgeEnabled(enabled: boolean): void {
      if (disposed || bridgeWanted === enabled) return;
      bridgeWanted = enabled;
      if (enabled) startBridge();
      else void stopBridge().catch(() => {});
    },
    releaseSession(sessionId: string): void {
      const ownerSessionId = browserSessionId(sessionId);
      lifecycle.releaseSession(ownerSessionId);
      downloadLedger.release(ownerSessionId);
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.browserSessionReleased, ownerSessionId);
      }
    },
    setGuestActive(sessionId: string, webContentsId: number, active: boolean): void {
      browserSessions.bindVisibleGuest(browserSessionId(sessionId), webContentsId, active);
    },
    async configureGuestViewport(
      sessionId: string,
      webContentsId: number,
      config: DesktopBrowserViewportConfig,
    ): Promise<void> {
      const guest = browserSessions.bindVisibleGuest(
        browserSessionId(sessionId),
        webContentsId,
        true,
      );
      if (!guest || guest.id !== webContentsId) {
        throw new Error('Browser guest is unavailable.');
      }
      const fixedViewport = config.width !== null && config.height !== null;
      await emulation.configureEmulation(guest, {
        action: 'emulate',
        reset: true,
        ...(fixedViewport ? {
          width: config.width!,
          height: config.height!,
          deviceScaleFactor: config.deviceScaleFactor,
          mobile: config.mobile,
          touch: config.touch,
          userAgent: config.userAgent ?? '',
          orientation: config.width! > config.height! ? 'landscape' : 'portrait',
        } : {}),
      });
    },
    async browserImportSources(): Promise<BrowserImportSource[]> {
      return await profileImporter.sources();
    },
    async browserImport(request: BrowserImportRequest): Promise<BrowserImportResult> {
      return await profileImporter.importProfile(request, (progress) => {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send(DESKTOP_IPC.browserProfileImportProgress, progress);
        }
      });
    },
    async browserHistorySearch(query: string): Promise<BrowserHistoryEntry[]> {
      return await profileImporter.searchHistory(query);
    },
    async browserCredentialSuggestions(
      sessionId: string,
    ): Promise<BrowserCredentialSuggestion[]> {
      const guest = browserSessions.liveGuest(browserSessionId(sessionId));
      if (!guest) return [];
      return await profileImporter.credentialSuggestions(guest.getURL());
    },
    async browserCredentialFill(
      sessionId: string,
      credentialId: string,
    ): Promise<BrowserCredentialFillResult> {
      const guest = browserSessions.liveGuest(browserSessionId(sessionId));
      if (!guest) throw new Error('Open a Browser Use page before filling a stored credential.');
      return await profileImporter.useCredential(
        guest.getURL(),
        credentialId,
        (credential) => credentialFill.fillCredentialInGuest(guest, credential),
      );
    },
    remoteBrowserFrame(sessionId: string, previousFrameId = ''): Promise<DesktopRemoteBrowserFrame> {
      return remote.remoteBrowserFrame(browserSessionId(sessionId), previousFrameId);
    },
    remoteBrowserControl(sessionId: string, control: DesktopRemoteBrowserControl): Promise<void> {
      return remote.remoteBrowserControl(browserSessionId(sessionId), control);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      partition.dispose();
      for (const guest of browserSessions.visibleGuests()) {
        await cdp.detach(guest);
      }
      await stopBridge();
    },
  };
}
