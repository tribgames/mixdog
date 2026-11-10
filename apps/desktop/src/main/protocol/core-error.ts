// A core failure as the user sees it. The core's JSON-RPC `message` is English for logs only (it is the bare reason,
// e.g. `domainError`), so a `domainError` is rebuilt in the shape Node's errors had when they reached the window.
// The error's text is the wire `message` of the `domainError` (Node's `error.message`):
//  - no `code`: the plain `Error` with that message (left as it is when the core sent none);
//  - a `code`: an Error with that `code` and, as `details`, the detail's fields its code declares public (the daemon wire's
//    `code`/`details`, desktop-service-client.ts responseError). A worktree code then gets Node's message framing, because Electron
//    hands the page only the message (worktree-validation.ts worktreeErrorWithCode); every other code is returned
//    by the IPC wrapper as an envelope (coded-error.ts ipcErrorEnvelope), which needs only `code` and `details`.
// Without a `message` the code stands in for it. Any other failure is unchanged.
import type { ErrorData } from '../../../../../packages/protocol/src/index.ts';
import { codedErrorParams } from '../../shared/coded-error';
import { worktreeErrorWithCode } from '../worktree-validation';

export function coreErrorForWindow(error: unknown): unknown {
  const failure = (error as { detail?: { kind?: unknown; data?: ErrorData } } | null)?.detail;
  const data = failure?.kind === 'rpc' ? failure.data : undefined;
  if (data?.reason !== 'domainError') return error;
  if (data.code === undefined) return data.message === undefined ? error : new Error(data.message);
  const { type: _type, ...fields } = data.detail ?? { type: '' };
  const coded = Object.assign(new Error(data.message ?? data.code), {
    code: data.code,
    ...(Object.keys(fields).length ? { details: fields } : {}),
  });
  const shown = worktreeErrorWithCode(coded) as Error & { details?: unknown };
  // Past the framing the error keeps, as Node's reached the app, only the params its code declares public
  // (desktop-service-client.ts responseError → codedErrorParams); a worktree's details travel in its message.
  const params = codedErrorParams(data.code, fields);
  if (params) shown.details = params;
  else delete shown.details;
  return shown;
}
