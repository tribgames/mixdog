import type { Server } from 'node:net';

export const FETCH_BLOCKED_PORTS: ReadonlySet<number>;

export const FETCH_SAFE_ATTEMPTS: number;

export function listenOnFetchSafePort(
  server: Server,
  host: string,
  onListening: () => void,
  options?: {
    attempts?: number;
    isCurrent?: () => boolean;
    portOf?: (server: Server) => number;
  }
): void;
