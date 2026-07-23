/**
 * src/tui/engine/context-state.mjs - route/context/agent-status derivations.
 *
 * Extracted from engine.mjs unchanged. These read the live runtime + store
 * snapshot. The two sync helpers stage immutable draft patches through
 * updateState; callers still follow with set(...) to schedule publication.
 */
export function createContextState({ runtime, getState, updateState, getPendingSessionReset }) {
  const autoClearState = () => runtime.getAutoClear?.() || runtime.autoClear || { enabled: true, idleMs: 60 * 60 * 1000, custom: false, providerDefault: 60 * 60 * 1000, provider: null, minContextPercent: 30 };
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
    // Fork-on-resume marker: when the engine opened a live session as a fork
    // (fresh id, copied transcript), hosts validating "resume returned the
    // requested session" must accept the fork by its origin id.
    sessionForkedFrom: runtime.session?.forkedFrom || null,
    // Remote-attach marker: this surface is a live viewer on a session owned
    // by another process; submits are injected, transcript follows disk.
    sessionRemoteAttached: runtime.session?.remoteAttached === true,
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
    const patch = {};
    if (displayWindow > 0) patch.displayContextWindow = displayWindow;
    if (compactBoundary > 0) patch.compactBoundaryTokens = compactBoundary;
    if (autoCompact > 0) patch.autoCompactTokenLimit = autoCompact;
    if (Object.keys(patch).length > 0) updateState(patch);
  }

  const syncContextStats = ({ allowEstimated = false } = {}) => {
    if (getPendingSessionReset()) return null;
    const ctx = runtime.contextStatus?.() || null;
    if (!ctx) return null;
    syncContextDisplayFields(ctx);
    const state = getState();
    const stats = { ...state.stats };
    const hasProviderUsage = Number(stats.latestPromptTokens || stats.latestInputTokens || stats.inputTokens || 0) > 0;
    const hasApiContextUsage = Number(ctx?.lastApiRequestTokens ?? ctx?.usage?.lastContextTokens ?? 0) > 0;
    const hasTurnActivity = state.busy === true
      || state.spinner != null
      || state.thinking != null;
    const hasConversationMessages = Number(ctx?.messages?.count || 0) > 0;
    const isFreshSession = !hasProviderUsage && !hasApiContextUsage && !hasTurnActivity
      && !hasConversationMessages;
    if (isFreshSession) {
      stats.currentEstimatedContextTokens = 0;
      stats.currentContextTokens = 0;
      stats.currentContextSource = null;
      stats.currentContextUpdatedAt = Date.now();
      updateState({ stats });
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
      stats.currentEstimatedContextTokens = estimatedTokens;
      stats.currentContextSource = 'estimated';
      stats.currentContextTokens = 0;
    } else if (allowEstimated && (hasProviderUsage || hasApiContextUsage || hasTurnActivity)) {
      stats.currentEstimatedContextTokens = estimatedTokens;
      stats.currentContextSource = usedSource || (estimatedTokens > 0 ? 'estimated' : null);
      const publishedSource = String(stats.currentContextSource || '').toLowerCase();
      if (publishedSource === 'last_api_request') {
        const apiUsed = Math.max(0, Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0));
        stats.currentContextTokens = apiUsed;
      } else if (publishedSource === 'estimated') {
        stats.currentContextTokens = 0;
      } else {
        stats.currentContextTokens = usedTokens > 0 ? usedTokens : 0;
      }
    } else {
      stats.currentEstimatedContextTokens = 0;
      if (usedSource === 'last_api_request' && Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0) > 0) {
        stats.currentContextTokens = Math.max(0, Number(ctx.lastApiRequestTokens ?? usedTokens ?? 0));
        stats.currentContextSource = 'last_api_request';
      } else {
        stats.currentContextTokens = 0;
        stats.currentContextSource = null;
      }
    }
    stats.currentContextUpdatedAt = Date.now();
    updateState({ stats });
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
