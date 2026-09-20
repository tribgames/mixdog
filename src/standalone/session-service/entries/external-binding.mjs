// Bind a retained external Agent snapshot into the ordinary view entry
// without materializing a daemon runtime. publishExternalSessionState adopts
// pending viewers so a completed turn is visible immediately.

export function createExternalViewBinding({
  readExternalSessionState,
  pendingViewers,
  log,
  sessionOwner,
  externalEntryForView,
  publishExternalSessionState,
}) {
  async function bindExternalSessionView(sessionId) {
    const id = String(sessionId || '');
    if (!id) return null;
    const owner = sessionOwner(id);
    if (owner) return owner;
    const existing = externalEntryForView(id);
    if (existing) return existing;
    if (typeof readExternalSessionState !== 'function') return null;

    // Register the address before the retained-snapshot read. Even a
    // synchronous reader crosses an `await` boundary, so a newer external
    // frame can otherwise arrive in that microtask, find no pending viewer,
    // and be dropped before the stale retained snapshot is bound.
    const placeholder = new Set();
    const ownsPlaceholder = !pendingViewers.has(id);
    if (ownsPlaceholder) pendingViewers.set(id, placeholder);
    const clearPlaceholder = () => {
      if (ownsPlaceholder && pendingViewers.get(id) === placeholder && placeholder.size === 0) {
        pendingViewers.delete(id);
      }
    };

    let snapshot = null;
    try {
      snapshot = await readExternalSessionState(id);
    } catch (error) {
      log(`external session state read failed session=${id}: ${error?.message || error}`);
      const raced = sessionOwner(id) || externalEntryForView(id);
      clearPlaceholder();
      return raced;
    }
    const raced = sessionOwner(id) || externalEntryForView(id);
    if (raced) {
      clearPlaceholder();
      return raced;
    }
    if (!snapshot || typeof snapshot !== 'object') {
      clearPlaceholder();
      return null;
    }
    publishExternalSessionState({ sessionId: id, snapshot });
    const bound = sessionOwner(id) || externalEntryForView(id);
    if (!bound) clearPlaceholder();
    return bound;
  }

  return { bindExternalSessionView };
}
