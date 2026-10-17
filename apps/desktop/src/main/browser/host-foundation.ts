/**
 * The browser host's shared base: guest state, sessions and command ledgers,
 * the display-client edge, URL policy, the persistent partition with its
 * cookies and restart state, profile import, CDP with its documents and
 * settle, display textures and tracking, page identity and leave confirmation.
 */
import type { WebContents } from 'electron';
import { join } from 'node:path';
import { app, type BrowserWindow, sharedTexture, webContents } from 'electron';

import { DESKTOP_IPC } from '../../shared/contract';
import { createBrowserActionApproval, type BrowserApprovalRequest } from './action-approval';
import { requestBrowserApproval } from './approval-dialog';
import { createBrowserSessionStore } from './browser-session-store';
import { createBrowserGuestCdp } from './cdp';
import { ACTION_SETTLE_DOM_TIMEOUT_MS, ACTION_SETTLE_LOAD_TIMEOUT_MS, ACTION_SETTLE_QUIET_MS } from './command';
import { createBrowserCookieJar } from './cookie-jar';
import { createBrowserDisplayTextures } from './display-textures';
import { createBrowserDisplayTracking } from './display-tracking';
import { createBrowserDocuments } from './documents';
import { browserDocumentId, BrowserGuestStateStore } from './guest-state';
import { createBrowserHostPageIdentity } from './host-page-identity';
import { browserUrlPolicyFromEnvironment } from './host-policy';
import { createBrowserIntercept } from './intercept';
import { createBrowserLeaveConfirmation } from './leave-confirmation';
import { createBrowserPartition } from './partition';
import { BrowserProfileImportService, defaultNativeBrowserImporterPath } from './profile-import';
import { redactBrowserText } from './redaction';
import { BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID } from './session-registry';
import { createBrowserSettle } from './settle';
import { createBrowserUrlAdmission } from './url-admission';
import type { BrowserUrlPolicy } from './url-policy';
import { browserPageGuardScripts } from './webrtc-guard';

type Diagnostic = (event: string, data: Record<string, unknown>) => void;

/** Chromium keeps persistent cookies and localStorage for the partition on
 *  its own; session cookies — most sign-ins — die with the process unless
 *  the host carries them across a restart itself. */
