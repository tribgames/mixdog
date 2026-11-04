// Rows of sessions that are gone, for every owner. The scoped sweep
// (stale-rows.mjs) only reaches the owners a status scope of this process
// reads; a row whose owner never comes back would stay forever. Here a row
// leaves the index (tombstoned, as the scoped sweep does) only when ALL of
// these hold:
//   - its session file is absent,
//   - its status is terminal,
//   - it is past the settled retention,
//   - it is not a restart failure its owner is still owed.
// A session in use in this process also keeps its row.
//
// "Absent" is decided where the row is removed, not from the directory
// listing that found the candidates, and the decision is FENCED up to the
// commit. The removal is a conditional update that runs again on the document
// it is persisted against (under the index lock). There, for every row, it
// takes the session store's writer exclusion (a try-lock on the session's
// writer claim, see excludeSessionWriters), checks that the record is absent,
// and KEEPS the exclusion until the index file holding the removal has been
// replaced. Admission to any save of that session takes the same claim first,
// so no process can save it in between: a save that arrives meanwhile is
// refused as for a session held elsewhere, and one that came earlier either
// holds the claim (the row stays) or wrote the record (the row stays). Once
// the removal is on disk the exclusion goes, and a later save finds a session
// without a worker row, as for any other session no agent turn has indexed.
//
// Lock order: the persist holds the index lock and only TRIES the writers'
// claims (never waits), so it cannot close a cycle with a writer that holds a
// claim and waits for the index lock.
import { copyFileSync, constants, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { sessionRecordPath, storeRecordDir } from '../../../../runtime/agent/orchestrator/session/store/session-paths.mjs';
import { excludeSessionWriters } from '../../../../runtime/agent/orchestrator/session/store/session-writer-claim.mjs';
import { daemonOwnerLockHeldHere } from '../../../../standalone/daemon-owner-lock.mjs';
import { clean } from '../helpers.mjs';
import { isUnnotifiedRestartFailure } from '../worker-index/row-liveness.mjs';
import { isLeadPoolAgent } from '../worker-rows.mjs';
import { isTerminalRow, pastSettledRetention, sessionHasLiveWork } from './row-helpers.mjs';
import { applyTombstones } from './tombstone-rows.mjs';

/** Keeps the index as it is before the first removal of rows from it, as
 *  `<index>.pre-prune.bak`; a backup that exists already is the older bytes. A
 *  copy that fails throws, and nothing is removed. */
function backupBeforeFirstRemoval(file) {
  if (!file) return;
  try {
    copyFileSync(file, `${file}.pre-prune.bak`, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOENT') throw error;
  }
}

// Rows whose records are checked and removed per commit: each check is a lock
// cycle (about a millisecond), and the persisted removal runs them in one
// stretch of the loop.
const REMOVAL_BATCH = 50;

const recordPath = (sessionId) => {
  try {
    return sessionRecordPath(sessionId);
  } catch {
    return null; // not a session id of this store: never judged gone
  }
};

/** The exclusions one persisted removal holds until its index file has landed
 *  (or the sweep gives up on it). */
function createFence() {
  const holds = [];
  return {
    closed: false,
    /** Excludes the writers of `sessionId` and reports whether its record is
     *  absent; the exclusion stays held when it is (the row is going). */
    absent(sessionId) {
      const path = recordPath(sessionId);
      if (!path) return false;
      const hold = excludeSessionWriters(sessionId);
      if (!hold) return false;
      if (existsSync(path)) {
        hold.release();
        return false;
      }
      holds.push(hold);
      return true;
    },
    release() {
      for (const hold of holds.splice(0)) hold.release();
    },
    close() {
      this.closed = true;
      this.release();
    },
  };
}

// Only the daemon that owns the data dir prunes. Another process on it (the
// `--plain` REPL) has no way to learn that a creator of this daemon is waiting
// on a removal's exclusion, so it never takes one: the in-process wake is all
// the fence needs. `ownsDataDir` is the owner-lock state of this process.
export function createGoneRowSweep({ cfgMod, mgr, tagMaps, index, ownsDataDir = daemonOwnerLockHeldHere }) {
  let sweeping = null;

  /** Whether `row` is settled for good as far as its own fields and this
   *  process say: terminal, past retention, not owed, no live work. */
  function settled(row, now, getConfig) {
    return (
      !isLeadPoolAgent(row.agent) &&
      isTerminalRow(row) &&
      !isUnnotifiedRestartFailure(row) &&
      pastSettledRetention(getConfig, row, now) &&
      !sessionHasLiveWork(mgr, clean(row.sessionId))
    );
  }

  const configOnce = () => {
    let config;
    return () => (config ??= cfgMod.loadConfig());
  };

  /** The conditional removal of `candidates` (session ids). Its first run is
   *  this process's view: a row whose record is not there leaves it. Every run
   *  after that is the persist, against the file: each row still settled
   *  there, with its record absent under the writers' exclusion, is
   *  tombstoned, and the exclusions are held in `fence`. `onRemoved(n)` hears
   *  every run; the last is the persist's. A removal the sweep has closed does nothing, so a retried
   *  persist never removes rows unfenced. */
  function removal(candidates, fence, onRemoved) {
    let view = true;
    return (byKey, tombstonesByKey, priorityTombstoneKeys) => {
      const projection = view;
      view = false;
      if (fence.closed) return;
      fence.release(); // an earlier attempt of this persist
      const now = Date.now();
      const getConfig = configOnce();
      const absent = projection
        ? (sessionId) => {
            const path = recordPath(sessionId);
            return path !== null && !existsSync(path);
          }
        : (sessionId) => fence.absent(sessionId);
      const gone = [...byKey.values()].filter(
        (row) => candidates.has(clean(row.sessionId)) && settled(row, now, getConfig) && absent(clean(row.sessionId))
      );
      if (gone.length > 0) applyTombstones({ tagMaps }, gone, byKey, tombstonesByKey, priorityTombstoneKeys);
      onRemoved(gone.length);
    };
  }

  async function sweep() {
    if (!ownsDataDir()) return 0;
    const getConfig = configOnce();
    const settledRows = () => index.readAllWorkerRows().filter((row) => settled(row, Date.now(), getConfig));
    if (settledRows().length === 0) return 0;
    // One listing of the session store finds the candidates. A store that
    // cannot be listed says nothing about its sessions: nothing is removed.
    let present;
    try {
      present = new Set(await readdir(storeRecordDir()));
    } catch {
      return 0;
    }
    const candidates = new Set(
      settledRows()
        .filter((row) => !present.has(`${clean(row.sessionId)}.json`))
        .map((row) => clean(row.sessionId))
    );
    if (candidates.size === 0) return 0;
    // The removal is only made with the old bytes saved.
    backupBeforeFirstRemoval(index.workerIndexPath());
    index.flushWorkerIndexMutations();
    // A batch at a time, each on disk before the next.
    const ids = [...candidates];
    let removed = 0;
    for (let at = 0; at < ids.length; at += REMOVAL_BATCH) {
      const fence = createFence();
      let count = null;
      try {
        index.updateWorkerRows(
          removal(new Set(ids.slice(at, at + REMOVAL_BATCH)), fence, (n) => {
            count = n; // the last run is the persist: what the file lost
          })
        );
        // The exclusions are held until this batch's index file has landed.
        await index.flushWorkerIndexWrites();
        removed += count ?? 0;
      } finally {
        fence.close();
      }
    }
    return removed;
  }

  /** Removes the gone, settled rows of every owner; resolves to how many. A sweep
   *  already running answers for a caller that arrives meanwhile. */
  function sweepGoneRows() {
    sweeping ??= sweep().finally(() => {
      sweeping = null;
    });
    return sweeping;
  }

  /** A session was deleted: its terminal rows go with it, as a tombstone each.
   *  Queued onto the index's batch, so deleting many sessions at once is one write. */
  function forgetDeletedSession(sessionId) {
    const id = clean(sessionId);
    if (!id) return false;
    const owned = (row) => clean(row.sessionId) === id && isTerminalRow(row) && !isUnnotifiedRestartFailure(row);
    const rows = index.readAllWorkerRows().filter((row) => !isLeadPoolAgent(row.agent) && owned(row));
    if (rows.length === 0) return false;
    backupBeforeFirstRemoval(index.workerIndexPath());
    return index.queueWorkerIndexMutation((byKey, tombstonesByKey, priorityTombstoneKeys) => {
      const current = [...byKey.values()].filter(owned);
      if (current.length > 0) applyTombstones({ tagMaps }, current, byKey, tombstonesByKey, priorityTombstoneKeys);
    });
  }

  return { sweepGoneRows, forgetDeletedSession };
}
