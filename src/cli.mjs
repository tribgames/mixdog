#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { performPendingSwap, registerLiveSession } from './runtime/shared/staged-update.mjs';

const argv = process.argv.slice(2);

// Pre-import self-update swap: BEFORE any runtime module is imported, if a
// completed staged newer version exists and no other mixdog session is live,
// atomically swap the global package dir into place. Doing it here (and only
// here) means the process goes on to load the NEW files, and a live session
// never has its files overwritten mid-run. Any obstacle → false, run current.
let swapped = false;
try { swapped = performPendingSwap(); } catch { swapped = false; }

// Register this process in the live-session refcount BEFORE any runtime module
// loads, so a concurrently-launching mixdog's liveness check can see us and
// defer its own swap. Unregister is hooked on process 'exit' (and on graceful
// close). Harmless for the swap decision above — our own pid is excluded.
try { registerLiveSession(); } catch { /* advisory refcount only */ }

async function main() {
  // If we actually swapped, re-exec a fresh node process so the new package
  // loads with a clean module cache (no stale pre-swap modules mixed in). The
  // env guard prevents re-swap / relaunch loops. Foreground + inherited stdio
  // keeps the interactive TUI intact. Best-effort: if the re-exec spawn fails,
  // fall through and run in-place.
  if (swapped && !process.env.MIXDOG_SWAP_REEXEC) {
    try {
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
        stdio: 'inherit',
        env: { ...process.env, MIXDOG_SWAP_REEXEC: '1' },
      });
      if (!r.error) return Number.isInteger(r.status) ? r.status : 0;
    } catch { /* fall through to in-place run */ }
  }
  const { run } = await import('./app.mjs');
  return await run(argv);
}

main().then((code) => {
  process.exit(Number.isInteger(code) ? code : 0);
}).catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exit(1);
});
