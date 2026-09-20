// Auto-background transition of one foreground shell run. Two triggers
// resolve the call immediately with a 'backgrounded' result while the child
// keeps running, promoted in the shell-jobs registry but still owned by this
// CLI process:
//   1. the autoBackgroundMs soft foreground threshold — an EARLIER promotion
//      before the timeout, and
//   2. the foreground timeout deadline (backgroundOnTimeout) — the default
//      promote-on-timeout that replaces the old tree-kill.
// A capped explicit foreground timeout supplies its remaining deadline to the
// promoted job; otherwise background execution remains unlimited. Mutually
// exclusive with settle() via the autoBackgrounded flag set synchronously at
// the top before any await.
//
//   shell-run-background/promote-job.mjs       — registry promotion, lease hand-over, kill fallback
//   shell-run-background/promotion-results.mjs — the ExecResult of each promotion outcome
import { clearForegroundRecord, clearForegroundTimers, elapsedSinceStart } from './shell-run-state.mjs';
import { readCapturedOutput } from './shell-run-settle.mjs';
import { handOverLease, killAfterFailedPromotion, promoteWithRetry } from './shell-run-background/promote-job.mjs';
import {
  promotedSpillPaths,
  resolveBackgrounded,
  resolveCancelledAfterPromotion,
  resolveCleanupFailure,
  resolveCompletedDuringPromotion,
} from './shell-run-background/promotion-results.mjs';

// True when an abort was raised because the user sent a NEW message while the
// command was running (session-api.mjs raises 'interrupt' when steering is
// pending, 'user-cancel' for a plain ESC). The reason travels as the
// SessionClosedError's `reason` field; a bare string / message fallback keeps
// non-session callers working. Anything unrecognized is treated as a real
// cancellation, so the kill path stays the default.
export function _abortReasonIsInterrupt(abortSignal) {
  const raw = abortSignal?.reason;
  if (!raw) return false;
  if (typeof raw === 'string') return raw === 'interrupt';
  if (typeof raw === 'object') {
    if (raw.reason === 'interrupt') return true;
    if (typeof raw.message === 'string' && /\breason=interrupt\b/.test(raw.message)) return true;
  }
  return false;
}

/** The deadline the promoted job inherits from the foreground run, if any. */
function remainingBackgroundTimeout(run, reason, { promotedTimeoutMs, backgroundDeadlineMs }) {
  if (reason === 'timeout') return promotedTimeoutMs;
  if (backgroundDeadlineMs > 0) return Math.max(1, backgroundDeadlineMs - elapsedSinceStart(run));
  return 0;
}

export function createAutoBackground({
  run,
  command,
  cwd,
  clientHostPid,
  ownerSessionId,
  promotedTimeoutMs,
  backgroundDeadlineMs,
}) {
  const { taskOutput, abortSignal } = run;
  const promotion = { run, command, cwd, clientHostPid, ownerSessionId };

  // Named: the cancellation-race regression (scripts/shellhardening) arms its
  // abort from this frame's stack.
  const _autoBackground = async ({ reason = 'threshold' } = {}) => {
    // Win the race: bail if a terminal transition already happened, and
    // claim the transition synchronously so a concurrently-queued settle()
    // (which checks autoBackgrounded) becomes inert.
    if (run.settled || run.autoBackgrounded || run.killed || run.timedOut) return;
    if (run.child.exitCode != null || run.child.signalCode != null) return;
    run.autoBackgrounded = true;
    // The foreground capture is over; stop the local watchdogs/timers so
    // they cannot treeKill the now-promoted child.
    clearForegroundTimers(run);
    // Keep the abort handler ATTACHED through the promotion window. A user
    // cancel racing in after promotion starts must still bring the promoted
    // child down — the handler's treeKill(child) does exactly that (settle()
    // is inert once autoBackgrounded, but the kill itself still lands, and
    // refreshShellJob then flags the job failed). We only detach on a real
    // settle() or on the promotion-failure fallback below.
    // Every subsequent stdout/stderr chunk must hit disk — the call is
    // about to resolve and nobody will drain the in-memory buffers again.
    try {
      taskOutput.forceSpill();
    } catch {}
    // The foreground sizeWatchdog was cleared above; the output cap now
    // travels with the promoted job — the shell-job watcher arms a periodic
    // refreshShellJob tick that enforces SHELL_JOB_OUTPUT_DISK_CAP against the
    // same spill files (stdoutPath/stderrPath below), killing + flagging a
    // runaway background producer even with no active task waiter.
    const stdoutPath = taskOutput.spilled ? taskOutput.stdoutPath : null;
    const stderrPath = taskOutput.spilled ? taskOutput.stderrPath : null;
    // The promoted job publishes its own record under the real task id; drop
    // the foreground marker first so the command is never counted twice.
    clearForegroundRecord(run);
    const remainingBackgroundTimeoutMs = remainingBackgroundTimeout(run, reason, {
      promotedTimeoutMs,
      backgroundDeadlineMs,
    });
    const { job, promotionFailure } = await promoteWithRetry(promotion, {
      remainingBackgroundTimeoutMs,
      stdoutPath,
      stderrPath,
    });
    if (!job) {
      killAfterFailedPromotion(run, reason, promotionFailure);
      return;
    }
    const jobId = job.jobId;
    run.autoBackgroundJobId = jobId;
    await handOverLease(run, jobId);
    // Snapshot the partial output captured so far for the immediate result.
    const { stdout, stderr } = await readCapturedOutput(taskOutput);
    const capture = { stdout, stderr, spill: { ...promotedSpillPaths(taskOutput), stdoutPath } };
    // Re-check after the awaited capture reads: cancellation can race after
    // promotion commits. Never report that cancelled process as a successful
    // still-running background task.
    // EXCEPTION: an interrupt-driven promotion starts FROM an aborted signal
    // by design (the user typed a new message), so this guard must not undo
    // the very transition it was asked to perform. A plain cancellation still
    // reverts promotion and kills.
    if (abortSignal?.aborted && !(reason === 'interrupt' && _abortReasonIsInterrupt(abortSignal))) {
      resolveCancelledAfterPromotion(run, jobId, capture);
      return;
    }
    // Completed-during-promotion race: write the exit/done files here as
    // well — when 'close' fired before the once('close') wiring, nothing
    // else would ever flip the promoted job detail off 'running'.
    if (run.child.exitCode != null || run.child.signalCode != null) {
      resolveCompletedDuringPromotion(run, capture);
      return;
    }
    resolveBackgrounded(run, { jobId, reason, remainingBackgroundTimeoutMs }, capture);
  };

  return (options) => {
    void _autoBackground(options).catch((error) => {
      if (run.isResolved()) return;
      resolveCleanupFailure(run, error);
    });
  };
}
