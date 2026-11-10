// worker-index/restart-settlement.mjs
// Rows whose turn a process exit or restart ended: this process's active rows
// settled as failed on exit, stale active rows and approval waits settled at
// startup and on later sweeps, and the owner's restart-failure notification
// stamped once queued. Owns the keys of the rows this process marked active.
import { positiveInt } from '../helpers.mjs';
import { workerRowKey } from '../worker-rows.mjs';
import { clearAwaitingUser } from './approval-wait.mjs';
import {
  createRowLiveness,
  isActiveWorkerRow,
  isStaleApprovalWait,
  isUnnotifiedRestartFailure,
  PROCESS_RESTART_FAILURE,
  runtimeDied,
} from './row-liveness.mjs';

export function createRestartSettlement({ store, cfgMod, mgr }) {
  const liveness = createRowLiveness({
    cfgMod,
    isSessionRunning: (sessionId) => mgr.isSessionTurnInFlight?.(sessionId) === true,
  });
  // Rows this process marked active; settled as failed on exit (their turn
  // dies with the process) so a crash of the host never leaves them
  // "running" forever.
  const activeWorkerKeys = new Set();

  /** Track whether the row written under `key` is one this process runs. */
  function trackActiveRow(key, row) {
    if (isActiveWorkerRow(row)) activeWorkerKeys.add(key);
    else activeWorkerKeys.delete(key);
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

  // Startup recovery: stale active rows settle — as failed when another
  // process ran their turn (it is gone, or is the predecessor still shutting
  // down: either way the turn never finished), otherwise to idle — and an
  // approval wait left behind by a runtime that is gone (daemon restart) is
  // cleared. `deadOnly` (later sweeps) settles only rows whose runtime is
  // provably dead, never a live process's quiet turn.
  function recoverStaleWorkerRows({ deadOnly = false } = {}) {
    const now = Date.now();
    const rows = store.readAll();
    const isStale = deadOnly
      ? (row) => isActiveWorkerRow(row) && runtimeDied(row)
      : (row) => liveness.isStaleActive(row, now);
    const staleActive = rows.filter(isStale);
    const staleWaits = rows.some(isStaleApprovalWait);
    if (!staleActive.length && !staleWaits) return false;
    if (staleActive.length) {
      store.write((byKey) => {
        for (const row of staleActive) {
          const key = workerRowKey(row);
          const current = byKey.get(key);
          if (!current || !isStale(current)) continue;
          const ranElsewhere = positiveInt(current.runtimePid) && positiveInt(current.runtimePid) !== process.pid;
          byKey.set(
            key,
            ranElsewhere ? liveness.failedRow(current, now, PROCESS_RESTART_FAILURE) : liveness.idleRow(current, now)
          );
        }
      });
    }
    if (staleWaits) store.update((byKey) => clearAwaitingUser(byKey, isStaleApprovalWait));
    return true;
  }

  /** Rows whose turn a process restart ended and whose owner has not been told
   *  yet — whoever settled the row (this process at startup, or the
   *  predecessor's exit flush). Read-only: the caller enqueues the owner's
   *  notification durably, THEN calls `markRestartNotified`, so a crash in
   *  between retries (the notification's stable id makes the retry exactly-once). */
  function pendingRestartFailures() {
    return store.readAll().filter(isUnnotifiedRestartFailure);
  }

  /** Stamp these rows as told, once their notification is durably queued. */
  function markRestartNotified(rows) {
    const stamp = new Date().toISOString();
    store.write((byKey) => {
      for (const row of rows) {
        const key = workerRowKey(row);
        const current = byKey.get(key);
        if (!current || !isUnnotifiedRestartFailure(current)) continue;
        byKey.set(key, { ...current, restartNotified: stamp });
      }
    });
  }

  return {
    trackActiveRow,
    flushActiveWorkerRows,
    recoverStaleWorkerRows,
    pendingRestartFailures,
    markRestartNotified,
  };
}
