/**
 * src/tui/session/active-tool-summary.mjs - surfaced-tool activity summary.
 *
 * Status surfaces must react at tool start, before a shell is backgrounded or
 * an agent worker heartbeat exists. Track the three surfaced categories
 * directly; background shell records and worker rows later dedupe by max.
 */
// Tool category -> the activeTools key it publishes under. Iteration order is
// also the field order of the activeToolSummary string.
const SURFACED_CATEGORIES = new Map([
  ['Shell', 'shell'],
  ['Web Research', 'web_search'],
  ['Agent', 'agent'],
]);

export function createActiveToolTracker({ getState, set }) {
  const activeToolCalls = new Map(); // callKey -> { category, count, startedAt }
  const recomputeActiveToolSummary = () => {
    const totals = new Map([...SURFACED_CATEGORIES.keys()].map((category) => [category, { count: 0, startedAt: 0 }]));
    for (const rec of activeToolCalls.values()) {
      const total = rec ? totals.get(rec.category) : null;
      if (!total) continue;
      total.count += Math.max(1, Number(rec.count || 1));
      const started = Number(rec.startedAt || 0);
      if (started > 0 && (total.startedAt === 0 || started < total.startedAt)) total.startedAt = started;
    }
    const surfaced = [...totals.values()].some((total) => total.count);
    const next = surfaced ? [...totals.values()].map((total) => `${total.count}:${total.startedAt}`).join(':') : '';
    let activeTools = null;
    if (next) {
      activeTools = {};
      for (const [category, key] of SURFACED_CATEGORIES) {
        const total = totals.get(category);
        if (total.count) activeTools[key] = { count: total.count, startedAt: total.startedAt };
      }
    }
    const prev = getState().activeToolSummary || '';
    if (next !== prev) set({ activeToolSummary: next || null, activeTools });
  };
  const markToolCallActive = (callKey, category, count, startedAt) => {
    if (!callKey || !SURFACED_CATEGORIES.has(category)) return;
    activeToolCalls.set(callKey, {
      category,
      count: Math.max(1, Number(count || 1)),
      startedAt: Number(startedAt || Date.now()),
    });
    recomputeActiveToolSummary();
  };
  const markToolCallDone = (callKey) => {
    if (!callKey || !activeToolCalls.delete(callKey)) return;
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
