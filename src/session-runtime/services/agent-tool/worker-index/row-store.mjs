// worker-index/row-store.mjs
// The on-disk worker index file: a watched parse cache in front of it and the
// single in-process writer queue that republishes rows + tombstones. Every
// worker index of a process over one file shares one store (acquireWorkerRowStore),
// so all of them serialize through the same projection and queue.
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { createWatchedFileCache } from '../../../../runtime/shared/watched-file-cache.mjs';
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

const EMPTY_DOC = Object.freeze({ parsed: null, rows: [], tombstones: [] });

// Cold read of the index. A read that fails (a sharing violation, EPERM)
// throws: it says nothing about these bytes. Bytes that do not parse read as
// empty until the file changes.
function loadIndexDoc(path) {
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return { value: EMPTY_DOC };
    throw error;
  }
  return { value: parseIndexDoc(text) };
}

/** loadIndexDoc off the loop; null when the file could not be read. */
async function loadIndexDocAsync(path) {
  let text = '';
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (error) {
    return ABSENT_CODES.has(error?.code) ? { value: EMPTY_DOC } : null;
  }
  return { value: parseIndexDoc(text) };
}

const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
const docOf = (parsed) => ({ parsed, rows: normalizeWorkerRows(parsed), tombstones: normalizeTagTombstones(parsed) });

function parseIndexDoc(text) {
  try {
    return docOf(JSON.parse(text));
  } catch {
    return EMPTY_DOC;
  }
}

/** `file` may be null (no data dir): reads are empty and writes are no-ops. */
export function createWorkerRowStore(file) {
  // The release markers live in their own file beside the index, so a writer
  // that rebuilds the index document never drops them.
  const released = createReleasedStore(file ? join(dirname(file), RELEASED_FILE) : null);
  // Every Lead's agent-status pulse (every 2 s) and each spawn's tag
  // resolution read this file, and none of them waits on it: reads serve
  // `current`, the document as this process last read it — or, once its own
  // write landed, the document that write put there. Every watch event on the file (whoever
  // wrote it) has the watched cache re-read it off the loop, debounced; the
  // old document is served until a differing one lands. The disk is read
  // synchronously only when nothing was read yet (a store's first holder, at
  // construction) or a caller asks for it fresh (a new holder, the base of a
  // write).
  // `onChange` (`changeListeners`): every write, and every re-read whose
  // document differs from the one served.
  const changeListeners = new Set();
  const emitChange = () => {
    for (const listener of [...changeListeners]) {
      try {
        listener();
      } catch {
        /* observers never affect the store */
      }
    }
  };
  let current = null; // { parsed, rows, tombstones }
  let syncRead = false;
  let dirty = true;
  const docs = file
    ? createWatchedFileCache(
        {
          load(path) {
            // Off a sync read the cache takes `current` back: changes are read
            // by its re-read, never inside the read that stores a write.
            if (current && !syncRead) return { value: current };
            const loaded = loadIndexDoc(path);
            current = loaded.value;
            return loaded;
          },
          async loadAsync(path) {
            const loaded = await loadIndexDocAsync(path);
            if (!loaded) throw new Error('worker index unreadable');
            return loaded;
          },
        },
        {
          // A re-read whose document differs (a failed one keeps the last
          // good document; the next event reads again). The cache discards a
          // re-read that started before a newer document was stored.
          onChange: () => {
            const next = docs.peek(file);
            if (!next || next === current) return;
            current = next;
            emitChange();
          },
        }
      )
    : null;
  // Unpersisted writes: reads are served from the queue's projection so a
  // caller sees its own write before the async persist lands.
  let projected = null; // { version, rows, tombstones }

  const queue = createIndexWriteQueue({
    file,
    rewrite: rewriteIndexDocument,
    // A fresh disk read: another process's write may not have been noticed yet.
    readDoc: () => {
      dirty = true;
      return diskDoc().parsed;
    },
    // This process's write landed: `doc` (written under the lock, other
    // processes' rows merged in) is what the file holds, stored at once so
    // the write never reads as undone. Storing it supersedes any re-read
    // already in flight (those bytes may predate the write). The file is read
    // back on the write's own watch event, as after any change — not at once:
    // a read still open when this process's next write renames over the file
    // fails that rename on Windows (EPERM), and a synchronous flush retrying
    // it holds the loop the read needs to finish.
    onPersisted: (doc) => {
      if (!doc || !docs) return;
      const changed = JSON.stringify(doc) !== JSON.stringify(current?.parsed);
      if (changed) current = docOf(doc);
      try {
        docs.get(file, { fresh: true }); // the loader hands `current` over
      } catch {
        /* the next read stores it */
      }
      if (changed) emitChange();
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

  // The document on disk as this process knows it: `{ parsed, rows, tombstones }`.
  function diskDoc() {
    if (!docs) return EMPTY_DOC;
    if (current && !dirty) return current;
    dirty = false;
    syncRead = true;
    try {
      return docs.get(file, { fresh: true });
    } catch {
      // The read failed: the last good document stands (empty before one);
      // the next watch event re-reads the file, and a store that never read
      // it tries again on its next read.
      return current ?? EMPTY_DOC;
    } finally {
      syncRead = false;
    }
  }

  // Rows and tombstones must come from the same read/projection.
  function readSnapshot() {
    const view = projectedView() || diskDoc();
    return { rows: view.rows, tombstones: view.tombstones };
  }

  function readAll() {
    return readSnapshot().rows;
  }

  function readTombstones() {
    return readSnapshot().tombstones;
  }

  // Single writer path: the mutator runs now over keyed maps against the
  // in-process projection (see index-write-queue.mjs); its effect is
  // republished as rows + tombstones by one async locked writer.
  const write = (mutator) => {
    const next = queue.write(typeof mutator === 'function' ? keepingAwaitingUser(mutator) : mutator);
    if (next) emitChange();
    return next;
  };

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
    update: (mutator) => {
      const next = queue.write(mutator, { rerun: true });
      if (next) emitChange();
      return next;
    },
    /** `listener()` runs when the rows may have changed; returns the unsubscribe. */
    onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
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
    /** Last holder gone: the directory watch closes. */
    close: () => docs?.close(),
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
          entry.store.close();
        }
      };
      // A store still holding unpersisted writes stays shared (a new holder
      // must see them) until its queue drains.
      if (entry.refs === 0 && entry.store.hasUnpersisted()) entry.store.flush().then(dropIfIdle, () => {});
      else dropIfIdle();
    },
  };
}
