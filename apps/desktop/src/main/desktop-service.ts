import type {
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
import {
  resolveRemoteBridgePort,
  rotateRemoteToken,
  startRemoteBridge,
  type RemoteBridgeHandle,
} from './remote-bridge';
import {
  resolveRelayUrl,
  rotateRemoteDevice,
  startRemoteRelay,
  type RemoteRelayHandle,
} from './remote-relay';
import { rotateRelayE2EEIdentity } from './remote-e2ee';

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
  const operations = createDesktopOperations({
    userDataPath: options.userDataPath,
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
    appPath: options.appPath,
    loadConfig: runtime.loadConfig,
    loadCommitCompletion: runtime.loadCommitCompletion,
    emit: (event) => emit({ kind: 'desktop-event', ...event }),
  });
  const settingsStore = operations.settingsStore;
  const remoteHost = new Proxy(host, {
    get(target, property) {
      if (property === 'invokeDesktopOperation') {
        return (name: string, args: unknown[] = []) => operations.invoke(name, args);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as DesktopService;
  let remoteBridge: RemoteBridgeHandle | null = null;
  let remoteRelay: RemoteRelayHandle | null = null;
  let remoteServicesPromise: Promise<void> | null = null;
  const remoteDescriptor = () => {
    if (!remoteBridge && !remoteRelay) return null;
    return {
      bridge: remoteBridge ? {
        port: remoteBridge.port,
        token: remoteBridge.token,
        urls: remoteBridge.urls,
      } : null,
      relay: remoteRelay ? {
        clientUrl: remoteRelay.clientUrl,
        token: remoteRelay.token,
        pairing: remoteRelay.pairing,
      } : null,
    };
  };
  const remoteOptions = {
    host: remoteHost,
    settingsStore,
    onDesktopSettingsChanged: (value: unknown) => {
      emit({ kind: 'desktop-event', name: 'desktop-settings-changed', value });
    },
    terminals: operations.terminals,
    subscribeTerminalData: operations.subscribeTerminalData,
    userDataPath: options.userDataPath,
    onClientCountChanged,
  };
  const startRemoteServices = async (): Promise<void> => {
    if (remoteServicesPromise) return remoteServicesPromise;
    remoteServicesPromise = (async () => {
      await Promise.all([
        (async () => {
          if (remoteBridge) return;
          const port = resolveRemoteBridgePort(process.env);
          if (port === null || !options.rendererDir) return;
          try {
            remoteBridge = await startRemoteBridge({
              ...remoteOptions,
              port,
              rendererDir: options.rendererDir,
            });
          } catch (error) {
            emit({
              kind: 'desktop-event',
              name: 'remote-access-status',
              value: {
                leg: 'bridge',
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        })(),
        (async () => {
          if (remoteRelay) return;
          const relayUrl = resolveRelayUrl(process.env);
          if (!relayUrl) return;
          try {
            remoteRelay = await startRemoteRelay({ ...remoteOptions, relayUrl });
          } catch (error) {
            emit({
              kind: 'desktop-event',
              name: 'remote-access-status',
              value: {
                leg: 'relay',
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
              },
            });
          }
        })(),
      ]);
    })();
    try {
      await remoteServicesPromise;
    } finally {
      remoteServicesPromise = null;
    }
  };
  const rotateRemoteAccess = async () => {
    await startRemoteServices();
    const bridge = remoteBridge;
    const relay = remoteRelay;
    await Promise.all([
      rotateRemoteToken(options.userDataPath),
      rotateRemoteDevice(options.userDataPath),
      rotateRelayE2EEIdentity(options.userDataPath),
    ]);
    remoteBridge = null;
    remoteRelay = null;
    try { await bridge?.close(); } catch {}
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
      return (remoteBridge?.clientCount ?? 0) + (remoteRelay?.clientCount ?? 0);
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
      try { await remoteBridge?.close(); } catch {}
      try { await remoteRelay?.close(); } catch {}
      remoteBridge = null;
      remoteRelay = null;
      await operations.dispose();
      await host.dispose();
    },
  };
}
