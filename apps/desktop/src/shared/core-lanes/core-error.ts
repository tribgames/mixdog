// A core failure as the window sees it: shared/core-error.ts, then framed as Node's IPC boundary did. A worktree code gets
// Node's message framing, because Electron hands the page only the message (worktree-error.ts worktreeErrorWithCode);
// every other code is returned by the IPC wrapper as an envelope (coded-error.ts ipcErrorEnvelope). Past the framing the
// error keeps, as Node's reached the app, only the params its code declares public (desktop-service-client.ts
// responseError -> codedErrorParams); a worktree's details travel in its message.
import { codedErrorParams } from '../coded-error';
import { coreFailure } from '../core-error';
import { worktreeErrorWithCode } from '../worktree-error';

export function coreErrorForWindow(error: unknown): unknown {
  // A refused argument names Node's own sentence (the TypeError its handler threw): the core's `expected` is that text.
  const refused = (error as { detail?: { kind?: unknown; data?: { reason?: unknown; expected?: unknown } } } | null)?.detail;
  if (refused?.kind === 'rpc' && refused.data?.reason === 'invalidParams' && typeof refused.data.expected === 'string' && refused.data.expected) {
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
