// The browser-mode shim's shared state. Every piece of transport state lives on
// one context object so the modules that own a responsibility (pairing, sync,
// dispatch, liveness, socket, calls) can be read and tested apart while still
// seeing the same connection.
import type {
  DesktopAgentPoolRow,
  DesktopBrowserImportProgress,
  DesktopBrowserOpenRequest,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserTab,
  DesktopLspDiagnosticEvent,
  DesktopLspStatusEvent,
  DesktopSessionSummary,
  DesktopUpdaterState,
  SessionSnapshot,
} from '../shared/contract';
import type { RelayE2EEChannel, RelayE2EEPairingMaterial } from '../shared/remote-e2ee';
import type { ActivityRailPinsState } from '../shared/activity-rail-pins';
import type { ProviderModelsChange } from '../shared/provider-models';
import type { SettingsChange } from '../shared/settings-changed';
import { createKeyedListDeltaDecoder } from '../shared/list-delta';
import { createRemoteCatalog } from '../shared/remote-catalog';
import { createRemoteRosterCache, createIndexedDbRosterStorage } from '../shared/remote-roster-cache';
import { createRemoteViewBaselineCache } from '../shared/remote-view-baseline';
import { createSnapshotDeltaDecoder } from '../main/state-delta';
import { newBrowserId } from './remote-browser-identity';
import { createCompactTranscriptExpander } from './remote-compact-frames';
import { reportRemoteConnectionIssue } from './remote-connection-state';
import {
  REMOTE_PAIRING_STORAGE_KEYS,
  canReuseStoredRemoteClientRegistration,
  clearStoredRemotePairing,
  normalizeRemoteRelayOrigin,
  readRemoteDeviceId,
} from './remote-pairing-recovery';
import { createRemoteSessionInbox } from './remote-session-inbox';
import { createRelayPayloadLimits, showRemoteToast, type PendingCall } from './remote-shim-payload-limit';
import type { createRemotePairingScreen } from './remote-pairing-screen';
import type { createRemoteViewSync } from './remote-view-sync';

export const TOKEN_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.token;
export const SERVER_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.server;
export const BROWSER_ID_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.browserId;
export const DEVICE_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.device;
export const REMOTE_CREDENTIAL_READY_EVENT = 'mixdog:remote-credential-ready';
export const REMOTE_CONNECTION_READY_EVENT = 'mixdog:remote-connection-ready';
export const REMOTE_PAIRING_INVALID_EVENT = 'mixdog:remote-pairing-invalid';
// Sticky proof that this pairing has worked at least once. Without it a browser
// reopened while the desktop sleeps counts three quick retries and throws the
// pairing screen over a perfectly valid pairing.
export const PAIRED_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.paired;
export const E2EE_PUBLIC_KEY_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.e2eePublicKey;
export const E2EE_SECRET_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.e2eeSecret;
export const VISIBLE_SESSIONS_STORAGE_KEY = 'mixdog.remote-visible-sessions';
export const LAST_SESSION_STORAGE_KEY = 'mixdog.desktop-last-session.v1';
export const MAX_RESTORED_VISIBLE_SESSIONS = 8;

