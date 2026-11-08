import { get as httpGet } from 'node:http';
import { posix } from 'node:path';

import type { ConnectionProgress } from '../connections/contract';
import { bootstrapRemoteDaemon, isTerminalRemoteError } from './remote-bootstrap';
import { parseSshTarget, SshError, type SshTarget } from './ssh-command';
import type { SshModelLogin } from './ssh-context';
import type { SshSpawn } from './ssh-exec';
import { SshTunnel, type TunnelDependencies } from './tunnel';

/** Discovery as the protocol client consumes it: the port is the LOCAL end of
 *  the tunnel to the core's WebSocket listener; token and pid belong to the
 *  remote core. */
export interface TunnelDiscovery {
  port: number;
  token: string;
  pid: number;
}

export interface RemoteDaemonEndpoint {
  discovery: TunnelDiscovery;
  /** Server-side working directory for the attachment. */
  cwd: string;
  /** Version of the Mixdog core running on the server. */
  coreVersion: string;
  /** The core instance; a different one after a reconnect means a new core. */
  instanceId: string;
}

/** What the protocol connection needs from a remote core. */
export interface RemoteDaemonConnector {
  readonly display: string;
  /** Bootstrap (when needed) and bring the tunnel up. Never starts or
   *  touches a local core. */
  connect(log: (line: string) => void): Promise<RemoteDaemonEndpoint>;
  /** Last known discovery; synchronous for reconnect checks. Null until
   *  connected or after invalidate(). */
  currentDiscovery(): TunnelDiscovery | null;
  /** Forget the cached discovery; the next connect re-reads the server. */
  invalidate(): void;
  /** Stop for good on a failure no retry fixes (e.g. a protocol mismatch):
   *  the tunnel closes and every later connect rejects with `error`. */
  fail(error: Error): void;
  /** Detach: close the tunnel, leave the remote core running. */
  close(): Promise<void>;
}

export interface RemoteSessionConfig {
  target: string;
  remoteCwd: string | null;
  tunnelReadyTimeoutMs?: number;
  spawnImpl?: SshSpawn;
  tunnel?: TunnelDependencies;
  /** connect (ssh dialed) → check (platform probed) → install (runtime
   *  upload) or start (core) → start (tunnel coming up) → ready (attached). */
  onProgress?: (progress: ConnectionProgress) => void;
  /** The user confirmed stopping the older core's running work
   *  (`daemon-busy-other-version`): the first bootstrap may abort it. */
  forceRestart?: boolean;
  /** The host's "reconnect automatically" setting; off, a dropped link stays
   *  down until the user reconnects. */
  autoReconnect?: boolean;
  /** Whose provider logins the core runs models on; this PC's by default. */
  modelLogin?: SshModelLogin;
}

const DEFAULT_TUNNEL_READY_TIMEOUT_MS = 90_000;
const IDENTITY_CHECK_TIMEOUT_MS = 5_000;

/** Remote mode is on exactly when MIXDOG_SSH_TARGET is set. */
export function remoteSessionConfigFromEnv(env: NodeJS.ProcessEnv): RemoteSessionConfig | null {
  const target = env.MIXDOG_SSH_TARGET;
  if (!target?.trim()) return null;
  return { target, remoteCwd: env.MIXDOG_SSH_REMOTE_CWD?.trim() || null };
}

/** `~` / `~/x` resolve against the remote home; anything else must be absolute. */
export function resolveRemoteCwd(configured: string | null, home: string): string {
  if (!configured) return home;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what is refused.
  if (/[\u0000-\u001f\u007f]/.test(configured))
    throw new Error('MIXDOG_SSH_REMOTE_CWD must not contain control characters.');
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return posix.join(home, configured.slice(2));
  if (!posix.isAbsolute(configured))
    throw new Error(`MIXDOG_SSH_REMOTE_CWD must be an absolute server path: ${configured}`);
  return posix.normalize(configured);
}

