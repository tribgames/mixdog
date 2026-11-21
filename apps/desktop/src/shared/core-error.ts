// The core's JSON-RPC `message` is the bare reason (`domainError`), English for logs only, so a `domainError` is rebuilt
// from the wire `message` (plain Error when no `code`; else an Error with `code` and the detail's fields as `details`).
// `frame` then shapes it for the caller. Without a `message` the code stands in for it.
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
