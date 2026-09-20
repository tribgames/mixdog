/**
 * src/tui/session/active-tool-summary.mjs - surfaced-tool activity summary.
 *
 * Status surfaces must react at tool start, before a shell is backgrounded or
 * an agent worker heartbeat exists. Track the three surfaced categories
 * directly; background shell records and worker rows later dedupe by max.
 */
const SURFACED_CATEGORIES = ['Shell', 'Web Research', 'Agent'];

export function createActiveToolTracker({ getState, set }) {
  const activeToolCalls = new Map(); // callKey -> { category, count, startedAt }
  const recomputeActiveToolSummary = () => {
    let shellCount = 0,
      shellStart = 0;
    let webSearchCount = 0,
      webSearchStart = 0;
    let agentCount = 0,
      agentStart = 0;
    for (const rec of activeToolCalls.values()) {
      if (!rec) continue;
      const c = Math.max(1, Number(rec.count || 1));
      const started = Number(rec.startedAt || 0);
      if (rec.category === 'Shell') {
        shellCount += c;
        if (started > 0 && (shellStart === 0 || started < shellStart)) shellStart = started;
      } else if (rec.category === 'Web Research') {
        webSearchCount += c;
        if (started > 0 && (webSearchStart === 0 || started < webSearchStart)) webSearchStart = started;
      } else if (rec.category === 'Agent') {
        agentCount += c;
        if (started > 0 && (agentStart === 0 || started < agentStart)) agentStart = started;
      }
    }
    const next =
      shellCount || webSearchCount || agentCount
        ? `${shellCount}:${shellStart}:${webSearchCount}:${webSearchStart}:${agentCount}:${agentStart}`
        : '';
    let activeTools = null;
    if (next) {
      activeTools = {};
      if (shellCount) activeTools.shell = { count: shellCount, startedAt: shellStart };
      if (webSearchCount) activeTools.web_search = { count: webSearchCount, startedAt: webSearchStart };
      if (agentCount) activeTools.agent = { count: agentCount, startedAt: agentStart };
    }
    const prev = getState().activeToolSummary || '';
    if (next !== prev) set({ activeToolSummary: next || null, activeTools });
  };
  const markToolCallActive = (callKey, category, count, startedAt) => {
    if (!callKey || !SURFACED_CATEGORIES.includes(category)) return;
    activeToolCalls.set(callKey, {
      category,
      count: Math.max(1, Number(count || 1)),
      startedAt: Number(startedAt || Date.now()),
    });
    recomputeActiveToolSummary();
  };
  const markToolCallDone = (callKey) => {
    if (!callKey || !activeToolCalls.has(callKey)) return;
    activeToolCalls.delete(callKey);
    recomputeActiveToolSummary();
  };
  const clearActiveToolSummary = () => {
    const state = getState();
    if (activeToolCalls.size === 0 && !state.activeToolSummary && !state.activeTools) return;
    activeToolCalls.clear();
    if (state.activeToolSummary || state.activeTools) set({ activeToolSummary: null, activeTools: null });
  };
  // A bulk transcript swap discards the old transcript, so drop the tracked
  // calls without publishing: the caller's accompanying patch nulls the summary.
  const resetActiveToolCalls = () => activeToolCalls.clear();
  return { markToolCallActive, markToolCallDone, clearActiveToolSummary, resetActiveToolCalls };
}
