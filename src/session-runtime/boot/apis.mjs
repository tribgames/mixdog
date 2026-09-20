// Boot stage 8: the API slices the facade spreads together — settings,
// channel config, provider auth, usage stats, media, lifecycle, resources,
// model route, workflow/agents, the session turn api, review and goal.
import { localPackageVersion } from '../../runtime/shared/update-checker.mjs';
import { setConfiguredShell } from '../../runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
import {
  LOCAL_PROVIDER_ID,
  installLocalProviderModel,
  installLocalProviderRuntime,
  localProviderStatus,
  stopLocalProviderServer,
  cancelLocalInstallation,
  configureLocalProviderIdleTtl,
} from '../../runtime/local-provider/managed-runtime.mjs';
import { deferComputerSessionRelease, endComputerExecution } from '../../runtime/computer-bridge/client.mjs';
import { hasOwn } from '../session-text.mjs';
import {
  normalizeSystemShellConfig,
  normalizeSystemShellCommand,
  normalizeAutoClearConfig,
  autoClearIdleMsForProvider,
  autoClearProviderDefaults,
  normalizeCompactionConfig,
  setModuleEnabledInConfig,
  setRecapEnabledInConfig,
  setMemoryToolsEnabledInConfig,
  formatDurationMs,
  parseDurationMs,
} from '../config-helpers.mjs';
import { applyDeferredToolSurface } from '../tool-catalog.mjs';
import { ONBOARDING_VERSION } from '../quick-web-search-models.mjs';
import { createSettingsApi } from '../settings-api.mjs';
import { createSessionTitleController } from '../session-title.mjs';
import { closeNativeToolTransports, closePatchRuntimeIfLoaded, withTeardownDeadline } from '../native-teardown.mjs';
import { createChannelConfigApi } from '../channel-config-api.mjs';
import { createMediaApi } from '../media-api.mjs';
import { createProviderAuthApi } from '../provider-auth-api.mjs';
import { createUsageStatsApi } from '../usage-stats-api.mjs';
import { createLifecycleApi } from '../lifecycle-api.mjs';
import { createResourceApi } from '../resource-api.mjs';
import { createModelRouteApi } from '../model-route-api.mjs';
import { createWorkflowAgentsApi } from '../workflow-agents-api.mjs';
import { createToolPolicyRefresh } from '../tool-policy-refresh.mjs';
import { createSessionTurnApi } from '../session-turn-api.mjs';
import { createGoalFacadeApi } from '../goal-facade-api.mjs';
import { createRuntimeReviewApi } from '../runtime-review-api.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { STANDALONE_DATA_DIR } from '../runtime-paths.mjs';
import {
  dataDirOf,
  resolveRoute,
  summarizeWorkflowRoutes,
  agentRouteFromConfig,
  webSearchCapableFor,
  workflowHelpers,
} from './shared.mjs';

export function wireApis(boot) {
  wireToolPolicyRefresh(boot);
  boot.settingsApi = settingsApiFor(boot);
  boot.channelConfigApi = createChannelConfigApi({
    channels: boot.channels,
    reloadChannelsSoon: boot.reloadChannelsSoon,
    // Automation saved mid-session boots the worker (claim-if-vacant) even
    // though the boot-time autostart window has already passed.
    ensureAutomationRuntime: () => boot.scheduleChannelStart(0),
  });
  boot.usageStatsApi = createUsageStatsApi();
  boot.providerAuthApi = providerAuthApiFor(boot);
  boot.mediaApi = createMediaApi();
  boot.sessionTitles = createSessionTitleController({
    dataRoot: () => dataDirOf(boot.cfgMod),
    promoteGeneratedTitle: (sessionId, title, stage) => boot.mgr.updateSessionGeneratedTitle(sessionId, title, stage),
  });
  boot.disposeGlobalExtensionSubscription = () => {};
  boot.lifecycleApi = lifecycleApiFor(boot);
  boot.resourceApi = resourceApiFor(boot);
  boot.disposeGlobalExtensionSubscription = () => boot.resourceApi.disposeGlobalExtensionSubscription?.();
  boot.modelRouteApi = modelRouteApiFor(boot);
  boot.workflowAgentsApi = workflowAgentsApiFor(boot);
  boot.sessionTurnApi = sessionTurnApiFor(boot);
  const getFacadeSessionId = () => boot.rt.session?.id || boot.rt.reservedSessionId || null;
  boot.runtimeReviewApi = createRuntimeReviewApi({
    getCwd: () => boot.rt.currentCwd,
    getSessionId: getFacadeSessionId,
  });
  boot.goalFacadeApi = createGoalFacadeApi({
    agentStatusState: boot.agentStatusState,
    createCurrentSession: boot.createCurrentSession,
    getSession: () => boot.rt.session,
    getSessionId: getFacadeSessionId,
    goalRuntime: boot.goalRuntime,
  });
}

