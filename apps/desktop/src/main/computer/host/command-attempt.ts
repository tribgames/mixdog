/**
 * One attempt at one command, inside its execution context. A takeover that
 * happened since the request was queued turns a mutation into a pending
 * observation instead of replaying its input. A failure is judged before it
 * is reported: codes that mean the user has the desktop trigger a takeover,
 * a user pause parks the work (keeping only its progress), and anything else
 * gets one recovery capture so the reply carries fresh evidence.
 */
import { beginComputerOperation } from '../../human-only-approval';
import { type ComputerUseCoordinator, computerResultLastNumber } from '../session/coordinator';
import { computerLogError } from '../session/log-privacy';
import { appendComputerRunRecord, computerRunRecord } from '../session/run-log';
import { captureAttemptsFromError } from '../shared/capture-attempts';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { computerDeliveryMode, READ_ACTIONS, requiresForegroundLane } from './action-sets';
import { PausedBeforeDispatch, type ForegroundLane } from './command-queue-foreground';
import { type PauseGate, pausedForUserInput } from './command-queue-pause';
import type { ActiveExecution, ExecutionState } from './execution-state';
import { PausedComputerWork, pendingWorkReply } from './pending-work';
import { isComputerRecoveryRead } from './recovery-reads';

export interface CommandAttemptDeps {
  coordinator: ComputerUseCoordinator;
  execution: ExecutionState;
  sessionIdFor(command: ComputerCommand): string;
  runCommand(command: ComputerCommand): Promise<ComputerCommandResult>;
  recaptureRequiredReply(command: ComputerCommand, error: unknown): Promise<ComputerCommandResult | null>;
  takeOver(reason: string): void;
  recordDiagnostic?: (sessionId: string, record: Record<string, unknown>) => void;
  assertEpoch: PauseGate['assertEpoch'];
  runForegroundExclusive: ForegroundLane['runForegroundExclusive'];
}

/** Failure codes that mean the user, not the agent, has the desktop now. */
const TAKEOVER_CODES = ['user_input_active', 'input_cleanup_unconfirmed', 'input_observation_unavailable'];

interface Attempt {
  command: ComputerCommand;
  state: ActiveExecution;
  generation: number;
  foreground: boolean;
  /** Work parked by an earlier pause; set during the run when a takeover
   *  since queueing turns this attempt into an observation. */
  pending: PausedComputerWork | undefined;
  startedAt: number;
  assertRunnable(): void;
}

/** Reads and recovery reads observe the desktop; they never replay input. */
function observesOnly(command: ComputerCommand): boolean {
  return READ_ACTIONS.has(String(command.action)) || isComputerRecoveryRead(String(command.action));
}

