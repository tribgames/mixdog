// One daemon connection: its service client, the transport generation the
// client is currently on, the ssh RemoteSession (server connections only) and
// the model proxy that runs the daemon's model calls with this PC's
// credentials.
import type { DesktopConnectionNotice, SessionSnapshot } from '../../shared/contract';
import type { DesktopServerPort } from '../../shared/contract-server-ports';
import { DEFAULT_STARTUP_TIMEOUT_MS, DesktopServiceClient } from '../desktop-service-client';
import type { SerializableDesktopServiceOptions } from '../desktop-service-contract';
import type { DesktopTerminalHost } from '../ipc-terminal';
import {
  createModelProxyHost,
  type ModelProxyCallSettled,
  type ModelProxyHost,
  type ModelProxyHostOptions,
  type ModelProxyRuntime,
} from '../model-proxy-host';
import { SessionTransport } from '../session-transport';
import { describeConnectFailure } from '../ssh/connect-failure';
import { REMOTE_INSTALL_TIMEOUT_MS, REMOTE_PROBE_TIMEOUT_MS } from '../ssh/remote-bootstrap';
import { RemoteSession, type RemoteDaemonConnector, type RemoteSessionConfig } from '../ssh/remote-session';
import { parseSshTarget } from '../ssh/ssh-command';
import { currentSshContext, runWithSshContext, type SshHostSettings, type SshModelLogin } from '../ssh/ssh-context';
import {
  ConnectionLink,
  LINK_STABLE_RESET_MS,
  RECONNECT_BASE_DELAY_MS,
  reconnectDelayCapMs,
  remoteClientGraceMs,
  type LinkFailure,
} from './connection-link';
import type { ConnectionIdentity, ConnectionProgress } from './contract';
import { createReattachReport } from './reattach-report';
import type { ServerPortForwards } from './server-port-forwards';
import { createServiceTerminalHost } from './terminal-host';
import { createCapabilityLane } from '../protocol/capability-route';
import { withSectionCapabilities } from '../protocol/section-capability-lane';
import { createOperationLane } from '../protocol/desktop-operation-route';
import type { OperationHost } from '../protocol/section-reads';
import type { ProtocolConnection } from '../protocol/connection';
import { createCoreModelProxy } from '../protocol/model-proxy-relay';

/** How long a server's tunnel may take to accept its first connection. */
export const REMOTE_TUNNEL_READY_TIMEOUT_MS = 90_000;
/** A server connection's whole startup: the longest bootstrap (probe, then an
 *  upload with an npm install and a daemon start), the tunnel coming up, and
 *  the same handshake budget this PC's daemon gets. A first install must not
 *  be cut short by the client's startup deadline. */
export const REMOTE_STARTUP_TIMEOUT_MS =
  REMOTE_PROBE_TIMEOUT_MS + REMOTE_INSTALL_TIMEOUT_MS + REMOTE_TUNNEL_READY_TIMEOUT_MS + DEFAULT_STARTUP_TIMEOUT_MS;

export interface DesktopConnection extends ConnectionIdentity {
  /** The ssh destination; null for this PC. */
  readonly target: string | null;
  readonly client: DesktopServiceClient;
  /** This process's one protocol connection to the connection's core: pushed sections, detail calls, host role.
   *  Null for a target whose core endpoint is not wired yet (server tunnels). */
  readonly protocol: ProtocolConnection | null;
  /** The current ssh session; reopening after a terminal failure replaces it. */
  readonly remote: RemoteSession | null;
  /** What the server window shows about its link; null for this PC. */
  readonly link: ConnectionLink | null;
  readonly modelProxy: ModelProxyHost;
  readonly terminals: DesktopTerminalHost;
  /** The server's Ports panel (listening ports, forwards); null for this PC. */
  readonly ports: ServerPortForwards | null;
  /** Whose provider logins the server's models run on now: 'pc' (this PC's,
   *  through the model proxy) unless the server uses its own. Always 'pc' for this PC. */
  readonly modelLogin: SshModelLogin;
  /** The saved choice changed while attached: the server's daemon restarts
   *  (running turns stop) in that mode and the windows attach to it again. */
  applyModelLogin(modelLogin: SshModelLogin): Promise<void>;
  /** Calls `listener` once when the connection stops running models with
   *  `modelLogin`: it is disposed (disconnect, quit) or its model login
   *  changes; at once when it already has. Returns the unsubscribe. */
  onModelLoginEnd(modelLogin: SshModelLogin, listener: () => void | Promise<void>): () => void;
  /** The transport generation the client is attached through, if any. */
  transport(): SessionTransport | null;
  /** Notices for the connection's windows (re-attach report, sign-in). */
  subscribeNotices(listener: (notice: DesktopConnectionNotice) => void): () => void;
  /** Reconnect now; a connection a terminal failure stopped is opened again
   *  (inside the caller's ssh context, so a user's attempt may prompt). */
  reconnect(): Promise<void>;
  /** A terminal failure stopped it: only reconnect() brings it back. */
  stopped(): boolean;
  /** The daemon-side user data directory: this PC's profile, or the server
   *  layout's once the tunnel is up. */
  serviceUserDataPath(): string;
  start(): Promise<void>;
  /** Detach: the client and tunnel close, a remote daemon keeps running. */
  dispose(): Promise<void>;
}

