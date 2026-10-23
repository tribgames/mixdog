// Bootstrap of a server connection: probe the platform and the installed
// state, install this desktop's exact runtime into an immutable version
// directory when it is missing, and make sure that build's daemon serves the
// session port (replacing an idle daemon of another build). The server side
// lives in the remote-install-* program sections.
import { posix } from 'node:path';

import type { ConnectionProgress } from '../connections/contract';
import { RemoteBootstrapError, TERMINAL_BOOTSTRAP_CODES } from './remote-install-errors';
import { REMOTE_INSTALL_LOCK_STALE_MS, REMOTE_INSTALL_LOCK_WAIT_MS } from './remote-install-lock';
import { resolveServerPayload, type RemoteServerPayload } from './remote-install-payload';
import {
  classifyRemotePlatform,
  isWindowsShellFailure,
  parsePlatformLine,
  windowsServerError,
} from './remote-install-platform';
import {
  REMOTE_STATE_DIRECTORY,
  remoteProgramScript,
  remoteShellCommand,
  type RemoteProgramArgs,
} from './remote-install-program';
import { REMOTE_PTY_PACKAGE } from './remote-install-versioned';
import { isTerminalSshError, type SshTarget } from './ssh-command';
import { currentSshContext, type SshModelLogin } from './ssh-context';
import { sshExec, type SshSpawn } from './ssh-exec';

export { RemoteBootstrapError } from './remote-install-errors';
export { REMOTE_MIN_NODE_MAJOR, REMOTE_STATE_DIRECTORY, remoteShellCommand, shQuote } from './remote-install-program';

/** ssh run budgets of one bootstrap: the probe, then the ensure run that
 *  waits for the install lock and replaces/starts the daemon — longer when it
 *  also installs (upload, manifest check, npm modules: npm alone may take
 *  300 s inside it). */
export const REMOTE_PROBE_TIMEOUT_MS = 60_000;
export const REMOTE_ENSURE_TIMEOUT_MS = 360_000;
export const REMOTE_INSTALL_TIMEOUT_MS = 600_000;
/** A remote client's default lease is 30 s and the daemon sweeps every 5 s:
 *  a desktop that quit is gone from /health within this window. */
export const REMOTE_CLIENT_LEASE_WAIT_MS = 35_000;
export const REMOTE_CLIENT_LEASE_POLL_MS = 3_000;
const CLIENT_LEASE_WAIT_DETAIL = '이전 연결이 끝나기를 기다리는 중';

/** Modules the desktop service bundle loads at runtime that
 *  `scripts/build-daemon.mjs` leaves external. The generated server lockfile
 *  pins them to apps/desktop/package-lock.json. */
export const REMOTE_DESKTOP_DEPENDENCIES: Readonly<Record<string, string>> = {
  [REMOTE_PTY_PACKAGE]: '0.13.1',
};

export interface RemoteDiscovery {
  port: number;
  token: string;
  pid: number;
}

/** Server-side paths the desktop service runs against. */
export interface RemoteLayout {
  root: string;
  base: string;
  appPath: string;
  bundlePath: string;
  rendererDir: string;
  resourcesPath: string;
  userDataPath: string;
}

export interface RemoteReport {
  home: string;
  uid: number;
  nodeVersion: string;
  runtimeRoot: string;
  /** The version directory this desktop's build installs into. */
  versionDir: string;
  /** Its `.install-complete` marker names this build and its modules exist. */
  installed: boolean;
  /** node-pty loads and runs on the server (null: not installed yet). */
  terminalsAvailable: boolean | null;
  terminalsError: string | null;
  /** Runtime version the attached daemon runs (or the installed one). */
  packageVersion: string;
  discovery: RemoteDiscovery | null;
  healthy: boolean;
  /** `modelProxy` from the daemon's /health: 'client' when its model calls
   *  run on the attached desktop, null otherwise. */
  modelProxy: string | null;
  daemonVersion: string | null;
  daemonBuildHash: string | null;
  /** Running turns of the daemon (0 when idle or not healthy). */
  daemonBusy: number;
  /** The healthy daemon runs exactly this build in the model login mode asked for. */
  daemonCurrent: boolean;
  /** This bootstrap run started the daemon (ensure mode only). */
  started: boolean;
  /** The daemon of another build this run stopped. */
  replaced: { pid: number; version: string; buildHash: string | null; graceful: boolean } | null;
  /** Version/deps directories the run garbage-collected. */
  gcRemoved: string[];
}

