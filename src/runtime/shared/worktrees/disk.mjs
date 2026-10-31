/**
 * Disk estimate for a new worktree: tracked checkout bytes (blob sizes of the
 * base commit's tree) + include copies + a safety margin, compared with free
 * space on the DESTINATION volume.
 */
import { existsSync } from 'node:fs';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runGit } from './git.mjs';
import { pathKey } from './paths.mjs';

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

/**
 * Bytes of the files under `path`. Links are not followed (linked dependency
 * folders belong to the project folder); unreadable entries are skipped. The
 * walk stops after `maxEntries`, reporting `complete: false` (a lower bound).
 * @returns {Promise<{ bytes: number, complete: boolean }>}
 */
async function folderBytes(path, { maxEntries = 250_000 } = {}) {
  let bytes = 0;
  let seen = 0;
  const pending = [path];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > maxEntries) return { bytes, complete: false };
      const child = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile())
        bytes += await lstat(child).then(
          (info) => info.size,
          () => 0
        );
    }
  }
  return { bytes, complete: true };
}

// path key → { bytes, complete, at, refresh }: the worktree list's sizes.
const sizeCache = new Map();
const FOLDER_SIZE_TTL_MS = 5 * 60_000;
// The repository's comparison key: canonical, case-folded only on Windows.
const sizeKey = (path, platform) => pathKey(path, platform);

/**
 * folderBytes through a per-path cache: a fresh entry (younger than
 * `ttlMs`) is returned as is; a stale one is returned at once while one
 * background walk refreshes it; only a path never measured waits for its walk.
 * forgetFolderSize drops an entry (the worktree was removed or created).
 * @returns {Promise<{ bytes: number, complete: boolean, at: number }>}
 */
export async function cachedFolderBytes(
  path,
  { ttlMs = FOLDER_SIZE_TTL_MS, measure = folderBytes, platform = process.platform } = {}
) {
  const key = sizeKey(path, platform);
  const cached = sizeCache.get(key);
  const walk = () => {
    const refresh = measure(path).then(
      (value) => {
        const entry = { ...value, at: Date.now(), refresh: null };
        if (sizeCache.get(key)?.refresh === refresh) sizeCache.set(key, entry);
        return entry;
      },
      (error) => {
        if (sizeCache.get(key)?.refresh === refresh) sizeCache.delete(key);
        throw error;
      }
    );
    sizeCache.set(key, { ...(cached ?? { bytes: 0, complete: false, at: 0 }), refresh });
    return refresh;
  };
  if (!cached) return walk();
  if (!cached.refresh && Date.now() - cached.at >= ttlMs) walk().catch(() => {});
  if (!cached.at) return cached.refresh;
  return { bytes: cached.bytes, complete: cached.complete, at: cached.at };
}

export function forgetFolderSize(path, platform = process.platform) {
  if (typeof path === 'string' && path) sizeCache.delete(sizeKey(path, platform));
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
