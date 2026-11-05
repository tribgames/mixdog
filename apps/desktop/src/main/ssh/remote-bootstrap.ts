// Bootstrap of a server connection (LR §8.1): probe the platform and the
// installed state, upload this desktop's `mixdogd` when its version directory
// is missing, and let `mixdogd server-ensure` on the server decide — with the
// one `compat::order` — whether the running core is attached to, replaced
// (this desktop is newer) or refused (this desktop is older). Nothing here
// compares versions; the server's answer is the decision.
import type { ConnectionProgress } from '../connections/contract';
import {
  isLocalFilesystemError,
  type RemoteDrain,
  RemoteBootstrapError,
  TERMINAL_BOOTSTRAP_CODES,
} from './remote-install-errors';
import { resolveServerPayloads, type ServerPayloads } from './remote-install-payload';
import {
  classifyRemotePlatform,
  isWindowsShellFailure,
  parsePlatformLine,
  type RemotePlatform,
  windowsServerError,
} from './remote-install-platform';
import {
  REMOTE_INSTALL_LOCK_STALE_MS,
  REMOTE_INSTALL_LOCK_WAIT_MS,
  remoteProgramScript,
  remoteShellCommand,
  type RemoteProgramArgs,
} from './remote-install-program';
import { isTerminalSshError, type SshTarget } from './ssh-command';
import type { SshModelLogin } from './ssh-context';
import { sshExec, type SshSpawn } from './ssh-exec';

export { RemoteBootstrapError } from './remote-install-errors';
export { REMOTE_STATE_DIRECTORY, remoteShellCommand, shQuote } from './remote-install-program';

/** ssh run budgets of one bootstrap: the probe, then the ensure run that waits
 *  for the install lock and replaces/starts the core — longer when it also
 *  uploads the runtime. */
export const REMOTE_PROBE_TIMEOUT_MS = 60_000;
export const REMOTE_ENSURE_TIMEOUT_MS = 360_000;
export const REMOTE_INSTALL_TIMEOUT_MS = 600_000;

/** The discovery file of the server's core (LR §4), as the desktop uses it. */
export interface RemoteDiscovery {
  /** The WebSocket listener; null while the core does not serve (no `rpc`). */
  rpcPort: number | null;
  /** The control listener (`/mgmt/*`, `/health`). */
  controlPort: number;
  /** The one token that opens both listeners. */
  token: string;
  pid: number;
  instanceId: string;
  /** The OS start time of `pid`: with the pid it names this process, not a later one that reused the pid. */
  processStartTime: string;
  state: string;
  version: string;
  build: string;
}

export interface RemoteReport {
  home: string;
  uid: number;
  runtimeRoot: string;
  /** The version directory this desktop's build installs into. */
  versionDir: string;
  /** This build's `mixdogd` exists on the server. */
  installed: boolean;
  discovery: RemoteDiscovery | null;
  /** A core is serving (discovery names an RPC listener). */
  healthy: boolean;
  /** The serving core is this desktop's version and build, in the model login mode asked for. */
  coreCurrent: boolean;
  /** This bootstrap run started the core (ensure mode only). */
  started: boolean;
  /** The core of an older version this run replaced. */
  replaced: { pid: number; version: string; graceful: boolean } | null;
  /** Version directories the run garbage-collected. */
  gcRemoved: string[];
}

/** Terminal ssh failures (host key, auth), terminal setup failures and local file errors. */
export function isTerminalRemoteError(error: unknown): boolean {
  return (
    isTerminalSshError(error) ||
    isLocalFilesystemError(error) ||
    (error instanceof RemoteBootstrapError && TERMINAL_BOOTSTRAP_CODES.has(error.code))
  );
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const port = (value: unknown): number | null =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535 ? (value as number) : null;

/** daemon.json as the core writes it (LR §4): `pid`, `endpoints.session.token`
 *  and the `core` block with the control port and, while serving, the RPC port. */
export function parseRemoteDiscovery(raw: unknown): RemoteDiscovery | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as {
    pid?: unknown;
    endpoints?: { session?: { token?: unknown } };
    core?: {
      version?: unknown;
      build?: unknown;
      instanceId?: unknown;
      processStartTime?: unknown;
      state?: unknown;
      rpc?: { port?: unknown };
      control?: { port?: unknown };
    };
  };
  const pid = record.pid;
  const token = record.endpoints?.session?.token;
  const core = record.core;
  const controlPort = port(core?.control?.port);
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof token !== 'string' || !token || !core || controlPort === null) return null;
  return {
    rpcPort: port(core.rpc?.port),
    controlPort,
    token,
    pid,
    instanceId: text(core.instanceId) ?? '',
    processStartTime: text(core.processStartTime) ?? '',
    state: text(core.state) ?? '',
    version: text(core.version) ?? '',
    build: text(core.build) ?? '',
  };
}