/** The connection's mutable state. */
export interface RemoteShimState {
  serverBase: string;
  deviceId: string;
  token: string;
  e2eePairing: RelayE2EEPairingMaterial | null;
  browserId: string;
  clientRegistered: boolean;
  registrationInFlight: Promise<void> | null;
  socket: WebSocket | null;
  openPromise: Promise<WebSocket> | null;
  openingSocket: WebSocket | null;
  openingStartedAt: number;
  retireConnection: ((code?: number, reason?: string) => void) | null;
  // Last visible-session registration. The relay gates per-session transcript
  // frames on a PER CLIENT set, and a reconnect starts a fresh client record
  // with an empty one, so the shim replays this on every reopen.
  //
  // It also OUTLIVES the page. On a cold launch nothing names a session until
  // React has mounted and restored its panes, and only then can the desktop
  // start reading that transcript — a serial chain the user watches as an
  // empty conversation for seconds. The set from the last visit names it while
  // the bundle is still parsing, so the read overlaps the boot.
  lastVisibleSessionIds: string[];
  // A view-synchronizing peer names the restored set in its FIRST sync,
  // whatever the panes registered meanwhile. A phone never restores its panes,
  // so its first React commit registers a fresh New-task pane — before the
  // socket is even open — and that registration used to replace this set: the
  // first sync named nothing and the transcript waited for a second one.
  restoredVisibleSessionIds: string[];
  // The set the latest synchronizeViews request named, in flight or complete.
  // Every connection opens with a new request, so a registration of this same
  // set is already being served and never needs another full sync.
  requestedViewSyncKey: string | null;
  everConnected: boolean;
  everPaired: boolean;
  retryMs: number;
  nextId: number;
  secureChannel: RelayE2EEChannel | null;
  connectionReady: boolean;
  peerViewSync: boolean;
  /** The current host advertised `remoteParity` in its challenge: it serves
   *  this release's remote methods. Absent means an older host. */
  peerRemoteParity: boolean;
  /** The current host advertised `nativePush` in its challenge: it serves
   *  `registerNativePush` for the phone app's APNs/FCM token. */
  peerNativePush: boolean;
  /** The current host advertised `browserParity` in its challenge: it serves
   *  the remote browser pane's tabs, history, saved-login fill and profile
   *  import. Absent means an older host: the pane keeps its single stream. */
  peerBrowserParity: boolean;
  /** The current host serves the encrypted HTTP media lane (`mediaE2ee` in
   *  its challenge). Absent means an older host: media stays on RPC. */
  peerMediaE2ee: boolean;
  /** This connection's media session label (its handshake challenge) once the
   *  media key was handed to the service worker; null otherwise. */
  mediaSid: string | null;
  legacyVisibleSessionsQueue: Promise<unknown>;
  pendingReconnectNotification: boolean;
  // Delta-lane resumption (shared/remote-view-resume.ts). The desktop issues a
  // token with each completed view sync; it stays valid only while every
  // decoder holds exactly what that desktop's encoders sent. A close carries
  // it (and the decoders) over to the next connection's first sync; any gap,
  // resync or reset clears it, and the epoch voids a sync already in flight.
  viewResumeToken: string | null;
  carriedResumeToken: string | null;
  deltaEpoch: number;
  approvalVerificationInFlight: boolean;
  relayBinaryFrames: boolean;
  // Unsolicited resync requests (relay drop hint, foreground wake) share one
  // short debounce: a tab that flips visibility repeatedly must not pull a
  // full transcript per flip, while a real gap still recovers immediately.
  lastResyncAt: number;
  trailingResyncTimer: number | null;
  // NAT/carrier middleboxes silently drop idle WebSockets; the browser
  // cannot send protocol pings, so an app-level ping/pong detects the
  // half-dead socket and recycles it, and a foreground/online wake probe
  // reconnects immediately instead of on the next (hanging) tap.
  heartbeatSentAt: number;
  awaitingPong: boolean;
  wakePongTimer: number | null;
  // Any inbound frame already proves this leg is alive. The keepalive lane
  // therefore exists ONLY for a silent socket: a busy session never spends a
  // probe, and never risks the recycle that a lost pong triggers.
  lastTrafficAt: number;
  backgroundSuspended: boolean;
  resyncOnWake: boolean;
  reconnectTimer: number | null;
  backgroundGraceTimer: number | null;
}

