/**
 * The page-level tools agent commands act through — input, snapshots, refs,
 * screenshots, replies, dialogs, downloads, network, performance, emulation,
 * page state and credential fill — wired over one guest state store and CDP.
 */
import type { Session, WebContents } from 'electron';
import { join } from 'node:path';
import { app } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract';
import type { createBrowserGuestCdp } from './cdp';
import {
  CUSTOM_DROPDOWN_POLL_MS,
  CUSTOM_DROPDOWN_TIMEOUT_MS,
  DOWNLOAD_ATTACH_MAX_BYTES,
  READ_MAX_CHARS,
  SCREENSHOT_FALLBACK_TIMEOUT_MS,
  SCREENSHOT_TIMEOUT_MS,
  SNAPSHOT_MAX_ELEMENTS,
  snapshotTextLimit,
} from './command';
import { createBrowserCredentialFill } from './credential-autofill';
import { browserCredentialFillHost, rememberForSession } from './credential-fill-host';
import { createBrowserDialogReport } from './dialog-report';
import type { createBrowserDocuments } from './documents';
import { createBrowserDownloads } from './downloads';
import { createBrowserEmulation } from './emulation';
import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import { createBrowserInitScripts } from './init-scripts';
import { createBrowserInputDriver } from './input';
import { createBrowserInputDispatch } from './input-dispatch';
import { createBrowserNetworkReports } from './network-report';
import type { createBrowserPartition } from './partition';
import { createBrowserPageState } from './page-state';
import { createBrowserPerformanceCommands } from './performance';
import { createBrowserRefActions } from './ref-actions';
import { createBrowserRefPoints } from './ref-points';
import { createBrowserReply } from './reply';
import { createBrowserScreenshotService } from './screenshot';
import { DEFAULT_BROWSER_SESSION_ID, type BrowserSessionRegistry } from './session-registry';
import { pause, type createBrowserSettle } from './settle';
import { createBrowserSnapshotCapture } from './snapshot-capture';
import type { BrowserUrlPolicy } from './url-policy';
import { createBrowserVisualPrivacy } from './visual-privacy';

type Cdp = ReturnType<typeof createBrowserGuestCdp>;
type Documents = ReturnType<typeof createBrowserDocuments>;
type ToolkitSessions = Pick<BrowserSessionRegistry, 'sessionIdForGuest' | 'currentGuest'>;

type DownloadsForSession = ReturnType<typeof createBrowserPartition>['downloadLedger']['downloadsForSession'];

