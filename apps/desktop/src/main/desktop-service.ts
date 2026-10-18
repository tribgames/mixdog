import { dirname, join } from 'node:path';

import type { ConversationImportJob } from '../shared/contract-import';
import { createConversationImportProgress } from './conversation-import-progress';
import type {
  DesktopCapability,
  DesktopRemoteAccessSettings,
  DesktopRemoteClientInfo,
  DesktopBrowserImportProgress,
  DesktopRemoteBrowserStreamFrame,
  DesktopRemoteBrowserTab,
} from '../shared/contract';
import { BROWSER_OPEN_REQUESTED_DESKTOP_EVENT } from '../shared/remote-browser';
import { REMOTE_VISUALIZE_LANE, VISUALIZE_REMOTE_DESKTOP_EVENT } from '../shared/visualize';
import { createRemoteVisualizeMirror } from './remote-visualize';
import { randomUUID } from 'node:crypto';

import type {
  MixdogProjectsModule,
  MixdogSessionSearchModule,
  MixdogSessionStoreModule,
  MixdogWorktreesModule,
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
import { createDesktopServiceStateSync } from './desktop-service-state-sync';
import { createDesktopOperations } from './desktop-operations';
import { projectRecoveryStorePath } from './project-recovery-store';
import { sessionRecordsReferencing } from './server-file-operations';
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
import { createRemoteAccessSettingsStore } from './remote-access-settings';
import { loadRemoteClientCache } from './remote-client-cache';
import { createPendingRevokeDrain } from './remote-revoke-drain';
import { rotateRelayE2EEIdentity } from './remote-e2ee';
import type { RemoteHostRequestMethod } from './remote-methods';
import type { BrowserRemoteMethod } from './remote-browser-methods';
import {
  getModelProxyChannel,
  MODEL_PROXY_REQUEST_EVENT,
} from '../../../../src/runtime/agent/orchestrator/providers/model-proxy-channel.mjs';
import { modelProxyClientMode } from '../../../../src/runtime/shared/model-proxy-mode.mjs';
import { registerSessionSidebarHost } from '../../../../src/runtime/shared/session-sidebar-host.mjs';
import { sessionSidebarChangeHandler } from './session-sidebar-actions';

// Slightly under the relay's own claim TTL: a dialog left open must never
// outlive the request it answers.
const REMOTE_CLAIM_TIMEOUT_MS = 295_000;
/** Server-window upload staging sweep: shortly after start, then daily. */
const UPLOAD_SWEEP_FIRST_MS = 5 * 60 * 1000;
const UPLOAD_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  /** Worktree manager; optional: an older daemon has no managed worktrees. */
  loadWorktrees?(): Promise<MixdogWorktreesModule>;
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
  releaseClient(epoch: number): Promise<void>;
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

/** Removing a managed worktree — from the branch chip or the Lead's cwd tool,
 *  both through the runtime's worktree manager — first disposes the desktop
 *  terminals started inside it (termDisposeUnder) and stops the language
 *  servers rooted in it (lspDisposeUnder), before the manager drops its caches
 *  and runs `git worktree remove`, so no PTY or server keeps the folder
 *  locked. Returns the unregister function (a no-op on an older daemon). */
export async function registerWorktreeTerminalReleaser(
  runtime: Pick<DesktopServiceRuntime, 'loadWorktrees'>,
  disposeTerminalsUnder: (root: string) => unknown,
  disposeLanguageServersUnder: (root: string) => unknown = () => undefined
): Promise<() => void> {
  const worktrees = await runtime.loadWorktrees?.();
  const id = randomUUID();
  const unregisters = [
    worktrees?.registerRootReleaser?.(`desktop-terminals:${id}`, (root) => disposeTerminalsUnder(root)),
    worktrees?.registerRootReleaser?.(`desktop-language-servers:${id}`, (root) => disposeLanguageServersUnder(root)),
  ];
  return () => {
    for (const unregister of unregisters) unregister?.();
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
    withRecoveryStore: async (root, action, run) => {
      const worktrees = await runtime.loadWorktrees?.();
      if (worktrees?.withWorktreeRecoveryStore)
        return worktrees.withWorktreeRecoveryStore(
          root,
          projectRecoveryStorePath(options.userDataPath, root),
          action,
          run
        );
      if (worktrees && (await (worktrees.findWorktreeContaining ?? worktrees.getWorktreeByPath)(root)))
        throw new Error('Worktree file recovery protection is unavailable. Update the host before editing.');
      return run();
    },
    userDataPath: options.userDataPath,
    packaged: options.packaged,
    resourcesPath: options.resourcesPath,
    appPath: options.appPath,
    loadConfig: runtime.loadConfig,
    loadDocumentPreview: runtime.loadDocumentPreview ? () => runtime.loadDocumentPreview!() : undefined,
    emit: (event) => publishDesktopEvent(event.name, event.value),
  });
  const importProgress = createConversationImportProgress({
    fetchJobs: async () => {
      const { value } = await host.invokeCapability<{ jobs?: ConversationImportJob[] }>('getConversationImportJobs', [
        {},
      ]);
      return value?.jobs ?? [];
    },
    publish: publishDesktopEvent,
  });
  const unregisterTerminalReleaser = await registerWorktreeTerminalReleaser(
    runtime,
    (root) => operations.invoke('termDisposeUnder', [root]),
    (root) => operations.invoke('lspDisposeUnder', [root])
  );
  // The Lead's `session` tool (favorite / archive) runs
  // in this daemon and applies its change through the same host methods.
  const unregisterSessionSidebarHost = registerSessionSidebarHost(sessionSidebarChangeHandler(host));
  const settingsStore = operations.settingsStore;
  // A deleted session takes its server-window upload staging folder with it.
  const deleteSessionWithUploads = async (sessionId: unknown): Promise<unknown> => {
    const result = await host.deleteSession(String(sessionId || ''));
    void operations.serverFiles.removeSessionUploads(String(sessionId || '')).catch(() => {});
    return result;
  };
  const sweepUploads = async (): Promise<void> => {
    const store = await runtime.loadSessionStore();
    const liveSessionIds = store
      .listStoredSessionSummaries()
      .map((row) => String(row.id || ''))
      .filter(Boolean);
    const sessionsDir = store.storedAgentWorkerIndexPath
      ? join(dirname(store.storedAgentWorkerIndexPath()), 'sessions')
      : null;
    await operations.serverFiles.sweepUploads({
      liveSessionIds,
      // Without the store's location no reference can be ruled out.
      referencedFolders: async (folders) =>
        sessionsDir ? sessionRecordsReferencing(sessionsDir, folders) : new Set(folders),
    });
  };
  const runUploadSweep = (): void => void sweepUploads().catch(() => {});
  const firstUploadSweep = setTimeout(runUploadSweep, UPLOAD_SWEEP_FIRST_MS);
  firstUploadSweep.unref?.();
  const uploadSweepTimer = setInterval(runUploadSweep, UPLOAD_SWEEP_INTERVAL_MS);
  uploadSweepTimer.unref?.();
  const remoteHost = new Proxy(host, {
    get(target, property) {
      if (property === 'deleteSession') return deleteSessionWithUploads;
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
  // The window's agent `visualize` tabs, mirrored for paired remote clients.
  const visualizeMirror = createRemoteVisualizeMirror();
  // Remote mode only: this daemon's model calls run on the connected PC. The
  // request state travels out as an event; the PC answers through operations.
  const modelProxy = modelProxyClientMode() ? getModelProxyChannel() : null;
  const detachModelProxy =
    modelProxy?.attachPublisher((snapshot) => publishDesktopEvent(MODEL_PROXY_REQUEST_EVENT, snapshot)) ?? null;
  const accessSettings = createRemoteAccessSettingsStore(options.userDataPath);
  let pcName = (await accessSettings.read()).name;
  // While access is off the relay is closed and cannot list its paired
  // devices, so the last list seen is what the off state shows.
  const clientCache = await loadRemoteClientCache(options.userDataPath);
  const remembered = async (clients: DesktopRemoteClientInfo[]): Promise<DesktopRemoteClientInfo[]> => {
    const pending = clientCache.pending();
    await clientCache.remember(clients).catch(() => undefined);
    return clients.map((client) => (pending.includes(client.id) ? { ...client, pendingRemoval: true } : client));
  };
  let deviceAliases = await accessSettings.deviceAliases();
  const withAliases = (clients: DesktopRemoteClientInfo[]): DesktopRemoteClientInfo[] =>
    clients.map((client) => (deviceAliases[client.id] ? { ...client, alias: deviceAliases[client.id] } : client));
  const publishAccessSettings = (settings: DesktopRemoteAccessSettings): DesktopRemoteAccessSettings => {
    publishDesktopEvent('remote-access-settings-changed', settings);
    return settings;
  };
  const remoteDescriptor = async () => {
    if (!remoteRelay) {
      return (await accessSettings.disabled())
        ? { relay: { clientUrl: '', token: '', clients: withAliases(clientCache.list()) }, enabled: false }
        : null;
    }
    const descriptor = await remoteAccessDescriptor(remoteRelay);
    if (!descriptor) return null;
    const clients = await remembered(descriptor.relay.clients);
    return { relay: { ...descriptor.relay, clients: withAliases(clients) }, enabled: true };
  };
  /** Revocations asked for while access was off, applied once the relay answers. */
  const applyPendingRevokes = createPendingRevokeDrain({ cache: clientCache, relay: () => remoteRelay });
  const remoteOptions = {
    host: remoteHost,
    hostName: () => pcName,
    deviceAlias: (credentialId: string) => deviceAliases[credentialId] ?? '',
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
    browserRemote: browserRemoteRequests.request,
    hostRequest: browserRemoteRequests.request,
    visualize: visualizeMirror,
    subscribeTerminalData: operations.subscribeTerminalData,
    userDataPath: options.userDataPath,
    onClientCountChanged,
    // Every successful (re)connection drains revocations that failed earlier.
    onConnected: () => {
      if (clientCache.pending().length) void applyPendingRevokes();
    },
    // The window process owns the approval dialog, so the decision travels
    // out as an event and comes back as remoteAccessResolveClaim. An
    // unanswered request expires on its own — the relay drops it at 300s.
    onClientClaim: (claim: RemoteClientClaim): Promise<RemoteClaimDecision> => claims.claim(claim),
    onClaimConflict: (claimId: string): void => void claims.resolve(claimId, false),
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
        // Switched off: no relay leg, no retry, nothing activated.
        if (await accessSettings.disabled()) return;
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
        if (clientCache.pending().length) void applyPendingRevokes();
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
    await clientCache.clear();
    await startRemoteServices(true);
    return remoteDescriptor();
  };
  const setRemoteAccessEnabled = async (enabled: boolean): Promise<DesktopRemoteAccessSettings> => {
    await accessSettings.setEnabled(enabled);
    if (enabled) {
      await startRemoteServices(true);
    } else {
      if (relayRetryTimer) {
        clearTimeout(relayRetryTimer);
        relayRetryTimer = null;
      }
      // A start already in flight finishes first, then its relay is closed.
      await remoteServicesPromise;
      const relay = remoteRelay;
      if (relay) {
        const descriptor = await remoteAccessDescriptor(relay);
        if (descriptor) await remembered(descriptor.relay.clients);
        remoteRelay = null;
        try {
          await relay.close();
        } catch {}
      }
    }
    return publishAccessSettings(await accessSettings.read());
  };
  const setRemotePcName = async (name: string): Promise<DesktopRemoteAccessSettings> => {
    const settings = await accessSettings.setName(name);
    pcName = settings.name;
    remoteRelay?.pushName();
    return publishAccessSettings(settings);
  };
  const rpcMethods = new Set<string>(DESKTOP_SERVICE_METHODS);
  const stateSync = createDesktopServiceStateSync({ host, emit });
  const invokeServiceOperation = async (operation: string, operationArgs: unknown[]): Promise<unknown> => {
    if (modelProxy?.handlesOperation(operation)) return modelProxy.handleOperation(operation, operationArgs);
    switch (operation) {
      case 'remoteAccessStart':
        await startRemoteServices();
        return remoteDescriptor();
      case 'remoteAccessInfo':
        // activate:false is a pure read: warm an activated install, never
        // start or activate a fresh one.
        await startRemoteServices(operationArgs[0] !== false);
        return remoteDescriptor();
      case 'remoteAccessSettings':
        return accessSettings.read();
      case 'remoteAccessSetEnabled':
        return setRemoteAccessEnabled(operationArgs[0] === true);
      case 'remoteAccessSetName':
        return setRemotePcName(String(operationArgs[0] ?? ''));
      case 'remoteAccessSetClientAlias':
        deviceAliases = await accessSettings.setDeviceAlias(
          String(operationArgs[0] || ''),
          String(operationArgs[1] ?? '')
        );
        return null;
      case 'remoteAccessRotate':
        return rotateRemoteAccess();
      case 'remoteAccessListClaims':
        return claims.list(Date.now());
      case 'remoteAccessResolveClaim':
        return claims.resolve(String(operationArgs[0] || ''), operationArgs[1] === true);
      case 'remoteAccessPairCode': {
        // The code exists while Settings → Connection is open; opening it is
        // an explicit remote-access action like the pairing card itself.
        const requested = operationArgs[0];
        const action = requested === 'release' || requested === 'renew' ? requested : 'ensure';
        if (action !== 'release') await startRemoteServices(true);
        return remoteRelay?.pairCode(action) ?? null;
      }
      case 'remoteAccessRevokeClient': {
        await startRemoteServices(true);
        const clientId = String(operationArgs[0] || '');
        if (!remoteRelay) {
          // Off: forget it now, tell the relay on the next enable.
          if (!(await accessSettings.disabled())) return null;
          await clientCache.queueRevoke(clientId);
          return remoteDescriptor();
        }
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
      // The window's visualize changes; the relay forwards the path-free form.
      case 'visualizeRemotePublish': {
        const event = visualizeMirror.apply(operationArgs[0]);
        if (event) publishDesktopEvent(VISUALIZE_REMOTE_DESKTOP_EVENT, event);
        return null;
      }
      case 'visualizeRemoteViewing':
        return remoteRelay?.viewsSessionLane(String(operationArgs[0] || ''), REMOTE_VISUALIZE_LANE) ?? false;
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
        return stateSync.setDeliveryFilter(args);
      }
      if (method === 'deleteSession') return deleteSessionWithUploads(args[0]);
      if (method === 'invokeCapability') {
        const result = await host.invokeCapability(
          args[0] as DesktopCapability,
          args[1] as unknown[],
          args[2] as string
        );
        importProgress.observe(String(args[0]), result.value);
        return result;
      }
      const target = (host as unknown as Record<DesktopServiceMethod, (...values: unknown[]) => unknown>)[
        method as DesktopServiceMethod
      ];
      // The window's own read: its frame must reach the window even before a
      // pane registers the session as visible.
      if (method === 'prefetchSession') {
        return stateSync.runDesktopRead(String(args[0] || ''), async () => await target.apply(host, args));
      }
      return await target.apply(host, args);
    },
    async control(value): Promise<void> {
      if (!value || typeof value !== 'object') return;
      await stateSync.control(value as DesktopServiceInbound);
    },
    releaseClient(epoch): Promise<void> {
      return stateSync.releaseClient(epoch);
    },
    async dispose(): Promise<void> {
      unregisterTerminalReleaser();
      unregisterSessionSidebarHost();
      importProgress.dispose();
      stateSync.dispose();
      desktopEventListeners.clear();
      browserRemoteRequests.rejectAll('Desktop service is closing.');
      detachModelProxy?.();
      clearTimeout(firstUploadSweep);
      clearInterval(uploadSweepTimer);
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
