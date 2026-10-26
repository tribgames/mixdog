// worker-index/row-reads.mjs
// Scoped reads of the worker rows and tag tombstones: a row a tombstone still
// blocks never reads as work, and a legacy tombstone without an owner takes
// the one its session resolves to.
import { clean, rowMatchesContext } from '../helpers.mjs';
import { recoverTagTombstoneOwner } from '../worker-rows.mjs';
import {
  findTagTombstone,
  tagTombstoneKey,
  tombstoneBlocksWork,
} from '../../../../runtime/shared/agent-reap-state.mjs';

export function createWorkerRowReads(store, mgr) {
  function readWorkerRows(context = {}) {
    const { rows, tombstones: savedTombstones } = store.readSnapshot();
    if (rows.length === 0) return rows;
    const tombstones = new Map(recoverTombstoneOwners(savedTombstones).map((row) => [tagTombstoneKey(row), row]));
    return rows.filter(
      (row) => rowMatchesContext(row, context) && !tombstoneBlocksWork(row, findTagTombstone(row, tombstones))
    );
  }

  function readAllTagTombstones() {
    return recoverTombstoneOwners(store.readTombstones());
  }

  function recoverTombstoneOwners(rows) {
    if (!rows.some((row) => !clean(row.parentSessionId || row.ownerSessionId))) return rows;
    const sessions = typeof mgr.listSessions === 'function' ? mgr.listSessions({ includeClosed: true }) : [];
    // Resolve legacy ownership against all sessions, never just the caller's
    // scope: filtering first would conceal an ambiguous sibling owner.
    return rows.map((row) => recoverTagTombstoneOwner(row, sessions));
  }

  return { readWorkerRows, readAllTagTombstones };
}
