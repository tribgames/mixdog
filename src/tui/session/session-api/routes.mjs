/**
 * routes.mjs — the session object's route surface: provider/model catalogs,
 * the serialized optimistic setRoute, web-search route, workflows, agent
 * definitions, output style and orchestration mode.
 */
import { modelSwitchItem } from '../../../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { selectedModel } from '../../../session-runtime/model-route/model-switch-target.mjs';
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

const SESSION_ONLY_KEYS = new Set(['provider', 'model', 'effort', 'fast', 'autoEffort']);

/**
 * A session-only request (an agent child's route) may name just the model, just
 * the tuning, or both. Completed here, inside the serialized route write,
 * against the latest selected route — so a Fast-only change keeps the effort a
 * previous write selected. `unchanged` when it asks for nothing the selected
 * route does not already have.
 */
function completeSessionOnlyRequest(request, selected) {
  const named = Boolean(request.provider || request.model);
  const target = named ? request : { ...request, provider: selected.provider, model: selected.model };
  const sameModel = target.provider === selected.provider && target.model === selected.model;
  if (!sameModel) return { request: target, unchanged: false };
  const unchanged =
    Object.keys(request).every((key) => SESSION_ONLY_KEYS.has(key)) &&
    (request.effort === undefined || request.effort === selected.effort) &&
    (request.fast === undefined || request.fast === (selected.fast === true)) &&
    (request.autoEffort === undefined || request.autoEffort === (selected.autoEffort !== false));
  return {
    unchanged,
    request: {
      ...(selected.effort ? { effort: selected.effort } : {}),
      fast: selected.fast === true,
      autoEffort: selected.autoEffort !== false,
      ...target,
    },
  };
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
  // Whether this API (not another command) is the one holding commandBusy.
  let routeLocked = false;

  // A preset selector previews as the preset's model, never as its id.
  const previewedRequest = (routeOpts) => {
    if (routeOpts.provider || !routeOpts.model) return routeOpts;
    const target = selectedModel(runtime, routeOpts, '', '');
    return target.provider ? { ...routeOpts, ...target } : routeOpts;
  };

  const setRoute = async (opts) => {
    const routeOpts = opts && typeof opts === 'object' ? opts : {};
    // All model pickers save a selection for the conversation's next turn; a
    // running turn keeps the session model it started on. A selection is never
    // refused: another command's lock neither blocks it nor is released by it.
    const token = ++routeSequence;
    const previousWrite = routeWrite;
    // The session generation this selection was made under. The write below
    // waits behind earlier ones, so "current" is never read later: the runtime
    // validates this token before every route side effect, and `settle` below
    // is the only place the display is touched once the write has started.
    const originGeneration = runtime.sessionGeneration;
    const owned = () => runtime.sessionGeneration === originGeneration;
    const preview = optimisticRoutePatch(previewedRequest(routeOpts), getState());
    // Preview immediately, serialize persistence without dropping a later
    // click. Earlier completions cannot replace the newest visible choice.
    if (!getState().commandBusy) routeLocked = true;
    set({ ...(routeLocked ? { commandBusy: true } : {}), ...(preview || {}) });
    flushEmitImmediate();
    const write = (async () => {
      if (previousWrite) await previousWrite.catch(() => {});
      const previousRoute = routeState();
      // A stale selection only republishes the route that is actually
      // selected; it never restores or announces its own session's state.
      const settle = ({ failed = false, sync = false, modelSwitch = null } = {}) => {
        const stillOwned = owned();
        if (stillOwned) publishModelSwitch(bag, modelSwitch);
        // A newer selection publishes the final route itself.
        if (token !== routeSequence) return;
        if (stillOwned && failed) {
          if (preview) set({ ...previousRoute, stats: { ...getState().stats } });
          return;
        }
        if (stillOwned && sync) syncContextStats({ allowEstimated: true });
        publishRoute();
      };
      try {
        // Keep the durable session address while deferring route application.
        const applyToCurrentSession = routeOpts.applyToCurrentSession === true;
        const keepMainModel = routeOpts.keepMainModel !== false;
        const sessionOnly = routeOpts.sessionOnly === true;
        const { applyToCurrentSession: _drop, keepMainModel: _keep, sessionOnly: _scope, ...requested } = routeOpts;
        let nextRoute = requested;
        if (sessionOnly) {
          const completed = completeSessionOnlyRequest(requested, previousRoute);
          if (completed.unchanged) {
            // An earlier failed write skipped its rollback because this one is
            // newer, so the shown route may still be that write's preview.
            settle();
            return previousRoute;
          }
          nextRoute = completed.request;
        }
        const resolvedRoute = await runtime.setRoute(nextRoute, {
          applyToCurrentSession,
          keepMainModel,
          ...(sessionOnly ? { sessionOnly } : {}),
          ...(originGeneration !== undefined ? { originGeneration } : {}),
          switchEstablished: true,
          deferUntilNextTurn: true,
        });
        settle({
          sync: applyToCurrentSession || Boolean(resolvedRoute?.modelSwitch),
          modelSwitch: resolvedRoute?.modelSwitch,
        });
        return resolvedRoute;
      } catch (error) {
        settle({ failed: true });
        throw error;
      } finally {
        if (token === routeSequence) {
          if (routeLocked) set({ commandBusy: false });
          routeLocked = false;
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
