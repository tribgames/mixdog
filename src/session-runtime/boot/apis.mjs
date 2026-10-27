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
  discardLocalInstallation,
  configureLocalProviderIdleTtl,
} from '../../runtime/local-provider/managed-runtime.mjs';
import { deferComputerSessionRelease, endComputerExecution } from '../../runtime/computer-bridge/client.mjs';
import { developerOption, developerOptionEnabled } from '../../runtime/shared/developer-options.mjs';
import { hasOwn } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import {
  normalizeSystemShellConfig,
  normalizeSystemShellCommand,
  normalizeAutoClearConfig,
  autoClearIdleMsForProvider,
  resolveAutoClearIdleMs,
  autoClearProviderDefaults,
  normalizeCompactionConfig,
  setModuleEnabledInConfig,
  setRecapEnabledInConfig,
  setMemoryToolsEnabledInConfig,
  formatDurationMs,
  parseDurationMs,
} from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { applyDeferredToolSurface } from '../../runtime/agent/orchestrator/runtime-core/tool-catalog.mjs';
import { ONBOARDING_VERSION } from '../quick-web-search-models.mjs';
import { createSettingsApi } from '../settings-api.mjs';
import { createSessionTitleController } from '../../runtime/agent/orchestrator/runtime-core/session-title.mjs';
import { closeNativeToolTransports, closePatchRuntimeIfLoaded, withTeardownDeadline } from '../native-teardown.mjs';
import { createChannelConfigApi } from '../channel-config-api.mjs';
import { createMediaApi } from '../media-api.mjs';
import { createProviderAuthApi } from '../provider-auth-api.mjs';
import { createUsageStatsApi } from '../usage-stats-api.mjs';
import { listProviderAccounts } from '../services/provider-admin.mjs';
import { createLifecycleApi } from '../lifecycle-api.mjs';
import {
  assertAdmissionOpen,
  assertNotAddressed,
  assertResumeTarget,
  beginCanonicalClose,
  finishCanonicalClose,
  isAdmissionOpen,
  markTerminal,
} from '../session-address.mjs';
import { createResourceApi } from '../resource-api.mjs';
import { createModelRouteApi } from '../model-route-api.mjs';
import { createWorkflowAgentsApi } from '../workflow-agents-api.mjs';
import { createToolPolicyRefresh } from '../tool-policy-refresh.mjs';
import { subscribeAgentProfileChanges } from '../agent-profile-changes.mjs';
import { loadInstructionFilesContext } from '../../runtime/agent/orchestrator/context/instruction-files.mjs';
import { createSessionTurnApi } from '../session-turn-api.mjs';
import { createGoalFacadeApi } from '../goal-facade-api.mjs';
import { createRuntimeReviewApi } from '../runtime-review-api.mjs';
import { createWorkspaceTransitions, refreshWorkspacePrompt } from '../workspace/transitions.mjs';
import { saveSession, saveSessionAsync } from '../../runtime/agent/orchestrator/session/store.mjs';
import { modelToolSchemaAllowlist } from '../../runtime/agent/orchestrator/runtime-core/tool-profile.mjs';
import { sessionOptions } from '../session-create/session-options.mjs';
import { createConversationImportApi } from '../conversation-import/service.mjs';
import { importError } from '../conversation-import/discovery.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { standaloneDataDir } from '../runtime-paths.mjs';
import { registerBotRouteStore } from '../../runtime/shared/agent-store.mjs';
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
  boot.usageStatsApi = createUsageStatsApi({
    getSessionId: () => boot.rt.session?.id || null,
    accountEmails: (provider) =>
      Object.fromEntries(listProviderAccounts(provider).accounts.map((row) => [row.id, row.email || ''])),
  });
  boot.providerAuthApi = providerAuthApiFor(boot);
  boot.mediaApi = createMediaApi();
  boot.conversationImportApi = conversationImportApiFor(boot);
  boot.sessionTitles = createSessionTitleController({
    dataRoot: () => dataDirOf(boot.cfgMod),
    promoteGeneratedTitle: (sessionId, title, stage) => boot.mgr.updateSessionGeneratedTitle(sessionId, title, stage),
  });
  boot.lifecycleApi = lifecycleApiFor(boot);
  boot.resourceApi = resourceApiFor(boot);
  // Plugin MCP servers are derived live; copies an earlier enable action wrote
  // into mcpServers are adopted once (an injected headless config is left as is).
  if (!boot.params.initialConfig || typeof boot.params.initialConfig !== 'object') {
    try {
      boot.resourceApi.migratePluginMcpCopies();
    } catch (error) {
      console.warn(`[mcp] adopting plugin MCP copies failed: ${error?.message || error}`);
      bootProfile('plugin-mcp:adopt-failed', { error: error?.message || String(error) });
    }
    // One server per multi-account connector: `gmail`, `gmail-2`… merge into
    // `gmail` holding the accounts (their sign-ins and app passwords stay).
    try {
      boot.resourceApi.migrateConnectorAccounts();
    } catch (error) {
      console.warn(`[connectors] merging connector accounts failed: ${error?.message || error}`);
      bootProfile('connector-accounts:merge-failed', { error: error?.message || String(error) });
    }
  }
  boot.disposeGlobalExtensionSubscription = () => {
    boot.disposeConfigSync?.();
    boot.disposeAgentProfileChanges();
    boot.resourceApi.disposeGlobalExtensionSubscription?.();
  };
  boot.modelRouteApi = modelRouteApiFor(boot);
  boot.workflowAgentsApi = workflowAgentsApiFor(boot);
  // Connector allow lists (agent lists, MCP project scopes) become the
  // equivalent "switched off" lists once; a later connector is on everywhere.
  if (!boot.params.initialConfig || typeof boot.params.initialConfig !== 'object') {
    try {
      boot.workflowAgentsApi.migrateConnectorPolicies();
    } catch (error) {
      bootProfile('connector-policy:migrate-failed', { error: error?.message || String(error) });
    }
    // Agents made before the kind marker get `kind: agent` once, so an update
    // never turns a workflow agent into a bot (agent-kind-migration.mjs).
    try {
      boot.workflowAgentsApi.migrateAgentKindMarkers();
    } catch (error) {
      bootProfile('agent-kind:migrate-failed', { error: error?.message || String(error) });
    }
    // Bots get their own store (bots/) once, before any catalog read; a
    // failed split leaves agents/ read as before (bot-split-migration.mjs).
    try {
      boot.workflowAgentsApi.migrateBotStore();
    } catch (error) {
      bootProfile('bot-split:migrate-failed', { error: error?.message || String(error) });
    }
  }
  // Route reads ask a store bot's own folder first (agent-store.mjs).
  registerBotRouteStore(() => dataDirOf(boot.cfgMod));
  boot.workspaceApi = workspaceApiFor(boot);
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
  const {
    refreshEmptySessionToolPolicy,
    switchSessionWorkflow,
    switchSessionOrchestrationMode,
    applyPendingSessionSwitches,
    refreshAgentProfile,
    applyPendingAgentProfile,
    currentAgents,
  } = createToolPolicyRefresh({
    getSession: () => rt.session,
    getRoute: () => rt.route,
    getMode: () => rt.mode,
    getConfig: () => rt.config,
    getDataDir: () => dataDirOf(cfgMod),
    getActiveTurnCount: () => rt.activeTurnCount || 0,
    modelStandaloneTools: boot.modelStandaloneTools,
    featureDisallowedTools: boot.featureDisallowedTools,
    loadCoreMemoryContext: boot.loadCoreMemoryContext,
    loadInstructionFilesContext: (session) =>
      session.skipInstructionFiles
        ? ''
        : loadInstructionFilesContext({ mode: rt.config?.instructionFiles, cwd: session.cwd }),
    activeWorkflowContext: workflowHelpers.activeWorkflowContext,
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
    // A switch is acknowledged only once saved; a session closed or replaced
    // since (its generation moved) is not resurrected.
    persistSession: (session) => saveSessionAsync(session, { expectedGeneration: session.generation }),
  });
  boot.refreshEmptySessionToolPolicy = refreshEmptySessionToolPolicy;
  boot.switchSessionWorkflow = switchSessionWorkflow;
  boot.switchSessionOrchestrationMode = switchSessionOrchestrationMode;
  boot.applyPendingSessionSwitches = applyPendingSessionSwitches;
  boot.refreshAgentProfile = refreshAgentProfile;
  boot.applyPendingAgentProfile = applyPendingAgentProfile;
  boot.currentAgents = currentAgents;
  // A saved bot reaches this runtime's thread when its prompt embeds it (it
  // runs as that bot, or lists it); the rebuilt prompt is saved with the session.
  const profileChanges = subscribeAgentProfileChanges(async () => {
    if (!(await refreshAgentProfile())) return;
    saveSession(rt.session);
    boot.invalidateContextStatusCache();
  });
  boot.disposeAgentProfileChanges = profileChanges.unsubscribe;
}

