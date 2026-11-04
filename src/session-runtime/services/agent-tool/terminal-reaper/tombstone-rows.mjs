// The one way the reaper removes worker rows in bulk: every row of `rows`
// (and any other row of the same session) leaves the index in a single write,
// and each leaves a tag tombstone so a later session scan cannot re-bind the
// reaped tag.
import { clean, positiveInt } from '../helpers.mjs';
import { insertTombstone } from './row-helpers.mjs';

/** The mutator body of a removal: drops every row of the reaped sessions and
 *  leaves each a tombstone. */
export function applyTombstones({ tagMaps }, rows, byKey, tombstonesByKey, priorityTombstoneKeys) {
  const nowIso = new Date().toISOString();
  const reapedIds = new Set(rows.map((row) => clean(row.sessionId)));
  for (const [key, candidate] of byKey) {
    if (reapedIds.has(clean(candidate.sessionId))) byKey.delete(key);
  }
  for (const row of rows) {
    const sessionId = clean(row.sessionId);
    const tombstone = {
      tag: clean(row.tag),
      agent: clean(row.agent) || null,
      cwd: clean(row.cwd) || null,
      clientHostPid: positiveInt(row.clientHostPid),
      sessionId,
      parentSessionId: clean(row.parentSessionId) || null,
      ownerSessionId: clean(row.ownerSessionId) || null,
      reapedAt: nowIso,
    };
    insertTombstone(tombstonesByKey, priorityTombstoneKeys, tombstone);
    tagMaps.unbindIfOwned(tombstone.tag, sessionId);
  }
}

/** Tombstones and removes `rows` from the worker index in one write; false when `rows` is empty. */
export function tombstoneRows({ index, tagMaps }, rows) {
  if (rows.length === 0) return false;
  index.flushWorkerIndexMutations();
  index.writeWorkerRows((byKey, tombstonesByKey, priorityTombstoneKeys) =>
    applyTombstones({ tagMaps }, rows, byKey, tombstonesByKey, priorityTombstoneKeys)
  );
  return true;
}