/** Who answers the control listener's /health on the tunnel's companion end,
 *  and how fast. /health takes no token, and none is sent: the answer is
 *  checked first. */
export interface DaemonHealth {
  pid: number;
  /** The run the answering core is (`instanceId`): random per start, so a process that reused the pid differs. */
  instanceId: string | null;
  rttMs: number;
  /** Units of work the core is running (`busy`). */
  busy: number;
}

/** The core the bootstrap found: what the tunnel must lead to. */
export interface DaemonIdentity {
  pid: number;
  /** The `core.instanceId` its discovery file names. */
  instanceId: string;
}

export function readDaemonHealth(port: number, timeoutMs: number): Promise<DaemonHealth | null> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const request = httpGet({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body) as { status?: unknown; pid?: unknown; instanceId?: unknown; busy?: unknown };
          if (health.status !== 'ok') return resolve(null);
          resolve({
            pid: Number(health.pid) || 0,
            instanceId: typeof health.instanceId === 'string' && health.instanceId ? health.instanceId : null,
            rttMs: Math.max(0, Math.round(performance.now() - startedAt)),
            busy: Math.max(0, Number(health.busy) || 0),
          });
        } catch {
          resolve(null);
        }
      });
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

/** The answering process is the probed core: same pid and same run. Anything
 *  else may be another user's process that bound the freed port on a shared
 *  server, or a replacement that reused the pid. */
export function isExpectedDaemon(health: DaemonHealth, identity: DaemonIdentity): boolean {
  return health.pid === identity.pid && health.instanceId === identity.instanceId;
}

/** The tunnel leads to another process than the probed core. */
export function daemonIdentityError(display: string): SshError {
  return new SshError(
    `Another process answered through the ssh tunnel to ${display} instead of the Mixdog core it started. ` +
      'The connection was stopped and nothing was sent to it. Reconnect to start over.',
    'terminal'
  );
}

/** One remote target per desktop process: shared by every protocol connection
 *  generation, so a restart reuses the supervised tunnel. */
export class RemoteSession implements RemoteDaemonConnector {
  readonly display: string;
  private readonly target: SshTarget | null;
  private readonly tunnel: SshTunnel | null;
  private failure: Error | null = null;
  private discovery: TunnelDiscovery | null = null;
  private identity: DaemonIdentity | null = null;
  private controlPort = 0;
  private connecting: Promise<RemoteDaemonEndpoint> | null = null;
  private closed = false;
  private forceRestart: boolean;
  private held = false;

  constructor(private readonly config: RemoteSessionConfig) {
    this.display = String(config.target).trim();
    this.forceRestart = config.forceRestart === true;
    let target: SshTarget | null = null;
    try {
      target = parseSshTarget(config.target);
    } catch (error) {
      this.failure = error instanceof Error ? error : new Error(String(error));
    }
    this.target = target;
    const autoRestart = config.autoReconnect === false ? { autoRestart: false } : {};
    this.tunnel = target
      ? new SshTunnel(target, { spawnImpl: config.spawnImpl, ...autoRestart, ...config.tunnel })
      : null;
  }

