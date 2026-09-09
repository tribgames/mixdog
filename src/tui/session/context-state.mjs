/**
 * src/tui/session/context-state.mjs - route/context/agent-status derivations.
 *
 * Extracted from session-local.mjs unchanged. These read the live runtime + store
 * snapshot. The two sync helpers stage immutable draft patches through
 * updateState; callers still follow with set(...) to schedule publication.
 */
import { contextMeasurementStats } from '../../ui/context-measurement.mjs';

export function createContextState({ runtime, getState, updateState, getPendingSessionReset, getVisibleGoal }) {
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
    // Fork-on-resume marker: when the session runtime opened a live session as a fork
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
    modelParameters: runtime.modelParameters || {},
    contextPercent: runtime.contextPercent,
    contextWindow: runtime.contextWindow,
    rawContextWindow: runtime.rawContextWindow,
    effectiveContextWindowPercent: runtime.effectiveContextWindowPercent,
    cwd: runtime.cwd || process.cwd(),
    systemShell: runtime.systemShell || { source: 'auto', command: '', effective: '' },
    webSearchRoute: runtime.getWebSearchRoute?.() || runtime.webSearchRoute || null,
    autoClear: autoClearState(),
    workflow: runtime.workflow || null,
    // Every `set({ ...routeState() })` (the 2s runtime pulse, model/effort
    // switches, turn end, resume) republishes the Goal. It must read it
    // through the goal-continuation mask: the raw record still holds a
    // completed Goal while its user-input archive is being written, so the
    // retired capsule popped back for one frame and vanished again (user:
    // 안 보이던 골이 생성되었다 바로 사라짐).
    goal: typeof getVisibleGoal === 'function'
      ? getVisibleGoal()
      : (runtime.goalStatus?.() || null),
  });

  const routeState = () => {
    const state = getState();
    const base = baseRouteState();
    const sameContextRoute = state.sessionId === base.sessionId
      && state.clientHostPid === base.clientHostPid
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

  const syncContextStats = ({
    allowEstimated = false,
    invalidateExact = false,
  } = {}) => {
    if (getPendingSessionReset()) return null;
    const ctx = runtime.contextStatus?.() || null;
    if (!ctx) return null;
    syncContextDisplayFields(ctx);
    const stats = { ...getState().stats, ...contextMeasurementStats(ctx) };
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
