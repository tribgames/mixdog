// worker-index/row-store.mjs
// The on-disk worker index file: an mtime-keyed parse cache in front of it and
// the single locked writer that republishes rows + tombstones.
import { readFileSync, statSync } from 'node:fs';

import { updateJsonAtomicSync } from '../../../runtime/shared/atomic-file.mjs';
import { normalizeTagTombstones, tagTombstoneKey, workerRowKey } from '../worker-rows.mjs';
import { keepWorkerRow, normalizeWorkerRows } from './row-shape.mjs';

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
  // Mtime-keyed parse cache. A single spawn calls refreshTagsFromSessions /
  // resolveTag / nextTag, which each re-read and re-parse this file; across a
  // parallel fanout that is O(spawns^2) synchronous reads of the same bytes.
  let cache = null; // { mtimeMs, size, rows, tombstones }
  let dirty = true;

  function readAll() {
    if (!file) return [];
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
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      rows = normalizeWorkerRows(parsed);
      tombstones = normalizeTagTombstones(parsed);
    } catch {
      rows = [];
      tombstones = [];
    }
    cache = { mtimeMs: st.mtimeMs, size: st.size, rows, tombstones };
    dirty = false;
    return rows;
  }

  function readTombstones() {
    readAll();
    return cache?.tombstones || [];
  }

  // Single writer path: every mutation re-reads under the file lock, applies
  // the caller's mutator over keyed maps, then republishes rows + tombstones.
  function write(mutator) {
    if (!file || typeof mutator !== 'function') return null;
    try {
      const result = updateJsonAtomicSync(file, (cur) => rewriteIndexDocument(cur, mutator), { lock: true });
      // This process just rewrote the index; force the next read to re-parse
      // even if the new mtime/size happen to collide with the cached stat.
      dirty = true;
      return result;
    } catch {
      return null;
    }
  }

  return {
    readAll,
    readTombstones,
    write,
    invalidate: () => {
      dirty = true;
    },
  };
}
