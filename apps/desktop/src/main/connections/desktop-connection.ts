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
import { currentSshContext, type SshModelLogin } from '../ssh/ssh-context';
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
  onModelLoginEnd(modelLogin: SshModelLogin, listener: () => void): () => void;
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
  moduleUrl(): string;
  /** Settles once this process's environment is final (local daemon spawn). */
  environmentReady(): Promise<unknown>;
  sessionOptions(): SerializableDesktopServiceOptions;
  loadModelProxyRuntime(): Promise<ModelProxyRuntime>;
  appVersion: string;
  /** Local path of the desktop service bundle uploaded to servers. */
  bundlePath: string;
  remoteGraceMs?: string;
  initialSnapshot?(): SessionSnapshot;
  onDiagnostic?(connection: ConnectionIdentity, event: string, data: Record<string, unknown>): void;
  onServiceReady?(connection: ConnectionIdentity, context: { generation: number }): void;
  /** The host's provider consent: may this server's turns use `provider`
   *  with this PC's sign-in? Absent, or a host without a list: all may. */
  isProviderAllowed?(connection: ConnectionIdentity, provider: string): boolean;
  /** A server connection's port forwards; `scan` asks its daemon what listens. */
  createPortForwards?(
    connection: ConnectionIdentity,
    target: string,
    scan: () => Promise<DesktopServerPort[]>
  ): ServerPortForwards;
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
  userDataPath: string | null;
}

function bindRemote(
  spec: DesktopConnectionSpec,
  deps: DesktopConnectionDependencies,
  options: DesktopConnectionOptions
): RemoteBinding {
  if (!spec.target) throw new Error('An ssh connection needs a target.');
  const config: RemoteSessionConfig = {
    target: spec.target,
    remoteCwd: spec.remoteCwd ?? null,
    graceMs: spec.graceMs !== undefined ? String(spec.graceMs) : (deps.remoteGraceMs ?? ''),
    appVersion: deps.appVersion,
    bundlePath: deps.bundlePath,
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
    userDataPath: null,
    connector: {
      display: first.display,
      async connect(log) {
        const endpoint = await binding.session.connect(log);
        binding.userDataPath = endpoint.remapOptions(deps.sessionOptions()).userDataPath;
        return endpoint;
      },
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
      resetTunnel: () => session().resetTunnel(),
      reviveTunnel: () => session().reviveTunnel(),
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
  emitNotice,
}: {
  spec: DesktopConnectionSpec;
  deps: DesktopConnectionDependencies;
  identity: ConnectionIdentity;
  graceMs: number;
  binding: RemoteBinding;
  client: DesktopServiceClient;
  emitNotice(notice: DesktopConnectionNotice): void;
}): ServerPanels {
  const ports =
    deps.createPortForwards?.(identity, binding.config.target, async () => {
      const value = await client.invokeDesktopOperation('listListeningPorts', []);
      return Array.isArray(value) ? (value as DesktopServerPort[]) : [];
    }) ?? null;
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
}: {
  spec: DesktopConnectionSpec;
  deps: DesktopConnectionDependencies;
  identity: ConnectionIdentity;
  binding: RemoteBinding | null;
  graceMs: number;
  live: ClientLive;
}): DesktopServiceClient {
  const client = new DesktopServiceClient({
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
        live.panels.link.setTerminalsAvailable(binding.session.terminalsAvailable);
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
}: {
  spec: DesktopConnectionSpec;
  deps: DesktopConnectionDependencies;
  identity: ConnectionIdentity;
  client: DesktopServiceClient;
  reattach: ReturnType<typeof createReattachReport> | null;
  emitNotice(notice: DesktopConnectionNotice): void;
  /** The server runs models with its own logins now. */
  serverLogins(): boolean;
}): ModelProxyHost {
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
  const binding = spec.kind === 'ssh' ? bindRemote(spec, deps, options) : null;
  const graceMs = spec.graceMs ?? remoteClientGraceMs(deps.remoteGraceMs);
  const live: ClientLive = { transport: null, panels: null };
  const client = createServiceClient({ spec, deps, identity, binding, graceMs, live });
  const notices = new Set<(notice: DesktopConnectionNotice) => void>();
  const emitNotice = (notice: DesktopConnectionNotice): void => {
    for (const listener of notices) listener(notice);
  };
  const panels = binding ? createServerPanels({ spec, deps, identity, graceMs, binding, client, emitNotice }) : null;
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
  });
  const unsubscribeModelProxy = client.subscribeDesktopEvents(({ name, value }) => {
    modelProxy.handleDesktopEvent(name, value);
  });
  let disposal: Promise<void> | null = null;
  // Watchers of one model login: each is called once, when the connection is
  // disposed or its model login is no longer the one watched.
  const loginWatchers = new Set<{ modelLogin: SshModelLogin; listener: () => void }>();
  const endLogins = (all: boolean): void => {
    for (const watcher of [...loginWatchers]) {
      if (!all && bindingModelLogin(binding) === watcher.modelLogin) continue;
      loginWatchers.delete(watcher);
      watcher.listener();
    }
  };
  return {
    ...identity,
    target: spec.kind === 'ssh' ? (spec.target ?? null) : null,
    client,
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
      endLogins(false);
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
      if (spec.kind === 'local') return deps.sessionOptions().userDataPath;
      if (!binding?.userDataPath) throw new Error(`The connection to ${spec.name} is not attached yet.`);
      return binding.userDataPath;
    },
    async start() {
      await client.start();
      if (panels && binding) {
        panels.link.setTerminalsAvailable(binding.session.terminalsAvailable);
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
      await reopenRemote(binding);
      panels.link.reopening();
      await client.reattach();
    },
    dispose() {
      disposal ??= (async () => {
        endLogins(true);
        panels?.link.dispose();
        panels?.reattach.dispose();
        await panels?.ports?.dispose().catch(() => undefined);
        notices.clear();
        unsubscribeModelProxy();
        modelProxy.dispose();
        try {
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