export interface DesktopConnectionDependencies {
  /** The Node service module this PC's local connection runs until the core replaces it (K1). */
  moduleUrl(): string;
  /** Settles once this process's environment is final (local daemon spawn). */
  environmentReady(): Promise<unknown>;
  sessionOptions(): SerializableDesktopServiceOptions;
  loadModelProxyRuntime(): Promise<ModelProxyRuntime>;
  appVersion: string;
  remoteGraceMs?: string;
  initialSnapshot?(): SessionSnapshot;
  onDiagnostic?(connection: ConnectionIdentity, event: string, data: Record<string, unknown>): void;
  onServiceReady?(connection: ConnectionIdentity, context: { generation: number }): void;
  /** The protocol connection of `connection`'s core, or null when its endpoint is not available. A server's
   *  endpoint is its SSH tunnel, reached through `connector`; this PC's has none. */
  createProtocol?(connection: ConnectionIdentity, connector: RemoteDaemonConnector | null): ProtocolConnection | null;
  /** The host's provider consent: may this server's turns use `provider`
   *  with this PC's sign-in? Absent, or a host without a list: all may. */
  isProviderAllowed?(connection: ConnectionIdentity, provider: string): boolean;
  /** What only this process answers for the renderer's desktop operations: `pcNotificationsSupported`,
   *  `readDisplayPreferences`, `hostName` (protocol/section-reads.ts `OperationHost`). */
  operationHost?(): Partial<Omit<OperationHost, 'emitDesktopEvent'>>;
  /** The providers the host lets this server use (`allowedProvidersForHost`): null = every one enabled here, [] = none. */
  allowedProviders?(connection: ConnectionIdentity): string[] | null;
  /** This PC's own core connection, where a server core's proxied model calls run (`modelProxy/run`). */
  localProtocol?(): ProtocolConnection | null;
  /** A server connection's port forwards; the listening ports reach them through `update`. */
  createPortForwards?(connection: ConnectionIdentity, target: string): ServerPortForwards;
}

export interface DesktopConnectionSpec extends ConnectionIdentity {
  target?: string | null;
  /** Server working directory (`~`, `~/x` or absolute); the home by default. */
  remoteCwd?: string | null;
  /** The host's "reconnect automatically" setting; on unless false. */
  autoReconnect?: boolean;
  /** The host's grace (how long the server keeps its daemon for this PC
   *  while away); the server default when absent. */
  graceMs?: number;
  /** The host's model login; this PC's unless 'server'. */
  modelLogin?: SshModelLogin;
}

interface DesktopConnectionOptions {
  onProgress?: (progress: ConnectionProgress) => void;
  forceRestart?: boolean;
}

/** The ssh half of a server connection: its current RemoteSession (reopening
 *  after a terminal failure replaces it), the connector transports dial
 *  through, and where the server keeps the service's user data. */
interface RemoteBinding {
  /** Replaced (never mutated) when the model login changes in place. */
  config: RemoteSessionConfig;
  session: RemoteSession;
  readonly connector: RemoteDaemonConnector;
  /** The saved settings (identity file, ...) the connect attempt that created
   *  this connection ran under; later reconnects run outside any attempt. */
  settings: SshHostSettings | undefined;
}

/** Runs ssh work of a connection under its retained settings, unless the
 *  caller already runs under an attempt that carries its own. */
