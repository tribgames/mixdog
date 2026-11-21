import { MAX_COMPUTER_WORKERS } from '../backend/worker-capacity';
import { restoreSessionDesktop, type RetiredChild, type SessionAbort } from './lifecycle-abort';
import type { LifecycleContext } from './session-lifecycle';

// An agent routinely thinks for one to five minutes between commands.
const WORKER_IDLE_STALE_MS = 300_000;
// Near the worker limit the relaxed window is useless: the pool refuses the
// next session while its own finished ones stay warm, and a caller cannot
// release a session it does not own. Reclaim briefly idle workers instead.
const WORKER_IDLE_PRESSURE_MS = 5_000;
const WORKER_PRESSURE_COUNT = Math.ceil(MAX_COMPUTER_WORKERS * 0.75);

export function createWorkerReclaim(
  context: LifecycleContext,
  queue: Parameters<typeof restoreSessionDesktop>[1],
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
      const retire = () => {
        host.retirePowerShell(child, new Error('computer_worker_reclaimed: idle session worker was released'));
        host.releaseSessionState(sessionId, host.releaseCaptureSession);
        coordinator.cancelSession(sessionId);
      };
      const restore = restoreSessionDesktop(context, queue, sessionId);
      if (restore) void restore.finally(retire);
      else retire();
    }
  }

  return { onSessionWorkerRetired, reapIdleSessionWorkers };
}
