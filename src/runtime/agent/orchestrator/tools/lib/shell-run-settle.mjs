// Settle phase of one foreground shell run: the terminal result once the
// child is gone (or its kill could not be confirmed), plus the capture /
// lease cleanup that a promoted or unconfirmed-kill child defers to its own
// real exit.
import { ExecResult, SHELL_OUTPUT_INLINE_CAP } from '../shell-exec-output.mjs';
import { createProcessTreeTracker, probeShellDescendants, watchTermination } from './shell-descendants.mjs';
import { unregisterOwnedShellTree } from './owned-shell-trees.mjs';
import {
  adoptShellWorkspaceAdmission,
  clearTerminationHold,
  registerTerminationHold,
  takeReleaseRequest,
} from '../builtin/lib/shell-job-records.mjs';
import {
  clearForegroundRecord,
  clearForegroundTimers,
  detachAbortHandler,
  keepTerminationUnconfirmedRecord,
  releaseResourceLease,
} from './shell-run-state.mjs';

// Unconfirmed-kill cleanup ceiling: the result is already reported, but the
// tree may still be alive, so closing the capture and returning the resource
// lease wait for the child's real exit — bounded so an unkillable tree cannot
// pin the shell lane forever. The workspace admission is NOT bounded by it:
// it follows confirmed termination only (see below).
const UNCONFIRMED_KILL_CLEANUP_CEILING_MS = 60_000;

/** Settles once a held run's whole tree is confirmed gone (or its hold was
 *  force-released): what its result left in use defers to this. */
function treeSettled(run) {
  if (!run.treeSettled) {
    run.treeSettled = new Promise((resolve) => {
      run.resolveTreeSettled = resolve;
    });
  }
  return run.treeSettled;
}

/** Lifecycle completion of a run whose result is already reported: release
 *  `run.workspaceAdmission` and retire the live record only once the root AND
 *  every descendant identity captured before the kill are confirmed gone. One
 *  observation loop at the termination cadence; running, unknown (incomplete
 *  snapshot, failed table read) and a failing release all re-check, and no
 *  timer ever releases on its own. */
export function releaseAdmissionOnConfirmedTermination(run, { markNow = true, sweep = run.killed === true } = {}) {
  const { child } = run;
  if (!child || run.stopTerminationWatch) return;
  // Visible as "termination unconfirmed" until the lifecycle ends, with an
  // explicit user force-release as the only other way out. An unconfirmed
  // kill is marked at once; an owner-cancelled tree whose root is already
  // gone only once its first observation is not 'gone'.
  if (markNow) keepTerminationUnconfirmedRecord(run);
  treeSettled(run);
  // The workspace leases stop counting here; the returned promise settles once
  // their removal is on disk.
  const release = () => {
    const released = run.workspaceAdmission?.();
    run.workspaceAdmission = null;
    run.stopTerminationWatch?.();
    clearTerminationHold(run.foregroundRecordId);
    clearForegroundRecord(run);
    run.resolveTreeSettled();
    return released;
  };
  registerTerminationHold(run.foregroundRecordId, {
    ownerSessionId: run.foregroundRecordInput?.ownerSessionId || null,
    cwd: run.foregroundRecordInput?.cwd || null,
    release,
  });
  run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: child.pid });
  run.stopTerminationWatch = watchTermination({
    tracker: run.terminationTracker,
    rootExited: () => child.exitCode != null || child.signalCode != null,
    // A killed run is not over while processes it started still run.
    sweep,
    onTerminated: release,
    onUnconfirmed: markNow ? null : () => keepTerminationUnconfirmedRecord(run),
    releaseRequested: () => takeReleaseRequest(run.foregroundRecordId),
  });
}

