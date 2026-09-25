// Boot stage 7: new-session config, the session lifecycle (route resolution,
// createCurrentSession, warmup schedulers), then the deferred warmups.
import { configureEmbedding } from '../../runtime/memory/lib/embedding-provider.mjs';
import { createSessionLifecycle } from '../session-lifecycle.mjs';
import { createNewSessionConfig } from '../new-session-config.mjs';
import { modelToolSchemaAllowlist } from '../tool-profile.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { resolveRoute, workflowHelpers } from './shared.mjs';

export function wireSessionLifecycle(boot) {
  const { rt, params, tunables } = boot;
  const prepareNewSessionConfig = createNewSessionConfig({
    rt,
    sharedCfgMod: boot.sharedCfgMod,
    reloadFullConfig: boot.reloadFullConfig,
    resolveRoute,
    initialConfig: params.initialConfig,
    initialRouteExplicit:
      params.provider !== undefined ||
      params.model !== undefined ||
      params.effort !== undefined ||
      params.fast !== undefined ||
      params.modelParameters !== undefined,
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
    invalidateOutputStyleStatusCache: boot.invalidateOutputStyleStatusCache,
    invalidateSkills: boot.invalidateSkills,
    connectConfiguredMcp: boot.connectConfiguredMcp,
    configureEmbedding,
  });
  const lifecycle = createSessionLifecycle({
    rt,
    adoptSession: boot.adoptSession,
    collectProviderModels: boot.collectProviderModels,
    ensureProvidersReady: boot.ensureProvidersReady,
    lookupModelMeta: boot.lookupModelMeta,
    mgr: boot.mgr,
    loadCoreMemoryContext: boot.loadCoreMemoryContext,
    awaitKeychainPrewarm: boot.awaitKeychainPrewarm,
    prepareNewSessionConfig,
    ensureConfigForRouteProvider: boot.ensureConfigForRouteProvider,
    reg: boot.reg,
    cfgMod: boot.cfgMod,
    activeWorkflowContext: workflowHelpers.activeWorkflowContext,
    hooks: boot.hooks,
    hookCommonPayload: boot.hookCommonPayload,
    mcpClient: boot.mcpClient,
    modelStandaloneTools: boot.modelStandaloneTools,
    schemaAllowedTools: modelToolSchemaAllowlist(rt.toolProfile),
    featureDisallowedTools: boot.featureDisallowedTools,
    applyPreSessionToolSelection: boot.applyPreSessionToolSelection,
    statusRoutes: boot.statusRoutes,
    warmupTimers: boot.warmupTimers,
    providerModelCaches: boot.providerModelCaches,
    reloadFullConfig: boot.reloadFullConfig,
    refreshStatuslineUsageSnapshot: boot.refreshStatuslineUsageSnapshot,
    warmProviderModelCache: boot.warmProviderModelCache,
    cachedProviderSetup: boot.cachedProviderSetup,
    providerWarmupDelayMs: tunables.providerWarmupDelayMs,
    providerSetupWarmupDelayMs: tunables.providerSetupWarmupDelayMs,
    providerModelWarmupDelayMs: tunables.providerModelWarmupDelayMs,
    modelCatalogWarmupDelayMs: tunables.modelCatalogWarmupDelayMs,
    statuslineUsageWarmupDelayMs: tunables.statuslineUsageWarmupDelayMs,
    statuslineUsageRefreshDelayMs: tunables.statuslineUsageRefreshDelayMs,
    backgroundBusyRetryMs: tunables.backgroundBusyRetryMs,
    providerWarmupEnabled: tunables.providerWarmupEnabled,
    modelPrefetchEnabled: tunables.modelPrefetchEnabled,
    modelCatalogWarmupEnabled: tunables.modelCatalogWarmupEnabled,
    prewarmTimers: boot.prewarmTimers,
    getCodeGraphModule: boot.getCodeGraphModule,
    channels: boot.channels,
    codeGraphPrewarmDelayMs: tunables.codeGraphPrewarmDelayMs,
    channelStartDelayMs: tunables.channelStartDelayMs,
    codeGraphPrewarmEnabled: tunables.codeGraphPrewarmEnabled,
    prewarmState: boot.prewarmState,
    agentTool: boot.routedAgentTool,
  });
  const {
    scheduleProviderWarmup,
    scheduleProviderSetupWarmup,
    scheduleProviderModelWarmup,
    scheduleModelCatalogWarmup,
    scheduleStatuslineUsageWarmup,
    scheduleStatuslineUsageRefresh,
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    scheduleAutomationAutostart,
    scheduleChannelStart,
    refreshRouteEffort,
    createCurrentSession,
    remoteTranscript,
  } = lifecycle;
  Object.assign(boot, {
    scheduleProviderWarmup,
    scheduleProviderSetupWarmup,
    scheduleProviderModelWarmup,
    scheduleModelCatalogWarmup,
    scheduleStatuslineUsageWarmup,
    scheduleStatuslineUsageRefresh,
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    scheduleAutomationAutostart,
    scheduleChannelStart,
    refreshRouteEffort,
    createCurrentSession,
    remoteTranscript,
    ensureSessionTranscriptWriter: () => remoteTranscript.ensureSessionTranscriptWriter(),
  });
  bootProfile('session-runtime:ready', {
    lazySession: true,
    providerWarmup: tunables.providerWarmupEnabled,
    codeGraphPrewarm: tunables.codeGraphPrewarmEnabled,
  });
  // Heavy work remains demand-driven. Native helpers overlap provider.send;
  // memory and code-graph parsing stay cold until their feature is used.
  bootProfile('runtime:prewarm-deferred', { reason: 'first-turn' });
  scheduleProviderWarmup();
  scheduleProviderModelWarmup();
  scheduleProviderSetupWarmup();
  scheduleModelCatalogWarmup();
  scheduleStatuslineUsageWarmup();
  scheduleAutomationAutostart(tunables.remoteAutoStartDelayMs);
}