function wireToolPolicyRefresh(boot) {
  const { rt, cfgMod } = boot;
  const { refreshEmptySessionToolPolicy } = createToolPolicyRefresh({
    getSession: () => rt.session,
    getRoute: () => rt.route,
    getMode: () => rt.mode,
    getConfig: () => rt.config,
    getDataDir: () => dataDirOf(cfgMod),
    modelStandaloneTools: boot.modelStandaloneTools,
    featureDisallowedTools: boot.featureDisallowedTools,
    memoryToolsEnabled: boot.memoryToolsEnabledFn,
    loadCoreMemoryContext: boot.loadCoreMemoryContext,
    activeWorkflowContext: workflowHelpers.activeWorkflowContext,
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
  });
  boot.refreshEmptySessionToolPolicy = refreshEmptySessionToolPolicy;
}

// Built-in install adapters. Memory warms the embedding runtime so the model
// download happens at install time instead of the first recall; git
// verification is an instant probe; office provisions global Noto fonts and
// verifies the bundled engine; tidy downloads its core managed engines.
function builtinFeatureAdapters(boot) {
  const { cfgMod, getMemoryModule } = boot;
  return {
    prepareBuiltinFeature: async (name) => {
      if (name === 'memory') {
        const memory = await getMemoryModule().catch(() => null);
        await memory?.warmup?.().catch?.(() => {});
      } else if (name === 'office') {
        const { prepareOfficeFonts } = await import('../../runtime/office/portable/font-provisioner.mjs');
        await prepareOfficeFonts?.().catch?.(() => {});
      } else if (name === 'tidy') {
        const { installTidyCoreEngines } = await import('../../runtime/tidy/core-install.mjs');
        // Per-engine failures land in the install job, not in an exception:
        // the feature still installs and the card reports what did not.
        await installTidyCoreEngines({ pluginData: dataDirOf(cfgMod) });
      } else if (name === 'localProvider') {
        await installLocalProviderRuntime();
      }
    },
    tidyEngineStatus: async () => {
      const { tidyEngineStatus } = await import('../../runtime/tidy/core-install.mjs');
      return tidyEngineStatus({ pluginData: dataDirOf(cfgMod) });
    },
    tidyInstallStatus: async () => {
      const { tidyInstallStatus } = await import('../../runtime/tidy/core-install.mjs');
      return tidyInstallStatus();
    },
  };
}

function localProviderAdapters(boot) {
  const { rt, reg, invalidateProviderCaches, ensureProvidersReady } = boot;
  return {
    prepareLocalProviderModel: (modelId) => installLocalProviderModel(modelId),
    getLocalProviderStatus: () => localProviderStatus(),
    stopLocalProviderServer,
    cancelLocalProviderInstallation: (jobId) => cancelLocalInstallation(jobId),
    configureLocalProviderIdleTtl,
    syncLocalProviderRegistry: async (enabled) => {
      invalidateProviderCaches();
      if (enabled === false) {
        reg.disableProvider?.(LOCAL_PROVIDER_ID);
        return;
      }
      await ensureProvidersReady(rt.config.providers || {});
    },
    refreshLocalProviderCatalog: async () => {
      invalidateProviderCaches();
      await ensureProvidersReady(rt.config.providers || {});
      await reg.refreshCatalogs?.({ force: true });
      invalidateProviderCaches({ preserveProviderInit: true });
    },
  };
}

