/**
 * promote-job.mjs — hand the still-running foreground child to the shell-jobs
 * registry: the bounded promotion attempt, the lease release + background
 * budget registration that follows a successful one, and the kill fallback
 * that follows a failed one.
 */
import { promoteForegroundShellJob } from '../../builtin/shell-jobs.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { backgroundShellPendingNotice, registerBackgroundShellJob } from '../../builtin/shell-background-budget.mjs';
import { treeKillForceSettle } from '../shell-run-state.mjs';

export async function promoteWithRetry(
  { run, command, cwd, clientHostPid, ownerSessionId },
  { remainingBackgroundTimeoutMs, stdoutPath, stderrPath }
) {
  let promotionFailure = '';
  const tryPromote = async () => {
    try {
      const promoted = await promoteForegroundShellJob({
        command,
        cwd,
        pid: run.child.pid,
        jobId: run.foregroundRecordId,
        timeoutMs: remainingBackgroundTimeoutMs,
        // Carry the command's own start moment into the job: promotion time
        // and a standby's process-creation time are both wrong.
        startedAtMs: run.commandStartedAtMs,
        mergeStderr: false,
        stdoutPath,
        stderrPath,
        // Stamp the promoted job with the dispatching terminal's claude.exe
        // pid so the statusline scopes it to the owning session.
        clientHostPid,
        // …and with the dispatching SESSION, so a pooled host (desktop) can
        // show the job on its own pane only.
        ownerSessionId,
      });
      if (!promoted) promotionFailure = promotionFailure || 'promotion unavailable';
      return promoted;
    } catch (err) {
      promotionFailure = err?.message || String(err);
      return null;
    }
  };
  let job = await tryPromote();
  // One bounded retry: a promotion that failed on a transient registry/IPC
  // race heals within a beat, while a capability gap fails identically and
  // falls through to the kill path with its reason attached below.
  if (!job && !run.settled && run.child.exitCode == null && run.child.signalCode == null) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    job = await tryPromote();
  }
  return { job, promotionFailure };
}

/**
 * Adoption failed AFTER the foreground timers/size-watchdog were already
 * torn down. Do NOT resolve as backgrounded — that would leave the child
 * running unlimited with no task_id and no watcher. Release the claim and
 * fall back to the old kill path so the command never outlives a failed
 * promotion. (The abort handler is still attached, so an in-flight cancel
 * is honored by the kill path too.)
 */
export function killAfterFailedPromotion(run, reason, promotionFailure) {
  run.autoBackgrounded = false;
  if (reason === 'timeout') {
    run.timedOut = true;
    treeKillForceSettle(run, 'timeout');
    return;
  }
  // Keep the stable cause tag first (trace classifiers match on it)
  // and attach the captured reason so the next occurrence is
  // diagnosable from the transcript alone.
  treeKillForceSettle(
    run,
    promotionFailure ? `background-promotion-failed (${promotionFailure.slice(0, 120)})` : 'background-promotion-failed'
  );
}

// How long a promotion waits for the slot an in-flight eviction is freeing
// before reporting the job as pending.
const ADMIT_WAIT_AFTER_EVICTION_MS = 2_000;

/**
 * The promoted job leaves foreground admission: it joins the background
 * budget and its lease is RELEASED (a long-lived server must never hold a
 * foreground slot for its whole life). When the hard background cap is full
 * the job stays pending: the budget keeps the lease until a slot frees, and
 * the returned notice tells the model why. Returns null when admitted.
 */
export async function handOverToBackgroundBudget(run, jobId, { command, ownerSessionId, explicitTimeout }) {
  const lease = run.resourceLease;
  run.resourceLease = null;
  const outcome = registerBackgroundShellJob(jobId, { command, ownerSessionId, explicitTimeout, lease });
  if (outcome.admitted) {
    await lease?.release();
    return null;
  }
  // Admitted later, the budget releases the lease itself.
  const admitted =
    outcome.evicted.length > 0 &&
    (await Promise.race([outcome.whenAdmitted, delay(ADMIT_WAIT_AFTER_EVICTION_MS, false)]));
  if (admitted) return null;
  // Still pending: the foreground slot stays held, but the caller's own
  // (agent) lease is given back so it is not blocked behind this job.
  await lease?.detachDependency?.();
  return backgroundShellPendingNotice(jobId, ownerSessionId);
}