/** Terminal ssh failures (host key, auth) and terminal setup failures. */
export function isTerminalRemoteError(error: unknown): boolean {
  return (
    isTerminalSshError(error) || (error instanceof RemoteBootstrapError && TERMINAL_BOOTSTRAP_CODES.has(error.code))
  );
}

/** The desktop attaches only to a daemon whose model login matches the saved
 *  server's choice. With this PC's logins (the default) that is a daemon that
 *  sends its model calls back to this PC; any other would run models with the
 *  server's credentials. With the server's own logins it is a daemon without
 *  the model proxy; one in proxy mode would run them on this PC's. */
export function assertModelLoginMode(report: RemoteReport, modelLogin: SshModelLogin = 'pc'): void {
  if (!report.healthy || !report.discovery) return;
  const pid = report.discovery.pid;
  const version = report.packageVersion || 'unknown';
  if (modelLogin === 'server') {
    if (report.modelProxy === null) return;
    throw new RemoteBootstrapError(
      'daemon-model-login',
      `The Mixdog daemon on the server (pid ${pid}, mixdog ${version}) sends its model calls to this PC, ` +
        "but this server is set to use the server's own logins. " +
        `Stop it on the server (kill ${pid}), then reconnect.`
    );
  }
  if (report.modelProxy === 'client') return;
  throw new RemoteBootstrapError(
    'daemon-not-proxy',
    `The Mixdog daemon on the server (pid ${pid}, mixdog ${version}) ` +
      "is not in desktop model proxy mode; attaching would run models with the server's credentials. " +
      `Stop it on the server (kill ${pid}), then reconnect.`
  );
}

/** `installId` names the version directory: `<version>-<buildHash>`. */
export function remoteLayout(home: string, installId: string): RemoteLayout {
  if (!posix.isAbsolute(home)) throw new RemoteBootstrapError('remote-home', `Remote home is not absolute: ${home}`);
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/.test(installId)) {
    throw new RemoteBootstrapError('version', `Server install id is not a safe path segment: ${installId}`);
  }
  const root = posix.join(home, REMOTE_STATE_DIRECTORY);
  const base = posix.join(root, 'versions', installId);
  // `appPath/../../src` is where an unpackaged desktop service resolves the
  // runtime: the version directory's own src/.
  const appPath = posix.join(base, 'apps', 'desktop');
  return {
    root,
    base,
    appPath,
    bundlePath: posix.join(appPath, 'out', 'main', 'daemon.cjs'),
    rendererDir: posix.join(appPath, 'out', 'renderer'),
    resourcesPath: posix.join(base, 'resources'),
    // Version independent: pairing and settings survive desktop updates.
    userDataPath: posix.join(root, 'user-data'),
  };
}

/** file: URL of a server-side path, independent of the local platform. */
export function remoteFileUrl(path: string, build?: string): string {
  const url = new URL('file:///');
  url.pathname = path;
  if (build) url.searchParams.set('build', build);
  return url.href;
}

/** daemon.json as the daemon writes it: `{pid, endpoints: {session: {port, token}}}`. */
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
  const record = parsed as { pid?: unknown; endpoints?: { session?: { port?: unknown; token?: unknown } } };
  const pid = Number(record.pid);
  const port = Number(record.endpoints?.session?.port);
  const token = record.endpoints?.session?.token;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== 'string' || !token) return null;
  return { port, token, pid };
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** The platform line first (an unsupported server is named as such even when
 *  a later step failed), then the last MIXDOG_RESULT / MIXDOG_ERROR line. */