/** Input into the page and the reads that locate what to act on. */
function createBrowserReadingTools(state: BrowserGuestStateStore, cdp: Cdp, documents: Documents) {
  const diagnosticsFor = (guest: WebContents) => state.for(guest);
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
  const screenshots = createBrowserScreenshotService(
    cdp,
    SCREENSHOT_TIMEOUT_MS,
    SCREENSHOT_FALLBACK_TIMEOUT_MS,
    createBrowserVisualPrivacy({ state, documents, cdp })
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
  return { dispatchInput, input, screenshots, snapshots, refPoints };
}

/** How an action is answered, and the actions and reports built on the reads. */
function createBrowserActionTools(
  state: BrowserGuestStateStore,
  cdp: Cdp,
  documents: Documents,
  settle: ReturnType<typeof createBrowserSettle>,
  sessions: ToolkitSessions,
  downloadsForSession: DownloadsForSession,
  reading: ReturnType<typeof createBrowserReadingTools>
) {
  const { input, screenshots, snapshots, refPoints } = reading;
  const diagnosticsFor = (guest: WebContents) => state.for(guest);
  const reply = createBrowserReply({
    state,
    settleAfterAction: settle.settleAfterAction,
    postconditionMatchesGuest: settle.postconditionMatchesGuest,
    captureSnapshotPayload: snapshots.captureSnapshotPayload,
    captureScreenshot: screenshots.capture,
    bindVisualGrounding: refPoints.bindVisualGrounding,
    downloadsForGuest: (guest) => downloadsForSession(sessions.sessionIdForGuest(guest) ?? DEFAULT_BROWSER_SESSION_ID),
  });
  const refActions = createBrowserRefActions({
    rememberSecret: (guest, value) => {
      state.rememberSecret(guest, value);
      rememberForSession(sessions, guest, value);
    },
    accessibilityRefs: (guest) => state.peek(guest)?.accessibilityRefs,
    callAccessibilityRef: snapshots.callAccessibilityRef,
    evaluate: cdp.evaluate,
    evaluateInFrames: documents.collect,
    evaluateInFramesByFrame: (guest, expression, signal) => documents.collect.byFrame(guest, expression, signal),
    cdp,
    frames: (guest) => state.for(guest).cdpSessions,
    frameOffsetForSession: (guest, sessionId, signal) => snapshots.frameOffsetForSession(guest, sessionId, signal),
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
    downloads: downloadsForSession,
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
  return { reply, refActions, dialogs, downloads, network, performance, initScripts };
}

/** Emulation, page state and credential fill: what configures a page. */
function createBrowserPageConfigTools(
  state: BrowserGuestStateStore,
  cdp: Cdp,
  sessions: ToolkitSessions,
  reply: ReturnType<typeof createBrowserReply>,
  options: {
    partitionSession: Session;
    urlPolicy: BrowserUrlPolicy;
    sendToRenderer: (channel: string, ...args: unknown[]) => void;
    beginViewportChange: (guest: WebContents) => () => void;
  }
) {
  const emulation = createBrowserEmulation({
    cdp,
    invalidateInteractionState: (guest) => state.invalidateInteraction(guest),
    snapshotResult: reply.snapshotResult,
    // The pane hears every emulated metrics change and frames the guest at
    // that size; resizing only the page would leave it drawn top-left inside
    // a larger responsive box.
    onViewportChanged: (guest, viewport) => {
      const sessionId = sessions.sessionIdForGuest(guest);
      // Only the selected page may reframe the pane, including a selected popup.
      if (!sessionId || sessions.currentGuest(sessionId) !== guest) return;
      options.sendToRenderer(DESKTOP_IPC.browserGuestViewportChanged, {
        sessionId,
        webContentsId: guest.id,
        viewport,
      });
    },
    beginViewportChange: options.beginViewportChange,
  });
  const pageState = createBrowserPageState({
    partitionSession: options.partitionSession,
    urlPolicy: () => options.urlPolicy,
    evaluate: cdp.evaluate,
    invalidateInteractionState: (guest) => state.invalidateInteraction(guest),
    formatEvaluationValue: reply.formatEvaluationValue,
  });
  const credentialFill = createBrowserCredentialFill(browserCredentialFillHost(state, cdp, sessions));
  return { emulation, pageState, credentialFill };
}

export function createBrowserCommandToolkit(options: {
  state: BrowserGuestStateStore;
  cdp: Cdp;
  documents: Documents;
  settle: ReturnType<typeof createBrowserSettle>;
  sessions: ToolkitSessions;
  downloadsForSession: DownloadsForSession;
  partitionSession: Session;
  urlPolicy: BrowserUrlPolicy;
  sendToRenderer: (channel: string, ...args: unknown[]) => void;
  beginViewportChange: (guest: WebContents) => () => void;
}) {
  const { state, cdp, documents, sessions } = options;
  const reading = createBrowserReadingTools(state, cdp, documents);
  const actions = createBrowserActionTools(
    state,
    cdp,
    documents,
    options.settle,
    sessions,
    options.downloadsForSession,
    reading
  );
  const config = createBrowserPageConfigTools(state, cdp, sessions, actions.reply, {
    partitionSession: options.partitionSession,
    urlPolicy: options.urlPolicy,
    sendToRenderer: options.sendToRenderer,
    beginViewportChange: options.beginViewportChange,
  });
  return { ...reading, ...actions, ...config };
}
