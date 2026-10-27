// Temp dirs a test run or the local gate owns. A normal exit removes them, but
// a killed process runs no exit handler, so each run starts by sweeping what an
// earlier killed run left behind.
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// How long a kept test log stays readable; also what counts as a leftover.
export const STALE_TEMP_MS = 3 * 24 * 60 * 60 * 1000;

// rmSync retries the lock errors itself (EBUSY, EPERM, ENOTEMPTY, ...) a
// bounded number of times per entry before it throws. Returns whether the
// directory is gone; a held file leaves it for the next start-of-run sweep.
export function removeTempDirSync(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  } catch {
    return false;
  }
}

// Removes every directory in `root` whose name starts with one of `prefixes`
// and whose mtime is older than `maxAgeMs`.
export function pruneStaleTempDirs(prefixes, { root = tmpdir(), maxAgeMs = STALE_TEMP_MS, now = Date.now() } = {}) {
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  const cutoff = now - maxAgeMs;
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const path = join(root, name);
    try {
      // lstat: a link or a plain file that merely matches the prefix is not ours to remove.
      const info = lstatSync(path);
      if (info.isDirectory() && info.mtimeMs < cutoff) removeTempDirSync(path);
    } catch {
      /* another run may own or be removing it */
    }
  }
}
