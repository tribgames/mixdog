/**
 * routes.mjs — the session object's route surface: provider/model catalogs,
 * the serialized optimistic setRoute, web-search route, workflows, agent
 * definitions, output style and orchestration mode.
 */
import { createApiHelpers } from './shared.mjs';

// Optimistic route preview: the requested provider/model/effort/fast are
// published before the runtime write settles. What is NOT previewed about the
// route (effort options, Fast capability, context window) is provider
// metadata the runtime resolves while the preview is already on screen.
const ROUTE_PREVIEW_KEYS = ['provider', 'model', 'effort', 'fast', 'modelParameters', 'contextPercent'];

/**
 * The patch that publishes a requested route before the runtime write settles.
 * Returns null when the request carries nothing previewable.
 */
function optimisticRoutePatch(requested = {}, current = {}) {
  const route = requested && typeof requested === 'object' ? requested : {};
  const has = (key) => Object.hasOwn(route, key);
  const patch = {};
  for (const key of ROUTE_PREVIEW_KEYS) {
    if (has(key)) patch[key] = route[key];
  }
  if (!has('provider') && !has('model')) {
    return Object.keys(patch).length > 0 ? patch : null;
  }
  const sameModel =
    String(patch.provider ?? current.provider ?? '') === String(current.provider ?? '') &&
    String(patch.model ?? current.model ?? '') === String(current.model ?? '');
  // A different model carries none of the previous model's tuning: an omitted
  // key means "this model has no such control", not "keep the old value".
  if (!sameModel) {
    if (!has('effort')) patch.effort = null;
    if (!has('fast')) patch.fast = false;
    if (!has('modelParameters')) patch.modelParameters = {};
  }
  return patch;
}

