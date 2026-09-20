// Session resets: clear / new / switch / delete, each a TUI reset around one
// runtime transition — publish the blank boundary, snapshot for rollback, and
// commit the empty session only once the runtime call succeeded.
import { resetAllStreamingMarkdownStablePrefixes } from '../../../markdown/streaming-markdown.mjs';

export function createSessionResetActions(bag) {
  const {
    runtime,
    flags,
    getState,
    set,
    flushEmitImmediate,
    replaceItems,
    clearToastTimers,
    routeState,
    clearUiActivityBeforeContextSync,
    resetTuiForPendingSessionReset,
    snapshotTuiBeforeSessionReset,
    restoreTuiAfterFailedSessionReset,
    commitTuiSessionReset,
    resetStatsAndSyncContext,
  } = bag;

  // The published view of a session that is transitioning: current rows stay
  // on screen, live activity and the session id are cleared.
  const blankSessionPatch = () => ({
    items: getState().items,
    toasts: getState().toasts,
    queued: getState().queued,
    thinking: null,
    spinner: null,
    lastTurn: null,
    sessionId: null,
    stats: { ...getState().stats },
  });
  // The published view of the fresh session after the runtime transition.
  const emptySessionPatch = (extra = {}) => ({
    items: replaceItems([]),
    toasts: [],
    queued: [],
    thinking: null,
    spinner: null,
    lastTurn: null,
    ...extra,
    ...routeState(),
    stats: { ...getState().stats },
  });
  // Snapshot the TUI for rollback and park it for the pending reset.
  const beginTuiReset = (snapshot = true) => {
    clearToastTimers();
    resetAllStreamingMarkdownStablePrefixes();
    if (!snapshot) return null;
    const rollbackSnapshot = snapshotTuiBeforeSessionReset();
    resetTuiForPendingSessionReset();
    return rollbackSnapshot;
  };
  const commitEmptySession = (rollbackSnapshot, extra = {}) => {
    clearUiActivityBeforeContextSync();
    flags.pendingSessionReset = false;
    resetStatsAndSyncContext();
    set(emptySessionPatch(extra));
    commitTuiSessionReset(rollbackSnapshot);
  };

  return {
    clear: async () => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      const rollbackSnapshot = beginTuiReset();
      set(blankSessionPatch());
      try {
        await runtime.clear({ recoverAgent: true });
        commitEmptySession(rollbackSnapshot);
        flags.lastUserActivityAt = Date.now();
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    deleteSession: async (id) => {
      if (getState().commandBusy) return false;
      const deletingCurrent = String(runtime.session?.id || getState().sessionId || '') === String(id || '');
      set({ commandBusy: true });
      const rollbackSnapshot = beginTuiReset(deletingCurrent);
      try {
        if ((await runtime.deleteSession(id)) !== true) {
          if (rollbackSnapshot) restoreTuiAfterFailedSessionReset(rollbackSnapshot);
          return false;
        }
        if (deletingCurrent) commitEmptySession(rollbackSnapshot, { sessionId: null, cwd: runtime.cwd });
        return true;
      } catch (error) {
        if (rollbackSnapshot) restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    switchContext: async (options) => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      const rollbackSnapshot = beginTuiReset();
      try {
        await runtime.switchContext(options);
        commitEmptySession(rollbackSnapshot, { sessionId: null, cwd: runtime.cwd });
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
      }
    },
    newSession: async () => {
      if (getState().commandBusy) return false;
      set({ commandBusy: true });
      const rollbackSnapshot = beginTuiReset();
      set(blankSessionPatch());
      // Publish the blank session boundary before runtime session creation can
      // block on disk/provider work. Otherwise the old transcript remains the
      // last committed React snapshot until the async command completes.
      flushEmitImmediate();
      try {
        await runtime.newSession();
        commitEmptySession(rollbackSnapshot);
        return true;
      } catch (error) {
        restoreTuiAfterFailedSessionReset(rollbackSnapshot);
        throw error;
      } finally {
        flags.pendingSessionReset = false;
        set({ commandBusy: false });
        // Match resume's atomic handoff: callers (and the forced terminal
        // repaint triggered by /new) must observe the completed empty session.
        flushEmitImmediate();
      }
    },
  };
}
