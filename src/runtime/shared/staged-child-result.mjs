'use strict';

import { finishProcessLifecycle } from './process-lifecycle.mjs';

const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};

export function stagedChildExitCode(result) {
  if (!result || result.error) return null;
  if (result.signal) {
    const exitCode = SIGNAL_EXIT_CODES[result.signal] || 1;
    finishProcessLifecycle('forced-cleanup', exitCode);
    return exitCode;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}
