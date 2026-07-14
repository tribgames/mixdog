#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { classifyCliInvocation } from './headless-command.mjs';

const argv = process.argv.slice(2);

let swapped = false;
const invocation = classifyCliInvocation(argv);
const skipHostPrelude = invocation.kind === 'headless' || invocation.skipHostPrelude === true;
if (!skipHostPrelude) {
  // Interactive/general sessions retain the staged-update and live-session
  // semantics. Headless role commands skip both because those helpers touch the
  // host data tree before the pristine boundary exists.
  try {
    const { performPendingSwap, registerLiveSession } = await import(
      './runtime/shared/staged-update.mjs'
    );
    swapped = performPendingSwap();
    try { registerLiveSession(); } catch { /* advisory refcount only */ }
  } catch {
    swapped = false;
  }
}

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
        windowsHide: true,
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
