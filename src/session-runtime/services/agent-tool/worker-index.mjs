// Worker-index persistence for the agent tool: the on-disk row store (tag →
// session) and its tag-map projection. agent-tool.mjs owns spawn / dispatch
// flow only. The tag Maps are passed in by reference so the facade and this
// store observe the same live state. The pieces live under ./worker-index/:
//   row-shape      — one row shape; session → row projection
//   row-store      — the file, its parse cache, the locked writer
//   mutation-batch — spawn-path writes coalesced onto one immediate
//   row-liveness   — stale-active detection and idle settlement
import { resolve } from 'node:path';

import { WORKER_INDEX_FILE } from './tool-def.mjs';
import { clean, positiveInt, registerExitFlush, rowMatchesContext } from './helpers.mjs';
import { applyWorkerRowUpsert, recoverTagTombstoneOwner, workerRowKey } from './worker-rows.mjs';
import {
  applyAwaitingUser,
  awaitingUserWouldChange,
  clearAwaitingUser,
  registerApprovalWaitWriter,
} from './worker-index/approval-wait.mjs';
import { createMutationBatch } from './worker-index/mutation-batch.mjs';
import {
  createRowLiveness,
  isActiveWorkerRow,
  isStaleApprovalWait,
  PROCESS_RESTART_FAILURE,
  runtimeDied,
} from './worker-index/row-liveness.mjs';
import { normalizeWorkerRows, workerRowFromSession } from './worker-index/row-shape.mjs';
import { acquireWorkerRowStore } from './worker-index/row-store.mjs';
import { findTagTombstone, tagTombstoneKey, tombstoneBlocksWork } from '../../../runtime/shared/agent-reap-state.mjs';

