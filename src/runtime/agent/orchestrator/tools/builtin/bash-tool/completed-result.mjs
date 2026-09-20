import { renderBackgroundTask, startBackgroundTask } from '../../../../../shared/background-tasks.mjs';
import { killShellDescendants, waitForShellDescendants } from '../../lib/shell-descendants.mjs';
import { consumeFilterTeeCapture } from '../shell-analysis.mjs';
import { compactShellOutputLosslessly, renderShellOutputBody } from '../shell-lossless-compact.mjs';
import { removeTransportFileNow } from './transport-artifacts.mjs';
import { _isBenignSearchExitOne } from './benign-exit.mjs';
import {
  SURVIVING_DESCENDANTS_UNREACHABLE_WARNING,
  SURVIVING_DESCENDANTS_WARNING,
  _composeShellFailure,
  _finalizeShellResult,
  _placeDestructiveWarningsAfterStatus,
  _prependDestructiveWarning,
  _shellFailureStatus,
} from './result-format.mjs';

/** Register the survivors a finished command left behind as a normal tracked
 *  task. It uses the SAME task registry every other background shell task
 *  uses, so task list/read/cancel need no special case: `run` settles the task
 *  when the last observed survivor exits, `cancel` terminates them. */
function trackSurvivingDescendants(handle, { command, cwd, options, startedAtMs } = {}) {
  if (!handle?.taskId) return null;
  try {
    return startBackgroundTask({
      taskId: handle.taskId,
      startedAtMs: startedAtMs || Date.now(),
      surface: 'shell',
      operation: 'shell',
      label: String(command).replace(/\s+/g, ' ').slice(0, 120),
      input: { command, cwd },
      context: {
        notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
        callerSessionId: options?.callerSessionId || options?.sessionId || null,
        routingSessionId: options?.routingSessionId || options?.sessionId || null,
        clientHostPid: options?.clientHostPid,
      },
      meta: { task_id: handle.taskId, stdout: null, stderr: null, cwd, timeoutMs: 0 },
      resultType: 'shell_task_result',
      run: async () => {
        await waitForShellDescendants(handle, { pollMs: 1_000 });
        return {
          task_id: handle.taskId,
          status: 'completed',
          detail: 'every process the command left running has exited',
        };
      },
      cancel: () => {
        void killShellDescendants(handle);
      },
    });
  } catch {
    return null;
  }
}

// The shell process is gone, but the runner observed live processes still in
// its process group / tree. Hand them to the task registry so the caller
// leaves with a task_id that reads, completes on its own when the last
// survivor exits, and cancels the whole set — instead of work running with no
// handle at all.
function survivingDescendantsWarning(result, taskContext) {
  const task = result.descendants ? trackSurvivingDescendants(result.descendants, taskContext) : null;
  if (!task) return '';
  const heading = result.descendants?.reachable
    ? SURVIVING_DESCENDANTS_WARNING
    : SURVIVING_DESCENDANTS_UNREACHABLE_WARNING;
  return [heading, renderBackgroundTask(task)].join('\n');
}

// Filter-swallow rescue: the tee file is ALWAYS consumed (deleted) here; its
// tail is attached only when the run failed with an empty visible capture —
// the exact `(no output)` shape that previously cost the model extra
// diagnostic turns.
function filterRescueNote(teePlan, { failed, stdout, stderr }) {
  const rescueTail = consumeFilterTeeCapture(teePlan.teePath);
  // consumeFilterTeeCapture unlinks best-effort and swallows the failure; on
  // Windows a process that survived an unconfirmed kill still holds the file.
  // Route it through the same retry + exit-hook path the settlement branch
  // uses instead of abandoning it.
  removeTransportFileNow(teePlan.teePath);
  if (!failed || !rescueTail || stdout.trim() || stderr.trim()) return '';
  return `\n\n[filter-swallowed output rescue] the command failed but its trailing filter(s) matched nothing, so the visible output was empty. Unfiltered pipeline output (tail):\n${rescueTail}`;
}