function createBrowserRestartState(cookieJar: ReturnType<typeof createBrowserCookieJar>, onDiagnostic?: Diagnostic) {
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

/** A JavaScript dialog pauses its whole renderer process, so every page that
 *  process hosts (typically a same-site popup and its opener) waits on it.
 *  The process, not the opener link, decides: a cross-site popup runs elsewhere. */
function sameProcessGuests(guest: WebContents): WebContents[] {
  const pid = guest.isDestroyed() ? 0 : guest.getOSProcessId();
  if (pid <= 0) return [];
  return webContents
    .getAllWebContents()
    .filter((other) => other !== guest && !other.isDestroyed() && other.getOSProcessId() === pid);
}

/** The persistent partition and what lives on it across restarts. */
function createBrowserHostStorage(
  state: BrowserGuestStateStore,
  sessions: BrowserSessionRegistry,
  urls: ReturnType<typeof createBrowserUrlAdmission>,
  onDiagnostic?: Diagnostic
) {
  const partition = createBrowserPartition({
    assertResolvedResourceUrlAllowed: urls.assertResolvedResourceUrlAllowed,
    downloadsDirectory: () => app.getPath('downloads'),
    sessionIdForGuest: (guest) => sessions.sessionIdForGuest(guest),
    defaultSessionId: DEFAULT_BROWSER_SESSION_ID,
    onRequestRefused: (webContentsId, url, reason) => {
      const guest = webContentsId === undefined ? null : webContents.fromId(webContentsId);
      if (guest) state.recordRefusedRequest(guest, url, reason);
    },
  });
  const cookieJar = createBrowserCookieJar(partition.session);
  const { sessionStore, stopSessionAutosave } = createBrowserRestartState(cookieJar, onDiagnostic);
  const profileImporter = new BrowserProfileImportService({
    userDataDirectory: app.getPath('userData'),
    temporaryDirectory: app.getPath('temp'),
    partition: partition.session,
    cookieJar,
    nativeImporterPath: defaultNativeBrowserImporterPath(),
  });
  return { partition, cookieJar, sessionStore, stopSessionAutosave, profileImporter };
}

/** CDP over the guest state, with the document readers and settle built on it. */
function createBrowserHostDevtools(
  state: BrowserGuestStateStore,
  urlPolicy: BrowserUrlPolicy,
  permissionRefused: (origin: string, name: string) => boolean
) {
  const intercept = createBrowserIntercept();
  const cdp = createBrowserGuestCdp({
    state,
    permissionRefused,
    interceptFetchPatterns: intercept.interceptFetchPatterns,
    matchInterceptRule: intercept.matchInterceptRule,
    pageGuardScripts: () => browserPageGuardScripts(urlPolicy),
  });
  const documents = createBrowserDocuments({
    cdp,
    sessions: (guest) => state.for(guest).cdpSessions,
  });
  const settle = createBrowserSettle({
    diagnostics: (guest) => state.for(guest),
    evaluate: cdp.evaluate,
    renderCheckpoint: documents.renderCheckpoint,
    pageText: documents.pageText,
    quietMs: ACTION_SETTLE_QUIET_MS,
    domTimeoutMs: ACTION_SETTLE_DOM_TIMEOUT_MS,
    loadTimeoutMs: ACTION_SETTLE_LOAD_TIMEOUT_MS,
  });
  return { intercept, cdp, documents, settle };
}

function createBrowserHostTextures(window: BrowserWindow, state: BrowserGuestStateStore) {
  return createBrowserDisplayTextures({
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
}

export type BrowserHostFoundation = ReturnType<typeof createBrowserHostFoundation>;

export function createBrowserHostFoundation(
  window: BrowserWindow,
  options: {
    /** The session's work runs on a remote server (ssh window), not this PC. */
    remoteSession: boolean;
    onDiagnostic?: Diagnostic;
    requestApproval?: (request: BrowserApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
  }
) {
  const state = new BrowserGuestStateStore(sameProcessGuests);
  const approvals = createBrowserActionApproval({
    ask: options.requestApproval || ((request, signal) => requestBrowserApproval(window, request, signal)),
    confirmActions: process.env.MIXDOG_BROWSER_CONFIRM_ACTIONS,
    denyActions: process.env.MIXDOG_BROWSER_DENY_ACTIONS,
  });
  const sessions = new BrowserSessionRegistry();
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

  const urlPolicy = browserUrlPolicyFromEnvironment({ remote: options.remoteSession });
  const urls = createBrowserUrlAdmission({ policy: urlPolicy });
  const nativeView = /^(?:1|true|yes)$/i.test(String(process.env.MIXDOG_BROWSER_NATIVE_VIEW || ''));
  const storage = createBrowserHostStorage(state, sessions, urls, options.onDiagnostic);
  const devtools = createBrowserHostDevtools(state, urlPolicy, storage.partition.permissions.refused);
  const displayTextures = createBrowserHostTextures(window, state);
  const display = createBrowserDisplayTracking(sessions);
  const pageIdentity = createBrowserHostPageIdentity({
    partitionSession: storage.partition.session,
    directory: join(app.getPath('userData'), 'browser-state'),
    announce: (origin) => sendToRenderer(DESKTOP_IPC.browserPageIdentityChanged, origin),
  });
  const leave = createBrowserLeaveConfirmation();
  return {
    state,
    approvals,
    sessions,
    commandChains,
    isBackgroundBusy,
    pendingReads,
    sendToRenderer,
    urlPolicy,
    urls,
    nativeView,
    ...storage,
    ...devtools,
    displayTextures,
    display,
    pageIdentity,
    leave,
  };
}
