// A core failure as the window sees it: shared/core-error.ts, then framed as Node's IPC boundary did. A worktree code gets
// Node's message framing, because Electron hands the page only the message (worktree-validation.ts worktreeErrorWithCode);
// every other code is returned by the IPC wrapper as an envelope (coded-error.ts ipcErrorEnvelope). Past the framing the
// error keeps, as Node's reached the app, only the params its code declares public (desktop-service-client.ts
// responseError -> codedErrorParams); a worktree's details travel in its message.
import { codedErrorParams } from '../../shared/coded-error';
import { coreFailure } from '../../shared/core-error';
import { worktreeErrorWithCode } from '../worktree-validation';

export function coreErrorForWindow(error: unknown): unknown {
  return coreFailure(error, (coded) => {
    const { code, details } = coded as Error & { code: string; details?: Record<string, unknown> };
    const shown = worktreeErrorWithCode(coded) as Error & { details?: unknown };
    const params = codedErrorParams(code, details ?? {});
    if (params) shown.details = params;
    else delete shown.details;
    return shown;
  });
}