// Three outcomes: TOOL/control-plane failure, interrupted execution, and a
// process that completed (zero or non-zero). Completed non-zero exits keep
// their code but never carry Error:/shell-run-failed. Every integer exit
// status is an observed process completion; stdout/stderr wording never
// overrides that fact.
function classifyCompletion(result, timeout, analysisCommand) {
  const failureStatus = _shellFailureStatus(result, timeout);
  const { signal, exitCode, shellToolFailed, statusDetail } = failureStatus;
  const completedExit = !shellToolFailed && !signal && !result.timedOut && Number.isInteger(exitCode);
  const benignExit = completedExit && _isBenignSearchExitOne(analysisCommand, exitCode, signal, result.stderr);
  const shellRunFailed = !shellToolFailed && (!!signal || result.timedOut || !Number.isInteger(exitCode));
  // Distinct timeout marker so callers see "killed by timeout after Nms" vs
  // an external signal; the detail carries an inline recovery hint.
  let statusMarker = '';
  if (shellToolFailed) statusMarker = `[shell-tool-failed] ${statusDetail}`;
  else if (shellRunFailed) statusMarker = `[shell-run-failed] ${statusDetail}`;
  else if (completedExit) statusMarker = statusDetail;
  return {
    signal,
    exitCode,
    completedExit,
    benignExit,
    isReallyErrored: shellToolFailed || shellRunFailed,
    statusMarker,
    outcomeNote: benignExit ? '\n[outcome: no-match]' : '',
  };
}

export function renderCompletedResult({
  result,
  command,
  analysisCommand,
  cwd,
  options,
  startedAtMs,
  teePlan,
  stdout,
  stderr,
  timeout,
  rewriteNote,
}) {
  const outcome = classifyCompletion(result, timeout, analysisCommand);
  const { signal, exitCode, completedExit, benignExit, isReallyErrored } = outcome;
  const commandExitedNonzero = completedExit && exitCode !== 0 && !benignExit;
  const rescueNote = teePlan
    ? filterRescueNote(teePlan, { failed: isReallyErrored || commandExitedNonzero, stdout, stderr })
    : '';
  const descendantWarning = survivingDescendantsWarning(result, { command, cwd, options, startedAtMs });
  // rewriteNote states that the text which RAN is not the text the caller
  // sent (wmic → Get-CimInstance); it rides both result shapes.
  const warningBlock = [descendantWarning, rewriteNote || ''].filter(Boolean).join('\n');
  const losslessCompaction = compactShellOutputLosslessly({
    command,
    rawStdout: result.stdout || '',
    rawStderr: result.stderr || '',
    stdout,
    stderr,
    exitCode,
    signal,
    timedOut: result.timedOut,
    hasExistingRecovery: Boolean(result.stdoutPath || result.stderrPath),
    sessionId: options?.sessionId,
    toolCallId: options?.toolCallId,
    resultTelemetry: options?.resultTelemetry,
  });
  // stdout and stderr are captured on separate fds and pasted as one body.
  // Without a boundary a stdout tail with no trailing newline glued itself
  // onto the first stderr line and corrupted both. No spill-path block: a
  // truncated stream already carries its own "full output at <path>" marker.
  const payload = `${renderShellOutputBody(
    losslessCompaction?.stdout ?? stdout,
    losslessCompaction?.stderr ?? stderr,
    losslessCompaction
  )}${rescueNote}`;
  if (outcome.statusMarker) {
    const failure = _composeShellFailure(
      `${outcome.statusMarker}${outcome.outcomeNote}`,
      isReallyErrored ? 'Error: ' : '',
      warningBlock,
      payload
    );
    return _finalizeShellResult(completedExit, _placeDestructiveWarningsAfterStatus(command, failure));
  }
  return _prependDestructiveWarning(command, warningBlock ? `${warningBlock}\n${payload}` : payload);
}
