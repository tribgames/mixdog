// Transcript-activity signatures: the agent-state
// revision key, the L2 statusline web-search pending-tool signature
// (engine-published fast path + local transcript fallback), and the
// primitive statusline stats snapshot.
import { useMemo } from 'react';
// eslint-disable-next-line import/no-relative-packages
import { classifyToolCategory } from '../../runtime/shared/tool-surface.mjs';

// Signature slots, in order: shell, web search, agent.
const SIGNATURE_CATEGORIES = ['Shell', 'Web Research', 'Agent'];

// Pending calls per signature slot for one unresolved tool card: aggregate
// cards carry a `categories` map; standalone cards resolve their name/args.
function pendingCategoryHits(it, count) {
  const hits = [0, 0, 0];
  const add = (category, calls) => {
    const slot = SIGNATURE_CATEGORIES.indexOf(category);
    if (slot >= 0) hits[slot] += calls;
  };
  if (it.aggregate && it.categories && typeof it.categories === 'object') {
    for (const v of Object.values(it.categories)) {
      const entry = v && typeof v === 'object' ? v : null;
      add(entry ? entry.category : null, Math.max(1, Number(entry ? entry.count : 1) || 1));
    }
  } else if (it.name) {
    add(classifyToolCategory(it.name, it.args || {}), count);
  }
  return hits;
}

export function useTranscriptActivity({ state }) {
  // agentRevision is a cheap change-detection key for downstream consumers, but
  // JSON.stringify over the worker/job arrays ran on EVERY render (including the
  // ~120fps streaming reconciles). Memoize on the agent slices so it only
  // recomputes when agent state actually changes, not on every assistant delta.
  const agentRevision = useMemo(
    () =>
      JSON.stringify({
        workers: (state.agentWorkers || []).map((w) => [w.tag, w.status, w.stage, w.sessionId]).slice(0, 20),
        jobs: (state.agentJobs || [])
          .map((j) => [j.task_id, j.status, j.tag, j.sessionId, j.startedAt, j.finishedAt, j.error])
          .slice(0, 20),
      }),
    [state.agentWorkers, state.agentJobs]
  );

  // Surface-tool activity is the MAIN session's own running tool cards.
  // Derive pending counts + oldest
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
    const counts = [0, 0, 0];
    const starts = [0, 0, 0];
    for (const it of items) {
      if (it?.kind !== 'tool') continue;
      const count = Math.max(1, Number(it.count || 1));
      // Resolved check: aggregates stay on the pure completedCount>=count test
      // because engine patchToolCardResult sets `result` on EVERY aggregate
      // patch (even partial, completedCount<count), so a `result`-aware check
      // would drop a still-running aggregate early. Standalone cards mirror
      // toolItemPendingForRows (done when completedCount>=count OR a result
      // landed) so an abnormally-finished card (cancelled/errored) that sets a
      // result without bumping completedCount cannot pin a phantom segment.
      const fallbackDone = it.result == null ? 0 : count;
      const done = it.aggregate
        ? Number(it.completedCount || 0)
        : Math.max(0, Math.min(count, Number(it.completedCount || fallbackDone)));
      if (done >= count) continue; // resolved card (matches toolItemPendingForRows)
      const started = Number(it.startedAt || 0);
      pendingCategoryHits(it, count).forEach((hits, slot) => {
        if (hits <= 0) return;
        counts[slot] += hits;
        if (started > 0 && (starts[slot] === 0 || started < starts[slot])) starts[slot] = started;
      });
    }
    if (!counts.some(Boolean)) return '';
    return counts.map((total, slot) => `${total}:${starts[slot]}`).join(':');
  }, [state.activeToolSummary, state.items]);

  const activeTools = useMemo(() => {
    if (!activeToolsSignature) return null;
    const [hc, hs, sc, ss, ac, as] = activeToolsSignature.split(':').map((n) => Number(n) || 0);
    return {
      ...(hc ? { shell: { count: hc, startedAt: hs } } : {}),
      ...(sc ? { web_search: { count: sc, startedAt: ss } } : {}),
      ...(ac ? { agent: { count: ac, startedAt: as } } : {}),
    };
  }, [activeToolsSignature]);

  // StatusLine only reads a small stats subset; engine clones the full stats
  // object on many updates. Memoize by field value so identical usage keeps
  // the same object reference and React.memo / effect deps stay quiet.
  const {
    currentContextSource,
    currentEstimatedContextTokens,
    currentContextTokens,
    contextTokens,
    latestPromptTokens,
    latestInputTokens,
    latestCachedTokens,
    latestCacheWriteTokens,
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    promptTokens,
    turns,
  } = state.stats || {};
  const statuslineStats = useMemo(
    () => ({
      currentContextSource: currentContextSource ?? null,
      currentEstimatedContextTokens: currentEstimatedContextTokens ?? 0,
      currentContextTokens: currentContextTokens ?? null,
      contextTokens: contextTokens ?? 0,
      latestPromptTokens: latestPromptTokens ?? 0,
      latestInputTokens: latestInputTokens ?? 0,
      latestCachedTokens: latestCachedTokens ?? 0,
      latestCacheWriteTokens: latestCacheWriteTokens ?? 0,
      inputTokens: inputTokens ?? 0,
      cachedTokens: cachedTokens ?? 0,
      cacheWriteTokens: cacheWriteTokens ?? 0,
      promptTokens: promptTokens ?? 0,
      turns: turns ?? 0,
    }),
    [
      currentContextSource,
      currentEstimatedContextTokens,
      currentContextTokens,
      contextTokens,
      latestPromptTokens,
      latestInputTokens,
      latestCachedTokens,
      latestCacheWriteTokens,
      inputTokens,
      cachedTokens,
      cacheWriteTokens,
      promptTokens,
      turns,
    ]
  );

  return { agentRevision, activeTools, statuslineStats };
}
