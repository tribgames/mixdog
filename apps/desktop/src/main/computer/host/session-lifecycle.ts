/**
 * Session lifecycle for the Computer Use host: target leases, the per-session
 * command chain and the shared foreground lane, plus release, abort, takeover,
 * and idle reclamation. Everything that decides whether a command may run and
 * what happens to a session's desktop state when it stops lives here.
 */
import { spawn } from 'node:child_process';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { assertSafeComputerSessionId } from '../input/guards';
import { ABORT_CLEANUP_PROGRAM } from '../backend/program';
import { waitForComputerWorkerExit } from '../backend/worker-capacity';
import type { createWorkerPool } from '../backend/worker-pool';
import type { createSessionState } from '../session/state';
import type { createCaptureEngine } from '../observation/capture';
import {
  computerUseCoordinator as defaultCoordinator,
  type ComputerUseCoordinator,
} from '../session/coordinator';
import {
  HOST_WARMUP_SESSION_ID,
} from './action-sets';
import type { ExecutionState, InputRecoveryState } from './execution-state';
import { createComputerCommandQueue } from './command-queue';
import { waitForResumeBarrier } from './resume-barrier';

const ABORT_CLEANUP_TIMEOUT_MS = 5_000;
// Resident workers remain warm longer than target leases. A window lease is
// deliberately short-lived in the coordinator so an abandoned session
// cannot reserve a user's app for this whole worker-idle period.
const WORKER_IDLE_STALE_MS = 10 * 60_000;

type WorkerPool = ReturnType<typeof createWorkerPool>;
type SessionState = ReturnType<typeof createSessionState>;
type CaptureEngine = ReturnType<typeof createCaptureEngine>;

export interface SessionLifecycleHost extends
  Pick<WorkerPool, 'powerShellBySession' | 'workerLastUsedAt' | 'retirePowerShell' | 'callPowerShell' | 'cancelElevatedSession' | 'elevatedSessionIds'>,
  Pick<SessionState, 'sessionIdFor' | 'releaseSessionState' | 'invalidateWorkerGeneration'>,
  Pick<CaptureEngine, 'releaseCaptureSession'> {
  execution: ExecutionState;
  /** Late-bound: the router is composed after the lifecycle it depends on. */
  runCommand(command: ComputerCommand): Promise<ComputerCommandResult>;
  recaptureRequiredReply(command: ComputerCommand, error: unknown): Promise<ComputerCommandResult | null>;
  coordinator?: ComputerUseCoordinator;
  cleanupInput?: (recovery: InputRecoveryState | undefined, restoreDesktop: boolean) => Promise<boolean>;
  recordDiagnostic?: (sessionId: string, record: Record<string, unknown>) => void;
}

