// Background-task reconcile for a worker turn (spawn AND send paths).
//
// A worker turn has to mark its background task terminal from three separate
// windows, and both paths must do it identically:
//
//   1. TERMINAL RESULT — the worker produced its final result. Reconciling
//      here (rather than after the session save) keeps a hung/slow post-result
//      step from stranding the task, and the status card, in `running`. An
//      empty/abnormal finish is a FAILURE, not a completion, so the Lead card
//      renders `error: …` instead of a header-only empty card.
//   2. STREAM STALLED — a mid-stream stall (StreamStalledError / ESTREAMSTALL)
//      throws WITHOUT a terminal result, so the finally net below (gated on
//      _terminalResultValue) is skipped and only the outer task-reject path
//      would notify. Reconciling to `failed` here guarantees the owner (Lead)
//      gets a failure notification instead of a task stuck in `running`.
//   3. FINALLY — safety net for a post-result step (session save) that hung or
//      threw after a terminal result already existed.
//
// Every call is idempotent (the first terminal state wins, so the outer reject
// path cannot double-notify) and absorbs its own errors, so reporting on a
// turn can never break the turn.
import { reconcileBackgroundTask, settleCancelledBackgroundTask } from '../../../runtime/shared/background-tasks.mjs';

function reconcileJobTerminalResult(job, value) {
  if (!job?.taskId) return;
  try {
    reconcileBackgroundTask(
      job.taskId,
      value.error
        ? {
            status: 'failed',
            result: value,
            error: value.error,
            terminalReason: 'agent-empty-final',
          }
        : {
            status: 'completed',
            result: value,
            terminalReason: 'agent-terminal-result',
          }
    );
  } catch {}
}

/** The turn's onTerminalResult hook: close the turn review, record the
 *  completion value on the job, send the early owner preview, and reconcile
 *  the task (window 1 above). */
export function terminalResultHook({ job, turnReview, completionValue, notifyEarly, notifyContext }) {
  return (terminalResult) => {
    turnReview.complete();
    const value = completionValue(terminalResult);
    job._terminalResultValue = value;
    // A cancelled job reports once, as `cancelled`, when its turn settles.
    if (job.status === 'cancelled') return;
    notifyEarly(job, value, notifyContext || {});
    reconcileJobTerminalResult(job, value);
  };
}

/** Watchdog stall that still recovered a partial handoff: the turn never
 *  finished, so the owner is told it FAILED (stalled), with the partial
 *  output it produced before the stop. */
export const WATCHDOG_STOP_ERROR = 'stalled: the progress watchdog stopped the turn';

export function reconcileJobWatchdogPartial(job, value) {
  if (!job?.taskId) return;
  try {
    reconcileBackgroundTask(job.taskId, {
      status: 'failed',
      result: value,
      error: WATCHDOG_STOP_ERROR,
      terminalReason: 'agent-watchdog-partial',
    });
  } catch {}
}

/** The cancelled turn stopped: deliver the owner's single `cancelled`
 *  notification, carrying the output the turn produced before it stopped
 *  (header-only when it produced none). */
export function reconcileJobCancelled(job, value) {
  if (!job?.taskId) return;
  try {
    settleCancelledBackgroundTask(job.taskId, value?.content ? { result: value } : {});
  } catch {}
}

export function reconcileJobStreamStalled(job, error) {
  if (!job?.taskId || job._terminalResultValue !== undefined) return;
  try {
    reconcileBackgroundTask(job.taskId, {
      status: 'failed',
      error,
      terminalReason: 'agent-stream-stalled',
    });
  } catch {}
}

export function reconcileJobFinally(job, finalStatus) {
  if (!job || job._terminalResultValue === undefined) return;
  try {
    reconcileBackgroundTask(job.taskId, {
      status: finalStatus === 'error' ? 'failed' : 'completed',
      result: job._terminalResultValue,
      ...(finalStatus === 'error' && job._terminalResultValue?.error ? { error: job._terminalResultValue.error } : {}),
      terminalReason: 'agent-finally-reconcile',
    });
  } catch {}
}
