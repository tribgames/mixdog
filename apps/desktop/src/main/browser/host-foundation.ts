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
import type { EngineContext } from '../host/browser-engine/context';
import type { Leases } from '../host/browser-engine/lease';
import { createInterceptTable } from '../host/browser-engine/session';
import { createBrowserActionApproval, type BrowserApprovalRequest } from './action-approval';
import { requestBrowserApproval } from './approval-dialog';
import { createBrowserSessionStore, watchBrowserSessionCookies } from './browser-session-store';
import { createBrowserGuestCdp } from './cdp';
import type { EngineEventSink } from './cdp-event-router';
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
import { createBrowserLinkedSignIns } from './linked-sign-in';
import { LinkedSignInStore } from './linked-sign-in-store';
import { createBrowserPartition } from './partition';
import type { BrowserPermissionPolicyStore } from './permissions';
import type { FillEngine } from './credential-autofill';
import { CredentialVault } from './credential-vault';
import { BrowserProfileImportService, defaultNativeBrowserImporterPath } from './profile-import';
import { redactBrowserText } from './redaction';
import { BrowserSessionRegistry, DEFAULT_BROWSER_SESSION_ID } from './session-registry';
import { createBrowserSignIns } from './signed-in-sites';
import { createBrowserSettle } from './settle';
import { createBrowserUrlAdmission } from './url-admission';
import type { BrowserUrlPolicy } from './url-policy';
import { browserPageGuardScripts } from './webrtc-guard';

type Diagnostic = (event: string, data: Record<string, unknown>) => void;

/** Chromium keeps persistent cookies and localStorage for the partition on
 *  its own; session cookies — most sign-ins — die with the process unless
 *  the host carries them across a restart itself. Both are written within a
 *  second of a sign-in, so a crash after it keeps the login too. */
function createBrowserRestartState(
  partition: Electron.Session,
  cookieJar: ReturnType<typeof createBrowserCookieJar>,
  onDiagnostic?: Diagnostic
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
  const stopAutosave = sessionStore.startAutosave();
  const stopWatching = watchBrowserSessionCookies(partition.cookies, sessionStore, cookieJar);
  return {
    sessionStore,
    stopSessionAutosave: () => {
      stopAutosave();
      stopWatching();
    },
  };
}

/** "로그인 유지 중인 사이트" over the partition: per-site sign-out and the full
 *  wipe, which also deletes what was imported from Chrome. */
