// Settle phase of one foreground shell run: the terminal result once the
// child is gone (or its kill could not be confirmed), plus the capture /
// lease cleanup that a promoted or unconfirmed-kill child defers to its own
// real exit.
import { ExecResult, SHELL_OUTPUT_INLINE_CAP } from '../shell-exec-output.mjs';
import { probeShellDescendants, STDIO_HELD_AFTER_EXIT_MS } from './shell-descendants.mjs';
import {
  clearForegroundRecord,
  clearForegroundTimers,
  detachAbortHandler,
  releaseResourceLease,
} from './shell-run-state.mjs';

// Unconfirmed-kill cleanup ceiling: the result is already reported, but the
// tree may still be alive, so closing the capture and returning the
// admission lease wait for the child's real exit — bounded so an unkillable
// tree cannot pin the shell lane forever.
const UNCONFIRMED_KILL_CLEANUP_CEILING_MS = 60_000;

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
      // An empty spill pair is garbage nothing can reference; captured
      // bytes stay, because the promoted task record points at these files.
      if (run.taskOutput.spilled && run.taskOutput.totalDiskBytes() === 0) run.taskOutput.deleteFiles();
      else run.taskOutput.closeFds();
    } catch {
      /* best-effort */
    }
  };
}

function deferCleanupToChildExit(run) {
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
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
  const ceiling = setTimeout(cleanup, UNCONFIRMED_KILL_CLEANUP_CEILING_MS);
  if (ceiling.unref) ceiling.unref();
}

// getStdout/getStderr can throw on a spilled-file read failure (EBADF after
// unlink race, EACCES). Without this catch the rejection bubbles up and
// leaves the outer settle promise unresolved, hanging the call. Capture as
// writeError so the caller sees outputCaptureError and the partial inline
// buffer (if any) is still surfaced via partialOutput.
export async function readCapturedOutput(taskOutput) {
  let stdout = '';
  let stderr = '';
  try {
    stdout = await taskOutput.getStdout();
  } catch (err) {
    taskOutput.writeError = taskOutput.writeError || err;
  }
  try {
    stderr = await taskOutput.getStderr();
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
  try {
    const descendants = await probeShellDescendants({
      pid: run.child.pid,
      stdioHeld: run.rootExitAtMs > 0 && Date.now() - run.rootExitAtMs >= STDIO_HELD_AFTER_EXIT_MS,
    });
    if (descendants) descendants.taskId = run.foregroundRecordId;
    return descendants;
  } catch {
    return null;
  }
}

export function createSettle(run, releasePromotedCapture) {
  return async (exitCode, signal) => {
    if (run.settled) return;
    if (run.autoBackgrounded) {
      releasePromotedCapture();
      return;
    }
    run.settled = true;
    const { taskOutput } = run;
    // Off the readouts the instant the command is over, before any awaited
    // output capture — a finished command must never linger as "running".
    clearForegroundRecord(run);
    clearForegroundTimers(run);
    detachAbortHandler(run);
    const stdoutTail = run.stdoutDecoder.end();
    const stderrTail = run.stderrDecoder.end();
    if (stdoutTail) taskOutput.writeStdout(stdoutTail);
    if (stderrTail) taskOutput.writeStderr(stderrTail);
    let { stdout, stderr } = await readCapturedOutput(taskOutput);
    if (run.spawnError && !stderr) stderr = String(run.spawnError.message || run.spawnError);
    // Inline-only path: nothing spilled. Nothing to clean up.
    // Spilled but within the inline cap: getStdout/getStderr already
    // returned the whole file, so the files would only duplicate the
    // inline body — drop them. Past the cap the rendered body is head+tail
    // carrying a "full output at <path>" marker, so the files MUST survive.
    // The test compares captured BYTES, not rendered UTF-16 length: a CJK
    // head+tail holds ~1/3 the char count of its byte size and under a
    // length test would delete the very file its own marker names.
    if (run.killUnconfirmed) {
      // Never confirmed dead: deleting the capture files or handing back the
      // lease now would release resources a live process still owns. The
      // spilled paths therefore survive and travel with the result below.
      deferCleanupToChildExit(run);
    } else if (taskOutput.spilled && taskOutput.totalDiskBytes() <= SHELL_OUTPUT_INLINE_CAP) {
      taskOutput.deleteFiles();
      void releaseResourceLease(run);
    } else {
      taskOutput.closeFds();
      void releaseResourceLease(run);
    }
    const descendants = await probeSurvivingDescendants(run);
    run.resolveResult(
      new ExecResult({
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut: run.timedOut,
        killed: run.killed,
        killCause: run.killCause,
        stdoutPath: taskOutput.spilled ? taskOutput.stdoutPath : null,
        stdoutFileSize: taskOutput.stdoutFileSize,
        stderrPath: taskOutput.spilled ? taskOutput.stderrPath : null,
        stderrFileSize: taskOutput.stderrFileSize,
        taskId: run.taskId,
        partialOutput: run.partialOutput,
        outputCaptureError: taskOutput.writeError,
        failurePhase: run.failurePhase,
        failureReason: run.failureReason,
        descendants,
      })
    );
  };
}
