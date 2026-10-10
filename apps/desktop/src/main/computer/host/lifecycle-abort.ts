/**
 * Stopping one session's desktop work: retire its worker, wait for every
 * input worker to confirm exit, release whatever input the host still holds
 * through a fresh cleanup process, and only then give up the session's
 * targets. A cleanup that cannot confirm latches the coordinator's pause; an
 * unconfirmed release is never reported as a clean stop.
 */
import { spawn } from 'node:child_process';

import { computerNativeBinary, computerNativeEnvironment } from '../backend/native-host';
import { ABORT_CLEANUP_PROGRAM } from '../backend/program';
import { waitForComputerWorkerExit } from '../backend/worker-capacity';
import { assertSafeComputerSessionId } from '../input/guards';
import type { ComputerUseCoordinator } from '../session/coordinator';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import type { createComputerCommandQueue } from './command-queue';
import type { InputRecoveryState } from './execution-state';
import type { LifecycleContext, SessionLifecycleHost } from './session-lifecycle';

// Covers PowerShell's Add-Type compile plus the sweep's 2 s wait for the
// user's own keys (the Stop chord) to lift.
const ABORT_CLEANUP_TIMEOUT_MS = 7_000;

export type RetiredChild = Parameters<typeof waitForComputerWorkerExit>[0];
type CommandQueue = ReturnType<typeof createComputerCommandQueue>;

/** `sweep` runs the owned-input release even without a recorded target:
 *  Stop's recovery must release whatever the host still holds. */
export async function cleanupAbortedInput(
  host: Pick<
    SessionLifecycleHost,
    'cleanupInput' | 'inputMarker' | 'pendingInactiveLedgers' | 'inactiveLedgersRecovered'
  >,
  recovery?: InputRecoveryState,
  restoreDesktop = true,
  sweep = false
): Promise<boolean> {
  if (host.cleanupInput) return host.cleanupInput(recovery, restoreDesktop, sweep);
  // Exited workers' inactive-window ledgers are cleared whatever the restore
  // settings or foreground state.
  const ledgers = process.platform === 'win32' ? (host.pendingInactiveLedgers?.() ?? []) : [];
  if (!sweep && !recovery?.targetWindowId && ledgers.length === 0) return true;
  const confirmed = await new Promise<boolean>((resolve) => {
    const abortEnvironment = {
      MIXDOG_ABORT_LEDGERS: ledgers.join('|'),
      MIXDOG_ABORT_TARGET: restoreDesktop ? recovery?.targetWindowId || '' : '',
      MIXDOG_ABORT_RESTORE: restoreDesktop ? recovery?.restoreWindowId || '' : '',
      MIXDOG_ABORT_CURSOR_X: String(recovery?.cursorX ?? 0),
      MIXDOG_ABORT_CURSOR_Y: String(recovery?.cursorY ?? 0),
    };
    const child =
      process.platform === 'win32'
        ? spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ABORT_CLEANUP_PROGRAM],
            {
              windowsHide: true,
              stdio: 'ignore',
              env: { ...process.env, MIXDOG_COMPUTER_INPUT_MARKER: host.inputMarker, ...abortEnvironment },
            }
          )
        : spawn(computerNativeBinary(), ['--abort-cleanup'], {
            stdio: 'ignore',
            env: computerNativeEnvironment(host.inputMarker, abortEnvironment),
          });
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(confirmed);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish(false);
    }, ABORT_CLEANUP_TIMEOUT_MS);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
  if (confirmed) host.inactiveLedgersRecovered?.(ledgers);
  return confirmed;
}

/** The session's desktop restore, at turn end or release: the focus and pointer
 *  of its restore point go back once, unless the user touched the desktop
 *  since — the observer sequence the restore asserts is the one recorded then.
 *  Needs the session's idle live worker; a failed restore never blocks release.
 *  It moves the one focus and pointer, so it takes the foreground lane, and the
 *  worker refuses when the foreground is no longer a window this session held.
 *  `null` when there is nothing to restore, so the caller stays synchronous. */
export function restoreSessionDesktop(
  context: Pick<LifecycleContext, 'host' | 'coordinator' | 'execution'>,
  lane: Pick<CommandQueue, 'runForegroundExclusive'>,
  sessionId: string
): Promise<void> | null {
  const { host, coordinator, execution } = context;
  const anchor = execution.sessionDesktopAnchor.get(sessionId);
  if (!anchor) return null;
  execution.sessionDesktopAnchor.delete(sessionId);
  const heldWindowIds = [anchor.targetWindowId, anchor.heldWindowId, ...(anchor.handedWindowIds ?? [])].filter(
    (id): id is string => Boolean(id)
  );
  // Another agent session still has the desktop: the last one to finish hands
  // it back, and may take focus from the windows this session leaves in front.
  const borrowing = [...execution.sessionDesktopAnchor.values()].filter((other) => !other.userOwned);
  if (borrowing.length > 0) {
    if (!anchor.userOwned) {
      for (const other of borrowing) {
        other.handedWindowIds = [...new Set([...(other.handedWindowIds ?? []), ...heldWindowIds])];
      }
    }
    return null;
  }
  const child = host.powerShellBySession.get(sessionId);
  if (
    anchor.userOwned ||
    !child ||
    child.killed ||
    execution.activeExecutionsBySession.has(sessionId) ||
    coordinator.snapshot().userControlActive
  ) {
    return null;
  }
  const { recovery } = anchor;
  return lane
    .runForegroundExclusive(
      sessionId,
      () =>
        host.callPowerShell({
          action: 'restore_input_state',
          window_id: anchor.targetWindowId,
          held_window_ids: heldWindowIds,
          restore_window_id: recovery.restoreWindowId,
          restore_owner_window_id: recovery.restoreOwnerWindowId,
          cursor_x: recovery.cursorX,
          cursor_y: recovery.cursorY,
          restore_focus: true,
          expected_input_monitor_id: recovery.inputMonitorId,
          expected_input_user_sequence: recovery.inputUserSequence,
          session_id: sessionId,
        }),
      { requireFreshAfterWait: false }
    )
    .then(
      () => undefined,
      () => {
        /* user input, another window in front, or a pause: the desktop is no longer ours to move */
      }
    );
}

