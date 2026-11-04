// In-memory cache for small files read on hot paths (status, routes). A warm
// read touches no filesystem. Every watch event on a cached file (an
// `fs.watch` on its directory, whoever wrote it) re-reads that file off the
// loop after a short debounce; a value that differs from the cached one
// replaces it and tells `onChange`, an equal one changes nothing — so this
// process's own writes read back as no change. Nothing is polled: a
// directory whose watch fails (or errors later) is logged, closed and
// skipped; its entries wait on the nearest ancestor that can be watched,
// whose event naming the directory (it was created or replaced) re-reads
// them and tries the watch again. Until then — and while an entry's last
// load failed — a read of the entry is itself the event: it answers what
// the entry holds now and schedules one debounced re-read.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeStderrBestEffort } from './best-effort-stderr.mjs';

/** Re-reads a cache keeps in flight at once; the rest wait for a slot. */
export const POLL_CONCURRENCY = 8;
// One replace brings several events (Windows): the file is read once.
const RELOAD_DEBOUNCE_MS = 50;
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

/** `load(path)` returns `{ value }` synchronously (a cold read, or a fresh
 *  one); `loadAsync(path)` resolves the same off the loop (a re-read after a
 *  change). Both answer a file that does not exist as such (a value) and
 *  throw/reject for every other failure. Without `loadAsync`, re-reads call
 *  `load`: one synchronous call that has closed the file when it returns —
 *  for a file this process also replaces synchronously, whose rename an
 *  async read's handle (open across event-loop turns the blocked rename
 *  never gives it) would fail on Windows. A failed read keeps what the
 *  entry had — the last value, or the error of a first read that failed —
 *  without notifying. A warm read never touches the disk synchronously.
 *  `onChange(path)` hears every change of a cached value: a re-read that
 *  differs, an entry this process forgot (`delete`) — whoever wrote the
 *  file. `onWatch(path, watched)` hears an entry go blind (`false`: its
 *  directory's watch failed, so changes go unseen until an ancestor's event
 *  names it) and see again (`true`), for an owner that must say so. */
