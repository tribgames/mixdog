/**
 * `host/computer/cursorPrepare`: the core asks for the agent's arrow to be ready before a session's first pointer input
 * (`computer/overlay/cursor-readiness.ts` `prepareCursorFeedback`). The overlay's cursor window is made ready, or the
 * answer says it cannot be (`unavailable`) or was not ready in time (`timeout`); the core waits at most 900 ms and goes
 * on without the arrow, so input never depends on artwork.
 */
import type { HostComputerCursorPrepareParams, HostComputerCursorPrepareResult } from '../../../../../packages/protocol/src/index.ts';
import { CURSOR_PREPARE_BUDGET_MS, prepareCursorFeedback } from '../computer/overlay/cursor-readiness';
import { HOST_INVALID_PARAMS, HostRpcError, type HostConnection, objectParams } from './connection';

export const HOST_COMPUTER_CURSOR_PREPARE = 'host/computer/cursorPrepare';

type PrepareCursor = (sessionId: string, budgetMs: number) => Promise<HostComputerCursorPrepareResult['state']>;

export function registerComputerCursor(connection: HostConnection, prepare: PrepareCursor = prepareCursorFeedback): void {
  connection.handleRequest(HOST_COMPUTER_CURSOR_PREPARE, async (params): Promise<HostComputerCursorPrepareResult> => {
    const { sessionThreadId } = objectParams<HostComputerCursorPrepareParams>(params, HOST_COMPUTER_CURSOR_PREPARE);
    if (typeof sessionThreadId !== 'string' || !sessionThreadId) {
      throw new HostRpcError(HOST_INVALID_PARAMS, `${HOST_COMPUTER_CURSOR_PREPARE} needs sessionThreadId.`);
    }
    return { state: await prepare(sessionThreadId, CURSOR_PREPARE_BUDGET_MS) };
  });
}
