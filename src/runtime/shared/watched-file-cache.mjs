// In-memory cache for small files read on hot paths (status, routes). A warm
// read touches no filesystem. Every watch event on a cached file (the
// process's one shared watch of its directory, directory-watch.mjs, whoever
// wrote it) re-reads that file off the loop after a short debounce; a value
// that differs from the cached one
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
import { basename, dirname, join, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { writeStderrBestEffort } from './best-effort-stderr.mjs';
import { watchDirectory } from './directory-watch.mjs';

/** Re-reads a cache keeps in flight at once; the rest wait for a slot. */
export const POLL_CONCURRENCY = 8;
// One replace brings several events (Windows): the file is read once.
const RELOAD_DEBOUNCE_MS = 50;
const MISSING = 'missing';

const isMissing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

// The entry of `dir` on the way down to `target` (a path inside it).
const stepToward = (dir, target) => target.slice(dir.endsWith(sep) ? dir.length : dir.length + 1).split(sep)[0];

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
  let closed = false;

  // Directories whose watch failed (not merely missing): not tried again
  // until an ancestor's event names them (they were created or replaced).
  const unwatchable = new Set();

  const watchFailed = (dir, error) => {
    if (unwatchable.has(dir)) return;
    unwatchable.add(dir);
    writeStderrBestEffort(`[watch] cannot watch ${dir}: ${error?.message || error}\n`);
  };

  // `target` was named by an event (created or replaced): a failed watch at
  // or under it may work now.
  const forgive = (target) => {
    for (const failed of [...unwatchable]) {
      if (failed === target || failed.startsWith(target + sep)) unwatchable.delete(failed);
    }
  };

  // `path`'s entry follows its file in `dir` — its own directory — or, while
  // that is missing or unwatchable, the step toward it in the nearest
  // ancestor that can be watched; an event there re-reads the entry, which
  // then tries its own directory again. Either directory replaced must be
  // heard (a watch follows the moved one), so both follow their parent.
  // Handlers of a subscription the entry no longer holds do nothing.
  const subscribe = (path, dir, own) => {
    const held = () => {
      const entry = entries.get(path);
      return entry?.subscription === subscription ? entry : null;
    };
    const subscription = watchDirectory(dir, [own ? basename(path) : stepToward(dir, dirname(path))], {
      replace: true,
      onEvent: (_event, name) => {
        if (!own && name) forgive(join(dir, name));
        const entry = held();
        if (entry) scheduleReread(path, entry);
      },
      // The watch ended (an error, a close, or the directory gone after a
      // replacement): the entry re-attaches and re-reads what it may have missed.
      onLost: (error) => {
        const entry = held();
        if (!entry) return;
        if (!isMissing(error)) watchFailed(dir, error);
        entry.watchDir = null;
        entry.subscription = null;
        attach(path, entry);
        scheduleReread(path, entry);
      },
      // A replacement of the directory now goes unheard: reads re-read on demand.
      onDistrust: () => {
        const entry = held();
        if (!entry) return;
        if (!entry.blind) {
          entry.blind = true;
          notifyWatch(path, false);
        }
        scheduleReread(path, entry);
      },
      // Heard again (the watch also moved onto the live directory and its
      // unnamed event re-reads the entry). An entry waiting on an ancestor
      // may be blind for a directory below that failed: it sees again only
      // once it re-attaches.
      onTrust: () => {
        const entry = held();
        if (!entry?.blind || !own) return;
        entry.blind = false;
        notifyWatch(path, true);
      },
    });
    return subscription;
  };

  // Points `holder`'s subscription at its file's directory or, while that is
  // missing or unwatchable, the nearest ancestor that can be watched.
  // `holder.blind`: a directory on that way failed (or nothing could be
  // watched, or a replacement of the one it holds would go unheard), so events may go
  // unseen and reads re-read on demand. True when it reached its own
  // directory just now.
  const attach = (path, holder) => {
    const own = dirname(path);
    if (holder.watchDir === own) return false;
    let dir = own;
    let blind = false;
    let subscription = holder.subscription;
    while (dir !== holder.watchDir) {
      if (unwatchable.has(dir)) blind = true;
      else {
        try {
          subscription = subscribe(path, dir, dir === own);
          if (!subscription.trusted) blind = true;
          break;
        } catch (error) {
          if (!isMissing(error)) {
            watchFailed(dir, error);
            blind = true;
          }
        }
      }
      const parent = dirname(dir);
      if (parent === dir) {
        dir = null;
        subscription = null;
        blind = true;
        break;
      }
      dir = parent;
    }
    if (blind !== (holder.blind === true)) notifyWatch(path, !blind);
    holder.blind = blind;
    if (dir === holder.watchDir) return false;
    // Released after the new one is held: a directory both use stays watched.
    const previous = holder.subscription;
    holder.watchDir = dir;
    holder.subscription = subscription;
    previous?.close();
    return dir === own;
  };

  const drop = (path) => {
    const entry = entries.get(path);
    if (!entry) return null;
    clearTimeout(entry.timer);
    entries.delete(path);
    entry.subscription?.close();
    checkSettled(path);
    return entry;
  };

  // Re-reads in flight across every entry, and those waiting for a slot.
  let reading = 0;
  const waiting = [];

  // Test seam: path -> resolvers waiting for it to have no re-read due,
  // queued or running.
  const settledWaiters = new Map();
  const checkSettled = (path) => {
    const resolvers = settledWaiters.get(path);
    if (!resolvers) return;
    const entry = entries.get(path);
    if (entry && (entry.timer || entry.loading || entry.queued)) return;
    settledWaiters.delete(path);
    for (const resolve of resolvers) resolve();
  };

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
        if (!current()) {
          checkSettled(path);
          return;
        }
        // A watch that starts only now may have missed a write before it.
        if (attach(path, entry)) entry.again = true;
        // Debounced like any event: a read started at once could still hold
        // the file when this process's next synchronous write renames over it.
        if (entry.again) {
          entry.again = false;
          scheduleReread(path, entry);
        }
        checkSettled(path);
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

  // `holder` carries the subscription the new entry takes over.
  // `error`: a first read failed, and reads throw it until a re-read succeeds.
  const store = (path, holder, value, error = null) => {
    const previous = entries.get(path);
    if (previous) clearTimeout(previous.timer);
    const entry = {
      value,
      error,
      failed: false,
      watchDir: holder.watchDir,
      subscription: holder.subscription,
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
    for (const entry of entries.values()) {
      clearTimeout(entry.timer);
      entry.subscription?.close();
    }
    entries.clear();
    unwatchable.clear();
    waiting.length = 0;
    for (const path of [...settledWaiters.keys()]) checkSettled(path);
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
      const holder = entry ?? { watchDir: null, subscription: null };
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
      const value = store(path, holder, loaded.value).value;
      // A fresh read may replace an entry whose re-read was due.
      checkSettled(path);
      return value;
    },
    /** The cached value (the last one read), or undefined. */
    peek(path) {
      return entries.get(path)?.value;
    },
    /** Test seam: resolves once `path` has no re-read due, queued or running,
     *  the last one's result applied; rejects after `timeoutMs`. That deadline
     *  is also what keeps the process alive meanwhile: the re-read's timer and
     *  the watches are unref'd. */
    _settledForTest(path, timeoutMs = 5_000) {
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`${path} had a re-read pending after ${timeoutMs}ms`)),
          timeoutMs
        );
        const settled = () => {
          clearTimeout(deadline);
          resolve();
        };
        settledWaiters.set(path, [...(settledWaiters.get(path) ?? []), settled]);
        checkSettled(path);
      });
    },
    /** Write-through after this process wrote `path`. The file is read back
     *  (debounced, so the read holds no handle across the writer's next
     *  rename): our own value compares equal and tells nobody, while a write
     *  another writer landed meanwhile is read rather than lost. */
    set(path, value) {
      if (closed) return;
      const holder = entries.get(path) ?? { watchDir: null, subscription: null };
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