export function createWatchedFileCache({ load, loadAsync }, { onChange = null, onWatch = null } = {}) {
  const entries = new Map();
  const notify = (path) => {
    if (typeof onChange !== 'function') return;
    try {
      onChange(path);
    } catch {}
  };
  const notifyWatch = (path, watched) => {
    if (typeof onWatch !== 'function') return;
    try {
      onWatch(path, watched);
    } catch {}
  };
  // dir -> { watcher, refs }: one `fs.watch` per directory, held by every
  // entry whose `watchDir` names it and closed when the last of them goes.
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

  // The directory's watched subdirectory was replaced: its watcher may follow
  // the old one, so entries that held it attach again on their re-read.
  const dropWatcher = (dir) => {
    closeWatcher(dir);
    for (const entry of entries.values()) if (entry.watchDir === dir) entry.watchDir = null;
  };

  // Directories whose watch failed (not merely missing): not tried again
  // until an ancestor's event names them (they were created or replaced).
  const unwatchable = new Set();

  const watchFailed = (dir, error) => {
    unwatchable.add(dir);
    writeStderrBestEffort(`[watch] cannot watch ${dir}: ${error?.message || error}\n`);
  };

  // A watch that errored is closed; its entries wait on the nearest
  // ancestor that can be watched.
  const watchLost = (dir, error) => {
    const affected = [...entries].filter(([, entry]) => entry.watchDir === dir);
    dropWatcher(dir);
    watchFailed(dir, error);
    for (const [path, entry] of affected) attach(path, entry);
  };

  // 'open' (held now), 'missing' (does not exist yet) or 'failed'.
  const openWatcher = (dir) => {
    if (watchers.has(dir)) return 'open';
    if (unwatchable.has(dir)) return 'failed';
    let watcher;
    try {
      watcher = fs.watch(dir, { persistent: false }, (_event, name) => onEvent(dir, name));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'missing';
      watchFailed(dir, error);
      return 'failed';
    }
    const held = { watcher, refs: 0 };
    watcher.on('error', (error) => {
      if (watchers.get(dir) === held) watchLost(dir, error);
    });
    watchers.set(dir, held);
    return 'open';
  };

  // Points `holder`'s watch at its file's directory or, while that is missing
  // or unwatchable, the nearest ancestor that can be watched (whose event
  // naming it re-reads the entries beneath it, which try their own directory
  // again). `holder.blind`: a directory on that way failed (or nothing could
  // be watched), so events may go unseen and reads re-read on demand. True
  // when it reached its own directory just now.
  const attach = (path, holder) => {
    const own = dirname(path);
    if (holder.watchDir === own) return false;
    let dir = own;
    let blind = false;
    while (dir !== holder.watchDir) {
      const state = openWatcher(dir);
      if (state === 'open') break;
      if (state === 'failed') blind = true;
      const parent = dirname(dir);
      if (parent === dir) {
        dir = null;
        blind = true;
        break;
      }
      dir = parent;
    }
    if (blind !== (holder.blind === true)) notifyWatch(path, !blind);
    holder.blind = blind;
    if (dir === holder.watchDir) return false;
    if (dir !== null) watchers.get(dir).refs += 1;
    release(holder.watchDir);
    holder.watchDir = dir;
    return dir === own;
  };

  const drop = (path) => {
    const entry = entries.get(path);
    if (!entry) return null;
    clearTimeout(entry.timer);
    entries.delete(path);
    release(entry.watchDir);
    return entry;
  };

  // Re-reads in flight across every entry, and those waiting for a slot.
  let reading = 0;
  const waiting = [];

  const reread = (path, entry) => {
    if (entry.loading) {
      // An event during an in-flight read may postdate what that read saw.
      entry.again = true;
      return;
    }
    if (entry.queued) return;
    if (reading >= POLL_CONCURRENCY) {
      entry.queued = true;
      waiting.push([path, entry]);
      return;
    }
    startRead(path, entry);
  };

  const startWaiting = () => {
    while (reading < POLL_CONCURRENCY && waiting.length > 0) {
      const [path, entry] = waiting.shift();
      entry.queued = false;
      if (entries.get(path) === entry) startRead(path, entry);
    }
  };

  const startRead = (path, entry) => {
    reading += 1;
    entry.loading = true;
    // Generation check: a newer load or local write replaced this entry, and
    // a read that started before it must not overwrite it.
    const current = () => entries.get(path) === entry;
    (loadAsync ? loadAsync(path) : new Promise((resolve) => resolve(load(path))))
      .then(
        (loaded) => {
          if (!current()) return;
          const changed = entry.error !== null || !isDeepStrictEqual(loaded.value, entry.value);
          entry.value = loaded.value;
          entry.error = null;
          entry.failed = false;
          if (changed) notify(path);
        },
        (error) => {
          // The entry keeps what it had; the next event, or read, reads again.
          if (!current()) return;
          entry.failed = true;
          writeStderrBestEffort(`[watch] re-read of ${path} failed: ${error?.message || error}\n`);
        }
      )
      .finally(() => {
        reading -= 1;
        entry.loading = false;
        startWaiting();
        if (!current()) return;
        // A watch that starts only now may have missed a write before it.
        if (attach(path, entry)) entry.again = true;
        // Debounced like any event: a read started at once could still hold
        // the file when this process's next synchronous write renames over it.
        if (entry.again) {
          entry.again = false;
          scheduleReread(path, entry);
        }
      });
  };

  const scheduleReread = (path, entry) => {
    if (entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entries.get(path) === entry) reread(path, entry);
    }, RELOAD_DEBOUNCE_MS);
    entry.timer.unref?.();
  };

  // A read of an entry that may be behind the file: its last load failed, or
  // its directory's watch did. Joins a re-read already due or running.
  const demandReread = (path, entry) => {
    if (!(entry.error || entry.failed || entry.blind) || entry.loading || entry.queued) return;
    scheduleReread(path, entry);
  };

  const onEvent = (dir, name) => {
    const target = name ? join(dir, String(name)) : null;
    // A directory named here was created or replaced: its watch may work now.
    if (target !== null) {
      for (const failed of [...unwatchable]) {
        if (failed === target || failed.startsWith(target + sep)) unwatchable.delete(failed);
      }
    }
    for (const [path, entry] of entries) {
      if (target === null ? dirname(path) === dir : path === target) scheduleReread(path, entry);
      else if (target !== null && path.startsWith(target + sep)) {
        if (entry.watchDir === dirname(path)) dropWatcher(entry.watchDir);
        scheduleReread(path, entry);
      }
    }
  };

  // `holder` carries the watch the new entry takes over.
  // `error`: a first read failed, and reads throw it until a re-read succeeds.
  const store = (path, holder, value, error = null) => {
    const previous = entries.get(path);
    if (previous) clearTimeout(previous.timer);
    const entry = {
      value,
      error,
      failed: false,
      watchDir: holder.watchDir,
      blind: holder.blind === true,
      loading: false,
      queued: false,
      again: false,
      timer: null,
    };
    entries.set(path, entry);
    return entry;
  };

  const clear = () => {
    for (const entry of entries.values()) clearTimeout(entry.timer);
    for (const dir of [...watchers.keys()]) closeWatcher(dir);
    entries.clear();
    unwatchable.clear();
    waiting.length = 0;
  };

  const cache = {
    /** The value of `path`; `fresh` reads the disk now (a read-modify-write). */
    get(path, { fresh = false } = {}) {
      if (closed) return load(path).value;
      const entry = entries.get(path);
      if (entry && !fresh) {
        demandReread(path, entry);
        if (entry.error) throw entry.error;
        return entry.value;
      }
      // Watch before loading so a change after the load is never missed.
      const holder = entry ?? { watchDir: null };
      attach(path, holder);
      let loaded;
      try {
        loaded = load(path);
      } catch (error) {
        // A failed fresh read keeps the entry's last value; a failed first
        // read is kept as such: the next reads answer it from memory and
        // re-read off the loop.
        if (!entry) store(path, holder, undefined, error);
        throw error;
      }
      return store(path, holder, loaded.value).value;
    },
    /** The cached value (the last one read), or undefined. */
    peek(path) {
      return entries.get(path)?.value;
    },
    /** Write-through after this process wrote `path`. The file is read back
     *  (debounced, so the read holds no handle across the writer's next
     *  rename): our own value compares equal and tells nobody, while a write
     *  another writer landed meanwhile is read rather than lost. */
    set(path, value) {
      if (closed) return;
      const holder = entries.get(path) ?? { watchDir: null };
      attach(path, holder);
      scheduleReread(path, store(path, holder, value));
    },
    /** This process removed or rewrote `path`: forget it, and say so. */
    delete(path) {
      if (drop(path)) notify(path);
    },
    /** Forget every entry inside `dir` (this process rewrote that tree). */
    deleteUnder(dir) {
      for (const path of [...entries.keys()]) if (path.startsWith(dir + sep)) cache.delete(path);
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
 *  cache forgets it now and tells its observers. */
export function forgetWatchedFile(path) {
  for (const cache of liveCaches) cache.delete(path);
}

/** Test seam: drop every cached value and close every watcher. */
export function _resetWatchedFileCachesForTest() {
  for (const cache of liveCaches) cache.clear();
}
