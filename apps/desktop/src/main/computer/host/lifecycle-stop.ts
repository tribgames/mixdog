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
  // A Stop that could not confirm its cleanup leaves nothing on screen: the
  // pill closed with the press. The next command retries that recovery once
  // and fails with its reason if it still cannot.
  let stopUnconfirmed = false;
  let recovering: Promise<void> | undefined;

  function takeOverComputer(reason = 'user_takeover'): void {
    const queuedOrActiveSessionIds = new Set([...commandChainsBySession.keys(), ...activeExecutionsBySession.keys()]);
    const sessionIds = new Set([
      ...coordinator.pauseForUser(reason, queuedOrActiveSessionIds),
      ...queuedOrActiveSessionIds,
    ]);
    const aborted = [...sessionIds].map((sessionId) =>
      abortComputerSession(
        { action: 'session_abort', session_id: sessionId },
        false,
        undefined,
        reason === 'user_pause'
      )
    );
    // A worker killed mid-call takes seconds to unwind, so its first cleanup
    // frequently fails on that timing alone while the input it owned is already
    // free — and an interruption that arrived before any input was sent has
    // nothing to release at all. Latching there would make the user clear a
    // barrier the host can clear itself. Run exactly the evidence Stop demands,
    // once: worker exit, owned-input release, and target-local certainty. Only a
    // second failure is left for the user, because only then is the uncertainty
    // real rather than a matter of timing.
    void Promise.allSettled(aborted).then(async (results) => {
      if (!results.some((result) => result.status === 'rejected')) return;
      try {
        await recoverLatchedCleanup();
        coordinator.restoreTakeoverReason(reason);
      } catch {
        console.warn('computer_abort_cleanup_unconfirmed: user takeover cancellation failed');
      }
    });
  }

  /** `userAcknowledged`: the user pressed Stop/Resume, which acknowledges they
   *  have recovered the affected window, so the unconfirmed-release latches
   *  clear once the sweep below confirms. Automatic recoveries never do. */
  async function recoverLatchedCleanup(userAcknowledged = false): Promise<void> {
    // An idle resident worker never exits on its own — the warmup worker, or
    // one a recovery read just started. Waiting for it is a guaranteed timeout,
    // so retire every worker no command is running on before demanding exit.
    for (const [sessionId, child] of [...host.powerShellBySession]) {
      if (activeExecutionsBySession.has(sessionId)) continue;
      host.retirePowerShell(child, new Error('computer_worker_reclaimed: cleanup recovery retired an idle worker'));
      host.releaseSessionState(sessionId, host.releaseCaptureSession);
    }
    const workersExited = host.waitForResidentWorkersExit
      ? await host.waitForResidentWorkersExit(STOP_WORKER_EXIT_TIMEOUT_MS)
      : true;
    // Workers have exited; unconfirmed elevated sessions would otherwise keep
    // listing as live. A still-pending elevated job is left in place, and so is
    // one whose launcher process is not verified gone (it stays listed below).
    if (workersExited && userAcknowledged) await host.releaseUnconfirmedElevated?.();
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
    if (userAcknowledged) host.clearUnconfirmedBackgroundInput?.();
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
        await recoverLatchedCleanup(resume);
      }
    };
    // Daemon cancellation cannot serialize or bypass native cleanup. Either
    // failure keeps the pause latched, including late replies after a timeout.
    try {
      await Promise.all([stopNative(), turnsStopped]);
    } catch (error) {
      if (resume) stopUnconfirmed = true;
      throw error;
    }
    if (resume) {
      stopUnconfirmed = false;
      // Stop has ended every session, so it releases whatever pause is current:
      // aborting a latched session re-pauses (a newer generation) on its own.
      coordinator.resumeAfterUserTakeover(coordinator.snapshot().takeoverGeneration);
    }
  }

  /** Before a new command: an unconfirmed Stop, or a failed cleanup no paused
   *  task is waiting on, gets one more verified recovery. `null` when there is
   *  nothing to recover, so the command queues in the same tick as before. */
  function recoverBeforeCommand(): Promise<void> | null {
    const unattended = (snapshot: ReturnType<typeof coordinator.snapshot>) =>
      snapshot.activities.length === 0 && (snapshot.pausedSessionIds ?? []).length === 0;
    const snapshot = coordinator.snapshot();
    const orphanedFailure = snapshot.cleanupState === 'failed' && unattended(snapshot);
    if (!stopUnconfirmed && !orphanedFailure) return null;
    recovering ??= (async () => {
      await recoverLatchedCleanup();
      stopUnconfirmed = false;
      const current = coordinator.snapshot();
      if (current.userControlActive && unattended(current)) {
        coordinator.resumeAfterUserTakeover(current.takeoverGeneration);
      }
    })().finally(() => {
      recovering = undefined;
    });
    return recovering;
  }

  /** The overlay's Resume: a latched cleanup gets its verified recovery first,
   *  then the paused task continues from the generation the user saw. */
  async function resumeByUser(generation: number): Promise<void> {
    if (coordinator.snapshot().cleanupState === 'failed') await recoverLatchedCleanup(true);
    await resumeAfterTakeover(generation);
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

  return {
    takeOverComputer,
    stopAllComputerSessions,
    resumeAfterTakeover,
    resumeByUser,
    recoverBeforeCommand,
    waitForCleanup,
  };
}
