// A slow disk, injected at the file layer: loaded into the daemon before it
// (daemon-steady-entry.mjs `MIXDOG_STEADY_STATE_MUTATION`), it delays every
// node:fs call that names a path under the daemon's data dir or runtime root
// by MIXDOG_SLOW_DISK_MS (default 5 ms). A synchronous call blocks the thread
// for the delay, as a call on a saturated disk does; a promise-based one waits
// without holding the thread. Lock waits inherit the delay through their
// stat/link/unlink calls, so a file lock takes longer to take and to release.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import module from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';

const delayMs = Number(process.env.MIXDOG_SLOW_DISK_MS ?? 5);
const roots = [process.env.MIXDOG_DATA_DIR, process.env.MIXDOG_RUNTIME_ROOT].filter(Boolean).map((p) => resolve(p));

function slow(target) {
  if (delayMs <= 0 || (typeof target !== 'string' && !(target instanceof URL))) return false;
  let path;
  try {
    path = resolve(target instanceof URL ? target.pathname : target);
  } catch {
    return false;
  }
  return roots.some((root) => path.startsWith(root));
}

for (const name of Object.keys(fs)) {
  if (!name.endsWith('Sync') || typeof fs[name] !== 'function') continue;
  const real = fs[name];
  fs[name] = function slowSync(...args) {
    if (slow(args[0])) {
      // Spun, not Atomics.wait: Windows sleeps in ~15 ms steps, which would
      // make a 2 ms disk cost 15 ms per call.
      for (const until = performance.now() + delayMs; performance.now() < until; );
    }
    return real.apply(this, args);
  };
}
for (const name of ['open', 'readFile', 'writeFile', 'appendFile', 'rename', 'link', 'unlink', 'stat', 'readdir', 'mkdir']) {
  const real = fsPromises[name];
  fsPromises[name] = async function slowAsync(...args) {
    if (slow(args[0])) await sleep(delayMs);
    return real.apply(this, args);
  };
}
module.syncBuiltinESMExports();
