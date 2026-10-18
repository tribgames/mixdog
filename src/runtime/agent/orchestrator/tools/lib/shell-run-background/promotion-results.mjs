/**
 * promotion-results.mjs — the ExecResult a promotion resolves the foreground
 * call with, one builder per outcome: cancelled during promotion, completed
 * during promotion, backgrounded, or cleanup failure.
 */
import { killShellJob } from '../../builtin/shell-jobs.mjs';
import { ExecResult, treeKill } from '../../shell-exec-output.mjs';
import {
  clearForegroundRecord,
  detachAbortHandler,
  elapsedSinceStart,
  releaseResourceLease,
} from '../shell-run-state.mjs';

const BACKGROUND_GUIDANCE =
  'Its result is delivered automatically when it finishes; use task wait only if you need it now.';

function backgroundVerb(reason, secs) {
  if (reason === 'timeout') return `moved to background at timeout after ${secs}s`;
  if (reason === 'input') return `moved to background on new user input after ${secs}s`;
  if (reason === 'notification') {
    return `moved to background after ${secs}s because a notification arrived (delivered to you now)`;
  }
  if (reason === 'interrupt') return `moved to background on interrupt after ${secs}s`;
  if (reason === 'background') return 'started in the background';
  return `moved to background after the ${secs}s hold`;
}

export function promotedSpillPaths(taskOutput) {
  return {
    stdoutPath: taskOutput.spilled ? taskOutput.stdoutPath : null,
    stdoutFileSize: taskOutput.stdoutFileSize,
    stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
    stderrFileSize: taskOutput.stderrFileSize,
  };
}

/** Fields every promotion-time result shares: the partial capture and its spill. */
function capturedFields(run, { stdout, stderr, spill }) {
  return {
    stdout,
    stderr,
    ...spill,
    taskId: run.taskId,
    outputCaptureError: run.taskOutput.writeError,
  };
}

/**
 * Cancellation raced in after promotion committed. Never report that
 * cancelled process as a successful still-running background task.
 */
export function resolveCancelledAfterPromotion(run, jobId, capture) {
  run.killed = true;
  run.killCause = 'cancellation';
  try {
    killShellJob(jobId);
  } catch {}
  try {
    treeKill(run.child);
  } catch {}
  run.resolveResult(
    new ExecResult({
      ...capturedFields(run, capture),
      exitCode: null,
      signal: run.child.signalCode || null,
      timedOut: false,
      killed: true,
      killCause: run.killCause,
      partialOutput: true,
      backgrounded: false,
    })
  );
}

/**
 * Completed-during-promotion race: the child finished while promotion was
 * committing. Report a clean COMPLETED result instead of backgrounded — the
 * caller then never arms the completion watcher, so no redundant task
 * notification fires.
 */
export function resolveCompletedDuringPromotion(run, capture) {
  detachAbortHandler(run);
  run.resolveResult(
    new ExecResult({
      ...capturedFields(run, capture),
      exitCode: run.child.exitCode,
      signal: run.child.signalCode || null,
      timedOut: false,
      killed: false,
      partialOutput: false,
      backgrounded: false,
    })
  );
}

export function resolveBackgrounded(run, { jobId, reason, remainingBackgroundTimeoutMs }, capture) {
  // The promoted job now owns cancellation through task control. Retaining
  // the foreground caller's signal listener would keep the completed tool
  // frame alive and could later kill an unrelated, already-returned job.
  detachAbortHandler(run);
  const secs = Math.max(0, Math.round(elapsedSinceStart(run) / 1000));
  const verb = backgroundVerb(reason, secs);
  run.resolveResult(
    new ExecResult({
      ...capturedFields(run, capture),
      exitCode: null,
      signal: null,
      timedOut: false,
      killed: false,
      partialOutput: true,
      backgrounded: true,
      jobId,
      backgroundTimeoutMs: remainingBackgroundTimeoutMs,
      backgroundMessage: jobId
        ? `${verb}; still running. ${BACKGROUND_GUIDANCE}`
        : `${verb}; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.`,
    })
  );
}

/**
 * A promotion that threw (lease hand-over) must still leave nothing behind:
 * the child is killed, the unreferenced capture files dropped, the lease
 * returned, and the call resolves with the cleanup failure.
 */
export function resolveCleanupFailure(run, error) {
  const { taskOutput } = run;
  run.settled = true;
  run.autoBackgrounded = true;
  clearForegroundRecord(run);
  run.killed = true;
  run.killCause = 'resource-cleanup-error';
  detachAbortHandler(run);
  try {
    if (run.autoBackgroundJobId) killShellJob(run.autoBackgroundJobId);
  } catch {}
  try {
    treeKill(run.child);
  } catch {}
  // settle() is inert from here (settled), so the cleanup it owns has to
  // run in this branch: the reported result carries no spill paths, so
  // the capture files are unreferenced garbage — drop them, close their
  // descriptors and hand back any lease the failed handoff still holds.
  try {
    taskOutput.deleteFiles();
  } catch {
    /* best-effort */
  }
  void releaseResourceLease(run);
  run.resolveResult(
    new ExecResult({
      stdout: '',
      stderr: `resource cleanup failed during background promotion: ${error?.message || error}`,
      exitCode: 1,
      signal: run.child?.signalCode || null,
      timedOut: false,
      killed: true,
      killCause: run.killCause,
      taskId: run.taskId,
      partialOutput: true,
      outputCaptureError: taskOutput.writeError,
      failurePhase: 'tool',
      failureReason: 'resource cleanup failed',
      backgrounded: false,
    })
  );
}
