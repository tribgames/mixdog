import type { ConnectionKind } from './contract';
import { ConnectionError } from './errors';

export interface PooledConnection {
  readonly id: string;
  readonly kind: ConnectionKind;
}

/** The attached daemon connections, keyed by connection id. */
export class ConnectionPool<T extends PooledConnection> {
  private readonly entries = new Map<string, T>();
  private readonly addedListeners = new Set<(connection: T) => void>();

  add(connection: T): void {
    if (this.entries.has(connection.id)) throw new Error(`Connection "${connection.id}" is already open.`);
    this.entries.set(connection.id, connection);
    for (const listener of [...this.addedListeners]) {
      try {
        listener(connection);
      } catch {
        // A listener's failure never undoes the attach.
      }
    }
  }

  /** Calls `listener` for each connection added from now on (an attached, started one). Returns the unsubscribe. */
  onAdd(listener: (connection: T) => void): () => void {
    this.addedListeners.add(listener);
    return () => this.addedListeners.delete(listener);
  }

  get(id: string): T | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  require(id: string): T {
    const connection = this.entries.get(id);
    if (!connection) throw new ConnectionError('connection-missing', `The connection "${id}" is not open.`);
    return connection;
  }

  remove(id: string): T | undefined {
    const connection = this.entries.get(id);
    this.entries.delete(id);
    return connection;
  }

  list(): T[] {
    return [...this.entries.values()];
  }
}