export function createPartitionSignIns(
  partition: Electron.Session,
  cookieJar: ReturnType<typeof createBrowserCookieJar>,
  profileImporter: Pick<BrowserProfileImportService, 'clearImportedData'>,
  sessionStore: Pick<ReturnType<typeof createBrowserSessionStore>, 'save'>,
  vault: Pick<CredentialVault, 'pauseOrigin'>
) {
  return createBrowserSignIns({
    cookies: cookieJar,
    clearOriginStorage: (origin) =>
      partition.clearStorageData({
        origin,
        // Electron 43 dropped 'websql' along with Chromium's WebSQL.
        storages: ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'serviceworkers', 'cachestorage'],
      }),
    clearAllStorage: async () => {
      await partition.clearStorageData();
      await partition.clearCache();
      await partition.clearAuthCache();
    },
    clearImportedData: () => profileImporter.clearImportedData(),
    saveSessionCookies: () => sessionStore.save(),
    pauseAutoSignIn: (site) => vault.pauseOrigin(site),
  });
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
  windowSession: Electron.Session,
  state: BrowserGuestStateStore,
  sessions: BrowserSessionRegistry,
  urls: ReturnType<typeof createBrowserUrlAdmission>,
  onDiagnostic?: Diagnostic,
  hidDevices?: () => boolean,
  permissionPolicy?: BrowserPermissionPolicyStore
) {
  const partition = createBrowserPartition({
    windowSession,
    hidDevices,
    permissionPolicy,
    guestForFrame: (frame) => webContents.fromFrame(frame),
    assertResolvedResourceUrlAllowed: urls.assertResolvedResourceUrlAllowed,
    downloadsDirectory: () => app.getPath('downloads'),
    sessionIdForGuest: (guest) => sessions.sessionIdForGuest(guest),
    defaultSessionId: DEFAULT_BROWSER_SESSION_ID,
    // A form_post callback's fields, for linked sign-in's state check.
    onNavigationPost: (webContentsId, url, chunks) => linkedSignIns.navigationPost(webContentsId, url, chunks),
    onRequestRefused: (webContentsId, url, reason) => {
      const guest = webContentsId === undefined ? null : webContents.fromId(webContentsId);
      if (guest) state.recordRefusedRequest(guest, url, reason);
    },
  });
  const cookieJar = createBrowserCookieJar(partition.session);
  const { sessionStore, stopSessionAutosave } = createBrowserRestartState(partition.session, cookieJar, onDiagnostic);
  const profileImporter = new BrowserProfileImportService({
    userDataDirectory: app.getPath('userData'),
    temporaryDirectory: app.getPath('temp'),
    partition: partition.session,
    cookieJar,
    nativeImporterPath: defaultNativeBrowserImporterPath(),
  });
  const vault = new CredentialVault({ userDataDirectory: app.getPath('userData') });
  const linkedSignInStore = new LinkedSignInStore({ userDataDirectory: app.getPath('userData') });
  // Linked sign-in memory (linked-sign-in.ts): the tabs' OAuth round trips.
  const linkedSignIns = createBrowserLinkedSignIns({
    store: linkedSignInStore,
    ref: (guest, ref) => {
      const refs = state.peek(guest)?.refSet;
      const found = refs?.refs.get(ref);
      return refs && found
        ? { name: found.name, url: refs.url, role: found.role, sensitive: found.sensitive === true }
        : null;
    },
    pageId: (guest) => state.pageId(guest),
    onError: (error) =>
      onDiagnostic?.('browser-linked-sign-in-failed', {
        error: redactBrowserText((error as Error).message || String(error)),
      }),
  });
  const signIns = createPartitionSignIns(partition.session, cookieJar, profileImporter, sessionStore, vault);
  return {
    partition,
    cookieJar,
    sessionStore,
    stopSessionAutosave,
    profileImporter,
    vault,
    linkedSignInStore,
    linkedSignIns,
    signIns,
  };
}

/** What one protocol connection's engine lane hands the browser while the connection is up
 *  (host/browser-engine/index.ts installBrowserEngine). */
export interface EngineLaneBinding {
  ctx: EngineContext;
  leases: Leases;
  /** Where the CDP event router sends a page's events. */
  sink: EngineEventSink;
  /** A page appeared: its facts are followed from now on. */
  guestAppeared(guest: WebContents): void;
  /** The page was shown, hidden or moved: its facts are re-read. */
  visibilityChanged(guest: WebContents): void;
}

/**
 * The browser's side of the engine lane. The browser is built before the protocol connection and the lane
 * belongs to a connection, so everything the browser reads from the lane goes through here: bound while the
 * connection is claimed, and a plain "no lane" (nothing routed, no engine mode) otherwise.
 */
export function createEngineLane() {
  let bound: EngineLaneBinding | null = null;
  const current = (): EngineLaneBinding => {
    if (!bound) throw new Error('The browser engine lane is not connected.');
    return bound;
  };
  /** The router's sink: events go to the connection's lane, and nowhere without one. */
  const sink: EngineEventSink = {
    active: () => bound?.sink.active() ?? false,
    carries: (method) => bound?.sink.carries(method) ?? false,
    forward: (guest, method, params, sessionId) => bound?.sink.forward(guest, method, params, sessionId),
  };
  /** What a secret or saved-login fill holds its call to the core's page state by. */
  const fill: FillEngine = {
    isEngineMode: () => bound?.ctx.isEngineMode() ?? false,
    page: (pageId) => bound?.ctx.page(pageId),
    facts: (pageId) => current().ctx.events.facts(pageId),
  };
  /** What the person's input on the pane is served by while the core drives the browser. The lease store is
   *  read at each input: a new connection makes a new one. */
  const localPage = {
    isEngineMode: (): boolean => bound?.ctx.isEngineMode() ?? false,
    get leases(): Leases {
      return current().leases;
    },
  };
  return {
    sink,
    fill,
    localPage,
    /** Binds the connection's lane; the returned function unbinds it (only while it is still the bound one). */
    bind(binding: EngineLaneBinding): () => void {
      bound = binding;
      return () => {
        if (bound === binding) bound = null;
      };
    },
    guestAppeared: (guest: WebContents): void => bound?.guestAppeared(guest),
    visibilityChanged: (guest: WebContents): void => bound?.visibilityChanged(guest),
  };
}

