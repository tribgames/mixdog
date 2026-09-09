import '../runtime/shared/uv-threadpool-boot.mjs';
import { createSessionLifecycle } from './session-lifecycle.mjs';
import { createSessionTitleController } from './session-title.mjs';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import keychain from '../lib/keychain-cjs.cjs';
import './hitch-profile.mjs';
import { ensureStandaloneEnvironment } from '../standalone/seeds.mjs';
import { createStandaloneAgent } from '../standalone/agent-tool.mjs';
import { createStandaloneChannelWorker } from '../standalone/channel-worker.mjs';
import { createStandaloneHookBus } from '../standalone/hook-bus.mjs';
import {
  updateCurrentCwdOverride,
  writeLastSessionCwd,
} from '../runtime/shared/user-cwd.mjs';
import { localPackageVersion } from '../runtime/shared/update-checker.mjs';
import {
  channelNotificationModelContent,
  channelNotificationSessionId,
} from '../runtime/shared/channel-notification-routing.mjs';
import {
  normalizeAgentPermissionOrNone,
  readMarkdownDocument,
} from '../runtime/shared/markdown-frontmatter.mjs';
import { setConfiguredShell } from '../runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
import { isKnownProvider, providerSetup } from '../standalone/provider-admin.mjs';
import { createUsageDashboard } from '../standalone/usage-dashboard.mjs';
import {
  consumeOpenAICodexResetCredit,
  fetchOAuthUsageSnapshot,
} from '../runtime/agent/orchestrator/providers/oauth-usage.mjs';
import { hasActiveAutomation } from '../standalone/channel-admin.mjs';
import { listRegisteredPlugins, pluginAdminStatus } from '../standalone/plugin-admin.mjs';
import { clean, hasOwn } from './session-text.mjs';
import { normalizeToolMode } from './effort.mjs';
import { LAZY_SECRET_PROVIDERS, makeWebSearchCapableFor } from './model-capabilities.mjs';
import {
  makeResolveDefaultProvider,
  findPreset,
  makeResolveRoute,
  ensureProviderEnabled,
  normalizeSystemShellConfig,
  normalizeSystemShellCommand,
  normalizeAutoClearConfig,
  autoClearIdleMsForProvider,
  autoClearProviderDefaults,
  normalizeCompactionConfig,
  moduleEnabled,
  setModuleEnabledInConfig,
  recapEnabled,
  setRecapEnabledInConfig,
  memoryToolsEnabled,
  setMemoryToolsEnabledInConfig,
  formatDurationMs,
  parseDurationMs,
} from './config-helpers.mjs';
import { builtinFeatureActive, featureDisallowedToolsFor } from './builtin-features.mjs';
import { outputStyleStatus as outputStyleStatusRaw } from './output-styles.mjs';
import {
  countSkillFiles,
  mcpScriptForPlugin,
  pluginManifest,
  pluginMcpServerName,
} from './plugin-mcp.mjs';
import {
  WEB_SEARCH_DEFAULT_PROVIDER,
  WEB_SEARCH_DEFAULT_MODEL,
  workflowPresetId,
  createWorkflowHelpers,
  normalizeWebSearchProviderId,
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  normalizeWebSearchRouteConfig,
  normalizeWorkflowRoute,
  upsertWorkflowPreset,
  createWorkflowRouteHelpers,
} from './workflow.mjs';
import { applyDeferredToolSurface } from './tool-catalog.mjs';
import {
  TOOL_SEARCH_TOOL,
  CWD_TOOL,
  SKILL_TOOL,
  applyStandaloneToolDefaults,
} from './tool-defs.mjs';
import {
  modelToolSchemaAllowlist,
  normalizeToolProfile,
} from './tool-profile.mjs';
import { ONBOARDING_VERSION } from './quick-web-search-models.mjs';
import {
  sortProviderModels as sortProviderModelsRaw,
  providerModelCacheRow as providerModelCacheRowRaw,
} from './model-recency.mjs';
import { createNativeWebSearch } from './native-web-search.mjs';
import { createConfigLifecycle } from './config-lifecycle.mjs';
import { createQuickModelRows } from './quick-model-rows.mjs';
import { createWarmupSchedulers } from './warmup-schedulers.mjs';
import { createPrewarmSchedulers } from './prewarm.mjs';
import { createMcpGlue } from './mcp-glue.mjs';
import { createCwdPlugins } from './cwd-plugins.mjs';
import { createSettingsApi } from './settings-api.mjs';
import { createProviderModels } from './provider-models.mjs';
import { createProviderUsage } from './provider-usage.mjs';
import { envFlag } from '../runtime/shared/env.mjs';
import { bootProfile, profiledImport } from './boot-profile.mjs';
import { createProviderReadiness } from './provider-readiness.mjs';
import { createLazyRuntimeModules } from './runtime-modules.mjs';
import { closeNativeToolTransports, closePatchRuntimeIfLoaded, withTeardownDeadline } from './native-teardown.mjs';
import { createChannelConfigApi } from './channel-config-api.mjs';
import { createMediaApi } from './media-api.mjs';
import { createProviderAuthApi } from './provider-auth-api.mjs';
import { createContextStatus } from './context-status.mjs';
import { createLifecycleApi } from './lifecycle-api.mjs';
import { createResourceApi } from './resource-api.mjs';
import { createModelRouteApi } from './model-route-api.mjs';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import { createSelfUpdateController } from './self-update.mjs';
import { createSkillsApi } from './skills-api.mjs';
import { createNotificationBus } from './notification-bus.mjs';
import { createToolSurface } from './tool-surface.mjs';
import {
  LOCAL_PROVIDER_ID,
  installLocalProviderModel,
  installLocalProviderRuntime,
  localProviderStatus,
  stopLocalProviderServer,
  cancelLocalInstallation,
  configureLocalProviderIdleTtl,
} from '../runtime/local-provider/managed-runtime.mjs';
import { createToolPolicyRefresh } from './tool-policy-refresh.mjs';
import { readRuntimeTunables } from './runtime-tunables.mjs';
import { createSessionTurnApi } from './session-turn-api.mjs';
import { createGoalRuntime } from './goal-runtime.mjs';
import { createGoalFacadeApi } from './goal-facade-api.mjs';
import { createRuntimeReviewApi } from './runtime-review-api.mjs';
import { createRuntimeFacade } from './runtime-facade.mjs';
import { createRoutePreparationGate } from './route-preparation.mjs';
import { createHookPayload } from './hook-payload.mjs';
import { createRoutedAgentTool } from './agent-tool-routing.mjs';
import { createInternalToolExecutor } from './internal-tool-executor.mjs';
import {
  RUNTIME,
  WEB_SEARCH_TOOL_DEFS,
  MEMORY_TOOL_DEFS,
  CHANNEL_TOOL_DEFS,
  CODE_GRAPH_TOOL_DEFS,
  STATUSLINE_SESSION_ROUTES,
  STANDALONE_ROOT,
  STANDALONE_DATA_DIR,
} from './runtime-paths.mjs';
// Desktop-app bridges: tiny fs/fetch clients, so a static import adds no
// meaningful boot cost. The tools themselves are gated per session by the
// sync bridge-availability probes (headless runs never see them); execution
// lives in internal-tool-executor.mjs.
import { browserBridgeAvailableSync } from '../runtime/browser-bridge/client.mjs';
import { TOOL_DEFS as BROWSER_BRIDGE_TOOL_DEFS } from '../runtime/browser-bridge/tool-defs.mjs';
import {
  computerBridgeAvailableSync,
  deferComputerSessionRelease,
  endComputerExecution,
} from '../runtime/computer-bridge/client.mjs';
import { TOOL_DEFS as COMPUTER_BRIDGE_TOOL_DEFS } from '../runtime/computer-bridge/tool-defs.mjs';
import { initializeOfficeTransactions } from '../runtime/office/index.mjs';
import { TOOL_DEFS as OFFICE_TOOL_DEFS } from '../runtime/office/tool-defs.mjs';
import { TOOL_DEFS as MEDIA_TOOL_DEFS } from '../runtime/media/tool-defs.mjs';
import { SETUP_TOOL_DEFS } from './setup-tool/tool-defs.mjs';
import { createSetupToolExecutor } from './setup-tool/executor.mjs';
const resolveDefaultProvider = makeResolveDefaultProvider(isKnownProvider);
const resolveRoute = makeResolveRoute(resolveDefaultProvider);
const webSearchCapableFor = makeWebSearchCapableFor(normalizeWebSearchProviderId, isWebSearchCapableProvider);

