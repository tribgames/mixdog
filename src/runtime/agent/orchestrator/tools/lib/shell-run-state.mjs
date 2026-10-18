// Explicit state of one foreground shell run (execShellCommand) plus the
// small lifecycle helpers every phase shares: lease release, abort-handler
// detach, timer teardown, the live foreground record, and the confirmed
// tree-kill. The spawn, settle and auto-background phases live in their own
// modules and read/write this one record.
import { randomUUID } from 'node:crypto';
import { publishForegroundShellRecord, retireForegroundShellRecord } from '../builtin/shell-jobs.mjs';
import { ShellTextDecoder, TaskOutput, treeKill } from '../shell-exec-output.mjs';
import { createProcessTreeTracker, killAfterSnapshot } from './shell-descendants.mjs';
import { registerOwnedShellTree } from './owned-shell-trees.mjs';

/** One pre-kill identity read of the run's tree (every kill path shares it):
 *  resolves true once the capture is complete, false when it failed. */
export function capturePreKill(run) {
  run.terminationTracker = run.terminationTracker || createProcessTreeTracker({ pid: run.child.pid });
  const rootExited = run.child.exitCode != null || run.child.signalCode != null;
  return run.terminationTracker.capture({ rootExited }).catch(() => false);
}

/** Session close cancels every tree its session owns. For a foreground run
 *  that cancel must snapshot the identities first, exactly like the run's own
 *  kill, and mark the run owner-cancelled so its settle completes on confirmed
 *  termination instead of on the root's exit. */
export function registerForegroundOwnedTree(run, ownerSessionId) {
  if (!ownerSessionId) return;
  run.ownedTree = {
    ownerSessionId,
    prepareKill: () => {
      if (run.settled || run.autoBackgrounded || !run.child?.pid) return true;
      run.killed = true;
      run.ownerCancelled = true;
      run.killCause = run.killCause || 'session-close';
      // Always a fresh read: an earlier one predates what the run started
      // since. Pending, the kill is sent at the snapshot bound regardless.
      return capturePreKill(run);
    },
  };
  registerOwnedShellTree(run.foregroundRecordId, run.ownedTree);
}

// Treekill + exit confirmation. treeKill alone leaves settle() pending on
// 'close'/'exit'; on Windows a taskkill miss or a grandchild holding stdio
// fds keeps the dispatch stalled until the upstream ceiling. Covers every
// kill path (timeout / pre-aborted / abort / capture-error / size-watchdog)
// so the hang risk does not live on outside the timeout branch.
// A single 5 s force-settle was NOT enough: settling on that timer while
// the tree was still alive released the admission lease and the capture
// files under a running process. Each deadline now RE-issues the kill and
// re-arms; only a confirmed exit settles normally, and the bounded last
// resort settles with killUnconfirmed so cleanup follows the real exit.
const KILL_CONFIRM_INTERVAL_MS = 5000;
const KILL_CONFIRM_ATTEMPTS = 3;

export function createShellRun({ abortSignal, resolve, jobId = null }) {
  const taskId = `shell_${randomUUID().slice(0, 8)}`;
  let resultResolved = false;
  return {
    taskId,
    taskOutput: new TaskOutput(taskId),
    // The command text is NEVER inspected or rewritten here: whatever the
    // caller wrote reaches the shell byte for byte, trailing `&` included.
    // A command that detaches work is dealt with AFTER it runs, by observing
    // whether the shell's process group / tree still holds live processes
    // (see the descendant probe in settle()).
    stdoutDecoder: new ShellTextDecoder(),
    stderrDecoder: new ShellTextDecoder(),
    abortSignal,
    // _startMs covers admission lease + policy preflight too, so it overstates
    // how long the command itself has run; before a shell exists it is the
    // only stamp available (see elapsedSinceStart).
    startMs: Date.now(),
    resolveResult(result) {
      if (resultResolved) return false;
      resultResolved = true;
      resolve(result);
      return true;
    },
    isResolved: () => resultResolved,
    timedOut: false,
    killed: false,
    killCause: null,
    failurePhase: null,
    failureReason: null,
    spawnError: null,
    pendingChildError: null,
    settle: null,
    settled: false,
    timer: null,
    abortHandler: null,
    partialOutput: false,
    // Moment the shell PROCESS itself exited. The gap between it and the
    // stdio close is the win32 evidence that descendants inherited (and still
    // hold) this command's stdout/stderr — see lib/shell-descendants.mjs.
    rootExitAtMs: 0,
    resourceLease: null,
    progressTimer: null,
    outputTailTimer: null,
    lastOutputTail: '',
    // Auto-background transition flag. Set the moment the autoBackgroundMs
    // timer fires and promotes the still-running child. Once true the normal
    // settle()/close/exit/treeKill paths are inert for this run — the call
    // has already resolved with a 'backgrounded' result and the child's
    // lifecycle is owned by the shell-jobs registry. Mutually exclusive with
    // `settled`: whichever transition wins first wins for good.
    autoBackgrounded: false,
    autoBackgroundJobId: null,
    autoBgTimer: null,
    killUnconfirmed: false,
    child: null,
    // Live foreground record. Stamped with the moment the command actually
    // reached a shell — not lease/preflight entry, and not a warm standby's
    // process-creation time.
    commandStartedAtMs: 0,
    // Also the task_id the command keeps once promoted. A queued command
    // passes its queued task's id so one id names it before and after.
    foregroundRecordId: jobId || `job_${Date.now()}_${randomUUID().slice(0, 6)}`,
    foregroundRecordTimer: null,
    foregroundRecordPublished: false,
    // Command/cwd/owner the live record is published with.
    foregroundRecordInput: null,
    // Process identities captured before a kill, and the stop() of the
    // observation loop that holds the workspace until they are gone.
    terminationTracker: null,
    stopTerminationWatch: null,
  };
}

