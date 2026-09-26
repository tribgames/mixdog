/**
 * src/tui/session/initial-state.mjs - the session store's first draft.
 */
import { buildMergedPromptHistory, loadPromptHistory } from '../prompt-history-store.mjs';
import { createSessionStats } from './session-stats.mjs';
import { goalStateSnapshot } from '../../session-runtime/goal-state.mjs';

export function createInitialSessionState({ runtime, runtimeCwd, baseRouteState }) {
  return {
    items: [],
    transcriptViewItems: null,
    transcriptViewRevision: 0,
    transcriptHistoryBefore: false,
    transcriptHistoryAfter: false,
    structureRevision: 0,
    streamingTail: null,
    toasts: [],
    progressHint: null,
    busy: false,
    commandBusy: false,
    commandStatus: null,
    spinner: null,
    queued: [],
    thinking: null,
    toolApproval: null,
    lastTurn: null,
    stats: createSessionStats(),
    // Incremental derivations published by the session runtime so App does not scan all
    // transcript items on every change:
    //  - activeToolSummary/activeTools: running Shell, Agent, and web-search
    //    counts + earliest starts for status surfaces.
    //  - promptHistoryList: newest-first deduped user-prompt history, rebuilt
    //    only when a user item is appended (replaces the per-change rescan).
    activeToolSummary: null,
    activeTools: null,
    // Seed from the persisted cwd-scoped store so up-arrow history is available
    // on a fresh start, before any bulk swap / first submit republishes it.
    promptHistoryList: buildMergedPromptHistory([], loadPromptHistory(runtimeCwd)),
    ...baseRouteState(),
    displayContextWindow: 0,
    compactBoundaryTokens: 0,
    autoCompactTokenLimit: 0,
    agentWorkers: [],
    agentJobs: [],
    agentScope: null,
    goal: goalStateSnapshot(runtime.goalStatus?.() || null),
    toolMode: runtime.toolMode,
    cwd: runtimeCwd,
    themeEpoch: 0,
  };
}
