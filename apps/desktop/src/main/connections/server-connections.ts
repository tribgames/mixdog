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
  /** The server's connection is gone: whatever the app kept about it ends here. */
  detached?(id: string): void;
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

export function createServerConnections<T extends ServerConnection>(
  deps: ServerConnectionsDeps<T>
): ServerConnections<T> {
  const servers = new Set<string>();
  const detach = async (id: string): Promise<void> => {
    servers.delete(id);
    try {
      await deps.pool.remove(id)?.dispose();
    } finally {
      // A newer connection of the same id (attached while this one closed) keeps what the app holds for it.
      if (!deps.pool.has(id)) deps.detached?.(id);
    }
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
