// The service connection of each server window open in this process: this PC's own client to the server's core (the
// desktop operations of the window's IPC, its terminals, its uploads and previews), dialed where this PC's core says the
// server listens. The core owns the ssh session, the tunnel and the link; this only keeps the connection a window uses
// while the window lives.
import type { ConnectionPool, PooledConnection } from './pool';
import type { ServerWindowRecord } from './server-window-record';

export interface ServerConnection extends PooledConnection {
  start(): Promise<void>;
  dispose(): Promise<void>;
}

export interface ServerConnectionsDeps<T extends ServerConnection> {
  pool: ConnectionPool<T>;
  /** Makes the service connection of a server window (not started). */
  create(record: ServerWindowRecord): T;
}

export interface ServerConnections<T extends ServerConnection> {
  /** The record's connection, started and in the pool (the one already there when there is one). Rejects, keeping
   *  nothing, when it cannot be started. */
  attach(record: ServerWindowRecord): Promise<T>;
  /** The window is gone: the connection leaves the pool and closes (the server's core keeps running). */
  detach(id: string): Promise<void>;
  /** Every server connection closes (the app quits). */
  closeAll(): Promise<void>;
}

export function createServerConnections<T extends ServerConnection>(deps: ServerConnectionsDeps<T>): ServerConnections<T> {
  const servers = new Set<string>();
  const detach = async (id: string): Promise<void> => {
    servers.delete(id);
    await deps.pool.remove(id)?.dispose();
  };
  return {
    attach: async (record) => {
      const existing = deps.pool.get(record.id);
      if (existing) return existing;
      const connection = deps.create(record);
      deps.pool.add(connection);
      servers.add(record.id);
      try {
        await connection.start();
      } catch (error) {
        await detach(record.id).catch(() => undefined);
        throw error;
      }
      return connection;
    },
    detach,
    closeAll: async () => {
      await Promise.all([...servers].map((id) => detach(id).catch(() => undefined)));
    },
  };
}
