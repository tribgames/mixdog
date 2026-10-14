/**
 * routes.mjs — the session object's route surface: provider/model catalogs,
 * the serialized optimistic setRoute, web-search route, workflows, agent
 * definitions, output style and orchestration mode.
 */
import { modelSwitchItem } from '../../../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { selectedModel, switchesSessionModel } from '../../../session-runtime/model-route/model-switch-target.mjs';
import { latestQuotaFailure } from '../quota-resume.mjs';
import { createApiHelpers } from './shared.mjs';

// Optimistic route preview: the requested provider/model/effort/fast are
// published before the runtime write settles. What is NOT previewed about the
// route (effort options, Fast capability, context window) is provider
// metadata the runtime resolves while the preview is already on screen.
const ROUTE_PREVIEW_KEYS = [
  'provider',
  'model',
  'effort',
  'fast',
  'autoEffort',
  'modelParameters',
  'contextPercent',
  'contextTokens',
];

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

/** The live divider of an in-place model switch (restored from message meta
 *  after a reload); every switch path publishes it the same way. */
export function publishModelSwitch(bag, modelSwitch) {
  if (modelSwitch) bag.pushItem(modelSwitchItem(bag.nextId(), modelSwitch));
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
  const { withCommandLock, publishRoute, deferStatsRefresh } = createApiHelpers({
    getState,
    set,
    resetStatsAndSyncContext,
    routeState,
    syncContextStats,
  });
  let routeWrite = null;
  let routeSequence = 0;

  // A preset selector previews as the preset's model, never as its id.
  const previewedRequest = (routeOpts) => {
    if (routeOpts.provider || !routeOpts.model) return routeOpts;
    const target = selectedModel(runtime, routeOpts, '', '');
    return target.provider ? { ...routeOpts, ...target } : routeOpts;
  };

  // Auto-compact on model change (default on): compact on the CURRENT model,
  // whose cache and window still hold the history, before the switch. A model
  // stopped on its quota cannot run it; the next turn's auto-compaction on the
  // new model fits the history instead. A failure never blocks the switch.
  const compactBeforeModelSwitch = async () => {
    if (runtime.getCompactionSettings?.()?.onModelChange === false) return;
    if (latestQuotaFailure(getState().items)) return;
    if (typeof bag.compactBeforeModelSwitch !== 'function') return;
    set({
      commandStatus: { active: true, verb: 'Compacting conversation', startedAt: Date.now(), mode: 'compacting' },
    });
    flushEmitImmediate();
    try {
      await bag.compactBeforeModelSwitch();
    } catch {
      /* the switch goes ahead; next-turn auto-compaction fits the window */
    } finally {
      set({ commandStatus: null });
    }
  };

  const setRoute = async (opts) => {
    if (getState().commandBusy && !routeWrite) return false;
    const routeOpts = opts && typeof opts === 'object' ? opts : {};
    // Every user model choice on this surface (composer picker, /model,
    // presets, the TUI picker) switches the conversation itself in place.
    const switchesModel = switchesSessionModel(runtime, routeOpts);
    // A running turn keeps the route it started on.
    if (switchesModel && getState().busy) {
      throw new Error('The model cannot change while a response is running. Try again when it finishes.');
    }
    // Any route change supersedes waiting for the old route's quota reset.
    bag.supersedeQuotaResume?.(getState().sessionId);
    const token = ++routeSequence;
    const previousWrite = routeWrite;
    const preview = optimisticRoutePatch(previewedRequest(routeOpts), getState());
    // Preview immediately, serialize persistence without dropping a later
    // click. Earlier completions cannot replace the newest visible choice.
    // A model switch previews once its pre-compaction (which republishes the
    // current route) is done.
    set({ commandBusy: true, ...(switchesModel ? {} : preview || {}) });
    flushEmitImmediate();
    const write = (async () => {
      if (previousWrite) await previousWrite.catch(() => {});
      const previousRoute = routeState();
      try {
        // Explicit addressing applies the route to this session: an empty
        // one is initialized in place. Either way an established
        // conversation follows the user's choice in place.
        const applyToCurrentSession = routeOpts.applyToCurrentSession === true;
        const keepMainModel = routeOpts.keepMainModel === true;
        const { applyToCurrentSession: _drop, keepMainModel: _keep, ...nextRoute } = routeOpts;
        if (switchesModel) {
          // The destination must be accepted before the history is compacted.
          await runtime.setRoute(nextRoute, { validateOnly: true });
          await compactBeforeModelSwitch();
          if (token === routeSequence && preview) {
            set(preview);
            flushEmitImmediate();
          }
        }
        const resolvedRoute = await runtime.setRoute(nextRoute, {
          applyToCurrentSession,
          keepMainModel,
          switchEstablished: true,
        });
        if (token === routeSequence) {
          if (applyToCurrentSession || resolvedRoute?.modelSwitch) syncContextStats({ allowEstimated: true });
          publishRoute();
        }
        publishModelSwitch(bag, resolvedRoute?.modelSwitch);
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
  // The settings surface's setModel (/model, presets) is the same user
  // model choice and runs through this one path.
  bag.setSessionRoute = setRoute;

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
    getProviderSetup: (options = {}) => {
      return runtime.getProviderSetup(options);
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
      // Style change repaints immediately; stats settle right after.
      deferStatsRefresh();
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
