import { registerBackgroundTask, renderBackgroundTask } from '../../../../../shared/background-tasks.mjs';
import { killShellJob, watchBackgroundShellJob } from '../shell-jobs.mjs';
import { renderBackgroundPartialOutput } from '../shell-output.mjs';
import { readShellTaskOutput } from '../lib/shell-task-output.mjs';
import { normalizeOutputPath } from '../path-utils.mjs';
import { cleanupArtifactOnTaskSettled, consumeTeeArtifact } from './transport-artifacts.mjs';
import { _backgroundResultLines, _prependDestructiveWarning } from './result-format.mjs';

const DEFAULT_BACKGROUND_MESSAGE =
  'auto-backgrounded; still running — judge from the partial output whether waiting can finish in budget, or diagnose and pursue an alternative.';

// The label and owner context every task registered for a shell command
// carries, whether promoted or tracking survivors.
export function shellTaskIdentity(command, options) {
  return {
    label: String(command).replace(/\s+/g, ' ').slice(0, 120),
    context: {
      notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
      callerSessionId: options?.callerSessionId || options?.sessionId || null,
      routingSessionId: options?.routingSessionId || options?.sessionId || null,
      clientHostPid: options?.clientHostPid,
    },
  };
}

function registerPromotedTask({ result, command, cwd, options, startedAtMs }) {
  try {
    return registerBackgroundTask({
      taskId: result.jobId,
      startedAtMs,
      surface: 'shell',
      operation: 'shell',
      ...shellTaskIdentity(command, options),
      input: { command, cwd },
      meta: {
        task_id: result.jobId,
        stdout: result.stdoutPath ? normalizeOutputPath(result.stdoutPath) : null,
        stderr: result.stderrPath ? normalizeOutputPath(result.stderrPath) : null,
        cwd,
        timeoutMs: result.backgroundTimeoutMs || 0,
      },
      resultType: 'shell_task_result',
      cancel: () => killShellJob(result.jobId),
    });
  } catch {
    return null;
  }
}

// Auto-backgrounded: the command outlived autoBackgroundMs and is still
// running, now promoted as a tracked shell-job. Surface the task_id + partial
// output for manual task control instead of keeping the tool call open until
// the hard timeout.
export function renderBackgroundedResult({ result, command, cwd, options, startedAtMs, teePlan, stdout, stderr }) {
  let task = null;
  if (result.jobId) {
    task = registerPromotedTask({ result, command, cwd, options, startedAtMs });
    try {
      watchBackgroundShellJob(result.jobId, {
        notifyFn: typeof options?.notifyFn === 'function' ? options.notifyFn : null,
        callerSessionId: options?.callerSessionId || options?.sessionId,
        routingSessionId: options?.routingSessionId || options?.sessionId,
        clientHostPid: options?.clientHostPid,
      });
    } catch {
      /* best effort */
    }
  }
  // The promoted producer is still writing into the tee file, so it cannot be
  // consumed here — but it must not survive the command either. Consume (and
  // delete) it when the task settles.
  if (teePlan) cleanupArtifactOnTaskSettled(teePlan.teePath, result.jobId, consumeTeeArtifact);
  let taskBlock = null;
  if (task) taskBlock = renderBackgroundTask(task);
  else if (result.jobId) taskBlock = `[task_id: ${result.jobId}]`;
  const partialOutput = task
    ? readShellTaskOutput(task, {
        stdout_path: result.stdoutPath,
        stderr_path: result.stderrPath,
        stdout_preview: stdout,
        stderr_preview: stderr,
      })
    : renderBackgroundPartialOutput(stdout, stderr);
  const lines = _backgroundResultLines({
    taskBlock,
    message: result.backgroundMessage || DEFAULT_BACKGROUND_MESSAGE,
    partialOutput,
  });
  return _prependDestructiveWarning(command, lines.join('\n'));
}
