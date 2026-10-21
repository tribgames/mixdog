/**
 * routes.mjs — the session object's route surface: provider/model catalogs,
 * the serialized optimistic setRoute, web-search route, workflows, agent
 * definitions, output style and orchestration mode.
 */
import {
  orchestrationModeSwitchItem,
  workflowSwitchItem,
} from '../../../runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
import { createAgentDefinitionApi } from './routes-agent-definitions.mjs';
import { createRouteWrite } from './routes-write.mjs';
import { createApiHelpers } from './shared.mjs';

export { publishModelSwitch } from './routes-write.mjs';

/** The live dividers of a conversation's orchestration mode and workflow
 *  switches (made now, or chosen during a turn and applied at the next). */
export function publishSessionSwitches(bag, { orchestrationModeSwitch, workflowSwitch } = {}) {
  if (orchestrationModeSwitch) bag.pushItem(orchestrationModeSwitchItem(bag.nextId(), orchestrationModeSwitch));
  if (workflowSwitch) bag.pushItem(workflowSwitchItem(bag.nextId(), workflowSwitch));
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
  const setRoute = createRouteWrite(bag, {
    runtime,
    getState,
    set,
    flushEmitImmediate,
    routeState,
    syncContextStats,
    publishRoute,
  });

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
    ...createAgentDefinitionApi(runtime),
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
    setWorkflow: withCommandLock(async (workflowId, options) => {
      const result = await runtime.setWorkflow?.(workflowId, options);
      // A switch of this conversation leaves a divider (restored from message meta).
      publishSessionSwitches(bag, { workflowSwitch: result?.workflowSwitch });
      publishRoute();
      return result;
    }),
    getOrchestrationMode: () => runtime.getOrchestrationMode(),
    setOrchestrationMode: withCommandLock(async (mode, options) => {
      const result = await runtime.setOrchestrationMode(mode, options);
      publishSessionSwitches(bag, { orchestrationModeSwitch: result?.orchestrationModeSwitch });
      publishRoute();
      return result;
    }),
  };
}