// Pure settings-delegate methods (onboarding status/skip, autoClear, profile,
// compaction, recap/memory, channels, systemShell, update settings), spread
// into the facade so the external surface is unchanged.
function settingsApiFor(boot) {
  const { rt, cfgMod, selfUpdate, prewarmTimers } = boot;
  return createSettingsApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    getSession: () => rt.session,
    adoptConfig: boot.adoptConfig,
    saveConfigAndAdopt: boot.saveConfigAndAdopt,
    scheduleSkillsSave: boot.scheduleSkillsSave,
    cfgMod,
    hasOwn,
    normalizeAutoClearConfig,
    autoClearIdleMsForProvider,
    autoClearProviderDefaults,
    normalizeCompactionConfig,
    normalizeSystemShellConfig,
    normalizeSystemShellCommand,
    setConfiguredShell,
    setRecapEnabledInConfig,
    setMemoryToolsEnabledInConfig,
    setModuleEnabledInConfig,
    ...builtinFeatureAdapters(boot),
    ...localProviderAdapters(boot),
    summarizeWorkflowRoutes,
    parseDurationMs,
    formatDurationMs,
    localPackageVersion,
    recapEnabledFn: boot.recapEnabledFn,
    memoryToolsEnabledFn: boot.memoryToolsEnabledFn,
    gitToolsEnabledFn: boot.gitToolsEnabledFn,
    officeToolsEnabledFn: boot.officeToolsEnabledFn,
    tidyToolEnabledFn: boot.tidyToolEnabledFn,
    localProviderEnabledFn: boot.localProviderEnabledFn,
    webSearchEnabled: boot.webSearchEnabled,
    channelsEnabled: boot.channelsEnabled,
    autoUpdateEnabled: selfUpdate.autoUpdateEnabled,
    getUpdateCheckState: () => selfUpdate.getCheckState(),
    getUpdateProcessState: () => selfUpdate.getProcessState(),
    invalidateContextStatusCache: (...a) => boot.invalidateContextStatusCache(...a),
    invalidatePreSessionToolSurface: (...a) => boot.invalidatePreSessionToolSurface(...a),
    refreshEmptySessionToolPolicy: boot.refreshEmptySessionToolPolicy,
    scheduleChannelStart: (...a) => boot.scheduleChannelStart(...a),
    channels: boot.channels,
    clearChannelStartTimer: () => {
      if (prewarmTimers.channelStartTimer) {
        clearTimeout(prewarmTimers.channelStartTimer);
        prewarmTimers.channelStartTimer = null;
      }
    },
    checkForUpdateInternal: selfUpdate.checkForUpdate,
    runUpdateNowInternal: selfUpdate.runUpdateNow,
    reloadChannelsSoon: (...a) => boot.reloadChannelsSoon(...a),
    ONBOARDING_VERSION,
  });
}

function providerAuthApiFor(boot) {
  const { rt, cfgMod, reg, ensureProvidersReady } = boot;
  return createProviderAuthApi({
    cfgMod,
    getConfig: () => rt.config,
    saveConfigAndAdopt: boot.saveConfigAndAdopt,
    displayConfig: boot.displayConfig,
    reloadFullConfig: boot.reloadFullConfig,
    awaitKeychainPrewarm: boot.awaitKeychainPrewarm,
    isKeychainPrewarmReady: () => rt.keychainPrewarmWaitDone,
    hasProviderSetupCached: boot.hasProviderSetupCached,
    invalidateProviderCaches: boot.invalidateProviderCaches,
    warmProviderModelCache: boot.warmProviderModelCache,
    refreshProviderCatalogs: (options = {}) =>
      ensureProvidersReady(rt.config.providers || {}).then(() => reg.refreshCatalogs(options)),
    cachedProviderSetup: boot.cachedProviderSetup,
    getUsageDashboard: boot.getUsageDashboard,
    consumeCodexRateLimitResetCredit: boot.consumeCodexRateLimitResetCredit,
    collectProviderModels: boot.collectProviderModels,
  });
}

