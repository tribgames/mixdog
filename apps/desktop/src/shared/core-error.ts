// A core failure as the user sees it. The core's JSON-RPC `message` is English for logs only (it is the bare reason,
// e.g. `domainError`), so a `domainError` is rebuilt in the shape Node's errors had when they reached the window.
// The error's text is the wire `message` of the `domainError` (Node's `error.message`):
//  - no `code`: the plain `Error` with that message (left as it is when the core sent none);
//  - a `code`: an Error with that `code` and, as `details`, the detail's fields (the daemon wire's `code`/`details`,
//    desktop-service-client.ts responseError). `frame` then shapes it for the caller (the window's IPC boundary frames a
//    worktree code; the phone's relay frame carries the error as it is).
// Without a `message` the code stands in for it. Any other failure is unchanged.
import type { ErrorData } from '../../../../packages/protocol/src/index.ts';

export function coreFailure(error: unknown, frame: (coded: Error) => unknown = (coded) => coded): unknown {
  const failure = (error as { detail?: { kind?: unknown; data?: ErrorData } } | null)?.detail;
  const data = failure?.kind === 'rpc' ? failure.data : undefined;
  if (data?.reason !== 'domainError') return error;
  if (data.code === undefined) return data.message === undefined ? error : new Error(data.message);
  const { type: _type, ...fields } = data.detail ?? { type: '' };
  const coded = Object.assign(new Error(data.message ?? data.code), {
    code: data.code,
    ...(Object.keys(fields).length ? { details: fields } : {}),
  });
  return frame(coded);
}