// Promotion resolves the call and hands the child's lifecycle to the
// shell-jobs registry, but the spill FDs stay owned by THIS runner and
// nothing else would ever close them — one leaked descriptor pair per
// promoted command. Released on the promoted child's own terminal event.
export function createPromotedCaptureRelease(run) {
  let released = false;
  return () => {
    if (released) return;
    if (run.child?.exitCode == null && run.child?.signalCode == null) return;
    released = true;
    try {
      // Flush the decoders before the capture closes: held bytes (a pending
      // encoding decision or a split character) would otherwise be lost.
      const stdoutTail = run.stdoutDecoder.end();
      const stderrTail = run.stderrDecoder.end();
      if (stdoutTail) run.taskOutput.writeStdout(stdoutTail);
      if (stderrTail) run.taskOutput.writeStderr(stderrTail);
    } catch {
      /* best-effort */
    }
    try {
      // The spill files stay, even when empty: the promoted task record and
      // its completion notice point at these paths.
      run.taskOutput.closeFds();
    } catch {
      /* best-effort */
    }
  };
}

function deferCleanupToChildExit(run) {
  let done = false;
  let ceiling = null;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(ceiling);
    try {
      run.child.removeListener('close', cleanup);
      run.child.removeListener('exit', cleanup);
    } catch {
      /* not an emitter */
    }
    try {
      run.taskOutput.closeFds();
    } catch {
      /* best-effort */
    }
    void releaseResourceLease(run);
  };
  try {
    run.child.once('close', cleanup);
    run.child.once('exit', cleanup);
  } catch {
    /* child may already be gone */
  }
  ceiling = setTimeout(cleanup, UNCONFIRMED_KILL_CLEANUP_CEILING_MS);
  if (ceiling.unref) ceiling.unref();
  releaseAdmissionOnConfirmedTermination(run);
}

// getStdout/getStderr can throw on a spilled-file read failure (EBADF after
// unlink race, EACCES). Without this catch the rejection bubbles up and
// leaves the outer settle promise unresolved, hanging the call. Capture as
// writeError so the caller sees outputCaptureError and the partial inline
// buffer (if any) is still surfaced via partialOutput.
export async function readCapturedOutput(taskOutput, final = false) {
  let stdout = '';
  let stderr = '';
  try {
    stdout = await taskOutput.getStdout(final);
  } catch (err) {
    taskOutput.writeError = taskOutput.writeError || err;
  }
  try {
    stderr = await taskOutput.getStderr(final);
  } catch (err) {
    taskOutput.writeError = taskOutput.writeError || err;
  }
  return { stdout, stderr };
}

// The shell is gone — did it leave anything RUNNING? Answered from the
// process group / process tree the spawn layer already owns, never from the
// command text. A handle here means the caller reports a tracked task
// instead of a clean finish; null means nothing survived.
async function probeSurvivingDescendants(run) {
  if (run.killed || run.timedOut || !run.child?.pid) return null;
  const descendants = await probeShellDescendants({
    pid: run.child.pid,
  });
  if (descendants) descendants.taskId = run.foregroundRecordId;
  return descendants;
}

