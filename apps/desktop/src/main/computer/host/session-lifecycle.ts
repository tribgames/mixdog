/**
 * Session lifecycle for the Computer Use host: target leases, the per-session
 * command chain and the shared foreground lane, plus release, abort, takeover,
 * and idle reclamation. Everything that decides whether a command may run and
 * what happens to a session's desktop state when it stops lives here.
 */
import type { createWorkerPool } from '../backend/worker-pool';
import type { createCaptureEngine } from '../observation/capture';
import { computerUseCoordinator as defaultCoordinator, type ComputerUseCoordinator } from '../session/coordinator';
import type { createSessionState } from '../session/state';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import { createComputerCommandQueue } from './command-queue';
import type { ExecutionState, InputRecoveryState } from './execution-state';
import { createSessionAbort } from './lifecycle-abort';
import { createSessionStop } from './lifecycle-stop';
import { claimComputerTargets } from './lifecycle-target-leases';
import { createWorkerReclaim } from './lifecycle-worker-reclaim';

type WorkerPool = ReturnType<typeof createWorkerPool>;
type SessionState = ReturnType<typeof createSessionState>;
type CaptureEngine = ReturnType<typeof createCaptureEngine>;

export interface SessionLifecycleHost
  extends Pick<
      WorkerPool,
      | 'powerShellBySession'
      | 'workerLastUsedAt'
      | 'retirePowerShell'
      | 'callPowerShell'
      | 'cancelElevatedSession'
      | 'elevatedSessionIds'
    >,
    Pick<SessionState, 'sessionIdFor' | 'releaseSessionState' | 'invalidateWorkerGeneration'>,
    Pick<CaptureEngine, 'releaseCaptureSession'> {
  execution: ExecutionState;
  inputMarker?: string;
  /** Late-bound: the router is composed after the lifecycle it depends on. */
  runCommand(command: ComputerCommand): Promise<ComputerCommandResult>;
  recaptureRequiredReply(command: ComputerCommand, error: unknown): Promise<ComputerCommandResult | null>;
  coordinator?: ComputerUseCoordinator;
  cleanupInput?: (recovery: InputRecoveryState | undefined, restoreDesktop: boolean) => Promise<boolean>;
  hasUnconfirmedBackgroundInput?: WorkerPool['hasUnconfirmedBackgroundInput'];
  waitForResidentWorkersExit?: WorkerPool['waitForResidentWorkersExit'];
  recordDiagnostic?: (sessionId: string, record: Record<string, unknown>) => void;
  pauseWaitMs?: number;
}

/** What every lifecycle stage shares: the host, the coordinator that owns
 *  leases and pauses, the execution state, and the cleanup job per session. */
export interface LifecycleContext {
  host: SessionLifecycleHost;
  coordinator: ComputerUseCoordinator;
  execution: ExecutionState;
  cleanupJobs: Map<string, Promise<ComputerCommandResult>>;
}

export function createSessionLifecycle(host: SessionLifecycleHost) {
  const coordinator = host.coordinator || defaultCoordinator;
  const context: LifecycleContext = { host, coordinator, execution: host.execution, cleanupJobs: new Map() };
  const queue = createComputerCommandQueue({
    coordinator,
    execution: host.execution,
    sessionIdFor: host.sessionIdFor,
    runCommand: host.runCommand,
    recaptureRequiredReply: host.recaptureRequiredReply,
    // Takeover is composed after the queue that reports it; resolved per call.
    takeOver: (reason?: string) => stop.takeOverComputer(reason),
    recordDiagnostic: host.recordDiagnostic,
    pauseWaitMs: host.pauseWaitMs,
  });
  const abort = createSessionAbort(context, queue);
  const reclaim = createWorkerReclaim(context, abort.abortComputerSession);
  const stop = createSessionStop(context, queue, abort.abortComputerSession);

  return {
    resumeAfterTakeover: stop.resumeAfterTakeover,
    waitForCleanup: stop.waitForCleanup,
    onSessionWorkerRetired: reclaim.onSessionWorkerRetired,
    reapIdleSessionWorkers: reclaim.reapIdleSessionWorkers,
    claimComputerTargets: (command: ComputerCommand, windowIds: Array<string | undefined>) =>
      claimComputerTargets(coordinator, host.sessionIdFor(command), windowIds),
    releaseComputerSession: abort.releaseComputerSession,
    abortComputerSession: abort.abortComputerSession,
    takeOverComputer: stop.takeOverComputer,
    stopAllComputerSessions: stop.stopAllComputerSessions,
    executeSerialized: queue.executeSerialized,
  };
}

export type SessionLifecycle = ReturnType<typeof createSessionLifecycle>;
