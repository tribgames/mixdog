// Launcher side of "attach or start": reads discovery, starts a core when none runs, and waits until discovery
// says `serving` (lifecycle spec §5.4: "launcher start = spawn detached → discovery serving").
import { spawn } from 'node:child_process';
import { beginDaemonSpawnCapture } from './crash-capture/spawn-capture.mjs';

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const POLL_MS = 50;

/**
 * Starts `mixdogd serve` detached from this process, so closing the terminal never stops running work. Its fd 2 goes
 * to the boot's crash capture (`<data>/daemon-crash`), whose sidecar the core fills with its own exit; resolves the
 * capture.
 */
export function launchCore({
  bin = process.env.MIXDOGD_BIN || 'mixdogd',
  env = process.env,
  spawnImpl = spawn,
  log = () => {},
  beginCapture = beginDaemonSpawnCapture,
} = {}) {
  return new Promise((resolve, reject) => {
    const capture = beginCapture({ launcher: 'core', log });
    let child;
    try {
      child = spawnImpl(bin, ['serve'], { detached: true, stdio: ['ignore', 'ignore', capture.stderrStdio], windowsHide: true, env });
    } catch (error) {
      capture.noteSpawnError(error);
      reject(new Error(`cannot start ${bin}: ${error.message}`));
      return;
    }
    capture.track(child, { detached: true });
    child.once('error', (error) => reject(new Error(`cannot start ${bin}: ${error.message}`)));
    child.once('spawn', () => {
      child.stderr?.unref?.();
      child.unref();
      resolve(capture);
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
  readDiscovery,
  launch = launchCore,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readyTimeoutMs = Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS) || DEFAULT_READY_TIMEOUT_MS,
  now = Date.now,
  log = () => {},
} = {}) {
  const deadline = now() + Math.max(1, readyTimeoutMs);
  let launched = false;
  let capture = null;
  let last = null;
  while (now() < deadline) {
    try {
      last = await readDiscovery();
    } catch (error) {
      if (error?.name !== 'CoreDiscoveryError' || error.code !== 'absent') throw error;
      last = null;
    }
    if (last?.state === 'serving' && last.rpcPort) {
      capture?.noteReady?.();
      return last;
    }
    if (last?.state === 'blocked') throw notReadyError(last);
    if (!last && !launched) {
      launched = true;
      log('starting core');
      capture = await launch({ log });
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
  }
  throw notReadyError(last);
}