export function parseRemoteResult(stdout: string): Record<string, unknown> {
  const platform = parsePlatformLine(stdout);
  if (platform) classifyRemotePlatform(platform.uname, platform.libc);
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const error = /^MIXDOG_ERROR (\S+) (.*)$/.exec(line);
    if (error) throw new RemoteBootstrapError(error[1], error[2]);
    if (!line.startsWith('MIXDOG_RESULT ')) continue;
    try {
      const value: unknown = JSON.parse(line.slice('MIXDOG_RESULT '.length));
      if (value && typeof value === 'object') return value as Record<string, unknown>;
    } catch {
      // A torn result line is no result.
    }
    break;
  }
  throw new RemoteBootstrapError('protocol', 'The server returned no bootstrap result.');
}

export function parseRemoteReport(stdout: string): RemoteReport {
  return reportFromResult(parseRemoteResult(stdout));
}

function reportFromResult(value: Record<string, unknown>): RemoteReport {
  const discovery = value.daemonJson == null ? null : parseRemoteDiscovery(value.daemonJson);
  const healthy = value.healthy === true && discovery !== null;
  const replaced =
    value.replaced && typeof value.replaced === 'object' ? (value.replaced as Record<string, unknown>) : null;
  return {
    home: String(value.home || ''),
    uid: Number(value.uid) || 0,
    nodeVersion: String(value.nodeVersion || ''),
    runtimeRoot: String(value.runtimeRoot || ''),
    versionDir: String(value.versionDir || ''),
    installed: value.installed === true,
    terminalsAvailable: typeof value.terminalsAvailable === 'boolean' ? value.terminalsAvailable : null,
    terminalsError: text(value.terminalsError),
    packageVersion: (healthy ? text(value.daemonVersion) : null) ?? text(value.installedVersion) ?? '',
    discovery,
    healthy,
    modelProxy: text(value.modelProxy),
    daemonVersion: text(value.daemonVersion),
    daemonBuildHash: text(value.daemonBuildHash),
    daemonBusy: Number(value.daemonBusy) || 0,
    daemonCurrent: healthy && value.daemonCurrent === true,
    started: value.started === true,
    replaced: replaced
      ? {
          pid: Number(replaced.pid) || 0,
          version: String(replaced.version || ''),
          buildHash: text(replaced.buildHash),
          graceful: replaced.graceful === true,
        }
      : null,
    gcRemoved: Array.isArray(value.gcRemoved) ? value.gcRemoved.map(String) : [],
  };
}

export interface RemoteScriptArgs {
  /** Desktop app version (diagnostics; the runtime version names the install). */
  version: string;
  /** Developer override (the desktop's own MIXDOG_REMOTE_CLIENT_GRACE_MS);
   *  empty: the saved server's grace setting. */
  graceMs: string;
  /** Whose provider logins the daemon runs models on; this PC's by default. */
  modelLogin?: SshModelLogin;
}

/** How long a daemon outlives its last desktop (per saved server). */
export const REMOTE_GRACE_DEFAULT_MINUTES = 30;
export const REMOTE_GRACE_MIN_MINUTES = 1;
export const REMOTE_GRACE_MAX_MINUTES = 7 * 24 * 60;

/** The saved `graceMinutes` in ms: the default when absent or invalid,
 *  clamped to 1 minute .. 7 days. */
export function sshHostGraceMs(graceMinutes: unknown): number {
  const minutes =
    typeof graceMinutes === 'number' && Number.isFinite(graceMinutes) && graceMinutes > 0
      ? graceMinutes
      : REMOTE_GRACE_DEFAULT_MINUTES;
  return Math.round(Math.min(REMOTE_GRACE_MAX_MINUTES, Math.max(REMOTE_GRACE_MIN_MINUTES, minutes)) * 60_000);
}

/** The grace of the connect attempt this runs under. The daemon reads it
 *  once, at spawn: a changed setting applies from the next daemon start
 *  (a running daemon of the same build is reused with its old grace). */
function daemonGraceMs(override: string): string {
  if (override.trim()) return override.trim();
  const settings = currentSshContext()?.settings as { graceMinutes?: unknown } | undefined;
  return String(sshHostGraceMs(settings?.graceMinutes));
}

