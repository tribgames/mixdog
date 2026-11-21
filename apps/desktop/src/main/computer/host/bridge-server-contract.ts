/** What the host's in-process command service needs from the host. The loopback HTTP bridge is `computer/bridge/`. */
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import type { createWorkerPool } from '../backend/worker-pool';
import type { SessionLifecycle } from './session-lifecycle';

type WorkerPool = ReturnType<typeof createWorkerPool>;

export interface BridgeServerHost
  extends Pick<WorkerPool, 'powerShellBySession' | 'elevatedSessionIds'>,
    Pick<SessionLifecycle, 'abortComputerSession' | 'executeSerialized' | 'reapIdleSessionWorkers'> {
  waitForCleanup?(): Promise<boolean>;
  waitForUser?(command: ComputerCommand, signal: AbortSignal): Promise<ComputerCommandResult>;
}

/** The OS's answer about one process: `unknown` is never read as ended. */
export interface ProcessFate {
  state: 'running' | 'ended' | 'unknown';
  /** Its creation time (a FILETIME as decimal text) when it could be read. */
  created: string;
}
