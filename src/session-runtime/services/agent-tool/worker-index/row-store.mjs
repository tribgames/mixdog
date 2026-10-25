// worker-index/row-store.mjs
// The on-disk worker index file: an mtime-keyed parse cache in front of it and
// the single in-process writer queue that republishes rows + tombstones. Every
// worker index of a process over one file shares one store (acquireWorkerRowStore),
// so all of them serialize through the same projection and queue.
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { createIndexWriteQueue } from '../index-write-queue.mjs';
import { normalizeTagTombstones, tagTombstoneKey, workerRowKey } from '../worker-rows.mjs';
import { RELEASED_FILE, createReleasedStore } from './released-store.mjs';
import { settleAwaitingUser } from './approval-wait.mjs';
import { keepWorkerRow, normalizeWorkerRows } from './row-shape.mjs';

const ROWS_ARG = 0; // the rows Map's position in the rewrite mutator's arguments
const sharedStores = new Map(); // canonical file -> { store, refs }

const canonicalFile = (file) => (process.platform === 'win32' ? resolve(file).toLowerCase() : resolve(file));

/** A whole-row write never decides `awaitingUser`: every row it changed keeps
 *  the flag the row held before (never a stale copy's), dropped once settled. */
function keepingAwaitingUser(mutator) {
  return (byKey, ...rest) => {
    const before = new Map(byKey);
    mutator(byKey, ...rest);
    for (const [key, row] of byKey) {
      const prior = before.get(key);
      if (row === prior) continue;
      const settled = settleAwaitingUser(row, prior?.awaitingUser);
      if (settled !== row) byKey.set(key, settled);
    }
  };
}

/** One rewrite: the current document as keyed maps, the caller's mutator over
 *  them, then the v2 document to publish. */
function rewriteIndexDocument(cur, mutator) {
  const byKey = new Map();
  for (const row of normalizeWorkerRows(cur)) {
    const key = workerRowKey(row);
    if (key) byKey.set(key, row);
  }
  const tombstonesByKey = new Map();
  for (const row of normalizeTagTombstones(cur, { cap: false })) {
    tombstonesByKey.set(tagTombstoneKey(row), row);
  }
  const priorityTombstoneKeys = new Set();
  mutator(byKey, tombstonesByKey, priorityTombstoneKeys);
  const workers = {};
  for (const row of [...byKey.values()].filter(keepWorkerRow)) {
    const key = workerRowKey(row);
    if (key) workers[key] = row;
  }
  const tombstones = {};
  for (const row of normalizeTagTombstones(
    { tombstones: [...tombstonesByKey.values()] },
    { priorityKeys: priorityTombstoneKeys }
  )) {
    tombstones[tagTombstoneKey(row)] = row;
  }
  return { version: 2, updatedAt: new Date().toISOString(), workers, tombstones };
}

