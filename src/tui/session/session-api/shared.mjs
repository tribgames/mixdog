/**
 * shared.mjs — helpers every session-api group repeats: the command lock
 * (commandBusy guard held around one runtime call) and the route/stats
 * republish after a change that alters the tool surface.
 */
export function createApiHelpers({ getState, set, resetStatsAndSyncContext, routeState }) {
  /**
   * Wrap a runtime call in the command lock: refused (→ `busyResult`) while
   * another command holds commandBusy, otherwise held for the call's duration.
   * `onRelease` runs after the lock drops (RPC replies read the published
   * snapshot, not the mutable draft, so some callers flush there).
   */
  const withCommandLock =
    (run, { busyResult = null, onRelease = null } = {}) =>
    async (...args) => {
      if (getState().commandBusy) return busyResult;
      set({ commandBusy: true });
      try {
        return await run(...args);
      } finally {
        set({ commandBusy: false });
        onRelease?.();
      }
    };

  // Extension/tool-surface changes invalidate the context estimate and the
  // published route.
  const refreshRouteStats = () => {
    resetStatsAndSyncContext();
    set({ ...routeState(), stats: { ...getState().stats } });
  };

  return { withCommandLock, refreshRouteStats };
}