function lifecycleApiFor(boot) {
  const { rt, selfUpdate, setupTool, sessionTitles, routePreparation } = boot;
  return createLifecycleApi({
    getSession: () => rt.session,
    setSession: boot.adoptSession,
    getRoute: () => rt.route,
    setRoute: (v) => {
      rt.route = v;
    },
    getConfig: () => rt.config,
    getMode: () => rt.mode,
    getCurrentCwd: () => rt.currentCwd,
    // Resume must bind the session to THIS runtime's MCP registry scope;
    // without it the resumed session falls back to the empty 'global' scope
    // and every connected MCP tool is announced as removed (and never comes
    // back).
    getMcpScopeId: () => rt.mcpScopeId,
    getDesktopSession: () => rt.desktopSession,
    setDesktopSession: (v) => {
      rt.desktopSession = v;
    },
    setCloseRequested: (v) => {
      rt.closeRequested = v;
    },
    getMemoryModPromise: () => rt.memoryModPromise,
    setMemoryModPromise: (v) => {
      rt.memoryModPromise = v;
    },
    getReservedSessionId: () => rt.reservedSessionId,
    abortActiveTurns: boot.abortActiveTurns,
    hooks: boot.hooks,
    hookCommonPayload: boot.hookCommonPayload,
    mgr: boot.mgr,
    statusRoutes: boot.statusRoutes,
    channels: boot.channels,
    agentTool: boot.routedAgentTool,
    mcpClient: boot.mcpClient,
    warmupTimers: boot.warmupTimers,
    prewarmTimers: boot.prewarmTimers,
    flushAllConfigSavesAsync: boot.flushAllConfigSavesAsync,
    withTeardownDeadline,
    closePatchRuntimeIfLoaded,
    closeNativeToolTransports,
    stopSelfUpdateBootCheck: () => selfUpdate.stopBootCheck(),
    createCurrentSession: boot.createCurrentSession,
    refreshRouteEffort: boot.refreshRouteEffort,
    computeContextStatus: boot.computeContextStatus,
    invalidateContextStatusCache: boot.invalidateContextStatusCache,
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
    applyResolvedCwd: boot.applyResolvedCwd,
    resolveRoute,
    applyDeferredToolSurface,
    beginRoutePreparation: (task) => routePreparation.start(task),
    clearRoutePreparation: () => routePreparation.clear(),
    // Live getter: cwd-refresh session rebuilds must re-evaluate the
    // workflow's agent-tool gate, not reuse the boot-time array.
    getStandaloneTools: boot.modelStandaloneTools,
    clearRuntimeNotifications: boot.clearRuntimeNotifications,
    goalRuntime: boot.goalRuntime,
    disposeSessionTitles: () => sessionTitles.disposeAll(),
    disposeInternalTools: () => {
      setupTool.dispose();
      boot.disposeInternalTools();
    },
    disposeGlobalExtensionSubscription: () => boot.disposeGlobalExtensionSubscription(),
  });
}

function resourceApiFor(boot) {
  const { rt, cfgMod, settingsApi } = boot;
  return createResourceApi({
    getConfig: () => rt.config,
    getSession: () => rt.session,
    getCurrentCwd: () => rt.currentCwd,
    cfgMod,
    hooks: boot.hooks,
    STANDALONE_DATA_DIR,
    saveConfigAndAdopt: boot.saveConfigAndAdopt,
    connectConfiguredMcp: boot.connectConfiguredMcp,
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy: boot.refreshEmptySessionToolPolicy,
    normalizeMcpServerInput: boot.normalizeMcpServerInput,
    mcpStatus: boot.mcpStatus,
    getMcpServerConfig: boot.getMcpServerConfig,
    skillsStatus: boot.skillsStatus,
    skillContent: boot.skillContent,
    addGlobalSkill: boot.addGlobalSkill,
    saveSkillDocument: boot.saveSkillDocument,
    invalidateSkills: boot.invalidateSkills,
    getDisabledSkills: () => settingsApi.getDisabledSkills(),
    setDisabledSkills: (names) => settingsApi.setDisabledSkills(names),
    pluginsStatus: boot.pluginsStatus,
    getMemoryModule: boot.getMemoryModule,
    reloadFullConfig: boot.reloadFullConfig,
    flushSkillsSave: boot.flushSkillsSave,
    awaitKeychainPrewarm: boot.awaitKeychainPrewarm,
  });
}

function modelRouteApiFor(boot) {
  const { rt } = boot;
  return createModelRouteApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    setRouteState: (v) => {
      rt.route = v;
    },
    getSession: () => rt.session,
    setSession: boot.adoptSession,
    getConfigHasSecrets: () => rt.configHasSecrets,
    getWebSearchRouteState: () => rt.webSearchRoute,
    setWebSearchRouteState: (v) => {
      rt.webSearchRoute = v;
    },
    cfgMod: boot.cfgMod,
    reg: boot.reg,
    mgr: boot.mgr,
    statusRoutes: boot.statusRoutes,
    resolveRoute,
    webSearchCapableFor,
    lookupModelMeta: boot.lookupModelMeta,
    adoptConfig: boot.adoptConfig,
    saveConfigAndAdopt: boot.saveConfigAndAdopt,
    ensureFullConfig: boot.ensureFullConfig,
    awaitKeychainPrewarm: boot.awaitKeychainPrewarm,
    ensureProvidersReady: boot.ensureProvidersReady,
    persistLeadRoute: boot.persistLeadRoute,
    refreshRouteEffort: boot.refreshRouteEffort,
    refreshStatuslineUsageSnapshot: boot.refreshStatuslineUsageSnapshot,
    scheduleStatuslineUsageRefresh: boot.scheduleStatuslineUsageRefresh,
    invalidateContextStatusCache: boot.invalidateContextStatusCache,
    invalidateProviderCaches: boot.invalidateProviderCaches,
    createCurrentSession: boot.createCurrentSession,
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
    collectWebSearchProviderModels: boot.collectWebSearchProviderModels,
  });
}

