/**
 * Resident workers stay warm after a session's last command, but not forever:
 * idle ones are reclaimed sooner under worker pressure, never while their
 * session still holds a target lease, and never by quietly retiring a worker
 * that still owes an input release — that one goes through the full abort
 * barrier.
 */
import { MAX_COMPUTER_WORKERS } from '../backend/worker-capacity';
import type { RetiredChild, SessionAbort } from './lifecycle-abort';
import type { LifecycleContext } from './session-lifecycle';

// Resident workers remain warm longer than target leases. A window lease is
// deliberately short-lived in the coordinator so an abandoned session
// cannot reserve a user's app for this whole worker-idle period.
const WORKER_IDLE_STALE_MS = 60_000;
// Near the worker limit the relaxed window is useless: the pool refuses the
// next session while its own finished ones stay warm, and a caller cannot
// release a session it does not own. Reclaim briefly idle workers instead.
const WORKER_IDLE_PRESSURE_MS = 5_000;
const WORKER_PRESSURE_COUNT = Math.ceil(MAX_COMPUTER_WORKERS * 0.75);

export function createWorkerReclaim(
  context: LifecycleContext,
  abortComputerSession: SessionAbort['abortComputerSession']
) {
  const { host, coordinator, execution, cleanupJobs } = context;
  const { activeExecutionsBySession, commandChainsBySession } = execution;

  function onSessionWorkerRetired(sessionId: string, child?: RetiredChild, interruptedInput = true): void {
    host.invalidateWorkerGeneration(sessionId);
    // A failed read invalidates refs, not the caller's entire capture. A new
    // worker may finish a pixel-only observation; it must never replay input.
    if (!interruptedInput) return;
    if (coordinator.hasPendingCleanup(sessionId)) return;
    void abortComputerSession({ action: 'session_abort', session_id: sessionId }, false, child).catch(() => {
      /* failed cleanup remains latched in the coordinator */
    });
  }

  function reapIdleSessionWorkers(now = Date.now()): void {
    // A finished command leaves its activity behind as "thinking" so the overlay
    // can show an idle session. Treating that as active exempted every session
    // that ever ran a command, so no idle worker was ever reclaimed.
    const activeSessions = new Set(
      coordinator
        .snapshot()
        .activities.filter((activity) => activity.phase !== 'thinking')
        .map((activity) => activity.sessionId)
    );
    for (const [sessionId, child] of host.powerShellBySession) {
      if (
        activeSessions.has(sessionId) ||
        activeExecutionsBySession.has(sessionId) ||
        commandChainsBySession.has(sessionId) ||
        cleanupJobs.has(sessionId)
      )
        continue;
      const idleLimit =
        host.powerShellBySession.size >= WORKER_PRESSURE_COUNT ? WORKER_IDLE_PRESSURE_MS : WORKER_IDLE_STALE_MS;
      if (now - (host.workerLastUsedAt.get(sessionId) || 0) < idleLimit) continue;
      // Under worker pressure this reclaim runs sooner than the lease grace
      // period. Releasing the process must not hand this session's reserved
      // windows to another agent while its claim is still valid.
      if (coordinator.hasLiveTargetLease(sessionId)) continue;
      if (host.hasUnconfirmedBackgroundInput?.(sessionId)) {
        // Input without a release receipt still owes the full cleanup barrier.
        void abortComputerSession({ action: 'session_abort', session_id: sessionId }, false, child).catch(() => {
          /* cleanup remains blocked until the host is replaced */
        });
        continue;
      }
      // Routine reclaim: an idle session holds no input, so retiring its worker
      // must not raise the global barrier that guards a user takeover — that
      // barrier refuses every other session's next command until it clears.
      host.retirePowerShell(child, new Error('computer_worker_reclaimed: idle session worker was released'));
      host.releaseSessionState(sessionId, host.releaseCaptureSession);
      coordinator.cancelSession(sessionId);
    }
  }

  return { onSessionWorkerRetired, reapIdleSessionWorkers };
}
