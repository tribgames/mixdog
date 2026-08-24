import type {
  DesktopRemoteClientInfo,
  DesktopSessionStateUpdate,
  SessionSnapshot,
} from '../shared/contract';
import type {
  MixdogProjectsModule,
  MixdogSessionStoreModule,
  StatuslineSegmentsModule,
} from './desktop-support';
import {
  SessionHost,
  type SessionClient,
} from './session-host';
import {
  DESKTOP_SERVICE_METHODS,
  type DesktopService,
  type DesktopServiceMethod,
  type SerializableDesktopServiceOptions,
} from './desktop-service-contract';
import {
  createLatestStateMailbox,
  type DesktopServiceInbound,
  type DesktopServiceOutbound,
} from './desktop-service-protocol';
import {
  createSnapshotDeltaEncoder,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';
import { createDesktopOperations } from './desktop-operations';
import { rotatePairingToken } from './remote-pairing-token';
import {
  resolveRelayUrl,
  rotateRemoteDevice,
  startRemoteRelay,
  type RemoteClientClaim,
  type RemoteRelayHandle,
} from './remote-relay';
import { rotateRelayE2EEIdentity } from './remote-e2ee';

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
  loadStatuslineSegments(): Promise<StatuslineSegmentsModule>;
  loadConfig(): Promise<import('./settings-store').MixdogConfigModule>;
  loadCommitCompletion(): Promise<import('./commit-message').CommitCompletionModule>;
  executeCodeGraphTool(
    name: string,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<unknown>;
}

export interface DesktopServiceAdapter {
  readonly clientCount: number;
  invoke(method: string, args: unknown[]): Promise<unknown>;
  control(message: unknown): Promise<void>;
  dispose(reason?: string): Promise<void>;
}

/** Service service adapter hosted inside the singleton machine daemon.
 *
 * DesktopServiceClient remains a pure, tested projection/cache layer. The
 * adapter itself never follows a desktop view's lifetime; this object's
 * dispose runs only when the daemon exits.
 */
export async function createDesktopService(
  { options, runtime, emit, onClientCountChanged }: DesktopServiceFactoryInput,
): Promise<DesktopServiceAdapter> {
  if (!runtime || typeof runtime.attachSessionClient !== 'function') {
    throw new TypeError('Mixdog service session bridge is unavailable.');
  }
  const host = await SessionHost.create(options, runtime);
  const desktopEventListeners = new Set<
    (event: { name: string; value: unknown }) => void
  >();
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
    loadCommitCompletion: runtime.loadCommitCompletion,
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
  // claimId -> settle(approved). One entry lives only as long as the approval
  // dialog it belongs to.
  const pendingClaims = new Map<string, {
    clientId: string;
    claim: RemoteClientClaim;
    promise: Promise<boolean>;
    settle(approved: boolean): void;
  }>();
  const remoteDescriptor = async () => {
    if (!remoteRelay) return null;
    let clients: DesktopRemoteClientInfo[] = [];
    try { clients = await remoteRelay.listClients(); } catch { /* relay may still be connecting */ }
    return {
      relay: {
        clientUrl: remoteRelay.clientUrl,
        token: remoteRelay.token,
        clients,
      },
    };
  };
  const remoteOptions = {
    host: remoteHost,
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
    subscribeTerminalData: operations.subscribeTerminalData,
    userDataPath: options.userDataPath,
    onClientCountChanged,
    // The window process owns the approval dialog, so the decision travels
    // out as an event and comes back as remoteAccessResolveClaim. An
    // unanswered request expires on its own — the relay drops it at 180s.
    onClientClaim: (claim: RemoteClientClaim): Promise<boolean> => {
      // A duplicate delivery shares the decision already on screen. Resolving
      // it false would deny the original claim before the user can answer it.
      const existing = pendingClaims.get(claim.claimId);
      if (existing) return existing.promise;

      // One container can have only one live prompt. A newer request replaces
      // an older key that its reloaded page can no longer use.
      for (const pending of [...pendingClaims.values()]) {
        if (pending.clientId === claim.clientId) pending.settle(false);
      }

      const now = Date.now();
      const relayExpiresAt = Number.isFinite(claim.expiresAt) && claim.expiresAt > now
        ? claim.expiresAt
        : now + REMOTE_CLAIM_TIMEOUT_MS;
      const expiresAt = Math.min(relayExpiresAt, now + REMOTE_CLAIM_TIMEOUT_MS);
      let resolveClaim!: (approved: boolean) => void;
      const promise = new Promise<boolean>((resolve) => { resolveClaim = resolve; });
      let timer: NodeJS.Timeout | null = null;
      const settle = (approved: boolean): void => {
        if (!pendingClaims.delete(claim.claimId)) return;
        if (timer) clearTimeout(timer);
        resolveClaim(approved);
      };
      timer = setTimeout(() => settle(false), Math.max(0, expiresAt - now));
      timer.unref?.();
      pendingClaims.set(claim.claimId, {
        clientId: claim.clientId,
        claim: { ...claim, expiresAt },
        promise,
        settle,
      });
      publishDesktopEvent('remote-client-claim', { ...claim, expiresAt });
      return promise;
    },
  };
  const RELAY_RETRY_BASE_MS = 5_000;
  const RELAY_RETRY_MAX_MS = 5 * 60_000;
  /** One pending retry at a time. Never scheduled once a leg is up: the relay
   *  handle owns its own reconnect loop from that point on. */
  const scheduleRelayRetry = (): void => {
    if (relayRetryTimer || remoteRelay) return;
    relayRetryMs = relayRetryMs > 0
      ? Math.min(RELAY_RETRY_MAX_MS, relayRetryMs * 2)
      : RELAY_RETRY_BASE_MS;
    relayRetryTimer = setTimeout(() => {
      relayRetryTimer = null;
      void startRemoteServices();
    }, relayRetryMs);
    relayRetryTimer.unref?.();
  };
  const startRemoteServices = async (): Promise<void> => {
    if (remoteServicesPromise) return remoteServicesPromise;
    remoteServicesPromise = (async () => {
      if (remoteRelay) return;
      try {
        const relayUrl = resolveRelayUrl(process.env);
        if (!relayUrl) return;
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
    await startRemoteServices();
    const relay = remoteRelay;
    await Promise.all([
      rotatePairingToken(options.userDataPath),
      rotateRemoteDevice(options.userDataPath),
      rotateRelayE2EEIdentity(options.userDataPath),
    ]);
    remoteRelay = null;
    try { await relay?.close(); } catch {}
    await startRemoteServices();
    return remoteDescriptor();
  };
  const rpcMethods = new Set<string>(DESKTOP_SERVICE_METHODS);
  const visibleSessionIds = new Set<string>();
  const stateEncoder = createSnapshotDeltaEncoder();
  const sessionStateEncoders = new Map<string, SnapshotDeltaEncoder>();
  const latestSessionStates = new Map<string, SessionSnapshot>();
  const latestSessionProvenance = new Map<string, {
    frameSource: 'live' | 'replay';
    contentRevision?: number;
  }>();

  const stateMailbox = createLatestStateMailbox<SessionSnapshot>((sequence, snapshot) => {
    emit({ kind: 'state', sequence, wire: stateEncoder.encode(snapshot) });
  });
  const postSessionState = (
    update: DesktopSessionStateUpdate,
  ): void => {
    const { sessionId, snapshot } = update;
    let encoder = sessionStateEncoders.get(sessionId);
    if (!encoder) encoder = createSnapshotDeltaEncoder();
    if (snapshot === null) {
      emit({
        kind: 'session-state',
        sessionId,
        wire: encoder.encode(null),
        frameSource: update.frameSource,
        ...(update.laneEnd ? { laneEnd: update.laneEnd } : {}),
        ...(typeof update.contentRevision === 'number'
          ? { contentRevision: update.contentRevision }
          : {}),
      });
      sessionStateEncoders.delete(sessionId);
      latestSessionStates.delete(sessionId);
      latestSessionProvenance.delete(sessionId);
      return;
    }
    sessionStateEncoders.set(sessionId, encoder);
    latestSessionStates.set(sessionId, snapshot);
    latestSessionProvenance.set(sessionId, update);
    emit({
      kind: 'session-state',
      sessionId,
      wire: encoder.encode(snapshot),
      frameSource: update.frameSource,
      ...(typeof update.contentRevision === 'number'
        ? { contentRevision: update.contentRevision }
        : {}),
    });
  };

  const unsubscribeState = host.subscribe((snapshot) => stateMailbox.publish(snapshot));
  const unsubscribeSessions = host.subscribeSessions((sessions) => {
    emit({ kind: 'sessions', sessions });
  });
  const unsubscribeAgentPool = host.subscribeAgentPool((agents) => {
    emit({ kind: 'agent-pool', agents });
  });
  const unsubscribeSessionStates = host.subscribeSessionStates((update) => {
    if (!shouldPublishSessionState(update.sessionId, update.snapshot, visibleSessionIds)) return;
    postSessionState(update);
  });
  stateMailbox.publish(host.getSnapshot());

  return {
    get clientCount() {
      return remoteRelay?.clientCount ?? 0;
    },
    async invoke(method, args): Promise<unknown> {
      if (!rpcMethods.has(method)) {
        throw new TypeError('Mixdog desktop service method is unavailable.');
      }
      if (method === 'invokeDesktopOperation') {
        const operation = String(args[0] || '');
        const operationArgs = Array.isArray(args[1]) ? args[1] : [];
        if (operation === 'remoteAccessStart' || operation === 'remoteAccessInfo') {
          await startRemoteServices();
          return remoteDescriptor();
        }
        if (operation === 'remoteAccessRotate') return rotateRemoteAccess();
        if (operation === 'remoteAccessListClaims') {
          const now = Date.now();
          return [...pendingClaims.values()]
            .map((pending) => pending.claim)
            .filter((claim) => claim.expiresAt > now);
        }
        if (operation === 'remoteAccessResolveClaim') {
          const pending = pendingClaims.get(String(operationArgs[0] || ''));
          if (!pending) return false;
          pending.settle(operationArgs[1] === true);
          return true;
        }
        if (operation === 'remoteAccessRevokeClient') {
          await startRemoteServices();
          const clientId = String(operationArgs[0] || '');
          if (!remoteRelay) return null;
          await remoteRelay.revokeClient(clientId);
          return remoteDescriptor();
        }
        if (operation === 'remoteAccessResume') {
          if (remoteRelay) remoteRelay.resume();
          else await startRemoteServices();
          return null;
        }
        return operations.invoke(operation, operationArgs);
      }
      if (method === 'setVisibleSessions') {
        visibleSessionIds.clear();
        const requested = args[0];
        if (Array.isArray(requested)) {
          for (const value of requested) {
            const sessionId = String(value || '');
            if (/^[A-Za-z0-9_-]+$/.test(sessionId)) visibleSessionIds.add(sessionId);
          }
        }
        releaseHiddenSessionStateEntries(
          visibleSessionIds,
          [sessionStateEncoders, latestSessionStates, latestSessionProvenance],
          (sessionId) => sessionStateEncoders.get(sessionId)?.reset(),
        );
      }
      const target = (host as unknown as Record<
        DesktopServiceMethod,
        (...values: unknown[]) => unknown
      >)[method as DesktopServiceMethod];
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
        stateEncoder.reset();
        stateMailbox.reset(host.getSnapshot());
        return;
      }
      if (message.kind !== 'session-state-resync') return;
      const sessionId = String(message.sessionId || '');
      const encoder = sessionStateEncoders.get(sessionId);
      const snapshot = latestSessionStates.get(sessionId);
      const provenance = latestSessionProvenance.get(sessionId);
      if (!encoder || snapshot === undefined || !provenance) return;
      encoder.reset();
      postSessionState({
        sessionId,
        snapshot,
        ...provenance,
      });
    },
    async dispose(): Promise<void> {
      unsubscribeState();
      unsubscribeSessions();
      unsubscribeAgentPool();
      unsubscribeSessionStates();
      stateMailbox.clear();
      sessionStateEncoders.clear();
      latestSessionStates.clear();
      latestSessionProvenance.clear();
      visibleSessionIds.clear();
      desktopEventListeners.clear();
      if (relayRetryTimer) {
        clearTimeout(relayRetryTimer);
        relayRetryTimer = null;
      }
      try { await remoteRelay?.close(); } catch {}
      remoteRelay = null;
      await operations.dispose();
      await host.dispose();
    },
  };
}
