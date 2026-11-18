// Attach-or-start of this PC's core (lifecycle spec §5.4): the one place the desktop launches `mixdogd serve`, then waits
// until the discovery file says `serving`. The endpoint itself is read by `readLocalDiscovery` on every dial.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { linkSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ensureCore, launchCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
import type { BootFailure, LaunchAttempt } from '../core-port/boot-progress';
import { readLocalDiscovery } from './discovery';
import type { WsEndpoint } from './ws-connector';

/** The core binary: the packaged one beside the app's resources, `MIXDOGD_BIN` in development. */
export function coreBinaryPath(packaged: boolean, resourcesPath: string, platform: NodeJS.Platform = process.platform): string {
  if (!packaged) return process.env.MIXDOGD_BIN || 'mixdogd';
  return join(resourcesPath, 'core', platform === 'win32' ? 'mixdogd.exe' : 'mixdogd');
}

/** What `coreLaunchPath` asks of the file system. */
export interface CoreLinkFs {
  identity(path: string): string | null;
  link(existing: string, path: string): void;
  remove(path: string): void;
}

const coreLinkFs: CoreLinkFs = {
  identity(path) {
    try {
      const stat = statSync(path, { bigint: true });
      return stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
    } catch {
      return null;
    }
  },
  link: (existing, path) => linkSync(existing, path),
  remove: (path) => {
    // Earlier names moved aside below, once their core has ended.
    const dir = dirname(path);
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${basename(path)}.replaced-`)) {
        try {
          rmSync(join(dir, name), { force: true });
        } catch {
          // Still running: a later launch removes it.
        }
      }
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // A core still running under the name (the one a deploy replaced) cannot be removed, but the name can be moved:
      // left in place, the new core started as `mixdogd.exe`, out of the app's group in Task Manager.
      renameSync(path, `${path}.replaced-${Date.now()}`);
    }
  },
};

/** The binary the packaged app starts its core from. On Windows that is `core/Mixdog.exe`, a hard link to
 *  `core/mixdogd.exe` the app makes (and makes again when the core was replaced): Task Manager lists a child under
 *  its app only when the child's image carries the app's name, so a core started as `mixdogd.exe` shows inside the
 *  Mixdog group for a moment and then on a row of its own. A link costs no space and needs no packaging; where it
 *  cannot be made (a read-only install, another volume) the core starts as `mixdogd.exe`. The command-line
 *  `mixdogd.exe` stays what scripts and `ctl` run. */
export function coreLaunchPath(
  packaged: boolean,
  resourcesPath: string,
  platform: NodeJS.Platform = process.platform,
  fs: CoreLinkFs = coreLinkFs
): string {
  const bin = coreBinaryPath(packaged, resourcesPath, platform);
  if (!packaged || platform !== 'win32') return bin;
  const named = join(resourcesPath, 'core', 'Mixdog.exe');
  try {
    const core = fs.identity(bin);
    if (!core) return bin;
    if (fs.identity(named) === core) return named;
    // A core that was replaced leaves the name on the old file.
    fs.remove(named);
    fs.link(bin, named);
    return fs.identity(named) === core ? named : bin;
  } catch {
    return bin;
  }
}

// Switches to `desktopMixdogRoot` of scripts/core-layout.mjs when k1-packaging combines.
/** The core's resource root in a packaged app: the unpacked `src/` of the mixdog package (the same rule as
 *  `desktopMixdogRoot` in scripts/core-layout.mjs, which stages it). */
export function packagedMixdogRoot(resourcesPath: string): string {
  return join(resourcesPath, 'runtime.asar.unpacked', 'node_modules', 'mixdog', 'src');
}

/** What the started core inherits: a packaged app tells it where its resources are and which Electron profile is
 *  its own. The core never guesses a profile (`migration_roots` in the daemon's boot.rs): `MIXDOG_DESKTOP_USER_DATA`
 *  is the only way the one-time migration reaches the profile's session metadata and remote state. */
export function coreEnvironment(packaged: boolean, resourcesPath: string, userData: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!packaged) return base;
  // The test hooks belong to a dev core built with `--features test-hooks`; a packaged core never receives them.
  const { MIXDOG_DEV_COMPUTER_RUN: _run, MIXDOGD_TEST_HOOKS: _hooks, ...inherited } = base;
  return { ...inherited, MIXDOG_ROOT: packagedMixdogRoot(resourcesPath), MIXDOG_DESKTOP_USER_DATA: userData };
}

export async function readCoreState(
  runtimeRoot: string
): Promise<{
  state: string;
  rpcPort: number | null;
  blocked: unknown;
  pid: number | null;
  controlPort: number | null;
  token: string | null;
  rebuild: { done: number; total: number } | null;
}> {
  let text: string;
  try {
    text = await readFile(join(runtimeRoot, 'daemon.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw Object.assign(new Error(`no core is running (${runtimeRoot})`), { name: 'CoreDiscoveryError', code: 'absent' });
    }
    throw error;
  }
  const discovery = JSON.parse(text) as {
    pid?: unknown;
    core?: {
      state?: unknown;
      rpc?: { port?: unknown };
      control?: { port?: unknown };
      blocked?: unknown;
      rebuild?: { done?: unknown; total?: unknown };
    };
    protocol?: unknown;
    endpoints?: { session?: { port?: unknown; token?: unknown } };
  };
  const core = discovery.core;
  const sessionPort = discovery.endpoints?.session?.port;
  const legacy = core === undefined && discovery.protocol === 1
    && typeof sessionPort === 'number' && Number.isInteger(sessionPort) && sessionPort > 0 && sessionPort <= 65535;
  return {
    state: legacy ? 'legacy' : String(core?.state ?? 'unknown'),
    rpcPort: Number.isInteger(core?.rpc?.port) ? (core?.rpc?.port as number) : null,
    blocked: core?.blocked ?? null,
    // Whose file this is: a core this app started and saw end is not waited for when the file still names it.
    pid: Number.isInteger(discovery.pid) ? (discovery.pid as number) : null,
    // What a liveness ask of the core needs: its control listener and the session token (watchCore).
    controlPort: Number.isInteger(core?.control?.port) ? (core?.control?.port as number) : null,
    token: typeof discovery.endpoints?.session?.token === 'string' ? discovery.endpoints.session.token : null,
    // Present only while the core rebuilds its conversation index at start.
    rebuild:
      Number.isInteger(core?.rebuild?.done) && Number.isInteger(core?.rebuild?.total) && (core?.rebuild?.total as number) > 0
        ? { done: core?.rebuild?.done as number, total: core?.rebuild?.total as number }
        : null,
  };
}

/** How long the desktop waits for its core to publish serving. The library default (15 s) is shorter than the core's first
 *  start on a large profile (12-17 s measured on a copy of a 11 GB profile, on a loaded machine), and a start that gives up
 *  leaves the app without a core. MIXDOG_DAEMON_READY_TIMEOUT_MS still overrides it. */
export const DESKTOP_CORE_READY_TIMEOUT_MS = 120_000;

/** What `coreExit` reads of a child process. */
export interface CoreProcess {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: () => void): unknown;
}

/** One fixed action on this child only. It has no endpoint reachable from discovery, the renderer or tools. */
export function desktopConfirmationWriter({ stdin, stdout }: ChildProcess): (() => Promise<void>) | undefined {
  if (!stdin || !stdout) return undefined;
  let closed = false;
  let pending: ((applied: boolean) => void) | undefined;
  const close = () => {
    closed = true;
    pending?.(false);
  };
  stdin.on('error', close);
  stdin.once('close', close);
  stdout.on('error', close);
  stdout.once('close', close);
  stdout.on('data', (reply: Buffer) => {
    if (!pending || reply.length !== 1 || (reply[0] !== 89 && reply[0] !== 78)) {
      close();
      return;
    }
    pending(reply[0] === 89);
  });
  return async () => {
    if (closed || pending) throw new Error('The desktop confirmation channel is unavailable.');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(close, 15_000);
      pending = (applied) => {
        clearTimeout(timeout);
        pending = undefined;
        if (applied) resolve();
        else reject(new Error('The local core did not confirm the change.'));
      };
      stdin.write('allow-all-actions\n', (error) => {
        if (error) close();
      });
    });
  };
}

/** Resolves when the core this app started has ended, or after `timeoutMs`: `true` when it ended (or there is none to
 *  wait for), `false` when the time ran out. A quitting app waits here after it has left the core: the stop it
 *  asked for (`requestCoreStop`) is what ends its PostgreSQL in order and closes a running turn's
 *  record. The app's own exit ends the core at once (it is the app's child), so an app that did not wait would cut the
 *  stop short every time. */
export function coreExit(child: CoreProcess | null, timeoutMs: number): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Ends the core this app started, and the processes it started (its workers, PostgreSQL), when a quit's stop left it running.
 *  The app's exit does not end its children on Windows, so a core that did not leave in time would outlive the app, keep the
 *  data directory and make the next launch wait on it. True when a kill was sent. */
export function forceEndCore(child: CoreProcess | null, { platform = process.platform, spawnImpl = spawn }: { platform?: NodeJS.Platform; spawnImpl?: typeof spawn } = {}): boolean {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (platform === 'win32') {
      const kill = spawnImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, detached: true });
      kill.once('error', () => {});
      kill.unref();
    } else {
      process.kill(child.pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

/** What became of the request to stop the core: `none` (no core of this app's to stop), `not-ours` (the discovery file
 *  names another process), `sent` (the core answered: it is winding down), `refused` (the request failed; `error` says
 *  why) or `unanswered` (no answer within the limit). `elapsedMs` is how long the request took. */
export interface CoreStopRequest {
  request: 'none' | 'not-ours' | 'sent' | 'refused' | 'unanswered';
  error: string | null;
  elapsedMs: number;
}

/** Asks the core this app started to stop (`mixdogd ctl stop --force --reason userStop`) and resolves once the request
 *  was answered, or after `timeoutMs`. A quit's stop is forced, as 1.4.5's was: the core cancels its running turns, agent
 *  tasks and service calls, runs its exit hooks and leaves. A stop that waits for idle never ends a busy core: the app has
 *  detached from it before it asks, so no drain notice reaches a client to confirm an abort, and the app's exit ends the
 *  core with its process tree and no exit hook. The stop is sent only while the discovery file names that very process, so
 *  a quit never stops a core another launcher owns. */
export async function requestCoreStop({
  child,
  bin,
  runtimeRoot,
  env,
  timeoutMs,
  spawnImpl = spawn,
  readDiscovery = readCoreState,
}: {
  child: CoreProcess | null;
  bin: string;
  runtimeRoot: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  spawnImpl?: typeof spawn;
  readDiscovery?: (runtimeRoot: string) => Promise<{ pid: number | null }>;
}): Promise<CoreStopRequest> {
  const began = Date.now();
  const outcome = (request: CoreStopRequest['request'], error: string | null = null): CoreStopRequest => ({
    request,
    error,
    elapsedMs: Date.now() - began,
  });
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return outcome('none');
  let named: number | null = null;
  try {
    named = (await readDiscovery(runtimeRoot)).pid;
  } catch (error) {
    return outcome('refused', `discovery unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (named !== child.pid) return outcome('not-ours');
  return new Promise((resolve) => {
    let settled = false;
    let stderr = '';
    const done = (result: CoreStopRequest['request'], error: string | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome(result, error));
    };
    const timer = setTimeout(() => done('unanswered'), timeoutMs);
    try {
      const ctl = spawnImpl(bin, ['ctl', 'stop', '--force', '--reason', 'userStop', '--json'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        ...(env ? { env } : {}),
      });
      ctl.stderr?.on('data', (chunk: Buffer | string) => {
        if (stderr.length < 2_000) stderr += String(chunk);
      });
      ctl.once('error', (error: Error) => done('refused', error.message));
      ctl.once('exit', (code) => (code === 0 ? done('sent') : done('refused', stderr.trim() || `mixdogd ctl stop exited ${code}`)));
    } catch (error) {
      done('refused', error instanceof Error ? error.message : String(error));
    }
  });
}

