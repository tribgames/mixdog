/**
 * shared.mjs — helpers every session-api group repeats: the command lock
 * (commandBusy guard held around one runtime call) and the route/stats
 * republish after a change that alters the tool surface.
 */
export function createApiHelpers({ getState, set, resetStatsAndSyncContext, routeState, syncContextStats }) {
  /**
   * Wrap a runtime call in the command lock: refused (→ `busyResult`, or a
   * thrown `busyError` for callers that must not read a refusal as success)
   * while another command holds commandBusy, otherwise held for the call's
   * duration. `onRelease` runs after the lock drops (RPC replies read the
   * published snapshot, not the mutable draft, so some callers flush there).
   */
  const withCommandLock =
    (run, { busyResult = null, busyError = '', onRelease = null } = {}) =>
    async (...args) => {
      if (getState().commandBusy) {
        if (busyError) throw new Error(busyError);
        return busyResult;
      }
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

  const publishRoute = () => set({ ...routeState(), stats: { ...getState().stats } });

  // Context-stats recompute (transcript scan + per-message JSON stringify) is
  // deferred off the caller's tick so Ink repaints the change first; stats
  // become eventually consistent on the next tick/repaint.
  const deferStatsRefresh = () =>
    setTimeout(() => {
      syncContextStats({ allowEstimated: true });
      set({ stats: { ...getState().stats } });
    }, 0);

  return { withCommandLock, refreshRouteStats, publishRoute, deferStatsRefresh };
}