/** The long-lived collaborators every module reads. */
export interface RemoteShimCollaborators {
  pending: Map<number, PendingCall>;
  limits: ReturnType<typeof createRelayPayloadLimits>;
  stateListeners: Set<(snapshot: SessionSnapshot) => void>;
  sessionsCatalog: ReturnType<typeof createRemoteCatalog<DesktopSessionSummary>>;
  agentsCatalog: ReturnType<typeof createRemoteCatalog<DesktopAgentPoolRow>>;
  sessionInbox: ReturnType<typeof createRemoteSessionInbox>;
  termListeners: Set<(event: { id: string; data: string }) => void>;
  folderChangeListeners: Set<(dir: string) => void>;
  activityRailPinsListeners: Set<(state: ActivityRailPinsState) => void>;
  providerModelsListeners: Set<(change: ProviderModelsChange) => void>;
  settingsChangedListeners: Set<(change: SettingsChange) => void>;
  updaterListeners: Set<(state: DesktopUpdaterState) => void>;
  remoteBrowserFrameListeners: Set<(frame: DesktopRemoteBrowserStreamFrame) => void>;
  browserOpenListeners: Set<(request: DesktopBrowserOpenRequest) => void>;
  remoteBrowserTabListeners: Set<(tabs: DesktopRemoteBrowserTab[]) => void>;
  browserImportProgressListeners: Set<(progress: DesktopBrowserImportProgress) => void>;
  lspDiagnosticsListeners: Set<(event: DesktopLspDiagnosticEvent) => void>;
  lspStatusListeners: Set<(event: DesktopLspStatusEvent) => void>;
  // Push lanes this browser actually reads. Terminal output, diagnostics and
  // folder events are produced by DESKTOP activity — a build, a save — and
  // used to reach every paired phone regardless of what it had open, so a
  // phone left connected received entire build logs it never displayed.
  // Registering the lanes stops them at the source. A reconnect replays this
  // exactly like the visible-session set.
  activeLanes: Set<string>;
  viewBaselines: ReturnType<typeof createRemoteViewBaselineCache>;
  sessionsDecoder: ReturnType<typeof createKeyedListDeltaDecoder<DesktopSessionSummary>>;
  agentPoolDecoder: ReturnType<typeof createKeyedListDeltaDecoder<DesktopAgentPoolRow>>;
  rosterCache: ReturnType<typeof createRemoteRosterCache<DesktopSessionSummary>>;
  // State pushes ride the same identity-prefix items delta the desktop IPC
  // uses (state-delta.ts): reassemble full snapshots here, and ask the
  // desktop for a resync when a patch does not match our base revision
  // (mid-stream join through the relay, missed frame).
  stateDecoder: ReturnType<typeof createSnapshotDeltaDecoder>;
  sessionStateDecoders: Map<string, ReturnType<typeof createSnapshotDeltaDecoder>>;
  compactFrames: ReturnType<typeof createCompactTranscriptExpander>;
  // Recycling a silent socket is invisible maintenance: nothing is waiting on
  // an answer, so the redial that follows must not raise the disconnect
  // surface. A close with calls in flight keeps the normal, visible path.
  quietRecycledSockets: WeakSet<WebSocket>;
}

/** What the responsibility modules publish for one another (each install*
 *  function fills in its own part). */
export interface RemoteShimServices {
  // remote-shim-sync.ts
  viewSync: ReturnType<typeof createRemoteViewSync>;
  viewSyncSessionIds: () => string[];
  sessionSetKey: (sessionIds: readonly string[]) => string;
  invalidateViewResume: () => void;
  resetDeltaState: () => void;
  refreshBroadcastLanes: () => void;
  requestResync: () => void;
  applyStatePayload: (payload: unknown) => SessionSnapshot | null;
  // remote-shim-pairing.ts
  currentToken: () => string;
  waitForCredential: () => Promise<void>;
  wsUrl: () => string;
  ensureClientRegistration: () => Promise<void>;
  showPairingScreen: ReturnType<typeof createRemotePairingScreen>;
  adoptApproval: (credential: string, material: RelayE2EEPairingMaterial) => boolean;
  verifyApprovedConnection: () => Promise<void>;
  resetApprovalAndAsk: (message: string) => void;
  // remote-shim-dispatch.ts
  fanOut: <T>(listeners: Set<(value: T) => void>, value: T) => void;
  dispatchState: (snapshot: SessionSnapshot) => void;
  handleMessage: (frame: Record<string, unknown>, authenticated: boolean) => void;
  handleClearResync: (clear: Record<string, unknown>) => void;
  // remote-shim-liveness.ts
  clearWakePongTimer: () => void;
  wakeProbe: (event?: Event) => void;
  scheduleReconnect: () => void;
  // remote-shim-socket.ts
  connect: () => Promise<WebSocket>;
  // remote-shim-calls.ts
  publishLanes: () => void;
  laneSubscription: <T>(lane: string, listeners: Set<T>, listener: T) => () => void;
  invoke: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
  call: <T = unknown>(method: string, params?: unknown[]) => Promise<T>;
  readCatalog: <T>(
    catalog: ReturnType<typeof createRemoteCatalog<T>>,
    method: 'listSessions' | 'listAgentPool'
  ) => Promise<T[]>;
  fire: (method: string, params: unknown[]) => void;
}