export function createSessionRouteApi(bag) {
  const {
    runtime,
    getState,
    set,
    flushEmitImmediate,
    routeState,
    syncContextStats,
    resetStats,
    resetStatsAndSyncContext,
  } = bag;
  const { withCommandLock } = createApiHelpers({ getState, set, resetStatsAndSyncContext, routeState });
  const publishRoute = () => set({ ...routeState(), stats: { ...getState().stats } });
  let routeWrite = null;
  let routeSequence = 0;

  const setRoute = async (opts) => {
    if (getState().commandBusy && !routeWrite) return false;
    const token = ++routeSequence;
    const previousWrite = routeWrite;
    const routeOpts = opts && typeof opts === 'object' ? opts : {};
    const preview = optimisticRoutePatch(routeOpts, getState());
    // Preview immediately, serialize persistence without dropping a later
    // click. Earlier completions cannot replace the newest visible choice.
    set({ commandBusy: true, ...(preview || {}) });
    flushEmitImmediate();
    const write = (async () => {
      if (previousWrite) await previousWrite.catch(() => {});
      const previousRoute = routeState();
      try {
        // Explicit addressing initializes an empty session in place; the
        // runtime continues to own established-session route policy.
        const applyToCurrentSession = routeOpts.applyToCurrentSession === true;
        const { applyToCurrentSession: _drop, ...nextRoute } = routeOpts;
        const resolvedRoute = await runtime.setRoute(nextRoute, { applyToCurrentSession });
        if (token === routeSequence) {
          if (applyToCurrentSession) syncContextStats({ allowEstimated: true });
          publishRoute();
        }
        return resolvedRoute;
      } catch (error) {
        if (token === routeSequence && preview) {
          set({ ...previousRoute, stats: { ...getState().stats } });
        }
        throw error;
      } finally {
        if (token === routeSequence) {
          set({ commandBusy: false });
          // Publish the resolved route (or rollback) before an RPC reply
          // reads getState(), even while the display-frame clock is busy.
          flushEmitImmediate();
        }
      }
    })();
    routeWrite = write;
    try {
      return await write;
    } finally {
      if (routeWrite === write) routeWrite = null;
    }
  };

  const setWebSearchRoute = async (opts) => {
    if (getState().commandBusy) return null;
    const beforeRouteState = routeState();
    let optimisticWebSearchRoute = null;
    if (opts?.provider && opts?.model) {
      optimisticWebSearchRoute = { provider: String(opts.provider).trim(), model: String(opts.model).trim() };
      if (opts.effort) optimisticWebSearchRoute.effort = opts.effort;
      if (opts.fast === true) optimisticWebSearchRoute.fast = true;
      if (opts.modelParameters) optimisticWebSearchRoute.modelParameters = { ...opts.modelParameters };
      if (opts.toolType) optimisticWebSearchRoute.toolType = opts.toolType;
    }
    set({ commandBusy: true });
    try {
      if (optimisticWebSearchRoute?.provider && optimisticWebSearchRoute.model) {
        set({ webSearchRoute: optimisticWebSearchRoute });
      }
      const result = await runtime.setWebSearchRoute?.(opts);
      publishRoute();
      return result;
    } catch (e) {
      set({ webSearchRoute: beforeRouteState.webSearchRoute || null });
      throw e;
    } finally {
      set({ commandBusy: false });
    }
  };

  return {
    listPresets: () => {
      return runtime.listPresets();
    },
    listProviderModels: (options = {}) => {
      return runtime.listProviderModels(options);
    },
    prefetchSession: (id) => {
      return runtime.prefetchSession?.(id) === true;
    },
    listProviders: () => {
      return runtime.listProviders();
    },
    getProviderSetup: () => {
      return runtime.getProviderSetup();
    },
    setRoute,
    setAgentRoute: async (agentId, opts) => {
      return await runtime.setAgentRoute?.(agentId, opts);
    },
    getWebSearchRoute: () => {
      return runtime.getWebSearchRoute?.() || runtime.webSearchRoute || null;
    },
    listWebSearchModels: (options = {}) => {
      return runtime.listWebSearchModels?.(options) || [];
    },
    setWebSearchRoute,
    listAgents: () => {
      return runtime.listAgents?.() || [];
    },
    listWorkflows: () => {
      return runtime.listWorkflows?.() || [];
    },
    // Workflow pack editing (desktop Workflows page): direct passthroughs —
    // the runtime owns validation, user-pack persistence, and delete guards.
    getWorkflowPack: (workflowId) => runtime.getWorkflowPack?.(workflowId) ?? null,
    saveWorkflowPack: async (payload) => runtime.saveWorkflowPack?.(payload) ?? null,
    createWorkflow: async (payload) => runtime.createWorkflow?.(payload) ?? null,
    deleteWorkflow: async (workflowId) => runtime.deleteWorkflow?.(workflowId) ?? null,
    getAgentDefinition: (agentId) => runtime.getAgentDefinition?.(agentId) ?? null,
    saveAgentDefinition: async (payload) => runtime.saveAgentDefinition?.(payload) ?? null,
    deleteAgentDefinition: async (agentId) => runtime.deleteAgentDefinition?.(agentId) ?? null,
    getOutputStyle: () => {
      return runtime.getOutputStyle?.() || runtime.listOutputStyles?.() || null;
    },
    listOutputStyles: () => {
      return (
        runtime.listOutputStyles?.() ||
        runtime.getOutputStyle?.() || { styles: [], current: null, configured: 'default' }
      );
    },
    setOutputStyle: withCommandLock(async (styleId) => {
      const result = await runtime.setOutputStyle?.(styleId);
      resetStats();
      publishRoute();
      // Defer the context recompute (transcript scan) off this tick so the
      // style change repaints immediately; stats settle right after.
      setTimeout(() => {
        syncContextStats({ allowEstimated: true });
        set({ stats: { ...getState().stats } });
      }, 0);
      return result;
    }),
    setWorkflow: withCommandLock(async (workflowId) => {
      const result = await runtime.setWorkflow?.(workflowId);
      publishRoute();
      return result;
    }),
    getOrchestrationMode: () => runtime.getOrchestrationMode(),
    setOrchestrationMode: withCommandLock(async (mode) => {
      const result = await runtime.setOrchestrationMode(mode);
      publishRoute();
      return result;
    }),
  };
}
