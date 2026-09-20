/**
 * Park requests outside the desktop lane and the active-operation drain. A
 * session's commands run in order on one chain; a queued mutation resumes with
 * fresh evidence, never with its old input.
 */
import { assertSafeComputerSessionId } from '../input/guards';
import type { ComputerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { isComputerLifecycleControl, requiresForegroundLane } from './action-sets';
import { createCommandAttempt } from './command-attempt';
import { createComputerCommandBudget } from './command-budget';
import { createForegroundLane, PausedBeforeDispatch } from './command-queue-foreground';
import { createPauseGate, PauseWaitExpired } from './command-queue-pause';
import type { ExecutionState } from './execution-state';
import { PausedComputerWork, pausedWorkReply } from './pending-work';
import { isComputerRecoveryRead } from './recovery-reads';

const MAX_PAUSE_WAIT_MS = 15_000;

export function createComputerCommandQueue(options: {
  coordinator: ComputerUseCoordinator;
  execution: ExecutionState;
  sessionIdFor(command: ComputerCommand): string;
  runCommand(command: ComputerCommand): Promise<ComputerCommandResult>;
  recaptureRequiredReply(command: ComputerCommand, error: unknown): Promise<ComputerCommandResult | null>;
  takeOver(reason: string): void;
  recordDiagnostic?: (sessionId: string, record: Record<string, unknown>) => void;
  /** Internal/test seam; never changes the user's idle-resume setting. */
  pauseWaitMs?: number;
}) {
  const { coordinator, execution, sessionIdFor, runCommand } = options;
  const { commandChainsBySession, sessionAbortEpochs } = execution;
  const budget = createComputerCommandBudget();
  const pauseWaitMs = options.pauseWaitMs ?? MAX_PAUSE_WAIT_MS;
  if (!Number.isFinite(pauseWaitMs) || pauseWaitMs < 0 || pauseWaitMs > MAX_PAUSE_WAIT_MS) {
    throw new Error('computer_pause_wait_invalid: paused request wait must be 0..15000ms');
  }
  const gate = createPauseGate(coordinator, sessionAbortEpochs);
  const lane = createForegroundLane(coordinator);
  const { executeAttempt } = createCommandAttempt({
    coordinator,
    execution,
    sessionIdFor,
    runCommand,
    recaptureRequiredReply: options.recaptureRequiredReply,
    takeOver: options.takeOver,
    recordDiagnostic: options.recordDiagnostic,
    assertEpoch: gate.assertEpoch,
    runForegroundExclusive: lane.runForegroundExclusive,
  });
  const active = new Set<Promise<void>>();

  /** Attempts until one settles. A pause parks the request, keeping only its
   *  progress, and retries once the desktop is handed back; waiting out the
   *  pause budget answers with a paused reply instead. */
  async function attemptUntilSettled(
    command: ComputerCommand,
    sessionId: string,
    epoch: number,
    generation: number,
    pauseDeadline: number
  ): Promise<ComputerCommandResult> {
    let pending: PausedComputerWork | undefined;
    for (;;) {
      try {
        await gate.waitUntilRunnable(sessionId, epoch, pauseDeadline);
      } catch (error) {
        if (!(error instanceof PauseWaitExpired)) throw error;
        options.recordDiagnostic?.(sessionId, {
          action: command.action,
          stage: 'paused',
          ok: true,
          input_replayed: false,
        });
        return pausedWorkReply(
          command,
          pending?.progress || { completed: 0 },
          coordinator.snapshot().takeoverReason || 'user_pause'
        );
      }
      gate.assertEpoch(sessionId, epoch);
      // A pause can arrive between the waiter resolving and this continuation.
      if (coordinator.snapshot().userControlActive) continue;
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      active.add(settled);
      try {
        return await executeAttempt(command, epoch, generation, pending);
      } catch (error) {
        if (error instanceof PausedComputerWork) pending = error;
        else if (!(error instanceof PausedBeforeDispatch)) throw error;
      } finally {
        active.delete(settled);
        finish();
      }
    }
  }

  function executeSerialized(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = sessionIdFor(command);
    // Probes and lifecycle controls must never sit behind a parked request.
    if (isComputerLifecycleControl(command)) return runCommand(command);
    const releaseBudget = budget.acquire(sessionId);
    if (coordinator.snapshot().userControlActive && isComputerRecoveryRead(String(command.action))) {
      return Promise.resolve()
        .then(() => runCommand(command))
        .finally(releaseBudget);
    }
    const epoch = sessionAbortEpochs.get(sessionId) || 0;
    const snapshot = coordinator.snapshot();
    const generation = snapshot.userControlActive ? -1 : (snapshot.takeoverGeneration ?? 0);
    const pauseDeadline = performance.now() + pauseWaitMs;
    coordinator.queueCommand({
      sessionId,
      action: String(command.action || 'computer'),
      target: String(command.window || command.window_id || command.app || ''),
      mode: requiresForegroundLane(command) ? 'foreground' : 'background',
    });
    coordinator.touchTargets(sessionId);
    const previous = commandChainsBySession.get(sessionId) || Promise.resolve();
    const run = previous.then(() => attemptUntilSettled(command, sessionId, epoch, generation, pauseDeadline));
    const tail = run.then(
      () => {},
      () => {}
    );
    commandChainsBySession.set(sessionId, tail);
    void tail.then(() => {
      releaseBudget();
      if (commandChainsBySession.get(sessionId) === tail) {
        commandChainsBySession.delete(sessionId);
        sessionAbortEpochs.delete(sessionId);
        // A command finishing is not the agent task finishing. The runtime's
        // execution_end/session_abort closes visible activity at turn settlement.
        // In particular, waiting and thinking between commands retain the task.
      }
    });
    return run;
  }

  return {
    executeSerialized,
    runForegroundExclusive: lane.runForegroundExclusive,
    cancelSession: gate.cancelSession,
    drainActive: () => Promise.all([...active]),
  };
}
