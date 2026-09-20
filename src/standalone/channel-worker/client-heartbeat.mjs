// channel-worker/client-heartbeat.mjs
// The per-process heartbeat file under <runtime>/channel-clients/ that tells
// the daemon which client processes are alive, plus the sweep that removes
// rows whose pid died or whose stamp went stale.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFile } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from '../../runtime/shared/pid-liveness.mjs';

const HEARTBEAT_INTERVAL_MS = 5_000;
const EXIT_CLEANUPS = new Set();
let exitHookInstalled = false;

export function pruneStaleChannelClientHeartbeats(
  clientDir,
  { now = Date.now(), maxAgeMs = 30_000, pidAlive = isPidAlive } = {}
) {
  let removed = 0;
  try {
    for (const name of readdirSync(clientDir)) {
      if (!/^\d+\.json$/.test(name)) continue;
      const target = join(clientDir, name);
      let row = null;
      try {
        row = JSON.parse(readFileSync(target, 'utf8'));
      } catch {}
      const pid = Number(row?.pid);
      const updatedAt = Number(row?.updatedAt);
      const stale =
        !Number.isInteger(pid) ||
        pid <= 0 ||
        !Number.isFinite(updatedAt) ||
        now - updatedAt > Math.max(5_000, Number(maxAgeMs) || 30_000) ||
        !pidAlive(pid);
      if (!stale) continue;
      try {
        rmSync(target, { force: true });
        removed += 1;
      } catch {}
    }
  } catch {}
  return removed;
}

/** Runs `cleanup` on process exit; returns the unregister function. */
function registerExitCleanup(cleanup) {
  EXIT_CLEANUPS.add(cleanup);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const fn of EXIT_CLEANUPS) {
        try {
          fn();
        } catch {}
      }
      EXIT_CLEANUPS.clear();
    });
  }
  return () => {
    EXIT_CLEANUPS.delete(cleanup);
  };
}

export function createClientHeartbeat({ clientDir, cwd }) {
  const clientPath = join(clientDir, `${process.pid}.json`);
  let timer = null;
  let unregisterExit = null;
  let dirReady = false;

  function write() {
    try {
      if (!dirReady) {
        mkdirSync(clientDir, { recursive: true });
        pruneStaleChannelClientHeartbeats(clientDir);
        dirReady = true;
      }
      writeFile(clientPath, JSON.stringify({ pid: process.pid, cwd, updatedAt: Date.now() }), () => {});
    } catch {}
  }

  function stop() {
    if (unregisterExit) {
      const unregister = unregisterExit;
      unregisterExit = null;
      unregister();
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    try {
      rmSync(clientPath, { force: true });
    } catch {}
  }

  function start() {
    if (timer) return;
    write();
    timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    unregisterExit ||= registerExitCleanup(stop);
  }

  return { start, stop };
}
