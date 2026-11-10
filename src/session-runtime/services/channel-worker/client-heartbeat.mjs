// The per-process client file under <runtime>/channel-clients/ that names a
// live client process, plus the sweep that removes rows whose pid died. The
// file is written once when the first runtime of the process starts and
// removed when the last one stops (or the process exits): its pid is the
// liveness, so nothing rewrites it on a timer.
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPidAlive } from '../../../runtime/shared/pid-liveness.mjs';

const EXIT_CLEANUPS = new Set();
let exitHookInstalled = false;
// Client file path -> runtimes of this process that hold it.
const holders = new Map();

export function pruneStaleChannelClientHeartbeats(clientDir, { pidAlive = isPidAlive } = {}) {
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
      const stale = !Number.isInteger(pid) || pid <= 0 || !pidAlive(pid);
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
  let unregisterExit = null;

  function stop() {
    if (!unregisterExit) return;
    const unregister = unregisterExit;
    unregisterExit = null;
    unregister();
    const remaining = (holders.get(clientPath) || 1) - 1;
    if (remaining > 0) {
      holders.set(clientPath, remaining);
      return;
    }
    holders.delete(clientPath);
    try {
      rmSync(clientPath, { force: true });
    } catch {}
  }

  function start() {
    if (unregisterExit) return;
    unregisterExit = registerExitCleanup(stop);
    const count = holders.get(clientPath) || 0;
    holders.set(clientPath, count + 1);
    if (count > 0) return;
    try {
      mkdirSync(clientDir, { recursive: true });
      pruneStaleChannelClientHeartbeats(clientDir);
      writeFileSync(clientPath, JSON.stringify({ pid: process.pid, cwd, updatedAt: Date.now() }));
    } catch {}
  }

  return { start, stop };
}
