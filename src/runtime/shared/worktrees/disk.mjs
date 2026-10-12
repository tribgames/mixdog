/**
 * Disk estimate for a new worktree: tracked checkout bytes (blob sizes of the
 * base commit's tree) + include copies + a safety margin, compared with free
 * space on the DESTINATION volume.
 */
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runGit } from './git.mjs';

const MARGIN_MIN_BYTES = 64 * 1024 * 1024;
const MARGIN_RATIO = 0.1;

/**
 * Sum of blob sizes in `commit`'s tree; gitlinks flag submodules.
 * @returns {Promise<{ bytes: number, files: number, submodules: boolean }>}
 */
export async function trackedCheckoutBytes(cwd, commit, { signal } = {}) {
  const result = await runGit(cwd, ['ls-tree', '-r', '-l', '-z', '--full-tree', commit], {
    signal,
    timeoutMs: 600_000,
    maxBytes: 1024 * 1024 * 1024,
  });
  let bytes = 0;
  let files = 0;
  let submodules = false;
  for (const record of result.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [, type, , size] = record.slice(0, tab).trim().split(/\s+/);
    if (type === 'commit') {
      submodules = true;
      continue;
    }
    if (type !== 'blob') continue;
    files += 1;
    bytes += Number(size) || 0;
  }
  return { bytes, files, submodules };
}

/** Bytes needed for `contentBytes` of checkout and copies. */
export function requiredBytes(contentBytes) {
  return contentBytes + Math.max(MARGIN_MIN_BYTES, Math.ceil(contentBytes * MARGIN_RATIO));
}

/** Free bytes available to this user on the volume holding `path`. */
export async function freeBytesAt(path) {
  let dir = resolve(path);
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const info = await statfs(dir);
  return Number(info.bavail) * Number(info.bsize);
}
