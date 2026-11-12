// Attach-or-start of this PC's core (lifecycle spec §5.4): the one place the desktop launches `mixdogd serve`, then waits
// until the discovery file says `serving`. The endpoint itself is read by `readLocalDiscovery` on every dial.
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

// Switches to `desktopMixdogRoot` of scripts/core-layout.mjs when k1-packaging combines.
/** The core's resource root in a packaged app: the unpacked `src/` of the mixdog package (the same rule as
 *  `desktopMixdogRoot` in scripts/core-layout.mjs, which stages it). */
export function packagedMixdogRoot(resourcesPath: string): string {
  return join(resourcesPath, 'runtime.asar.unpacked', 'node_modules', 'mixdog', 'src');
}

/** What the started core inherits: a packaged app tells it where its resources are. */
export function coreEnvironment(packaged: boolean, resourcesPath: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return packaged ? { ...base, MIXDOG_ROOT: packagedMixdogRoot(resourcesPath) } : base;
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

export function resolveLocalCore({
  runtimeRoot,
  bin,
  env,
  environmentReady,
  ensure = ensureCore,
}: {
  runtimeRoot: string;
  bin: string;
  /** The core's environment, read at spawn (after `environmentReady`). */
  env?: () => NodeJS.ProcessEnv;
  /** Settles once this process's environment is final: the core inherits it at spawn. */
  environmentReady(): Promise<unknown>;
  /** The attach-or-start routine; tests pass their own. */
  ensure?: typeof ensureCore;
}): () => Promise<WsEndpoint> {
  return async () => {
    await environmentReady();
    await ensure({
      readDiscovery: () => readCoreState(runtimeRoot),
      launch: () => launchCore({ bin, ...(env ? { env: env() } : {}) }),
      readyTimeoutMs: Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS) || DESKTOP_CORE_READY_TIMEOUT_MS,
    });
    return readLocalDiscovery(runtimeRoot);
  };
}
