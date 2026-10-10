import type {
  DesktopBrowserImportProgress,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserTab,
  DesktopSessionStateUpdate,
  SessionSnapshot,
} from '../shared/contract';
import { BROWSER_OPEN_REQUESTED_DESKTOP_EVENT } from '../shared/remote-browser';
import { reportTranscriptRead } from '../shared/transcript-read-diagnostics';
import type {
  MixdogProjectsModule,
  MixdogSessionSearchModule,
  MixdogSessionStoreModule,
  StatuslineSegmentsModule,
} from './desktop-support';
import { SessionHost, type SessionClient } from './session-host';
import {
  DESKTOP_SERVICE_METHODS,
  type DesktopService,
  type DesktopServiceMethod,
  type SerializableDesktopServiceOptions,
} from './desktop-service-contract';
import type { DesktopServiceInbound, DesktopServiceOutbound } from './desktop-service-protocol';
import { createSnapshotStateMailbox } from './snapshot-state-mailbox';
import {
  createSessionReadWindow,
  createSnapshotDeltaEncoder,
  isNoDelta,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';
import { createDesktopOperations } from './desktop-operations';
import { rotatePairingToken } from './remote-pairing-token';
import { remoteAccessDescriptor } from './remote-access-descriptor';
import {
  resolveRelayUrl,
  rotateRemoteDevice,
  startRemoteRelay,
  type RemoteClaimDecision,
  type RemoteClientClaim,
  type RemoteRelayHandle,
} from './remote-relay';
import { activateRemote, isRemoteActivated } from './remote-activation';
import { rotateRelayE2EEIdentity } from './remote-e2ee';
import type { RemoteHostRequestMethod } from './remote-methods';
import type { BrowserRemoteMethod } from './remote-browser-methods';
import { synchronizeViewSnapshot } from './view-synchronizer';
import { filterSessionIds, requiredVisibleSessionVersion } from './desktop-state';

// Slightly under the relay's own claim TTL: a dialog left open must never
// outlive the request it answers.
const REMOTE_CLAIM_TIMEOUT_MS = 295_000;

interface DesktopServiceFactoryInput {
  options: SerializableDesktopServiceOptions;
  runtime: DesktopServiceRuntime;
  emit(message: DesktopServiceOutbound): void;
  onClientCountChanged?(): void;
}

interface DesktopServiceRuntime {
  attachSessionClient(options: {
    onFrame(frame: Record<string, unknown>): void;
    onFatal?(reason: string): void;
  }): Promise<SessionClient>;
  loadProjects(): Promise<MixdogProjectsModule>;
  loadSessionStore(): Promise<MixdogSessionStoreModule>;
  loadSessionSearch?(): Promise<MixdogSessionSearchModule>;
  loadStatuslineSegments(): Promise<StatuslineSegmentsModule>;
  loadConfig(): Promise<import('./settings-store').MixdogConfigModule>;
  /** Office document conversion and page rasterization. Optional: an older
   *  daemon simply has no document preview, and the editor says so. */
  loadDocumentPreview?(): Promise<import('./document-preview').DocumentPreviewModule>;
  executeCodeGraphTool(name: string, args: Record<string, unknown>, cwd: string): Promise<unknown>;
}

interface DesktopServiceAdapter {
  readonly clientCount: number;
  invoke(method: string, args: unknown[]): Promise<unknown>;
  control(message: unknown): Promise<void>;
  dispose(reason?: string): Promise<void>;
}

/** The window process owns the approval dialog, so a claim is published as an
 *  event and answered later. One live prompt per container: a duplicate
 *  delivery joins the decision already on screen, a newer claim replaces the
 *  key its reloaded page can no longer use, and every claim expires by itself
 *  so an unanswered dialog cannot outlive the request it answers. */
function createRemoteClaimArbiter(publish: (claim: RemoteClientClaim) => void) {
  // claimId -> settle(approved). One entry lives only as long as the approval
  // dialog it belongs to.
  const pendingClaims = new Map<
    string,
    {
      clientId: string;
      claim: RemoteClientClaim;
      promise: Promise<RemoteClaimDecision>;
      settle(decision: RemoteClaimDecision): void;
    }
  >();
  const denied: RemoteClaimDecision = { approved: false };
  return {
    claim(claim: RemoteClientClaim): Promise<RemoteClaimDecision> {
      // A duplicate delivery shares the decision already on screen. Resolving
      // it false would deny the original claim before the user can answer it.
      const existing = pendingClaims.get(claim.claimId);
      if (existing) return existing.promise;

      // One container can have only one live prompt. A newer request replaces
      // an older key that its reloaded page can no longer use.
      for (const pending of [...pendingClaims.values()]) {
        if (pending.clientId === claim.clientId) pending.settle(denied);
      }

      const now = Date.now();
      const relayExpiresAt =
        Number.isFinite(claim.expiresAt) && claim.expiresAt > now ? claim.expiresAt : now + REMOTE_CLAIM_TIMEOUT_MS;
      const expiresAt = Math.min(relayExpiresAt, now + REMOTE_CLAIM_TIMEOUT_MS);
      let resolveClaim!: (decision: RemoteClaimDecision) => void;
      const promise = new Promise<RemoteClaimDecision>((resolve) => {
        resolveClaim = resolve;
      });
      let timer: NodeJS.Timeout | null = null;
      const settle = (decision: RemoteClaimDecision): void => {
        if (!pendingClaims.delete(claim.claimId)) return;
        if (timer) clearTimeout(timer);
        resolveClaim(decision);
      };
      timer = setTimeout(() => settle(denied), Math.max(0, expiresAt - now));
      timer.unref?.();
      pendingClaims.set(claim.claimId, {
        clientId: claim.clientId,
        claim: { ...claim, expiresAt },
        promise,
        settle,
      });
      publish({ ...claim, expiresAt });
      return promise;
    },
    /** Claims still awaiting an answer, as the window should show them. */
    list(now: number): RemoteClientClaim[] {
      return [...pendingClaims.values()].map((pending) => pending.claim).filter((claim) => claim.expiresAt > now);
    },
    resolve(claimId: string, approved: boolean): boolean {
      const pending = pendingClaims.get(claimId);
      if (!pending) return false;
      pending.settle({ approved });
      return true;
    },
  };
}

type WindowRequestMethod = BrowserRemoteMethod | RemoteHostRequestMethod;

/** Desktop Browser Use, the OS trash and the updater run in the window process:
 *  a remote request travels out as an event and its answer returns as an
 *  operation. Each request is bounded, so a window that never answers fails the
 *  call instead of holding it open. */
function createBrowserRemoteRequests(
  publish: (request: { id: string; method: WindowRequestMethod; args: unknown[] }) => void
) {
  let nextRequestId = 0;
  const pendingRequests = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  return {
    request(method: WindowRequestMethod, args: unknown[], timeoutMs = 20_000): Promise<unknown> {
      const id = `browser_remote_${++nextRequestId}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error('The desktop app did not answer the remote request.'));
        }, timeoutMs);
        timer.unref?.();
        pendingRequests.set(id, { resolve, reject, timer });
        publish({ id, method, args });
      });
    },
    settle(id: string, ok: boolean, value: unknown, error: unknown): boolean {
      const pending = pendingRequests.get(id);
      if (!pending) return false;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      if (ok) pending.resolve(value);
      else pending.reject(new Error(String(error || 'The desktop app request failed.')));
      return true;
    },
    rejectAll(reason: string): void {
      for (const [id, pending] of pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
        pendingRequests.delete(id);
      }
    },
  };
}

/** Per-session transcript deltas: one encoder per session, the last snapshot it
 *  encoded, and where that snapshot came from. Every session-state frame the
 *  service emits is built here, which is what lets a resync rebuild the same
 *  frame from a reset encoder instead of asking the host again. */
function createSessionStatePublisher(emit: (message: DesktopServiceOutbound) => void) {
  const encoders = new Map<string, SnapshotDeltaEncoder>();
  const latestSnapshots = new Map<string, SessionSnapshot>();
  const latestProvenance = new Map<
    string,
    {
      frameSource: 'live' | 'replay';
      contentRevision?: number;
    }
  >();
  const post = (update: DesktopSessionStateUpdate): void => {
    const { sessionId, snapshot } = update;
    let encoder = encoders.get(sessionId);
    // Main decodes with this same build, so older-history pages travel as prepends.
    if (!encoder) encoder = createSnapshotDeltaEncoder({ prepend: true });
    if (snapshot === null) {
      emit({
        kind: 'session-state',
        sessionId,
        wire: encoder.encode(null),
        frameSource: update.frameSource,
        ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
        ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
      });
      encoders.delete(sessionId);
      latestSnapshots.delete(sessionId);
      latestProvenance.delete(sessionId);
      return;
    }
    encoders.set(sessionId, encoder);
    latestSnapshots.set(sessionId, snapshot);
    latestProvenance.set(sessionId, update);
    const wire = encoder.encode(snapshot);
    reportTranscriptRead(sessionId, update.readTraceId, isNoDelta(wire) ? 'service-unchanged' : 'service-send');
    if (isNoDelta(wire)) return;
    emit({
      kind: 'session-state',
      sessionId,
      wire,
      ...(update.readTraceId ? { readTraceId: update.readTraceId } : {}),
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number' ? { contentRevision: update.contentRevision } : {}),
    });
  };
  return {
    post,
    /** Drops one session's encoder, so its next frame is a full snapshot. */
    forget(sessionId: string): void {
      encoders.delete(sessionId);
    },
    /** A view sync restarts every lane from a full snapshot. */
    resetEncoders(): void {
      encoders.clear();
    },
    /** Re-sends what this session last published, from a reset encoder. */
    republish(sessionId: string): void {
      const encoder = encoders.get(sessionId);
      const snapshot = latestSnapshots.get(sessionId);
      const provenance = latestProvenance.get(sessionId);
      if (!encoder || snapshot === undefined || !provenance) return;
      encoder.reset();
      post({
        sessionId,
        snapshot,
        ...provenance,
      });
    },
    /** A session the window stopped showing keeps no delta state here. */
    releaseHidden(visibleSessionIds: Set<string>): void {
      releaseHiddenSessionStateEntries(visibleSessionIds, [encoders, latestSnapshots, latestProvenance], (sessionId) =>
        encoders.get(sessionId)?.reset()
      );
    },
    clear(): void {
      encoders.clear();
      latestSnapshots.clear();
      latestProvenance.clear();
    },
  };
}

/** Desktop service adapter hosted inside the singleton machine daemon.
 *
 * DesktopServiceClient remains a pure, tested projection/cache layer. The
 * adapter itself never follows a desktop view's lifetime; this object's
 * dispose runs only when the daemon exits.
 */
export async function createDesktopService({
  options,
  runtime,
  emit,
  onClientCountChanged,
}: DesktopServiceFactoryInput): Promise<DesktopServiceAdapter> {
  if (!runtime || typeof runtime.attachSessionClient !== 'function') {
    throw new TypeError('Mixdog service session bridge is unavailable.');
  }
  const host = await SessionHost.create(options, runtime);
  const desktopEventListeners = new Set<(event: { name: string; value: unknown }) => void>();
  const publishDesktopEvent = (name: string, value: unknown): void => {
    emit({ kind: 'desktop-event', name, value });
    for (const listener of desktopEventListeners) listener({ name, value });
  };
  const operations = createDesktopOperations({
    userDataPath: options.userDataPath,
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
    appPath: options.appPath,
    loadConfig: runtime.loadConfig,
    loadDocumentPreview: runtime.loadDocumentPreview ? () => runtime.loadDocumentPreview!() : undefined,
    emit: (event) => publishDesktopEvent(event.name, event.value),
  });
  const settingsStore = operations.settingsStore;
  const remoteHost = new Proxy(host, {
    get(target, property) {
      if (property === 'invokeDesktopOperation') {
        return (name: string, args: unknown[] = []) => operations.invoke(name, args);
      }
      if (property === 'subscribeDesktopEvents') {
        return (listener: (event: { name: string; value: unknown }) => void) => {
          desktopEventListeners.add(listener);
          return () => desktopEventListeners.delete(listener);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as DesktopService;
  let remoteRelay: RemoteRelayHandle | null = null;
  let remoteServicesPromise: Promise<void> | null = null;
  // A relay leg that fails to come up must not stay down until someone opens
  // the remote-access window: the phone that needs it is, by definition, not
  // in front of this machine. Backoff is per failure and resets on success.
  let relayRetryTimer: NodeJS.Timeout | null = null;
  let relayRetryMs = 0;
  const claims = createRemoteClaimArbiter((claim) => publishDesktopEvent('remote-client-claim', claim));
  const browserRemoteRequests = createBrowserRemoteRequests((request) =>
    publishDesktopEvent('browser-remote-request', request)
  );
  const remoteDescriptor = () => remoteAccessDescriptor(remoteRelay);
  const remoteOptions = {
    host: remoteHost,
    appVersion: options.appVersion,
    settingsStore,
    onDesktopSettingsChanged: (value: unknown) => {
      emit({ kind: 'desktop-event', name: 'desktop-settings-changed', value });
    },
    // An oversize frame the relay refused without naming a client. It reaches
    // the desktop window as an event so the user is told; no phone is
    // messaged and no call is blamed.
    onRelayPayloadRefused: (value: { bytes: number | null; limit: number | null }) => {
      emit({ kind: 'desktop-event', name: 'relay-payload-refused', value });
    },
    terminals: operations.terminals,
    browserRemote: browserRemoteRequests.request as (
      method: BrowserRemoteMethod,
      args: unknown[],
      timeoutMs?: number
    ) => Promise<unknown>,
    hostRequest: browserRemoteRequests.request as (method: RemoteHostRequestMethod, args: unknown[]) => Promise<unknown>,
    subscribeTerminalData: operations.subscribeTerminalData,
    userDataPath: options.userDataPath,
    onClientCountChanged,
    // The window process owns the approval dialog, so the decision travels
    // out as an event and comes back as remoteAccessResolveClaim. An
    // unanswered request expires on its own — the relay drops it at 180s.
    onClientClaim: (claim: RemoteClientClaim): Promise<RemoteClaimDecision> => claims.claim(claim),
  };
  const RELAY_RETRY_BASE_MS = 5_000;
  const RELAY_RETRY_MAX_MS = 5 * 60_000;
  /** One pending retry at a time. Never scheduled once a leg is up: the relay
   *  handle owns its own reconnect loop from that point on. */
  const scheduleRelayRetry = (): void => {
    if (relayRetryTimer || remoteRelay) return;
    relayRetryMs = relayRetryMs > 0 ? Math.min(RELAY_RETRY_MAX_MS, relayRetryMs * 2) : RELAY_RETRY_BASE_MS;
    relayRetryTimer = setTimeout(() => {
      relayRetryTimer = null;
      void startRemoteServices();
    }, relayRetryMs);
    relayRetryTimer.unref?.();
  };
  /** `explicit` is a user remote-access action: it activates (and persists)
   *  remote access. Boot/resume/retry starts only connect once activated, so a
   *  fresh install never registers on the relay on its own. */
  const startRemoteServices = async (explicit = false): Promise<void> => {
    if (remoteServicesPromise) {
      if (!explicit) return remoteServicesPromise;
      // A boot-time pass may have declined as not-yet-activated; run again.
      await remoteServicesPromise;
      return startRemoteServices(true);
    }
    remoteServicesPromise = (async () => {
      if (remoteRelay) {
        if (explicit) await activateRemote(options.userDataPath);
        return;
      }
      try {
        const relayUrl = resolveRelayUrl(process.env);
        if (!relayUrl) return;
        if (explicit) await activateRemote(options.userDataPath);
        else if (!(await isRemoteActivated(options.userDataPath))) return;
        remoteRelay = await startRemoteRelay({ ...remoteOptions, relayUrl });
        if (relayRetryTimer) {
          clearTimeout(relayRetryTimer);
          relayRetryTimer = null;
        }
        relayRetryMs = 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Logged where the daemon's own failures are read. Without this the
        // remote leg could stay down for hours leaving no trace anywhere.
        console.error(`[mixdog-relay] start failed: ${message}`);
        scheduleRelayRetry();
        emit({
          kind: 'desktop-event',
          name: 'remote-access-status',
          value: {
            leg: 'relay',
            status: 'failed',
            error: message,
          },
        });
      }
    })();
    try {
      await remoteServicesPromise;
    } finally {
      remoteServicesPromise = null;
    }
  };
  const rotateRemoteAccess = async () => {
    await startRemoteServices(true);
    const relay = remoteRelay;
    await Promise.all([
      rotatePairingToken(options.userDataPath),
      rotateRemoteDevice(options.userDataPath),
      rotateRelayE2EEIdentity(options.userDataPath),
    ]);
    remoteRelay = null;
    try {
      await relay?.close();
    } catch {}
    await startRemoteServices(true);
    return remoteDescriptor();
  };
  const rpcMethods = new Set<string>(DESKTOP_SERVICE_METHODS);
  let viewsSyncing = false;
  let viewVersion = 0;
  let visibleSessionVersion = 0;
  let serviceClosed = false;
  let viewSyncQueue: Promise<void> = Promise.resolve();
  const visibleSessionIds = new Set<string>();
  const desktopReads = createSessionReadWindow();
  const sessionStates = createSessionStatePublisher(emit);

  const stateMailbox = createSnapshotStateMailbox<SessionSnapshot>((sequence, wire) => {
    emit({ kind: 'state', sequence, wire });
  });

  const unsubscribeState = host.subscribe((snapshot) => {
    if (!viewsSyncing) stateMailbox.publish(snapshot);
  });
  const unsubscribeSessions = host.subscribeSessions((sessions) => {
    if (!viewsSyncing) emit({ kind: 'sessions', sessions });
  });
  const unsubscribeAgentPool = host.subscribeAgentPool((agents) => {
    if (!viewsSyncing) emit({ kind: 'agent-pool', agents });
  });
  const unsubscribeSessionStates = host.subscribeSessionStates((update) => {
    if (viewsSyncing) {
      reportTranscriptRead(update.sessionId, update.readTraceId, 'service-syncing');
      return;
    }
    if (!shouldPublishSessionState(update.sessionId, update.snapshot, visibleSessionIds, desktopReads)) {
      reportTranscriptRead(update.sessionId, update.readTraceId, 'service-hidden');
      return;
    }
    sessionStates.post(update);
  });
  stateMailbox.publish(host.getSnapshot());
  const synchronizeViews = (): Promise<void> => {
    const run = viewSyncQueue
      .catch(() => undefined)
      .then(async () => {
        let version: number;
        do {
          if (serviceClosed) return;
          version = viewVersion;
          viewsSyncing = true;
          try {
            await host.setVisibleSessions([...visibleSessionIds]);
            await synchronizeViewSnapshot(host, [...visibleSessionIds], (snapshot) => {
              if (serviceClosed) return;
              stateMailbox.reset(snapshot.snapshot);
              sessionStates.resetEncoders();
              for (const update of snapshot.sessionStates) sessionStates.post(update);
              emit({ kind: 'sessions', sessions: snapshot.sessions });
              emit({ kind: 'agent-pool', agents: snapshot.agents });
              viewsSyncing = false;
              if (version === viewVersion) emit({ kind: 'view-sync-complete' });
            });
          } finally {
            viewsSyncing = false;
          }
        } while (version !== viewVersion);
      });
    viewSyncQueue = run;
    return run;
  };
  const invokeServiceOperation = async (operation: string, operationArgs: unknown[]): Promise<unknown> => {
    switch (operation) {
      case 'remoteAccessStart':
        await startRemoteServices();
        return remoteDescriptor();
      case 'remoteAccessInfo':
        // activate:false is a pure read: warm an activated install, never
        // start or activate a fresh one.
        await startRemoteServices(operationArgs[0] !== false);
        return remoteDescriptor();
      case 'remoteAccessRotate':
        return rotateRemoteAccess();
      case 'remoteAccessListClaims':
        return claims.list(Date.now());
      case 'remoteAccessResolveClaim':
        return claims.resolve(String(operationArgs[0] || ''), operationArgs[1] === true);
      case 'remoteAccessRevokeClient': {
        await startRemoteServices(true);
        const clientId = String(operationArgs[0] || '');
        if (!remoteRelay) return null;
        await remoteRelay.revokeClient(clientId);
        return remoteDescriptor();
      }
      case 'remoteAccessResume':
        if (remoteRelay) remoteRelay.resume();
        else await startRemoteServices();
        return null;
      // The window process's live Browser Use frames and explicit reveal/hide
      // requests. Frames are paced per client by the relay; an open request is
      // a desktop event the relay forwards to every paired client.
      case 'browserRemoteFrame':
        remoteRelay?.publishBrowserFrame(operationArgs[0] as DesktopRemoteBrowserStreamFrame);
        return null;
      case 'browserRemoteTabs':
        remoteRelay?.publishBrowserTabs(operationArgs[0] as DesktopRemoteBrowserTab[]);
        return null;
      case 'browserRemoteImportProgress':
        remoteRelay?.publishBrowserImportProgress(operationArgs[0] as DesktopBrowserImportProgress);
        return null;
      case 'browserRemoteOpen':
        publishDesktopEvent(BROWSER_OPEN_REQUESTED_DESKTOP_EVENT, operationArgs[0]);
        return null;
      case 'browserRemoteResolve':
        return browserRemoteRequests.settle(
          String(operationArgs[0] || ''),
          operationArgs[1] === true,
          operationArgs[2],
          operationArgs[3]
        );
      default:
        return operations.invoke(operation, operationArgs);
    }
  };
  const setDeliveryFilter = async (args: unknown[]): Promise<boolean> => {
    const version = args[1];
    if (version !== undefined) {
      const nextVersion = requiredVisibleSessionVersion(version);
      // HTTP requests can arrive out of order even when IPC sent them in
      // order. An old tab must not restore its filter or subscription set.
      if (nextVersion <= visibleSessionVersion) return true;
      visibleSessionVersion = nextVersion;
    }
    viewVersion += 1;
    const requested = filterSessionIds(args[0]);
    visibleSessionIds.clear();
    for (const sessionId of requested) visibleSessionIds.add(sessionId);
    sessionStates.releaseHidden(visibleSessionIds);
    return host.setVisibleSessions(args[0] as string[]);
  };

  return {
    get clientCount() {
      return remoteRelay?.clientCount ?? 0;
    },
    async invoke(method, args): Promise<unknown> {
      if (!rpcMethods.has(method)) {
        throw new TypeError('Mixdog desktop service method is unavailable.');
      }
      if (method === 'invokeDesktopOperation') {
        return invokeServiceOperation(String(args[0] || ''), Array.isArray(args[1]) ? args[1] : []);
      }
      if (method === 'setVisibleSessions') {
        return setDeliveryFilter(args);
      }
      const target = (host as unknown as Record<DesktopServiceMethod, (...values: unknown[]) => unknown>)[
        method as DesktopServiceMethod
      ];
      // The window's own read: its frame must reach the window even before a
      // pane registers the session as visible.
      if (method === 'prefetchSession') {
        return desktopReads.run(String(args[0] || ''), async () => await target.apply(host, args));
      }
      return await target.apply(host, args);
    },
    async control(value): Promise<void> {
      if (!value || typeof value !== 'object') return;
      const message = value as DesktopServiceInbound;
      if (message.kind === 'state-ack' && Number.isSafeInteger(message.sequence)) {
        stateMailbox.acknowledge(message.sequence);
        return;
      }
      if (message.kind === 'state-resync') {
        await synchronizeViews();
        return;
      }
      if (message.kind !== 'session-state-resync') return;
      const sessionId = String(message.sessionId || '');
      if (host.replaySessionStates) {
        await host.replaySessionStates([sessionId], (updates) => {
          for (const update of updates) {
            sessionStates.forget(update.sessionId);
            sessionStates.post(update);
          }
        });
        return;
      }
      sessionStates.republish(sessionId);
    },
    async dispose(): Promise<void> {
      serviceClosed = true;
      unsubscribeState();
      unsubscribeSessions();
      unsubscribeAgentPool();
      unsubscribeSessionStates();
      stateMailbox.clear();
      sessionStates.clear();
      visibleSessionIds.clear();
      desktopEventListeners.clear();
      browserRemoteRequests.rejectAll('Desktop service is closing.');
      if (relayRetryTimer) {
        clearTimeout(relayRetryTimer);
        relayRetryTimer = null;
      }
      try {
        await remoteRelay?.close();
      } catch {}
      remoteRelay = null;
      await operations.dispose();
      await host.dispose();
    },
  };
}