function underSettings<T>(binding: RemoteBinding, run: () => T): T {
  const current = currentSshContext();
  if (current?.settings || !binding.settings) return run();
  return runWithSshContext({ ...current, settings: binding.settings }, run);
}

function bindRemote(spec: DesktopConnectionSpec, options: DesktopConnectionOptions): RemoteBinding {
  if (!spec.target) throw new Error('An ssh connection needs a target.');
  const config: RemoteSessionConfig = {
    target: spec.target,
    remoteCwd: spec.remoteCwd ?? null,
    tunnelReadyTimeoutMs: REMOTE_TUNNEL_READY_TIMEOUT_MS,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.forceRestart ? { forceRestart: true } : {}),
    ...(spec.autoReconnect === false ? { autoReconnect: false } : {}),
    ...(spec.modelLogin === 'server' ? { modelLogin: 'server' as const } : {}),
  };
  const first = new RemoteSession(config);
  // Every transport generation goes through the current RemoteSession (and
  // its supervised tunnel); reopening after a terminal failure swaps it.
  // The wrapper records where the server keeps the service's user data
  // once the layout is known.
  const binding: RemoteBinding = {
    config,
    session: first,
    settings: currentSshContext()?.settings,
    connector: {
      display: first.display,
      connect: (log) => underSettings(binding, () => binding.session.connect(log)),
      currentDiscovery: () => binding.session.currentDiscovery(),
      invalidate: () => binding.session.invalidate(),
      fail: (error) => binding.session.fail(error),
      close: () => binding.session.close(),
    },
  };
  return binding;
}

/** A stopped connection refuses every dial: open it again from scratch
 *  (bootstrap, tunnel, attach) behind the same window. `forceRestart`: the
 *  user's confirmation covers stopping the server's daemon. */
async function reopenRemote(
  binding: RemoteBinding,
  forceRestart = currentSshContext()?.forceRestart === true
): Promise<void> {
  const stopped = binding.session;
  binding.session = new RemoteSession({
    ...binding.config,
    onProgress: undefined,
    forceRestart,
  });
  await stopped.close();
}

const bindingModelLogin = (binding: RemoteBinding | null): SshModelLogin =>
  binding?.config.modelLogin === 'server' ? 'server' : 'pc';

/** What the server window shows about its link, driven by the service client's
 *  diagnostics and by the ssh session's own actions. */
function createConnectionLink(
  spec: DesktopConnectionSpec,
  graceMs: number,
  binding: RemoteBinding,
  client: DesktopServiceClient
): ConnectionLink {
  const session = (): RemoteSession => binding.session;
  return new ConnectionLink({
    connectionId: spec.id,
    graceMs,
    ...(spec.autoReconnect === false ? { autoReconnect: false } : {}),
    modelLogin: bindingModelLogin(binding),
    actions: {
      hold: () => session().hold(),
      release: () => session().release(),
      probe: (timeoutMs) => session().probeHealth(timeoutMs),
      resetTunnel: () => underSettings(binding, () => session().resetTunnel()),
      reviveTunnel: () => underSettings(binding, () => session().reviveTunnel()),
      retryService: () => void client.retryNow().catch(() => {}),
      stoppedBy: () => {
        const failure = session().stoppedBy;
        return failure ? describeLinkFailure(failure, spec.target ?? '') : null;
      },
    },
  });
}

/** What a server window shows and keeps about its connection. */
interface ServerPanels {
  readonly link: ConnectionLink;
  readonly ports: ServerPortForwards | null;
  readonly reattach: ReturnType<typeof createReattachReport>;
}

function createServerPanels({
  spec,
  deps,
  identity,
  graceMs,
  binding,
  client,
  protocol,
  emitNotice,
}: {
  spec: DesktopConnectionSpec;
  deps: DesktopConnectionDependencies;
  identity: ConnectionIdentity;
  graceMs: number;
  binding: RemoteBinding;
  client: DesktopServiceClient;
  protocol: ProtocolConnection | null;
  emitNotice(notice: DesktopConnectionNotice): void;
}): ServerPanels {
  const ports = deps.createPortForwards?.(identity, binding.config.target) ?? null;
  // The server's listening ports are the core's pushed `ports` section (sampled only while a window views them).
  if (ports) {
    protocol?.watchSection('ports', (entry) => {
      if (Array.isArray(entry?.value)) ports.update(entry.value as DesktopServerPort[]);
    });
  }
  const link = createConnectionLink(spec, graceMs, binding, client);
  const reattach = createReattachReport({
    sources: {
      subscribeSessions: (listener) => client.subscribeSessions(listener),
      subscribeSessionStates: (listener) => client.subscribeSessionStates(listener),
      subscribeLink: (listener) => link.subscribe(listener),
    },
    emit: emitNotice,
  });
  return { link, ports, reattach };
}

