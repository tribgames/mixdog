import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';
import { posix } from 'node:path';

import type { SerializableDesktopServiceOptions } from '../desktop-service-contract';
import type { ConnectionProgress } from '../connections/contract';
import { bootstrapRemoteDaemon, isTerminalRemoteError, remoteFileUrl, type RemoteLayout } from './remote-bootstrap';
import { parseSshTarget, SshError, type SshTarget } from './ssh-command';
import type { SshModelLogin } from './ssh-context';
import type { SshSpawn } from './ssh-exec';
import { SshTunnel, type TunnelDependencies } from './tunnel';

/** Discovery as the session client consumes it: the port is the LOCAL end
 *  of the tunnel; token and pid belong to the remote daemon. */
export interface TunnelDiscovery {
  port: number;
  token: string;
  pid: number;
}

export interface RemoteDaemonEndpoint {
  discovery: TunnelDiscovery;
  /** file: URL of the uploaded desktop service bundle, on the server. */
  moduleUrl: string;
  /** Server-side working directory for the attachment. */
  cwd: string;
  /** Version of the mixdog package installed on the server. */
  packageVersion: string;
  /** The desktop.init options with every path moved to the server. */
  remapOptions<T extends SerializableDesktopServiceOptions>(options: T): T;
}

/** What SessionTransport needs from a remote daemon. */
export interface RemoteDaemonConnector {
  readonly display: string;
  /** Bootstrap (when needed) and bring the tunnel up. Never starts or
   *  touches a local daemon. */
  connect(log: (line: string) => void): Promise<RemoteDaemonEndpoint>;
  /** Last known discovery; synchronous for the session client's reconnect
   *  checks. Null until connected or after invalidate(). */
  currentDiscovery(): TunnelDiscovery | null;
  /** Forget the cached discovery; the next connect re-reads the server. */
  invalidate(): void;
  /** Stop for good on a failure no retry fixes (e.g. a protocol mismatch):
   *  the tunnel closes and every later connect rejects with `error`. */
  fail(error: Error): void;
  /** Detach: close the tunnel, leave the remote daemon running. */
  close(): Promise<void>;
}

export interface RemoteSessionConfig {
  target: string;
  remoteCwd: string | null;
  graceMs: string;
  appVersion: string;
  /** Local path of the desktop service bundle (daemon.cjs). */
  bundlePath: string;
  tunnelReadyTimeoutMs?: number;
  spawnImpl?: SshSpawn;
  tunnel?: TunnelDependencies;
  /** connect (ssh dialed) → check (node/mixdog probed) → install (bundle
   *  upload) or start (daemon) → start (tunnel coming up) → ready (attached). */
  onProgress?: (progress: ConnectionProgress) => void;
  /** The user confirmed stopping a busy daemon of another version
   *  (`daemon-busy-other-version`): the first bootstrap may restart it. */
  forceRestart?: boolean;
  /** The host's "reconnect automatically" setting; off, a dropped link stays
   *  down until the user reconnects. */
  autoReconnect?: boolean;
  /** Whose provider logins the daemon runs models on; this PC's by default.
   *  The bootstrap attaches only to a daemon in exactly this mode. */
  modelLogin?: SshModelLogin;
}

const DEFAULT_TUNNEL_READY_TIMEOUT_MS = 90_000;
const IDENTITY_CHECK_TIMEOUT_MS = 5_000;

