// Session lifecycle: first-turn route resolution, route-effort refresh and
// createCurrentSession (provider session construction with MCP wiring and
// reset handling), plus the warmup/prewarm schedulers they feed. Shared
// mutable runtime state flows through the rt bag. The route derivations live
// in route-state.mjs / route-resolution.mjs and the session construction in
// session-create.mjs.
import { ensureProviderEnabled } from './config-helpers.mjs';
import { bootProfile } from './boot-profile.mjs';
import { createWarmupSchedulers } from './warmup-schedulers.mjs';
import { warmCatalogsInBackground } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { envFlag } from '../runtime/shared/env.mjs';
import { createPrewarmSchedulers } from './prewarm.mjs';
import { hasActiveAutomation } from '../standalone/channel-admin.mjs';
import { createSessionTranscript } from './session-transcript.mjs';
import { createRouteResolution } from './route-resolution.mjs';
import { createSessionCreator } from './session-create.mjs';

export { resolveRouteContextState, resolveRouteEffortState } from './route-state.mjs';

export function createSessionLifecycle(deps) {
  const {
    rt,
    ensureProvidersReady,
    awaitKeychainPrewarm,
    ensureConfigForRouteProvider,
    warmupTimers,
    providerModelCaches,
    reloadFullConfig,
    refreshStatuslineUsageSnapshot,
    warmProviderModelCache,
    cachedProviderSetup,
    providerWarmupDelayMs,
    providerSetupWarmupDelayMs,
    providerModelWarmupDelayMs,
    modelCatalogWarmupDelayMs,
    statuslineUsageWarmupDelayMs,
    statuslineUsageRefreshDelayMs,
    backgroundBusyRetryMs,
    providerWarmupEnabled,
    modelPrefetchEnabled,
    modelCatalogWarmupEnabled,
    prewarmTimers,
    getCodeGraphModule,
    channels,
    codeGraphPrewarmDelayMs,
    channelStartDelayMs,
    codeGraphPrewarmEnabled,
    prewarmState,
  } = deps;
  const routes = createRouteResolution(deps);
  const { routeHasModel, requireModelRoute, resolveMissingRouteModelForFirstTurn, refreshRouteEffort } = routes;
  const createCurrentSession = createSessionCreator(deps, routes);

  async function recreateCurrentSessionIfReady() {
    if (!routeHasModel()) {
      rt.session = null;
      return null;
    }
    return await createCurrentSession();
  }

  const {
    scheduleProviderWarmup,
    scheduleProviderSetupWarmup,
    scheduleProviderModelWarmup,
    scheduleModelCatalogWarmup,
    scheduleStatuslineUsageWarmup,
    scheduleStatuslineUsageRefresh,
  } = createWarmupSchedulers({
    timers: warmupTimers,
    bootProfile,
    getRoute: () => rt.route,
    getConfig: () => rt.config,
    isCloseRequested: () => rt.closeRequested,
    getActiveTurnCount: () => rt.activeTurnCount,
    getSessionCreatePromise: () => rt.sessionCreatePromise,
    getProviderModelsCache: () => providerModelCaches.providerModelsCache,
    getProviderModelsPromise: () => providerModelCaches.providerModelsPromise,
    reloadFullConfig,
    ensureConfigForRouteProvider,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    ensureProviderEnabled,
    refreshStatuslineUsageSnapshot,
    warmProviderModelCache,
    cachedProviderSetup,
    warmCatalogsInBackground,
    isFirstTurnCompleted: () => rt.firstTurnCompleted,
    isCatalogRefreshPending: () => rt.startupProviderCatalogRefreshPending,
    envFlag,
    delays: {
      providerWarmupDelayMs,
      providerSetupWarmupDelayMs,
      providerModelWarmupDelayMs,
      modelCatalogWarmupDelayMs,
      statuslineUsageWarmupDelayMs,
      statuslineUsageRefreshDelayMs,
      backgroundBusyRetryMs,
    },
    flags: {
      providerWarmupEnabled,
      modelPrefetchEnabled,
      modelCatalogWarmupEnabled,
    },
  });
  rt.scheduleProviderModelWarmupRef = scheduleProviderModelWarmup;
  rt.scheduleProviderSetupWarmupRef = scheduleProviderSetupWarmup;

  const {
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    scheduleChannelStart,
    scheduleAutomationAutostart,
  } = createPrewarmSchedulers({
    timers: prewarmTimers,
    bootProfile,
    getCurrentCwd: () => rt.currentCwd,
    isCloseRequested: () => rt.closeRequested,
    getActiveTurnCount: () => rt.activeTurnCount,
    getSessionCreatePromise: () => rt.sessionCreatePromise,
    getSession: () => rt.session,
    hasActiveAutomation,
    getCodeGraphModule,
    createCurrentSession,
    channels,
    envFlag,
    delays: {
      codeGraphPrewarmDelayMs,
      channelStartDelayMs,
      backgroundBusyRetryMs,
    },
    flags: {
      codeGraphPrewarmEnabled,
    },
    state: prewarmState,
  });

  // Session transcript writer lives in session-transcript.mjs; the facade
  // injects the mutable session/cwd state it needs.
  const remoteTranscript = createSessionTranscript({
    getSession: () => rt.session,
    getCwd: () => rt.currentCwd,
  });

  return {
    resolveMissingRouteModelForFirstTurn,
    scheduleProviderWarmup,
    scheduleProviderSetupWarmup,
    scheduleProviderModelWarmup,
    scheduleModelCatalogWarmup,
    scheduleStatuslineUsageWarmup,
    scheduleStatuslineUsageRefresh,
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    scheduleChannelStart,
    scheduleAutomationAutostart,
    refreshRouteEffort,
    routeHasModel,
    requireModelRoute,
    recreateCurrentSessionIfReady,
    createCurrentSession,
    remoteTranscript,
  };
}
