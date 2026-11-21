// A worktree code is framed into its message (worktreeErrorWithCode) because Electron hands the page only the message;
// every other code is returned by the IPC wrapper as an envelope (ipcErrorEnvelope).
import { codedErrorParams } from '../coded-error';
import { coreFailure } from '../core-error';
import { worktreeErrorWithCode } from '../worktree-error';

export function coreErrorForWindow(error: unknown): unknown {
  // A refused argument names the sentence of the TypeError its handler throws: the core's `expected` is that text.
  const refused = (error as { detail?: { kind?: unknown; data?: { reason?: unknown; expected?: unknown } } } | null)
    ?.detail;
  if (
    refused?.kind === 'rpc' &&
    refused.data?.reason === 'invalidParams' &&
    typeof refused.data.expected === 'string' &&
    refused.data.expected
  ) {
    return new TypeError(refused.data.expected, { cause: error });
  }
  return coreFailure(error, (coded) => {
    const { code, details } = coded as Error & { code: string; details?: Record<string, unknown> };
    const shown = worktreeErrorWithCode(coded) as Error & { details?: unknown };
    const params = codedErrorParams(code, details ?? {});
    if (params) shown.details = params;
    else delete shown.details;
    return shown;
  });
}
