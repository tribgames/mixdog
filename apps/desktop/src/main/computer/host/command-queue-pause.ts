/**
 * The gate a queued command waits at while the user holds the desktop. A
 * user-initiated pause parks the request until the desktop is handed back or
 * the pause budget runs out; any other takeover refuses automation outright.
 * Cancelling a session bumps its abort epoch and wakes every waiter so a
 * parked request fails instead of running against a dead session.
 */
import type { ComputerUseCoordinator } from '../session/coordinator';
import type { ExecutionState } from './execution-state';

export class PauseWaitExpired extends Error {}

type CoordinatorSnapshot = ReturnType<ComputerUseCoordinator['snapshot']>;

const USER_PAUSE_REASONS = ['user_input_active', 'user_pause'];

/** The user is holding the desktop and expects work to resume afterwards. */
export function pausedForUserInput(snapshot: CoordinatorSnapshot): boolean {
  return snapshot.userControlActive && USER_PAUSE_REASONS.includes(snapshot.takeoverReason || '');
}

export function createPauseGate(
  coordinator: ComputerUseCoordinator,
  sessionAbortEpochs: ExecutionState['sessionAbortEpochs']
) {
  const wakeups = new Map<string, Set<() => void>>();

  function assertEpoch(sessionId: string, epoch: number): void {
    if ((sessionAbortEpochs.get(sessionId) || 0) !== epoch) {
      throw new Error('computer_session_aborted: queued command was cancelled before execution');
    }
  }

  function waitUntilRunnable(sessionId: string, epoch: number, deadline: number): Promise<void> {
    assertEpoch(sessionId, epoch);
    const snapshot = coordinator.snapshot();
    if (!snapshot.userControlActive) {
      coordinator.assertAutomationAllowed();
      return Promise.resolve();
    }
    if (!pausedForUserInput(snapshot)) {
      coordinator.assertAutomationAllowed();
    }
    return new Promise<void>((resolve, reject) => {
      let unsubscribe = () => {};
      let settled = false;
      const callbacks = wakeups.get(sessionId) || new Set<() => void>();
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        callbacks.delete(check);
        if (!callbacks.size) wakeups.delete(sessionId);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (settled) return;
        try {
          assertEpoch(sessionId, epoch);
          const current = coordinator.snapshot();
          if (current.userControlActive) {
            if (!pausedForUserInput(current)) {
              coordinator.assertAutomationAllowed();
            }
            return;
          }
          coordinator.assertAutomationAllowed();
          finish();
        } catch (error) {
          finish(error);
        }
      };
      callbacks.add(check);
      wakeups.set(sessionId, callbacks);
      const timer = setTimeout(
        () => {
          check();
          if (!settled) finish(new PauseWaitExpired());
        },
        Math.max(0, deadline - performance.now())
      );
      unsubscribe = coordinator.subscribe(check);
      if (settled) unsubscribe();
      check();
    });
  }

  function cancelSession(sessionId: string): void {
    sessionAbortEpochs.set(sessionId, (sessionAbortEpochs.get(sessionId) || 0) + 1);
    for (const wake of [...(wakeups.get(sessionId) || [])]) wake();
  }

  return { assertEpoch, waitUntilRunnable, cancelSession };
}

export type PauseGate = ReturnType<typeof createPauseGate>;
