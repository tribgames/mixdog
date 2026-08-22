// Background-task reconcile for a worker turn (spawn AND send paths).
//
// A worker turn has to mark its background task terminal from three separate
// windows, and both paths must do it identically — they used to carry two
// byte-identical copies of every block:
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
import { reconcileBackgroundTask } from '../../runtime/shared/background-tasks.mjs';

export function reconcileJobTerminalResult(job, value) {
  if (!job?.taskId) return;
  try {
    reconcileBackgroundTask(job.taskId, value.error
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
        });
  } catch {}
}

/** Watchdog stall that still recovered a partial handoff: a completion. */
export function reconcileJobWatchdogPartial(job, value) {
  if (!job?.taskId) return;
  try {
    reconcileBackgroundTask(job.taskId, {
      status: 'completed',
      result: value,
      terminalReason: 'agent-watchdog-partial',
    });
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
      ...(finalStatus === 'error' && job._terminalResultValue?.error
        ? { error: job._terminalResultValue.error }
        : {}),
      terminalReason: 'agent-finally-reconcile',
    });
  } catch {}
}