export function createSettle(run, releasePromotedCapture) {
  return async (exitCode, signal) => {
    if (run.settled) return;
    if (run.ownedTree) unregisterOwnedShellTree(run.foregroundRecordId, run.ownedTree);
    if (run.autoBackgrounded) {
      // A failed promotion settles the run with this close instead.
      run.promotionClose = [exitCode, signal];
      releasePromotedCapture();
      return;
    }
    run.settled = true;
    const { taskOutput } = run;
    // Off the readouts the instant the command is over, before any awaited
    // output capture — a finished command must never linger as "running".
    // An unconfirmed kill is NOT over: its record stays, marked unconfirmed
    // (releaseAdmissionOnConfirmedTermination), until every process is
    // confirmed gone or the user releases it.
    // Every other killed run (timeout, abort, session close) completes the
    // same way: its pre-kill snapshot, not the root's exit, decides when it
    // is over — a captured descendant can outlive the root it was killed with.
    const confirmKill = run.killed === true && !run.killUnconfirmed && Boolean(run.child?.pid);
    const lifecycleHeld = run.killUnconfirmed || confirmKill;
    if (!lifecycleHeld) clearForegroundRecord(run);
    clearForegroundTimers(run);
    detachAbortHandler(run);
    const stdoutTail = run.stdoutDecoder.end();
    const stderrTail = run.stderrDecoder.end();
    if (stdoutTail) taskOutput.writeStdout(stdoutTail);
    if (stderrTail) taskOutput.writeStderr(stderrTail);
    let { stdout, stderr } = await readCapturedOutput(taskOutput, true);
    if (run.spawnError && !stderr) stderr = String(run.spawnError.message || run.spawnError);
    // Inline-only path: nothing spilled. Nothing to clean up.
    // Spilled but within the inline cap: getStdout/getStderr already
    // returned the whole file, so the files would only duplicate the
    // inline body — drop them. Past the cap the rendered body is head+tail
    // carrying a "full output at <path>" marker, so the files MUST survive.
    // The test compares captured BYTES, not rendered UTF-16 length: a CJK
    // head+tail holds ~1/3 the char count of its byte size and under a
    // length test would delete the very file its own marker names.
    const dropCapture =
      !run.killUnconfirmed && taskOutput.spilled && taskOutput.totalDiskBytes() <= SHELL_OUTPUT_INLINE_CAP;
    if (run.killUnconfirmed) {
      // Never confirmed dead: deleting the capture files or handing back the
      // lease now would release resources a live process still owns. The
      // spilled paths therefore survive and travel with the result below, and
      // the workspace admission stays held until termination is confirmed.
      deferCleanupToChildExit(run);
    } else {
      const releaseCapture = () => (dropCapture ? taskOutput.deleteFiles() : taskOutput.closeFds());
      // A captured descendant of a killed tree may still write the capture.
      if (confirmKill) void treeSettled(run).then(releaseCapture);
      else releaseCapture();
      void releaseResourceLease(run);
    }
    let descendants = null;
    let descendantsUnknown = false;
    try {
      descendants = await probeSurvivingDescendants(run);
    } catch (error) {
      descendantsUnknown = true;
      taskOutput.writeError = taskOutput.writeError || error;
      exitCode = exitCode || 1;
      run.failureReason = 'Remaining child processes could not be verified; workspace cleanup is blocked.';
      // The root exited on its own, so it is observed after exit like any
      // settle; the held admission joins the termination watch and the
      // explicit force-release, and the record is kept, marked unconfirmed.
      // (The probe runs only for an unkilled root, so the lifecycle is not
      // already held here.)
      run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: run.child.pid });
      run.terminationTracker.acceptExitObservation();
      releaseAdmissionOnConfirmedTermination(run);
    }
    // Marked unconfirmed (with its force-release) only once an observation
    // finds a captured identity still alive or cannot tell.
    if (confirmKill) releaseAdmissionOnConfirmedTermination(run, { markNow: false });
    if (!lifecycleHeld && !descendantsUnknown && run.workspaceAdmission) {
      try {
        let released = null;
        if (descendants) adoptShellWorkspaceAdmission(run.foregroundRecordId, run.workspaceAdmission);
        else released = run.workspaceAdmission();
        run.workspaceAdmission = null;
        // The result is reported once the removal is on disk, as when it was written synchronously.
        await released;
      } catch (error) {
        taskOutput.writeError = taskOutput.writeError || error;
        exitCode = exitCode || 1;
        run.failureReason = 'workspace admission cleanup failed';
      }
    }
    run.resolveResult(
      new ExecResult({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut: run.timedOut,
        killed: run.killed,
        killCause: run.killCause,
        stdoutPath: taskOutput.spilled && !dropCapture ? taskOutput.stdoutPath : null,
        stdoutFileSize: taskOutput.stdoutFileSize,
        stderrPath: taskOutput.spilled && !dropCapture ? taskOutput.stderrPath : null,
        stderrFileSize: taskOutput.stderrFileSize,
        taskId: run.taskId,
        partialOutput: run.partialOutput,
        outputCaptureError: taskOutput.writeError,
        failurePhase: run.failurePhase,
        failureReason: run.failureReason,
        descendants,
        settled: run.treeSettled,
      })
    );
  };
}
