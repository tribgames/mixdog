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
import { isComputerLifecycleControl } from './action-sets';
import { createComputerCommandQueue } from './command-queue';
import type { ExecutionState, InputRecoveryState } from './execution-state';
import { createSessionAbort, restoreSessionDesktop } from './lifecycle-abort';
import { createSessionStop } from './lifecycle-stop';
import { createPointerHold } from './pointer-hold';
import { claimComputerTargets } from './lifecycle-target-leases';
import { isComputerRecoveryRead } from './recovery-reads';
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
  cleanupInput?: (
    recovery: InputRecoveryState | undefined,
    restoreDesktop: boolean,
    sweep: boolean
  ) => Promise<boolean>;
  pendingInactiveLedgers?: WorkerPool['pendingInactiveLedgers'];
  inactiveLedgersRecovered?: WorkerPool['inactiveLedgersRecovered'];
  hasUnconfirmedBackgroundInput?:WorkerPool['hasUnconfirmedBackgroundInput'];
  waitForResidentWorkersExit?: WorkerPool['waitForResidentWorkersExit'];
  clearUnconfirmedBackgroundInput?: WorkerPool['clearUnconfirmedBackgroundInput'];
  releaseUnconfirmedElevated?: WorkerPool['releaseUnconfirmedElevated'];
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
  const pointerHold = createPointerHold(context);
  const queue = createComputerCommandQueue({
    pointerHold,
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
  const reclaim = createWorkerReclaim(context, queue, abort.abortComputerSession);
  const stop = createSessionStop(context, queue, abort.abortComputerSession);

  /** A key or button the agent left down acts on whatever the user does next,
   *  so a turn's end lets it go while the worker stays warm. `false` when the
   *  worker could not confirm the release. */
  function releaseHeldInput(sessionId: string): Promise<boolean> | null {
    const child = host.powerShellBySession.get(sessionId);
    if (!child || child.killed) return null;
    return queue
      .runForegroundExclusive(
        sessionId,
        () => host.callPowerShell({ action: 'release_held_input', session_id: sessionId, read_only: false }),
        { requireFreshAfterWait: false, allowWhileUserControl: true }
      )
      .then(
        (response) => response.ok !== false,
        () => false
      );
  }

  return {
    resumeAfterTakeover: stop.resumeAfterTakeover,
    waitForCleanup: stop.waitForCleanup,
    onSessionWorkerRetired: reclaim.onSessionWorkerRetired,
    reapIdleSessionWorkers: reclaim.reapIdleSessionWorkers,
    claimComputerTargets: (command: ComputerCommand, windowIds: Array<string | undefined>) =>
      claimComputerTargets(coordinator, host.sessionIdFor(command), windowIds),
    releaseComputerSession: abort.releaseComputerSession,
    /** Turn settlement: the user gets the desktop back now, while the worker
     *  and its observation refs stay warm for a follow-up until the deferred
     *  release. Held keys and buttons go up first, while the target still has
     *  focus. The reply cannot wait on the foreground lane, so the pointer
     *  shows again once the restore has put it home. */
    endComputerExecution(command: ComputerCommand): ComputerCommandResult {
      const sessionId = host.sessionIdFor(command);
      const released = releaseHeldInput(sessionId);
      const restore = restoreSessionDesktop(context, queue, sessionId);
      coordinator.endExecution(sessionId);
      void Promise.all([released, restore]).then(async ([confirmed]) => {
        await pointerHold.end(sessionId);
        // An unconfirmed release ends the session instead: the abort's sweep
        // releases whatever input the host still owns, or reports that it cannot.
        if (confirmed === false) {
          await abort
            .abortComputerSession({ action: 'session_abort', session_id: sessionId }, false, undefined, false, true)
            .catch(() => undefined);
        }
      });
      return { text: 'computer execution ended' };
    },
    abortComputerSession: abort.abortComputerSession,
    takeOverComputer: stop.takeOverComputer,
    stopAllComputerSessions: stop.stopAllComputerSessions,
    resumeByUser: stop.resumeByUser,
    executeSerialized(command: ComputerCommand): Promise<ComputerCommandResult> {
      const recovery =
        isComputerLifecycleControl(command) || isComputerRecoveryRead(String(command.action || ''))
          ? null
          : stop.recoverBeforeCommand();
      return recovery ? recovery.then(() => queue.executeSerialized(command)) : queue.executeSerialized(command);
    },
  };
}

export type SessionLifecycle = ReturnType<typeof createSessionLifecycle>;
