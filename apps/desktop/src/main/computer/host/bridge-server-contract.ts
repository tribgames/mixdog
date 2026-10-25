/** What the computer bridge needs from the host, and the state one bridge
 *  generation carries between start, request handling and stop. */
import type { Server } from 'node:http';
import type { BridgeDiscoveryRecord } from '../../bridge/discovery-ownership';
import type { ComputerCommand, ComputerCommandResult } from '../shared/types';
import type { createWorkerPool } from '../backend/worker-pool';
import type { SessionLifecycle } from './session-lifecycle';

type WorkerPool = ReturnType<typeof createWorkerPool>;

export interface BridgeServerHost
  extends Pick<WorkerPool, 'powerShellBySession' | 'elevatedSessionIds'>,
    Pick<SessionLifecycle, 'abortComputerSession' | 'executeSerialized' | 'reapIdleSessionWorkers'> {
  dataDirectory(): string;
  isBridgeWanted(): boolean;
  isDisposed(): boolean;
  diagnose(event: string, data?: Record<string, unknown>): void;
  waitForCleanup?(): Promise<boolean>;
  waitForUser?(command: ComputerCommand, signal: AbortSignal): Promise<ComputerCommandResult>;
  /** Saved-login owners: whether the process `pid` created at `created`
   *  (empty: whichever process has the id now) has ended, as the OS proves it
   *  (worker process_fate); absent, no owner is accepted. */
  processFate?(process: { pid: number; created: string }): Promise<ProcessFate>;
}

/** The OS's answer about one process: `unknown` is never read as ended. */
export interface ProcessFate {
  state: 'running' | 'ended' | 'unknown';
  /** Its creation time (a FILETIME as decimal text) when it could be read. */
  created: string;
}

export interface BridgeServerState {
  heartbeat: NodeJS.Timeout | null;
  server: Server | null;
  stopPromise: Promise<void> | null;
  /** Bumped on every start and stop; a continuation from an older generation is ignored. */
  generation: number;
  discoveryRecord: BridgeDiscoveryRecord | null;
  activeRequests: number;
}

export function createBridgeServerState(): BridgeServerState {
  return {
    heartbeat: null,
    server: null,
    stopPromise: null,
    generation: 0,
    discoveryRecord: null,
    activeRequests: 0,
  };
}
