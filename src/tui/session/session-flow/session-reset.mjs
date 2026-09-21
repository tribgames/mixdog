/**
 * src/tui/session/session-flow/session-reset.mjs - TUI state around a session
 * clear/reset: stats reset, transcript/toast wipe, and the snapshot/restore
 * pair that rolls the UI back when a session reset fails.
 */
import { resetAllStreamingMarkdownStablePrefixes } from '../../markdown/streaming-markdown.mjs';
import { createSessionStats } from '../session-stats.mjs';

export function createSessionResetOps(bag) {
  const {
    flags,
    pendingNotificationKeys,
    displayedExecutionNotificationKeys,
    clearExecutionDedupState,
    clearToastTimers,
    getState,
    set,
    replaceItems,
    agentStatusState,
    routeState,
    syncContextStats,
    snapshotTranscriptSpill,
    restoreTranscriptSpill,
    releaseTranscriptSpill,
  } = bag;

  const resetStats = () => {
    const stats = createSessionStats();
    set({ stats });
    return stats;
  };

  const clearUiActivityBeforeContextSync = () => {
    clearToastTimers();
    resetAllStreamingMarkdownStablePrefixes();
    const items = replaceItems([]);
    set({
      items,
      toasts: [],
      queued: [],
      thinking: null,
      spinner: null,
      lastTurn: null,
      busy: false,
    });
    pendingNotificationKeys.clear();
    displayedExecutionNotificationKeys.clear();
    clearExecutionDedupState?.();
  };

  const resetTuiForPendingSessionReset = () => {
    flags.pendingSessionReset = true;
    clearUiActivityBeforeContextSync();
    resetStats();
    set({
      stats: {
        ...getState().stats,
        currentContextTokens: 0,
        currentEstimatedContextTokens: 0,
        currentContextSource: null,
        currentContextUpdatedAt: Date.now(),
      },
      displayContextWindow: 0,
      compactBoundaryTokens: 0,
      autoCompactTokenLimit: 0,
    });
  };

  const snapshotTuiBeforeSessionReset = () => ({
    items: getState().items.slice(),
    transcriptViewItems: Array.isArray(getState().transcriptViewItems) ? getState().transcriptViewItems.slice() : null,
    transcriptViewRevision: getState().transcriptViewRevision,
    transcriptSpill: snapshotTranscriptSpill?.() || null,
    toasts: getState().toasts.slice(),
    queued: getState().queued.slice(),
    thinking: getState().thinking,
    spinner: getState().spinner,
    lastTurn: getState().lastTurn,
    busy: getState().busy,
    stats: { ...getState().stats },
    sessionId: getState().sessionId,
  });

  const restoreTuiAfterFailedSessionReset = (snapshot) => {
    if (!snapshot) return;
    flags.pendingSessionReset = false;
    restoreTranscriptSpill?.(snapshot.transcriptSpill);
    const items = replaceItems(snapshot.items, { preserveSpill: true });
    set({
      items,
      transcriptViewItems: snapshot.transcriptViewItems,
      transcriptViewRevision: snapshot.transcriptViewRevision,
      toasts: snapshot.toasts.slice(),
      queued: snapshot.queued.slice(),
      thinking: snapshot.thinking,
      spinner: snapshot.spinner,
      lastTurn: snapshot.lastTurn,
      busy: snapshot.busy,
      stats: { ...snapshot.stats },
    });
    syncContextStats({ allowEstimated: true });
    // The rows and live activity above are already published; this republish
    // exists for the route/agent state and the freshly synced stats.
    set({
      ...routeState(),
      stats: { ...getState().stats },
      ...agentStatusState(),
    });
  };

  const commitTuiSessionReset = (snapshot) => {
    releaseTranscriptSpill?.(snapshot?.transcriptSpill);
  };

  const resetStatsAndSyncContext = () => {
    resetStats();
    syncContextStats({ allowEstimated: true });
    return getState().stats;
  };

  return {
    resetStats,
    clearUiActivityBeforeContextSync,
    resetTuiForPendingSessionReset,
    snapshotTuiBeforeSessionReset,
    restoreTuiAfterFailedSessionReset,
    commitTuiSessionReset,
    resetStatsAndSyncContext,
  };
}