interface ParsedOutput {
  value: Record<string, unknown>;
  platform: RemotePlatform | null;
}

function parseDrainLine(lines: readonly string[]): RemoteDrain | null {
  const line = lines.filter((candidate) => candidate.startsWith('MIXDOG_DRAIN ')).at(-1);
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice('MIXDOG_DRAIN '.length)) as Partial<RemoteDrain>;
    if (typeof value.drainId !== 'string' || typeof value.confirmToken !== 'string') return null;
    const running = Array.isArray(value.running) ? value.running : [];
    return {
      drainId: value.drainId,
      confirmToken: value.confirmToken,
      running: running.map((work) => ({
        kind: String(work?.kind ?? ''),
        threadId: text(work?.threadId),
        turnId: text(work?.turnId),
        title: String(work?.title ?? ''),
      })),
    };
  } catch {
    return null;
  }
}

/** The platform line first (an unsupported server is named as such even when
 *  a later step failed), then the last MIXDOG_RESULT / MIXDOG_ERROR line. */
function parseRemoteOutput(stdout: string): ParsedOutput {
  const found = parsePlatformLine(stdout);
  const platform = found ? classifyRemotePlatform(found.uname, found.libc) : null;
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const error = /^MIXDOG_ERROR (\S+) (.*)$/.exec(line);
    if (error) throw new RemoteBootstrapError(error[1], error[2], parseDrainLine(lines));
    if (!line.startsWith('MIXDOG_RESULT ')) continue;
    try {
      const value: unknown = JSON.parse(line.slice('MIXDOG_RESULT '.length));
      if (value && typeof value === 'object') return { value: value as Record<string, unknown>, platform };
    } catch {
      // A torn result line is no result.
    }
    break;
  }
  throw new RemoteBootstrapError('protocol', 'The server returned no bootstrap result.');
}

export function parseRemoteReport(stdout: string): RemoteReport {
  return reportFromResult(parseRemoteOutput(stdout).value);
}

function reportFromResult(value: Record<string, unknown>): RemoteReport {
  const discovery = value.daemonJson == null ? null : parseRemoteDiscovery(value.daemonJson);
  const healthy = value.healthy === true && discovery !== null && discovery.rpcPort !== null;
  const replaced =
    value.replaced && typeof value.replaced === 'object' ? (value.replaced as Record<string, unknown>) : null;
  return {
    home: String(value.home || ''),
    uid: Number(value.uid) || 0,
    runtimeRoot: String(value.runtimeRoot || ''),
    versionDir: String(value.versionDir || ''),
    installed: value.installed === true,
    discovery,
    healthy,
    coreCurrent: healthy && value.coreCurrent === true,
    started: value.started === true,
    replaced: replaced
      ? {
          pid: Number(replaced.pid) || 0,
          version: String(replaced.version || ''),
          graceful: replaced.graceful === true,
        }
      : null,
    gcRemoved: Array.isArray(value.gcRemoved) ? value.gcRemoved.map(String) : [],
  };
}

export interface RemoteDaemonState {
  report: RemoteReport;
  /** The core's discovery with a serving RPC listener. */
  discovery: RemoteDiscovery & { rpcPort: number };
}

export interface BootstrapOptions {
  target: SshTarget;
  /** Whose provider logins the core runs models on; this PC's by default. */
  modelLogin?: SshModelLogin;
  /** The user confirmed stopping the older core's running work after a
   *  `daemon-busy-other-version` failure: this open aborts exactly the work
   *  that failure listed. */
  forceRestart?: boolean;
  /** The release to install; this desktop's staged runtimes by default. */
  payloads?: ServerPayloads;
  spawnImpl?: SshSpawn;
  log?: (line: string) => void;
  onProgress?: (progress: ConnectionProgress) => void;
}

/** What each server's last busy refusal listed. A user's confirmation reaches
 *  the server as that listing's token, so it only ever aborts work the user
 *  was shown; a changed set is refused again with the new listing. */
const pendingDrains = new Map<string, RemoteDrain>();

/** Run one server program over ssh: its raw MIXDOG_RESULT object and the
 *  server's platform. */
export async function runRemoteProgram(
  options: { target: SshTarget; spawnImpl?: SshSpawn },
  args: RemoteProgramArgs,
  timeoutMs: number,
  input?: Buffer
): Promise<{ result: Record<string, unknown>; platform: RemotePlatform }> {
  const run = await sshExec({
    target: options.target,
    command: remoteShellCommand(remoteProgramScript(args)),
    input,
    timeoutMs,
    spawnImpl: options.spawnImpl,
  });
  if (run.exitCode !== 0 && !/^MIXDOG_(?:RESULT|ERROR|PLATFORM) /m.test(run.stdout)) {
    if (isWindowsShellFailure(run.stderr)) throw windowsServerError();
    const detail = run.stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    throw new RemoteBootstrapError(
      'remote-shell',
      `Remote bootstrap exited with status ${run.exitCode}.${detail ? `\n${detail}` : ''}`
    );
  }
  const { value, platform } = parseRemoteOutput(run.stdout);
  if (!platform) throw new RemoteBootstrapError('protocol', 'The server did not report its platform.');
  return { result: value, platform };
}