/** One service diagnostic's effect on the link. */
function feedLink(link: ConnectionLink, event: string, client: DesktopServiceClient, target: string): void {
  if (LINK_LOST_EVENTS.has(event)) link.serviceLost();
  else if (LINK_RESTORED_EVENTS.has(event)) link.serviceRestored();
  else if (event === 'desktop-transport-terminal' && client.terminalFailure) {
    link.terminal(describeLinkFailure(client.terminalFailure, target));
  }
}

/** What the service client's callbacks reach: the transport it is on, and the
 *  server panels once they exist (the client's callbacks only run after start()). */
interface ClientLive {
  transport: SessionTransport | null;
  panels: ServerPanels | null;
}

function createServiceClient({
  spec,
  deps,
  identity,
  binding,
  graceMs,
  live,
  protocol,
}: {
  spec: DesktopConnectionSpec;
  deps: DesktopConnectionDependencies;
  identity: ConnectionIdentity;
  binding: RemoteBinding | null;
  graceMs: number;
  live: ClientLive;
  protocol: ProtocolConnection | null;
}): DesktopServiceClient {
  const client = new DesktopServiceClient({
    // A connection with a core endpoint sends its session capabilities there (capability-route.ts).
    // The capabilities the sections replaced are answered from the connection's sections (section-capability-lane.ts).
    ...(protocol
      ? {
          capabilityLane: withSectionCapabilities({
            lane: createCapabilityLane({ protocol }),
            protocol,
            snapshot: () => client.getSnapshot(),
          }),
          // What only this process knows (the OS's notification support, the window's theme, its windows' event feed)
          // is handed to the lane.
          operationLane: createOperationLane({
            protocol,
            host: { ...deps.operationHost?.(), emitDesktopEvent: (name, value) => client.emitDesktopEvent(name, value) },
          }),
        }
      : {}),
    connect: () => {
      live.transport = new SessionTransport(
        deps.moduleUrl(),
        process.cwd(),
        null,
        deps.environmentReady(),
        binding?.connector ?? null
      );
      return live.transport;
    },
    // First remote boot uploads the service bundle and may start the daemon;
    // its restarts follow the link's ladder, inside the server's grace.
    ...(binding
      ? {
          startupTimeoutMs: REMOTE_STARTUP_TIMEOUT_MS,
          restartBaseDelayMs: RECONNECT_BASE_DELAY_MS,
          restartMaxDelayMs: reconnectDelayCapMs(graceMs),
          restartStableMs: LINK_STABLE_RESET_MS,
        }
      : {}),
    sessionOptions: () => deps.sessionOptions(),
    ...(deps.initialSnapshot ? { initialSnapshot: deps.initialSnapshot() } : {}),
    onDiagnostic: (event, data) => {
      if (live.panels) feedLink(live.panels.link, event, client, spec.target ?? '');
      deps.onDiagnostic?.(identity, event, data);
    },
    onServiceReady: (context) => {
      if (live.panels && binding) {
        // The core always serves terminals; no per-server capability remains to ask.
        live.panels.link.setTerminalsAvailable(true);
        live.panels.link.serviceRestored();
      }
      // Attached (first time or again): the saved forwards run again.
      void live.panels?.ports?.restore().catch(() => undefined);
      deps.onServiceReady?.(identity, context);
    },
  });
  return client;
}

/** The model proxy that runs the daemon's model calls with this PC's
 *  credentials. Idle unless the connected daemon publishes model-proxy
 *  requests. */