/** Cleanup that cannot prove the input was released pauses the desktop for
 *  the user and fails the abort with the reason. */
function unconfirmedCleanup(coordinator: ComputerUseCoordinator, sessionId: string, message: string): never {
  coordinator.pauseForUser('input_cleanup_unconfirmed', [sessionId]);
  throw new Error(message);
}

export function createSessionAbort(
  context: LifecycleContext,
  queue: Pick<CommandQueue, 'cancelSession' | 'runForegroundExclusive'>
) {
  const { host, coordinator, execution, cleanupJobs } = context;
  const { activeExecutionsBySession, sessionAbortEpochs, sessionRecoveryBySession, commandChainsBySession } = execution;

  async function runAbortCleanup(
    sessionId: string,
    restoreDesktop: boolean,
    retiredChild?: RetiredChild,
    sweep = false
  ): Promise<ComputerCommandResult> {
    // Before the cleanup barrier: the restore is the session's last foreground
    // work, and the lane refuses automation once a cleanup is pending.
    const restore = restoreSessionDesktop(context, queue, sessionId);
    if (restore) await restore;
    const finishCleanup = coordinator.beginCleanup(sessionId);
    let confirmed = false;
    try {
      const activeExecution = activeExecutionsBySession.get(sessionId);
      const recovery = activeExecution?.recovery || sessionRecoveryBySession.get(sessionId);
      if (activeExecution) activeExecution.aborted = true;
      const elevatedStopped = host.cancelElevatedSession(sessionId);
      const child = retiredChild || host.powerShellBySession.get(sessionId);
      if (child && !child.killed) {
        host.retirePowerShell(
          child as NonNullable<ReturnType<typeof host.powerShellBySession.get>>,
          new Error('computer_session_aborted: command stopped by session cancellation')
        );
      }
      const residentStopped = waitForComputerWorkerExit(child);
      activeExecutionsBySession.delete(sessionId);
      host.releaseSessionState(sessionId, host.releaseCaptureSession);
      const stopped = await Promise.all([elevatedStopped, residentStopped]);
      if (!stopped.every(Boolean)) {
        unconfirmedCleanup(
          coordinator,
          sessionId,
          'computer_abort_cleanup_unconfirmed: input workers have not confirmed termination'
        );
      }
      if (host.hasUnconfirmedBackgroundInput?.(sessionId)) {
        unconfirmedCleanup(
          coordinator,
          sessionId,
          'computer_abort_cleanup_unconfirmed: background message sender stopped without a release receipt; input may remain held'
        );
      }
      const cleaned = await queue.runForegroundExclusive(
        sessionId,
        () => cleanupAbortedInput(host, recovery, restoreDesktop, sweep),
        { requireFreshAfterWait: false, allowWhileUserControl: true }
      );
      if (!cleaned) {
        unconfirmedCleanup(
          coordinator,
          sessionId,
          'computer_abort_cleanup_unconfirmed: input cleanup did not finish successfully'
        );
      }
      confirmed = true;
      sessionRecoveryBySession.delete(sessionId);
      coordinator.cancelSession(sessionId);
      if (!commandChainsBySession.has(sessionId)) sessionAbortEpochs.delete(sessionId);
      return { text: 'computer session aborted; input state and session resources were released' };
    } finally {
      finishCleanup(confirmed);
      host.recordDiagnostic?.(sessionId, {
        action: 'session_abort',
        stage: 'cleanup',
        ok: confirmed,
        input_recovery: { ok: confirmed },
      });
    }
  }

  /** One cleanup job per session; concurrent aborts share it. `sweep` releases
   *  input the host still owns even without a recorded target. */
  async function abortComputerSession(
    command: ComputerCommand,
    restoreDesktop = false,
    retiredChild?: RetiredChild,
    preserveQueued = false,
    sweep = false
  ): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = host.sessionIdFor(command);
    // Stop must cancel parked requests even when pause cleanup is already running.
    if (!preserveQueued) queue.cancelSession(sessionId);
    const existing = cleanupJobs.get(sessionId);
    if (existing) return existing;
    const job = runAbortCleanup(sessionId, restoreDesktop, retiredChild, sweep);
    cleanupJobs.set(sessionId, job);
    try {
      return await job;
    } finally {
      if (cleanupJobs.get(sessionId) === job) cleanupJobs.delete(sessionId);
    }
  }

  async function releaseComputerSession(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = host.sessionIdFor(command);
    const child = host.powerShellBySession.get(sessionId);
    try {
      if (child && !child.killed && !coordinator.snapshot().userControlActive) {
        await host.callPowerShell({
          action: 'release_session',
          session_id: sessionId,
          read_only: false,
        });
      }
    } finally {
      await abortComputerSession({ action: 'session_abort', session_id: sessionId }, false, child);
    }
    return { text: 'computer session released' };
  }

  return { abortComputerSession, releaseComputerSession };
}

export type SessionAbort = ReturnType<typeof createSessionAbort>;
