// Browser-mode DesktopApi: when the Relay serves this page to a phone/tablet,
// install a WebSocket-backed implementation of window.mixdogDesktop before
// any module reads it.
// Inside Electron the preload bridge already exists and this is a no-op.
import type {
  DesktopApi,
  DesktopCapabilityRequest,
  DesktopCapabilityResult,
  DesktopAgentPoolRow,
  DesktopLspDiagnosticEvent,
  DesktopLspStatusEvent,
  DesktopSessionSummary,
  DesktopSessionStateUpdate,
  SessionSnapshot,
} from '../shared/contract';
import {
  createRelayE2EEClientHandshake,
  isRelayE2EEChallenge,
  type RelayE2EEChannel,
  type RelayE2EEPairingMaterial,
} from '../shared/remote-e2ee';
import { isRemotePaintProbe } from '../shared/remote-performance';
import { earlyUiT } from './early-ui-i18n';
import {
  RELAY_PAYLOAD_TOO_LARGE_CODE,
  RELAY_ROUTING_CAPS_EVENT,
  readRelayPayloadRejection,
  readRelayUplinkCeilings,
  relayFrameByteLength,
  relayFrameCallId,
  relayFrameCapRefusal,
  relayPayloadTooLargeMessage,
  relayStrandedCallRefusals,
  relayUplinkContract,
  resolveRelayFrameLimit,
  type RelayInflightFrame,
  type RelayPayloadRejection,
  type RelayUplinkCeilings,
} from '../shared/remote-payload-limit';
import { createKeyedListDeltaDecoder } from '../shared/list-delta';
import { createRemoteCatalog } from '../shared/remote-catalog';
import {
  REMOTE_PAIRING_STORAGE_KEYS,
  canReuseStoredRemoteClientRegistration,
  clearStoredRemotePairing,
  isInvalidRemotePairingClose,
  isRemoteClientCredential,
  normalizeRemoteRelayOrigin,
  readRemoteDeviceId,
} from './remote-pairing-recovery';
import { createSnapshotDeltaDecoder } from '../main/state-delta';
import { armRemoteCallDeadline } from './remote-call-deadline';
import { browserProfile, newBrowserId } from './remote-browser-identity';
import { REMOTE_BROWSER_FALLBACKS } from './remote-browser-fallbacks';
import { createCompactTranscriptExpander, markCompactPayload } from './remote-compact-frames';
import { createRemotePairingScreen } from './remote-pairing-screen';
import { createRemoteSessionInbox } from './remote-session-inbox';
import { createRemoteViewSync } from './remote-view-sync';
import { createRemoteViewBaselineCache, VIEW_BASELINE_EVENT } from '../shared/remote-view-baseline';
import { createViewResumeRequest, readViewResumeGrant, type ViewResumePoint } from '../shared/remote-view-resume';
import { recoverableCreation } from './recoverable-creation';
import { isInstalledMobileWebAppSurface } from './mobile-surface';
import {
  REMOTE_WAKE_EVENT,
  beginRemoteConnectionTimeline,
  takeRemoteConnectionTimeline,
  clearRemoteConnectionState,
  remoteConnectionInterruptedError,
  reportRemoteConnectionIssue,
  setRemoteConnectionPhase,
  setRemoteConnectionState,
  shouldRunRemoteHeartbeat,
  type RemoteConnectionIssue,
} from './remote-connection-state';

const TOKEN_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.token;
const SERVER_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.server;
const BROWSER_ID_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.browserId;
const DEVICE_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.device;
const REMOTE_CREDENTIAL_READY_EVENT = 'mixdog:remote-credential-ready';
const REMOTE_CONNECTION_READY_EVENT = 'mixdog:remote-connection-ready';
const REMOTE_PAIRING_INVALID_EVENT = 'mixdog:remote-pairing-invalid';
// Sticky proof that this pairing has worked at least once. Without it a browser
// reopened while the desktop sleeps counts three quick retries and throws the
// pairing screen over a perfectly valid pairing.
const PAIRED_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.paired;
const E2EE_PUBLIC_KEY_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.e2eePublicKey;
const E2EE_SECRET_STORAGE_KEY = REMOTE_PAIRING_STORAGE_KEYS.e2eeSecret;

