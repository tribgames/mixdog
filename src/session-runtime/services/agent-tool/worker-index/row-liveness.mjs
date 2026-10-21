// worker-index/row-liveness.mjs
// Whether an active-looking row still has a live worker behind it, and how a
// row settles (idle, or failed when its runtime died) when it does not.
import { resolveAgentTerminalReapMs } from '../../../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { clean, positiveInt, runtimeAlive } from '../helpers.mjs';

const ACTIVE_WORKER_STATUS =
  /^(?:connecting|requesting|streaming|tool[-_\s]?running|running|queued|pending|starting|cancelling)$/i;
const WORKER_POOL_FRESH_MS = 2 * 60 * 1000;

const CANCELLED_WORKER_STATUS = /^(?:cancelled|canceled|killed|cancel[-_\s]?(?:unconfirmed|pending))$/i;

/** `status` decides; `stage` is the runtime phase copied in by the progress
 *  sweep and only decides for a row with no status. A cancel in either field
 *  is not work (bare `cancelling` still is). */
export const isActiveWorkerRow = (row) =>
  !CANCELLED_WORKER_STATUS.test(clean(row?.status)) &&
  !CANCELLED_WORKER_STATUS.test(clean(row?.stage)) &&
  ACTIVE_WORKER_STATUS.test(clean(row?.status) || clean(row?.stage));

/** A persisted approval wait whose runtime is gone: the in-memory wait died
 *  with that process (daemon restart), so the flag must not stick. */
export const isStaleApprovalWait = (row) => Boolean(row?.awaitingUser) && !runtimeAlive(row.runtimePid);

/** The process that ran the row's turn is gone (a restart or crash ended it). */
export const runtimeDied = (row) => Boolean(positiveInt(row?.runtimePid)) && !runtimeAlive(row.runtimePid);

/** The row's turn ended because the process running it went away. */
export const PROCESS_RESTART_FAILURE = 'process-restart';

/** The row's turn was stopped by the progress (stall) watchdog. */
export const WATCHDOG_STALL_FAILURE = 'stalled';

/** A failed row whose turn a process restart ended and whose owner has not
 *  been told yet (restart-notify). It is the only record of that owed result,
 *  so closing the worker never drops it. */
export const isUnnotifiedRestartFailure = (row) =>
  row?.status === 'failed' &&
  row.failureReason === PROCESS_RESTART_FAILURE &&
  Boolean(clean(row.ownerSessionId)) &&
  !row.restartNotified;

/** A turn's settled row status and failure reason: a watchdog stop is a
 *  failure whatever partial output it handed back (`finalStatus` may still
 *  read `idle` for the job's sake); a turn the process exit cut off (its `job`
 *  cancelled with terminalReason PROCESS_RESTART_FAILURE, lifecycle/teardown)
 *  fails as a restart failure under its task id, which the next process tells
 *  its owner; everything else keeps `finalStatus`. */
export function settledWorkerStatus(finalStatus, stalled, job = null) {
  if (job?.status === 'cancelled' && job.terminalReason === PROCESS_RESTART_FAILURE) {
    return {
      status: 'failed',
      stage: 'failed',
      failureReason: PROCESS_RESTART_FAILURE,
      ...(job.taskId ? { task_id: job.taskId } : {}),
    };
  }
  return stalled
    ? { status: 'failed', stage: 'failed', failureReason: WATCHDOG_STALL_FAILURE }
    : { status: finalStatus, stage: finalStatus };
}

/** `isSessionRunning(sessionId)`: the daemon's in-memory answer to whether
 *  that session's turn is in flight (every session runs in this process). */
export function createRowLiveness({ cfgMod, isSessionRunning = () => false }) {
  /** Active status, but its runtime pid is dead, or its turn is not running
   *  here and its own update stamp is not fresh either. */
  function isStaleActive(row, now) {
    if (!isActiveWorkerRow(row)) return false;
    if (runtimeDied(row)) return true;
    if (isSessionRunning(clean(row.sessionId))) return false;
    const updated = Date.parse(clean(row.updatedAt)) || 0;
    return !(updated > 0 && now - updated <= WORKER_POOL_FRESH_MS);
  }

  function terminalReapAt(row, now) {
    let reapMs = null;
    try {
      reapMs = resolveAgentTerminalReapMs(cfgMod.loadConfig(), row?.provider);
    } catch {
      reapMs = null;
    }
    return reapMs == null ? null : new Date(now + reapMs).toISOString();
  }

  /** The row settled to idle. `touch` restamps it as finished now (this
   *  process is giving up its own work); otherwise existing stamps win. An
   *  idle worker waits on nobody, so a persisted approval wait drops too. */
  function idleRow(row, now, touch = false) {
    const stamp = new Date(now).toISOString();
    const { awaitingUser: _awaitingUser, ...settled } = row;
    return {
      ...settled,
      status: 'idle',
      stage: 'idle',
      turnStartedAt: null,
      finishedAt: touch ? stamp : clean(row.finishedAt) || clean(row.updatedAt) || stamp,
      updatedAt: touch ? stamp : clean(row.updatedAt) || stamp,
      reapAt: touch ? terminalReapAt(row, now) : clean(row.reapAt) || terminalReapAt(row, now),
    };
  }

  /** The row settled as failed: its turn never finished, and `failureReason`
   *  says why. Stamps settle exactly as idleRow's. */
  function failedRow(row, now, failureReason, touch = false) {
    return { ...idleRow(row, now, touch), status: 'failed', stage: 'failed', failureReason };
  }

  return { isStaleActive, idleRow, failedRow };
}
