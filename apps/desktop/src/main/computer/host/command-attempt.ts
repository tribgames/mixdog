/**
 * One attempt at one command, inside its execution context. A takeover that
 * happened since the request was queued turns a mutation into a pending
 * observation instead of replaying its input. A failure is judged before it
 * is reported: codes that mean the user has the desktop trigger a takeover,
 * a user pause parks the work (keeping only its progress), the user's own
 * input refuses just this action, and anything else gets one recovery capture
 * so the reply carries fresh evidence.
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
import type { PointerHold } from './pointer-hold';
import { isComputerRecoveryRead } from './recovery-reads';
import { userInputRefusalPayload } from './user-input-refusal';
import { TAKEOVER_CODES } from '../shared/takeover-codes';
import type { WindowArrivals } from './window-arrivals';

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
  pointerHold?: Pick<PointerHold, 'claim' | 'arm'>;
  windowArrivals?: Pick<WindowArrivals, 'read' | 'report' | 'watch'>;
}

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

/** An aborted session whose input recovery failed reports that failure, not the abort. */
function recoveryFailure(failureCode: string): Error {
  return new Error(`${failureCode}: input recovery failed; inspect the recovery diagnostic`);
}

/** Reads and recovery reads observe the desktop; they never replay input. */
function observesOnly(command: ComputerCommand): boolean {
  return READ_ACTIONS.has(String(command.action)) || isComputerRecoveryRead(String(command.action));
}

/** The takeover code a returned reply carries, if any. */
function takeoverCodeIn(result: ComputerCommandResult): { code: string; message: string } | undefined {
  let reply: unknown;
  try {
    reply = JSON.parse(result.text);
  } catch {
    return undefined;
  }
  if (!reply || typeof reply !== 'object') return undefined;
  const { code, message } = reply as { code?: unknown; message?: unknown };
  if (typeof code !== 'string' || !TAKEOVER_CODES.includes(code)) return undefined;
  return { code, message: typeof message === 'string' ? message : 'reported by the native result' };
}

/** The recovery capture is an active operation too, so Stop and Resume
 *  cannot race a late observation into the next generation. A cancelled or
 *  failed recovery must not disguise a dispatched mutation as "cancelled
 *  before execution", or publish a stale result. */
async function recoveryCapture(
  deps: CommandAttemptDeps,
  attempt: Attempt,
  error: unknown,
  record: Record<string, unknown>
): Promise<ComputerCommandResult | null> {
  const { coordinator, recaptureRequiredReply } = deps;
  const { activeExecutionsBySession, executionContext } = deps.execution;
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

/** The reply (or the rethrow) for an attempt that failed. */
async function failedAttempt(
  deps: CommandAttemptDeps,
  attempt: Attempt,
  failure: unknown
): Promise<ComputerCommandResult> {
  const { command, state, startedAt } = attempt;
  const captureAttempts = captureAttemptsFromError(failure);
  const error = state.aborted && state.failureCode ? recoveryFailure(state.failureCode) : failure;
  const code = computerLogError(error);
  // A broken or replaced read observer alone is not evidence that the
  // user has the desktop.
  if (TAKEOVER_CODES.includes(code) && !observesOnly(command)) deps.takeOver(code);
  if (pausedForUserInput(deps.coordinator.snapshot()) && !observesOnly(command)) {
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
  if (code === 'user_input_active') {
    // The user's input refuses this action alone. They own the desktop, so
    // there is no recovery capture; the session and its queue go on.
    deps.recordDiagnostic?.(state.sessionId, { ...record, stage: 'execution' });
    return {
      text: JSON.stringify(
        userInputRefusalPayload(String(command.action || ''), command.window_id, !observesOnly(command))
      ),
    };
  }
  const recapture = await recoveryCapture(deps, attempt, error, record);
  if (recapture) return recapture;
  throw error;
}

export function createCommandAttempt(deps: CommandAttemptDeps) {
  const { coordinator, execution, sessionIdFor, runCommand, recaptureRequiredReply, assertEpoch } = deps;
  const { activeExecutionsBySession, executionContext } = execution;
  /** The injection tick the last foreground delivery reported, so the next
   *  one can tell its own input from the user's. */
  let lastInjectionTick: number | null = null;

  const assertRunnableFor = (state: ActiveExecution, epoch: number) => () => {
    if (state.aborted && state.failureCode) throw recoveryFailure(state.failureCode);
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
      // A takeover code in a returned reply is classified like a thrown one,
      // unless the reply's own path already took the desktop over.
      const returned = takeoverCodeIn(result);
      if (returned && !coordinator.snapshot().userControlActive)
        throw new Error(`${returned.code}: ${returned.message}`);
      return result;
    });
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
      // Outside the shared foreground lane and bounded, so the arrivals check
      // never holds another session's input or this command for long.
      const arrived = (await deps.windowArrivals?.read(command)) ?? [];
      const operation = async () => {
        // One physical pointer: another session's blanked cursor ends first.
        if (foreground) await deps.pointerHold?.claim(sessionId);
        return runAttempt(attempt);
      };
      const requireFreshAfterWait = pending || observesOnly(command) ? false : undefined;
      const result = foreground
        ? await deps.runForegroundExclusive(sessionId, operation, {
            assertRunnable: attempt.assertRunnable,
            requireFreshAfterWait,
          })
        : await operation();
      // Before the final checks: a stop or takeover while the report reads
      // app names must still refuse this reply.
      const outcome = deps.windowArrivals ? await deps.windowArrivals.report(command, arrived, result) : result;
      attempt.assertRunnable();
      coordinator.assertAutomationAllowed();
      if (foreground) {
        const tick = computerResultLastNumber(outcome.text, 'injection_tick');
        if (tick !== null) lastInjectionTick = tick;
      }
      const record = computerRunRecord(command, attempt.startedAt, outcome);
      appendComputerRunRecord(sessionId, record);
      deps.recordDiagnostic?.(sessionId, { ...record, stage: 'completed' });
      // Its first look comes after this reply is returned, on timers.
      deps.windowArrivals?.watch(command);
      return outcome;
    } catch (error) {
      if (error instanceof PausedBeforeDispatch) throw error;
      return await failedAttempt(deps, attempt, error);
    } finally {
      if (activeExecutionsBySession.get(sessionId) === state) activeExecutionsBySession.delete(sessionId);
      if (foreground) deps.pointerHold?.arm(sessionId);
      coordinator.finishCommand(sessionId);
      releaseApproval();
    }
  }

  return { executeAttempt };
}
