// Launcher side of "attach or start": reads discovery, starts a core when none runs, and waits until discovery
// says `serving` (lifecycle spec §5.4: "launcher start = spawn detached → discovery serving").
import { spawn } from 'node:child_process';
import { beginDaemonSpawnCapture } from './crash-capture/spawn-capture.mjs';

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const POLL_MS = 50;

/**
 * Starts `mixdogd serve` detached from this process, so closing the terminal never stops running work. A launcher
 * that owns its core (`detached: false`, the desktop app) starts it as an ordinary child instead: the core ends with
 * the launcher and belongs to its process group. Its fd 2 goes
 * to the boot's crash capture (`<data>/daemon-crash`), whose sidecar the core fills with its own exit; resolves the
 * capture.
 */
export function launchCore({
  bin = process.env.MIXDOGD_BIN || 'mixdogd',
  env = process.env,
  spawnImpl = spawn,
  log = () => {},
  beginCapture = beginDaemonSpawnCapture,
  detached = true,
} = {}) {
  return new Promise((resolve, reject) => {
    const capture = beginCapture({ launcher: 'core', log });
    let child;
    try {
      child = spawnImpl(bin, ['serve'], { detached, stdio: ['ignore', 'ignore', capture.stderrStdio], windowsHide: true, env });
    } catch (error) {
      capture.noteSpawnError(error);
      reject(new Error(`cannot start ${bin}: ${error.message}`));
      return;
    }
    capture.track(child, { detached });
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
 * The core this launcher started has ended without serving, when nothing else can still bring one up: it ended
 * abnormally (a clean exit is a contender that lost the claim to another core, which is waited for), and discovery
 * names no core or names the ended one. Null while that is not known.
 */
function endedBeforeServing(capture, last) {
  const record = capture?.snapshot?.();
  if (!record?.exitedAt) return null;
  if (record.exitCode === 0 && !record.exitSignal) return null;
  if (last && last.pid !== record.pid) return null;
  const summary = capture.summary?.() ?? {};
  const reason = summary.exitReason || (record.exitSignal ? `killed by ${record.exitSignal}` : `exited with code ${record.exitCode ?? '?'}`);
  const said = summary.stderrErrorLine || summary.stderrLastLine;
  return Object.assign(new Error(`core is not ready: the core ended before serving (${reason})${said ? `: ${said}` : ''}`), {
    coreDiscovery: last ?? null,
    coreExit: { code: record.exitCode ?? null, signal: record.exitSignal ?? null, stderrPath: summary.stderrPath ?? null },
  });
}

/** Whether the process `pid` still runs (a process this user may not signal runs too). */
export function processRuns(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Resolves the serving core's discovery. A `blocked` core is the user's decision, so it fails at once instead of
 * waiting; `booting`, `migrating` and `draining` end by themselves, so they are waited out. A core this call started
 * that ends abnormally before serving fails at once too, with its exit and what it last said.
 *
 * A discovery file outlives a process that was killed (and the 1.4.5 daemon wrote the same file): one that names a
 * process no longer running names no core, so a core is started as when there is no file. Waiting for it never ends.
 */
export async function ensureCore({
  readDiscovery,
  launch = launchCore,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  readyTimeoutMs = Number(process.env.MIXDOG_DAEMON_READY_TIMEOUT_MS) || DEFAULT_READY_TIMEOUT_MS,
  now = Date.now,
  log = () => {},
  runs = processRuns,
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
    if (last && Number.isInteger(last.pid) && !runs(last.pid)) last = null;
    if (last?.state === 'serving' && last.rpcPort) {
      capture?.noteReady?.();
      return last;
    }
    if (last?.state === 'blocked') throw notReadyError(last);
    const ended = endedBeforeServing(capture, last);
    if (ended) throw ended;
    if (!last && !launched) {
      launched = true;
      log('starting core');
      capture = await launch({ log });
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
  }
  throw notReadyError(last);
}