export type RemoteShimContext = RemoteShimState & RemoteShimCollaborators & RemoteShimServices;

const restoreVisibleSessionIds = (): string[] => {
  let restored: unknown = [];
  try {
    restored = JSON.parse(localStorage.getItem(VISIBLE_SESSIONS_STORAGE_KEY) || '[]');
  } catch {
    /* fall through to the established last-session key */
  }
  if (Array.isArray(restored)) {
    const sessionIds = restored
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .slice(0, MAX_RESTORED_VISIBLE_SESSIONS);
    if (sessionIds.length > 0) return sessionIds;
  }
  // First launch after this optimization has no dedicated visible-session
  // record yet. The older startup key still names the focused conversation,
  // so that launch receives the same head start instead of waiting one visit.
  try {
    const lastSessionId = localStorage.getItem(LAST_SESSION_STORAGE_KEY) || '';
    return /^[A-Za-z0-9_-]+$/u.test(lastSessionId) ? [lastSessionId] : [];
  } catch {
    return [];
  }
};

/** Read the persisted identity and pairing, then build the context. The
 *  services are absent until the install* functions run. */
export const createRemoteShimContext = (): RemoteShimContext => {
  // The relay serves this container under /d/<deviceId>/, which is the ONE
  // thing an installed web app knows about the desktop it belongs to: an empty
  // storage container inherits nothing, but the URL its install captured says
  // whom to ask for approval. The cookie fallback covers a navigation that
  // landed outside the route.
  let serverBase = '';
  let deviceId = '';
  try {
    const storedServer = localStorage.getItem(SERVER_STORAGE_KEY) || '';
    serverBase = normalizeRemoteRelayOrigin(storedServer) || location.origin;
    if (storedServer && !normalizeRemoteRelayOrigin(storedServer)) {
      clearStoredRemotePairing(localStorage);
    }
    deviceId = readRemoteDeviceId(location.pathname, document.cookie) || localStorage.getItem(DEVICE_STORAGE_KEY) || '';
    if (deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
  } catch {
    /* entry screen */
  }

  // Credentials only ever come from an approval on the desktop, so this
  // container either already holds its own or has to ask for one. Nothing is
  // read out of the URL: the entry link carries a route, never a secret.
  let token = '';
  let e2eePublicKey = '';
  let e2eeSecret = '';
  try {
    token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    e2eePublicKey = localStorage.getItem(E2EE_PUBLIC_KEY_STORAGE_KEY) || '';
    e2eeSecret = localStorage.getItem(E2EE_SECRET_STORAGE_KEY) || '';
  } catch {
    /* token stays empty; the entry screen asks for approval */
  }
  const e2eePairing: RelayE2EEPairingMaterial | null =
    e2eePublicKey && e2eeSecret ? { version: 1, serverPublicKey: e2eePublicKey, pairingSecret: e2eeSecret } : null;
  let browserId = '';
  try {
    browserId = localStorage.getItem(BROWSER_ID_STORAGE_KEY) || newBrowserId();
    localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId);
  } catch {
    browserId = newBrowserId();
  }
  let everPaired = false;
  try {
    everPaired = localStorage.getItem(PAIRED_STORAGE_KEY) === '1';
  } catch {
    /* no storage */
  }
  const lastVisibleSessionIds = restoreVisibleSessionIds();
  const hidden = document.visibilityState === 'hidden';

  const ctx = {} as RemoteShimContext;
  const pending = new Map<number, PendingCall>();
  const sessionsDecoder = createKeyedListDeltaDecoder<DesktopSessionSummary>();
  const state: RemoteShimState = {
    serverBase,
    deviceId,
    token,
    e2eePairing,
    browserId,
    clientRegistered: canReuseStoredRemoteClientRegistration({
      everPaired,
      token,
      hasE2eePairing: Boolean(e2eePairing),
    }),
    registrationInFlight: null,
    socket: null,
    openPromise: null,
    openingSocket: null,
    openingStartedAt: 0,
    retireConnection: null,
    lastVisibleSessionIds,
    restoredVisibleSessionIds: [...lastVisibleSessionIds],
    requestedViewSyncKey: null,
    everConnected: false,
    everPaired,
    retryMs: 500,
    nextId: 1,
    secureChannel: null,
    connectionReady: false,
    peerViewSync: false,
    peerRemoteParity: false,
    peerNativePush: false,
    peerBrowserParity: false,
    peerMediaE2ee: false,
    mediaSid: null,
    legacyVisibleSessionsQueue: Promise.resolve(),
    pendingReconnectNotification: false,
    viewResumeToken: null,
    carriedResumeToken: null,
    deltaEpoch: 0,
    approvalVerificationInFlight: false,
    relayBinaryFrames: false,
    lastResyncAt: 0,
    trailingResyncTimer: null,
    heartbeatSentAt: 0,
    awaitingPong: false,
    wakePongTimer: null,
    lastTrafficAt: 0,
    backgroundSuspended: hidden,
    resyncOnWake: hidden,
    reconnectTimer: null,
    backgroundGraceTimer: null,
  };
  const collaborators: RemoteShimCollaborators = {
    pending,
    limits: createRelayPayloadLimits({ pending, showToast: showRemoteToast }),
    stateListeners: new Set(),
    sessionsCatalog: createRemoteCatalog<DesktopSessionSummary>(),
    agentsCatalog: createRemoteCatalog<DesktopAgentPoolRow>(),
    sessionInbox: createRemoteSessionInbox({ onGap: () => ctx.requestResync() }),
    termListeners: new Set(),
    folderChangeListeners: new Set(),
    activityRailPinsListeners: new Set(),
    providerModelsListeners: new Set(),
    settingsChangedListeners: new Set(),
    updaterListeners: new Set(),
    remoteBrowserFrameListeners: new Set(),
    browserOpenListeners: new Set(),
    remoteBrowserTabListeners: new Set(),
    browserImportProgressListeners: new Set(),
    lspDiagnosticsListeners: new Set(),
    lspStatusListeners: new Set(),
    activeLanes: new Set(),
    viewBaselines: createRemoteViewBaselineCache(),
    sessionsDecoder,
    agentPoolDecoder: createKeyedListDeltaDecoder<DesktopAgentPoolRow>(),
    // Keyed to this pairing: another desktop or a re-pair never reads it.
    rosterCache: createRemoteRosterCache<DesktopSessionSummary>({
      storage: createIndexedDbRosterStorage(),
      scope: () =>
        ctx.e2eePairing
          ? [ctx.serverBase, ctx.deviceId, ctx.e2eePairing.serverPublicKey, ctx.e2eePairing.pairingSecret].join('\n')
          : null,
      decoder: sessionsDecoder,
      onMismatch: () => {
        reportRemoteConnectionIssue('sessions-gap');
        ctx.requestResync();
      },
    }),
    stateDecoder: createSnapshotDeltaDecoder(),
    sessionStateDecoders: new Map(),
    compactFrames: createCompactTranscriptExpander(),
    quietRecycledSockets: new WeakSet(),
  };
  return Object.assign(ctx, state, collaborators);
};