/** `args` run on the server: with the runtime uploaded when this build is not
 *  installed, and once more with it when another desktop's cleanup removed the
 *  build between the probe and now. */
export async function runWithInstall(
  options: { target: SshTarget; spawnImpl?: SshSpawn; log?: (line: string) => void },
  payloads: ServerPayloads,
  platform: RemotePlatform,
  args: RemoteProgramArgs,
  installed: boolean,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const attempt = async (upload: boolean): Promise<Record<string, unknown>> => {
    if (!upload) return (await runRemoteProgram(options, args, timeoutMs)).result;
    const binary = await payloads.binary(platform);
    const archive = await binary.archive();
    options.log?.(
      `uploading server runtime ${args.installId} platform=${platform.os}-${platform.arch} bytes=${archive.length}`
    );
    return (
      await runRemoteProgram(
        options,
        { ...args, upload: true, sha256: binary.sha256, bundleSha256: binary.bundleSha256 },
        Math.max(timeoutMs, REMOTE_INSTALL_TIMEOUT_MS),
        archive
      )
    ).result;
  };
  if (!installed) return attempt(true);
  try {
    return await attempt(false);
  } catch (error) {
    if (!(error instanceof RemoteBootstrapError && error.code === 'install-missing')) throw error;
    return attempt(true);
  }
}

/** Probe the server, upload this desktop's runtime when its version
 *  directory is missing, and make sure the core there serves this desktop's
 *  version. The returned discovery (and its token) only lives in memory. */
export async function bootstrapRemoteDaemon(options: BootstrapOptions): Promise<RemoteDaemonState> {
  const log = options.log ?? (() => {});
  const payloads = options.payloads ?? (await resolveServerPayloads());
  const { installId, version, build } = payloads.identity;
  const key = options.target.display;
  const base: RemoteProgramArgs = {
    mode: 'probe',
    installId,
    version,
    build,
    lockWaitMs: REMOTE_INSTALL_LOCK_WAIT_MS,
    lockStaleMs: REMOTE_INSTALL_LOCK_STALE_MS,
    // Only the opt-in travels: a server on this PC's logins gets exactly the
    // arguments it always did.
    ...(options.modelLogin === 'server' ? { modelLogin: 'server' as const } : {}),
  };
  const probeRun = await runRemoteProgram(options, base, REMOTE_PROBE_TIMEOUT_MS);
  const probe = reportFromResult(probeRun.result);
  const platform = probeRun.platform;
  log(
    `remote probe platform=${platform.os}-${platform.arch} install=${installId} installed=${probe.installed}` +
      ` core=${probe.discovery ? `${probe.discovery.version}/${probe.discovery.build}` : 'none'}` +
      ` current=${probe.coreCurrent}`
  );
  options.onProgress?.({ phase: 'check', detail: `${platform.os}-${platform.arch}` });
  const ready = (report: RemoteReport): RemoteDaemonState => {
    const discovery = report.discovery;
    if (!report.healthy || !discovery || discovery.rpcPort === null || !report.coreCurrent) {
      throw new RemoteBootstrapError('daemon-unhealthy', 'The Mixdog core on the server is not serving.');
    }
    return { report, discovery: { ...discovery, rpcPort: discovery.rpcPort } };
  };
  if (probe.installed && probe.coreCurrent) return ready(probe);

  const confirmToken = options.forceRestart ? pendingDrains.get(key)?.confirmToken : undefined;
  pendingDrains.delete(key);
  options.onProgress?.({ phase: probe.installed ? 'start' : 'install' });
  const ensureArgs: RemoteProgramArgs = { ...base, mode: 'ensure', ...(confirmToken ? { confirmToken } : {}) };
  let ensured: Record<string, unknown>;
  try {
    ensured = await runWithInstall(
      { target: options.target, spawnImpl: options.spawnImpl, log },
      payloads,
      platform,
      ensureArgs,
      probe.installed,
      REMOTE_ENSURE_TIMEOUT_MS
    );
  } catch (error) {
    if (error instanceof RemoteBootstrapError && error.drain) pendingDrains.set(key, error.drain);
    throw error;
  }
  const report = reportFromResult(ensured);
  if (report.replaced) {
    log(`replaced remote core pid=${report.replaced.pid} mixdog=${report.replaced.version || 'unknown'} graceful=${report.replaced.graceful}`);
  }
  if (report.gcRemoved.length) log(`remote gc removed ${report.gcRemoved.join(', ')}`);
  return ready(report);
}
