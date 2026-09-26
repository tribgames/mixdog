/**
 * src/tui/session/shared-dir-watch.mjs - one fs.watch handle per directory for
 * the whole process, shared by every subscriber and reference-counted.
 *
 * Every session runtime watches the data directory for the pending spool. On
 * Windows libuv resolves each directory-watch notification's long path
 * (GetLongPathNameW: NtOpenFile / NtQueryDirectoryFileEx / NtClose) on the loop
 * thread once PER HANDLE, so N sessions with N handles on the busiest
 * directory turned each spool write into N synchronous path lookups and
 * produced 100-800 ms event-loop stalls. One shared handle does that work once
 * and fans the (event, filename) pair out to each subscriber, which keeps its
 * own filtering. The last release closes the handle.
 */
import { watch as fsWatch } from 'node:fs';
import { resolve } from 'node:path';

export function createSharedDirWatch(watchImpl = fsWatch) {
  const entries = new Map();

  function closeEntry(key, entry) {
    if (entries.get(key) === entry) entries.delete(key);
    try {
      entry.watcher.close();
    } catch {
      /* already closed */
    }
  }

  function openEntry(key) {
    const subscribers = new Set();
    const watcher = watchImpl(key, { persistent: false }, (event, filename) => {
      for (const subscriber of [...subscribers]) {
        try {
          subscriber.listener(event, filename);
        } catch {
          /* one subscriber must not starve the others */
        }
      }
    });
    const entry = { watcher, subscribers };
    // An erroring handle is dropped exactly like the old per-session watcher:
    // its subscribers fall back to their poll tick; a later subscribe reopens.
    watcher.on?.('error', () => closeEntry(key, entry));
    entries.set(key, entry);
    return entry;
  }

  /**
   * Subscribe `listener(event, filename)` to `dir`. Throws like fs.watch when
   * the directory cannot be watched. Returns an idempotent release function.
   */
  function subscribe(dir, listener) {
    const key = resolve(dir);
    const entry = entries.get(key) || openEntry(key);
    const subscriber = { listener };
    entry.subscribers.add(subscriber);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.subscribers.delete(subscriber);
      if (entry.subscribers.size === 0) closeEntry(key, entry);
    };
  }

  return { subscribe, watchedCount: () => entries.size };
}

export const sharedDirWatch = createSharedDirWatch();
