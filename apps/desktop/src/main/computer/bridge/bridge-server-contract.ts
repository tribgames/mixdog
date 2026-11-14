/** What the computer bridge needs from the desktop, and the state one bridge generation carries between start,
 *  request handling and stop. */
import type { Server } from 'node:http';
import type { BridgeDiscoveryRecord } from '../../bridge/discovery-ownership';
import type { CallCore } from '../pixels/blob-upload';

export type { CallCore };

export interface BridgeServerHost {
  dataDirectory(): string;
  isBridgeWanted(): boolean;
  isDisposed(): boolean;
  diagnose(event: string, data?: Record<string, unknown>): void;
  /** The core the commands run on; the bridge answers a command the core could not take as a failed one. */
  callCore: CallCore;
}

export interface BridgeServerState {
  heartbeat: NodeJS.Timeout | null;
  server: Server | null;
  stopPromise: Promise<void> | null;
  /** Bumped on every start and stop; a continuation from an older generation is ignored. */
  generation: number;
  discoveryRecord: BridgeDiscoveryRecord | null;
  /** The sessions that sent a command since the bridge started: a stop ends each of them. */
  sessions: Set<string>;
}

export function createBridgeServerState(): BridgeServerState {
  return {
    heartbeat: null,
    server: null,
    stopPromise: null,
    generation: 0,
    discoveryRecord: null,
    sessions: new Set(),
  };
}