export async function releaseResourceLease(run) {
  if (!run.resourceLease) return null;
  const lease = run.resourceLease;
  run.resourceLease = null;
  try {
    await lease.release();
    return null;
  } catch (error) {
    return error;
  }
}

export function detachAbortHandler(run) {
  if (run.abortSignal && run.abortHandler) {
    try {
      run.abortSignal.removeEventListener('abort', run.abortHandler);
    } catch {}
    run.abortHandler = null;
  }
}

function clearProgressTimers(run) {
  if (run.progressTimer) {
    clearInterval(run.progressTimer);
    run.progressTimer = null;
  }
  if (run.outputTailTimer) {
    clearInterval(run.outputTailTimer);
    run.outputTailTimer = null;
  }
}

// The foreground capture is over (settled or promoted): stop every local
// watchdog/timer so none of them can treeKill the child afterwards.
export function clearForegroundTimers(run) {
  if (run.timer) {
    clearTimeout(run.timer);
    run.timer = null;
  }
  clearProgressTimers(run);
  if (run.autoBgTimer) {
    clearTimeout(run.autoBgTimer);
    run.autoBgTimer = null;
  }
}

export function clearForegroundRecord(run) {
  if (run.foregroundRecordTimer) {
    clearTimeout(run.foregroundRecordTimer);
    run.foregroundRecordTimer = null;
  }
  if (!run.foregroundRecordPublished) return;
  run.foregroundRecordPublished = false;
  try {
    retireForegroundShellRecord(run.foregroundRecordId);
  } catch {}
}

// Runtime of the COMMAND (see startMs).
export const elapsedSinceStart = (run) => Math.max(0, Date.now() - (run.commandStartedAtMs || run.startMs));

/** The command's result is reported, but its processes are not confirmed
 *  gone: the live record stays — now marked unconfirmed — until the
 *  termination watch retires it. */
export function keepTerminationUnconfirmedRecord(run) {
  if (run.foregroundRecordTimer) {
    clearTimeout(run.foregroundRecordTimer);
    run.foregroundRecordTimer = null;
  }
  if (!run.foregroundRecordInput || !run.child?.pid) return;
  try {
    publishForegroundShellRecord({
      ...run.foregroundRecordInput,
      jobId: run.foregroundRecordId,
      pid: run.child.pid,
      startedAtMs: run.commandStartedAtMs,
      terminationUnconfirmed: true,
    });
    run.foregroundRecordPublished = true;
  } catch {
    /* the record is presentation; the workspace admission stays held */
  }
}

// Record the tree's identities while the root is still alive, THEN kill: once
// an intermediate dies its children's parent links dangle and a snapshot taken
// afterwards can no longer find them.
// The kill waits for the snapshot at most PROCESS_TABLE_READ_BOUND_MS and is
// sent whether the snapshot succeeded, failed or is still pending (a late
// snapshot is still absorbed; a missing one leaves the outcome unknown, so the
// workspace stays held under the observation loop). The confirmation deadline
// starts once the kill is actually issued.
function snapshotThenKill(run, afterKill) {
  if (!run.child?.pid) {
    treeKill(run.child);
    afterKill();
    return;
  }
  void killAfterSnapshot(capturePreKill(run), () => {
    treeKill(run.child);
    afterKill();
  });
}

export function treeKillForceSettle(run, cause) {
  run.killed = true;
  run.killCause = run.killCause || cause || 'runtime-guard';
  let attempts = 0;
  const armConfirmation = () => {
    const deadline = setTimeout(() => {
      if (run.settled || run.autoBackgrounded) return;
      // A confirmed exit is settled by the child's own close/exit
      // handlers with its real status; nothing to force here.
      if (run.child?.exitCode != null || run.child?.signalCode != null) return;
      attempts += 1;
      if (attempts < KILL_CONFIRM_ATTEMPTS) {
        snapshotThenKill(run, armConfirmation);
        return;
      }
      run.partialOutput = true;
      run.killUnconfirmed = true;
      run.failureReason = run.failureReason || 'kill unconfirmed';
      run.settle(1, 'SIGKILL');
    }, KILL_CONFIRM_INTERVAL_MS);
    if (deadline.unref) deadline.unref();
  };
  snapshotThenKill(run, armConfirmation);
}
