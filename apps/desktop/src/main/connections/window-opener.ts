// One window per connection. Creating a window awaits (saved bounds, the
// renderer session) before it is registered, so a second request arriving in
// that gap would otherwise build a second window for the same connection.

export interface ConnectionWindowOpenerDependencies<C extends { id: string }, W> {
  /** The connection's live window, if it has one. */
  find(connectionId: string): W | null;
  /** Brings an existing window back (restore, show, focus). */
  focus(window: W): void;
  /** Builds and registers the connection's window. */
  create(connection: C): Promise<void>;
}

/** Opens the connection's window, or focuses the one already open or being
 *  created; concurrent requests for one connection never build two. */
export function createConnectionWindowOpener<C extends { id: string }, W>(
  deps: ConnectionWindowOpenerDependencies<C, W>
): (connection: C) => Promise<void> {
  const creating = new Map<string, Promise<void>>();
  const show = async (connection: C): Promise<void> => {
    const inflight = creating.get(connection.id);
    if (inflight) {
      await inflight;
      // The window may already be gone again: look once more.
      return show(connection);
    }
    const existing = deps.find(connection.id);
    if (existing) {
      deps.focus(existing);
      return;
    }
    const creation = deps.create(connection);
    creating.set(connection.id, creation);
    try {
      await creation;
    } finally {
      if (creating.get(connection.id) === creation) creating.delete(connection.id);
    }
  };
  return show;
}
