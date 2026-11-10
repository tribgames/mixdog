/**
 * Read-only notifications about a session's persistence lifecycle, for owners
 * of derived sidecars (the compaction archive) that must wait for the session
 * record instead of polling for it. A pure registry: it persists nothing and
 * imports no write path.
 *
 *   'landed' — a save of the session reached disk (its record exists);
 *   'closed' — the session was closed (no further save is to be expected).
 *
 * A hard delete is announced through the existing purge hooks
 * (session-observers.mjs registerSessionPurgeHook).
 */
const listeners = new Set();

export function subscribeSessionPersistence(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishSessionPersistence(id, event) {
  for (const listener of [...listeners]) {
    try {
      listener(id, event);
    } catch {
      /* observers never affect persistence */
    }
  }
}
