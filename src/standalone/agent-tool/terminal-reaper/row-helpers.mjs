// Row-level predicates shared by the terminal-reaper modules.
import { stampMs } from '../helpers.mjs';
import { isTerminalWorkerStatus, tagTombstoneKey } from '../worker-rows.mjs';

/** Latest proof of life on the session record itself. createdAt is included
 * as the last resort so a brand-new session that has not been stamped yet is
 * never mistaken for the reaped one that used to own its tag. */
export function sessionActivityAt(session) {
  let latest = 0;
  for (const value of [session?.updatedAt, session?.finishedAt, session?.lastUsedAt, session?.createdAt]) {
    const parsed = stampMs(value);
    if (parsed > latest) latest = parsed;
  }
  return latest;
}

export function isTerminalRow(row) {
  return isTerminalWorkerStatus(row.status || row.stage);
}

export function insertTombstone(tombstonesByKey, priorityTombstoneKeys, tombstone) {
  const key = tagTombstoneKey(tombstone);
  tombstonesByKey.set(key, tombstone);
  priorityTombstoneKeys.add(key);
}