// Built-in install adapters. Memory downloads and loads the embedding model at
// install time instead of the first recall, and a failed download fails the
// install; office provisions global Noto fonts; tidy downloads its core managed
// engines; the local provider downloads its runtime.
function builtinFeatureAdapters(boot) {
  const { cfgMod, getMemoryModule } = boot;
  return {
    prepareBuiltinFeature: async (name, options) => {
      if (name === 'memory') {
        const memory = await getMemoryModule();
        await memory.warmupEmbedding();
      } else if (name === 'office') {
        const { prepareOfficeFonts } = await import('../../runtime/office/portable/font-provisioner.mjs');
        await prepareOfficeFonts?.().catch?.(() => {});
      } else if (name === 'tidy') {
        const { installTidyCoreEngines } = await import('../../runtime/tidy/core-install.mjs');
        // Per-engine failures land in the install job, not in an exception:
        // the feature still installs and the card reports what did not.
        await installTidyCoreEngines({ pluginData: dataDirOf(cfgMod), engines: options?.engines });
      } else if (name === 'localProvider') {
        await installLocalProviderRuntime();
      } else if (name === 'autoEffort') {
        // Downloads the judge model (verified per file) unless it is current.
        const { installEffortJudge } = await import('../../runtime/effort-judge/judge-client.mjs');
        await installEffortJudge();
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
    discardLocalProviderInstallation: (phase, modelId) => discardLocalInstallation(phase, modelId),
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

function developerAdapters(boot) {
  const { reg, invalidateProviderCaches, ensureProvidersReady } = boot;
  return {
    // After setDeveloperOption: flush the pending save and reload so gates that
    // read the stored value (developerOptionEnabled) see it now, then apply
    // live effects. A provider option's provider appears/disappears in the
    // registry at once.
    syncDeveloperOption: async (id) => {
      const config = boot.reloadFullConfig();
      const provider = developerOption(id)?.provider;
      if (!provider) return;
      invalidateProviderCaches();
      if (!developerOptionEnabled(id)) {
        reg.disableProvider?.(provider);
        return;
      }
      // Provider init can take long (OAuth/network); the option is already saved
      // and adopted, so the toggle must not wait on it.
      void ensureProvidersReady(config?.providers || {}).catch((error) => {
        console.warn(`[providers] ${provider} init after enabling failed: ${error?.message || error}`);
      });
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
    resolveAutoClearIdleMs,
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
    ...developerAdapters(boot),
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

// Conversation import: imported sessions are built with the Lead options a new
// session of this runtime would get (current route, tools, workflow, memory),
// minus its reservation, profile ownership and desktop placement.
function conversationImportApiFor(boot) {
  const { rt, mgr } = boot;
  return createConversationImportApi({
    // The async catalog (the daemon's SQLite catalog worker, else JSON),
    // loaded on first use so boot does not pull in the cold reader.
    listSessionSummaries: async () => {
      const reader = await import('../../runtime/agent/orchestrator/session/store-summary-reader.mjs');
      return reader.listStoredSessionSummariesAsync();
    },
    createSession: (options) => mgr.createSession(options),
    prepareLeadOptions: async () => {
      await boot.awaitKeychainPrewarm();
      const route = rt.route?.provider && rt.route?.model ? rt.route : resolveRoute(rt.config, {});
      if (!route?.provider || !route?.model) throw importError('noModelRoute');
      await boot.ensureProvidersReady(rt.config.providers || {});
      const coreMemoryContext = await boot.loadCoreMemoryContext();
      const leadView = Object.assign(Object.create(rt), {
        route,
        reservedSessionId: null,
        sessionProfile: null,
        desktopSession: null,
      });
      return sessionOptions(
        {
          rt: leadView,
          cfgMod: boot.cfgMod,
          activeWorkflowContext: workflowHelpers.activeWorkflowContext,
          schemaAllowedTools: modelToolSchemaAllowlist(rt.toolProfile),
          featureDisallowedTools: boot.featureDisallowedTools,
        },
        coreMemoryContext
      );
    },
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
    // A deleted custom provider must not stay reachable through the live route
    // or the registry; stored routes naming it are filtered by the picker.
    onCustomProviderRemoved: (id) => {
      reg.disableProvider?.(id);
      if (rt.route?.provider === id) rt.route = { ...rt.route, provider: '', model: '', preset: null };
    },
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
    getAddressedSessionId: () => rt.addressedSessionId,
    assertNotAddressed: (operation) => assertNotAddressed(rt, operation),
    assertResumeTarget: (id) => assertResumeTarget(rt, id),
    markAddressTerminal: () => markTerminal(rt),
    beginCanonicalClose: (id) => beginCanonicalClose(rt, id),
    finishCanonicalClose: (previous, closed) => finishCanonicalClose(rt, previous, closed),
    isCanonicallyClosed: () => rt.admission === 'terminal',
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
    refreshAgentProfile: boot.refreshAgentProfile,
    // Created after the lifecycle API, so resolved at call time.
    cleanupDeletedSessionWorktree: (sessionId) => boot.workspaceApi?.cleanupDeletedSession?.(sessionId),
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
    STANDALONE_DATA_DIR: standaloneDataDir(),
    saveConfigAndAdopt: boot.saveConfigAndAdopt,
    connectConfiguredMcp: boot.connectConfiguredMcp,
    cancelMcpLogin: boot.cancelMcpLogin,
    completeMcpLogin: boot.completeMcpLogin,
    clearMcpServerOAuth: (cfg, options) => boot.mcpClient.clearMcpServerOAuth(cfg, options),
    startMcpServerOAuthSwitch: (cfg, launch, name) => boot.mcpClient.startMcpServerOAuthSwitch(cfg, launch, name),
    commitMcpServerOAuthSwitch: (cfg, signIn) => boot.mcpClient.commitMcpServerOAuthSwitch(cfg, signIn),
    getMcpServerOAuthState: (cfg) => boot.mcpClient.getMcpServerOAuthState(cfg),
    probeMcpServerAuth: (cfg) => boot.mcpClient.probeMcpServerAuth(cfg),
    invalidatePreSessionToolSurface: boot.invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy: boot.refreshEmptySessionToolPolicy,
    normalizeMcpServerInput: boot.normalizeMcpServerInput,
    mcpStatus: boot.mcpStatus,
    getMcpServerConfig: boot.getMcpServerConfig,
    resolveMcpCatalog: boot.resolveMcpCatalog,
    resolveConfiguredMcpCatalog: boot.resolveConfiguredMcpCatalog,
    pluginMcpServer: boot.pluginMcpServer,
    skillsStatus: boot.skillsStatus,
    skillContent: boot.skillContent,
    addGlobalSkill: boot.addGlobalSkill,
    saveSkillDocument: boot.saveSkillDocument,
    removeGlobalSkill: boot.removeGlobalSkill,
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
    getSessionGeneration: () => rt.sessionGeneration,
    setSession: boot.adoptSession,
    getAddressedSessionId: () => rt.addressedSessionId,
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
    reloadFullConfig: boot.reloadFullConfig,
    confirmLeadFill: boot.confirmLeadFill,
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
    STANDALONE_DATA_DIR: standaloneDataDir(),
    resolveRoute,
    lookupModelMeta: boot.lookupModelMeta,
    adoptConfig: boot.adoptConfig,
    saveConfigAndAdopt: boot.saveConfigAndAdopt,
    reloadFullConfig: boot.reloadFullConfig,
    ensureProvidersReady: boot.ensureProvidersReady,
    displayConfig: boot.displayConfig,
    mcpStatus: () => boot.mcpStatus(),
    resolveConfiguredMcpCatalog: () => boot.resolveConfiguredMcpCatalog(),
    getMcpTools: () => boot.mcpClient.getMcpTools(rt.mcpScopeId),
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
    switchSessionWorkflow: boot.switchSessionWorkflow,
    switchSessionOrchestrationMode: boot.switchSessionOrchestrationMode,
  });
}

// The Lead workspace transition authority (worktree / project branch / remove)
// and the turn-start workspace gate. Facade-facing methods are spread by
// buildFacade; prepareTurnWorkspace feeds the turn runner.
function workspaceApiFor(boot) {
  const { rt } = boot;
  return createWorkspaceTransitions({
    getSession: () => rt.session,
    getReservedSessionId: () => rt.reservedSessionId,
    getCurrentCwd: () => rt.currentCwd,
    getDesktopSession: () => rt.desktopSession,
    setDesktopSession: (next) => {
      rt.desktopSession = next;
    },
    getConfig: () => rt.config,
    createCurrentSession: (reason) => boot.createCurrentSession(reason),
    applyResolvedCwd: (cwd, options) => boot.applyResolvedCwd(cwd, options),
    // Durable save: on disk when it returns, throws when the write fails
    // (immediate mode only queues it). Synchronous, so a transition never
    // waits on the save worker, which may never come up.
    persistSession: (session) => saveSession(session, { sync: true }),
    refreshWorkspaceContext: (session, cwd, move) =>
      refreshWorkspacePrompt(session, cwd, { loadCoreMemoryContext: boot.loadCoreMemoryContext, move }),
    invalidateCaches: () => {
      boot.invalidateContextStatusCache();
      boot.invalidatePreSessionToolSurface();
    },
    getActiveTurnCount: () => rt.activeTurnCount || 0,
    agentStatusState: boot.agentStatusState,
    updateLeadWorkerCwd: (sessionId, cwd) => boot.agentTool?.updateLeadWorkerCwd?.(sessionId, cwd),
    sessionManager: boot.mgr,
    initialIntent: boot.params.worktree,
  });
}

function sessionTurnApiFor(boot) {
  const { rt, tunables, remoteTranscript, routePreparation } = boot;
  return createSessionTurnApi({
    applyPendingRoute: () => boot.modelRouteApi.applyPendingRoute(),
    applyPendingAgentProfile: boot.applyPendingAgentProfile,
    currentAgents: boot.currentAgents,
    applyPendingSessionSwitches: boot.applyPendingSessionSwitches,
    prepareTurnWorkspace: boot.workspaceApi.prepareTurnWorkspace,
    admitTurnWorkspace: boot.workspaceApi.admitTurnWorkspace,
    getSession: () => rt.session,
    setSession: boot.adoptSession,
    getCurrentCwd: () => rt.currentCwd,
    getConfig: () => rt.config,
    getMode: () => rt.mode,
    setMode: (v) => {
      rt.mode = v;
    },
    getActiveTurnCount: () => rt.activeTurnCount,
    takePendingCompact: (sessionId) => rt.pendingCompactSessionIds?.delete(sessionId) === true,
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
    switchProject: boot.workspaceApi.switchProject,
    resolveCwdPath: boot.resolveCwdPath,
    agentStatusState: boot.agentStatusState,
    notificationListeners: boot.notificationListeners,
    awaitInitialMcpConnect: boot.awaitInitialMcpConnect,
    mcpTurnGraceMs: tunables.mcpTurnGraceMs,
    mcpAgentGraceMs: tunables.mcpAgentGraceMs,
    awaitRoutePreparation: () => routePreparation.wait(),
    getReservedSessionId: () => rt.reservedSessionId,
    goalSnapshotFor: (sessionId) => boot.goalRuntime?.snapshot?.(sessionId),
    assertSessionAdmission: () => assertAdmissionOpen(rt),
    isSessionAdmissionOpen: () => isAdmissionOpen(rt),
    registerActiveTurnController: boot.registerActiveTurnController,
    sessionTitles: boot.sessionTitles,
    endComputerExecution,
    deferComputerSessionRelease,
  });
}