  connect(log: (line: string) => void): Promise<RemoteDaemonEndpoint> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.held) return Promise.reject(new Error('Automatic reconnection is off for this server.'));
    if (this.closed) return Promise.reject(new Error('The remote Mixdog connection is closed.'));
    if (!this.connecting) {
      const connecting = this.establish(log).finally(() => {
        if (this.connecting === connecting) this.connecting = null;
      });
      this.connecting = connecting;
    }
    return this.connecting;
  }

  currentDiscovery(): TunnelDiscovery | null {
    return this.discovery;
  }

  invalidate(): void {
    this.discovery = null;
  }

  fail(error: Error): void {
    this.failure ??= error;
    this.discovery = null;
    void this.tunnel?.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.discovery = null;
    await this.tunnel?.close();
  }

  /** The failure that stopped this session for good (its tunnel's included). */
  get stoppedBy(): Error | null {
    return this.failure ?? this.tunnel?.failure ?? null;
  }

  /** One /health round trip to the attached core through the tunnel, in ms;
   *  null when there is no attachment, it times out, or another process answers. */
  async probeHealth(timeoutMs: number): Promise<number | null> {
    const health = await this.controlHealth(timeoutMs);
    return health ? health.rttMs : null;
  }

  /** The attached core's running work, read from its /health through the
   *  tunnel; null when there is no attachment or another process answers. */
  async busySessions(timeoutMs: number): Promise<number | null> {
    const health = await this.controlHealth(timeoutMs);
    return health ? health.busy : null;
  }

  /** Refuses dials (without touching the network) until release(): the
   *  host does not reconnect on its own. */
  hold(): void {
    this.held = true;
  }

  release(): void {
    this.held = false;
  }

  /** Replaces the tunnel's ssh child now (its probes kept failing). */
  resetTunnel(): void {
    this.tunnel?.restartNow();
  }

  /** Starts the tunnel's ssh child now when none runs; a live one stays. */
  reviveTunnel(): void {
    this.tunnel?.revive();
  }

  /** Another answer counts as a failed probe; the next attach re-reads the
   *  server and checks the core's identity before any token is sent. */
  private async controlHealth(timeoutMs: number): Promise<DaemonHealth | null> {
    const identity = this.identity;
    if (!this.discovery || !identity || !this.controlPort) return null;
    const health = await readDaemonHealth(this.controlPort, timeoutMs);
    return health && isExpectedDaemon(health, identity) ? health : null;
  }

  private async establish(log: (line: string) => void): Promise<RemoteDaemonEndpoint> {
    const target = this.target!;
    const tunnel = this.tunnel!;
    const progress = this.config.onProgress;
    try {
      progress?.({ phase: 'connect' });
      const state = await bootstrapRemoteDaemon({
        target,
        ...(this.config.modelLogin === 'server' ? { modelLogin: 'server' as const } : {}),
        ...(this.forceRestart ? { forceRestart: true } : {}),
        spawnImpl: this.config.spawnImpl,
        log,
        onProgress: progress,
      });
      // The user's confirmation covered this open only: a later reconnect
      // never stops a busy core on its own.
      this.forceRestart = false;
      const cwd = resolveRemoteCwd(this.config.remoteCwd, state.report.home);
      progress?.({ phase: 'start' });
      const localPort = await tunnel.ensure(
        state.discovery.rpcPort,
        this.config.tunnelReadyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS,
        state.discovery.controlPort
      );
      if (this.closed) throw new Error('The remote Mixdog connection is closed.');
      // Before the core token goes through the tunnel, the process behind it
      // must be the core the probe found: on a shared server another user
      // could have bound the port it freed.
      const identity: DaemonIdentity = { pid: state.discovery.pid, instanceId: state.discovery.instanceId };
      const controlPort = tunnel.companionBoundPort;
      const health = await readDaemonHealth(controlPort, IDENTITY_CHECK_TIMEOUT_MS);
      if (!health) {
        throw new SshError(`The Mixdog core on ${this.display} does not answer through the ssh tunnel.`, 'transient');
      }
      if (!isExpectedDaemon(health, identity)) throw daemonIdentityError(this.display);
      this.identity = identity;
      this.controlPort = controlPort;
      progress?.({ phase: 'ready' });
      const discovery = { port: localPort, token: state.discovery.token, pid: state.discovery.pid };
      this.discovery = discovery;
      return {
        discovery,
        cwd,
        coreVersion: state.discovery.version,
        instanceId: state.discovery.instanceId,
      };
    } catch (error) {
      // A changed host key, a refused login, an unsupported server or an older
      // desktop will not fix itself: stop dialing until the app restarts, and
      // keep the original words.
      if (isTerminalRemoteError(error) || tunnel.failure) this.fail(tunnel.failure ?? (error as Error));
      throw error;
    }
  }
}
