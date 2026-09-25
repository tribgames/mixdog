// Session-address index: which execution entry currently owns a durable
// session id. External agent views never enter the index, so a later ordinary
// materialization can adopt their viewers and take authority.

export function createSessionAddressIndex({ sessionsById, externalViewEntries, addSubscriber, onSessionLive }) {
  function currentSessionId(entry) {
    return String(entry?.runtime?.getState?.()?.sessionId || '');
  }

  function indexSessionEntry(entry, sessionId = currentSessionId(entry)) {
    const nextId = String(sessionId || '');
    const previousId = String(entry?.indexedSessionId || '');
    if (previousId && previousId !== nextId && sessionsById.get(previousId) === entry) {
      sessionsById.delete(previousId);
    }
    if (!entry || entry.disposed || !nextId) {
      if (entry) entry.indexedSessionId = '';
      return '';
    }
    // External agent projections use the same frame machinery but are not a
    // daemon execution owner. Keeping them out of sessionsById lets a later
    // ordinary session materialization adopt the viewers and take authority.
    if (entry.externalView === true) return nextId;
    const existing = sessionsById.get(nextId);
    if (existing && existing !== entry && !existing.disposed) {
      // Never redirect an established address to a second session runtime.
      throw new Error(`duplicate session address: ${nextId}`);
    }
    const external = externalViewEntries.get(nextId);
    if (external) {
      externalViewEntries.delete(nextId);
      for (const token of external.subscribers || []) {
        addSubscriber(entry, { clientToken: token });
      }
    }
    sessionsById.set(nextId, entry);
    entry.indexedSessionId = nextId;
    // A live runtime is now the authority: its cold disk projections are dead.
    if (existing !== entry) onSessionLive(nextId);
    return nextId;
  }

  /** Entry that currently holds a session live. */
  function sessionOwner(sessionId) {
    const id = String(sessionId || '');
    if (!id) return null;
    const entry = sessionsById.get(id) || null;
    if (!entry || entry.disposed) {
      if (entry) sessionsById.delete(id);
      return null;
    }
    return entry;
  }

  return { currentSessionId, indexSessionEntry, sessionOwner };
}
