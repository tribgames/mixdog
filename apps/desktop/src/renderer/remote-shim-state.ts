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
import type { RemoteWebrtcDesktopSignal } from '../shared/remote-webrtc';
import type { ActivityRailPinsState } from '../shared/activity-rail-pins';
import type { ProviderModelsChange } from '../shared/provider-models';
import type { SettingsChange } from '../shared/settings-changed';
import type { OrchestrationModeChange } from '../shared/orchestration-mode';
import type { DesktopVisualizeEvent } from '../shared/visualize';
import type { DesktopTerminalRunRequest } from '../shared/terminal-command';
import { createKeyedListDeltaDecoder } from '../shared/list-delta';
import { createRemoteCatalog } from '../shared/remote-catalog';
import { createRemoteRosterCache } from '../shared/remote-roster-cache';
import { createRemoteViewBaselineCache } from '../shared/remote-view-baseline';
import { createSnapshotDeltaDecoder } from '../main/state-delta';
import { newBrowserId } from './remote-browser-identity';
import { createCompactTranscriptExpander } from './remote-compact-frames';
import { REMOTE_CONNECTION_READY_EVENT, reportRemoteConnectionIssue } from './remote-connection-state';
import {
  REMOTE_PAIRING_STORAGE_KEYS,
  canReuseStoredRemoteClientRegistration,
  clearStoredRemotePairing,
  migrateLegacyRemotePairing,
  normalizeRemoteRelayOrigin,
  readRemoteDeviceId,
  remotePairingKeys,
  type RemotePairingKeys,
} from './remote-pairing-recovery';
import {
  createRemotePageCache,
  createRemoteTransportMediaClient,
  type RemotePageCache,
  type RemoteTransportMediaClient,
} from './remote-file-preview';
import { createRemoteSessionInbox } from './remote-session-inbox';
import type { RemoteTransportPeer } from './remote-transport-peer';
import { createRelayPayloadLimits, showRemoteToast, type PendingCall } from './remote-shim-payload-limit';
import type { createRemotePairingScreen } from './remote-pairing-screen';
import type { createRemoteViewSync } from './remote-view-sync';
import type { TerminalSizeOwnerEvent } from '../shared/terminal-size-owner';
import type { TerminalActivityEvent } from '../shared/terminal-activity';

export const DEVICE_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.device;
export const REMOTE_CREDENTIAL_READY_EVENT = 'mixdog:remote-credential-ready';
export { REMOTE_CONNECTION_READY_EVENT };
export const REMOTE_PAIRING_INVALID_EVENT = 'mixdog:remote-pairing-invalid';
/** The E2EE channel to the PC is up (before any view sync). */
export const REMOTE_SECURE_CHANNEL_READY_EVENT = 'mixdog:remote-secure-channel-ready';
export const VISIBLE_SESSIONS_STORAGE_KEY = 'mixdog.remote-visible-sessions';
const LAST_SESSION_STORAGE_KEY = 'mixdog.desktop-last-session.v1';
export const MAX_RESTORED_VISIBLE_SESSIONS = 8;