export function createSessionLifecycle(host: SessionLifecycleHost) {
  const computerUseCoordinator = host.coordinator || defaultCoordinator;
  const cleanupJobs = new Map<string, Promise<ComputerCommandResult>>();
  const {
    powerShellBySession,
    workerLastUsedAt,
    retirePowerShell,
    callPowerShell,
    cancelElevatedSession,
    elevatedSessionIds,
    sessionIdFor,
    releaseSessionState,
    invalidateWorkerGeneration,
    releaseCaptureSession,
    execution,
    runCommand,
    recaptureRequiredReply,
  } = host;
  const {
    activeExecutionsBySession,
    sessionAbortEpochs,
    sessionRecoveryBySession,
    commandChainsBySession,
  } = execution;
  const queue = createComputerCommandQueue({
    coordinator: computerUseCoordinator, execution, sessionIdFor, runCommand,
    recaptureRequiredReply, takeOver: takeOverComputer, recordDiagnostic: host.recordDiagnostic,
  });
  const { runForegroundExclusive, executeSerialized } = queue;

  function onSessionWorkerRetired(sessionId: string, child?: Parameters<typeof waitForComputerWorkerExit>[0]): void {
    invalidateWorkerGeneration(sessionId);
    if (computerUseCoordinator.hasPendingCleanup(sessionId)) return;
    void abortComputerSession({ action: 'session_abort', session_id: sessionId }, false, child)
      .catch(() => { /* failed cleanup remains latched in the coordinator */ });
  }

  function reapIdleSessionWorkers(now = Date.now()): void {
    for (const [sessionId, child] of powerShellBySession) {
      if (activeExecutionsBySession.has(sessionId)) continue;
      if (now - (workerLastUsedAt.get(sessionId) || 0) < WORKER_IDLE_STALE_MS) continue;
      void abortComputerSession({ action: 'session_abort', session_id: sessionId }, false, child)
        .catch(() => { /* cleanup remains blocked until the host is replaced */ });
    }
  }

  async function claimComputerTargets(
    command: ComputerCommand,
    windowIds: Array<string | undefined>,
  ): Promise<void> {
    const sessionId = sessionIdFor(command);
    const lease = await computerUseCoordinator.acquireTargets(sessionId, windowIds);
    if (lease.status === 'acquired') {
      if (lease.queued) {
        throw new Error(
          `computer_target_available_recapture_required: ${lease.windowIds.join(', ')} lease acquired`
          + ` after ${lease.waitedMs}ms; discard the stale action and capture fresh state`,
        );
      }
      return;
    }
    if (lease.status === 'user_takeover') {
      throw new Error('computer_user_takeover: queued target request was cancelled because the user took control');
    }
    if (lease.status === 'cancelled') {
      throw new Error('computer_session_aborted: queued target request was cancelled');
    }
    throw new Error(
      `computer_target_in_use: ${lease.windowIds.join(', ')} is reserved by another agent;`
      + ` queue_position=${lease.queuePosition}; retry from a fresh capture`,
    );
  }

  function releaseTargetClaims(sessionId: string): void {
    computerUseCoordinator.cancelSession(sessionId);
  }

  async function releaseComputerSession(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = sessionIdFor(command);
    const child = powerShellBySession.get(sessionId);
    try {
      if (child && !child.killed && !computerUseCoordinator.snapshot().userControlActive) {
        await callPowerShell({
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

  async function cleanupAbortedInput(recovery?: InputRecoveryState, restoreDesktop = true): Promise<boolean> {
    if (host.cleanupInput) return host.cleanupInput(recovery, restoreDesktop);
    if (!recovery?.targetWindowId) return true;
    return await new Promise<boolean>((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        ABORT_CLEANUP_PROGRAM,
      ], {
        windowsHide: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          MIXDOG_ABORT_TARGET: restoreDesktop ? recovery.targetWindowId : '',
          MIXDOG_ABORT_RESTORE: restoreDesktop ? recovery.restoreWindowId : '',
          MIXDOG_ABORT_CURSOR_X: String(recovery.cursorX),
          MIXDOG_ABORT_CURSOR_Y: String(recovery.cursorY),
        },
      });
      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(confirmed);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish(false);
      }, ABORT_CLEANUP_TIMEOUT_MS);
      child.once('error', () => finish(false));
      child.once('exit', (code) => finish(code === 0));
    });
  }

  async function abortComputerSession(
    command: ComputerCommand,
    restoreDesktop = false,
    retiredChild?: Parameters<typeof waitForComputerWorkerExit>[0],
    preserveQueued = false,
  ): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = sessionIdFor(command);
    // Stop must cancel parked requests even when pause cleanup is already running.
    if (!preserveQueued) queue.cancelSession(sessionId);
    const existing = cleanupJobs.get(sessionId);
    if (existing) return existing;
    const finishCleanup = computerUseCoordinator.beginCleanup(sessionId);
    const job = (async (): Promise<ComputerCommandResult> => {
    let confirmed = false;
    try {
    const activeExecution = activeExecutionsBySession.get(sessionId);
    const recovery = activeExecution?.recovery || sessionRecoveryBySession.get(sessionId);
    if (activeExecution) activeExecution.aborted = true;
    const elevatedStopped = cancelElevatedSession(sessionId);
    const child = retiredChild || powerShellBySession.get(sessionId);
    if (child && !child.killed) {
      retirePowerShell(child as NonNullable<ReturnType<typeof powerShellBySession.get>>, new Error('computer_session_aborted: command stopped by session cancellation'));
    }
    const residentStopped = waitForComputerWorkerExit(child);
    activeExecutionsBySession.delete(sessionId);
    releaseSessionState(sessionId, releaseCaptureSession);
    const stopped = await Promise.all([elevatedStopped, residentStopped]);
    if (!stopped.every(Boolean)) {
      computerUseCoordinator.pauseForUser('input_cleanup_unconfirmed', [sessionId]);
      throw new Error('computer_abort_cleanup_unconfirmed: input workers have not confirmed termination');
    }
    const cleaned = await runForegroundExclusive(
      sessionId,
      () => cleanupAbortedInput(recovery, restoreDesktop),
      { requireFreshAfterWait: false, allowWhileUserControl: true },
    );
    if (!cleaned) {
      computerUseCoordinator.pauseForUser('input_cleanup_unconfirmed', [sessionId]);
      throw new Error('computer_abort_cleanup_unconfirmed: input cleanup did not finish successfully');
    }
    confirmed = true;
    sessionRecoveryBySession.delete(sessionId);
    releaseTargetClaims(sessionId);
    if (!commandChainsBySession.has(sessionId)) sessionAbortEpochs.delete(sessionId);
    return { text: 'computer session aborted; input state and session resources were released' };
    } finally {
      finishCleanup(confirmed);
      host.recordDiagnostic?.(sessionId, {
        action: 'session_abort', stage: 'cleanup', ok: confirmed,
        input_recovery: { ok: confirmed },
      });
    }
    })();
    cleanupJobs.set(sessionId, job);
    try { return await job; }
    finally { if (cleanupJobs.get(sessionId) === job) cleanupJobs.delete(sessionId); }
  }

  function takeOverComputer(reason = 'user_takeover'): void {
    const queuedOrActiveSessionIds = new Set([
      ...commandChainsBySession.keys(),
      ...activeExecutionsBySession.keys(),
    ]);
    const sessionIds = new Set([
      ...computerUseCoordinator.pauseForUser(reason, queuedOrActiveSessionIds),
      ...queuedOrActiveSessionIds,
    ]);
    for (const sessionId of sessionIds) {
      void abortComputerSession(
        { action: 'session_abort', session_id: sessionId }, false, undefined,
        reason === 'user_input_active' || reason === 'user_pause',
      ).catch(() => {
        console.warn('computer_abort_cleanup_unconfirmed: user takeover cancellation failed');
      });
    }
  }

  async function stopAllComputerSessions(resume = true): Promise<void> {
    const generation = computerUseCoordinator.snapshot().takeoverGeneration;
    const sessionIds = new Set([
      ...powerShellBySession.keys(),
      ...elevatedSessionIds(),
      ...activeExecutionsBySession.keys(),
      ...commandChainsBySession.keys(),
      ...cleanupJobs.keys(),
      ...computerUseCoordinator.snapshot().activities.map((activity) => activity.sessionId),
    ]);
    const stopped = await Promise.allSettled([...sessionIds]
      .filter((sessionId) => sessionId !== HOST_WARMUP_SESSION_ID)
      .map((sessionId) => abortComputerSession({
        action: 'session_abort',
        session_id: sessionId,
      })));
    if (stopped.some((result) => result.status === 'rejected')) {
      throw new Error('computer_abort_cleanup_unconfirmed: not every session confirmed cleanup');
    }
    if (resume) computerUseCoordinator.resumeAfterUserTakeover(generation);
  }

  return {
    async resumeAfterTakeover(generation: number, signal?: AbortSignal, recheck?: () => Promise<boolean>): Promise<void> {
      const snapshot = computerUseCoordinator.snapshot();
      if (!snapshot.userControlActive || snapshot.takeoverGeneration !== generation) {
        throw new Error('computer_resume_stale: use the current user resume control');
      }
      await waitForResumeBarrier(Promise.all([...cleanupJobs.values()])
        .then(() => queue.drainActive()), signal);
      if (recheck && !await recheck()) throw new Error('computer_resume_stale: input changed while resuming');
      if (signal?.aborted) throw new Error('computer_resume_cancelled: resume request cancelled');
      if (!computerUseCoordinator.snapshot().userControlActive
        || computerUseCoordinator.snapshot().takeoverGeneration !== generation) {
        throw new Error('computer_resume_stale: another interruption superseded the resume request');
      }
      // Cleanup may finish before a late read/capture continuation. Discard
      // that generation's observations again, never replay its commands.
      for (const sessionId of snapshot.pausedSessionIds ?? []) {
        releaseSessionState(sessionId, releaseCaptureSession);
      }
      computerUseCoordinator.resumeAfterUserTakeover(generation);
    },
    async waitForCleanup(): Promise<boolean> {
      const results = await Promise.allSettled([...cleanupJobs.values()]);
      return results.every((result) => result.status === 'fulfilled');
    },
    onSessionWorkerRetired,
    reapIdleSessionWorkers,
    claimComputerTargets,
    releaseComputerSession,
    abortComputerSession,
    takeOverComputer,
    stopAllComputerSessions,
    executeSerialized,
  };
}

export type SessionLifecycle = ReturnType<typeof createSessionLifecycle>;
