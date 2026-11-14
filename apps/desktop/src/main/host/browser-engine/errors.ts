/**
 * The error codes of the browser engine host lane (`host/browser/*`), the
 * same numbers as `BROWSER_ENGINE_ERR_*` in mixdog-app-protocol
 * `v2/browser_engine.rs`, and the constructors of the errors that carry data.
 */
import type { PageFacts } from '../../../../../../packages/protocol/src/index.ts';
import { HOST_COMMAND_FAILED, HostRpcError } from '../connection';

export const ENGINE_ERROR = {
  preconditionFailed: -32010,
  pageGone: -32011,
  userInput: -32012,
  staleSnapshot: -32013,
  dialogBlocking: -32014,
  refused: -32015,
  failed: HOST_COMMAND_FAILED,
} as const;

/** `BrowserPreconditionReason` of `v2/browser_engine.rs` (not in the generated types: no method names it). */
export type PreconditionReason = 'document' | 'origin' | 'url' | 'childSession' | 'receiver' | 'snapshot';

export function preconditionFailed(reason: PreconditionReason, facts: PageFacts): HostRpcError {
  const data = { reason, facts };
  return new HostRpcError(ENGINE_ERROR.preconditionFailed, `precondition failed: ${reason}`, data);
}

export function pageGone(pageId: string): HostRpcError {
  return new HostRpcError(ENGINE_ERROR.pageGone, `page ${pageId} is gone`);
}