const outputStyleStatus = (dataDir = STANDALONE_DATA_DIR, opts = {}) => outputStyleStatusRaw(STANDALONE_ROOT, dataDir || STANDALONE_DATA_DIR, opts);
// Workflow/agent pack loaders bound to this runtime's root/data layout.
const {
  listWorkflowPacks,
  activeWorkflowId,
  loadWorkflowPack,
  workflowSummary,
  activeWorkflowSummary,
  loadAgentDefinition,
  listCustomAgentIds,
  workflowContextBlock,
  activeWorkflowContext,
} = createWorkflowHelpers({
  rootDir: STANDALONE_ROOT,
  dataDir: STANDALONE_DATA_DIR,
  readMarkdownDocument,
  normalizeAgentPermissionOrNone,
});
const {
  summarizeWorkflowRoutes,
  routeFromPreset,
  agentRouteFromConfig,
} = createWorkflowRouteHelpers({ findPreset });

export async function createMixdogSessionRuntime({
  provider,
  model,
  effort,
  fast,
  modelParameters,
  cwd = process.cwd(),
  toolMode = 'full',
  toolProfile = 'interactive',
  approvalMode = null,
  disallowDelegation = false,
  autoWakeCompletions = true,
  initialConfig = null,
  remote = false,
  desktopSession: initialDesktopSession = null,
  sessionProfile: initialSessionProfile = null,
  executeAgentControl = null,
} = {}) {
  // Shared mutable runtime state, promoted from closure `let`s so extracted
  // modules can read/write live values through one reference.
  const rt = {};
  rt.toolProfile = normalizeToolProfile(toolProfile);
  rt.approvalMode = approvalMode === 'implicit' ? 'implicit' : null;
  rt.disallowDelegation = disallowDelegation === true;
  rt.mcpScopeId = randomUUID();
  rt.desktopSession = initialDesktopSession;
  rt.sessionProfile = initialSessionProfile && typeof initialSessionProfile === 'object'
    ? { ...initialSessionProfile }
    : null;
  bootProfile('session-runtime:start', { provider, model, toolMode, cwd });
  // Last assistant text handed to the transcript writer (via onAssistantText),
  // so the post-turn final-content append can skip an exact duplicate.
  rt._lastAppendedAssistant = '';
  process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';
  const standaloneStartedAt = performance.now();
  ensureStandaloneEnvironment({
    rootDir: STANDALONE_ROOT,
    dataDir: STANDALONE_DATA_DIR,
  });
  // Office journals exist only for cross-process crash recovery, so startup just
  // prunes expired ones in the background. Surfacing them as session context made
  // every new session (agents included) re-announce unrelated leftovers for the
  // full 30-day retention window; recovery stays reachable on demand through
  // office action=transactions / action=recover.
  initializeOfficeTransactions(STANDALONE_DATA_DIR).catch(() => {});
  bootProfile('standalone-env:ready', { ms: (performance.now() - standaloneStartedAt).toFixed(1) });
  const {
    awaitKeychainPrewarm,
    invalidateProviderCaches,
    ensureProvidersReady,
    modelMetaByRoute,
    providerModelCaches,
    providerUsageCaches,
    providerInitPromises,
  } = createProviderReadiness({
    rt,
    keychain,
    getReg: () => reg,
    getWarmProviderModelCache: () => warmProviderModelCache,
  });
  const routePreparation = createRoutePreparationGate({
    onError: (error) => bootProfile('route-preparation:failed', {
      error: error?.message || String(error),
    }),
  });

  const importsStartedAt = performance.now();
  const [
    cfgMod,
    sharedCfgMod,
    reg,
    mcpClient,
    mgr,
    contextMod,
    internalTools,
    statusRoutes,
    webSearchToolDefs,
    memoryToolDefs,
    channelToolDefs,
    codeGraphToolDefs,
  ] = await Promise.all([
    profiledImport('config', `${RUNTIME}/config.mjs`),
    profiledImport('shared-config', `${RUNTIME}/../../shared/config.mjs`),
    profiledImport('providers-registry', `${RUNTIME}/providers/registry.mjs`),
    profiledImport('mcp-client', `${RUNTIME}/mcp/client.mjs`),
    profiledImport('session-manager', `${RUNTIME}/session/manager.mjs`),
    profiledImport('context-collect', `${RUNTIME}/context/collect.mjs`),
    profiledImport('internal-tools', `${RUNTIME}/internal-tools.mjs`),
    profiledImport('status-routes', STATUSLINE_SESSION_ROUTES, { optional: true }),
    profiledImport('web-search-tool-defs', WEB_SEARCH_TOOL_DEFS, { optional: true }),
    profiledImport('memory-tool-defs', MEMORY_TOOL_DEFS, { optional: true }),
    profiledImport('channel-tool-defs', CHANNEL_TOOL_DEFS, { optional: true }),
    profiledImport('code-graph-tool-defs', CODE_GRAPH_TOOL_DEFS, { optional: true }),
  ]);
  bootProfile('imports:ready', { ms: (performance.now() - importsStartedAt).toFixed(1) });
  const pluginDataDir = cfgMod.getPluginData();
  // Re-wire the idle/tombstone sweep. startIdleCleanup() lost its caller in a
  // refactor, so closed-session tombstones were never deleted after their 24h
  // grace — the store grew unbounded (observed: 1.8k files / 114MB), which
  // made summary-index rebuilds and per-save index rewrites stall boot for
  // seconds. Timer is unref'd and first fires after CLEANUP_INITIAL_DELAY_MS
  // (5min), so this adds zero boot-path cost.
  try { mgr.startIdleCleanup?.(); } catch { /* cleanup is best-effort */ }

  // Memory ingest is always-on. `recap` gates only the background cycles;
  // `memoryTools` gates the model-facing memory/recall tool surface. Headless
  // runs override any toggle per process via MIXDOG_FEATURE_* env values.
  const recapEnabledFn = () => recapEnabled(rt.config, true);
  const memoryToolsEnabledFn = () => builtinFeatureActive(rt.config, 'memory');
  const webSearchEnabled = () => builtinFeatureActive(rt.config, 'webSearch');
  const gitToolsEnabledFn = () => builtinFeatureActive(rt.config, 'git');
  const officeToolsEnabledFn = () => builtinFeatureActive(rt.config, 'office');
  const localProviderEnabledFn = () => builtinFeatureActive(rt.config, 'localProvider');
  const mediaToolEnabledFn = () => builtinFeatureActive(rt.config, 'media');
  const channelsEnabled = () => moduleEnabled(rt.config, 'channels', true);
  const featureDisallowedTools = () => featureDisallowedToolsFor(rt.config, {
    browserAvailable: browserBridgeAvailableSync(),
    computerAvailable: computerBridgeAvailableSync(),
  });

  const { getMemoryModule, getWebSearchModule, getCodeGraphModule } = createLazyRuntimeModules({ rt, cfgMod });

  function persistLeadRoute(routeLike) {
    const leadRoute = normalizeWorkflowRoute(routeLike);
    if (!leadRoute) return null;

    const nextConfig = { ...(rt.config || {}) };
    nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, 'lead', leadRoute);
    nextConfig.default = workflowPresetId('lead');

    saveConfigAndAdopt(nextConfig);
    return leadRoute;
  }

  const configStartedAt = performance.now();
  rt.config = initialConfig && typeof initialConfig === 'object'
    ? initialConfig
    : cfgMod.loadConfig({ secrets: false });
  configureLocalProviderIdleTtl(rt.config.providers?.[LOCAL_PROVIDER_ID]?.idleTtlSeconds);
  setConfiguredShell(normalizeSystemShellConfig(rt.config.shell).command);
  rt.configHasSecrets = false;
  rt.route = resolveRoute(rt.config, { provider, model });
  if (effort !== undefined) rt.route = { ...rt.route, effort: effort || null };
  if (fast === true || fast === false) rt.route = { ...rt.route, fast };
  if (modelParameters && typeof modelParameters === 'object') {
    rt.route = { ...rt.route, modelParameters: { ...modelParameters } };
  }
  // Unset means the default "follow the Main Model" route, not "unconfigured".
  rt.webSearchRoute = normalizeWebSearchRouteConfig(rt.config.webSearchRoute)
    || normalizeWebSearchRouteConfig({
      provider: WEB_SEARCH_DEFAULT_PROVIDER,
      model: WEB_SEARCH_DEFAULT_MODEL,
    });
  bootProfile('config:ready', { ms: (performance.now() - configStartedAt).toFixed(1) });
  rt.mode = normalizeToolMode(toolMode);
  rt.session = null;
  // A daemon-issued address may exist before provider setup. It is consumed by
  // createCurrentSession on the first actual turn, avoiding eager auth/model
  // work while still giving submit a stable session key.
  rt.reservedSessionId = null;
  rt.sessionCreatePromise = null;
  rt.currentCwd = cwd;
  rt.sessionNeedsCwdRefresh = false;
  rt.closeRequested = false;
  const warmupTimers = {
    providerSetupWarmupTimer: null,
    providerWarmupTimer: null,
    providerModelWarmupTimer: null,
    modelCatalogWarmupTimer: null,
    statuslineUsageWarmupTimer: null,
    statuslineUsageRefreshTimer: null,
  };
  // Prewarm/channel-start timer handles + async state, owned here so the
  // teardown clearTimeout sweep still sees them; the prewarm scheduler factory
  // mutates these objects in place (see createPrewarmSchedulers).
  const prewarmTimers = {
    codeGraphPrewarmTimer: null,
    channelStartTimer: null,
    searchRuntimeWarmupTimer: null,
  };
  const prewarmState = {
    codeGraphPrewarmInFlight: false,
    codeGraphPrewarmQueuedCwd: '',
    channelStartPromise: null,
  };
  rt.activeTurnCount = 0;
  rt.activeTurnAbortControllers = new Set();
  const registerActiveTurnController = (controller) => {
    rt.activeTurnAbortControllers.add(controller);
    return () => rt.activeTurnAbortControllers.delete(controller);
  };
  const abortActiveTurns = (reason) => {
    let aborted = false;
    for (const controller of [...rt.activeTurnAbortControllers]) {
      if (controller.signal.aborted) continue;
      aborted = true;
      try { controller.abort(reason); } catch {}
    }
    return aborted;
  };
  rt.firstTurnCompleted = false;
  const { hookCommonPayload } = createHookPayload({ rt, cfgMod });
  // Env-tunable boot delays and feature gates: runtime-tunables.mjs.
  const {
    providerSetupWarmupDelayMs,
    modelCatalogWarmupDelayMs,
    providerWarmupDelayMs,
    providerModelWarmupDelayMs,
    codeGraphPrewarmDelayMs,
    statuslineUsageWarmupDelayMs,
    statuslineUsageRefreshDelayMs,
    channelStartDelayMs,
    backgroundBusyRetryMs,
    mcpTurnGraceMs,
    remoteAutoStartDelayMs,
    providerWarmupEnabled,
    modelPrefetchEnabled,
    codeGraphPrewarmEnabled,
    modelCatalogWarmupEnabled,
    codeGraphPrewarmLazy,
  } = readRuntimeTunables();
  rt.codeGraphFirstTurnPrewarmDone = false;
  const notificationListeners = new Set();
  rt.startupProviderCatalogRefreshStarted = false;
  // True while the boot-time provider-catalog refresh is in flight: warming a
  // model cache it is about to invalidate only burns the load twice.
  rt.startupProviderCatalogRefreshPending = false;
  // MCP connect state, owned here so teardown/reconnect paths still observe it;
  // the mcp-glue factory mutates this object in place (see createMcpGlue).
  const mcpState = {
    mcpFailures: [],
    mcpConnectGeneration: 0,
    mcpConnectInFlight: null,
  };
  // MCP glue factory — config/currentCwd live-bound; connect state shared via
  // the caller-owned mcpState object above.
  const {
    mcpTransportLabel,
    resolveEffectiveMcpServers,
    mcpStatus,
    getMcpServerConfig,
    connectConfiguredMcp,
    awaitInitialMcpConnect,
    normalizeMcpServerInput,
  } = createMcpGlue({
    mcpClient,
    getConfig: () => rt.config,
    getCurrentCwd: () => rt.currentCwd,
    getMcpScopeId: () => rt.mcpScopeId,
    getDesktopSession: () => rt.desktopSession,
    setDesktopSession: (v) => { rt.desktopSession = v; },
    state: mcpState,
  });
  const hooksStartedAt = performance.now();
  const hooks = createStandaloneHookBus({
    dataDir: cfgMod.getPluginData(),
    // `mcp_tool` hooks run against the SAME connected MCP servers this session
    // uses. Without this runner every configured mcp_tool hook reported
    // "handler type mcp_tool not configured", so the handler's timeout +
    // cancellation path never ran in production. The hook's abort signal is
    // forwarded so a timed-out hook cancels its tool call instead of leaving it
    // holding an admission slot.
    mcpToolRunner: async ({ name, args, signal }) => {
      if (typeof mcpClient?.executeMcpTool !== 'function') {
        throw new Error('MCP runtime is unavailable');
      }
      const result = await mcpClient.executeMcpTool(name, args ?? {}, {
        scopeId: rt.mcpScopeId,
        signal: signal || null,
        ownerKey: `hook:${name}`,
      });
      return typeof result === 'string' ? result : String(result?.result ?? '');
    },
  });
  hooks.emit('runtime:start', { cwd: rt.currentCwd, provider: rt.route.provider, model: rt.route.model, toolMode: rt.mode });
  bootProfile('hooks:ready', { ms: (performance.now() - hooksStartedAt).toFixed(1) });

  // Self-update: registry check + background staging live in self-update.mjs;
  // the facade only wires config/data-dir/notification access into it. The
  // boot check is deferred past this constructor so a hanging registry request
  // can never delay session boot.
  const selfUpdate = createSelfUpdateController({
    getConfig: () => rt.config,
    getDataDir: () => cfgMod.getPluginData?.() || STANDALONE_DATA_DIR,
    emitNotification: (...a) => emitRuntimeNotification(...a),
  });
  const autoUpdateEnabled = () => selfUpdate.autoUpdateEnabled();
  const checkForUpdateInternal = (...a) => selfUpdate.checkForUpdate(...a);
  const runUpdateNowInternal = (...a) => selfUpdate.runUpdateNow();
  selfUpdate.startBootCheck();

  // Notification fan-out (listener broadcast + pending-queue mirroring of
  // terminal completions) lives in notification-bus.mjs.
  let sessionTurnApi = null;
  let goalRuntime = null;
  const completionWakeups = new Set();
  const wakeQueuedCompletion = ({ sessionId, executionId, enqueuedAt } = {}) => {
    const ownerSessionId = String(sessionId || '').trim();
    if (!ownerSessionId || completionWakeups.has(ownerSessionId)) return false;
    completionWakeups.add(ownerSessionId);
    setImmediate(async () => {
      const queuedAt = Number(enqueuedAt) || Date.now();
      try {
        const currentSessionId = String(rt.session?.id || rt.reservedSessionId || '').trim();
        if (currentSessionId !== ownerSessionId || !sessionTurnApi) return;
        const delayMs = Math.max(0, Date.now() - queuedAt);
        if (delayMs >= 1_000) {
          process.stderr.write(
            `[notification] delayed completion wake sessionId=${ownerSessionId}`
            + ` executionId=${executionId || 'unknown'} queuedMs=${delayMs}\n`,
          );
        }
        await sessionTurnApi.ask('', { submittedAt: queuedAt });
      } catch (err) {
        try {
          process.stderr.write(
            `[notification] completion wake failed sessionId=${ownerSessionId}`
            + ` executionId=${executionId || 'unknown'} err=${err?.message || err}\n`,
          );
        } catch {}
      } finally {
        completionWakeups.delete(ownerSessionId);
      }
    });
    return true;
  };
  const {
    emitRuntimeNotification,
    notifySession,
    notifySessionUi,
    notifyFnForSession,
    notifySessionCompletion,
    subscribeRuntimeNotification,
    bindRuntimeNotificationSession,
    clearRuntimeNotifications,
  } = createNotificationBus({
    listeners: notificationListeners,
    mgr,
    onCompletionQueued: autoWakeCompletions ? wakeQueuedCompletion : null,
  });
  // Adopt a session as this runtime's identity wherever setSession is
  // injected (lifecycle resume, model-route swap, workflow swap, turn api).
  // Binding here closes the restored-session hole: reserveSessionId binds
  // fresh daemon-addressed sessions, but a daemon-boot RESUME reaches the
  // runtime with listeners subscribed before any session id existed —
  // completion notifications then emitted into an empty session bucket and
  // the transcript card never rendered while the queued model twin worked
  // (2026-08-17 notify-trace: bus:completion listeners=0 on every restored
  // session's background completion).
  const adoptSession = (v) => {
    rt.session = v;
    if (v?.id) {
      rt.reservedSessionId = null;
      bindRuntimeNotificationSession(v.id);
      goalRuntime?.watchSession(v.id);
    }
  };

  // Skill listing/loading/creation lives in skills-api.mjs; the facade only
  // supplies the mutable cwd and the context module.
  const {
    skillsStatus,
    skillContent,
    skillToolContent,
    addGlobalSkill,
    saveSkillDocument,
    invalidateSkills,
  } = createSkillsApi({
    contextMod,
    getCwd: () => rt.currentCwd,
    getTools: () => {
      const surface = activeToolSurface();
      return [...new Map([...(surface?.tools || []), ...(surface?.deferredToolCatalog || []),
        ...(surface?.deferredLateToolCatalog || [])].map((tool) => [tool.name, tool])).values()];
    },
  });

  // cwd resolution/apply + plugins-status + core-memory context. Extracted to
  // session-runtime/cwd-plugins.mjs; the facade keeps ownership of the mutable
  // currentCwd/session/config locals via getter/setter
  // injection and passes the later-defined callbacks (prewarm/tool-surface/
  // memory) as closures.
  const {
    resolveCwdPath,
    applyResolvedCwd,
    refreshSessionForCwdIfNeeded,
    pluginsStatus,
    loadCoreMemoryContext,
  } = createCwdPlugins({
    getCurrentCwd: () => rt.currentCwd,
    setCurrentCwd: (next) => { rt.currentCwd = next; },
    getConfig: () => rt.config,
    getSession: () => rt.session,
    getDesktopSession: () => rt.desktopSession,
    setDesktopSession: (next) => { rt.desktopSession = next; },
    getRoute: () => rt.route,
    isCodeGraphPrewarmLazy: () => codeGraphPrewarmLazy,
    isCodeGraphFirstTurnPrewarmDone: () => rt.codeGraphFirstTurnPrewarmDone,
    getCodeGraphPrewarmDelayMs: () => codeGraphPrewarmDelayMs,
    setSessionNeedsCwdRefresh: (next) => { rt.sessionNeedsCwdRefresh = next; },
    connectConfiguredMcp,
    invalidatePreSessionToolSurface: (...a) => invalidatePreSessionToolSurface(...a),
    scheduleCodeGraphPrewarm: (...a) => scheduleCodeGraphPrewarm(...a),
    hooks,
    hookCommonPayload: (...a) => hookCommonPayload(...a),
    bootProfile,
    getMemoryModule: (...a) => getMemoryModule(...a),
    listRegisteredPlugins,
    pluginAdminStatus,
    pluginManifest,
    pluginMcpServerName,
    mcpScriptForPlugin,
    countSkillFiles,
    writeLastSessionCwd,
    updateCurrentCwdOverride,
    clean,
    resolve,
    statSync,
    existsSync,
    cfgMod,
    STANDALONE_DATA_DIR,
  });

  const agentToolStartedAt = performance.now();
  const agentTool = createStandaloneAgent({
    cfgMod,
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd,
    mcpScopeId: rt.mcpScopeId,
    awaitKeychainPrewarm,
    isKeychainPrewarmReady: () => rt.keychainPrewarmWaitDone,
    notifySessionCompletion,
    // SubagentStart/SubagentStop: bridge internal worker spawn/finish to the
    // standard hook bus. agent_type is passed top-level via hookCommonPayload
    // (added to hook-bus buildEventPayload passthrough). Best-effort.
    onSubagentEvent: (phase, info = {}) => {
      try {
        const event = phase === 'stop' ? 'SubagentStop' : 'SubagentStart';
        void hooks.dispatch(event, hookCommonPayload({
          session_id: info?.session_id || null,
          agent_type: info?.agent_type || null,
        }));
      } catch { /* best-effort: subagent hook must never affect worker lifecycle */ }
    },
  });
  const { routedAgentTool, agentStatusState } = createRoutedAgentTool({ rt, agentTool, executeAgentControl });
  bootProfile('agent:ready', { ms: (performance.now() - agentToolStartedAt).toFixed(1) });
  goalRuntime = createGoalRuntime({
    dataDir: cfgMod.getPluginData?.() || STANDALONE_DATA_DIR,
    generateTitle: async (source, options = {}) => {
      const { generateSessionTitle } = await import(
        '../runtime/agent/orchestrator/agent-runtime/title-completion.mjs'
      );
      return generateSessionTitle(source, options);
    },
  });
  if (rt.session?.id || rt.reservedSessionId) {
    goalRuntime.watchSession(rt.session?.id || rt.reservedSessionId);
  }
  const channelsStartedAt = performance.now();
  const channels = createStandaloneChannelWorker({
    rootDir: STANDALONE_ROOT,
    dataDir: cfgMod.getPluginData(),
    cwd,
    // A session runtime can outlive the process that originally spawned
    // the daemon. Bind channel liveness to this runtime host, never that stale
    // inherited supervisor PID.
    leadPid: process.pid,
    // Sessions are lazy: a resumed session lives as a reserved id until its
    // first turn. Registering with a null id would make the daemon skip the
    // session-pinned channel-link restore for exactly the session that owns it.
    getSessionId: () => rt.session?.id || rt.reservedSessionId || null,
    onNotify: (msg) => {
      if (msg?.method !== 'notifications/claude/channel') return;
      const params = msg?.params && typeof msg.params === 'object' ? msg.params : {};
      const meta = params.meta && typeof params.meta === 'object' ? params.meta : {};
      const content = channelNotificationModelContent(params);
      if (!content) return;
      const targetSessionId = channelNotificationSessionId(rt.session, rt.reservedSessionId);
      notifySession(targetSessionId, content, meta);
    },
  });
  bootProfile('channels:worker-ready', { ms: (performance.now() - channelsStartedAt).toFixed(1) });
  const toolsStartedAt = performance.now();
  const webSearchRuntimeTools = (webSearchToolDefs?.TOOL_DEFS || [])
    .filter((tool) => ['web_search', 'web_fetch', 'local_fetch', 'image_fetch'].includes(tool?.name));
  const standaloneTools = [
    TOOL_SEARCH_TOOL,
    ...(envFlag('MIXDOG_DISABLE_SKILLS') ? [] : [SKILL_TOOL]),
    CWD_TOOL,
    ...webSearchRuntimeTools.filter((tool) => tool?.public !== false),
    ...(memoryToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'recall' || tool?.name === 'memory'),
    ...(channelToolDefs?.TOOL_DEFS || []).filter((tool) => channels.isChannelTool(tool?.name)),
    ...(codeGraphToolDefs?.CODE_GRAPH_TOOL_DEFS || []).filter((tool) => tool?.name === 'code_graph'),
    ...BROWSER_BRIDGE_TOOL_DEFS.filter((tool) => tool?.name === 'browser' || tool?.name === 'browser_devtools'),
    ...COMPUTER_BRIDGE_TOOL_DEFS.filter((tool) => tool?.name === 'computer'),
    ...OFFICE_TOOL_DEFS.filter((tool) => tool?.name === 'office'),
    ...MEDIA_TOOL_DEFS.filter((tool) => tool?.name === 'media'),
    ...SETUP_TOOL_DEFS,
    ...goalRuntime.tools,
    ...agentTool.tools,
  ].map(applyStandaloneToolDefaults);
  bootProfile('tools:ready', { ms: (performance.now() - toolsStartedAt).toFixed(1), count: standaloneTools.length });

  // Workflow-aware model surface: a pack that declares an EMPTY agents list
  // (Solo) must not advertise the agent tool at all — the model calling a
  // schema-visible tool that policy always rejects is a guaranteed error turn
  // (user-reported in Solo). Names derive from the live agent tool defs.
  const agentToolNames = new Set(agentTool.tools.map((tool) => String(tool?.name || '')).filter(Boolean));
  // Lead tool surface (workflow-gated agent tool, pre-session preview, deferred
  // replay) lives in tool-surface.mjs.
  const {
    modelStandaloneTools,
    invalidatePreSessionToolSurface,
    activeToolSurface,
    applyPreSessionToolSelection,
  } = createToolSurface({
    mgr,
    mode: rt.mode,
    standaloneTools,
    agentToolNames,
    getSession: () => rt.session,
    getRoute: () => rt.route,
    getConfig: () => rt.config,
    getToolProfile: () => rt.toolProfile,
    getMcpScopeId: () => rt.mcpScopeId,
    getCurrentCwd: () => rt.currentCwd,
    cfgMod,
    loadWorkflowPack,
    activeWorkflowId,
    dataDir: STANDALONE_DATA_DIR,
    getFeatureDisallowedTools: featureDisallowedTools,
  });

  const { contextStatus: computeContextStatus, invalidateContextStatusCache } = createContextStatus({
    getSession: () => rt.session,
    getRoute: () => rt.route,
    getCurrentCwd: () => rt.currentCwd,
    getMcpScopeId: () => rt.mcpScopeId,
    getMode: () => rt.mode,
  });
  const computeContextStatusForSession = (session) => {
    if (!session || typeof session !== 'object') return null;
    const { contextStatus } = createContextStatus({
      getSession: () => session,
      getRoute: () => ({
        provider: session.provider || '',
        model: session.model || '',
        contextWindow: session.contextWindow || null,
      }),
      getCurrentCwd: () => session.cwd || rt.currentCwd,
      getMode: () => rt.mode,
    });
    return contextStatus();
  };
  // The setup tool drives the same facade the settings UIs use. The facade is
  // the object this factory returns, so it is handed over by reference below
  // and read lazily on each call.
  let runtimeFacade = null;
  const setupTool = createSetupToolExecutor({
    getApi: () => runtimeFacade,
    getConfig: () => rt.config,
    notifySessionUi,
    getSessionId: () => rt.session?.id || rt.reservedSessionId || null,
  });
  internalTools.setInternalToolsProvider({
    tools: [...standaloneTools, ...webSearchRuntimeTools.filter((tool) => tool?.public === false)],
    executor: createInternalToolExecutor({
      rt,
      channels,
      goalRuntime,
      agentTool: routedAgentTool,
      setupTool,
      webSearchEnabled,
      memoryToolsEnabled: memoryToolsEnabledFn,
      officeToolsEnabled: officeToolsEnabledFn,
      mediaToolEnabled: mediaToolEnabledFn,
      channelsEnabled,
      getWebSearchModule,
      getMemoryModule,
      getCodeGraphModule,
      notifyFnForSession,
      // Late-bound: createNativeWebSearch is constructed after this
      // registration; the executor only runs once a tool call arrives.
      runNativeWebSearch: (...a) => runNativeWebSearch(...a),
      activeToolSurface,
      mcpStatus,
      applyResolvedCwd,
      skillToolContent,
    }),
  });
  void connectConfiguredMcp()
    .then((status) => bootProfile('mcp:ready', {
      connected: Number(status?.connectedCount || 0),
      failed: Number(status?.failedCount || 0),
    }))
    .catch((error) => bootProfile('mcp:failed', { error: error?.message || String(error) }));

  function reloadChannelsSoon() {
    channels.execute('reload_config', {}).catch(() => {});
  }

  // Config reload/save/adopt family + output-style status cache. Extracted to
  // session-runtime/config-lifecycle.mjs; the facade retains ownership of the
  // config/webSearchRoute/configHasSecrets mutable locals via getter/setter
  // injection (the proven mutable-state pattern).
  const {
    getOutputStyleStatusCached,
    invalidateOutputStyleStatusCache,
    seedOutputStyleStatusCache,
    adoptConfig,
    saveConfigAndAdopt,
    flushConfigSave,
    scheduleSkillsSave,
    flushSkillsSave,
    flushOutputStyleSave,
    scheduleOutputStyleSave,
    flushAllConfigSavesAsync,
    reloadFullConfig,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
  } = createConfigLifecycle({
    getConfig: () => rt.config,
    setConfig: (next) => {
      rt.config = next;
      configureLocalProviderIdleTtl(next.providers?.[LOCAL_PROVIDER_ID]?.idleTtlSeconds);
    },
    getWebSearchRoute: () => rt.webSearchRoute,
    setWebSearchRoute: (next) => { rt.webSearchRoute = next; },
    getConfigHasSecrets: () => rt.configHasSecrets,
    setConfigHasSecrets: (next) => { rt.configHasSecrets = next; },
    getRoute: () => rt.route,
    cfgMod,
    sharedCfgMod,
    setConfiguredShell,
    normalizeSystemShellConfig,
    normalizeWebSearchRouteConfig,
    outputStyleStatus,
    LAZY_SECRET_PROVIDERS,
    clean,
    resolve,
    STANDALONE_DATA_DIR,
  });

  const {
    currentMainWebSearchModelMeta,
    runNativeWebSearch,
  } = createNativeWebSearch({
    getRoute: () => rt.route,
    getWebSearchRoute: () => rt.webSearchRoute,
    setWebSearchRoute: (next) => { rt.webSearchRoute = next; },
    getConfig: () => rt.config,
    getSession: () => rt.session,
    getReg: () => reg,
    ensureFullConfig,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    ensureProviderEnabled,
    normalizeWebSearchProviderId,
    normalizeWebSearchRouteConfig,
    isDefaultWebSearchRouteConfig,
    isWebSearchCapableProvider,
    webSearchCapableFor,
  });

  // Late-bound: createWarmupSchedulers is constructed after this factory, but
  // cachedProviderSetup(quick) may nudge scheduleProviderSetupWarmup on a cold
  // quick-cache fill. Thread it by reference so the scheduler is reachable once
  // it exists (a pre-scheduler quick fill simply skips the warmup nudge).
  rt.scheduleProviderSetupWarmupRef = () => {};
  const {
    refreshStatuslineUsageSnapshot,
    cachedProviderSetup,
    hasProviderSetupCached,
    getUsageDashboard,
    consumeCodexRateLimitResetCredit,
  } = createProviderUsage({
    caches: providerUsageCaches,
    getConfig: () => rt.config,
    getReg: () => reg,
    displayConfig,
    providerSetup,
    createUsageDashboard,
    fetchOAuthUsageSnapshot,
    consumeOpenAICodexResetCredit,
    isCloseRequested: () => rt.closeRequested,
    getProviderSetupWarmupTimer: () => warmupTimers.providerSetupWarmupTimer,
    scheduleProviderSetupWarmup: (delayMs) => rt.scheduleProviderSetupWarmupRef(delayMs),
  });

  // Holder filled after createQuickModelRows resolves; provider-models and
  // quick-model-rows are mutually dependent (rows need cache-row helpers, the
  // model factory needs quick fallbacks) so we thread the quick surface in by
  // reference after both are constructed.
  const providerModelQuickHelpers = {};
  // Late-bound: createWarmupSchedulers is constructed after this factory, but
  // lookupModelMeta may fire scheduleProviderModelWarmup on a cache miss. Thread
  // it by reference so the scheduler is called once it exists (miss handling is
  // best-effort; a pre-scheduler miss simply skips the warmup nudge).
  rt.scheduleProviderModelWarmupRef = () => {};
  const {
    modelMetaKey,
    lookupModelMeta,
    sortProviderModels,
    providerModelCacheRow,
    providerModelsFromCacheRows,
    collectWebSearchProviderModels,
    collectProviderModels,
    warmProviderModelCache,
  } = createProviderModels({
    caches: providerModelCaches,
    modelMetaByRoute,
    getRoute: () => rt.route,
    getConfig: () => rt.config,
    getReg: () => reg,
    webSearchCapableFor,
    sortProviderModelsRaw,
    providerModelCacheRowRaw,
    normalizeWebSearchProviderId,
    isWebSearchCapableProvider,
    ensureFullConfig,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    bootProfile,
    scheduleProviderModelWarmup: () => rt.scheduleProviderModelWarmupRef(),
    quickHelpers: providerModelQuickHelpers,
  });

  const {
    quickProviderModelRows,
    addDefaultWebSearchModel,
    quickWebSearchProviderModelRows,
    webSearchModelsFromRows,
    webSearchRowsWithDefault,
  } = createQuickModelRows({
    getRoute: () => rt.route,
    getWebSearchRoute: () => rt.webSearchRoute,
    displayConfig,
    providerModelCacheRow,
    providerModelsFromCacheRows,
    sortProviderModels,
    modelMetaByRoute,
    modelMetaKey,
    normalizeWebSearchProviderId,
    normalizeWebSearchRouteConfig,
    isWebSearchCapableProvider,
    webSearchCapableFor,
    currentMainWebSearchModelMeta,
  });
  Object.assign(providerModelQuickHelpers, {
    quickProviderModelRows,
    addDefaultWebSearchModel,
    quickWebSearchProviderModelRows,
    webSearchModelsFromRows,
    webSearchRowsWithDefault,
  });

  // Route resolution + createCurrentSession: session-lifecycle.mjs.
  const {
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
    invokeChannelStart,
    scheduleChannelStart,
    refreshRouteEffort,
    routeHasModel,
    requireModelRoute,
    recreateCurrentSessionIfReady,
    createCurrentSession,
    remoteTranscript,
  } = createSessionLifecycle({
    rt,
    collectProviderModels,
    ensureProvidersReady,
    lookupModelMeta,
    mgr,
    loadCoreMemoryContext,
    awaitKeychainPrewarm,
    ensureConfigForRouteProvider,
    reg,
    cfgMod,
    activeWorkflowContext,
    hooks,
    hookCommonPayload,
    mcpClient,
    modelStandaloneTools,
    schemaAllowedTools: modelToolSchemaAllowlist(rt.toolProfile),
    featureDisallowedTools,
    applyPreSessionToolSelection,
    statusRoutes,
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
    channelsEnabled,
    getCodeGraphModule,
    channels,
    codeGraphPrewarmDelayMs,
    channelStartDelayMs,
    codeGraphPrewarmEnabled,
    prewarmState,
    agentTool: routedAgentTool,
  });
  const ensureSessionTranscriptWriter = () => remoteTranscript.ensureSessionTranscriptWriter();

  bootProfile('session-runtime:ready', {
    lazySession: true,
    providerWarmup: providerWarmupEnabled,
    codeGraphPrewarm: codeGraphPrewarmEnabled,
  });
  // Heavy work remains demand-driven. Native helpers overlap provider.send;
  // memory and code-graph parsing stay cold until their feature is used.
  bootProfile('runtime:prewarm-deferred', { reason: 'first-turn' });
  scheduleProviderWarmup();
  scheduleProviderModelWarmup();
  scheduleProviderSetupWarmup();
  scheduleModelCatalogWarmup();
  scheduleStatuslineUsageWarmup();
  // Automation decoupling (user decision): enabled schedules/webhooks boot
  // the worker on their own — no messaging provider. The worker runs
  // headless (scheduler/webhooks/voice only).
  prewarmTimers.channelStartTimer = setTimeout(() => {
    prewarmTimers.channelStartTimer = null;
    if (rt.closeRequested) return;
    void hasActiveAutomation()
      .then((active) => {
        if (!active || rt.closeRequested) return;
        bootProfile('channels:automation-autostart');
        void invokeChannelStart();
      })
      .catch(() => { /* automation probe is best-effort */ });
  }, remoteAutoStartDelayMs);
  prewarmTimers.channelStartTimer.unref?.();

  // Pure settings-delegate methods (onboarding status/skip, autoClear, profile,
  // compaction, recap/memory, channels, systemShell, update settings).
  // Extracted to session-runtime/settings-api.mjs
  // and SPREAD into the API object below so the external surface is unchanged.
  const { refreshEmptySessionToolPolicy } = createToolPolicyRefresh({
    getSession: () => rt.session,
    getRoute: () => rt.route,
    getMode: () => rt.mode,
    getConfig: () => rt.config,
    getDataDir: () => cfgMod.getPluginData?.() || STANDALONE_DATA_DIR,
    modelStandaloneTools,
    featureDisallowedTools,
    memoryToolsEnabled: memoryToolsEnabledFn,
    loadCoreMemoryContext,
    activeWorkflowContext,
    invalidatePreSessionToolSurface,
  });
  const settingsApi = createSettingsApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    getSession: () => rt.session,
    adoptConfig,
    saveConfigAndAdopt,
    scheduleSkillsSave,
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
    // Built-in install adapters. Memory warms the embedding runtime so the
    // model download happens at install time instead of the first recall;
    // git verification is an instant probe; office provisions global Noto fonts
    // and verifies the bundled engine.
    prepareBuiltinFeature: async (name) => {
      if (name === 'memory') {
        const memory = await getMemoryModule().catch(() => null);
        await memory?.warmup?.().catch?.(() => {});
      } else if (name === 'office') {
        const { prepareOfficeFonts } = await import('../runtime/office/portable/font-provisioner.mjs');
        await prepareOfficeFonts?.().catch?.(() => {});
      } else if (name === 'localProvider') {
        await installLocalProviderRuntime();
      }
    },
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
    summarizeWorkflowRoutes,
    parseDurationMs,
    formatDurationMs,
    localPackageVersion,
    recapEnabledFn,
    memoryToolsEnabledFn,
    gitToolsEnabledFn,
    officeToolsEnabledFn,
    localProviderEnabledFn,
    webSearchEnabled,
    channelsEnabled,
    autoUpdateEnabled,
    getUpdateCheckState: () => selfUpdate.getCheckState(),
    getUpdateProcessState: () => selfUpdate.getProcessState(),
    invalidateContextStatusCache: (...a) => invalidateContextStatusCache(...a),
    invalidatePreSessionToolSurface: (...a) => invalidatePreSessionToolSurface(...a),
    refreshEmptySessionToolPolicy,
    scheduleChannelStart: (...a) => scheduleChannelStart(...a),
    channels,
    clearChannelStartTimer: () => {
      if (prewarmTimers.channelStartTimer) {
        clearTimeout(prewarmTimers.channelStartTimer);
        prewarmTimers.channelStartTimer = null;
      }
    },
    checkForUpdateInternal: (...a) => checkForUpdateInternal(...a),
    runUpdateNowInternal: (...a) => runUpdateNowInternal(...a),
    reloadChannelsSoon: (...a) => reloadChannelsSoon(...a),
    ONBOARDING_VERSION,
  });

  const channelConfigApi = createChannelConfigApi({
    channels,
    reloadChannelsSoon,
    // Automation saved mid-session boots the worker (claim-if-vacant) even
    // though the boot-time autostart window has already passed.
    ensureAutomationRuntime: () => scheduleChannelStart(0),
  });
  const providerAuthApi = createProviderAuthApi({
    cfgMod,
    getConfig: () => rt.config,
    saveConfigAndAdopt,
    displayConfig,
    reloadFullConfig,
    awaitKeychainPrewarm,
    isKeychainPrewarmReady: () => rt.keychainPrewarmWaitDone,
    hasProviderSetupCached,
    invalidateProviderCaches,
    warmProviderModelCache,
    refreshProviderCatalogs: (options = {}) => ensureProvidersReady(rt.config.providers || {})
      .then(() => reg.refreshCatalogs(options)),
    cachedProviderSetup,
    getUsageDashboard,
    consumeCodexRateLimitResetCredit,
    collectProviderModels,
  });
  const mediaApi = createMediaApi();
  const sessionTitles = createSessionTitleController({
    dataRoot: () => cfgMod.getPluginData?.() || STANDALONE_DATA_DIR,
    promoteGeneratedTitle: (sessionId, title, stage) => (
      mgr.updateSessionGeneratedTitle(sessionId, title, stage)
    ),
  });
  let disposeGlobalExtensionSubscription = () => {};
  const lifecycleApi = createLifecycleApi({
    getSession: () => rt.session,
    setSession: adoptSession,
    getRoute: () => rt.route,
    setRoute: (v) => { rt.route = v; },
    getConfig: () => rt.config,
    getMode: () => rt.mode,
    getCurrentCwd: () => rt.currentCwd,
    // Resume must bind the session to THIS runtime's MCP registry scope; without
    // it the resumed session falls back to the empty 'global' scope and every
    // connected MCP tool is announced as removed (and never comes back).
    getMcpScopeId: () => rt.mcpScopeId,
    getDesktopSession: () => rt.desktopSession,
    setDesktopSession: (v) => { rt.desktopSession = v; },
    setCloseRequested: (v) => { rt.closeRequested = v; },
    getMemoryModPromise: () => rt.memoryModPromise,
    setMemoryModPromise: (v) => { rt.memoryModPromise = v; },
    setSessionNeedsCwdRefresh: (v) => { rt.sessionNeedsCwdRefresh = v; },
    getReservedSessionId: () => rt.reservedSessionId,
    abortActiveTurns,
    hooks,
    hookCommonPayload,
    mgr,
    statusRoutes,
    channels,
    agentTool: routedAgentTool,
    mcpClient,
    warmupTimers,
    prewarmTimers,
    flushConfigSave,
    flushOutputStyleSave,
    flushAllConfigSavesAsync,
    withTeardownDeadline,
    closePatchRuntimeIfLoaded,
    closeNativeToolTransports,
    stopSelfUpdateBootCheck: () => selfUpdate.stopBootCheck(),
    createCurrentSession,
    refreshRouteEffort,
    computeContextStatus,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface,
    applyResolvedCwd,
    resolveRoute,
    applyDeferredToolSurface,
    beginRoutePreparation: (task) => routePreparation.start(task),
    clearRoutePreparation: () => routePreparation.clear(),
    // Live getter: cwd-refresh session rebuilds must re-evaluate the
    // workflow's agent-tool gate, not reuse the boot-time array.
    getStandaloneTools: modelStandaloneTools,
    clearRuntimeNotifications,
    goalRuntime,
    disposeSessionTitles: () => sessionTitles.disposeAll(),
    disposeGlobalExtensionSubscription: () => disposeGlobalExtensionSubscription(),
  });
  const resourceApi = createResourceApi({
    getConfig: () => rt.config,
    getCurrentCwd: () => rt.currentCwd,
    cfgMod,
    hooks,
    STANDALONE_DATA_DIR,
    saveConfigAndAdopt,
    connectConfiguredMcp,
    invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy,
    normalizeMcpServerInput,
    mcpStatus,
    getMcpServerConfig,
    skillsStatus,
    skillContent,
    addGlobalSkill,
    saveSkillDocument,
    invalidateSkills,
    getDisabledSkills: () => settingsApi.getDisabledSkills(),
    setDisabledSkills: (names) => settingsApi.setDisabledSkills(names),
    pluginsStatus,
    getMemoryModule,
    reloadFullConfig,
    flushSkillsSave,
    awaitKeychainPrewarm,
  });
  disposeGlobalExtensionSubscription = () => resourceApi.disposeGlobalExtensionSubscription?.();
  const modelRouteApi = createModelRouteApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    setRouteState: (v) => { rt.route = v; },
    getSession: () => rt.session,
    setSession: adoptSession,
    getConfigHasSecrets: () => rt.configHasSecrets,
    getWebSearchRouteState: () => rt.webSearchRoute,
    setWebSearchRouteState: (v) => { rt.webSearchRoute = v; },
    cfgMod,
    reg,
    mgr,
    statusRoutes,
    resolveRoute,
    webSearchCapableFor,
    lookupModelMeta,
    adoptConfig,
    saveConfigAndAdopt,
    ensureFullConfig,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    persistLeadRoute,
    refreshRouteEffort,
    refreshStatuslineUsageSnapshot,
    scheduleStatuslineUsageRefresh,
    invalidateContextStatusCache,
    invalidateProviderCaches,
    createCurrentSession,
    invalidatePreSessionToolSurface,
    collectWebSearchProviderModels,
  });
  const workflowAgentsApi = createWorkflowAgentsApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    setRouteState: (v) => { rt.route = v; },
    getSession: () => rt.session,
    cfgMod,
    STANDALONE_DATA_DIR,
    resolveRoute,
    lookupModelMeta,
    adoptConfig,
    saveConfigAndAdopt,
    ensureProvidersReady,
    displayConfig,
    agentRouteFromConfig,
    loadAgentDefinition,
    listCustomAgentIds,
    activeWorkflowId,
    listWorkflowPacks,
    loadWorkflowPack,
    workflowSummary,
    getOutputStyleStatusCached,
    seedOutputStyleStatusCache,
    scheduleOutputStyleSave,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy,
  });
  sessionTurnApi = createSessionTurnApi({
    getSession: () => rt.session,
    setSession: adoptSession,
    getCurrentCwd: () => rt.currentCwd,
    getConfig: () => rt.config,
    getMode: () => rt.mode,
    setMode: (v) => { rt.mode = v; },
    getActiveTurnCount: () => rt.activeTurnCount,
    setActiveTurnCount: (v) => { rt.activeTurnCount = v; },
    isFirstTurnCompleted: () => rt.firstTurnCompleted,
    setFirstTurnCompleted: (v) => { rt.firstTurnCompleted = v; },
    getCodeGraphFirstTurnPrewarmDone: () => rt.codeGraphFirstTurnPrewarmDone,
    setCodeGraphFirstTurnPrewarmDone: (v) => { rt.codeGraphFirstTurnPrewarmDone = v; },
    codeGraphPrewarmLazy,
    getCloseRequested: () => rt.closeRequested,
    getTranscriptWriter: () => remoteTranscript.transcriptWriter,
    getLastAppendedAssistant: () => rt._lastAppendedAssistant,
    setLastAppendedAssistant: (v) => { rt._lastAppendedAssistant = v; },
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    refreshSessionForCwdIfNeeded,
    createCurrentSession,
    ensureSessionTranscriptWriter,
    channels,
    hooks,
    hookCommonPayload,
    mgr,
    notifyFnForSession,
    subscribeRuntimeNotification,
    bootProfile,
    scheduleProviderWarmup,
    scheduleProviderModelWarmup,
    invalidateContextStatusCache,
    agentTool: routedAgentTool,
    invalidatePreSessionToolSurface,
    refreshEmptySessionToolPolicy,
    activeToolSurface,
    applyResolvedCwd,
    resolveCwdPath,
    agentStatusState,
    notificationListeners,
    awaitInitialMcpConnect,
    mcpTurnGraceMs,
    awaitRoutePreparation: () => routePreparation.wait(),
    getReservedSessionId: () => rt.reservedSessionId,
    registerActiveTurnController,
    sessionTitles,
    endComputerExecution,
    deferComputerSessionRelease,
  });
  const getFacadeSessionId = () => rt.session?.id || rt.reservedSessionId || null;
  const runtimeReviewApi = createRuntimeReviewApi({
    getCwd: () => rt.currentCwd,
    getSessionId: getFacadeSessionId,
  });
  const goalFacadeApi = createGoalFacadeApi({
    agentStatusState,
    createCurrentSession,
    getSession: () => rt.session,
    getSessionId: getFacadeSessionId,
    goalRuntime,
  });

  runtimeFacade = createRuntimeFacade({
    state: rt,
    leadingApi: {
      ...settingsApi,
      ...channelConfigApi,
      ...providerAuthApi,
      ...mediaApi,
      ...runtimeReviewApi,
    },
    goalApi: goalFacadeApi,
    trailingApi: {
      ...lifecycleApi,
      ...resourceApi,
      ...modelRouteApi,
      ...workflowAgentsApi,
      ...sessionTurnApi,
    },
    deliverToolCompletion: notifySessionCompletion,
    reserveSessionId: (id) => {
      if (rt.session?.id && rt.session.id !== id) {
        throw new Error(`session ${rt.session.id} is already materialized`);
      }
      rt.reservedSessionId = id;
      bindRuntimeNotificationSession(id);
      goalRuntime?.watchSession(id);
      // Reservation is the earliest safe point to prepare keychain, memory,
      // provider metadata, hooks, and the provider transport. This starts no
      // model response and therefore incurs no inference/token usage. The first
      // submit joins this single-flight promise instead of paying cold setup.
      void createCurrentSession('reservation').catch((error) => {
        bootProfile('session:reservation-prewarm-failed', {
          error: error?.message || String(error),
        });
      });
    },
    getAutoClear: () => settingsApi.getAutoClear(),
    getSystemShell: () => normalizeSystemShellConfig(rt.config.shell),
    getWebSearchRoute: () => {
      rt.webSearchRoute = normalizeWebSearchRouteConfig(rt.config.webSearchRoute)
        || normalizeWebSearchRouteConfig(rt.webSearchRoute)
        || normalizeWebSearchRouteConfig({
          provider: WEB_SEARCH_DEFAULT_PROVIDER,
          model: WEB_SEARCH_DEFAULT_MODEL,
        });
      return rt.webSearchRoute;
    },
    getWorkflow: () => {
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const active = activeWorkflowSummary(rt.config, dataDir);
      if (rt.session?.workflow && typeof rt.session.workflow === 'object') {
        const current = workflowSummary(rt.session.workflow);
        return current?.id && active?.id && current.id !== active.id
          ? { ...active, currentSession: current, appliedToCurrentSession: false }
          : active;
      }
      return active;
    },
    getOutputStyle: () => getOutputStyleStatusCached().current,
    getContextStatus: computeContextStatus,
    getContextStatusForSession: computeContextStatusForSession,
    renameSessionTitle: (sessionId, title) => mgr.updateSessionManualTitle(sessionId, title),
  });
  return runtimeFacade;
}