function workflowAgentsApiFor(boot) {
  const { rt } = boot;
  return createWorkflowAgentsApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    setRouteState: (v) => {
      rt.route = v;
    },
    getSession: () => rt.session,
    cfgMod: boot.cfgMod,
    STANDALONE_DATA_DIR,
    resolveRoute,
    lookupModelMeta: boot.lookupModelMeta,
    adoptConfig: boot.adoptConfig,
    saveConfigAndAdopt: boot.saveConfigAndAdopt,
    ensureProvidersReady: boot.ensureProvidersReady,
    displayConfig: boot.displayConfig,
    agentRouteFromConfig,
    loadAgentDefinition: workflowHelpers.loadAgentDefinition,
    listCustomAgentIds: workflowHelpers.listCustomAgentIds,
    activeWorkflowId: workflowHelpers.activeWorkflowId,
    listWorkflowPacks: workflowHelpers.listWorkflowPacks,
    loadWorkflowPack: workflowHelpers.loadWorkflowPack,
    workflowSummary: workflowHelpers.workflowSummary,
    getOutputStyleStatusCached: boot.getOutputStyleStatusCached,
    seedOutputStyleStatusCache: boot.seedOutputStyleStatusCache,
    scheduleOutputStyleSave: boot.scheduleOutputStyleSave,
    invalidateContextStatusCache: boot.invalidateContextStatusCache,
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy: boot.refreshEmptySessionToolPolicy,
  });
}

function sessionTurnApiFor(boot) {
  const { rt, tunables, remoteTranscript, routePreparation } = boot;
  return createSessionTurnApi({
    getSession: () => rt.session,
    setSession: boot.adoptSession,
    getCurrentCwd: () => rt.currentCwd,
    getConfig: () => rt.config,
    getMode: () => rt.mode,
    setMode: (v) => {
      rt.mode = v;
    },
    getActiveTurnCount: () => rt.activeTurnCount,
    setActiveTurnCount: (v) => {
      rt.activeTurnCount = v;
    },
    isFirstTurnCompleted: () => rt.firstTurnCompleted,
    setFirstTurnCompleted: (v) => {
      rt.firstTurnCompleted = v;
    },
    getCodeGraphFirstTurnPrewarmDone: () => rt.codeGraphFirstTurnPrewarmDone,
    setCodeGraphFirstTurnPrewarmDone: (v) => {
      rt.codeGraphFirstTurnPrewarmDone = v;
    },
    codeGraphPrewarmLazy: tunables.codeGraphPrewarmLazy,
    getCloseRequested: () => rt.closeRequested,
    getTranscriptWriter: () => remoteTranscript.transcriptWriter,
    getLastAppendedAssistant: () => rt._lastAppendedAssistant,
    setLastAppendedAssistant: (v) => {
      rt._lastAppendedAssistant = v;
    },
    scheduleCodeGraphPrewarm: boot.scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup: boot.scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup: boot.scheduleSearchRuntimeWarmup,
    createCurrentSession: boot.createCurrentSession,
    ensureSessionTranscriptWriter: boot.ensureSessionTranscriptWriter,
    channels: boot.channels,
    hooks: boot.hooks,
    hookCommonPayload: boot.hookCommonPayload,
    mgr: boot.mgr,
    notifyFnForSession: boot.notifyFnForSession,
    subscribeRuntimeNotification: boot.subscribeRuntimeNotification,
    bootProfile,
    scheduleProviderWarmup: boot.scheduleProviderWarmup,
    scheduleProviderModelWarmup: boot.scheduleProviderModelWarmup,
    invalidateContextStatusCache: boot.invalidateContextStatusCache,
    agentTool: boot.routedAgentTool,
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy: boot.refreshEmptySessionToolPolicy,
    activeToolSurface: boot.activeToolSurface,
    applyResolvedCwd: boot.applyResolvedCwd,
    resolveCwdPath: boot.resolveCwdPath,
    agentStatusState: boot.agentStatusState,
    notificationListeners: boot.notificationListeners,
    awaitInitialMcpConnect: boot.awaitInitialMcpConnect,
    mcpTurnGraceMs: tunables.mcpTurnGraceMs,
    awaitRoutePreparation: () => routePreparation.wait(),
    getReservedSessionId: () => rt.reservedSessionId,
    registerActiveTurnController: boot.registerActiveTurnController,
    sessionTitles: boot.sessionTitles,
    endComputerExecution,
    deferComputerSessionRelease,
  });
}
