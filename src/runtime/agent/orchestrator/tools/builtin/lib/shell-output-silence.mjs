// How long a running shell job has gone without writing to stdout or stderr.
// Silence is read from the capture files' mtime (the writer is the child, so
// nothing has to poll), floored at the job's start. It is a warning only:
// builds and installs can be legitimately quiet, so nothing is ever killed
// from here, and any output at all resets the clock.
import { statSync } from 'node:fs';
import { formatDuration } from '../../../../../shared/time-format.mjs';
import { getBackgroundTask } from '../../../../../shared/background-tasks.mjs';
import { STALL_ABORT_S, resolveTimeoutMs } from '../../../stall-policy.mjs';

// Defaults to the agent stall budget (600 s): a quiet job past the point where
// a silent model turn would be reaped is worth a look.
export const SHELL_OUTPUT_SILENCE_WARN_MS = resolveTimeoutMs('MIXDOG_SHELL_OUTPUT_SILENCE_WARN_MS', STALL_ABORT_S * 1000);

/** Milliseconds since the job last wrote to stdout/stderr (or started), or null
 *  when silence is unknown. The spawner creates both capture files before the
 *  command runs (mixdog-spawn open_capture_files, or the paired spill open), so
 *  a stream whose file cannot be stat'd (even ENOENT) is unknown, not quiet:
 *  its recent output could be what we cannot see. `task` is the background
 *  task; the stream paths come from `result` or the task meta. */
export function shellOutputSilenceMs(task, { now = Date.now(), result = task?.result } = {}) {
  let last = null;
  for (const path of [result?.stdout_path || task?.meta?.stdout, result?.stderr_path || task?.meta?.stderr]) {
    if (!path) continue;
    try {
      last = Math.max(last ?? 0, statSync(path).mtimeMs);
    } catch {
      return null;
    }
  }
  if (last == null) return null;
  return Math.max(0, now - Math.max(last, Number(task?.startedAtMs) || 0));
}

/** The warning text for a silence at or past the threshold, else null. */
export function describeShellOutputSilence(silentMs, warnMs = SHELL_OUTPUT_SILENCE_WARN_MS) {
  if (!(silentMs >= warnMs)) return null;
  return `no output for ${formatDuration(silentMs, { mostSignificantOnly: true })} — may be hung; inspect or cancel`;
}

/** The warning for one running shell task, else null. */
export function shellTaskSilenceNote(task, { now = Date.now(), warnMs = SHELL_OUTPUT_SILENCE_WARN_MS, result } = {}) {
  if (task?.surface !== 'shell' || task.status !== 'running') return null;
  return describeShellOutputSilence(shellOutputSilenceMs(task, { now, result: result ?? task.result }), warnMs);
}

/** The quietest of the running shell jobs an agent's `task wait` is parked on:
 *  `{ taskId, silentMs, hung }`, or null when it waits on none. */
export function waitedJobSilence(taskIds, { now = Date.now(), warnMs = SHELL_OUTPUT_SILENCE_WARN_MS } = {}) {
  let worst = null;
  for (const taskId of taskIds || []) {
    const task = getBackgroundTask(taskId);
    if (task?.surface !== 'shell' || task.status !== 'running') continue;
    const silentMs = shellOutputSilenceMs(task, { now });
    if (silentMs != null && (!worst || silentMs > worst.silentMs)) worst = { taskId, silentMs, hung: silentMs >= warnMs };
  }
  return worst;
}
