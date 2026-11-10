// Launcher side of "attach or start": reads discovery, starts a core when none runs, and waits until discovery
// says `serving` (lifecycle spec §5.4: "launcher start = spawn detached → discovery serving").
import { spawn } from 'node:child_process';
import { sleep as delay } from '../../runtime/shared/sleep.mjs';
import { CoreDiscoveryError, readCoreDiscovery } from './discovery.mjs';

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const POLL_MS = 50;

/** Starts `mixdogd serve` detached from this process, so closing the terminal never stops running work. */
export function launchCore({ bin = process.env.MIXDOGD_BIN || 'mixdogd', spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => reject(new Error(`cannot start ${bin}: ${error.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function notReadyError(last) {
  const state = last ? `the core is ${last.state}` : 'no core published its endpoint';
  const detail = last?.blocked ? ` (${JSON.stringify(last.blocked)})` : '';
  return Object.assign(new Error(`core is not ready: ${state}${detail}`), { coreDiscovery: last ?? null });
}

/**
 * Resolves the serving core's discovery. A `blocked` core is the user's decision, so it fails at once instead of
 * waiting; `booting`, `migrating` and `draining` end by themselves, so they are waited out.
 */
export async function ensureCore({
  readDiscovery = readCoreDiscovery,
  launch = launchCore,
  sleep = delay,
  readyTimeoutMs = Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS) || DEFAULT_READY_TIMEOUT_MS,
  now = Date.now,
  log = () => {},
} = {}) {
  const deadline = now() + Math.max(1, readyTimeoutMs);
  let launched = false;
  let last = null;
  while (now() < deadline) {
    try {
      last = await readDiscovery();
    } catch (error) {
      if (!(error instanceof CoreDiscoveryError) || error.code !== 'absent') throw error;
      last = null;
    }
    if (last?.state === 'serving' && last.rpcPort) return last;
    if (last?.state === 'blocked') throw notReadyError(last);
    if (!last && !launched) {
      launched = true;
      log('starting core');
      await launch();
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
  }
  throw notReadyError(last);
}
