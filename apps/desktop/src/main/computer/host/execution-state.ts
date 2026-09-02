/**
 * Per-session execution bookkeeping shared by the lifecycle, router, and
 * bridge: what is running, what was aborted, and the input state to restore.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface InputRecoveryState {
  targetWindowId: string;
  foregroundWindowId: string;
  restoreWindowId: string;
  /** Owner of the restore window, recorded while it still exists. */
  restoreOwnerWindowId: string;
  cursorX: number;
  cursorY: number;
}

export interface ActiveExecution {
  sessionId: string;
  aborted: boolean;
  recovery?: InputRecoveryState;
}

export function createExecutionState() {
  const activeExecutionsBySession = new Map<string, ActiveExecution>();
  const executionContext = new AsyncLocalStorage<ActiveExecution>();
  const sessionAbortEpochs = new Map<string, number>();
  const sessionRecoveryBySession = new Map<string, InputRecoveryState>();
  const commandChainsBySession = new Map<string, Promise<unknown>>();

  function assertExecutionNotAborted(): void {
    if (executionContext.getStore()?.aborted) {
      throw new Error('computer_session_aborted: command stopped by session cancellation');
    }
  }

  return {
    activeExecutionsBySession,
    executionContext,
    sessionAbortEpochs,
    sessionRecoveryBySession,
    commandChainsBySession,
    assertExecutionNotAborted,
  };
}

export type ExecutionState = ReturnType<typeof createExecutionState>;
