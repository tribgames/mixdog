// A core failure as the user sees it. The core's JSON-RPC `message` is English for logs only (it is the bare reason,
// e.g. `domainError`), so a `domainError` is rebuilt in the shape Node's errors had when they reached the window:
//  - no `code`: the plain `Error` whose message is `detail.message` (DomainErrorDetail `externalFailure`);
//  - a `code`: an Error with that `code` and, as `details`, the detail's fields (the daemon wire's `code`/`details`,
//    desktop-service-client.ts responseError). A worktree code then gets Node's message framing, because Electron
//    hands the page only the message (worktree-validation.ts worktreeErrorWithCode); every other code is returned
//    by the IPC wrapper as an envelope (coded-error.ts ipcErrorEnvelope), which needs only `code` and `details`.
// The protocol carries no message text for a typed detail, so the code stands in for it. Any other failure is unchanged.
import type { ErrorData } from '../../../../../packages/protocol/src/index.ts';
import { worktreeErrorWithCode } from '../worktree-validation';

export function coreErrorForWindow(error: unknown): unknown {
  const failure = (error as { detail?: { kind?: unknown; data?: ErrorData } } | null)?.detail;
  const data = failure?.kind === 'rpc' ? failure.data : undefined;
  if (data?.reason !== 'domainError') return error;
  const detail = data.detail;
  if (data.code === undefined) return detail?.type === 'externalFailure' ? new Error(detail.message) : error;
  const { type: _type, ...fields } = detail ?? { type: '' };
  const coded = Object.assign(new Error(detail?.type === 'externalFailure' ? detail.message : data.code), {
    code: data.code,
    ...(Object.keys(fields).length ? { details: fields } : {}),
  });
  return worktreeErrorWithCode(coded);
}
