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

async function readCoreState(runtimeRoot: string): Promise<{ state: string; rpcPort: number | null; blocked: unknown }> {
  let text: string;
  try {
    text = await readFile(join(runtimeRoot, 'daemon.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw Object.assign(new Error(`no core is running (${runtimeRoot})`), { name: 'CoreDiscoveryError', code: 'absent' });
    }
    throw error;
  }
  const core = (JSON.parse(text) as { core?: { state?: unknown; rpc?: { port?: unknown }; blocked?: unknown } }).core;
  return {
    state: String(core?.state ?? 'unknown'),
    rpcPort: Number.isInteger(core?.rpc?.port) ? (core?.rpc?.port as number) : null,
    blocked: core?.blocked ?? null,
  };
}

export function resolveLocalCore({
  runtimeRoot,
  bin,
  env,
  environmentReady,
}: {
  runtimeRoot: string;
  bin: string;
  /** The core's environment, read at spawn (after `environmentReady`). */
  env?: () => NodeJS.ProcessEnv;
  /** Settles once this process's environment is final: the core inherits it at spawn. */
  environmentReady(): Promise<unknown>;
}): () => Promise<WsEndpoint> {
  return async () => {
    await environmentReady();
    await ensureCore({ readDiscovery: () => readCoreState(runtimeRoot), launch: () => launchCore({ bin, ...(env ? { env: env() } : {}) }) });
    return readLocalDiscovery(runtimeRoot);
  };
}
