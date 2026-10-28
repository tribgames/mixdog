/*
 * app/use-context-panel-refresh.mjs — keeps an open /context breakdown panel
 * current: it is rebuilt whenever one of the session fields it summarizes
 * changes.
 */
import { useEffect } from 'react';

export function useContextPanelRefresh({ contextPanelKind, state, openContextPicker }) {
  // The deps are the refresh triggers (the fields the breakdown summarizes),
  // not the reads; openContextPicker is rebuilt by its factory every render
  // and must not re-trigger the rebuild.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-keyed refresh over the summarized session fields
  useEffect(() => {
    if (contextPanelKind === 'context') openContextPicker();
  }, [
    contextPanelKind,
    state.stats,
    state.contextWindow,
    state.rawContextWindow,
    state.sessionId,
    state.toolMode,
    state.agentWorkers,
    state.agentJobs,
    state.provider,
    state.model,
    state.effort,
    state.fast,
    state.cwd,
    state.clientHostPid,
  ]);
}
