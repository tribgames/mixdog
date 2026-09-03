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
import type { createWorkerPool } from '../backend/worker-pool';
import type { createSessionState } from '../session/state';
import type { createCaptureEngine } from '../observation/capture';
import { appendComputerRunRecord, computerRunRecord } from '../session/run-log';
import {
  computerResultLastNumber,
  computerUseCoordinator,
  queuedForegroundRequiresRecapture,
} from '../session/coordinator';
import { beginComputerOperation } from '../../human-only-approval';
import {
  HOST_WARMUP_SESSION_ID,
  isComputerLifecycleControl,
  requiresForegroundLane,
} from './action-sets';
import type { ExecutionState, InputRecoveryState } from './execution-state';

const ABORT_CLEANUP_TIMEOUT_MS = 5_000;
// Resident workers remain warm longer than target leases. A window lease is
// deliberately short-lived in the coordinator so an abandoned session
// cannot reserve a user's app for this whole worker-idle period.
const WORKER_IDLE_STALE_MS = 10 * 60_000;

type WorkerPool = ReturnType<typeof createWorkerPool>;
type SessionState = ReturnType<typeof createSessionState>;
type CaptureEngine = ReturnType<typeof createCaptureEngine>;

export interface SessionLifecycleHost extends
  Pick<WorkerPool, 'powerShellBySession' | 'workerLastUsedAt' | 'retirePowerShell' | 'callPowerShell'>,
  Pick<SessionState, 'sessionIdFor' | 'releaseSessionState' | 'invalidateWorkerGeneration'>,
  Pick<CaptureEngine, 'releaseCaptureSession'> {
  execution: ExecutionState;
  /** Late-bound: the router is composed after the lifecycle it depends on. */
  runCommand(command: ComputerCommand): Promise<ComputerCommandResult>;
  recaptureRequiredReply(command: ComputerCommand, error: unknown): Promise<ComputerCommandResult | null>;
}

