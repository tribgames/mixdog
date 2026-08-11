// Transcript-activity signatures, extracted from App.jsx: the agent-state
// revision key, the L2 statusline web-search pending-tool signature
// (engine-published fast path + local transcript fallback), and the
// primitive statusline stats snapshot.
import { useMemo } from 'react';
// eslint-disable-next-line import/no-relative-packages
import { classifyToolCategory } from '../../runtime/shared/tool-surface.mjs';

export function useTranscriptActivity({ state }) {
  // agentRevision is a cheap change-detection key for downstream consumers, but
  // JSON.stringify over the worker/job arrays ran on EVERY render (including the
  // ~120fps streaming reconciles). Memoize on the agent slices so it only
  // recomputes when agent state actually changes, not on every assistant delta.
  const agentRevision = useMemo(() => JSON.stringify({
    workers: (state.agentWorkers || []).map((w) => [w.tag, w.status, w.stage, w.sessionId]).slice(0, 20),
    jobs: (state.agentJobs || []).map((j) => [j.task_id, j.status, j.tag, j.sessionId, j.startedAt, j.finishedAt, j.error]).slice(0, 20),
  }), [state.agentWorkers, state.agentJobs]);

  // The L2 web-search segment is the MAIN session's own running
  // tool cards (NOT agentWorkers/agentJobs). Derive pending counts + oldest
  // start time straight from the live transcript tool cards. A card is pending
  // until completedCount >= count. (Do NOT use completedAt as the terminal
  // signal: engine patchToolCardResult stamps completedAt on EVERY aggregate
  // result patch even while calls are still running, and reused tail-aggregates
  // keep a stale completedAt, so it would drop the segment early / skip newly
  // added pending calls.) Aggregate cards carry a `categories` map; standalone
  // cards carry name/args resolved
  // via classifyToolCategory. Keep this CHEAP: build a primitive signature from
  // only the tool items so streaming flushes that swap
  // state.items for a fresh array don't restringify the whole transcript and
  // the StatusLine effect only re-fires when the numbers actually change.
  const activeToolsSignature = useMemo(() => {
    // The engine maintains this signature incrementally (updated on tool
    // start/early-complete/result/turn-end), so App no longer scans every
    // transcript item on each change. Prefer it; fall back to the local scan
    // only when the engine did not publish it (older snapshot).
    if (state.activeToolSummary !== undefined) return state.activeToolSummary || '';
    const items = state.items || [];
    let searchCount = 0;
    let searchStart = 0;
    for (const it of items) {
      if (!it || it.kind !== 'tool') continue;
      const count = Math.max(1, Number(it.count || 1));
      // Resolved check: aggregates stay on the pure completedCount>=count test
      // because engine patchToolCardResult sets `result` on EVERY aggregate
      // patch (even partial, completedCount<count), so a `result`-aware check
      // would drop a still-running aggregate early. Standalone cards mirror
      // toolItemPendingForRows (done when completedCount>=count OR a result
      // landed) so an abnormally-finished card (cancelled/errored) that sets a
      // result without bumping completedCount cannot pin a phantom segment.
      const done = it.aggregate
        ? Number(it.completedCount || 0)
        : Math.max(0, Math.min(count, Number(it.completedCount || (it.result == null ? 0 : count))));
      if (done >= count) continue; // resolved card (matches toolItemPendingForRows)
      const started = Number(it.startedAt || 0);
      let searchHits = 0;
      if (it.aggregate && it.categories && typeof it.categories === 'object') {
        for (const v of Object.values(it.categories)) {
          const cat = v && typeof v === 'object' ? v.category : null;
          const c = Math.max(1, Number(v && typeof v === 'object' ? v.count : 1) || 1);
          if (cat === 'Web Research') searchHits += c;
        }
      } else if (it.name) {
        const cat = classifyToolCategory(it.name, it.args || {});
        if (cat === 'Web Research') searchHits = count;
      }
      if (searchHits > 0) {
        searchCount += searchHits;
        if (started > 0 && (searchStart === 0 || started < searchStart)) searchStart = started;
      }
    }
    if (!searchCount) return '';
    return `0:0:${searchCount}:${searchStart}`;
  }, [state.activeToolSummary, state.items]);

  const activeTools = useMemo(() => {
    if (!activeToolsSignature) return null;
    const [, , sc, ss] = activeToolsSignature.split(':').map((n) => Number(n) || 0);
    return {
      search: { count: sc, startedAt: ss },
    };
  }, [activeToolsSignature]);

  // StatusLine only reads a small stats subset; engine clones the full stats
  // object on many updates. Memoize by field value so identical usage keeps
  // the same object reference and React.memo / effect deps stay quiet.
  const statuslineStats = useMemo(() => {
    const s = state.stats || {};
    return {
      currentContextSource: s.currentContextSource ?? null,
      currentEstimatedContextTokens: s.currentEstimatedContextTokens ?? 0,
      currentContextTokens: s.currentContextTokens ?? 0,
      contextTokens: s.contextTokens ?? 0,
      latestPromptTokens: s.latestPromptTokens ?? 0,
      latestInputTokens: s.latestInputTokens ?? 0,
      latestCachedTokens: s.latestCachedTokens ?? 0,
      latestCacheWriteTokens: s.latestCacheWriteTokens ?? 0,
      inputTokens: s.inputTokens ?? 0,
      cachedTokens: s.cachedTokens ?? 0,
      cacheWriteTokens: s.cacheWriteTokens ?? 0,
      promptTokens: s.promptTokens ?? 0,
      turns: s.turns ?? 0,
    };
  }, [
    state.stats?.currentContextSource,
    state.stats?.currentEstimatedContextTokens,
    state.stats?.currentContextTokens,
    state.stats?.contextTokens,
    state.stats?.latestPromptTokens,
    state.stats?.latestInputTokens,
    state.stats?.latestCachedTokens,
    state.stats?.latestCacheWriteTokens,
    state.stats?.inputTokens,
    state.stats?.cachedTokens,
    state.stats?.cacheWriteTokens,
    state.stats?.promptTokens,
    state.stats?.turns,
  ]);

  return { agentRevision, activeToolsSignature, activeTools, statuslineStats };
}
