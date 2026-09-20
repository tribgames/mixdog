// Session inheritance: carry this conversation into a heir session, the
// read-only preflight every surface asks first, and the /inherit command that
// opens the heir and carries in one step.

export function createInheritanceActions(bag, { restoreTranscriptItems }) {
  const { runtime, getState, set, flushEmitImmediate, replaceItems, routeState, resetStatsAndSyncContext } = bag;

  /**
   * Session inheritance as ONE addressable session action. THIS session is the
   * already-created heir, so only the carry step runs here — the desktop
   * creates and routes the new session first, then calls this by name. The
   * daemon resolves actions on THIS surface, so `inheritFrom` has to live here
   * and not only on the runtime beneath it.
   */
  const inheritFrom = async (sourceSessionId) => {
    const result = await runtime.inheritFrom(sourceSessionId);
    const sessionId = String(result?.sessionId || runtime.sessionId || getState().sessionId || '');
    // Only model messages travel with the conversation. Rebuild the visible
    // transcript from them right here so the heir opens showing the carried
    // conversation; without it the view stays blank until a cold reopen
    // resumes the session from disk and restores the same items.
    const carried = runtime.readModelMessages?.(0)?.messages;
    const items = restoreTranscriptItems(Array.isArray(carried) ? carried : [], { sessionId });
    resetStatsAndSyncContext();
    set({
      sessionId,
      items: replaceItems(items),
      toasts: [],
      queued: [],
      thinking: null,
      spinner: null,
      lastTurn: null,
      ...routeState(),
      stats: { ...getState().stats },
    });
    flushEmitImmediate();
    return result;
  };

  return {
    /**
     * /inherit — open a NEW session on the current route and carry this
     * conversation into it. The source session file is left as it is, so the
     * two transcripts share a prefix and then diverge.
     */
    inheritFrom,
    /** Read-only verdict for the heir this session would open, on the route it
     *  would open with. Every surface asks this before offering the carry. */
    inheritancePreflight: (sourceSessionId = null, selection = null) =>
      typeof runtime.inheritancePreflight === 'function'
        ? runtime.inheritancePreflight(sourceSessionId || getState().sessionId || null, selection)
        : null,
    inheritSession: async () => {
      if (getState().commandBusy) return false;
      const sourceId = getState().sessionId || null;
      if (!sourceId) return false;
      set({ commandBusy: true });
      try {
        // Refuse before a heir exists. Creating the new session first left the
        // user sitting in an empty one whenever the carry was rejected. An
        // oversized conversation is NOT a rejection: inheritFrom compacts it
        // for the heir, so only a route with nothing to compact toward stops
        // here.
        const fit = runtime.inheritancePreflight?.(sourceId, null);
        if (fit?.known && fit.fits === false && !fit.willCompact) throw new Error(fit.reason);
        await runtime.newSession();
        return await inheritFrom(sourceId);
      } finally {
        set({ commandBusy: false });
      }
    },
  };
}
