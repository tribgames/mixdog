// Attach-or-start of this PC's core (lifecycle spec §5.4): the one place the desktop launches `mixdogd serve`, then waits
// until the discovery file says `serving`. The endpoint itself is read by `readLocalDiscovery` on every dial.
import { spawn } from 'node:child_process';
import { linkSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureCore, launchCore } from '../../../../../packages/protocol-client/src/launch/ensure-core.mjs';
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
  remove: (path) => rmSync(path, { force: true }),
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
  return packaged ? { ...base, MIXDOG_ROOT: packagedMixdogRoot(resourcesPath), MIXDOG_DESKTOP_USER_DATA: userData } : base;
}

async function readCoreState(runtimeRoot: string): Promise<{ state: string; rpcPort: number | null; blocked: unknown; pid: number | null }> {
  let text: string;
  try {
    text = await readFile(join(runtimeRoot, 'daemon.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw Object.assign(new Error(`no core is running (${runtimeRoot})`), { name: 'CoreDiscoveryError', code: 'absent' });
    }
    throw error;
  }
  const discovery = JSON.parse(text) as { pid?: unknown; core?: { state?: unknown; rpc?: { port?: unknown }; blocked?: unknown } };
  const core = discovery.core;
  return {
    state: String(core?.state ?? 'unknown'),
    rpcPort: Number.isInteger(core?.rpc?.port) ? (core?.rpc?.port as number) : null,
    blocked: core?.blocked ?? null,
    // Whose file this is: a core this app started and saw end is not waited for when the file still names it.
    pid: Number.isInteger(discovery.pid) ? (discovery.pid as number) : null,
  };
}

/** How long the desktop waits for its core to publish serving. The library default (15 s) is shorter than the core's first
 *  start on a large profile (12-17 s measured on a copy of a 11 GB profile, on a loaded machine), and a start that gives up
 *  leaves the app without a core. MIXDOG_DAEMON_READY_TIMEOUT_MS still overrides it. */
export const DESKTOP_CORE_READY_TIMEOUT_MS = 120_000;

/** What `coreExit` reads of a child process. */
export interface CoreProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: () => void): unknown;
}

/** Resolves when the core this app started has ended, or after `timeoutMs`: `true` when it ended (or there is none to
 *  wait for), `false` when the time ran out. A quitting app waits here after it has left the core: the core stops by
 *  itself once its last client is gone, and that stop is what ends its PostgreSQL in order and closes a running turn's
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

export function resolveLocalCore({
  runtimeRoot,
  bin,
  env,
  environmentReady,
  ensure = ensureCore,
  onLaunched,
  spawnImpl = spawn,
}: {
  runtimeRoot: string;
  bin: string;
  /** The core's environment, read at spawn (after `environmentReady`). */
  env?: () => NodeJS.ProcessEnv;
  /** Settles once this process's environment is final: the core inherits it at spawn. */
  environmentReady(): Promise<unknown>;
  /** The attach-or-start routine; tests pass their own. */
  ensure?: typeof ensureCore;
  /** Told the core process this app started, each time it starts one (`coreExit` waits on it at quit). */
  onLaunched?: (child: CoreProcess) => void;
  /** The spawn of a launch; tests pass their own. */
  spawnImpl?: typeof spawn;
}): () => Promise<WsEndpoint> {
  return async () => {
    await environmentReady();
    await ensure({
      readDiscovery: () => readCoreState(runtimeRoot),
      // The app owns its core: an ordinary child, so the core ends when the app does and Windows lists it under the app.
      launch: () =>
        launchCore({
          bin,
          detached: false,
          ...(env ? { env: env() } : {}),
          spawnImpl: ((...args: Parameters<typeof spawn>) => {
            const child = spawnImpl(...args);
            onLaunched?.(child);
            return child;
          }) as typeof spawn,
        }),
      readyTimeoutMs: Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS) || DESKTOP_CORE_READY_TIMEOUT_MS,
    });
    return readLocalDiscovery(runtimeRoot);
  };
}
