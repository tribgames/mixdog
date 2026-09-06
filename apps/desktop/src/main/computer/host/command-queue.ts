import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import type { ComputerUseCoordinator } from '../session/coordinator';
import { computerResultLastNumber, queuedForegroundRequiresRecapture } from '../session/coordinator';
import { appendComputerRunRecord, computerRunRecord } from '../session/run-log';
import { computerLogError } from '../session/log-privacy';
import { assertSafeComputerSessionId } from '../input/guards';
import { beginComputerOperation } from '../../human-only-approval';
import { isComputerLifecycleControl, READ_ACTIONS, requiresForegroundLane } from './action-sets';
import { isComputerRecoveryRead } from './recovery-reads';
import { createComputerCommandBudget } from './command-budget';
import type { ExecutionState } from './execution-state';

class PausedBeforeDispatch extends Error {}

/** Park requests outside the desktop lane and the active-operation drain.
 * A queued mutation resumes with fresh evidence, never with its old input. */
export function createComputerCommandQueue(options: {
  coordinator: ComputerUseCoordinator;
  execution: ExecutionState;
  sessionIdFor(command: ComputerCommand): string;
  runCommand(command: ComputerCommand): Promise<ComputerCommandResult>;
  recaptureRequiredReply(command: ComputerCommand, error: unknown): Promise<ComputerCommandResult | null>;
  takeOver(reason: string): void;
  recordDiagnostic?: (sessionId: string, record: Record<string, unknown>) => void;
}) {
  const { coordinator, execution, sessionIdFor, runCommand, recaptureRequiredReply } = options;
  const { commandChainsBySession, sessionAbortEpochs, activeExecutionsBySession, executionContext } = execution;
  const budget = createComputerCommandBudget();
  const wakeups = new Map<string, Set<() => void>>();
  const active = new Set<Promise<void>>();
  let foregroundChain: Promise<unknown> = Promise.resolve();
  let foregroundQueueDepth = 0;
  let lastInjectionTick: number | null = null;

  function assertEpoch(sessionId: string, epoch: number): void {
    if ((sessionAbortEpochs.get(sessionId) || 0) !== epoch) {
      throw new Error('computer_session_aborted: queued command was cancelled before execution');
    }
  }

  function waitUntilRunnable(sessionId: string, epoch: number): Promise<void> {
    assertEpoch(sessionId, epoch);
    const snapshot = coordinator.snapshot();
    if (!snapshot.userControlActive) {
      coordinator.assertAutomationAllowed();
      return Promise.resolve();
    }
    if (!['user_input_active', 'user_pause'].includes(snapshot.takeoverReason || '')) {
      coordinator.assertAutomationAllowed();
    }
    return new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      const callbacks = wakeups.get(sessionId) || new Set<() => void>();
      const finish = (error?: unknown) => {
        unsubscribe();
        callbacks.delete(check);
        if (!callbacks.size) wakeups.delete(sessionId);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        try {
          assertEpoch(sessionId, epoch);
          const current = coordinator.snapshot();
          if (current.userControlActive) return;
          coordinator.assertAutomationAllowed();
          finish();
        } catch (error) { finish(error); }
      };
      callbacks.add(check);
      wakeups.set(sessionId, callbacks);
      unsubscribe = coordinator.subscribe(check);
      check();
    });
  }

  function cancelSession(sessionId: string): void {
    sessionAbortEpochs.set(sessionId, (sessionAbortEpochs.get(sessionId) || 0) + 1);
    for (const wake of [...(wakeups.get(sessionId) || [])]) wake();
  }

  function runForegroundExclusive<T>(
    sessionId: string,
    operation: () => Promise<T>,
    settings: { requireFreshAfterWait?: boolean; assertRunnable?: () => void; allowWhileUserControl?: boolean } = {},
  ): Promise<T> {
    const queuePosition = foregroundQueueDepth++;
    if (queuePosition > 0) coordinator.queueForeground(sessionId, queuePosition);
    const run = foregroundChain.then(async () => {
      try {
        settings.assertRunnable?.();
        if (!settings.allowWhileUserControl) {
          if (coordinator.snapshot().userControlActive) throw new PausedBeforeDispatch();
          coordinator.assertAutomationAllowed();
        }
        coordinator.activateForeground(sessionId);
        if (settings.requireFreshAfterWait !== false && queuedForegroundRequiresRecapture(queuePosition)) {
          throw new Error('computer_foreground_available_recapture_required: desktop lane changed; capture fresh state');
        }
        return await operation();
      } finally { foregroundQueueDepth = Math.max(0, foregroundQueueDepth - 1); }
    });
    foregroundChain = run.catch(() => undefined);
    return run;
  }

  async function executeAttempt(command: ComputerCommand, epoch: number, generation: number): Promise<ComputerCommandResult> {
    const sessionId = sessionIdFor(command);
    const foreground = requiresForegroundLane(command);
    const releaseApproval = beginComputerOperation();
    const state = { sessionId, aborted: false };
    const startedAt = performance.now();
    const assertRunnable = () => {
      assertEpoch(sessionId, epoch);
      if (state.aborted) throw new Error('computer_session_aborted: command stopped by session cancellation');
    };
    try {
      const operation = async () => {
        assertRunnable();
        coordinator.beginCommand({
          sessionId, action: String(command.action || 'computer'),
          target: String(command.window || command.window_id || command.app || ''),
          mode: foreground ? 'foreground' : 'background',
        });
        activeExecutionsBySession.set(sessionId, state);
        return executionContext.run(state, async () => {
          if (generation !== coordinator.snapshot().takeoverGeneration
            && !READ_ACTIONS.has(String(command.action)) && !isComputerRecoveryRead(String(command.action))) {
            throw new Error('computer_resume_recapture_required: queued work resumed; review the fresh target before sending new input');
          }
          return runCommand(foreground && lastInjectionTick !== null
            ? { ...command, known_injection_tick: lastInjectionTick } : command);
        });
      };
      const outcome = foreground
        ? await runForegroundExclusive(sessionId, operation, { assertRunnable })
        : await operation();
      assertRunnable();
      coordinator.assertAutomationAllowed();
      if (foreground) {
        const tick = computerResultLastNumber(outcome.text, 'injection_tick');
        if (tick !== null) lastInjectionTick = tick;
      }
      const record = computerRunRecord(command, startedAt, outcome);
      appendComputerRunRecord(sessionId, record);
      options.recordDiagnostic?.(sessionId, { ...record, stage: 'completed' });
      return outcome;
    } catch (error) {
      if (error instanceof PausedBeforeDispatch) throw error;
      const code = computerLogError(error);
      if (['user_input_active', 'input_cleanup_unconfirmed', 'input_observation_unavailable'].includes(code)) {
        options.takeOver(code);
      }
      const record = { ...computerRunRecord(command, startedAt), ok: false, error: code };
      appendComputerRunRecord(sessionId, record);
      let recapture: ComputerCommandResult | null = null;
      try {
        // The recovery capture is an active operation too, so Stop and Resume
        // cannot race a late observation into the next generation.
        if (!coordinator.snapshot().userControlActive) {
          assertRunnable();
          activeExecutionsBySession.set(sessionId, state);
          recapture = await executionContext.run(state, () => recaptureRequiredReply(command, error));
          assertRunnable();
          coordinator.assertAutomationAllowed();
        }
      } finally {
        options.recordDiagnostic?.(sessionId, {
          ...record, stage: 'execution', input_recovery: { recapture_available: recapture !== null },
        });
      }
      if (recapture) return recapture;
      throw error;
    } finally {
      if (activeExecutionsBySession.get(sessionId) === state) activeExecutionsBySession.delete(sessionId);
      coordinator.finishCommand(sessionId);
      releaseApproval();
    }
  }

  function executeSerialized(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = sessionIdFor(command);
    // Probes and lifecycle controls must never sit behind a parked request.
    if (isComputerLifecycleControl(command)) return runCommand(command);
    const releaseBudget = budget.acquire(sessionId);
    if (coordinator.snapshot().userControlActive && isComputerRecoveryRead(String(command.action))) {
      return Promise.resolve().then(() => runCommand(command)).finally(releaseBudget);
    }
    const epoch = sessionAbortEpochs.get(sessionId) || 0;
    const snapshot = coordinator.snapshot();
    const generation = snapshot.userControlActive ? -1 : snapshot.takeoverGeneration ?? 0;
    coordinator.queueCommand({
      sessionId, action: String(command.action || 'computer'),
      target: String(command.window || command.window_id || command.app || ''),
      mode: requiresForegroundLane(command) ? 'foreground' : 'background',
    });
    coordinator.touchTargets(sessionId);
    const previous = commandChainsBySession.get(sessionId) || Promise.resolve();
    const run = previous.then(async () => {
      for (;;) {
        await waitUntilRunnable(sessionId, epoch);
        assertEpoch(sessionId, epoch);
        // A pause can arrive between the waiter resolving and this continuation.
        if (coordinator.snapshot().userControlActive) continue;
        let finish!: () => void;
        const settled = new Promise<void>((resolve) => { finish = resolve; });
        active.add(settled);
        try {
          return await executeAttempt(command, epoch, generation);
        } catch (error) {
          if (!(error instanceof PausedBeforeDispatch)) throw error;
        } finally {
          active.delete(settled);
          finish();
        }
      }
    });
    const tail = run.then(() => {}, () => {});
    commandChainsBySession.set(sessionId, tail);
    void tail.then(() => {
      releaseBudget();
      if (commandChainsBySession.get(sessionId) === tail) {
        commandChainsBySession.delete(sessionId);
        sessionAbortEpochs.delete(sessionId);
      }
    });
    return run;
  }

  return {
    executeSerialized, runForegroundExclusive, cancelSession,
    drainActive: () => Promise.all([...active]),
  };
}
