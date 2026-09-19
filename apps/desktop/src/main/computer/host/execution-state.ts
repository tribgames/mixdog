/**
 * Per-session execution bookkeeping shared by the lifecycle, router, and
 * bridge: what is running, what was aborted, and the input state to restore.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ComputerWorkProgress } from './pending-work';
import type { ComputerObservationGuard, ObservedWindowScope } from '../shared/types';

interface ActiveObservation {
  windowIds: Set<string>;
  invalidated: boolean;
}

export interface InputRecoveryState {
  targetWindowId: string;
  targetExists?: boolean;
  targetOwnerWindowId?: string;
  foregroundWindowId: string;
  restoreWindowId: string;
  /** Owner of the restore window, recorded while it still exists. */
  restoreOwnerWindowId: string;
  cursorX: number;
  cursorY: number;
  inputTick?: number;
  inputObserverReady?: boolean;
  inputMonitorId?: string;
  inputUserSequence?: number;
  syntheticInput?: boolean;
  foregroundWithinTarget?: boolean;
  foregroundChildProcess?: boolean;
}

export interface ActiveExecution {
  sessionId: string;
  aborted: boolean;
  recovery?: InputRecoveryState;
  progress?: ComputerWorkProgress;
  failureCode?: string;
  observations?: Set<ActiveObservation>;
  inputScopes?: Map<string, ObservedWindowScope>;
  inputInvalidated?: boolean;
}

export function createExecutionState() {
  const activeExecutionsBySession = new Map<string, ActiveExecution>();
  const executionContext = new AsyncLocalStorage<ActiveExecution>();
  const sessionAbortEpochs = new Map<string, number>();
  const sessionRecoveryBySession = new Map<string, InputRecoveryState>();
  const commandChainsBySession = new Map<string, Promise<unknown>>();

  function assertExecutionNotAborted(): void {
    const state = executionContext.getStore();
    if (state?.aborted) {
      throw new Error('computer_session_aborted: command stopped by session cancellation');
    }
    if (
      state?.inputInvalidated ||
      (state?.observations && [...state.observations].some((observation) => observation.invalidated))
    ) {
      throw new Error('stale_frame: another session changed the observed window during capture');
    }
  }

  function beginObservation(windowId: string): ComputerObservationGuard {
    assertExecutionNotAborted();
    const state = executionContext.getStore();
    if (!state) return { includeWindow() {}, close() {} };
    state.observations ||= new Set();
    const observations = state.observations;
    const observation: ActiveObservation = { windowIds: new Set(), invalidated: false };
    observations.add(observation);
    const includeWindow = (id: string) => {
      if (!id) return;
      // Nested owner-surface captures also belong to their parent observation.
      for (const current of observations) current.windowIds.add(id.toLowerCase());
    };
    includeWindow(windowId);
    return {
      includeWindow,
      close: () => {
        observations.delete(observation);
      },
    };
  }

  function invalidateObservationsForWindows(windowIds: Array<string | undefined>, exceptSessionId: string): void {
    const ids = new Set(windowIds.filter(Boolean).map((id) => String(id).toLowerCase()));
    for (const [sessionId, state] of activeExecutionsBySession) {
      if (sessionId === exceptSessionId) continue;
      for (const scope of state.inputScopes?.values() || []) {
        if (scope.relatedWindowIds.some((id) => ids.has(id.toLowerCase()))) state.inputInvalidated = true;
      }
      for (const observation of state.observations || []) {
        if ([...observation.windowIds].some((id) => ids.has(id))) observation.invalidated = true;
      }
    }
  }

  return {
    activeExecutionsBySession,
    executionContext,
    sessionAbortEpochs,
    sessionRecoveryBySession,
    commandChainsBySession,
    assertExecutionNotAborted,
    beginObservation,
    invalidateObservationsForWindows,
  };
}

export type ExecutionState = ReturnType<typeof createExecutionState>;