/** The connection's mutable state. */
export interface RemoteShimState {
  serverBase: string;
  deviceId: string;
  /** Storage keys of THIS relay origin + device's pairing. */
  pairingKeys: RemotePairingKeys;
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
  // The sessions this page actually paints (use-visible-sessions'
  // useScreenSessions), apart from the delivery set above that also carries
  // background observations. The desktop decides notification presence from
  // it alone; every new leg is told again once it is ready.
  lastScreenSessionIds: string[];
  // The set the latest synchronizeViews request named, in flight or complete.
  // Every connection opens with a new request, so a registration of this same
  // set is already being served and never needs another full sync.
  requestedViewSyncKey: string | null;
  everConnected: boolean;
  everPaired: boolean;
  /** This container's id was already in storage when it booted. */
  browserIdStored: boolean;
  retryMs: number;
  nextId: number;
  secureChannel: RelayE2EEChannel | null;
  /** The current session's transport stream, when the handshake negotiated
   *  one; null on a legacy session. */
  transport: RemoteTransportPeer | null;
  /** The transport session's media adapter client (1D), beside `transport`. */
  transportMedia: RemoteTransportMediaClient | null;
  /** Builds it per transport session; tests substitute a fake. */
  createTransportMedia: typeof createRemoteTransportMediaClient;
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
  /** The current host advertised `browserDrive` in its challenge: it takes the
   *  remote browser pane's `viewport` control. Absent means an older host,
   *  which rejects that control: the pane never sends it. */
  peerBrowserDrive: boolean;
  /** The current host advertised `browserSessionTabs`: a conversation browser's
   *  tabs ride its frames and its tab controls are accepted. */
  peerBrowserSessionTabs: boolean;
  /** The current host advertised `termSizeOwner`: it honors the size-owner
   *  flag on `termResize`. Absent means an older host: never send the 0x0
   *  release or owner heartbeats. */
  peerTermSizeOwner: boolean;
  /** The current host advertised `hostDirectories`: it serves
   *  `listHostDirectories`. Absent means an older host. */
  peerHostDirectories: boolean;
  peerProjectRecovery: boolean;
  /** The current host advertised `routeAutoEffort` in its challenge: it takes
   *  `autoEffort` in model selections and `+noauto` automation refs. */
  peerRouteAutoEffort: boolean;
  /** The current host advertised `visualize`: it serves the agent visualize
   *  panel's state, tab commands and pane reads. Absent means an older host. */
  peerVisualize: boolean;
  /** The current host advertised `fileDownloads`: it serves the host file
   *  download lane (shared/file-downloads.ts). Absent means an older host. */
  peerFileDownloads: boolean;
  /** The current host advertised `browserWebrtc` (shared/remote-webrtc.ts):
   *  its value when it is the version this client speaks, else 0. */
  peerBrowserWebrtc: number;
  /** Whether the current host advertised `browserFit`
   *  (REMOTE_BROWSER_FIT_CAPABILITY); null while no host is authenticated
   *  (disconnected or mid-handshake): not known either way. */
  peerBrowserFit: boolean | null;
  /** The current host serves the encrypted HTTP media lane (`mediaE2ee` in
   *  its challenge). Absent means an older host: media stays on RPC. */
  peerMediaE2ee: boolean;
  /** This connection's media session label (its handshake challenge) once the
   *  media key was handed to the service worker; null otherwise. */
  mediaSid: string | null;
  legacyVisibleSessionsQueue: Promise<unknown>;
  pendingReconnectNotification: boolean;
  // Delta-lane resumption (shared/remote-view-resume.ts). The desktop issues a
  // token with each completed view sync; it stays valid while every decoder
  // holds a revision that desktop's encoders emitted and still retain — their
  // latest one, or an older one kept in their bounded revision history (a
  // frame lost in flight, updates missed while away). The desktop rewinds to
  // that revision and sends deltas; an unknown or evicted revision gets a full
  // snapshot instead. A close carries the token (and the decoders) over to the
  // next connection's first sync; a local decoder gap, resync or reset clears
  // it, and the epoch voids a sync already in flight.
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
  // The open leg the page went into the background with (or a wake probed),
  // until a wake probe proves it again. Its death is the background's cost,
  // so its redial runs silently instead of raising the disconnect surface.
  unprovenSocket: WebSocket | null;
  // The resync a wake asked for, sent once that wake's probe is answered.
  resyncAfterWakeProbe: boolean;
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
  termSizeOwnerListeners: Set<(event: TerminalSizeOwnerEvent) => void>;
  termActivityListeners: Set<(event: TerminalActivityEvent) => void>;
  folderChangeListeners: Set<(dir: string) => void>;
  activityRailPinsListeners: Set<(state: ActivityRailPinsState) => void>;
  providerModelsListeners: Set<(change: ProviderModelsChange) => void>;
  settingsChangedListeners: Set<(change: SettingsChange) => void>;
  orchestrationModeListeners: Set<(change: OrchestrationModeChange) => void>;
  updaterListeners: Set<(state: DesktopUpdaterState) => void>;
  remoteBrowserFrameListeners: Set<(frame: DesktopRemoteBrowserStreamFrame) => void>;
  remoteBrowserWebrtcListeners: Set<(signal: RemoteWebrtcDesktopSignal) => void>;
  browserOpenListeners: Set<(request: DesktopBrowserOpenRequest) => void>;
  terminalRunListeners: Set<(request: DesktopTerminalRunRequest) => void>;
  remoteBrowserTabListeners: Set<(tabs: DesktopRemoteBrowserTab[]) => void>;
  browserImportProgressListeners: Set<(progress: DesktopBrowserImportProgress) => void>;
  lspDiagnosticsListeners: Set<(event: DesktopLspDiagnosticEvent) => void>;
  lspStatusListeners: Set<(event: DesktopLspStatusEvent) => void>;
  visualizeListeners: Set<(event: DesktopVisualizeEvent) => void>;
  browserApprovalSessionListeners: Set<(sessionIds: string[]) => void>;
  /** The last browser-approval session list the PC sent (each handshake sends one). */
  browserApprovalSessionIds: string[];
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
  /** Visualize pages built over this pairing (memory-only). */
  visualizePages: RemotePageCache;
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
  adoptApproval: (credential: string, material: RelayE2EEPairingMaterial) => Promise<boolean>;
  /** Fill a credential missing from localStorage from its durable copy. */
  restoreDurablePairing: () => Promise<void>;
  verifyApprovedConnection: () => Promise<void>;
  resetApprovalAndAsk: (message: string) => void;
  // remote-shim-dispatch.ts
  fanOut: <T>(listeners: Set<(value: T) => void>, value: T) => void;
  dispatchState: (snapshot: SessionSnapshot) => void;
  handleMessage: (frame: Record<string, unknown>, authenticated: boolean) => void;
  handleClearResync: (clear: Record<string, unknown>) => void;
  // remote-shim-liveness.ts
  clearWakePongTimer: () => void;
  answerWakeProbe: () => void;
  wakeProbe: (event?: Event) => void;
  scheduleReconnect: (fleet?: boolean) => void;
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
  /** `fire` that settles true once a transport session handed the frame to
   *  a carrier, false at once when it cannot right away (or off transport). */
  fireHanded: (method: string, params: unknown[]) => Promise<boolean>;
  /** The PC answered call `id` (or named it in a refusal): its transport
   *  credit returns, whether or not the caller is still waiting. */
  settleCallCredit: (id: number) => void;
  /** The PC leg behind `ws` is gone: every credit its calls held returns. */
  retireCallCredits: (ws: WebSocket) => void;
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
  let keys = remotePairingKeys(location.origin, '');
  try {
    // Before the device label is overwritten by this route: credentials from
    // before namespacing belong to the device that label names.
    migrateLegacyRemotePairing(localStorage, location.origin);
    deviceId = readRemoteDeviceId(location.pathname, document.cookie) || localStorage.getItem(DEVICE_STORAGE_KEY) || '';
    keys = remotePairingKeys(location.origin, deviceId);
    const storedServer = localStorage.getItem(keys.server) || '';
    serverBase = normalizeRemoteRelayOrigin(storedServer) || location.origin;
    if (storedServer && !normalizeRemoteRelayOrigin(storedServer)) {
      clearStoredRemotePairing(localStorage, keys);
    }
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
    token = localStorage.getItem(keys.token) || '';
    e2eePublicKey = localStorage.getItem(keys.e2eePublicKey) || '';
    e2eeSecret = localStorage.getItem(keys.e2eeSecret) || '';
  } catch {
    /* token stays empty; the entry screen asks for approval */
  }
  const e2eePairing: RelayE2EEPairingMaterial | null =
    e2eePublicKey && e2eeSecret ? { version: 1, serverPublicKey: e2eePublicKey, pairingSecret: e2eeSecret } : null;
  let browserId = '';
  let browserIdStored = false;
  try {
    const storedBrowserId = localStorage.getItem(keys.browserId) || '';
    browserIdStored = Boolean(storedBrowserId);
    browserId = storedBrowserId || newBrowserId();
    localStorage.setItem(keys.browserId, browserId);
  } catch {
    browserId = newBrowserId();
  }
  let everPaired = false;
  try {
    everPaired = localStorage.getItem(keys.paired) === '1';
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
    pairingKeys: keys,
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
    lastScreenSessionIds: [],
    requestedViewSyncKey: null,
    everConnected: false,
    everPaired,
    browserIdStored,
    retryMs: 0,
    nextId: 1,
    secureChannel: null,
    transport: null,
    transportMedia: null,
    createTransportMedia: createRemoteTransportMediaClient,
    connectionReady: false,
    peerViewSync: false,
    peerRemoteParity: false,
    peerNativePush: false,
    peerBrowserParity: false,
    peerBrowserDrive: false,
    peerBrowserSessionTabs: false,
    peerTermSizeOwner: false,
    peerHostDirectories: false,
    peerProjectRecovery: false,
    peerRouteAutoEffort: false,
    peerVisualize: false,
    peerFileDownloads: false,
    peerBrowserWebrtc: 0,
    peerBrowserFit: null,
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
    unprovenSocket: null,
    resyncAfterWakeProbe: false,
    backgroundSuspended: hidden,
    resyncOnWake: hidden,
    reconnectTimer: null,
    backgroundGraceTimer: null,
  };
  // The authenticated pairing (server, device, keys) per-connection caches
  // are keyed to; none without one.
  const pairingScope = (): string | null =>
    ctx.e2eePairing
      ? [ctx.serverBase, ctx.deviceId, ctx.e2eePairing.serverPublicKey, ctx.e2eePairing.pairingSecret].join('\n')
      : null;
  const collaborators: RemoteShimCollaborators = {
    pending,
    limits: createRelayPayloadLimits({ pending, showToast: showRemoteToast }),
    stateListeners: new Set(),
    sessionsCatalog: createRemoteCatalog<DesktopSessionSummary>(),
    agentsCatalog: createRemoteCatalog<DesktopAgentPoolRow>(),
    sessionInbox: createRemoteSessionInbox({ onGap: () => ctx.requestResync() }),
    termListeners: new Set(),
    termSizeOwnerListeners: new Set(),
    termActivityListeners: new Set(),
    folderChangeListeners: new Set(),
    activityRailPinsListeners: new Set(),
    providerModelsListeners: new Set(),
    settingsChangedListeners: new Set(),
    orchestrationModeListeners: new Set(),
    updaterListeners: new Set(),
    remoteBrowserFrameListeners: new Set(),
    remoteBrowserWebrtcListeners: new Set(),
    browserOpenListeners: new Set(),
    terminalRunListeners: new Set(),
    remoteBrowserTabListeners: new Set(),
    browserImportProgressListeners: new Set(),
    lspDiagnosticsListeners: new Set(),
    lspStatusListeners: new Set(),
    visualizeListeners: new Set(),
    browserApprovalSessionListeners: new Set(),
    browserApprovalSessionIds: [],
    activeLanes: new Set(),
    viewBaselines: createRemoteViewBaselineCache(),
    sessionsDecoder,
    agentPoolDecoder: createKeyedListDeltaDecoder<DesktopAgentPoolRow>(),
    // Keyed to this pairing: another desktop or a re-pair never reads it.
    // Memory-only: the rows carry conversation titles, which the phone/browser
    // never keeps on the device (remote-conversation-privacy.ts).
    rosterCache: createRemoteRosterCache<DesktopSessionSummary>({
      storage: null,
      scope: pairingScope,
      decoder: sessionsDecoder,
      onMismatch: () => {
        reportRemoteConnectionIssue('sessions-gap');
        ctx.requestResync();
      },
    }),
    // Another pairing (re-pair, another desktop, signed out) reads none of it.
    visualizePages: createRemotePageCache(pairingScope),
    stateDecoder: createSnapshotDeltaDecoder(),
    sessionStateDecoders: new Map(),
    compactFrames: createCompactTranscriptExpander(),
    quietRecycledSockets: new WeakSet(),
  };
  return Object.assign(ctx, state, collaborators);
};