export function createCommandAttempt(deps: CommandAttemptDeps) {
  const { coordinator, execution, sessionIdFor, runCommand, recaptureRequiredReply, assertEpoch } = deps;
  const { activeExecutionsBySession, executionContext } = execution;
  /** The injection tick the last foreground delivery reported, so the next
   *  one can tell its own input from the user's. */
  let lastInjectionTick: number | null = null;

  const assertRunnableFor = (state: ActiveExecution, epoch: number) => () => {
    if (state.aborted && state.failureCode) {
      throw new Error(`${state.failureCode}: input recovery failed; inspect the recovery diagnostic`);
    }
    assertEpoch(state.sessionId, epoch);
    if (state.aborted) throw new Error('computer_session_aborted: command stopped by session cancellation');
  };

  async function runAttempt(attempt: Attempt): Promise<ComputerCommandResult> {
    const { command, state, generation, foreground } = attempt;
    attempt.assertRunnable();
    coordinator.beginCommand({
      sessionId: state.sessionId,
      action: String(command.action || 'computer'),
      target: String(command.window || command.window_id || command.app || ''),
      mode: computerDeliveryMode(command),
    });
    activeExecutionsBySession.set(state.sessionId, state);
    return executionContext.run(state, async () => {
      if (generation !== coordinator.snapshot().takeoverGeneration && !observesOnly(command)) {
        attempt.pending ||= new PausedComputerWork({ completed: 0 });
      }
      if (attempt.pending) {
        const fresh = await recaptureRequiredReply(command, attempt.pending);
        if (!fresh) throw new Error('computer_pending_observation_unavailable: cannot observe the pending target');
        return pendingWorkReply(command, fresh, attempt.pending.progress);
      }
      state.progress = { completed: 0, inFlight: 0 };
      const result = await runCommand(
        foreground && lastInjectionTick !== null ? { ...command, known_injection_tick: lastInjectionTick } : command
      );
      if (!Array.isArray(command.steps)) state.progress = { completed: 1 };
      return result;
    });
  }

  /** The recovery capture is an active operation too, so Stop and Resume
   *  cannot race a late observation into the next generation. A cancelled or
   *  failed recovery must not disguise a dispatched mutation as "cancelled
   *  before execution", or publish a stale result. */
  async function recoveryCapture(
    attempt: Attempt,
    error: unknown,
    record: Record<string, unknown>
  ): Promise<ComputerCommandResult | null> {
    const { command, state } = attempt;
    let recapture: ComputerCommandResult | null = null;
    try {
      if (!coordinator.snapshot().userControlActive && !state.aborted) {
        attempt.assertRunnable();
        activeExecutionsBySession.set(state.sessionId, state);
        recapture = await executionContext.run(state, () => recaptureRequiredReply(command, error));
        attempt.assertRunnable();
        coordinator.assertAutomationAllowed();
      }
    } catch (recoveryError) {
      recapture = null;
      deps.recordDiagnostic?.(state.sessionId, {
        action: command.action,
        stage: 'recovery',
        ok: false,
        error: computerLogError(recoveryError),
      });
    } finally {
      deps.recordDiagnostic?.(state.sessionId, {
        ...record,
        stage: 'execution',
        input_recovery: { recapture_available: recapture !== null },
      });
    }
    return recapture;
  }

  async function failedAttempt(attempt: Attempt, failure: unknown): Promise<ComputerCommandResult> {
    const { command, state, startedAt } = attempt;
    const captureAttempts = captureAttemptsFromError(failure);
    const error =
      state.aborted && state.failureCode
        ? new Error(`${state.failureCode}: input recovery failed; inspect the recovery diagnostic`)
        : failure;
    const code = computerLogError(error);
    if (TAKEOVER_CODES.includes(code)) {
      deps.takeOver(code);
    }
    if (pausedForUserInput(coordinator.snapshot()) && !observesOnly(command)) {
      // Throw out of the active lane before waiting: cleanup and resume
      // must be able to drain it. Only progress survives, never stale refs.
      throw attempt.pending || new PausedComputerWork(state.progress || { completed: 0 });
    }
    const record = {
      ...computerRunRecord(command, startedAt),
      ok: false,
      error: code,
      ...(captureAttempts.length ? { capture_attempts: captureAttempts } : {}),
    };
    appendComputerRunRecord(state.sessionId, record);
    const recapture = await recoveryCapture(attempt, error, record);
    if (recapture) return recapture;
    throw error;
  }

  async function executeAttempt(
    command: ComputerCommand,
    epoch: number,
    generation: number,
    pending?: PausedComputerWork
  ): Promise<ComputerCommandResult> {
    const sessionId = sessionIdFor(command);
    const foreground = requiresForegroundLane(command);
    const releaseApproval = beginComputerOperation();
    const state: ActiveExecution = { sessionId, aborted: false };
    const attempt: Attempt = {
      command,
      state,
      generation,
      foreground,
      pending,
      startedAt: performance.now(),
      assertRunnable: assertRunnableFor(state, epoch),
    };
    try {
      const operation = () => runAttempt(attempt);
      const requireFreshAfterWait = pending ? false : undefined;
      const outcome = foreground
        ? await deps.runForegroundExclusive(sessionId, operation, {
            assertRunnable: attempt.assertRunnable,
            requireFreshAfterWait,
          })
        : await operation();
      attempt.assertRunnable();
      coordinator.assertAutomationAllowed();
      if (foreground) {
        const tick = computerResultLastNumber(outcome.text, 'injection_tick');
        if (tick !== null) lastInjectionTick = tick;
      }
      const record = computerRunRecord(command, attempt.startedAt, outcome);
      appendComputerRunRecord(sessionId, record);
      deps.recordDiagnostic?.(sessionId, { ...record, stage: 'completed' });
      return outcome;
    } catch (error) {
      if (error instanceof PausedBeforeDispatch) throw error;
      return await failedAttempt(attempt, error);
    } finally {
      if (activeExecutionsBySession.get(sessionId) === state) activeExecutionsBySession.delete(sessionId);
      coordinator.finishCommand(sessionId);
      releaseApproval();
    }
  }

  return { executeAttempt };
}