export function createWorkerIndex({ dataDir, cfgMod, mgr, tags, tagAgents, tagCwds }) {
  const file = dataDir ? resolve(dataDir, WORKER_INDEX_FILE) : null;
  // Shared with every other worker index of this process over the same file.
  const { store, release: releaseStore } = acquireWorkerRowStore(file);
  // Sessions whose deferred rows still wait in the batch; reconciled once the
  // batch lands in the store.
  const unreconciled = new Set();
  const batch = createMutationBatch(store.write, () => {
    const ids = [...unreconciled];
    unreconciled.clear();
    for (const id of ids) reconcileAwaitingUser(id);
  });
  const liveness = createRowLiveness({
    cfgMod,
    isSessionRunning: (sessionId) => mgr.isSessionTurnInFlight?.(sessionId) === true,
  });
  // Rows this process marked active; settled as failed on exit (their turn
  // dies with the process) so a crash of the host never leaves them
  // "running" forever.
  const activeWorkerKeys = new Set();

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

  // Every upsert also projects the row into the in-memory tag maps so tag
  // lookups never wait on a disk round-trip.
  function bindTag(row) {
    tags.set(row.tag, row.sessionId);
    if (row.agent) tagAgents.set(row.tag, row.agent);
    if (row.cwd) tagCwds.set(row.tag, row.cwd);
  }

  function upsertWorkerRow(row, { defer = false } = {}) {
    const normalized = normalizeWorkerRows({ workers: [row] })[0];
    if (!normalized) return false;
    const key = workerRowKey(normalized);
    if (isActiveWorkerRow(normalized)) activeWorkerKeys.add(key);
    else activeWorkerKeys.delete(key);
    bindTag(normalized);
    if (defer) {
      if (!file) return false;
      unreconciled.add(normalized.sessionId);
      return batch.queue((byKey) => applyWorkerRowUpsert(byKey, normalized));
    }
    store.write((byKey) => {
      applyWorkerRowUpsert(byKey, normalized);
    });
    reconcileAwaitingUser(normalized.sessionId);
    return true;
  }

  const rowFromSession = (session, fallbackTag = '', extra = {}) =>
    workerRowFromSession(session, fallbackTag, extra, (sessionId) => mgr.getSessionRuntime?.(sessionId));

  function removeWorkerRow({ tag = '', sessionId = '' } = {}) {
    const targetTag = clean(tag);
    const targetSessionId = clean(sessionId);
    batch.flush();
    store.write((byKey) => {
      for (const [key, row] of [...byKey.entries()]) {
        if ((targetSessionId && row.sessionId === targetSessionId) || (targetTag && row.tag === targetTag)) {
          byKey.delete(key);
        }
      }
    });
  }

  /** Persist (or clear) a worker's approval wait as a field update fenced to
   *  the session and its turn (`turnAt`, ms): a row whose turn started later is
   *  left alone. Writes only when a row of that session exists and would
   *  change, so a Lead's own approvals cost nothing; a row that is not in the
   *  store yet takes the wait when it lands (reconcileAwaitingUser). */
  function setAwaitingUser(sessionId, awaitingUser, { turnAt = 0 } = {}) {
    const fence = {
      sessionId: clean(sessionId),
      awaitingUser: awaitingUser === 'approval' ? 'approval' : null,
      turnAt: Number(turnAt) || 0,
    };
    if (!fence.sessionId || !awaitingUserWouldChange(store.readAll(), fence)) return false;
    store.update((byKey) => applyAwaitingUser(byKey, fence));
    return true;
  }

  /** The runtime of a session this process runs is the authority on its
   *  approval wait (the runtime-liveness counter behind `awaitingUser`): every
   *  row it creates or refreshes takes that state, so a missed or stale
   *  transition heals on the next write. No runtime here: not ours to judge. */
  function reconcileAwaitingUser(sessionId) {
    const runtime = mgr.getSessionRuntime?.(sessionId);
    if (runtime) setAwaitingUser(sessionId, runtime.awaitingUser, { turnAt: runtime.askStartedAt });
  }

  function refreshTagsFromIndex(context = {}) {
    const rows = readWorkerRows(context);
    for (const row of rows) bindTag(row);
    return rows;
  }

  function flushActiveWorkerRows() {
    if (!activeWorkerKeys.size) return;
    const keys = [...activeWorkerKeys];
    activeWorkerKeys.clear();
    const now = Date.now();
    store.write((byKey) => {
      for (const key of keys) {
        const current = byKey.get(key);
        if (!current || positiveInt(current.runtimePid) !== process.pid) continue;
        if (isActiveWorkerRow(current)) {
          byKey.set(key, liveness.failedRow(current, now, PROCESS_RESTART_FAILURE, true));
        }
      }
    });
  }

  // Startup recovery: stale active rows settle — as failed when the process
  // that ran their turn is gone (the turn never finished), otherwise to idle —
  // and an approval wait left behind by a runtime that is gone (daemon
  // restart) is cleared.
  function recoverStaleWorkerRows() {
    const now = Date.now();
    const rows = store.readAll();
    const staleActive = rows.filter((row) => liveness.isStaleActive(row, now));
    const staleWaits = rows.some(isStaleApprovalWait);
    if (!staleActive.length && !staleWaits) return false;
    if (staleActive.length) {
      store.write((byKey) => {
        for (const row of staleActive) {
          const key = workerRowKey(row);
          const current = byKey.get(key);
          if (!current || !liveness.isStaleActive(current, now)) continue;
          byKey.set(
            key,
            runtimeDied(current)
              ? liveness.failedRow(current, now, PROCESS_RESTART_FAILURE)
              : liveness.idleRow(current, now)
          );
        }
      });
    }
    if (staleWaits) store.update((byKey) => clearAwaitingUser(byKey, isStaleApprovalWait));
    return true;
  }

  function flushWorkerIndexOnExit() {
    batch.flush();
    flushActiveWorkerRows();
    // Writes are persisted by an async queue; the loop is gone at exit. This
    // is the best-effort last resort: a persist still running is left alone
    // (the graceful shutdown path drains before exit).
    store.flushSync();
  }

  recoverStaleWorkerRows();
  const unregisterExitFlush = registerExitFlush(flushWorkerIndexOnExit);
  const unregisterApprovalWaits = registerApprovalWaitWriter(file, setAwaitingUser);
  let disposed = false;
  let disposePromise = null;

  function teardown() {
    unregisterExitFlush();
    unregisterApprovalWaits();
    releaseStore();
  }

  async function drainThenTeardown() {
    batch.flush();
    await store.flush();
    teardown();
  }

  /** Persist queued rows, then release the exit registration. Active rows are
   *  NOT settled: they are keyed by process pid, which every inline runtime in
   *  the daemon shares, so settling here would idle other runtimes' workers.
   *  When the sync flush cannot run (this process's async writer holds the
   *  lock) the exit hook and store ref stay until the async drain settles. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    let flushed = false;
    try {
      batch.flush();
      flushed = store.flushSync();
    } catch {}
    if (flushed) {
      teardown();
      return;
    }
    disposePromise = drainThenTeardown().catch(reopenAfterFailedDrain);
  }

  /** A failed drain tears nothing down; allow a later dispose to retry it. */
  function reopenAfterFailedDrain() {
    disposed = false;
    disposePromise = null;
  }

  /** Awaitable dispose: drain everything, then tear down. A failed drain
   *  rejects and leaves the registrations in place. */
  function disposeAsync() {
    if (!disposePromise) {
      disposed = true;
      disposePromise = drainThenTeardown().catch((error) => {
        reopenAfterFailedDrain();
        throw error;
      });
    }
    return disposePromise;
  }

  return {
    dispose,
    disposeAsync,
    workerIndexPath: () => file,
    invalidateWorkerRowsCache: store.invalidate,
    readAllWorkerRows: store.readAll,
    readAllTagTombstones,
    readTagTombstones: (context = {}) => readAllTagTombstones().filter((row) => rowMatchesContext(row, context)),
    readWorkerRows,
    writeWorkerRows: store.write,
    flushWorkerIndexMutations: batch.flush,
    /** Resolves once every queued index write is on disk. */
    flushWorkerIndexWrites: async () => {
      batch.flush();
      await store.flush();
    },
    queueWorkerIndexMutation: (mutator) => (file ? batch.queue(mutator) : false),
    workerRowFromSession: rowFromSession,
    upsertWorkerRow,
    upsertWorkerSession: (session, fallbackTag = '', extra = {}) =>
      upsertWorkerRow(rowFromSession(session, fallbackTag, extra)),
    upsertWorkerSessionDeferred: (session, fallbackTag = '', extra = {}) =>
      upsertWorkerRow(rowFromSession(session, fallbackTag, extra), { defer: true }),
    removeWorkerRow,
    setAwaitingUser,
    refreshTagsFromIndex,
    flushActiveWorkerRows,
    flushWorkerIndexOnExit,
    recoverStaleWorkerRows,
  };
}
