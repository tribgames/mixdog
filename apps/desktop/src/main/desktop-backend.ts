import type {
  DesktopSessionStateUpdate,
  EngineSnapshot,
} from '../shared/contract';
import { EngineHost } from './engine-host';
import type {
  EngineDaemonClientModule,
  MixdogEngine,
  MixdogProjectsModule,
  MixdogSessionStoreModule,
  StatuslineSegmentsModule,
} from './engine-host-support';
import {
  ENGINE_HOST_RPC_METHODS,
  type DesktopEngineHost,
  type EngineHostRpcMethod,
  type SerializableEngineHostOptions,
} from './engine-host-api';
import {
  createLatestStateMailbox,
  type DesktopBackendInbound,
  type DesktopBackendOutbound,
} from './desktop-backend-protocol';
import {
  createSnapshotDeltaEncoder,
  releaseHiddenSessionStateEntries,
  shouldPublishSessionState,
  type SnapshotDeltaEncoder,
} from './state-delta';
import { createDesktopBackendOperations } from './desktop-backend-operations';
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

interface DesktopBackendFactoryInput {
  options: SerializableEngineHostOptions;
  runtime: DesktopBackendRuntime;
  emit(message: DesktopBackendOutbound): void;
  onClientCountChanged?(): void;
}

interface DesktopBackendRuntime {
  createRemoteEngineSession(options?: Record<string, unknown>): Promise<MixdogEngine>;
  callDaemonSession: EngineDaemonClientModule['callDaemonSession'];
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

export interface DesktopBackendAdapter {
  readonly clientCount: number;
  invoke(method: string, args: unknown[]): Promise<unknown>;
  control(message: unknown): Promise<void>;
  dispose(reason?: string): Promise<void>;
}

/** EngineHost runtime hosted inside the machine backend daemon.
 *
 * DesktopBackendClient remains a pure, tested projection/cache layer. The
 * adapter itself never follows a desktop view's lifetime; this object's
 * dispose runs only when the daemon exits.
 */
export async function createDesktopBackend(
  { options, runtime, emit, onClientCountChanged }: DesktopBackendFactoryInput,
): Promise<DesktopBackendAdapter> {
  if (!runtime || typeof runtime.createRemoteEngineSession !== 'function'
    || typeof runtime.callDaemonSession !== 'function') {
    throw new TypeError('Mixdog desktop backend runtime bridge is unavailable.');
  }
  const host = new EngineHost({
    ...options,
    createEngine: (engineOptions) => runtime.createRemoteEngineSession(engineOptions),
    engineDaemonClient: { callDaemonSession: runtime.callDaemonSession },
    loadProjects: runtime.loadProjects,
    loadSessionStore: runtime.loadSessionStore,
    loadStatuslineSegments: runtime.loadStatuslineSegments,
    executeCodeGraphTool: runtime.executeCodeGraphTool,
  });
  const operations = createDesktopBackendOperations({
    userDataPath: options.userDataPath,
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
    appPath: options.appPath,
    loadConfig: runtime.loadConfig,
    loadCommitCompletion: runtime.loadCommitCompletion,
    emit: (event) => emit({ kind: 'backend-event', ...event }),
  });
  const settingsStore = operations.settingsStore;
  const remoteHost = new Proxy(host, {
    get(target, property) {
      if (property === 'backendInvoke') {
        return (name: string, args: unknown[] = []) => operations.invoke(name, args);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as DesktopEngineHost;
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
      } : null,
    };
  };
  const remoteOptions = {
    host: remoteHost,
    settingsStore,
    onDesktopSettingsChanged: (value: unknown) => {
      emit({ kind: 'backend-event', name: 'desktop-settings-changed', value });
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
              kind: 'backend-event',
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
              kind: 'backend-event',
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
    ]);
    remoteBridge = null;
    remoteRelay = null;
    try { await bridge?.close(); } catch {}
    try { await relay?.close(); } catch {}
    await startRemoteServices();
    return remoteDescriptor();
  };
  const rpcMethods = new Set<string>(ENGINE_HOST_RPC_METHODS);
  const visibleSessionIds = new Set<string>();
  const stateEncoder = createSnapshotDeltaEncoder();
  const sessionStateEncoders = new Map<string, SnapshotDeltaEncoder>();
  const latestSessionStates = new Map<string, EngineSnapshot>();
  const latestSessionProvenance = new Map<string, {
    frameSource?: 'live' | 'replay';
    contentRevision?: number;
  }>();

  const stateMailbox = createLatestStateMailbox<EngineSnapshot>((sequence, snapshot) => {
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
        ...(update.frameSource ? { frameSource: update.frameSource } : {}),
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
      ...(update.frameSource ? { frameSource: update.frameSource } : {}),
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
        throw new TypeError('Mixdog desktop backend method is unavailable.');
      }
      if (method === 'backendInvoke') {
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
        EngineHostRpcMethod,
        (...values: unknown[]) => unknown
      >)[method as EngineHostRpcMethod];
      return await target.apply(host, args);
    },
    async control(value): Promise<void> {
      if (!value || typeof value !== 'object') return;
      const message = value as DesktopBackendInbound;
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
      if (!encoder || snapshot === undefined) return;
      encoder.reset();
      postSessionState({
        sessionId,
        snapshot,
        ...(latestSessionProvenance.get(sessionId) ?? {}),
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