(() => {
  const w = window as Window & { mixdogDesktop?: DesktopApi };
  if (w.mixdogDesktop || typeof WebSocket === 'undefined') return;

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

  // ?token= wins and is persisted for reconnects. Relay E2EE material rides
  // the fragment so it never reaches relay HTTP logs; strip both after use.
  let token = '';
  let e2eePublicKey = '';
  let e2eeSecret = '';
  // Credentials only ever come from an approval on the desktop, so this
  // container either already holds its own or has to ask for one. Nothing is
  // read out of the URL: the entry link carries a route, never a secret.
  try {
    token = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    e2eePublicKey = localStorage.getItem(E2EE_PUBLIC_KEY_STORAGE_KEY) || '';
    e2eeSecret = localStorage.getItem(E2EE_SECRET_STORAGE_KEY) || '';
  } catch {
    /* token stays empty; the entry screen asks for approval */
  }
  let e2eePairing: RelayE2EEPairingMaterial | null =
    e2eePublicKey && e2eeSecret ? { version: 1, serverPublicKey: e2eePublicKey, pairingSecret: e2eeSecret } : null;
  let browserId = '';
  try {
    browserId = localStorage.getItem(BROWSER_ID_STORAGE_KEY) || newBrowserId();
    localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId);
  } catch {
    browserId = newBrowserId();
  }
  let clientRegistered = false;
  let registrationInFlight: Promise<void> | null = null;

  interface PendingCall {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    /** The frame this call actually sent. Recorded on the call itself so a
     *  ceiling that drops while it is in flight can be applied to it by its
     *  OWN size — never by matching a refusal's size to a list of recent
     *  frames, which is what made attribution guesswork. */
    frame?: RelayInflightFrame;
  }
  // The relay's per-frame ceiling as this browser knows it: handed over with
  // the E2EE handshake, and tightened by any refusal notice that proves a
  // smaller one. Until then the shared conservative default applies, so an
  // oversize request is never sent on the assumption that it might fit.
  let learnedFrameLimit: number | null = null;
  /** Capacity of the leg that receives this frame once the relay has wrapped
   *  it. Only a desktop that publishes no ceilings leaves this doing any work:
   *  it is the input the conservative derivation is priced from. */
  let learnedRoutedLimit: number | null = null;
  /** The relay's own ceilings for this connection, forwarded by the desktop
   *  from `relay-capabilities`. This is the contract: the relay published what
   *  it will admit, so the browser refuses at exactly that byte instead of
   *  deriving a second opinion from a capacity and an assumed envelope. */
  let publishedCeilings: RelayUplinkCeilings | null = null;
  // The desktop leg accepted the text-flagged binary envelope, so a text frame
  // is wrapped at a FIXED cost there instead of being JSON-escaped. Only the
  // fallback prices that itself; a published text ceiling already reflects it.
  let relayTextEnvelope = false;
  const relayFrameLimit = (): number => resolveRelayFrameLimit(learnedFrameLimit);
  /** The ceilings this leg enforces before it sends anything: the relay's
   *  published ones, bounded by any smaller ceiling a refusal notice has since
   *  proved. A desktop that publishes none (an older build) falls back to the
   *  conservative derivation, which is never the more permissive of the two. */
  const relayUplinkLimits = (): RelayUplinkCeilings =>
    relayUplinkContract(publishedCeilings, {
      policy: relayFrameLimit(),
      capacity: learnedRoutedLimit,
      textFrames: relayTextEnvelope,
    });
  const learnFrameLimit = (candidate: unknown): void => {
    if (typeof candidate !== 'number') return;
    learnedFrameLimit = resolveRelayFrameLimit(candidate, learnedFrameLimit);
  };
  /** Learned caps describe ONE connection: they only ever tighten, so carrying
   *  them across a redial keeps a restarted relay's smaller ceiling forever and
   *  refuses frames the new path accepts. Every connection starts unlearned. */
  const resetLearnedCaps = (): void => {
    learnedFrameLimit = null;
    learnedRoutedLimit = null;
    publishedCeilings = null;
    relayTextEnvelope = false;
  };
  /** Everything the desktop declared when the secure channel opened: the
   *  relay's policy ceiling, the ceilings it published for this connection,
   *  and how a text frame will be wrapped. */
  const learnRoutingCaps = (message: Record<string, unknown>): void => {
    learnFrameLimit(message.maxFrameBytes);
    if (typeof message.maxRoutedBytes === 'number') {
      learnedRoutedLimit = resolveRelayFrameLimit(message.maxRoutedBytes, learnedRoutedLimit);
    }
    publishedCeilings = readRelayUplinkCeilings(message);
    relayTextEnvelope = message.textFrames === 1;
  };
  const pending = new Map<number, PendingCall>();
  const stateListeners = new Set<(snapshot: SessionSnapshot) => void>();
  const sessionsCatalog = createRemoteCatalog<DesktopSessionSummary>();
  const agentsCatalog = createRemoteCatalog<DesktopAgentPoolRow>();
  const sessionInbox = createRemoteSessionInbox({ onGap: () => requestResync() });
  const termListeners = new Set<(event: { id: string; data: string }) => void>();
  const folderChangeListeners = new Set<(dir: string) => void>();
  const lspDiagnosticsListeners = new Set<(event: DesktopLspDiagnosticEvent) => void>();
  const lspStatusListeners = new Set<(event: DesktopLspStatusEvent) => void>();
  let socket: WebSocket | null = null;
  let openPromise: Promise<WebSocket> | null = null;
  let openingSocket: WebSocket | null = null;
  let openingStartedAt = 0;
  let retireConnection: ((code?: number, reason?: string) => void) | null = null;
  // Last visible-session registration. The relay gates per-session transcript
  // frames on a PER CLIENT set, and a reconnect starts a fresh client record
  // with an empty one, so the shim replays this on every reopen.
  //
  // It also OUTLIVES the page. On a cold launch nothing names a session until
  // React has mounted and restored its panes, and only then can the desktop
  // start reading that transcript — a serial chain the user watches as an
  // empty conversation for seconds. The set from the last visit names it while
  // the bundle is still parsing, so the read overlaps the boot.
  const VISIBLE_SESSIONS_STORAGE_KEY = 'mixdog.remote-visible-sessions';
  const LAST_SESSION_STORAGE_KEY = 'mixdog.desktop-last-session.v1';
  const MAX_RESTORED_VISIBLE_SESSIONS = 8;
  let lastVisibleSessionIds: string[] = (() => {
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
  })();
  // A view-synchronizing peer names the restored set in its FIRST sync,
  // whatever the panes registered meanwhile. A phone never restores its panes,
  // so its first React commit registers a fresh New-task pane — before the
  // socket is even open — and that registration used to replace this set: the
  // first sync named nothing and the transcript waited for a second one.
  let restoredVisibleSessionIds: string[] = [...lastVisibleSessionIds];
  const viewSyncSessionIds = (): string[] =>
    restoredVisibleSessionIds.length > 0
      ? [...new Set([...lastVisibleSessionIds, ...restoredVisibleSessionIds])]
      : lastVisibleSessionIds;
  const sessionSetKey = (sessionIds: readonly string[]): string => [...new Set(sessionIds)].sort().join('\0');
  // The set the latest synchronizeViews request named, in flight or complete.
  // Every connection opens with a new request, so a registration of this same
  // set is already being served and never needs another full sync.
  let requestedViewSyncKey: string | null = null;
  // Push lanes this browser actually reads. Terminal output, diagnostics and
  // folder events are produced by DESKTOP activity — a build, a save — and
  // used to reach every paired phone regardless of what it had open, so a
  // phone left connected received entire build logs it never displayed.
  // Registering the lanes stops them at the source. A reconnect replays this
  // exactly like the visible-session set.
  const activeLanes = new Set<string>();
  const publishLanes = (): void => {
    void call<boolean>('setRemoteLanes', [[...activeLanes]]).catch(() => {
      // A missed registration is repaired by the reconnect replay.
    });
  };
  const laneSubscription = <T>(lane: string, listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      activeLanes.add(lane);
      publishLanes();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        activeLanes.delete(lane);
        publishLanes();
      }
    };
  };
  let everConnected = false;
  let everPaired = false;
  try {
    everPaired = localStorage.getItem(PAIRED_STORAGE_KEY) === '1';
  } catch {
    /* no storage */
  }
  clientRegistered = canReuseStoredRemoteClientRegistration({
    everPaired,
    token,
    hasE2eePairing: Boolean(e2eePairing),
  });
  let retryMs = 500;
  let nextId = 1;
  let secureChannel: RelayE2EEChannel | null = null;
  let connectionReady = false;
  let peerViewSync = false;
  let legacyVisibleSessionsQueue: Promise<unknown> = Promise.resolve();
  let pendingReconnectNotification = false;
  const viewBaselines = createRemoteViewBaselineCache();
  // Delta-lane resumption (shared/remote-view-resume.ts). The desktop issues a
  // token with each completed view sync; it stays valid only while every
  // decoder holds exactly what that desktop's encoders sent. A close carries
  // it (and the decoders) over to the next connection's first sync; any gap,
  // resync or reset clears it, and the epoch voids a sync already in flight.
  let viewResumeToken: string | null = null;
  let carriedResumeToken: string | null = null;
  let deltaEpoch = 0;
  const invalidateViewResume = (): void => {
    viewResumeToken = null;
    carriedResumeToken = null;
    deltaEpoch += 1;
  };
  const viewSync = createRemoteViewSync({
    synchronize: async () => {
      setRemoteConnectionPhase('sync');
      const sessionIds = viewSyncSessionIds();
      requestedViewSyncKey = sessionSetKey(sessionIds);
      const resumeToken = carriedResumeToken;
      carriedResumeToken = null;
      viewResumeToken = null;
      const epoch = deltaEpoch;
      // Captured synchronously: a frame landing while the digests are computed
      // replaces decoder state instead of mutating what was captured.
      const points = resumeToken
        ? {
            state: stateDecoder.resumePoint(),
            sessions: sessionsDecoder.resumePoint(),
            agentPool: agentPoolDecoder.resumePoint(),
            sessionStates: sessionIds.map((sessionId): [string, ViewResumePoint | null] => [
              sessionId,
              sessionStateDecoders.get(sessionId)?.resumePoint() ?? null,
            ]),
          }
        : null;
      const resume = await createViewResumeRequest(resumeToken, points);
      const retained = viewBaselines.begin();
      try {
        const result = await invoke('synchronizeViews', [sessionIds, retained.offer, resume]);
        restoredVisibleSessionIds = [];
        if (epoch === deltaEpoch) viewResumeToken = readViewResumeGrant(result);
        // A resumed sync may resend no transcript: the phone already shows
        // it, so the wait ends at the receipt instead of going unreported.
        if (resumeToken) {
          const timeline = takeRemoteConnectionTimeline('resumed');
          if (timeline) fire('reportConnectionTimeline', [timeline]);
        }
        return result;
      } finally {
        retained.finish();
      }
    },
    state: (state) => {
      setRemoteConnectionState(state);
      if (state !== 'connected') return;
      window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
      publishLanes();
      if (pendingReconnectNotification) {
        pendingReconnectNotification = false;
        window.dispatchEvent(new Event('mixdog:remote-reconnected'));
      }
    },
    error: (error) => {
      reportRemoteConnectionIssue('sync-failed', error);
      console.warn('[mixdog-remote] view synchronization failed; retrying', error);
    },
    interrupted: remoteConnectionInterruptedError,
  });
  let approvalVerificationInFlight = false;
  let relayBinaryFrames = false;
  const sessionsDecoder = createKeyedListDeltaDecoder<DesktopSessionSummary>();
  const agentPoolDecoder = createKeyedListDeltaDecoder<DesktopAgentPoolRow>();

  // Another tab shares localStorage and may have re-registered this browser,
  // rotating the per-browser credential; always dial with the freshest one.
  const currentToken = (): string => {
    try {
      const stored = localStorage.getItem(TOKEN_STORAGE_KEY) || '';
      if (stored && isRemoteClientCredential(stored)) token = stored;
    } catch {
      /* keep the in-memory token */
    }
    return token;
  };

  // React mounts behind the pairing layer and immediately asks for snapshots.
  // Those calls must wait for the approval handoff instead of registering with
  // an empty token and turning a healthy in-progress claim into a 401 reset.
  const waitForCredential = (): Promise<void> => {
    if (currentToken() && e2eePairing) return Promise.resolve();
    setRemoteConnectionPhase('approval');
    return new Promise((resolve) => {
      const ready = () => {
        if (!currentToken() || !e2eePairing) return;
        window.removeEventListener(REMOTE_CREDENTIAL_READY_EVENT, ready);
        resolve();
      };
      window.addEventListener(REMOTE_CREDENTIAL_READY_EVENT, ready);
    });
  };

  const wsUrl = (): string => {
    const auth = encodeURIComponent(currentToken());
    if (serverBase) {
      const base = new URL(serverBase);
      const scheme = base.protocol === 'https:' ? 'wss' : 'ws';
      return `${scheme}://${base.host}/ws?token=${auth}`;
    }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}/ws?token=${auth}`;
  };

  const ensureClientRegistration = (): Promise<void> => {
    if (clientRegistered) return Promise.resolve();
    // Single flight: the app fires several RPCs at startup and every one dials
    // connect(). Parallel registrations would each rotate this browser's
    // credential server-side, invalidating each other mid-pairing.
    registrationInFlight ??= (async () => {
      setRemoteConnectionPhase('registration');
      const endpoint = serverBase
        ? new URL('/client/register', serverBase).toString()
        : new URL('/client/register', location.origin).toString();
      const auth = currentToken();
      const response = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          // localStorage outlives cookies in installed PWAs; the bearer keeps
          // registration working when the pairing cookie is gone.
          ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        },
        body: JSON.stringify({ clientId: browserId, ...(await browserProfile()) }),
      });
      if (!response.ok) {
        const failure: Error & { status?: number } = new Error(
          `Remote browser registration failed (${response.status}).`
        );
        failure.status = response.status;
        throw failure;
      }
      const result = (await response.json()) as { clientId?: unknown; token?: unknown };
      if (typeof result.clientId === 'string' && result.clientId) {
        browserId = result.clientId;
        try {
          localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId);
        } catch {
          /* session only */
        }
      }
      if (typeof result.token === 'string' && isRemoteClientCredential(result.token)) {
        token = result.token;
        try {
          localStorage.setItem(TOKEN_STORAGE_KEY, token);
        } catch {
          /* session only */
        }
      }
      clientRegistered = true;
    })().finally(() => {
      registrationInFlight = null;
    });
    return registrationInFlight;
  };

  // The pre-credential surface (remote-pairing-screen.ts) owns the entry screen
  // and the approval loop; the shim keeps what is connection state. Created
  // here so the install offer, which fires once and early, is still captured
  // before anything else can run.
  const showPairingScreen = createRemotePairingScreen({
    deviceId,
    serverBase: () => serverBase || location.origin,
    clientId: () => browserId,
    acceptApproval: (credential, material) => adoptApproval(credential, material),
    verifyConnection: () => verifyApprovedConnection(),
  });

  /** What an approval hands back: a credential minted for THIS container, plus
   *  E2EE material that travelled sealed to a key only this container holds. */
  const persistApproval = (credential: string, material: RelayE2EEPairingMaterial): boolean => {
    try {
      localStorage.setItem(SERVER_STORAGE_KEY, serverBase || location.origin);
      localStorage.setItem(TOKEN_STORAGE_KEY, credential);
      localStorage.setItem(E2EE_PUBLIC_KEY_STORAGE_KEY, material.serverPublicKey);
      localStorage.setItem(E2EE_SECRET_STORAGE_KEY, material.pairingSecret);
      localStorage.setItem(BROWSER_ID_STORAGE_KEY, browserId);
      if (deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
      return true;
    } catch {
      return false;
    }
  };

  const waitForApprovedConnection = (): Promise<void> => {
    if (connectionReady) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener(REMOTE_CONNECTION_READY_EVENT, ready);
        window.removeEventListener(REMOTE_PAIRING_INVALID_EVENT, invalid);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const invalid = (event: Event) => {
        cleanup();
        const message =
          event instanceof CustomEvent && typeof event.detail === 'string'
            ? event.detail
            : earlyUiT('This device could not complete secure pairing.');
        reject(new Error(message));
      };
      window.addEventListener(REMOTE_CONNECTION_READY_EVENT, ready, { once: true });
      window.addEventListener(REMOTE_PAIRING_INVALID_EVENT, invalid, { once: true });
    });
  };

  /** An approval this container may keep: stored first, because a credential
   *  that cannot be stored is a refused approval rather than a half pairing. */
  const adoptApproval = (credential: string, material: RelayE2EEPairingMaterial): boolean => {
    if (!persistApproval(credential, material)) return false;
    token = credential;
    e2eePairing = material;
    // Claim approval already minted this browser's credential server-side.
    clientRegistered = true;
    window.dispatchEvent(new Event(REMOTE_CREDENTIAL_READY_EVENT));
    return true;
  };

  /** Dial with the fresh credential and answer once THIS connection is secure.
   *  The in-flight flag is the shim's: it keeps a completing handshake from
   *  removing the entry screen while its own verification is still running. */
  const verifyApprovedConnection = async (): Promise<void> => {
    approvalVerificationInFlight = true;
    const verified = waitForApprovedConnection();
    void connect().catch(() => {
      // Transient failures stay on the reconnect loop. Permanent pairing
      // failures raise REMOTE_PAIRING_INVALID_EVENT and end this attempt.
    });
    try {
      await verified;
    } finally {
      approvalVerificationInFlight = false;
    }
  };

  /** Fan a push out to one lane's listeners. A faulting renderer listener
   *  must never stop the frame from reaching the rest. */
  const fanOut = <T>(listeners: Set<(value: T) => void>, value: T): void => {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch {
        /* renderer listener fault */
      }
    }
  };

  const dispatchState = (snapshot: SessionSnapshot): void => fanOut(stateListeners, snapshot);

  // State pushes ride the same identity-prefix items delta the desktop IPC
  // uses (state-delta.ts): reassemble full snapshots here, and ask the
  // desktop for a resync when a patch does not match our base revision
  // (mid-stream join through the relay, missed frame).
  const stateDecoder = createSnapshotDeltaDecoder();
  const sessionStateDecoders = new Map<string, ReturnType<typeof createSnapshotDeltaDecoder>>();
  const resetDeltaState = (): void => {
    invalidateViewResume();
    stateDecoder.reset();
    for (const decoder of sessionStateDecoders.values()) decoder.reset();
    sessionStateDecoders.clear();
    sessionsDecoder.reset();
    agentPoolDecoder.reset();
    sessionsCatalog.reset();
    agentsCatalog.reset();
    sessionInbox.reset();
  };
  // stateResync only restores the bound-session state lane, so this still has
  // to tell the renderer to re-read its per-session transcript lanes.
  //
  // The catalog lanes are NOT refetched here. The desktop retains the last
  // roster and re-sends it in full on join and on resync (remote-relay.ts
  // sendClientLists), and those frames are not droppable, so asking for
  // listSessions/listAgentPool on the same reconnect delivered the whole
  // catalog twice — measured at ~283KB per copy, the largest single item on
  // the RPC lane. A patch that cannot apply still reports it: the keyed decoder
  // answers `ok: false` and that path already calls requestResync().
  const refreshBroadcastLanes = (): void => {
    window.dispatchEvent(new Event('mixdog:remote-state-gap'));
  };
  // Unsolicited resync requests (relay drop hint, foreground wake) share one
  // short debounce: a tab that flips visibility repeatedly must not pull a
  // full transcript per flip, while a real gap still recovers immediately.
  let lastResyncAt = 0;
  let trailingResyncTimer: number | null = null;
  const requestResync = (): void => {
    // A gap, a dropped frame or a wake that doubts the stream: this browser's
    // decoders no longer vouch for what the desktop last sent.
    invalidateViewResume();
    if (peerViewSync && connectionReady) {
      void viewSync.request().catch(() => undefined);
      return;
    }
    const now = Date.now();
    // Decoders reject mismatched patches themselves. Resetting every healthy
    // lane here made one gap invalidate unrelated catalogs during recovery.
    const sinceLast = now - lastResyncAt;
    if (sinceLast < 3_000) {
      // TRAIL it, never drop it: a wake that lands inside the window of the
      // resync its own disconnect fired would otherwise be swallowed, and a
      // finished turn sends no further push to expose the gap.
      if (trailingResyncTimer === null) {
        trailingResyncTimer = window.setTimeout(() => {
          trailingResyncTimer = null;
          requestResync();
        }, 3_000 - sinceLast);
      }
      return;
    }
    if (trailingResyncTimer !== null) {
      window.clearTimeout(trailingResyncTimer);
      trailingResyncTimer = null;
    }
    lastResyncAt = now;
    fire('stateResync', []);
    refreshBroadcastLanes();
  };
  // Reassembly is the shared snapshot decoder's job — it already handles both
  // wire shapes (the original one and the compact frames a current desktop
  // sends), including the legacy full snapshot whose missing revision leaves
  // the next patch unverifiable. The shim only has to turn a rejected patch
  // into a resync request.
  const applyStatePayload = (payload: unknown): SessionSnapshot | null => {
    const decoded = stateDecoder.decode(payload);
    if (!decoded.ok) {
      reportRemoteConnectionIssue('state-gap');
      requestResync();
      return null;
    }
    return decoded.snapshot as SessionSnapshot;
  };

  const compactFrames = createCompactTranscriptExpander();

  // Reaches the toast surface without importing it: notifications.tsx renders
  // whatever arrives on DESKTOP_TOAST_EVENT, and this shim installs before the
  // React app exists, so it must not pull a component module in.
  const showRemoteToast = (text: string): void => {
    try {
      window.dispatchEvent(
        new CustomEvent('mixdog:desktop-toast', {
          detail: { id: `relay-payload:${Date.now()}`, text, tone: 'error' },
        })
      );
    } catch {
      /* container without a toast surface */
    }
  };
  /** The ceiling can drop while frames are already on their way: the relay
   *  lowers it, and a frame sent a moment earlier — or concurrently, before
   *  the desktop's update lands here — meets the NEW limit. That refusal can
   *  name no call, so without this the call behind it waits out its 20-second
   *  deadline and closes the socket, and a push vanishes with no error at all.
   *  Every call whose own frame is past the ceiling now in force is settled at
   *  once instead, carrying its size and that limit. Calls within the ceiling
   *  are not touched, and no deadline anywhere is moved. */
  const failStrandedCalls = (): void => {
    const waiting: Array<readonly [number, RelayInflightFrame]> = [];
    for (const [id, entry] of pending) {
      if (entry.frame) waiting.push([id, entry.frame] as const);
    }
    if (waiting.length === 0) return;
    for (const refusal of relayStrandedCallRefusals(waiting, relayUplinkLimits())) {
      if (refusal.callId === null) continue;
      const entry = pending.get(refusal.callId);
      if (!entry) continue;
      pending.delete(refusal.callId);
      const failure: Error & { code?: string } = new Error(relayPayloadTooLargeMessage(refusal));
      failure.code = RELAY_PAYLOAD_TOO_LARGE_CODE;
      entry.reject(failure);
    }
  };
  /** A refusal fails EXACTLY the call it names and never guesses one. An id is
   *  only ever present when the desktop itself declined to send that call's
   *  answer, inside the encrypted channel; a relay-controlled signal carries
   *  none and is reported to the user without blaming a call that may be
   *  perfectly healthy. Either way the ceiling it reports is learned, so the
   *  next oversize frame is refused before it is sent. */
  const applyRelayPayloadRejection = (rejection: RelayPayloadRejection): void => {
    learnFrameLimit(rejection.limit);
    // The reported ceiling is now the one in force, so anything already sent
    // past it is dead on arrival — including whatever this refusal was about.
    failStrandedCalls();
    const message = relayPayloadTooLargeMessage(rejection);
    if (rejection.callId === null) {
      // Unattributed or a push: the user is told, and NOTHING else happens.
      // Touching in-flight calls here would fail healthy ones — the refusal
      // names no call, so no call's fate may depend on it. Each keeps its own
      // deadline, which is the only bound that belongs to it.
      showRemoteToast(message);
      return;
    }
    const entry = pending.get(rejection.callId);
    // Already settled (its own deadline, a reconnect): nothing to say twice.
    if (!entry) return;
    pending.delete(rejection.callId);
    const failure: Error & { code?: string } = new Error(message);
    failure.code = RELAY_PAYLOAD_TOO_LARGE_CODE;
    entry.reject(failure);
  };

  const handleMessage = (
    frame: Record<string, unknown>,
    /** Whether this frame arrived over an authenticated channel. Required, so
     *  every call site states it: on a non-E2EE connection clear relay data
     *  reaches this same handler and must not be trusted with victim
     *  selection. */
    authenticated: boolean
  ): void => {
    // Any inbound frame proves the socket is alive; pong frames carry
    // nothing else.
    awaitingPong = false;
    clearWakePongTimer();
    if ('pong' in frame) return;
    if (frame.event === VIEW_BASELINE_EVENT) {
      if (!authenticated) return;
      try {
        handleMessage(viewBaselines.restore(frame.payload), true);
      } catch (error) {
        // Never acknowledge a recovery with missing data. Redial without
        // cached claims; the existing recovery path requests full baselines.
        viewBaselines.clear();
        throw error;
      }
      return;
    }
    let message = frame;
    if (frame.e === 'S') {
      // Compact app-state push: same payload, envelope reduced to two keys.
      const wire = frame.w;
      markCompactPayload(wire);
      message = { event: 'state', payload: wire };
    } else if (frame.e === 'T') {
      const expanded = compactFrames.expand(frame);
      if (!expanded) {
        // This browser's handle map disagrees with the desktop's. Only a fresh
        // handshake rebuilds both sides, and the reconnect loop performs one.
        try {
          socket?.close();
        } catch {
          /* reconnect loop takes over */
        }
        return;
      }
      message = expanded;
    }
    // Relay hint: a state push was dropped for this leg (background tab, slow
    // link). The next patch would expose the gap, but a finished turn sends
    // no next patch — ask for a full snapshot now.
    if ('resync' in message) {
      requestResync();
      return;
    }
    if (typeof message.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok === true) entry.resolve(message.value);
      else {
        const failure: Error & { code?: string } = new Error(
          typeof message.error === 'string' && message.error ? message.error : 'remote call failed.'
        );
        // Transport pass-through: the main side puts an errored call's `code`
        // on the frame (remote-methods.ts `RemoteFrameResponse.errorCode`)
        // because JSON drops custom Error properties. Putting it back here
        // keeps a remote caller on the same contract as an in-process one.
        if (typeof message.errorCode === 'string' && message.errorCode) {
          failure.code = message.errorCode;
        }
        entry.reject(failure);
      }
      return;
    }
    // The desktop declined to send a frame (or was told the relay refused
    // one). Read AFTER the response branch above, so an ordinary call error can
    // never be mistaken for one; it carries no state, so it never resyncs.
    const rejectedPayload = readRelayPayloadRejection(message, authenticated);
    if (rejectedPayload) {
      applyRelayPayloadRejection(rejectedPayload);
      return;
    }
    // The relay changed this leg's ceilings mid-connection and the desktop
    // forwarded the new ones. Applied at once, so the very next frame is
    // measured against the ceiling now in force and fails HERE, naming its own
    // call, instead of being refused at the relay where nothing can attribute
    // it. Authenticated only: what this leg may put on the wire is exactly the
    // decision a cleartext frame must never be able to move.
    if (message.event === RELAY_ROUTING_CAPS_EVENT) {
      if (authenticated && message.payload && typeof message.payload === 'object') {
        learnRoutingCaps(message.payload as Record<string, unknown>);
      }
      return;
    }
    if (message.event === 'state') {
      const snapshot = applyStatePayload(message.payload ?? null);
      if (snapshot !== null) dispatchState(snapshot);
    } else if (message.event === 'sessions') {
      const decoded = Array.isArray(message.payload)
        ? { ok: true, items: message.payload as DesktopSessionSummary[] }
        : sessionsDecoder.decode(message.payload);
      if (!decoded.ok) {
        reportRemoteConnectionIssue('sessions-gap');
        requestResync();
        return;
      }
      sessionsCatalog.publish(decoded.items ?? []);
    } else if (message.event === 'agentPool') {
      const decoded = Array.isArray(message.payload)
        ? { ok: true, items: message.payload as DesktopAgentPoolRow[] }
        : agentPoolDecoder.decode(message.payload);
      if (!decoded.ok) {
        reportRemoteConnectionIssue('agents-gap');
        requestResync();
        return;
      }
      agentsCatalog.publish(decoded.items ?? []);
    } else if (message.event === 'sessionState') {
      const payload = message.payload as DesktopSessionStateUpdate & {
        wire?: unknown;
        perfProbe?: unknown;
      };
      if (!payload || typeof payload !== 'object' || !String(payload.sessionId || '')) return;
      const receivedAt = performance.now();
      let update: DesktopSessionStateUpdate = payload;
      if (Object.hasOwn(payload, 'wire')) {
        let decoder = sessionStateDecoders.get(payload.sessionId);
        if (!decoder) {
          decoder = createSnapshotDeltaDecoder();
          sessionStateDecoders.set(payload.sessionId, decoder);
        }
        const decoded = decoder.decode(payload.wire);
        if (!decoded.ok) {
          reportRemoteConnectionIssue('transcript-gap');
          requestResync();
          return;
        }
        update = {
          sessionId: payload.sessionId,
          snapshot: decoded.snapshot as SessionSnapshot,
          frameSource: payload.frameSource,
          ...(payload.laneEnd ? { laneEnd: payload.laneEnd } : {}),
          ...(typeof payload.contentRevision === 'number' ? { contentRevision: payload.contentRevision } : {}),
        };
        if (update.snapshot === null) sessionStateDecoders.delete(payload.sessionId);
      }
      sessionInbox.publish(update);
      const timeline = update.snapshot ? takeRemoteConnectionTimeline() : '';
      if (timeline) fire('reportConnectionTimeline', [timeline]);
      if (isRemotePaintProbe(payload.perfProbe)) {
        const probe = payload.perfProbe;
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => {
            const receiveToPaintMs = performance.now() - receivedAt;
            console.info(
              `[mixdog-remote-perf] session=${payload.sessionId}` + ` receive-to-paint=${receiveToPaintMs.toFixed(1)}ms`
            );
            fire('remotePerfPaint', [probe.id, receiveToPaintMs]);
          })
        );
      }
    } else if (message.event === 'termData') {
      const payload = (message.payload ?? {}) as { id?: unknown; data?: unknown };
      fanOut(termListeners, { id: String(payload.id || ''), data: String(payload.data ?? '') });
    } else if (message.event === 'folderChanged') {
      const dir = String(message.payload || '');
      if (!dir) return;
      fanOut(folderChangeListeners, dir);
    } else if (message.event === 'lspDiagnostics') {
      const payload = message.payload as DesktopLspDiagnosticEvent;
      if (!payload || typeof payload !== 'object') return;
      fanOut(lspDiagnosticsListeners, payload);
    } else if (message.event === 'lspStatus') {
      const payload = message.payload as DesktopLspStatusEvent;
      if (!payload || typeof payload !== 'object') return;
      fanOut(lspStatusListeners, payload);
    }
  };

  // NAT/carrier middleboxes silently drop idle WebSockets; the browser
  // cannot send protocol pings, so an app-level ping/pong detects the
  // half-dead socket and recycles it, and a foreground/online wake probe
  // reconnects immediately instead of on the next (hanging) tap.
  let heartbeatSentAt = 0;
  let awaitingPong = false;
  let wakePongTimer: number | null = null;
  // Any inbound frame already proves this leg is alive. The keepalive lane
  // therefore exists ONLY for a silent socket: a busy session never spends a
  // probe, and never risks the recycle that a lost pong triggers.
  let lastTrafficAt = 0;
  const clearWakePongTimer = (): void => {
    if (wakePongTimer === null) return;
    window.clearTimeout(wakePongTimer);
    wakePongTimer = null;
  };
  // Recycling a silent socket is invisible maintenance: nothing is waiting on
  // an answer, so the redial that follows must not raise the disconnect
  // surface. A close with calls in flight keeps the normal, visible path.
  const quietRecycledSockets = new WeakSet<WebSocket>();
  const recycleIdleSocket = (ws: WebSocket): void => {
    reportRemoteConnectionIssue('heartbeat-timeout');
    if (pending.size === 0) quietRecycledSockets.add(ws);
    retireConnection?.();
  };
  window.setInterval(() => {
    if (backgroundSuspended || !shouldRunRemoteHeartbeat(document.visibilityState)) {
      awaitingPong = false;
      return;
    }
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      awaitingPong = false;
      return;
    }
    if (awaitingPong) {
      if (Date.now() - heartbeatSentAt >= 10_000) {
        awaitingPong = false;
        recycleIdleSocket(ws);
      }
      return;
    }
    // Silence, not elapsed time, is what needs probing: a leg that just
    // delivered a frame is provably alive.
    if (Date.now() - Math.max(lastTrafficAt, heartbeatSentAt) >= 25_000) {
      heartbeatSentAt = Date.now();
      awaitingPong = true;
      try {
        ws.send('{"ping":1}');
      } catch {
        /* surfaces as close */
      }
    }
  }, 5_000);
  let backgroundSuspended = document.visibilityState === 'hidden';
  let resyncOnWake = backgroundSuspended;
  beginRemoteConnectionTimeline('boot');
  let reconnectTimer: number | null = null;
  const backgroundSuspendApplies = (): boolean => isInstalledMobileWebAppSurface() && !!token && !!e2eePairing;
  const suspendRemoteConnection = (): void => {
    if (!backgroundSuspendApplies()) return;
    setRemoteConnectionPhase('background');
    backgroundSuspended = true;
    resyncOnWake = true;
    awaitingPong = false;
    clearWakePongTimer();
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setRemoteConnectionState('connecting');
    retireConnection?.(1000, 'background');
  };
  // A quick app switch must not cost the relay leg: going hidden only arms
  // this grace, and the suspend above runs only if the page is still hidden
  // when it expires. A return within the grace takes the live-socket wake
  // path (ping probe, half-dead recycle, resync) instead of a full redial.
  const BACKGROUND_GRACE_MS = 30_000;
  let backgroundGraceTimer: number | null = null;
  const clearBackgroundGrace = (): void => {
    if (backgroundGraceTimer === null) return;
    window.clearTimeout(backgroundGraceTimer);
    backgroundGraceTimer = null;
  };
  const beginBackgroundGrace = (): void => {
    if (!backgroundSuspendApplies()) return;
    resyncOnWake = true;
    if (backgroundGraceTimer !== null) return;
    backgroundGraceTimer = window.setTimeout(() => {
      backgroundGraceTimer = null;
      if (document.visibilityState === 'hidden') suspendRemoteConnection();
    }, BACKGROUND_GRACE_MS);
  };
  const wakeProbe = (event?: Event): void => {
    if (document.visibilityState === 'hidden') {
      beginBackgroundGrace();
      return;
    }
    clearBackgroundGrace();
    if (backgroundSuspended) beginRemoteConnectionTimeline('wake');
    backgroundSuspended = false;
    const shouldResync = resyncOnWake || event?.type === 'online';
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      resyncOnWake = true;
      retryMs = 500;
      // Neither a stalled handshake nor a delayed close event may keep
      // connect() pinned to the previous attempt after a foreground wake.
      const attempt = openingSocket ?? ws;
      if (
        attempt &&
        (attempt.readyState >= WebSocket.CLOSING ||
          (attempt.readyState === WebSocket.CONNECTING && Date.now() - openingStartedAt >= 1_500))
      ) {
        retireConnection?.();
      }
      void connect().catch(() => {
        /* the retry loop keeps running */
      });
      return;
    }
    // A wake must never inherit a grown backoff: if this probe fails, the
    // redial that follows IS the gap the user watches.
    retryMs = 500;
    heartbeatSentAt = Date.now();
    awaitingPong = true;
    try {
      ws.send('{"ping":1}');
    } catch {
      /* surfaces as close */
    }
    // Foreground recovery should not inherit the normal 10s background
    // heartbeat budget. If this exact probe gets no response, recycle the
    // half-open socket promptly and let the reconnect loop re-register lanes.
    clearWakePongTimer();
    const probeSentAt = heartbeatSentAt;
    wakePongTimer = window.setTimeout(() => {
      wakePongTimer = null;
      if (socket !== ws || !awaitingPong || heartbeatSentAt !== probeSentAt) return;
      awaitingPong = false;
      recycleIdleSocket(ws);
    }, 2_500);
    // A live socket proves nothing about the transcript: pushes sent while
    // this tab was hidden may have been dropped for a congested leg, and a
    // finished turn never sends another patch to expose it.
    if (shouldResync) {
      resyncOnWake = false;
      requestResync();
    }
  };
  document.addEventListener('visibilitychange', wakeProbe);
  window.addEventListener('online', wakeProbe);
  window.addEventListener('focus', wakeProbe);
  window.addEventListener('pageshow', wakeProbe);
  window.addEventListener('pagehide', beginBackgroundGrace);
  // Tapping the disconnect overlay runs the same recovery a wake does, so a
  // waiting user never has to sit out the remaining backoff.
  window.addEventListener(REMOTE_WAKE_EVENT, wakeProbe);

  // This credential is unrecoverable. Wipe it and hand the surface back to the
  // entry screen, which asks the desktop for a new approval; the device route
  // survives because it is a routing label, not a credential.
  const resetApprovalAndAsk = (message: string): void => {
    viewBaselines.clear();
    resetDeltaState();
    clearRemoteConnectionState();
    try {
      clearStoredRemotePairing(localStorage);
      if (deviceId) localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
    } catch {
      /* private storage */
    }
    serverBase = location.origin;
    token = '';
    e2eePairing = null;
    everPaired = false;
    browserId = newBrowserId();
    clientRegistered = false;
    showPairingScreen(message, false);
    window.dispatchEvent(new CustomEvent(REMOTE_PAIRING_INVALID_EVENT, { detail: message }));
  };

  const scheduleReconnect = (): void => {
    if (backgroundSuspended || !shouldRunRemoteHeartbeat(document.visibilityState)) {
      setRemoteConnectionState('connecting');
      return;
    }
    setRemoteConnectionState(everConnected ? 'reconnecting' : 'connecting');
    // Registration failures and socket closes can both ask for a retry in the
    // same tick; one timer serves them all.
    if (reconnectTimer !== null) return;
    const delay = retryMs;
    retryMs = Math.min(10_000, retryMs * 2);
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(() => {});
    }, delay);
  };

  const connect = async (): Promise<WebSocket> => {
    await waitForCredential();
    if (socket && socket.readyState === WebSocket.OPEN && connectionReady) {
      return Promise.resolve(socket);
    }
    try {
      await ensureClientRegistration();
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      reportRemoteConnectionIssue('registration-failed', error, status);
      // 401/403/409: this credential was revoked or its slot is gone — only a
      // new approval fixes it. Anything else (network, 429, 5xx) retries.
      if (status === 401 || status === 403 || status === 409) {
        // The status travels into the message on purpose: this is the one
        // failure a user can only report, never inspect.
        resetApprovalAndAsk(earlyUiT('This device is no longer approved ({{status}}).', { status }));
      } else {
        scheduleReconnect();
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (backgroundSuspended) throw remoteConnectionInterruptedError();
    openPromise ??= new Promise<WebSocket>((resolve, reject) => {
      setRemoteConnectionPhase('websocket');
      const ws = new WebSocket(wsUrl());
      openingSocket = ws;
      openingStartedAt = Date.now();
      ws.binaryType = 'arraybuffer';
      let opened = false;
      let closed = false;
      let failureReported = false;
      let handshakeTimer: number | null = null;
      const reportFailure = (issue: RemoteConnectionIssue, error?: unknown, code?: number): void => {
        failureReported = true;
        reportRemoteConnectionIssue(issue, error, code);
      };
      // Browser suspension can postpone onclose indefinitely. Detach this
      // attempt before asking the network to close, and ignore its late work.
      const retire = (code?: number, reason?: string): void => {
        if (closed) return;
        finishClose();
        try {
          ws.close(code, reason);
        } catch {
          /* this attempt is already detached */
        }
      };
      retireConnection = retire;
      const expireHandshake = (): void => {
        if (closed) return;
        reportFailure('encryption-timeout');
        retire();
      };
      const openingTimer = window.setTimeout(() => {
        if (closed || opened || ws.readyState !== WebSocket.CONNECTING) return;
        reportFailure('websocket-timeout');
        retire();
      }, 12_000);
      const finishOpen = () => {
        // The relay can preserve this browser socket while the desktop leg
        // redials. In that case a fresh E2EE challenge makes the already-open
        // socket temporarily unready, then this same completion path restores
        // its subscriptions without requiring a browser reconnect.
        if (closed || (opened && connectionReady)) return;
        const firstReady = !opened;
        const reconnected = everConnected;
        if (firstReady) {
          opened = true;
          window.clearTimeout(openingTimer);
          if (openingSocket === ws) openingSocket = null;
        }
        connectionReady = true;
        if (!peerViewSync) setRemoteConnectionState('connected');
        if (handshakeTimer !== null) {
          window.clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        retryMs = 500;
        if (!approvalVerificationInFlight) {
          document.getElementById('mixdog-remote-pairing')?.remove();
        }
        if (!everPaired) {
          everPaired = true;
          try {
            localStorage.setItem(PAIRED_STORAGE_KEY, '1');
          } catch {
            /* no storage */
          }
        }
        if (!peerViewSync) window.dispatchEvent(new Event(REMOTE_CONNECTION_READY_EVENT));
        if (everConnected && !peerViewSync) {
          // E2EE relay handshakes already trigger an authoritative full state
          // push from the desktop. Only legacy direct sockets need the RPC.
          if (!e2eePairing) {
            void call<SessionSnapshot>('getSnapshot')
              .then(dispatchState)
              .catch(() => {});
          }
          // The renderer only announces visible sessions when its pane set
          // CHANGES, so nothing re-registered this browser with the relay's
          // fresh client record: the phone silently stopped receiving
          // transcript frames until a session switch or a reload (user: 다른
          // 앱 갔다 들어오니 동기 안 됨). Replay it before the lane re-reads
          // below, whose replay frames pass through the same filter.
          // Encryption is asynchronous, so merely starting these RPCs in
          // order does not guarantee wire order. Finish the registration
          // before any transcript re-read can publish its recovery frame.
          void (async () => {
            if (lastVisibleSessionIds.length > 0) {
              try {
                await call<boolean>('setVisibleSessions', [lastVisibleSessionIds]);
              } catch {
                // The reconnect loop or the next pane registration retries it.
              }
            }
            // Always announced, even when empty: that is what tells the fresh
            // client record this browser speaks the lane protocol and wants
            // nothing but what it asks for.
            publishLanes();
            refreshBroadcastLanes();
          })();
        } else if (!peerViewSync && lastVisibleSessionIds.length > 0) {
          // COLD launch. The panes that will ask for this transcript are still
          // being parsed; naming the session now lets the desktop's own read
          // and projection run underneath that work instead of after it. The
          // pane registration that follows is authoritative and simply
          // re-announces the same set.
          // setVisibleSessionsForSource now replays an already-resident
          // projection to a NEW browser, while a cold projection is filled by
          // that same subscription. One call therefore owns both registration
          // and transcript delivery; a second prefetch only added another RTT.
          void call<boolean>('setVisibleSessions', [lastVisibleSessionIds]).catch(() => false);
        }
        resyncOnWake = false;
        everConnected = true;
        if (firstReady) resolve(ws);
        if (peerViewSync) {
          pendingReconnectNotification = reconnected;
          viewSync.open();
        }
        // Existing terminal panes can hold PTY ids from the relay leg that
        // just died. Notify them only after the replacement connection has
        // settled so their ensure calls cannot race the reconnecting request.
        if (reconnected && !peerViewSync) {
          queueMicrotask(() => window.dispatchEvent(new Event('mixdog:remote-reconnected')));
        }
      };
      /** One path for every decrypted frame, whichever wire form carried it:
       *  the handshake completion, the readiness guard and the authenticated
       *  dispatch must never drift apart between the two. */
      const deliverSecureFrame = async (payload: unknown): Promise<void> => {
        if (!secureChannel) throw new Error('Relay encryption handshake was not established.');
        const decrypted = await secureChannel.decryptJson(payload);
        if (closed) return;
        if (!decrypted || typeof decrypted !== 'object') return;
        const message = decrypted as Record<string, unknown>;
        if (message.type === 'e2ee-ready' && message.version === 1) {
          // The caps the desktop learned from the relay handshake; this leg
          // never sees `relay-capabilities` itself.
          learnRoutingCaps(message);
          peerViewSync = message.viewSync === 1;
          finishOpen();
          return;
        }
        if (!connectionReady) throw new Error('Relay sent data before encryption was ready.');
        // Decrypted on this leg's own channel: authenticated.
        handleMessage(message, true);
      };
      ws.onopen = () => {
        if (closed) return;
        socket = ws;
        connectionReady = false;
        secureChannel = null;
        relayBinaryFrames = false;
        resetLearnedCaps();
        if (!e2eePairing) {
          finishOpen();
          return;
        }
        setRemoteConnectionPhase('encryption');
        handshakeTimer = window.setTimeout(expireHandshake, 10_000);
      };
      ws.onerror = () => {
        if (!closed && !failureReported) reportRemoteConnectionIssue('websocket-error');
      };
      ws.onmessage = (event) => {
        if (closed) return;
        // Traffic on ANY lane, encrypted or clear, refreshes the keepalive
        // window; only real silence may cost a probe.
        lastTrafficAt = Date.now();
        void (async () => {
          if (event.data instanceof ArrayBuffer) {
            await deliverSecureFrame(event.data);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(String(event.data));
          } catch {
            return;
          }
          if (!parsed || typeof parsed !== 'object') return;
          const clear = parsed as Record<string, unknown>;
          awaitingPong = false;
          clearWakePongTimer();
          if ('pong' in clear) return;
          if ('resync' in clear) {
            // A relay refusal rides `resync` on purpose: it is the one
            // cleartext key this browser acts on BEFORE decryption, so it can
            // never reach decryptJson. It is also unauthenticated, so it may
            // report a size and a ceiling but must never select a victim —
            // it surfaces the error and tightens the pre-send check. An
            // unrelated resync hint yields no rejection at all.
            const rejected = readRelayPayloadRejection(clear, false);
            if (rejected) applyRelayPayloadRejection(rejected);
            requestResync();
            return;
          }
          if (!e2eePairing) {
            // Supported legacy mode: this frame is cleartext off the socket,
            // so nothing in it may pick a victim.
            handleMessage(clear, false);
            return;
          }
          if (isRelayE2EEChallenge(clear)) {
            if (opened) {
              // The VPS retained this phone while its desktop leg redialed.
              // Calls sent to the old leg cannot complete; fail them now and
              // establish a new channel on the existing browser socket.
              connectionReady = false;
              viewSync.close();
              setRemoteConnectionState('reconnecting');
              resetDeltaState();
              const failure = remoteConnectionInterruptedError();
              for (const entry of [...pending.values()]) entry.reject(failure);
              pending.clear();
            } else if (secureChannel) {
              throw new Error('Duplicate relay encryption challenge.');
            }
            secureChannel = null;
            relayBinaryFrames = clear.binaryFrames === 1;
            // A replacement desktop leg on the same browser socket: its caps
            // are its own, and the previous leg's must not survive into it.
            resetLearnedCaps();
            compactFrames.reset();
            if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
            setRemoteConnectionPhase('encryption');
            handshakeTimer = window.setTimeout(expireHandshake, 10_000);
            const handshake = await createRelayE2EEClientHandshake(e2eePairing, clear);
            if (closed) return;
            secureChannel = handshake.channel;
            ws.send(JSON.stringify({ ...handshake.hello, viewSync: 1 }));
            return;
          }
          await deliverSecureFrame(clear);
        })().catch((error) => {
          if (closed) return;
          reportFailure('frame-failed', error);
          retire();
        });
      };
      const finishClose = (event?: CloseEvent): void => {
        if (closed) return;
        if (event && !backgroundSuspended && !failureReported) {
          reportFailure('websocket-closed', undefined, event.code);
        }
        closed = true;
        retireConnection = null;
        viewSync.close();
        window.clearTimeout(openingTimer);
        if (handshakeTimer !== null) window.clearTimeout(handshakeTimer);
        if (socket === ws) socket = null;
        if (openingSocket === ws) openingSocket = null;
        openPromise = null;
        connectionReady = false;
        secureChannel = null;
        relayBinaryFrames = false;
        clearWakePongTimer();
        awaitingPong = false;
        resyncOnWake = true;
        // A new connection starts a fresh delta lane; a stale base revision
        // must never accidentally match the new encoder's numbering. Only
        // intact decoders survive, and only to be verified by revision and
        // content digest before the desktop continues any lane from them (a
        // new encoder's first frame is always a full baseline).
        // An attempt that closes before its first sync keeps the token it
        // was carrying: nothing consumed it.
        if (viewResumeToken) carriedResumeToken = viewResumeToken;
        viewResumeToken = null;
        if (!carriedResumeToken) resetDeltaState();
        // Decided BEFORE the rejection sweep empties the map: a keepalive
        // recycle only stays quiet while nothing was waiting on this leg.
        const quietRecycle = quietRecycledSockets.delete(ws) && pending.size === 0;
        const failure = remoteConnectionInterruptedError();
        for (const entry of [...pending.values()]) entry.reject(failure);
        pending.clear();
        if (!opened) reject(failure);
        if (event && isInvalidRemotePairingClose(event)) {
          resetApprovalAndAsk(earlyUiT('This device is no longer approved ({{status}}).', { status: event.code }));
          return;
        }
        if (quietRecycle) {
          // One silent redial at full speed. If THAT one fails, the next close
          // runs the normal path and the disconnect countdown starts.
          setRemoteConnectionState('connecting');
          if (!backgroundSuspended && shouldRunRemoteHeartbeat(document.visibilityState)) {
            retryMs = 500;
            void connect().catch(() => {
              /* the retry loop takes over */
            });
            return;
          }
        }
        scheduleReconnect();
      };
      ws.onclose = finishClose;
    });
    return openPromise;
  };

  const sendApplicationFrame = async (ws: WebSocket, payload: Record<string, unknown>): Promise<void> => {
    // Refuse an oversize frame HERE, while holding the very frame that would
    // fail and knowing the call it carries. What must fit is the frame AS THE
    // RELAY WILL ROUTE IT — wrapped for the desktop leg and charged again
    // there — and the relay itself published that ceiling for this connection,
    // per wire form. Judging the frame against the relay's own figure is what
    // makes the refusal exact: no second derivation to disagree with it, and
    // nothing content-dependent. Nothing is sent, so nothing has to be
    // correlated afterwards and no call waits out its 20-second deadline for an
    // answer that was never going to come.
    const refuseOversize = (frame: string | Uint8Array): void => {
      const refusal = relayFrameCapRefusal(frame, relayUplinkLimits(), relayFrameCallId(payload));
      if (!refusal) return;
      const failure: Error & { code?: string } = new Error(relayPayloadTooLargeMessage(refusal));
      failure.code = RELAY_PAYLOAD_TOO_LARGE_CODE;
      // A fire-and-forget publish has no caller to reject: say it once,
      // visibly, instead of dropping it in silence.
      if (refusal.callId === null) showRemoteToast(failure.message);
      throw failure;
    };
    /** What this call put on the wire, kept on the call itself, so a ceiling
     *  that drops after the send can be applied to that very frame. */
    const noteSentFrame = (frame: string | Uint8Array): void => {
      const callId = relayFrameCallId(payload);
      if (callId === null) return;
      const entry = pending.get(callId);
      if (!entry) return;
      entry.frame = { bytes: relayFrameByteLength(frame), binary: typeof frame !== 'string' };
    };
    if (e2eePairing) {
      if (!secureChannel || !connectionReady) throw new Error('Relay encryption is not ready.');
      const frame = relayBinaryFrames
        ? await secureChannel.encryptBinary(payload)
        : await secureChannel.encryptJson(payload);
      refuseOversize(frame);
      noteSentFrame(frame);
      ws.send(frame);
      return;
    }
    const directFrame = JSON.stringify(payload);
    refuseOversize(directFrame);
    noteSentFrame(directFrame);
    ws.send(directFrame);
  };

  const invoke = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    const ws = await connect();
    return await new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const deadline = armRemoteCallDeadline(pending, id, reject, wakeProbe);
      pending.set(id, {
        resolve: (value: unknown) => {
          window.clearTimeout(deadline);
          (resolve as (value: unknown) => void)(value);
        },
        reject: (reason: Error) => {
          window.clearTimeout(deadline);
          reject(reason);
        },
      });
      void sendApplicationFrame(ws, { id, method, params }).catch((error) => {
        pending.delete(id);
        const failure = error instanceof Error ? error : new Error(String(error));
        window.clearTimeout(deadline);
        reject(failure);
        // A payload this leg refused to send is a bad request, not a broken
        // socket: every other call on it stays alive.
        if ((failure as { code?: string }).code === RELAY_PAYLOAD_TOO_LARGE_CODE) return;
        try {
          ws.close();
        } catch {
          /* reconnect loop handles it */
        }
      });
    });
  };

  const call = async <T = unknown>(method: string, params: unknown[] = []): Promise<T> => {
    await connect();
    if (peerViewSync && method !== 'abortSession' && method !== 'resolveToolApprovalForSession') {
      await viewSync.ready();
    }
    return invoke<T>(method, params);
  };

  /** The roster a view-synchronizing desktop already delivered. Every sync
   *  sends the sessions and agent catalogs in full before its receipt and
   *  keeps them current with pushes, so once the view is synchronized the
   *  retained copy IS the answer. Asking again only re-downloaded the whole
   *  catalog, and on the desktop that read queued behind every earlier
   *  capability call: a cold boot's catalog readiness — and with it a session
   *  opened from a notification — waited seconds for unrelated settings
   *  probes. Legacy peers and an unset catalog still read over the relay. */
  const readCatalog = async <T>(
    catalog: ReturnType<typeof createRemoteCatalog<T>>,
    method: 'listSessions' | 'listAgentPool'
  ): Promise<T[]> => {
    await connect();
    if (!peerViewSync) return call<T[]>(method);
    await viewSync.ready();
    return (await catalog.read(() => invoke<T[]>(method))) ?? call<T[]>(method);
  };

  const fire = (method: string, params: unknown[]): void => {
    void connect()
      .then((ws) => sendApplicationFrame(ws, { method, params }))
      .catch(() => {});
  };

  const api: DesktopApi = {
    // Desktop-only OS integrations become inert or degrade to browser
    // equivalents (remote-browser-fallbacks.ts); everything below forwards over
    // the relay socket.
    ...REMOTE_BROWSER_FALLBACKS,
    // Web Push: the desktop mints the key, this browser subscribes with it and
    // sends the endpoint straight back through the encrypted socket, so the
    // relay never learns which device asked to be notified.
    pushPublicKey: () => call<string>('pushPublicKey'),
    registerPushSubscription: async (input) => {
      const profile = await browserProfile();
      return await call<boolean>('registerPushSubscription', [
        {
          ...input,
          clientId: browserId,
          label: [profile.browser, profile.platform].filter(Boolean).join(' · '),
        },
      ]);
    },
    removePushSubscription: (endpoint) => call<boolean>('removePushSubscription', [endpoint]),
    startProject: (projectPath) => call('startProject', [projectPath]),
    startProjectTask: (projectPath) => call('startProjectTask', [projectPath]),
    startTask: () => call('startTask'),
    listProjects: () => call('listProjects'),
    addProject: (projectPath) => call('addProject', [projectPath]),
    remoteBrowserFrame: (sessionId, previousFrameId) => call('browserRemoteFrame', [sessionId, previousFrameId ?? '']),
    remoteBrowserControl: (sessionId, input) => call('browserRemoteControl', [sessionId, input]),
    renameProject: (projectPath, alias) => call('renameProject', [projectPath, alias]),
    removeProject: (projectPath) => call('removeProject', [projectPath]),
    listProjectDir: (projectPath, relDir) => call('listProjectDir', [projectPath, relDir]),
    readProjectFile: (projectPath, relPath, accessToken) =>
      call('readProjectFile', [projectPath, relPath, accessToken ?? null]),
    statProjectFile: (projectPath, relPath, accessToken) =>
      call('statProjectFile', [projectPath, relPath, accessToken ?? null]),
    // No previewDocumentFile here on purpose: its answer is an Electron
    // protocol URL, which resolves to nothing in a browser. Pages are what a
    // phone can actually display, and they ride the encrypted lane.
    previewDocumentPages: (projectPath, relPath, accessToken, options) =>
      call('previewDocumentPages', [projectPath, relPath, accessToken ?? null, options ?? null]),
    writeProjectFile: (projectPath, relPath, content, expectedContent, accessToken, encoding) =>
      call('writeProjectFile', [projectPath, relPath, content, expectedContent, accessToken ?? null, encoding ?? null]),
    createProjectEntry: (projectPath, relDir, name, dir) =>
      call('createProjectEntry', [projectPath, relDir, name, dir === true]),
    renameProjectEntry: (projectPath, relPath, newName) => call('renameProjectEntry', [projectPath, relPath, newName]),
    moveProjectEntry: (projectPath, relPath, targetDirRel) =>
      call('moveProjectEntry', [projectPath, relPath, targetDirRel]),
    copyProjectEntry: (projectPath, relPath, targetDirRel) =>
      call('copyProjectEntry', [projectPath, relPath, targetDirRel]),
    readEditorSettings: (projectPath, relPath, workspaceFile) =>
      call('readEditorSettings', [projectPath, relPath, workspaceFile ?? null]),
    readEditorBackup: (projectPath, relPath, accessToken) =>
      call('readEditorBackup', [projectPath, relPath, accessToken ?? null]),
    writeEditorBackup: (projectPath, relPath, content, expectedContent, accessToken) =>
      call('writeEditorBackup', [projectPath, relPath, content, expectedContent, accessToken ?? null]),
    deleteEditorBackup: (projectPath, relPath, accessToken) =>
      call('deleteEditorBackup', [projectPath, relPath, accessToken ?? null]),
    readInstructions: (projectPath) => call('readInstructions', [projectPath ?? null]),
    writeInstructions: (projectPath, content, expectedContent) =>
      call('writeInstructions', [projectPath ?? null, content, expectedContent]),
    codeGraphQuery: (projectPath, mode, query) => call('codeGraphQuery', [projectPath, mode, query]),
    searchWorkspaceText: (projectPath, options) => call('searchWorkspaceText', [projectPath, options]),
    replaceWorkspaceText: (projectPath, options, replacement, relPaths) =>
      call('replaceWorkspaceText', [projectPath, options, replacement, relPaths ?? null]),
    lspDocument: (input) => call('lspDocument', [input]),
    lspRequest: (input) => call('lspRequest', [input]),
    lspApplyWorkspaceEdit: (projectPath, writes) => call('lspApplyWorkspaceEdit', [projectPath, writes]),
    subscribeLspDiagnostics: (listener) => laneSubscription('editor', lspDiagnosticsListeners, listener),
    subscribeLspStatus: (listener) => laneSubscription('editor', lspStatusListeners, listener),
    saveWorkspace: (workspaceFile, folders) => call('saveWorkspace', [workspaceFile ?? null, folders]),
    folderWatch: (dir, recursive) => call('folderWatch', [dir, recursive === true]),
    folderUnwatch: (dir, recursive) => call('folderUnwatch', [dir, recursive === true]),
    subscribeFolderChanges: (listener) => laneSubscription('files', folderChangeListeners, listener),
    resolveLocalPaths: (paths) => call('resolveLocalPaths', [paths]),
    readLocalFile: (path) => call('readLocalFile', [path]),
    listSessions: () => readCatalog(sessionsCatalog, 'listSessions'),
    markSessionRead: (sessionId, messageCount, consumedUnread) =>
      call<boolean>('markSessionRead', [sessionId, messageCount, consumedUnread]),
    subscribeSessions: (listener) => sessionsCatalog.subscribe(listener),
    listAgentPool: () => readCatalog(agentsCatalog, 'listAgentPool'),
    subscribeAgentPool: (listener) => agentsCatalog.subscribe(listener),
    renameSession: (sessionId, title) => call('renameSession', [sessionId, title]),
    setSessionArchived: (sessionId: string, archived: boolean) => call('setSessionArchived', [sessionId, archived]),
    deleteSession: (sessionId) => call('deleteSession', [sessionId]),
    // Cold session lanes fill through a host-side read; the replay frame
    // arrives on the broadcast sessionState event like any live push.
    prefetchSession: (sessionId, transcriptItemLimit, readTraceId) =>
      call<boolean>('prefetchSession', [sessionId, transcriptItemLimit, ...(readTraceId ? [readTraceId] : [])]),
    setVisibleSessions: (sessionIds) => {
      const requested = [...sessionIds];
      lastVisibleSessionIds = requested;
      try {
        localStorage.setItem(
          VISIBLE_SESSIONS_STORAGE_KEY,
          JSON.stringify(lastVisibleSessionIds.slice(0, MAX_RESTORED_VISIBLE_SESSIONS))
        );
      } catch {
        /* the next launch simply waits for React, as before */
      }
      return connect().then(async () => {
        if (!peerViewSync) {
          // Legacy encrypted peers have no registration version. Keep their
          // old ordering guarantee here, not in every desktop pane.
          const run = legacyVisibleSessionsQueue
            .catch(() => undefined)
            .then(() =>
              lastVisibleSessionIds === requested ? call<boolean>('setVisibleSessions', [requested]) : true
            );
          legacyVisibleSessionsQueue = run;
          return run;
        }
        // Already named by the latest sync: wait for it instead of
        // downloading every catalog and transcript baseline again.
        if (sessionSetKey(viewSyncSessionIds()) === requestedViewSyncKey) await viewSync.ready();
        else await viewSync.request();
        return true;
      });
    },
    searchProjectFiles: (projectIdOrWorkspaceId, query, limit) =>
      call('searchProjectFiles', [projectIdOrWorkspaceId, query, limit]),
    getSnapshot: () => call('getSnapshot'),
    subscribeState: (listener) => {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    termEnsure: (id, cwd, shell) => call('termEnsure', [id, cwd ?? null, shell ?? null]),
    termProfiles: () => call('termProfiles'),
    termWrite: (id, data) => fire('termWrite', [id, data]),
    termResize: (id, cols, rows) => fire('termResize', [id, cols, rows]),
    termDispose: (id) => call('termDispose', [id]),
    subscribeTermData: (listener) => laneSubscription('terminal', termListeners, listener),
    gitStatus: (cwd, options) => call('gitStatus', [cwd, options]),
    gitBranches: (cwd) => call('gitBranches', [cwd]),
    gitCheckoutBranch: (cwd, branch, remote) => call('gitCheckoutBranch', [cwd, branch, remote === true]),
    gitCreateBranch: (cwd, branch) => call('gitCreateBranch', [cwd, branch]),
    gitRenameBranch: (cwd, branch, nextBranch) => call('gitRenameBranch', [cwd, branch, nextBranch]),
    gitDeleteBranch: (cwd, branch) => call('gitDeleteBranch', [cwd, branch]),
    gitMergeBranch: (cwd, branch) => call('gitMergeBranch', [cwd, branch]),
    gitDiff: (cwd, path, staged, worktreeOnly, untracked) =>
      call('gitDiff', [cwd, path, staged === true, worktreeOnly === true, untracked === true]),
    gitApplyPatch: (cwd, path, patch, reverse) => call('gitApplyPatch', [cwd, path, patch, reverse === true]),
    gitStage: (cwd, paths) => call('gitStage', [cwd, paths]),
    gitUnstage: (cwd, paths) => call('gitUnstage', [cwd, paths]),
    gitIgnore: (cwd, path, scope) => call('gitIgnore', [cwd, path, scope]),
    gitCommit: (cwd, message) => call('gitCommit', [cwd, message]),
    gitCommitPaths: (cwd, message, paths) => call('gitCommitPaths', [cwd, message, paths]),
    gitAmend: (cwd, message) => call('gitAmend', [cwd, message]),
    gitUndoLastCommit: (cwd) => call('gitUndoLastCommit', [cwd]),
    gitStash: (cwd, message) => call('gitStash', [cwd, message]),
    gitStashPop: (cwd) => call('gitStashPop', [cwd]),
    gitPush: (cwd) => call('gitPush', [cwd]),
    gitFetch: (cwd) => call('gitFetch', [cwd]),
    gitPull: (cwd) => call('gitPull', [cwd]),
    gitSync: (cwd) => call('gitSync', [cwd]),
    gitContinue: (cwd) => call('gitContinue', [cwd]),
    gitAbortOperation: (cwd) => call('gitAbortOperation', [cwd]),
    gitRevert: (cwd, path, untracked, mode) => call('gitRevert', [cwd, path, untracked === true, mode]),
    gitLog: (cwd, query, skip, limit) => call('gitLog', [cwd, query, skip, limit]),
    gitShow: (cwd, hash) => call('gitShow', [cwd, hash]),
    gitShowDiff: (cwd, hash, path) => call('gitShowDiff', [cwd, hash, path]),
    // The confirmation flag is part of the call: dropping it made every
    // confirmed dirty `--mixed` reset ask again on the main side.
    gitResetToCommit: (cwd, hash, mode, confirmedDirty) =>
      call('gitResetToCommit', [cwd, hash, mode, confirmedDirty === true]),
    gitRevertCommit: (cwd, hash) => call('gitRevertCommit', [cwd, hash]),
    gitCherryPickCommit: (cwd, hash) => call('gitCherryPickCommit', [cwd, hash]),
    gitCreateTag: (cwd, tag, hash) => call('gitCreateTag', [cwd, tag, hash]),
    gitDeleteTag: (cwd, tag) => call('gitDeleteTag', [cwd, tag]),
    gitCheckoutCommit: (cwd, hash) => call('gitCheckoutCommit', [cwd, hash]),
    gitCreateBranchAtCommit: (cwd, branch, hash) => call('gitCreateBranchAtCommit', [cwd, branch, hash]),
    gitReview: (cwd) => call('gitReview', [cwd]),
    gitReviewDiff: (cwd, path, untracked) => call('gitReviewDiff', [cwd, path, untracked === true]),
    gitStashList: (cwd) => call('gitStashList', [cwd]),
    gitStashApply: (cwd, ref) => call('gitStashApply', [cwd, ref]),
    gitStashDrop: (cwd, ref) => call('gitStashDrop', [cwd, ref]),
    gitShowFile: (cwd, rev, path) => call('gitShowFile', [cwd, rev, path]),
    gitGlobalConfig: () => call('gitGlobalConfig'),
    setGitGlobalConfig: (key, value) => call('setGitGlobalConfig', [key, value]),
    // gh runs on the desktop machine and its login is a DEVICE flow, so the
    // phone shows the same code and finishes it in its own browser.
    githubStarStatus: () => call('githubStarStatus'),
    starGithub: () => call('starGithub'),
    gitCliStatus: () => call('gitCliStatus'),
    installGitCli: () => call('installGitCli'),
    libreOfficeStatus: () => call('libreOfficeStatus'),
    installLibreOffice: () => call('installLibreOffice'),
    githubCliStatus: () => call('githubCliStatus'),
    githubRequest: (cwd, input) => call('githubRequest', [cwd, input]),
    installGithubCli: () => call('installGithubCli'),
    githubCliLoginStart: () => call('githubCliLoginStart'),
    githubCliLoginStatus: (flowId) => call('githubCliLoginStatus', [flowId]),
    githubCliLoginCancel: (flowId) => call('githubCliLoginCancel', [flowId]),
    githubCliLogout: () => call('githubCliLogout'),
    githubCliAccount: () => call('githubCliAccount'),
    submitNewTask: (prompt, options, draft) => {
      const stable = { ...options, id: options?.id || newBrowserId() };
      return recoverableCreation(
        () => call('submitNewTask', [prompt, stable, draft ?? {}]),
        async () => {
          if (document.visibilityState === 'hidden') {
            await new Promise<void>((resolve) => {
              const visible = () => {
                if (document.visibilityState === 'hidden') return;
                document.removeEventListener('visibilitychange', visible);
                resolve();
              };
              document.addEventListener('visibilitychange', visible);
            });
          }
          await connect();
          if (peerViewSync) await viewSync.request();
        }
      );
    },
    submitToSession: (sessionId, prompt, options) => call('submitToSession', [sessionId, prompt, options ?? {}]),
    abortSession: (sessionId, options = {}) => call('abortSession', [sessionId, options]),
    resolveToolApprovalForSession: (sessionId, id, decision) =>
      call('resolveToolApprovalForSession', [sessionId, id, decision]),
    subscribeSessionState: (listener) => sessionInbox.subscribe(listener),
    inheritSession: (sourceSessionId, selection) => call('inheritSession', [sourceSessionId, selection ?? null]),
    listProviderModels: (options) => call('listProviderModels', [options]),
    setModelRoute: (selection, sessionId) => call('setModelRoute', [selection, sessionId]),
    setFast: (enabled, sessionId) => call('setFast', [enabled, sessionId]),
    readSettings: () => call('readSettings'),
    updateSetting: (key, enabled) => call('updateSetting', [key, enabled]),
    invokeCapability: <T = unknown>(request: DesktopCapabilityRequest) =>
      call<DesktopCapabilityResult<T>>('invokeCapability', [request]),
    readCapabilities: (requests) => call('readCapabilities', [requests]),
    // Gallery bytes ride HTTP, not this socket: the browser caches tiles and
    // asks for byte ranges when a clip seeks. A host that does not serve the
    // lane answers 404 and the caller falls back to the RPC payload.
    mediaUrl: (assetId, variant) => {
      const base = serverBase || location.origin;
      const auth = currentToken();
      const query = `variant=${encodeURIComponent(variant || 'original')}${auth ? `&token=${encodeURIComponent(auth)}` : ''}`;
      return `${base}/media/${encodeURIComponent(assetId)}?${query}`;
    },
  };

  w.mixdogDesktop = Object.freeze(api);
  // Settings → Connection on a remote surface: expose where this session is
  // connected so the panel shows live status instead of desktop-only pairing.
  (w as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer = serverBase || location.origin;
  // A browser tab always gets the install guide. A desktop-installed PWA is
  // also guide-only: only an installed phone/tablet app may hold a credential
  // and dial the relay.
  if (!isInstalledMobileWebAppSurface() || !token) {
    showPairingScreen('');
    return;
  }
  if (!e2eePairing) {
    resetApprovalAndAsk(earlyUiT('This device has incomplete approval data. Ask for approval again.'));
    return;
  }
  setRemoteConnectionState('connecting');
  if (!backgroundSuspended && shouldRunRemoteHeartbeat(document.visibilityState)) {
    void connect().catch(() => {
      /* the retry loop keeps running */
    });
  }
})();