function createConnectionModelProxy({
  spec,
  deps,
  identity,
  client,
  reattach,
  emitNotice,
  serverLogins,
  protocol,
}: {
  spec: DesktopConnectionSpec;
  deps: DesktopConnectionDependencies;
  identity: ConnectionIdentity;
  protocol: ProtocolConnection | null;
  client: DesktopServiceClient;
  reattach: ReturnType<typeof createReattachReport> | null;
  emitNotice(notice: DesktopConnectionNotice): void;
  /** The server runs models with its own logins now. */
  serverLogins(): boolean;
}): ModelProxyHost {
  // A server with a core endpoint asks this PC through the protocol (`model/proxy/execute`, DS §12.4), not through the
  // claim/event/resolve/heartbeat operations: the calls run on this PC's own core.
  const local = spec.kind === 'ssh' && protocol ? (deps.localProtocol?.() ?? null) : null;
  if (spec.kind === 'ssh' && protocol) {
    if (!local) throw new Error('A server core can use this PC\'s model sign-ins only through this PC\'s own core.');
    const core = createCoreModelProxy(
      protocol,
      local,
      () => deps.allowedProviders?.(identity) ?? null,
      {
        serving: () => !serverLogins(),
        ...(reattach
          ? {
              onCallSettled: (event) => {
                reattach.onModelCall(event);
                // The server's turn ran on this PC's sign-in: say which one failed.
                if (event.outcome === 'failed' && isSignInFailure(event.error)) {
                  emitNotice({ kind: 'model-sign-in', provider: event.provider });
                }
              },
            }
          : {}),
      }
    );
    return { handleDesktopEvent: () => false, revoke: core.revoke, dispose: core.dispose, get running() { return core.running; } };
  }
  const proxyOptions: ModelProxyHostOptions = {
    invoke: (operation, args) => client.invokeDesktopOperation(operation, args),
    loadRuntime: () => deps.loadModelProxyRuntime(),
    // A server on its own logins is never served from this PC: nothing of
    // this PC's providers is described to it and no call runs on its sign-ins.
    serving: () => !serverLogins(),
  };
  // Server connections only: this PC's own daemon uses its own sign-ins.
  if (spec.kind === 'ssh') {
    if (deps.isProviderAllowed) {
      proxyOptions.isProviderAllowed = (provider) => Boolean(deps.isProviderAllowed?.(identity, provider));
    }
  }
  if (reattach) {
    proxyOptions.onCallSettled = (event: ModelProxyCallSettled) => {
      reattach.onModelCall(event);
      // The server's turn ran on this PC's sign-in: say which one failed.
      if (event.outcome === 'failed' && isSignInFailure(event.error)) {
        emitNotice({ kind: 'model-sign-in', provider: event.provider });
      }
    };
  }
  return createModelProxyHost(proxyOptions);
}

