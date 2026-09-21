import { finishProcessLifecycle } from './process-lifecycle.mjs';
import { signalExitCode } from './process-shutdown.mjs';

export function stagedChildExitCode(result) {
  if (!result || result.error) return null;
  if (result.signal) {
    const exitCode = signalExitCode(result.signal, 1);
    finishProcessLifecycle('forced-cleanup', exitCode);
    return exitCode;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}
