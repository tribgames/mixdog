/**
 * Taking the desktop away from every session at once — user takeover, Stop —
 * and the resume that hands it back. Stop is the way out of a latched cleanup
 * failure: it waits for every retired worker to actually exit, releases any
 * input the host still owns, and only that evidence clears the barrier; a
 * click alone never does.
 */
import { HOST_WARMUP_SESSION_ID } from './action-sets';
import type { createComputerCommandQueue } from './command-queue';
import { cleanupAbortedInput, type SessionAbort } from './lifecycle-abort';
import { waitForResumeBarrier } from './resume-barrier';
import type { LifecycleContext } from './session-lifecycle';

/** Stop holds this long for retired workers to actually exit before it may
 *  declare the host quiet. */
const STOP_WORKER_EXIT_TIMEOUT_MS = 5_000;

type CommandQueue = ReturnType<typeof createComputerCommandQueue>;

export function createSessionStop(
  context: LifecycleContext,
  queue: Pick<CommandQueue, 'drainActive'>,
  abortComputerSession: SessionAbort['abortComputerSession']
) {
  const { host, coordinator, execution, cleanupJobs } = context;
  const { activeExecutionsBySession, commandChainsBySession } = execution;

  function takeOverComputer(reason = 'user_takeover'): void {
    const queuedOrActiveSessionIds = new Set([...commandChainsBySession.keys(), ...activeExecutionsBySession.keys()]);
    const sessionIds = new Set([
      ...coordinator.pauseForUser(reason, queuedOrActiveSessionIds),
      ...queuedOrActiveSessionIds,
    ]);
    for (const sessionId of sessionIds) {
      void abortComputerSession(
        { action: 'session_abort', session_id: sessionId },
        false,
        undefined,
        reason === 'user_input_active' || reason === 'user_pause'
      ).catch(() => {
        console.warn('computer_abort_cleanup_unconfirmed: user takeover cancellation failed');
      });
    }
  }

  async function recoverLatchedCleanup(): Promise<void> {
    const workersExited = host.waitForResidentWorkersExit
      ? await host.waitForResidentWorkersExit(STOP_WORKER_EXIT_TIMEOUT_MS)
      : true;
    if (!workersExited || host.elevatedSessionIds().length > 0) {
      throw new Error(
        'computer_abort_cleanup_unconfirmed: input workers are still running; press Ctrl+Alt+Esc (emergency Stop) again once they exit'
      );
    }
    if (!(await cleanupAbortedInput(host, undefined, false, true))) {
      throw new Error('computer_abort_cleanup_unconfirmed: held input could not be released');
    }
    // The global ownership ledger cannot prove a target-local window message
    // released its key/button. Worker exit must not erase that uncertainty.
    if (host.hasUnconfirmedBackgroundInput?.()) {
      throw new Error(
        'computer_background_cleanup_unconfirmed: target-local input release is unconfirmed; user recovery of the affected window is required before an approved host restart'
      );
    }
    if (!coordinator.clearFailedCleanup()) {
      throw new Error(
        'computer_cleanup_pending: a session cleanup is still running; press Ctrl+Alt+Esc (emergency Stop) again'
      );
    }
  }

  async function stopAllComputerSessions(resume = true, turnsStopped?: Promise<void>): Promise<void> {
    const generation = coordinator.snapshot().takeoverGeneration;
    const sessionIds = new Set([
      ...host.powerShellBySession.keys(),
      ...host.elevatedSessionIds(),
      ...activeExecutionsBySession.keys(),
      ...commandChainsBySession.keys(),
      ...cleanupJobs.keys(),
      ...(coordinator.snapshot().pausedSessionIds ?? []),
      ...coordinator.snapshot().activities.map((activity) => activity.sessionId),
    ]);
    const stopNative = async (): Promise<void> => {
      const stopped = await Promise.allSettled(
        [...sessionIds]
          .filter((sessionId) => sessionId !== HOST_WARMUP_SESSION_ID)
          .map((sessionId) => abortComputerSession({ action: 'session_abort', session_id: sessionId }))
      );
      if (stopped.some((result) => result.status === 'rejected') || coordinator.snapshot().cleanupState === 'failed') {
        await recoverLatchedCleanup();
      }
    };
    // Daemon cancellation cannot serialize or bypass native cleanup. Either
    // failure keeps the pause latched, including late replies after a timeout.
    await Promise.all([stopNative(), turnsStopped]);
    if (resume) coordinator.resumeAfterUserTakeover(generation);
  }

  async function resumeAfterTakeover(
    generation: number,
    signal?: AbortSignal,
    recheck?: () => Promise<boolean>
  ): Promise<void> {
    const snapshot = coordinator.snapshot();
    if (!snapshot.userControlActive || snapshot.takeoverGeneration !== generation) {
      throw new Error('computer_resume_stale: use the current user resume control');
    }
    await waitForResumeBarrier(
      Promise.all([...cleanupJobs.values()]).then(() => queue.drainActive()),
      signal
    );
    if (recheck && !(await recheck())) throw new Error('computer_resume_stale: input changed while resuming');
    if (signal?.aborted) throw new Error('computer_resume_cancelled: resume request cancelled');
    if (!coordinator.snapshot().userControlActive || coordinator.snapshot().takeoverGeneration !== generation) {
      throw new Error('computer_resume_stale: another interruption superseded the resume request');
    }
    // Cleanup may finish before a late read/capture continuation. Discard
    // that generation's observations again, never replay its commands.
    for (const sessionId of snapshot.pausedSessionIds ?? []) {
      host.releaseSessionState(sessionId, host.releaseCaptureSession);
    }
    coordinator.resumeAfterUserTakeover(generation);
  }

  async function waitForCleanup(): Promise<boolean> {
    const results = await Promise.allSettled([...cleanupJobs.values()]);
    return results.every((result) => result.status === 'fulfilled');
  }

  return { takeOverComputer, stopAllComputerSessions, resumeAfterTakeover, waitForCleanup };
}
