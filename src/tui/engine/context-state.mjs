/**
 * src/tui/engine/context-state.mjs - route/context/agent-status derivations.
 *
 * Extracted from engine.mjs unchanged. These read the live runtime + store
 * snapshot and (for the two sync helpers) mutate state.stats / the display
 * context fields IN PLACE — the exact same object the store owns — so the
 * immutable-emit contract is preserved by their callers, which follow up with
 * a set({ stats: { ...state.stats }, ...routeState() }). getState() must return
 * the live (latest) store object; getPendingSessionReset() gates the stats
 * sync exactly as the old inline `pendingSessionReset` closure did.
 */
export function createContextState({ runtime, getState, getPendingSessionReset }) {
  const autoClearState = () => runtime.getAutoClear?.() || runtime.autoClear || { enabled: true, idleMs: 60 * 60 * 1000, custom: false, providerDefault: 60 * 60 * 1000, provider: null, minContextPercent: 10 };
  const AGENT_STATUS_CACHE_MS = 250;
  let agentStatusCache = null;
  let agentStatusCacheAt = 0;
  const agentStatusState = ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && agentStatusCache && now - agentStatusCacheAt < AGENT_STATUS_CACHE_MS) return agentStatusCache;
    const status = runtime.agentStatus?.() || {};
    agentStatusCache = {
      agentWorkers: Array.isArray(status.agentWorkers) ? status.agentWorkers : [],
      agentJobs: Array.isArray(status.agentJobs) ? status.agentJobs : [],
      agentScope: status.agentScope || null,
    };
    agentStatusCacheAt = now;
    return agentStatusCache;
  };
  const baseRouteState = () => ({
    sessionId: runtime.id,
    clientHostPid: runtime.clientHostPid || null,
    model: runtime.model,
    provider: runtime.provider,
    effort: runtime.effort,
    effortOptions: runtime.effortOptions,
    fast: runtime.fast,
    fastCapable: runtime.fastCapable,
    contextWindow: runtime.contextWindow,
    rawContextWindow: runtime.rawContextWindow,
    effectiveContextWindowPercent: runtime.effectiveContextWindowPercent,
    cwd: runtime.cwd || process.cwd(),
    systemShell: runtime.systemShell || { source: 'auto', command: '', effective: '' },
    searchRoute: runtime.getSearchRoute?.() || runtime.searchRoute || null,
    autoClear: autoClearState(),
    workflow: runtime.workflow || null,
    remoteEnabled: runtime.isRemoteEnabled?.() === true,
  });

  const routeState = () => {
    const state = getState();
    const base = baseRouteState();
    const sameContextRoute = state.sessionId === base.sessionId
      && state.clientHostPid === base.clientHostPid
      && state.provider === base.provider
      && state.model === base.model
      && state.effort === base.effort
      && state.fast === base.fast
      && state.contextWindow === base.contextWindow
      && state.rawContextWindow === base.rawContextWindow;
    return {
      ...base,
      displayContextWindow: sameContextRoute ? (state.displayContextWindow || 0) : 0,
      compactBoundaryTokens: sameContextRoute ? (state.compactBoundaryTokens || 0) : 0,
      autoCompactTokenLimit: sameContextRoute ? (state.autoCompactTokenLimit || 0) : 0,
    };
  };

  function syncContextDisplayFields(ctx = null) {
    const status = ctx || runtime.contextStatus?.() || null;
    if (!status) return;
    const state = getState();
    const displayWindow = Number(status.contextWindow || 0);
    const compactBoundary = Number(status.compaction?.boundaryTokens || 0);
    // Prefer the resolved trigger (boundary - buffer): the statusline uses it
    // as the display denominator so context % reads 100% exactly when
    // auto-compact fires, instead of stalling at ~90% of the boundary.
    const autoCompact = Number(
      status.compaction?.triggerTokens
      || status.compaction?.autoCompactTokenLimit
      || runtime.session?.autoCompactTokenLimit
      || 0,
    );
    if (displayWindow > 0) state.displayContextWindow = displayWindow;
    if (compactBoundary > 0) state.compactBoundaryTokens = compactBoundary;
    if (autoCompact > 0) state.autoCompactTokenLimit = autoCompact;
  }

  const syncContextStats = ({ allowEstimated = false } = {}) => {
    if (getPendingSessionReset()) return null;
    const ctx = runtime.contextStatus?.() || null;
    if (!ctx) return null;
    syncContextDisplayFields(ctx);
    const state = getState();
    const hasProviderUsage = Number(state.stats.latestPromptTokens || state.stats.latestInputTokens || state.stats.inputTokens || 0) > 0;
    const hasApiContextUsage = Number(ctx?.lastApiRequestTokens ?? ctx?.usage?.lastContextTokens ?? 0) > 0;
    const hasTurnActivity = state.busy === true
      || state.spinner != null
      || state.thinking != null;
    const isFreshSession = !hasProviderUsage && !hasApiContextUsage && !hasTurnActivity;
    if (isFreshSession) {
      state.stats.currentEstimatedContextTokens = 0;
      state.stats.currentContextTokens = 0;
      state.stats.currentContextSource = null;
      state.stats.currentContextUpdatedAt = Date.now();
      return ctx;
    }
    const estimatedTokens = Math.max(0, Number(ctx.currentEstimatedTokens ?? ctx.usedTokens ?? 0));
    const usedTokens = Math.max(0, Number(ctx.usedTokens ?? estimatedTokens ?? 0));
    const usedSource = String(ctx.usedSource || '').toLowerCase();
    const shouldPublishEstimate = allowEstimated && (
      usedSource === 'estimated'
      || Number(ctx.currentEstimatedTokens) > 0
      || usedTokens > 0
    );
    if (!allowEstimated && !hasProviderUsage && usedSource !== 'last_api_request') return ctx;
    if (shouldPublishEstimate) {
      state.stats.currentEstimatedContextTokens = estimatedTokens;
      state.stats.currentContextSource = 'estimated';
      state.stats.currentContextTokens = 0;
    } else if (allowEstimated && (hasProviderUsage || hasApiContextUsage || hasTurnActivity)) {
      state.stats.currentEstimatedContextTokens = estimatedTokens;
      state.stats.currentContextSource = usedSource || (estimatedTokens > 0 ? 'estimated' : null);
      const publishedSource = String(state.stats.currentContextSource || '').toLowerCase();
      if (publishedSource === 'last_api_request') {
        const apiUsed = Math.max(0, Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0));
        state.stats.currentContextTokens = apiUsed;
      } else if (publishedSource === 'estimated') {
        state.stats.currentContextTokens = 0;
      } else {
        state.stats.currentContextTokens = usedTokens > 0 ? usedTokens : 0;
      }
    } else {
      state.stats.currentEstimatedContextTokens = 0;
      if (usedSource === 'last_api_request' && Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0) > 0) {
        state.stats.currentContextTokens = Math.max(0, Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0));
        state.stats.currentContextSource = 'last_api_request';
      } else {
        state.stats.currentContextTokens = 0;
        state.stats.currentContextSource = null;
      }
    }
    state.stats.currentContextUpdatedAt = Date.now();
    return ctx;
  };

  return {
    autoClearState,
    agentStatusState,
    baseRouteState,
    routeState,
    syncContextDisplayFields,
    syncContextStats,
  };
}