/** Remote mode is on exactly when MIXDOG_SSH_TARGET is set. */
export function remoteSessionConfigFromEnv(
  env: NodeJS.ProcessEnv,
  local: { appVersion: string; bundlePath: string }
): RemoteSessionConfig | null {
  const target = env.MIXDOG_SSH_TARGET;
  if (!target?.trim()) return null;
  return {
    target,
    remoteCwd: env.MIXDOG_SSH_REMOTE_CWD?.trim() || null,
    graceMs: env.MIXDOG_REMOTE_CLIENT_GRACE_MS?.trim() || '',
    appVersion: local.appVersion,
    bundlePath: local.bundlePath,
  };
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

export function remoteSessionOptions<T extends SerializableDesktopServiceOptions>(options: T, layout: RemoteLayout): T {
  return {
    ...options,
    // The server runs the service unpackaged: appPath/../../src is the
    // installed package (linked into the layout), not an Electron bundle.
    packaged: false,
    userDataPath: layout.userDataPath,
    resourcesPath: layout.resourcesPath,
    appPath: layout.appPath,
    rendererDir: layout.rendererDir,
  };
}

/** Who answers /health on the tunnel's local end, and how fast. /health
 *  takes no token, and none is sent: the answer is checked first. */
export interface DaemonHealth {
  pid: number;
  buildHash: string | null;
  rttMs: number;
  /** Sessions running a turn (`busySessions`, at least 1 while not idle). */
  busySessions: number;
}

/** The daemon the bootstrap probe found: what the tunnel must lead to. */
export interface DaemonIdentity {
  pid: number;
  buildHash: string | null;
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
          const health = JSON.parse(body) as {
            status?: unknown;
            pid?: unknown;
            buildHash?: unknown;
            busySessions?: unknown;
            idle?: unknown;
          };
          if (health.status !== 'ok') return resolve(null);
          const busy = Math.max(0, Number(health.busySessions) || 0);
          resolve({
            pid: Number(health.pid) || 0,
            buildHash: typeof health.buildHash === 'string' && health.buildHash ? health.buildHash : null,
            rttMs: Math.max(0, Math.round(performance.now() - startedAt)),
            busySessions: health.idle === false ? Math.max(1, busy) : busy,
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

/** The answering daemon is the probed one: same pid, and the same build when
 *  the probe named one. Anything else may be another user's process that
 *  bound the freed port on a shared server. */
export function isExpectedDaemon(health: DaemonHealth, identity: DaemonIdentity): boolean {
  return health.pid === identity.pid && (identity.buildHash === null || health.buildHash === identity.buildHash);
}

/** The tunnel leads to another process than the probed daemon. */
export function daemonIdentityError(display: string): SshError {
  return new SshError(
    `Another process answered through the ssh tunnel to ${display} instead of the Mixdog daemon it started. ` +
      'The connection was stopped and nothing was sent to it. Reconnect to start over.',
    'terminal'
  );
}

/** One remote target per desktop process: shared by every SessionTransport
 *  generation, so a transport restart reuses the supervised tunnel. */
export class RemoteSession implements RemoteDaemonConnector {
  readonly display: string;
  private readonly target: SshTarget | null;
  private readonly tunnel: SshTunnel | null;
  private failure: Error | null = null;
  private discovery: TunnelDiscovery | null = null;
  private identity: DaemonIdentity | null = null;
  private connecting: Promise<RemoteDaemonEndpoint> | null = null;
  private closed = false;
  private terminals = true;
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
    this.tunnel = target
      ? new SshTunnel(target, {
          spawnImpl: config.spawnImpl,
          ...(config.autoReconnect === false ? { autoRestart: false } : {}),
          ...config.tunnel,
        })
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

  /** False once the server reported it cannot run terminals; true until then. */
  get terminalsAvailable(): boolean {
    return this.terminals;
  }

  /** One /health round trip to the attached daemon through the tunnel, in ms;
   *  null when there is no attachment, it times out, or another process answers. */
  async probeHealth(timeoutMs: number): Promise<number | null> {
    const discovery = this.discovery;
    const identity = this.identity;
    if (!discovery || !identity) return null;
    const health = await readDaemonHealth(discovery.port, timeoutMs);
    // Another answer counts as a failed probe; the next attach re-reads the
    // server and checks the daemon's identity before any token is sent.
    return health && isExpectedDaemon(health, identity) ? health.rttMs : null;
  }

  /** The attached daemon's running sessions, read from its /health through
   *  the tunnel; null when there is no attachment or another process answers. */
  async busySessions(timeoutMs: number): Promise<number | null> {
    const discovery = this.discovery;
    const identity = this.identity;
    if (!discovery || !identity) return null;
    const health = await readDaemonHealth(discovery.port, timeoutMs);
    return health && isExpectedDaemon(health, identity) ? health.busySessions : null;
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

  private async establish(log: (line: string) => void): Promise<RemoteDaemonEndpoint> {
    const target = this.target!;
    const tunnel = this.tunnel!;
    const progress = this.config.onProgress;
    try {
      progress?.({ phase: 'connect' });
      const bundle = await readFile(this.config.bundlePath);
      const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
      const state = await bootstrapRemoteDaemon({
        target,
        args: {
          version: this.config.appVersion,
          graceMs: this.config.graceMs,
          ...(this.config.modelLogin === 'server' ? { modelLogin: 'server' as const } : {}),
        },
        bundle,
        bundleSha256,
        ...(this.forceRestart ? { forceRestart: true } : {}),
        spawnImpl: this.config.spawnImpl,
        log,
        onProgress: progress,
      });
      // The user's confirmation covered this open only: a later reconnect
      // never stops a busy daemon on its own.
      this.forceRestart = false;
      this.terminals = state.terminalsAvailable;
      const cwd = resolveRemoteCwd(this.config.remoteCwd, state.report.home);
      progress?.({ phase: 'start' });
      const localPort = await tunnel.ensure(
        state.discovery.port,
        this.config.tunnelReadyTimeoutMs ?? DEFAULT_TUNNEL_READY_TIMEOUT_MS
      );
      if (this.closed) throw new Error('The remote Mixdog connection is closed.');
      // Before the daemon token goes through the tunnel, the process behind it
      // must be the daemon the probe found: on a shared server another user
      // could have bound the port it freed.
      const identity: DaemonIdentity = {
        pid: state.discovery.pid,
        buildHash: state.report.daemonBuildHash ?? null,
      };
      const health = await readDaemonHealth(localPort, IDENTITY_CHECK_TIMEOUT_MS);
      if (!health) {
        throw new SshError(`The Mixdog daemon on ${this.display} does not answer through the ssh tunnel.`, 'transient');
      }
      if (!isExpectedDaemon(health, identity)) throw daemonIdentityError(this.display);
      this.identity = identity;
      progress?.({ phase: 'ready' });
      const discovery = { port: localPort, token: state.discovery.token, pid: state.discovery.pid };
      this.discovery = discovery;
      const layout = state.layout;
      return {
        discovery,
        moduleUrl: remoteFileUrl(layout.bundlePath, `${this.config.appVersion}:${bundleSha256.slice(0, 16)}`),
        cwd,
        packageVersion: state.report.packageVersion,
        remapOptions: (options) => remoteSessionOptions(options, layout),
      };
    } catch (error) {
      // A changed host key, a refused login, a missing or too old node or
      // mixdog, or a daemon outside proxy mode will not fix itself: stop
      // dialing until the app restarts, and keep the original words.
      if (isTerminalRemoteError(error) || tunnel.failure) this.fail(tunnel.failure ?? (error as Error));
      throw error;
    }
  }
}