export function createSessionLifecycle(host: SessionLifecycleHost) {
  const {
    powerShellBySession,
    workerLastUsedAt,
    retirePowerShell,
    callPowerShell,
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
    executionContext,
    sessionAbortEpochs,
    sessionRecoveryBySession,
    commandChainsBySession,
  } = execution;
  let foregroundChain: Promise<unknown> = Promise.resolve();
  let foregroundQueueDepth = 0;
  // Workers tell physical input from their own synthetic input by tick; this
  // carries the latest tick across sessions so one worker's click is not read
  // as the user grabbing the mouse by the next.
  let lastInjectionTick: number | null = null;

  function onSessionWorkerRetired(sessionId: string): void {
    invalidateWorkerGeneration(sessionId);
    sessionRecoveryBySession.delete(sessionId);
    releaseTargetClaims(sessionId);
  }

  function reapIdleSessionWorkers(now = Date.now()): void {
    for (const [sessionId, child] of powerShellBySession) {
      if (activeExecutionsBySession.has(sessionId)) continue;
      if (now - (workerLastUsedAt.get(sessionId) || 0) < WORKER_IDLE_STALE_MS) continue;
      releaseSessionState(sessionId, releaseCaptureSession);
      sessionRecoveryBySession.delete(sessionId);
      releaseTargetClaims(sessionId);
      retirePowerShell(child, new Error('computer session worker reclaimed after idle timeout'));
    }
  }

  function touchTargetClaims(sessionId: string): void {
    computerUseCoordinator.touchTargets(sessionId);
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

  function runForegroundExclusive<T>(
    sessionId: string,
    operation: () => Promise<T>,
    options: {
      requireFreshAfterWait?: boolean;
      assertRunnable?: () => void;
      allowWhileUserControl?: boolean;
    } = {},
  ): Promise<T> {
    const queuePosition = foregroundQueueDepth;
    foregroundQueueDepth += 1;
    if (queuePosition > 0) computerUseCoordinator.queueForeground(sessionId, queuePosition);
    const run = foregroundChain.then(async () => {
      computerUseCoordinator.activateForeground(sessionId);
      try {
        options.assertRunnable?.();
        if (!options.allowWhileUserControl) computerUseCoordinator.assertAutomationAllowed();
        if (options.requireFreshAfterWait !== false
          && queuedForegroundRequiresRecapture(queuePosition)) {
          throw new Error(
            `computer_foreground_available_recapture_required: foreground lane acquired`
            + ` after queue_position=${queuePosition}; discard the stale command and capture fresh state`,
          );
        }
        return await operation();
      } finally {
        foregroundQueueDepth = Math.max(0, foregroundQueueDepth - 1);
      }
    });
    foregroundChain = run.catch(() => undefined);
    return run;
  }

  async function releaseComputerSession(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = sessionIdFor(command);
    const child = powerShellBySession.get(sessionId);
    try {
      if (child && !child.killed) {
        await callPowerShell({
          action: 'release_session',
          session_id: sessionId,
          read_only: false,
        });
      }
    } finally {
      if (child && !child.killed) {
        retirePowerShell(child, new Error('computer session released'));
      }
      releaseSessionState(sessionId, releaseCaptureSession);
      sessionRecoveryBySession.delete(sessionId);
      releaseTargetClaims(sessionId);
    }
    return { text: 'computer session released' };
  }

  async function cleanupAbortedInput(recovery?: InputRecoveryState): Promise<void> {
    if (!recovery?.targetWindowId) return;
    await new Promise<void>((resolve) => {
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
          MIXDOG_ABORT_TARGET: recovery.targetWindowId,
          MIXDOG_ABORT_RESTORE: recovery.restoreWindowId,
          MIXDOG_ABORT_CURSOR_X: String(recovery.cursorX),
          MIXDOG_ABORT_CURSOR_Y: String(recovery.cursorY),
        },
      });
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* already gone */ }
        finish();
      }, ABORT_CLEANUP_TIMEOUT_MS);
      child.once('error', finish);
      child.once('exit', finish);
    });
  }

  async function abortComputerSession(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = sessionIdFor(command);
    sessionAbortEpochs.set(sessionId, (sessionAbortEpochs.get(sessionId) || 0) + 1);
    const activeExecution = activeExecutionsBySession.get(sessionId);
    const recovery = activeExecution?.recovery || sessionRecoveryBySession.get(sessionId);
    if (activeExecution) activeExecution.aborted = true;
    const child = powerShellBySession.get(sessionId);
    if (child && !child.killed) {
      retirePowerShell(child, new Error('computer_session_aborted: command stopped by session cancellation'));
    }
    activeExecutionsBySession.delete(sessionId);
    releaseSessionState(sessionId, releaseCaptureSession);
    sessionRecoveryBySession.delete(sessionId);
    releaseTargetClaims(sessionId);
    await runForegroundExclusive(
      sessionId,
      () => cleanupAbortedInput(recovery),
      { requireFreshAfterWait: false, allowWhileUserControl: true },
    );
    if (!commandChainsBySession.has(sessionId)) sessionAbortEpochs.delete(sessionId);
    return { text: 'computer session aborted; input state and session resources were released' };
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
      sessionAbortEpochs.set(sessionId, (sessionAbortEpochs.get(sessionId) || 0) + 1);
      const execution = activeExecutionsBySession.get(sessionId);
      if (execution) execution.aborted = true;
      const child = powerShellBySession.get(sessionId);
      if (child && !child.killed) {
        retirePowerShell(child, new Error('computer_user_takeover: command stopped without input recovery'));
      }
      activeExecutionsBySession.delete(sessionId);
      invalidateWorkerGeneration(sessionId);
      sessionRecoveryBySession.delete(sessionId);
    }
  }

  async function stopAllComputerSessions(): Promise<void> {
    const sessionIds = new Set([
      ...powerShellBySession.keys(),
      ...activeExecutionsBySession.keys(),
      ...computerUseCoordinator.snapshot().activities.map((activity) => activity.sessionId),
    ]);
    await Promise.allSettled([...sessionIds]
      .filter((sessionId) => sessionId !== HOST_WARMUP_SESSION_ID)
      .map((sessionId) => abortComputerSession({
        action: 'session_abort',
        session_id: sessionId,
      })));
    computerUseCoordinator.resumeAfterUserTakeover();
  }

  /** One command at a time per session, with foreground work serialized
   *  across every session on the shared desktop lane. */
  function executeSerialized(command: ComputerCommand): Promise<ComputerCommandResult> {
    assertSafeComputerSessionId(command);
    const sessionId = sessionIdFor(command);
    const lifecycleControl = isComputerLifecycleControl(command);
    if (!lifecycleControl) touchTargetClaims(sessionId);
    const queuedEpoch = sessionAbortEpochs.get(sessionId) || 0;
    const previous = commandChainsBySession.get(sessionId) || Promise.resolve();
    const run = previous.then(async () => {
      if ((sessionAbortEpochs.get(sessionId) || 0) !== queuedEpoch) {
        throw new Error('computer_session_aborted: queued command was cancelled before execution');
      }
      const releaseHumanApprovalGuard = lifecycleControl
        ? () => {}
        : beginComputerOperation();
      const foreground = requiresForegroundLane(command);
      const tracksActivity = !lifecycleControl;
      if (tracksActivity) {
        try {
          computerUseCoordinator.beginCommand({
            sessionId,
            action: String(command.action || 'computer'),
            target: String(command.window || command.window_id || command.app || ''),
            mode: foreground ? 'foreground' : 'background',
          });
        } catch (error) {
          releaseHumanApprovalGuard();
          throw error;
        }
      }
      if (lifecycleControl) return await runCommand(command);
      const execution = { sessionId, aborted: false };
      activeExecutionsBySession.set(sessionId, execution);
      const recordStartedAt = performance.now();
      try {
        const operation = () => executionContext.run(execution, () => runCommand(
          foreground && lastInjectionTick !== null
            ? { ...command, known_injection_tick: lastInjectionTick }
            : command,
        ));
        const outcome = foreground
          ? await runForegroundExclusive(sessionId, operation, {
            assertRunnable: () => {
              if (execution.aborted) {
                throw new Error('computer_session_aborted: command stopped by session cancellation');
              }
            },
          })
          : await operation();
        if (foreground) {
          const injectionTick = computerResultLastNumber(outcome.text, 'injection_tick');
          if (injectionTick !== null) lastInjectionTick = injectionTick;
        }
        appendComputerRunRecord(sessionId, computerRunRecord(command, recordStartedAt, outcome));
        return outcome;
      } catch (error) {
        appendComputerRunRecord(sessionId, {
          ...computerRunRecord(command, recordStartedAt),
          ok: false,
          error: String((error as Error)?.message || error).slice(0, 300),
        });
        const recapture = await recaptureRequiredReply(command, error);
        if (recapture) return recapture;
        throw error;
      } finally {
        if (activeExecutionsBySession.get(sessionId) === execution) {
          activeExecutionsBySession.delete(sessionId);
        }
        if (tracksActivity) computerUseCoordinator.finishCommand(sessionId);
        releaseHumanApprovalGuard();
      }
    });
    const tail = run.catch(() => undefined);
    commandChainsBySession.set(sessionId, tail);
    void tail.finally(() => {
      if (commandChainsBySession.get(sessionId) === tail) {
        commandChainsBySession.delete(sessionId);
        sessionAbortEpochs.delete(sessionId);
      }
    });
    return run;
  }

  return {
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
