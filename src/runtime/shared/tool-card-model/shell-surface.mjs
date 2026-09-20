/**
 * shell-surface.mjs — the shell/run tool family: its status merge and header.
 */
import { pluralize } from '../tool-primitives.mjs';
import { shellResultStatus } from './terminal-status.mjs';

export function isShellTool(normalizedName, label = '') {
  const n = String(normalizedName || '').toLowerCase();
  const l = String(label || '').toLowerCase();
  return (
    n === 'shell' || n === 'bash' || n === 'bash_session' || n === 'shell_command' || n === 'job_wait' || l === 'run'
  );
}

export function shellDisplayStatus({
  pending = false,
  failedCount = 0,
  exitFailedCount = 0,
  isError = false,
  result = '',
} = {}) {
  const status = shellResultStatus(result);
  if (pending || /^(running|pending|queued)$/.test(status)) return 'running';
  if (/^cancel/.test(status)) return 'cancelled';
  if (/^(failed|error|killed|timeout)$/.test(status)) return 'failed';
  // A command that RAN but exited non-zero is a command failure, not a failed
  // tool invocation: render the warning state unless a real tool failure also
  // exists in the group.
  const realFailed = Math.max(0, Number(failedCount) - Number(exitFailedCount));
  if (realFailed > 0) return 'failed';
  if (Number(exitFailedCount) > 0) return 'exit';
  if (isError || failedCount > 0) return 'failed';
  return 'completed';
}

export function shellHeader(status, count = 1, verifying = false) {
  const n = Math.max(1, Number(count) || 1);
  const object = `${n} ${pluralize(n, 'command')}`;
  // A shell that follows an edit in the same batch IS the verification —
  // label it as such while healthy; failures keep the neutral Ran + detail.
  if (verifying && status === 'running') return `Verifying ${object}`;
  if (verifying && status === 'completed') return `Verified ${object}`;
  if (status === 'running') return `Running ${object}`;
  return `Ran ${object}`;
}