export function createDesktopConnection(
  spec: DesktopConnectionSpec,
  deps: DesktopConnectionDependencies,
  options: DesktopConnectionOptions = {}
): DesktopConnection {
  const identity: ConnectionIdentity = { id: spec.id, kind: spec.kind, name: spec.name };
  const binding = spec.kind === 'ssh' ? bindRemote(spec, options) : null;
  const graceMs = spec.graceMs ?? remoteClientGraceMs(deps.remoteGraceMs);
  const protocol = deps.createProtocol?.(identity, binding?.connector ?? null) ?? null;
  const live: ClientLive = { transport: null, panels: null };
  const client = createServiceClient({ spec, deps, identity, binding, graceMs, live, protocol });
  const notices = new Set<(notice: DesktopConnectionNotice) => void>();
  const emitNotice = (notice: DesktopConnectionNotice): void => {
    for (const listener of notices) listener(notice);
  };
  const panels = binding ? createServerPanels({ spec, deps, identity, graceMs, binding, client, protocol, emitNotice }) : null;
  live.panels = panels;
  const serverLogins = (): boolean => bindingModelLogin(binding) === 'server';
  const modelProxy = createConnectionModelProxy({
    spec,
    deps,
    identity,
    client,
    reattach: panels?.reattach ?? null,
    emitNotice,
    serverLogins,
    protocol,
  });
  const unsubscribeModelProxy = client.subscribeDesktopEvents(({ name, value }) => {
    modelProxy.handleDesktopEvent(name, value);
  });
  let disposal: Promise<void> | null = null;
  // Watchers of one model login: each is called once, when the connection is
  // disposed or its model login is no longer the one watched.
  const loginWatchers = new Set<{ modelLogin: SshModelLogin; listener: () => void | Promise<void> }>();
  /** Calls the ended watchers; settles once their work (a cancel sent to the
   *  server) has, while the client is still attached. */
  const endLogins = async (all: boolean): Promise<void> => {
    const ended: Array<void | Promise<void>> = [];
    for (const watcher of [...loginWatchers]) {
      if (!all && bindingModelLogin(binding) === watcher.modelLogin) continue;
      loginWatchers.delete(watcher);
      ended.push(watcher.listener());
    }
    await Promise.allSettled(ended);
  };
  return {
    ...identity,
    target: spec.kind === 'ssh' ? (spec.target ?? null) : null,
    client,
    protocol,
    get remote() {
      return binding?.session ?? null;
    },
    link: panels?.link ?? null,
    modelProxy,
    get modelLogin() {
      return bindingModelLogin(binding);
    },
    async applyModelLogin(modelLogin) {
      if (!panels || !binding || disposal || bindingModelLogin(binding) === modelLogin) return;
      binding.config = { ...binding.config, modelLogin };
      // Proxy work the old mode took up ends here: none of it reads or
      // answers anything of this PC's after the switch.
      modelProxy.revoke();
      await endLogins(false);
      panels.link.setModelLogin(modelLogin);
      // The user confirmed that the server's running turns stop: the new
      // session's bootstrap replaces the daemon of the other mode even while
      // it is busy, and every window attaches to the new one.
      await reopenRemote(binding, true);
      panels.link.reopening();
      await client.reattach();
    },
    terminals: createServiceTerminalHost(client),
    ports: panels?.ports ?? null,
    transport: () => live.transport,
    subscribeNotices(listener) {
      notices.add(listener);
      return () => notices.delete(listener);
    },
    onModelLoginEnd(modelLogin, listener) {
      if (disposal || bindingModelLogin(binding) !== modelLogin) {
        queueMicrotask(listener);
        return () => undefined;
      }
      const watcher = { modelLogin, listener };
      loginWatchers.add(watcher);
      return () => loginWatchers.delete(watcher);
    },
    serviceUserDataPath() {
      // A server's core keeps its own data; only this PC's profile is addressable from here.
      if (spec.kind === 'local') return deps.sessionOptions().userDataPath;
      throw new Error(`The connection to ${spec.name} is not attached yet.`);
    },
    async start() {
      await client.start();
      // The core is serving once the service attached; windows read sections from here on.
      await protocol?.start();
      if (panels && binding) {
        panels.link.setTerminalsAvailable(true);
        panels.link.start();
      }
    },
    stopped() {
      return Boolean(client.terminalFailure || binding?.session.stoppedBy);
    },
    async reconnect() {
      if (!panels || !binding || disposal) return;
      if (!client.terminalFailure && !binding.session.stoppedBy) {
        panels.link.retry();
        return;
      }
      const attempted = currentSshContext()?.settings;
      await reopenRemote(binding);
      panels.link.reopening();
      await client.reattach();
      // A user's attempt authenticated with these: later reconnects keep them.
      if (attempted) binding.settings = attempted;
    },
    dispose() {
      disposal ??= (async () => {
        await endLogins(true);
        panels?.link.dispose();
        panels?.reattach.dispose();
        await panels?.ports?.dispose().catch(() => undefined);
        notices.clear();
        unsubscribeModelProxy();
        modelProxy.dispose();
        try {
          await protocol?.close().catch(() => undefined);
          await client.dispose();
        } finally {
          await binding?.session.close();
        }
      })();
      return disposal;
    },
  };
}

/** The service lost its stream, its daemon or its transport. */
const LINK_LOST_EVENTS = new Set([
  'session-stream-reconnecting',
  'session-daemon-reconnecting',
  'desktop-transport-exit',
]);
/** The service is attached again. */
const LINK_RESTORED_EVENTS = new Set(['session-stream-reconnected', 'session-daemon-reconnected']);

/** A refused host key or login can only be confirmed again where servers are
 *  managed: Settings → Connection in this PC's window. */
export function describeLinkFailure(error: Error, target: string): LinkFailure {
  let kind = 'failed';
  try {
    kind = describeConnectFailure(error, parseSshTarget(target), process.platform).kind;
  } catch {
    /* an unparsable target keeps the generic kind */
  }
  return {
    code: kind,
    message: error.message,
    ...(kind === 'host-key-changed' || kind === 'auth' ? { settingsRequired: true } : {}),
  };
}

/** This PC's model sign-in was refused (expired or revoked). */
export function isSignInFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as { reauthRequired?: unknown; status?: unknown; httpStatus?: unknown };
  return record.reauthRequired === true || Number(record.httpStatus ?? record.status) === 401;
}