export interface RemoteDaemonState {
  report: RemoteReport;
  layout: RemoteLayout;
  discovery: RemoteDiscovery;
  /** node-pty runs on the server; false keeps the connection with terminals off. */
  terminalsAvailable: boolean;
}

export interface BootstrapOptions {
  target: SshTarget;
  args: RemoteScriptArgs;
  /** The desktop service bundle, installed inside the version directory. */
  bundle: Buffer;
  /** The bundle's digest as the caller computed it (the payload manifest
   *  hashes the bundle again for the build hash). */
  bundleSha256: string;
  /** Stop a daemon of another build even while it runs turns (after the
   *  user confirmed a `daemon-busy-other-version` failure). */
  forceRestart?: boolean;
  /** The payload to install; this desktop's runtime by default. */
  payload?: RemoteServerPayload;
  spawnImpl?: SshSpawn;
  log?: (line: string) => void;
  onProgress?: (progress: ConnectionProgress) => void;
  /** Test seams: how long and how often to wait for an old client's lease. */
  clientLeaseWaitMs?: number;
  clientLeasePollMs?: number;
}

/** Run one server program over ssh: its raw MIXDOG_RESULT object. */
export async function runRemoteProgram(
  options: { target: SshTarget; spawnImpl?: SshSpawn },
  args: RemoteProgramArgs,
  timeoutMs: number,
  input?: Buffer
): Promise<Record<string, unknown>> {
  const result = await sshExec({
    target: options.target,
    command: remoteShellCommand(remoteProgramScript(args)),
    input,
    timeoutMs,
    spawnImpl: options.spawnImpl,
  });
  if (result.exitCode !== 0 && !/^MIXDOG_(?:RESULT|ERROR|PLATFORM) /m.test(result.stdout)) {
    if (isWindowsShellFailure(result.stderr)) throw windowsServerError();
    const detail = result.stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    throw new RemoteBootstrapError(
      'remote-shell',
      `Remote bootstrap exited with status ${result.exitCode}.${detail ? `\n${detail}` : ''}`
    );
  }
  return parseRemoteResult(result.stdout);
}

async function runBootstrapStep(
  options: BootstrapOptions,
  args: RemoteProgramArgs,
  timeoutMs: number,
  input?: Buffer
): Promise<RemoteReport> {
  return reportFromResult(await runRemoteProgram(options, args, timeoutMs, input));
}

/** Probe the server, install this desktop's runtime when its version
 *  directory is missing, and make sure that build's daemon answers. The
 *  returned discovery (and its token) only lives in memory. */
