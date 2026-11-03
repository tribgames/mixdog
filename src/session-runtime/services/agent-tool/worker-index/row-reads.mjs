// worker-index/row-reads.mjs
// Scoped reads of the worker rows and tag tombstones: a row a tombstone still
// blocks never reads as work, and a legacy tombstone without an owner takes
// the one its session resolves to (resolved off the read, see below).
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

  // A legacy (owner-less) tombstone takes the owner the session catalog
  // resolves it to. Listing the catalog scans every session summary, so no
  // read does it: a read applies the owners resolved so far (`owners`, per
  // tombstone, kept across index changes — a legacy tombstone only matches
  // sessions created before its reap, so later sessions cannot change its
  // answer) and leaves a tombstone not resolved yet as stored, blocking its
  // tag for the whole terminal. Its resolution runs on the next turn and is
  // announced (onOwnersResolved); a tool call resolves first
  // (resolveTombstoneOwners) and so reads every owner.
  const owners = new Map(); // tombstone identity -> recovered owner fields, or null (none)
  const listeners = new Set();
  let version = 0; // bumped by every resolution
  const recovered = new WeakMap(); // tombstone array -> { version, rows }
  let queued = null;
  let stopped = false;

  const isLegacy = (row) => !clean(row.parentSessionId || row.ownerSessionId);
  const identityOf = (row) => `${tagTombstoneKey(row)}\0${String(row.reapedAt ?? '')}\0${clean(row.sessionId)}`;

  function recoverTombstoneOwners(rows) {
    if (!rows.some(isLegacy)) return rows;
    const known = recovered.get(rows);
    if (known?.version === version) return known.rows;
    let unresolved = false;
    const result = rows.map((row) => {
      if (!isLegacy(row)) return row;
      const id = identityOf(row);
      if (!owners.has(id)) {
        unresolved = true;
        return row;
      }
      const owner = owners.get(id);
      return owner ? { ...row, ...owner } : row;
    });
    recovered.set(rows, { version, rows: result });
    if (unresolved) queueResolution();
    return result;
  }

  /** Resolve the owner of every legacy tombstone not resolved yet (one catalog
   *  listing, none when there is nothing to resolve); announces a found owner. */
  function resolveTombstoneOwners() {
    if (queued) clearImmediate(queued);
    queued = null;
    const legacy = store.readTombstones().filter(isLegacy);
    const unresolved = legacy.filter((row) => !owners.has(identityOf(row)));
    if (unresolved.length === 0) return;
    // Resolve legacy ownership against all sessions, never just the caller's
    // scope: filtering first would conceal an ambiguous sibling owner.
    const sessions = typeof mgr.listSessions === 'function' ? mgr.listSessions({ includeClosed: true }) : [];
    const current = new Set(legacy.map(identityOf));
    for (const id of owners.keys()) if (!current.has(id)) owners.delete(id);
    let found = false;
    for (const row of unresolved) {
      const owner = recoverTagTombstoneOwner(row, sessions);
      const fields =
        owner === row
          ? null
          : { sessionId: owner.sessionId, parentSessionId: owner.parentSessionId, ownerSessionId: owner.ownerSessionId };
      owners.set(identityOf(row), fields);
      if (fields) found = true;
    }
    version += 1;
    if (!found) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* observers never affect the reads */
      }
    }
  }

  function queueResolution() {
    if (queued || stopped) return;
    queued = setImmediate(() => {
      queued = null;
      try {
        resolveTombstoneOwners();
      } catch {
        /* the next read queues it again */
      }
    });
  }

  return {
    readWorkerRows,
    readAllTagTombstones,
    resolveTombstoneOwners,
    /** `listener()` runs when a legacy tombstone's owner was resolved; returns the unsubscribe. */
    onOwnersResolved(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      if (queued) clearImmediate(queued);
      queued = null;
      listeners.clear();
    },
  };
}
