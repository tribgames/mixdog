// In-memory cache for small files read on hot paths (status pulse, routes).
// A warm read touches no filesystem: the value is replaced by this process's
// own writes (`set`), and other processes' writes are noticed by an `fs.watch`
// on the owning directory or, where a filesystem delivers no events, by an
// async stat at most every SAFETY_RECHECK_MS per entry. Either one only marks
// the entry stale when the file's identity changed; the next read reloads it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

export const SAFETY_RECHECK_MS = 15_000;
const MISSING = 'missing';

// Atomic replacements may keep mtime and size; identity and ctime tell them apart.
const stampOf = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

/** Stat stamp for `path` ('missing' when absent); other errors throw. */
export function fileStampSync(path) {
  try {
    return stampOf(fs.statSync(path, { bigint: true }));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return MISSING;
    throw error;
  }
}

/** Async counterpart of fileStampSync; resolves null on unexpected errors. */
export function fileStamp(path) {
  return fsp.stat(path, { bigint: true }).then(stampOf, (error) =>
    error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? MISSING : null
  );
}

// Caches still open; a closed one is released (its owner shut down).
const liveCaches = new Set();

/** `load(path)` returns `{ value, stamp }` synchronously (cold or stale read). */
export function createWatchedFileCache(load, { recheckMs = SAFETY_RECHECK_MS } = {}) {
  const entries = new Map();
  // dir -> { watcher, refs }: one watcher per directory, held by every entry
  // whose `watchDir` names it and closed when the last of them goes.
  const watchers = new Map();
  let closed = false;

  const closeWatcher = (dir) => {
    const held = watchers.get(dir);
    if (!held) return;
    watchers.delete(dir);
    try {
      held.watcher.close();
    } catch {}
  };

  const release = (dir) => {
    const held = dir === null ? null : watchers.get(dir);
    if (held && --held.refs <= 0) closeWatcher(dir);
  };

  // The watcher is gone (error, or its directory was replaced): entries that
  // held it hold nothing until they attach again.
  const dropWatcher = (dir) => {
    closeWatcher(dir);
    for (const entry of entries.values()) if (entry.watchDir === dir) entry.watchDir = null;
  };

  // 'ok' | 'missing' (no such directory yet) | 'failed' (no watch support).
  const openWatcher = (dir) => {
    if (watchers.has(dir)) return 'ok';
    try {
      const watcher = fs.watch(dir, { persistent: false }, (_event, name) => onEvent(dir, name));
      watcher.on('error', () => {
        if (watchers.get(dir)?.watcher !== watcher) return;
        for (const entry of entries.values()) if (entry.watchDir === dir) entry.stale = true;
        dropWatcher(dir);
      });
      watchers.set(dir, { watcher, refs: 0 });
      return 'ok';
    } catch (error) {
      return error?.code === 'ENOENT' ? 'missing' : 'failed';
    }
  };

  // Points `holder`'s watch at its file's directory or, while that is missing,
  // the nearest existing ancestor (whose event naming it re-verifies the
  // entries beneath it). True when it reached its own directory just now.
  const attach = (path, holder) => {
    const own = dirname(path);
    if (holder.watchDir === own) return false;
    let dir = own;
    for (;;) {
      const state = openWatcher(dir);
      if (state === 'ok') break;
      // No watch support at all: the safety re-check covers it.
      if (state === 'failed' || dirname(dir) === dir) {
        dir = null;
        break;
      }
      dir = dirname(dir);
    }
    if (dir === holder.watchDir) return false;
    if (dir !== null) watchers.get(dir).refs += 1;
    release(holder.watchDir);
    holder.watchDir = dir;
    return dir === own;
  };

  const remove = (path) => {
    const entry = entries.get(path);
    if (!entry) return;
    entries.delete(path);
    release(entry.watchDir);
  };

  const verify = (path, entry) => {
    if (entry.verifying) {
      // An event during an in-flight stat may postdate what that stat saw.
      entry.again = true;
      return;
    }
    entry.verifying = true;
    fileStamp(path).then((stamp) => {
      entry.verifying = false;
      // Generation check: a newer load or local write replaced this entry, and
      // a stat that started before it must not mark it stale.
      if (entries.get(path) !== entry) return;
      entry.checkedAt = Date.now();
      if (stamp === null || stamp !== entry.stamp) {
        entry.stale = true;
        return;
      }
      // A watch that starts only now may have missed a write before it.
      if (attach(path, entry)) entry.again = true;
      if (entry.again) {
        entry.again = false;
        verify(path, entry);
      }
    });
  };

  const onEvent = (dir, name) => {
    const target = name ? join(dir, String(name)) : null;
    for (const [path, entry] of entries) {
      if (target === null ? dirname(path) === dir : path === target) verify(path, entry);
      else if (target !== null && path.startsWith(target + sep)) {
        // A watched subdirectory was replaced: its watcher may follow the old one.
        if (entry.watchDir === dirname(path)) dropWatcher(entry.watchDir);
        verify(path, entry);
      }
    }
  };

  // `holder` carries the watch the new entry takes over.
  const store = (path, holder, value, stamp) => {
    const entry = { value, stamp, watchDir: holder.watchDir, stale: false, checkedAt: Date.now() };
    Object.assign(entry, { verifying: false, again: false });
    entries.set(path, entry);
    return entry;
  };

  const clear = () => {
    for (const dir of [...watchers.keys()]) closeWatcher(dir);
    entries.clear();
  };

  const cache = {
    /** The value of `path`; `fresh` reads the disk now (a read-modify-write). */
    get(path, { fresh = false } = {}) {
      if (closed) return load(path).value;
      const entry = entries.get(path);
      if (entry && !entry.stale && !fresh) {
        if (Date.now() - entry.checkedAt >= recheckMs) verify(path, entry);
        return entry.value;
      }
      // Watch before loading so a change after the load is never missed.
      const holder = entry ?? { watchDir: null };
      attach(path, holder);
      let loaded;
      try {
        loaded = load(path);
      } catch (error) {
        if (!entry) release(holder.watchDir);
        throw error;
      }
      return store(path, holder, loaded.value, loaded.stamp).value;
    },
    /** The cached value (even a stale one), or undefined. */
    peek(path) {
      return entries.get(path)?.value;
    },
    /** Write-through after this process wrote `path`. */
    set(path, value) {
      if (closed) return;
      const holder = entries.get(path) ?? { watchDir: null };
      attach(path, holder);
      // No stamp: the file may already hold another writer's newer bytes, and
      // their event may have arrived before this entry existed. Verify now,
      // which reloads the file once on the next read.
      verify(path, store(path, holder, value, null));
    },
    delete: remove,
    /** Forget every entry inside `dir` (this process rewrote that tree). */
    deleteUnder(dir) {
      for (const path of [...entries.keys()]) if (path.startsWith(dir + sep)) remove(path);
    },
    /** The owner is done: every watcher closes and later reads go to disk. */
    close() {
      closed = true;
      liveCaches.delete(cache);
      clear();
    },
    clear,
  };
  liveCaches.add(cache);
  return cache;
}

/** This process changed `path` behind its caches (a delete): every live
 *  cache forgets it now. */
export function forgetWatchedFile(path) {
  for (const cache of liveCaches) cache.delete(path);
}

/** Test seam: drop every cached value and close every watcher. */
export function _resetWatchedFileCachesForTest() {
  for (const cache of liveCaches) cache.clear();
}