/** `file` may be null (no data dir): reads are empty and writes are no-ops. */
export function createWorkerRowStore(file) {
  // The release markers live in their own file beside the index, so a writer
  // that rebuilds the index document never drops them.
  const released = createReleasedStore(file ? join(dirname(file), RELEASED_FILE) : null);
  // Mtime-keyed parse cache. A single spawn calls refreshTagsFromSessions /
  // resolveTag / nextTag, which each re-read and re-parse this file; across a
  // parallel fanout that is O(spawns^2) synchronous reads of the same bytes.
  let cache = null; // { mtimeMs, size, parsed, rows, tombstones }
  let dirty = true;
  // Unpersisted writes: reads are served from the queue's projection so a
  // caller sees its own write before the async persist lands.
  let projected = null; // { version, rows, tombstones }

  const queue = createIndexWriteQueue({
    file,
    rewrite: rewriteIndexDocument,
    // A fresh disk read: the cache stat can collide with another process's write.
    readDoc: () => {
      dirty = true;
      readAll();
      return cache?.parsed ?? null;
    },
    // The file changed: force the next read to re-parse even if the new
    // mtime/size happen to collide with the cached stat.
    onPersisted: () => {
      dirty = true;
    },
    // The same rule against the locked document: a replayed row keeps the
    // flag that is on disk now, not the one the projection held.
    mergeSet: (index, prev, next) => (index === ROWS_ARG ? settleAwaitingUser(next, prev?.awaitingUser) : next),
  });

  function projectedView() {
    const doc = queue.projection();
    if (!doc) return null;
    if (!projected || projected.version !== queue.version()) {
      projected = { version: queue.version(), rows: normalizeWorkerRows(doc), tombstones: normalizeTagTombstones(doc) };
    }
    return projected;
  }

  function readAll() {
    if (!file) return [];
    const view = projectedView();
    if (view) return view.rows;
    let st = null;
    try {
      st = statSync(file);
    } catch {
      cache = null;
      return [];
    }
    if (!dirty && cache && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.rows;
    let rows = [];
    let tombstones = [];
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
      rows = normalizeWorkerRows(parsed);
      tombstones = normalizeTagTombstones(parsed);
    } catch {
      parsed = null;
      rows = [];
      tombstones = [];
    }
    cache = { mtimeMs: st.mtimeMs, size: st.size, parsed, rows, tombstones };
    dirty = false;
    return rows;
  }

  // Rows and tombstones must come from the same read/projection. In
  // particular, do not stat and reload the file between the two collections.
  function readSnapshot() {
    const rows = readAll();
    return { rows, tombstones: (projectedView() || cache)?.tombstones || [] };
  }

  function readTombstones() {
    return readSnapshot().tombstones;
  }

  // Single writer path: the mutator runs now over keyed maps against the
  // in-process projection (see index-write-queue.mjs); its effect is
  // republished as rows + tombstones by one async locked writer.
  const write = (mutator) => queue.write(typeof mutator === 'function' ? keepingAwaitingUser(mutator) : mutator);

  return {
    readAll,
    readSnapshot,
    readTombstones,
    isReleased: released.isReleased,
    markReleased: released.mark,
    clearReleased: released.clear,
    write,
    /** Conditional field update: `mutator` runs now on the projection and again
     *  on the locked document when persisted, so its condition is re-checked
     *  against what is on disk. The one writer of `awaitingUser`. */
    update: (mutator) => queue.write(mutator, { rerun: true }),
    /** Resolves once every write so far is on disk. */
    flush: async () => {
      await Promise.all([queue.flush(), released.flush()]);
    },
    /** Exit path: persist what is still queued, synchronously. */
    flushSync: () => {
      const flushed = [queue.flushSync(), released.flushSync()];
      return flushed.every(Boolean);
    },
    hasUnpersisted: () => queue.hasUnpersisted() || released.hasUnpersisted(),
    invalidate: () => {
      dirty = true;
      released.invalidate();
    },
  };
}

/** The process's one store for `file` (a fresh no-op store for null), and its
 *  idempotent release; the store is dropped once its last holder releases. */
export function acquireWorkerRowStore(file) {
  if (!file) return { store: createWorkerRowStore(null), release: () => {} };
  const key = canonicalFile(file);
  let entry = sharedStores.get(key);
  if (!entry) {
    entry = { store: createWorkerRowStore(file), refs: 0 };
    sharedStores.set(key, entry);
  }
  entry.refs += 1;
  // A new holder re-reads the file, as a store of its own would.
  entry.store.invalidate();
  let released = false;
  return {
    store: entry.store,
    release: () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      const dropIfIdle = () => {
        if (entry.refs === 0 && !entry.store.hasUnpersisted() && sharedStores.get(key) === entry) {
          sharedStores.delete(key);
        }
      };
      // A store still holding unpersisted writes stays shared (a new holder
      // must see them) until its queue drains.
      if (entry.refs === 0 && entry.store.hasUnpersisted()) entry.store.flush().then(dropIfIdle, () => {});
      else dropIfIdle();
    },
  };
}