export type EngineLane = ReturnType<typeof createEngineLane>;

/** CDP over the guest state, with the document readers and settle built on it. */
function createBrowserHostDevtools(
  state: BrowserGuestStateStore,
  urlPolicy: BrowserUrlPolicy,
  permissionRefused: (origin: string, name: string) => boolean
) {
  // The `intercept` command of the host's own path and the engine's `intercept` method each edit a table, and
  // the CDP fetch router reads both, so a rule from either takes effect.
  const intercept = createBrowserIntercept();
  const engineIntercept = createInterceptTable();
  const engineLane = createEngineLane();
  const cdp = createBrowserGuestCdp({
    state,
    permissionRefused,
    engine: engineLane.sink,
    interceptFetchPatterns: (guest) => [
      ...engineIntercept.interceptFetchPatterns(guest),
      ...intercept.interceptFetchPatterns(guest),
    ],
    matchInterceptRule: (guest, url, resourceType) =>
      engineIntercept.matchInterceptRule(guest, url, resourceType) ??
      intercept.matchInterceptRule(guest, url, resourceType),
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
  return { intercept, engineIntercept, engineLane, cdp, documents, settle };
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
    /** Sites may ask to connect a HID device (the `browserHidDevices` setting). */
    hidDevices?: () => boolean;
    /** The saved site-permission defaults and exceptions. */
    permissionPolicy?: BrowserPermissionPolicyStore;
  }
) {
  const state = new BrowserGuestStateStore(sameProcessGuests);
  const approvals = createBrowserActionApproval({
    ask: options.requestApproval || ((request, signal) => requestBrowserApproval(window, request, signal)),
    confirmActions: process.env.MIXDOG_BROWSER_CONFIRM_ACTIONS,
    denyActions: process.env.MIXDOG_BROWSER_DENY_ACTIONS,
    confirmSubmit: !/^(?:0|false|no|off)$/i.test(String(process.env.MIXDOG_BROWSER_CONFIRM_SUBMIT || '').trim()),
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
  /** Whether a command is queued or running on the session's visible pages. */
  const isForegroundBusy = (sessionId: string) => {
    const key = `session:${sessionId}:foreground`;
    return commandChains.has(key) || (pendingReads.get(key)?.size ?? 0) > 0;
  };
  /** The single edge to the display client: a window already torn down simply
   *  stops hearing about browser state, and never fails the work reporting it. */
  const sendToRenderer = (channel: string, ...args: unknown[]): void => {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    window.webContents.send(channel, ...args);
  };

  const urlPolicy = browserUrlPolicyFromEnvironment({ remote: options.remoteSession });
  const urls = createBrowserUrlAdmission({ policy: urlPolicy });
  const nativeView = /^(?:1|true|yes)$/i.test(String(process.env.MIXDOG_BROWSER_NATIVE_VIEW || ''));
  const storage = createBrowserHostStorage(
    window.webContents.session,
    state,
    sessions,
    urls,
    options.onDiagnostic,
    options.hidDevices,
    options.permissionPolicy
  );
  const devtools = createBrowserHostDevtools(state, urlPolicy, storage.partition.permissions.refused);
  const displayTextures = createBrowserHostTextures(window, state);
  const trackedDisplay = createBrowserDisplayTracking(sessions);
  // A page shown or hidden changes its facts (`visible`): the engine lane re-reads them.
  const display: typeof trackedDisplay = {
    ...trackedDisplay,
    setPanelActive(guest, active) {
      trackedDisplay.setPanelActive(guest, active);
      devtools.engineLane.visibilityChanged(guest);
    },
    setNativeShown(sessionId, guest) {
      trackedDisplay.setNativeShown(sessionId, guest);
      for (const page of sessions.visibleGuests(sessionId)) devtools.engineLane.visibilityChanged(page);
    },
  };
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
    isForegroundBusy,
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