export function resolveLocalCore({
  runtimeRoot,
  bin,
  env,
  environmentReady,
  ensure = ensureCore,
  onLaunched,
  desktopConfirmationPipe = false,
  reports,
  spawnImpl = spawn,
}: {
  runtimeRoot: string;
  /** The binary to start, or how to choose it at each launch ([`coreLaunchPath`]): chosen once at the app's start, a
   *  link that could not be made then (the replaced core still running under the old name during a deploy) kept the
   *  core on `mixdogd.exe`, out of the app's group in Task Manager, for as long as the app ran. */
  bin: string | (() => string);
  /** The core's environment, read at spawn (after `environmentReady`). */
  env?: () => NodeJS.ProcessEnv;
  /** Settles once this process's environment is final: the core inherits it at spawn. */
  environmentReady(): Promise<unknown>;
  /** The attach-or-start routine; tests pass their own. */
  ensure?: typeof ensureCore;
  /** Told the core process this app started, each time it starts one (`coreExit` waits on it at quit). */
  onLaunched?: (child: ChildProcess) => void;
  desktopConfirmationPipe?: boolean;
  /** What this call reports while it waits for the core, as one launch attempt: the rebuild's progress, and how it ended. */
  reports?: { attempt(): LaunchAttempt; confirmed(): BootFailure | null };
  /** The spawn of a launch; tests pass their own. */
  spawnImpl?: typeof spawn;
}): () => Promise<WsEndpoint> {
  return async () => {
    await environmentReady();
    const attempt = reports?.attempt();
    try {
      await ensure({
        readDiscovery: () => readCoreState(runtimeRoot),
        // The app owns its core: an ordinary child, so the core ends when the app does and Windows lists it under the app.
        launch: () => {
          // A start that is confirmed not to succeed is not tried again until the user asks, for an attempt already waiting on the core too:
          // it attaches to a core that serves (or is booting), and never starts one.
          const confirmedNow = reports?.confirmed();
          if (confirmedNow) throw Object.assign(new Error(confirmedNow.message), { coreLaunchFailed: confirmedNow });
          return launchCore({
            bin: typeof bin === 'function' ? bin() : bin,
            detached: false,
            desktopConfirmationPipe,
            ...(env ? { env: env() } : {}),
            spawnImpl: ((...args: Parameters<typeof spawn>) => {
              const child = spawnImpl(...args);
              onLaunched?.(child);
              return child;
            }) as typeof spawn,
          });
        },
        readyTimeoutMs: Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS) || DESKTOP_CORE_READY_TIMEOUT_MS,
        ...(attempt ? { onProgress: attempt.progress } : {}),
      });
    } catch (error) {
      throw attempt ? attempt.failed(error) : error;
    }
    attempt?.succeeded();
    return readLocalDiscovery(runtimeRoot);
  };
}
