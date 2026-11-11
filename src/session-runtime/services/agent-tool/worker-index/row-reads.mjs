// worker-index/row-reads.mjs
// Scoped reads of the worker rows and tag tombstones: a row a tombstone still
// blocks never reads as work, and a legacy tombstone without an owner takes
// the one its session resolves to (resolved off the read, see below).
import { callerSessionForContext, clean, rowMatchesContext, terminalPidForContext } from '../helpers.mjs';
import { recoverTagTombstoneOwner } from '../worker-rows.mjs';
import {
  findTagTombstone,
  tagTombstoneKey,
  tombstoneBlocksWork,
} from '../../../../runtime/shared/agent-reap-state.mjs';

// The fields rowMatchesContext reads off a context.
const contextKey = (context) => `${callerSessionForContext(context) || ''}\0${terminalPidForContext(context) || ''}`;

const SCOPED_VIEWS_MAX = 256;

// Test seam: `onRowWork(n)` hears every n rows or tombstones a read projects.
let onRowWork = null;
export function _setRowWorkCounterForTest(listener) {
  onRowWork = typeof listener === 'function' ? listener : null;
}

export function createWorkerRowReads(store, mgr) {
  // Every projection below is a pure function of the store's parsed arrays
  // (whose identity changes exactly when the store's document does: a write,
  // or a re-read of a changed file) and of the owners resolved so far
  // (`version`), so a read of an unchanged index does no per-row work.
  let tombstoneView = null; // { saved, version, tombstones, unresolved, byKey }
  let rowView = null; // { rows, byKey, scoped: context key -> admitted rows }

  function tombstonesOf(saved) {
    if (tombstoneView?.saved !== saved || tombstoneView.version !== version) {
      const { rows: tombstones, unresolved } = recoverTombstoneOwners(saved);
      tombstoneView = { saved, version, tombstones, unresolved, byKey: null };
    } else if (tombstoneView.unresolved) {
      queueResolution();
    }
    return tombstoneView;
  }

  function tombstoneIndexOf(view) {
    if (!view.byKey) {
      onRowWork?.(view.tombstones.length);
      view.byKey = new Map();
      for (const row of view.tombstones) view.byKey.set(tagTombstoneKey(row), row);
    }
    return view.byKey;
  }

  function readWorkerRows(context = {}) {
    const { rows, tombstones: savedTombstones } = store.readSnapshot();
    if (rows.length === 0) return rows;
    const byKey = tombstoneIndexOf(tombstonesOf(savedTombstones));
    if (rowView?.rows !== rows || rowView.byKey !== byKey) rowView = { rows, byKey, scoped: new Map() };
    const key = contextKey(context);
    let admitted = rowView.scoped.get(key);
    if (!admitted) {
      // An index nothing writes to still meets new scopes; their lists are cheap to rebuild.
      if (rowView.scoped.size >= SCOPED_VIEWS_MAX) rowView.scoped.clear();
      onRowWork?.(rows.length);
      admitted = rows.filter(
        (row) => rowMatchesContext(row, context) && !tombstoneBlocksWork(row, findTagTombstone(row, byKey))
      );
      rowView.scoped.set(key, admitted);
    }
    return admitted;
  }

  function readAllTagTombstones() {
    return tombstonesOf(store.readTombstones()).tombstones;
  }

  /** The tombstones keyed by tagTombstoneKey; shared and read-only. */
  function readTagTombstoneIndex() {
    return tombstoneIndexOf(tombstonesOf(store.readTombstones()));
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
  let queued = null;
  let stopped = false;

  const isLegacy = (row) => !clean(row.parentSessionId || row.ownerSessionId);
  const identityOf = (row) => `${tagTombstoneKey(row)}\0${String(row.reapedAt ?? '')}\0${clean(row.sessionId)}`;

  // Runs once per stored tombstone array and resolution (tombstonesOf).
  function recoverTombstoneOwners(rows) {
    onRowWork?.(rows.length);
    if (!rows.some(isLegacy)) return { rows, unresolved: false };
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
    if (unresolved) queueResolution();
    return { rows: result, unresolved };
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
    readTagTombstoneIndex,
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