export async function bootstrapRemoteDaemon(options: BootstrapOptions): Promise<RemoteDaemonState> {
  const log = options.log ?? (() => {});
  const modelLogin: SshModelLogin = options.args.modelLogin === 'server' ? 'server' : 'pc';
  const payload = options.payload ?? (await resolveServerPayload(options.bundle));
  const base: RemoteProgramArgs = {
    mode: 'probe',
    installId: payload.installId,
    version: payload.version,
    buildHash: payload.buildHash,
    graceMs: daemonGraceMs(options.args.graceMs),
    lockWaitMs: REMOTE_INSTALL_LOCK_WAIT_MS,
    lockStaleMs: REMOTE_INSTALL_LOCK_STALE_MS,
    // Only the opt-in travels: a server on this PC's logins gets exactly the
    // arguments it always did.
    ...(modelLogin === 'server' ? { modelLogin: 'server' as const } : {}),
  };
  const probe = await runBootstrapStep(options, base, REMOTE_PROBE_TIMEOUT_MS);
  const layout = remoteLayout(probe.home, payload.installId);
  log(
    `remote probe node=${probe.nodeVersion} install=${payload.installId} installed=${probe.installed}` +
      ` healthy=${probe.healthy} daemon=${probe.daemonVersion ?? 'none'}/${probe.daemonBuildHash ?? '-'}` +
      ` modelProxy=${probe.modelProxy ?? 'none'} modelLogin=${modelLogin} busy=${probe.daemonBusy}`
  );
  options.onProgress?.({ phase: 'check', detail: probe.nodeVersion });
  const ready = (report: RemoteReport, discovery: RemoteDiscovery): RemoteDaemonState => {
    if (report.terminalsAvailable === false && report.terminalsError)
      log(`remote terminals unavailable: ${report.terminalsError}`);
    return { report, layout, discovery, terminalsAvailable: report.terminalsAvailable === true };
  };
  // A daemon in the other model login mode is never attached to: ensure
  // replaces it (busy and attached daemons as for another build).
  const modeMatches = probe.modelProxy === (modelLogin === 'server' ? null : 'client');
  if (probe.installed && probe.daemonCurrent && modeMatches && probe.discovery) return ready(probe, probe.discovery);

  // While waiting for an old client's lease the re-checks keep the waiting
  // detail on screen instead of flipping back to a bare phase.
  let waitStarted = 0;
  const ensure = async (upload: boolean): Promise<RemoteReport> => {
    if (!waitStarted) options.onProgress?.({ phase: upload ? 'install' : 'start' });
    const archive = upload ? await payload.archive() : undefined;
    if (archive)
      log(`uploading server payload ${payload.installId} files=${payload.files.length} bytes=${archive.length}`);
    return runBootstrapStep(
      options,
      { ...base, mode: 'ensure', upload, forceRestart: options.forceRestart === true },
      upload ? REMOTE_INSTALL_TIMEOUT_MS : REMOTE_ENSURE_TIMEOUT_MS,
      archive
    );
  };
  const attempt = async (upload: boolean): Promise<RemoteReport> => {
    try {
      return await ensure(upload);
    } catch (error) {
      // GC by another desktop can remove the build between probe and ensure.
      if (!(error instanceof RemoteBootstrapError && error.code === 'install-missing')) throw error;
      return ensure(true);
    }
  };
  let ensured: RemoteReport;
  let upload = !probe.installed;
  let waitPhase: ConnectionProgress['phase'] | null = null;
  for (;;) {
    try {
      ensured = await attempt(upload);
      break;
    } catch (error) {
      // Another build's daemon runs no turns but still lists clients: a
      // desktop that just quit (an update) holds a lease until it expires.
      // Wait out one lease window, then refuse like a busy daemon.
      if (!(error instanceof RemoteBootstrapError && error.code === 'daemon-clients-attached')) throw error;
      const now = Date.now();
      if (!waitStarted) waitStarted = now;
      if (now - waitStarted >= (options.clientLeaseWaitMs ?? REMOTE_CLIENT_LEASE_WAIT_MS)) {
        throw new RemoteBootstrapError('daemon-busy-other-version', error.message);
      }
      const phase = upload ? 'install' : 'start';
      if (phase !== waitPhase) {
        waitPhase = phase;
        options.onProgress?.({ phase, detail: CLIENT_LEASE_WAIT_DETAIL });
        log(`waiting for the previous connection to the remote daemon to end (${error.message})`);
      }
      // The ensure run installed the build before it looked at the daemon.
      upload = false;
      await new Promise((resolve) => setTimeout(resolve, options.clientLeasePollMs ?? REMOTE_CLIENT_LEASE_POLL_MS));
    }
  }
  if (ensured.replaced) {
    log(
      `replaced remote daemon pid=${ensured.replaced.pid} mixdog=${ensured.replaced.version || 'unknown'}` +
        ` build=${ensured.replaced.buildHash ?? '-'} graceful=${ensured.replaced.graceful}`
    );
  }
  if (ensured.gcRemoved.length) log(`remote gc removed ${ensured.gcRemoved.join(', ')}`);
  assertModelLoginMode(ensured, modelLogin);
  if (!ensured.healthy || !ensured.discovery || !ensured.daemonCurrent) {
    throw new RemoteBootstrapError('daemon-unhealthy', 'The Mixdog daemon on the server is not answering.');
  }
  return ready(ensured, ensured.discovery);
}
