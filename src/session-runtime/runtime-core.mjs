import '../runtime/shared/uv-threadpool-boot.mjs';
import { createSessionLifecycle } from './session-lifecycle.mjs';
import { createSessionTitleController } from './session-title.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import keychain from '../lib/keychain-cjs.cjs';
import './hitch-profile.mjs';
import { ensureStandaloneEnvironment } from '../standalone/seeds.mjs';
import { createStandaloneAgent } from '../standalone/agent-tool.mjs';
import { isAgentOwner } from '../runtime/agent/orchestrator/agent-owner.mjs';
import { createStandaloneChannelWorker } from '../standalone/channel-worker.mjs';
import { createStandaloneHookBus } from '../standalone/hook-bus.mjs';
import { getStandaloneMemoryRuntime } from '../standalone/memory-runtime-proxy.mjs';
import { createRemoteTransitionQueue } from './remote-transition-queue.mjs';
import { writeLastSessionCwd } from '../runtime/shared/user-cwd.mjs';
import { cancelBackgroundTasks } from '../runtime/shared/background-tasks.mjs';
import { createTranscriptWriter } from '../runtime/shared/transcript-writer.mjs';
import { mixdogHome } from '../runtime/shared/plugin-paths.mjs';
import { checkLatestVersion, localPackageVersion, isDevInstall } from '../runtime/shared/update-checker.mjs';
import { spawnStagedInstall, runStagedInstall, isStagedComplete } from '../runtime/shared/staged-update.mjs';
import {
  channelNotificationModelContent,
  shouldMirrorChannelNotificationToPending,
} from '../runtime/shared/channel-notification-routing.mjs';
import {
  normalizeAgentPermissionOrNone,
  readMarkdownDocument,
} from '../runtime/shared/markdown-frontmatter.mjs';
import { setConfiguredShell } from '../runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
import { hasUserConversationMessage } from '../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import {
  beginOAuthProviderLogin,
  forgetProviderAuth,
  isKnownProvider,
  loginOAuthProvider,
  providerSetup,
  renderProviderStatus,
  saveOpenAIUsageSessionKey,
  saveOpenCodeGoUsageAuth,
  loginOpenCodeGoUsage,
  saveProviderApiKey,
  setLocalProvider,
} from '../standalone/provider-admin.mjs';
import { createUsageDashboard } from '../standalone/usage-dashboard.mjs';
import {
  consumeOpenAICodexResetCredit,
  fetchOAuthUsageSnapshot,
} from '../runtime/agent/orchestrator/providers/oauth-usage.mjs';
import {
  getModelMetadataSync,
  warmCatalogsInBackground,
} from '../runtime/agent/orchestrator/providers/model-catalog.mjs';
import {
  isResponsesFreeformTool,
  toResponsesCustomTool,
} from '../runtime/agent/orchestrator/providers/custom-tool-wire.mjs';
import {
  channelSetup,
  deleteSchedule,
  deleteWebhook,
  forgetDiscordToken,
  forgetTelegramToken,
  hasActiveAutomation,
  setChannel,
  saveDiscordToken,
  saveTelegramToken,
  saveSchedule,
  saveWebhook,
  setChannelProvider,
  setChannelProviderAsync,
  setScheduleEnabled,
  setWebhookEnabled,
  setWebhookConfig,
} from '../standalone/channel-admin.mjs';
import {
  addPlugin as registryAddPlugin,
  listRegisteredPlugins,
  pluginAdminStatus,
  removePlugin as registryRemovePlugin,
  updatePlugin as registryUpdatePlugin,
} from '../standalone/plugin-admin.mjs';
import {
  sessionMessageText,
  messageContextText,
  isSessionPreviewNoise,
  cleanSessionPreview,
  clean,
  hasOwn,
  toolResponseText,
  isEmptyRecallText,
  currentSessionRecallRows,
  sessionHasConversationMessages,
} from './session-text.mjs';
import {
  TOOL_MODES,
  ALL_EFFORT_LEVELS,
  EFFORT_LABELS,
  EFFORT_OPTIONS_BY_PROVIDER,
  EFFORT_BY_FAMILY,
  EFFORT_FALLBACKS,
  normalizeToolMode,
  normalizeEffortInput,
  effortOptionsFor,
  coerceEffortFor,
  normalizeSavedEffort,
  effortItemsFor,
  toolSpecForMode,
  deferredSurfaceModeForLead,
} from './effort.mjs';
import {
  LAZY_SECRET_PROVIDERS,
  routeFastKey,
  fastCapableFor,
  makeSearchCapableFor,
  fastPreferenceFor,
} from './model-capabilities.mjs';
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  makeResolveDefaultProvider,
  findPreset,
  makeResolveRoute,
  isLikelyRawModelId,
  validateRequestedModelSelector,
  ensureProviderEnabled,
  normalizeSystemShellConfig,
  normalizeSystemShellCommand,
  normalizeAutoClearConfig,
  resolveAutoClearIdleMs,
  autoClearIdleMsForProvider,
  autoClearProviderDefaults,
  normalizeCompactionConfig,
  moduleEnabled,
  setModuleEnabledInConfig,
  recapEnabled,
  setRecapEnabledInConfig,
  memoryToolsEnabled,
  setMemoryToolsEnabledInConfig,
  featureEnvOverride,
  formatDurationMs,
  parseDurationMs,
  modelMetaLooksResolved,
  modelSettingsFor,
  normalizeCompactTypeSetting,
} from './config-helpers.mjs';
import {
  routeForStatusline,
  writeStatuslineRoute,
} from './statusline-route.mjs';
import {
  normalizeOutputStyleId,
  listOutputStyleCatalog,
  findOutputStyle,
  outputStyleStatus as outputStyleStatusRaw,
} from './output-styles.mjs';
import { readJsonSafe, readTextSafe } from './fs-utils.mjs';
import {
  readProjectMcpServers,
  countSkillFiles,
  mcpScriptForPlugin,
  normalizePluginMcpServerConfig,
  pluginManifest,
  pluginMcpServerName,
  pluginRawMcpServers,
  pluginMcpEnableScript,
  resolveContainedPluginPath,
} from './plugin-mcp.mjs';
import {
  WORKFLOW_ROUTE_SLOTS,
  FIXED_AGENT_SLOTS,
  SEARCH_DEFAULT_PROVIDER,
  SEARCH_DEFAULT_MODEL,
  workflowPresetId,
  agentPresetSlot,
  normalizeAgentId,
  normalizeWorkflowId,
  DEFAULT_WORKFLOW_ID,
  createWorkflowHelpers,
  normalizeSearchProviderId,
  isDefaultSearchRouteConfig,
  isSearchCapableProvider,
  normalizeSearchRouteConfig,
  normalizeWorkflowRoute,
  upsertWorkflowPreset,
  createWorkflowRouteHelpers,
} from './workflow.mjs';
import {
  MEASURED_TOOL_USAGE,
  DEFERRED_DEFAULT_FULL_TOOLS,
  DEFERRED_DEFAULT_READONLY_TOOLS,
  DEFERRED_DEFAULT_LEAD_TOOLS,
  toolKind,
  toolSchemaBucket,
  estimateToolSchemaBreakdown,
  measuredToolUsage,
  parseToolSelection,
  parseToolSearchQuerySelection,
  sortedCatalogByMeasuredUsage,
  filterDisallowedTools,
  sortedNamesByMeasuredUsage,
  defaultDeferredToolNames,
  compactToolSearchDescription,
  toolRow,
  toolSearchMatches,
  applyDeferredToolSurface,
  selectDeferredTools,
  renderToolSearch,
} from './tool-catalog.mjs';
// Re-exported for external consumers (scripts/tool-smoke.mjs) that imported
// these from this module before the tool-catalog extraction.
export { defaultDeferredToolNames, compactToolSearchDescription } from './tool-catalog.mjs';
import {
  TOOL_SEARCH_TOOL,
  CWD_TOOL,
  SKILL_TOOL,
  SESSION_MANAGE_TOOL,
  LEAD_DISALLOWED_TOOLS,
  applyStandaloneToolDefaults,
} from './tool-defs.mjs';
import { ONBOARDING_VERSION, QUICK_SEARCH_MODELS } from './quick-search-models.mjs';
import {
  sortProviderModels as sortProviderModelsRaw,
  providerModelCacheRow as providerModelCacheRowRaw,
} from './model-recency.mjs';
import { createNativeSearch } from './native-search.mjs';
import { createConfigLifecycle } from './config-lifecycle.mjs';
import { attachSessionHooks } from './session-hooks.mjs';
import { createQuickModelRows } from './quick-model-rows.mjs';
import { createWarmupSchedulers } from './warmup-schedulers.mjs';
import { createPrewarmSchedulers } from './prewarm.mjs';
import {
  getTurnReviewDiff as getTurnSnapshotReviewDiff,
  revertTurnReview as revertTurnSnapshotReview,
  revertTurnReviewFile as revertTurnSnapshotReviewFile,
} from '../runtime/shared/turn-snapshot.mjs';
import { createMcpGlue } from './mcp-glue.mjs';
import { createCwdPlugins } from './cwd-plugins.mjs';
import { createSettingsApi } from './settings-api.mjs';
import { createProviderModels } from './provider-models.mjs';
import { createProviderUsage } from './provider-usage.mjs';
import { envFlag } from './env.mjs';
import { bootProfile, profiledImport } from './boot-profile.mjs';
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
import { createRemoteTranscript } from './remote-transcript.mjs';
import { createRemoteControl } from './remote-control.mjs';
import { createNotificationBus } from './notification-bus.mjs';
import { createToolSurface } from './tool-surface.mjs';
import { readRuntimeTunables } from './runtime-tunables.mjs';
import { createSessionTurnApi } from './session-turn-api.mjs';
import { providerInitCacheKey } from './provider-init-key.mjs';
import { createRoutePreparationGate } from './route-preparation.mjs';
import {
  RUNTIME,
  SEARCH_RUNTIME,
  SEARCH_TOOL_DEFS,
  MEMORY_TOOL_DEFS,
  CHANNEL_TOOL_DEFS,
  CODE_GRAPH_TOOL_DEFS,
  CODE_GRAPH_RUNTIME,
  STATUSLINE_SESSION_ROUTES,
  STANDALONE_SOURCE_ROOT,
  STANDALONE_ROOT,
  STANDALONE_DATA_DIR,
} from './runtime-paths.mjs';
import {
  dispatchSearchRuntimeTool,
  memoryToolArgsForCaller,
  shouldMirrorCompletionToPendingQueue,
} from './runtime-tool-routing.mjs';
export {
  __renderToolSearchForTest,
  __saveModelSettingsForTest,
  dispatchSearchRuntimeTool,
  memoryToolArgsForCaller,
  shouldMirrorCompletionToPendingQueue,
} from './runtime-tool-routing.mjs';
// Re-exported for external consumers (scripts/tool-smoke.mjs) that imported
// these from this module before the tool-defs extraction.
export { TOOL_SEARCH_TOOL, SKILL_TOOL };
// Back-compat test alias; delegates to the extracted helper.
export function __applyStandaloneToolDefaultsForTest(tool) {
  return applyStandaloneToolDefaults(tool);
}

const resolveDefaultProvider = makeResolveDefaultProvider(isKnownProvider);
const resolveRoute = makeResolveRoute(resolveDefaultProvider);
const searchCapableFor = makeSearchCapableFor(normalizeSearchProviderId, isSearchCapableProvider);
const KEYCHAIN_PREWARM_WAIT_MS = 5000;

const outputStyleStatus = (dataDir = STANDALONE_DATA_DIR, opts = {}) => outputStyleStatusRaw(STANDALONE_ROOT, dataDir || STANDALONE_DATA_DIR, opts);
const MEMORY_RUNTIME_ENTRY = fileURLToPath(new URL('../runtime/memory/index.mjs', import.meta.url));
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
} = createWorkflowRouteHelpers({ resolveDefaultProvider, findPreset });

export async function createMixdogSessionRuntime({
  provider,
  model,
  cwd = process.cwd(),
  toolMode = 'full',
  approvalMode = null,
  remote = false,
  desktopSession: initialDesktopSession = null,
  agentSession = null,
} = {}) {
  // Shared mutable runtime state, promoted from closure `let`s so extracted
  // modules can read/write live values through one reference.
  const rt = {};
  rt.approvalMode = approvalMode === 'implicit' ? 'implicit' : null;
  rt.mcpScopeId = randomUUID();
  rt.desktopSession = initialDesktopSession;
  // Agent shard spread: a daemon-hosted worker runtime carries the resolved
  // agent session spec; session creation routes through prepareAgentSession
  // (session-lifecycle) instead of the Lead session shape.
  rt.agentSessionSpec = agentSession && typeof agentSession === 'object' ? agentSession : null;
  bootProfile('session-runtime:start', { provider, model, toolMode, cwd });
  rt.remoteEnabled = remote === true;
  // SESSION-SCOPED Remote is manual-only. Explicit ON selects/overrides; no
  // registration, turn, session death, or process death transfers ownership.
  rt.remoteSessionId = null;
  // Desktop/TUI Remote toggles are desired-state transitions. Serialize the
  // daemon deactivate/detach and reconnect/activate chains so an OFF that is
  // still stopping can never tear down the worker created by the following ON.
  const remoteTransitions = createRemoteTransitionQueue();
  // Last assistant text handed to the transcript writer (via onAssistantText),
  // so the post-turn final-content append can skip an exact duplicate.
  rt._lastAppendedAssistant = '';
  process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';
  const standaloneStartedAt = performance.now();
  ensureStandaloneEnvironment({
    rootDir: STANDALONE_ROOT,
    dataDir: STANDALONE_DATA_DIR,
  });
  bootProfile('standalone-env:ready', { ms: (performance.now() - standaloneStartedAt).toFixed(1) });
  const keychainPrewarmPromise = keychain.prewarmSecrets();
  rt.keychainPrewarmWaitDone = false;
  rt.keychainPrewarmWaitPromise = null;
  function awaitKeychainPrewarm() {
    if (rt.keychainPrewarmWaitDone) return Promise.resolve();
    rt.keychainPrewarmWaitPromise ??= (async () => {
      let timeoutId;
      const deadline = new Promise((resolveDeadline) => {
        timeoutId = setTimeout(resolveDeadline, KEYCHAIN_PREWARM_WAIT_MS);
        timeoutId.unref?.();
      });
      try {
        await Promise.race([keychainPrewarmPromise, deadline]);
      } finally {
        clearTimeout(timeoutId);
        rt.keychainPrewarmWaitDone = true;
      }
    // Invoked here: the assignment used to store the async FUNCTION, so every
    // `await awaitKeychainPrewarm()` resolved instantly (awaiting a function is
    // a no-op) and callers silently skipped the wait they asked for.
    })();
    return rt.keychainPrewarmWaitPromise;
  }
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
    searchToolDefs,
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
    profiledImport('search-tool-defs', SEARCH_TOOL_DEFS, { optional: true }),
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
  rt.memoryModPromise = null;
  rt.searchModPromise = null;
  rt.codeGraphModPromise = null;

  // Memory ingest is always-on. `recap` gates only the background cycles;
  // `memoryTools` gates the model-facing memory/recall tool surface. Headless
  // runs override any toggle per process via MIXDOG_FEATURE_* env values.
  const recapEnabledFn = () => recapEnabled(rt.config, true);
  const memoryToolsEnabledFn = () => featureEnvOverride('MIXDOG_FEATURE_MEMORY')
    ?? memoryToolsEnabled(rt.config, true);
  const webSearchEnabled = () => featureEnvOverride('MIXDOG_FEATURE_WEB_SEARCH')
    ?? moduleEnabled(rt.config, 'search', true);
  const channelsEnabled = () => moduleEnabled(rt.config, 'channels', true);
  const featureDisallowedTools = () => [
    ...(webSearchEnabled() ? [] : ['search', 'web_fetch']),
    ...(memoryToolsEnabledFn() ? [] : ['memory', 'recall']),
  ];

  async function getMemoryModule() {
    const startedAt = performance.now();
    rt.memoryModPromise ??= Promise.resolve().then(() => {
      const runtime = getStandaloneMemoryRuntime({
        entry: MEMORY_RUNTIME_ENTRY,
        dataDir: process.env.MIXDOG_DATA_DIR || cfgMod.getPluginData?.() || STANDALONE_DATA_DIR,
      });
      // Session teardown must never stop a process shared by every other live
      // session. The daemon owns the actual stop()/deregister lifecycle.
      return {
        init: () => runtime.init(),
        handleToolCall: (...args) => runtime.handleToolCall(...args),
        buildSessionCoreMemoryPayload: (...args) => runtime.buildSessionCoreMemoryPayload(...args),
      };
    });
    const mod = await rt.memoryModPromise;
    if (typeof mod?.init === 'function') {
      await mod.init();
    }
    bootProfile('memory-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  async function getSearchModule() {
    const startedAt = performance.now();
    rt.searchModPromise ??= import(SEARCH_RUNTIME);
    const mod = await rt.searchModPromise;
    bootProfile('search-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  async function getCodeGraphModule() {
    const startedAt = performance.now();
    rt.codeGraphModPromise ??= import(CODE_GRAPH_RUNTIME);
    const mod = await rt.codeGraphModPromise;
    bootProfile('code-graph-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  function persistLeadRoute(routeLike) {
    const leadRoute = normalizeWorkflowRoute(routeLike);
    if (!leadRoute) return null;

    const nextConfig = { ...(rt.config || {}) };
    nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, 'lead', leadRoute);
    nextConfig.default = workflowPresetId('lead');

    saveConfigAndAdopt(nextConfig);
    return leadRoute;
  }

  async function closePatchRuntimeIfLoaded(options = {}) {
    const closer = globalThis.__mixdogCloseNativePatchServers;
    if (typeof closer !== 'function' || globalThis.__mixdogNativePatchRuntimeTouched !== true) return;
    bootProfile('patch-runtime:close:start');
    const startedAt = performance.now();
    try {
      await closer(options);
    } catch {
      // Best-effort shutdown only; terminal restore must continue.
    } finally {
      bootProfile('patch-runtime:close:done', { ms: (performance.now() - startedAt).toFixed(1) });
    }
  }

  const configStartedAt = performance.now();
  rt.config = cfgMod.loadConfig({ secrets: false });
  setConfiguredShell(normalizeSystemShellConfig(rt.config.shell).command);
  rt.configHasSecrets = false;
  rt.route = resolveRoute(rt.config, { provider, model });
  rt.searchRoute = normalizeSearchRouteConfig(rt.config.searchRoute);
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
  // session_manage tool: reset request scheduled by the model mid-turn,
  // consumed by the TUI engine at turn end ('clear' | 'compact_clear').
  rt.pendingSessionReset = null;
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
  function hookTranscriptPath(sessionId) {
    const id = clean(sessionId);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
    return join(dataDir, 'sessions', `${id}.json`);
  }
  function hookEffortPayload() {
    const level = clean(rt.route.effectiveEffort || rt.route.effort);
    return level ? { level: level.toLowerCase() } : undefined;
  }
  function hookCommonPayload(extra = {}) {
    const sid = clean(extra.session_id || extra.sessionId || rt.session?.id);
    return {
      ...(sid ? { session_id: sid, transcript_path: hookTranscriptPath(sid) } : {}),
      cwd: rt.currentCwd,
      permission_mode: rt.session?.permissionMode || 'default',
      ...(hookEffortPayload() ? { effort: hookEffortPayload() } : {}),
      ...extra,
    };
  }
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
  const modelMetaByRoute = new Map();
  const notificationListeners = new Set();
  // Remote seat listeners (TUI): fired when remote mode flips outside a direct
  // user action — currently only the superseded (seat stolen) path.
  const remoteStateListeners = new Set();
  function emitRemoteStateChange(enabled, reason = '') {
    for (const listener of [...remoteStateListeners]) {
      try { listener({ enabled: enabled === true, reason: String(reason || '') }); } catch {}
    }
  }
  const providerModelCaches = {
    providerModelsCache: { models: null, at: 0 },
    providerModelsPromise: null,
    providerModelsLoadSeq: 0,
    searchProviderModelsCache: { models: null, at: 0 },
  };
  const providerUsageCaches = {
    usageDashboardCache: { dashboard: null, at: 0 },
    usageDashboardPromise: null,
    providerSetupCache: { setup: null, at: 0 },
    providerSetupQuickCache: { setup: null, at: 0 },
    providerSetupPromise: null,
  };
  const providerInitPromises = new Map();
  rt.startupProviderCatalogRefreshStarted = false;
  // True while the boot-time provider-catalog refresh is in flight: warming a
  // model cache it is about to invalidate only burns the load twice.
  rt.startupProviderCatalogRefreshPending = false;
  rt.lastProjectMcpKey = null;
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
  const hooks = createStandaloneHookBus({ dataDir: cfgMod.getPluginData() });
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
  // Agent-hosted runtimes (shard spread) never own the install: skip the
  // network-bound update boot check per worker spawn.
  if (!rt.agentSessionSpec) selfUpdate.startBootCheck();

  // Notification fan-out (listener broadcast + pending-queue mirroring of
  // terminal completions) lives in notification-bus.mjs.
  const { emitRuntimeNotification, notifyFnForSession } = createNotificationBus({
    listeners: notificationListeners,
    mgr,
  });

  // Skill listing/loading/creation lives in skills-api.mjs; the facade only
  // supplies the mutable cwd and the context module.
  const {
    skillsStatus,
    skillContent,
    skillToolContent,
    addProjectSkill,
  } = createSkillsApi({ contextMod, getCwd: () => rt.currentCwd });

  // cwd resolution/apply + plugins-status + core-memory context. Extracted to
  // session-runtime/cwd-plugins.mjs; the facade keeps ownership of the mutable
  // currentCwd/session/config/lastProjectMcpKey locals via getter/setter
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
    getRoute: () => rt.route,
    getLastProjectMcpKey: () => rt.lastProjectMcpKey,
    setLastProjectMcpKey: (next) => { rt.lastProjectMcpKey = next; },
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
    readProjectMcpServers,
    writeLastSessionCwd,
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
  bootProfile('agent:ready', { ms: (performance.now() - agentToolStartedAt).toFixed(1) });
  const agentStatusState = () => {
    try {
      const status = agentTool.getStatus?.({ clientHostPid: rt.session?.clientHostPid || process.pid }) || {};
      return {
        agentWorkers: Array.isArray(status.workers) ? status.workers : [],
        agentJobs: Array.isArray(status.jobs) ? status.jobs : [],
        agentScope: status.scope || null,
      };
    } catch {
      return { agentWorkers: [], agentJobs: [], agentScope: null };
    }
  };
  const channelsStartedAt = performance.now();
  const channels = createStandaloneChannelWorker({
    rootDir: STANDALONE_ROOT,
    dataDir: cfgMod.getPluginData(),
    cwd,
    // A daemon session shard can outlive the process that originally spawned
    // the daemon. Bind channel liveness to this runtime host, never that stale
    // inherited supervisor PID.
    leadPid: process.pid,
    onNotify: (msg) => {
      // Single-holder remote: the worker reports it lost the bridge seat to a
      // newer remote session. Drop remote mode entirely on this session (no
      // handover, no retry) and tell UI listeners so the indicator updates.
      if (msg?.method === 'notifications/mixdog/remote') {
        if (msg?.params?.state === 'superseded' && rt.remoteEnabled) {
          stopRemote('superseded-by-newer-remote-session');
          emitRemoteStateChange(false, 'superseded');
        }
        return;
      }
      if (msg?.method !== 'notifications/claude/channel') return;
      const params = msg?.params && typeof msg.params === 'object' ? msg.params : {};
      const meta = params.meta && typeof params.meta === 'object' ? params.meta : {};
      const content = channelNotificationModelContent(params);
      if (!content) return;
      const { handled } = emitRuntimeNotification(content, meta);
      if (!handled && rt.session?.id && shouldMirrorChannelNotificationToPending(meta)) {
        try { mgr.enqueuePendingMessage(rt.session.id, content); } catch {}
      }
    },
  });
  bootProfile('channels:worker-ready', { ms: (performance.now() - channelsStartedAt).toFixed(1) });
  const toolsStartedAt = performance.now();
  const searchRuntimeTools = (searchToolDefs?.TOOL_DEFS || [])
    .filter((tool) => ['search', 'web_fetch', 'local_fetch', 'image_fetch'].includes(tool?.name));
  const standaloneTools = [
    TOOL_SEARCH_TOOL,
    ...(envFlag('MIXDOG_DISABLE_SKILLS') ? [] : [SKILL_TOOL]),
    CWD_TOOL,
    SESSION_MANAGE_TOOL,
    ...searchRuntimeTools.filter((tool) => tool?.public !== false),
    ...(memoryToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'recall' || tool?.name === 'memory'),
    ...(channelToolDefs?.TOOL_DEFS || []).filter((tool) => channels.isChannelTool(tool?.name)),
    ...(codeGraphToolDefs?.CODE_GRAPH_TOOL_DEFS || []).filter((tool) => tool?.name === 'code_graph'),
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
    getMcpScopeId: () => rt.mcpScopeId,
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
  internalTools.setInternalToolsProvider({
    tools: [...standaloneTools, ...searchRuntimeTools.filter((tool) => tool?.public === false)],
    executor: async (name, args, callerCtx = {}) => {
      const callerCwd = callerCtx?.callerCwd || rt.currentCwd;
      if (callerCtx?.invocationSource === 'model-tool') {
        if ((name === 'search' || name === 'web_fetch') && !webSearchEnabled()) {
          throw new Error('web search is disabled in settings; start a new session to refresh the tool list');
        }
        if ((name === 'memory' || name === 'recall') && !memoryToolsEnabledFn()) {
          throw new Error('memory tools are disabled in settings; background memory and manual core memory remain available');
        }
      }
      if (name === 'search' || name === 'web_fetch' || name === 'local_fetch' || name === 'image_fetch') {
        return dispatchSearchRuntimeTool(name, args, callerCtx, {
          getSearchModule,
          getCurrentCwd: () => rt.currentCwd,
          getSession: () => rt.session,
          notifyFnForSession,
          runNativeWebSearch,
        });
      }
      if (name === 'recall' || name === 'memory' || name === 'search_memories') {
        const memoryMod = await getMemoryModule();
        if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
        return await memoryMod.handleToolCall(
          name,
          memoryToolArgsForCaller(args, callerCwd),
          callerCtx?.signal || rt.session?.controller?.signal || null,
        );
      }
      if (name === 'code_graph') {
        const codeGraphMod = await getCodeGraphModule();
        if (!codeGraphMod?.executeCodeGraphTool) throw new Error('code_graph runtime is not available');
        return await codeGraphMod.executeCodeGraphTool(name, args || {}, args?.cwd || callerCwd);
      }
      if (name === 'tool_search' || name === 'load_tool') {
        return renderToolSearch(args, activeToolSurface(), rt.mode, { mcpStatus });
      }
      if (name === 'cwd') {
        const action = clean(args?.action || (args?.path ? 'set' : 'get')).toLowerCase();
        if (action === 'set') {
          applyResolvedCwd(resolveCwdPath(args?.path));
        } else if (action !== 'get') {
          throw new Error(`cwd: unknown action "${action}"`);
        }
        return JSON.stringify({ cwd: rt.currentCwd, sessionId: rt.session?.id || null }, null, 2);
      }
      if (name === 'session_manage') {
        // Lead/owner sessions only: an agent worker resetting its own
        // transcript mid-task would corrupt the delegation contract, and it
        // must never reach the owner conversation either.
        const callerSessionId = callerCtx?.callerSessionId || null;
        if (callerSessionId && rt.session?.id && callerSessionId !== rt.session.id) {
          throw new Error('session_manage: only the lead session may reset the conversation');
        }
        if (!rt.session?.id) throw new Error('session_manage: no active session');
        const action = clean(args?.action).toLowerCase();
        if (action !== 'clear' && action !== 'compact_clear') {
          throw new Error(`session_manage: unknown action "${action}" (use clear | compact_clear)`);
        }
        // Never clear mid-turn — the loop is still reading the transcript.
        // Schedule and let the TUI engine consume it at turn end (same
        // boundary the idle auto-clear uses).
        // Pin to the current session id so a resume/new-session between
        // scheduling and consumption can never clear the wrong conversation.
        rt.pendingSessionReset = { action, sessionId: rt.session.id };
        return action === 'clear'
          ? 'Session reset scheduled: full clear will run when this turn ends. All prior context will be gone.'
          : 'Session reset scheduled: the conversation will be summarized (compact) and cleared when this turn ends; key context carries forward in the summary.';
      }
      if (name === 'Skill') {
        return skillToolContent(args?.name);
      }
      if (name === 'agent') {
        const callerSessionId = callerCtx?.callerSessionId || rt.session?.id || null;
        return await agentTool.execute(args, {
          callerCwd,
          invocationSource: 'model-tool',
          callerSessionId,
          clientHostPid: callerCtx?.clientHostPid || rt.session?.clientHostPid || process.pid,
          signal: callerCtx?.signal,
          notifyFn: notifyFnForSession(callerSessionId),
        });
      }
      if (channels.isChannelTool(name)) {
        if (!channelsEnabled()) throw new Error('channels are disabled in settings');
        return await channels.execute(name, args || {});
      }
      throw new Error(`unknown standalone internal tool: ${name}`);
    },
  });
  internalTools.markBootReady?.();
  try { rt.lastProjectMcpKey = resolve(rt.currentCwd) + '\u0000' + JSON.stringify(readProjectMcpServers(rt.currentCwd)); } catch { rt.lastProjectMcpKey = null; }
  void connectConfiguredMcp()
    .then((status) => bootProfile('mcp:ready', {
      connected: Number(status?.connectedCount || 0),
      failed: Number(status?.failedCount || 0),
    }))
    .catch((error) => bootProfile('mcp:failed', { error: error?.message || String(error) }));

  function reloadChannelsSoon() {
    channels.execute('reload_config', {}).catch(() => {});
  }

  function invalidateProviderCaches(options = {}) {
    providerModelCaches.providerModelsCache = { models: null, at: 0 };
    providerModelCaches.providerModelsPromise = null;
    providerModelCaches.providerModelsLoadSeq += 1;
    providerModelCaches.searchProviderModelsCache = { models: null, at: 0 };
    providerUsageCaches.usageDashboardCache = { dashboard: null, at: 0 };
    providerUsageCaches.usageDashboardPromise = null;
    providerUsageCaches.providerSetupCache = { setup: null, at: 0 };
    providerUsageCaches.providerSetupQuickCache = { setup: null, at: 0 };
    providerUsageCaches.providerSetupPromise = null;
    if (options.preserveProviderInit !== true) providerInitPromises.clear();
    modelMetaByRoute.clear();
  }

  // Config reload/save/adopt family + output-style status cache. Extracted to
  // session-runtime/config-lifecycle.mjs; the facade retains ownership of the
  // config/searchRoute/configHasSecrets mutable locals via getter/setter
  // injection (the proven mutable-state pattern).
  const {
    getOutputStyleStatusCached,
    invalidateOutputStyleStatusCache,
    seedOutputStyleStatusCache,
    adoptConfig,
    saveConfigAndAdopt,
    flushConfigSave,
    flushChannelProviderSave,
    scheduleChannelProviderSave,
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
    setConfig: (next) => { rt.config = next; },
    getSearchRoute: () => rt.searchRoute,
    setSearchRoute: (next) => { rt.searchRoute = next; },
    getConfigHasSecrets: () => rt.configHasSecrets,
    setConfigHasSecrets: (next) => { rt.configHasSecrets = next; },
    getRoute: () => rt.route,
    cfgMod,
    sharedCfgMod,
    setChannelProvider,
    setChannelProviderAsync,
    setConfiguredShell,
    normalizeSystemShellConfig,
    normalizeSearchRouteConfig,
    outputStyleStatus,
    LAZY_SECRET_PROVIDERS,
    clean,
    resolve,
    STANDALONE_DATA_DIR,
  });

  async function ensureProvidersReady(providerConfig = rt.config.providers || {}) {
    await awaitKeychainPrewarm();
    const initKey = providerInitCacheKey(providerConfig);
    const existing = providerInitPromises.get(initKey);
    if (existing) return await existing;
    // Provider initialization is idempotent for one normalized config. Keep
    // the fulfilled promise, not only the in-flight one: session resume used
    // to rerun registry/keychain setup on every click even though neither the
    // provider config nor the registry had changed. Auth/config mutations call
    // invalidateProviderCaches(), which clears this gate and preserves the
    // existing refresh semantics.
    const providerInitPromise = Promise.resolve().then(() => reg.initProviders(providerConfig));
    providerInitPromises.set(initKey, providerInitPromise);
    let result;
    try {
      result = await providerInitPromise;
    } catch (error) {
      if (providerInitPromises.get(initKey) === providerInitPromise) providerInitPromises.delete(initKey);
      throw error;
    }
    if (!rt.startupProviderCatalogRefreshStarted && !rt.closeRequested) {
      rt.startupProviderCatalogRefreshStarted = true;
      rt.startupProviderCatalogRefreshPending = true;
      try {
        void Promise.resolve(reg.refreshProviderCatalogsOnStartup())
          .then(() => {
            // Fresh catalog rows invalidate model-derived caches, but the
            // already initialized provider registry remains valid.
            invalidateProviderCaches({ preserveProviderInit: true });
            rt.startupProviderCatalogRefreshPending = false;
            // Secrets-aware: a no-secrets rewarm bumps the load sequence and
            // is never adopted, so it discarded the in-flight authoritative
            // load and left the picker cache empty — every later consumer then
            // paid a full catalog load (measured ~560ms each).
            warmProviderModelCache({ loadSecrets: true });
            bootProfile('provider-catalogs:refresh-ready');
          })
          .catch((error) => {
            rt.startupProviderCatalogRefreshPending = false;
            bootProfile('provider-catalogs:refresh-failed', { error: error?.message || String(error) });
          });
        bootProfile('provider-catalogs:refresh-started');
      } catch (error) {
        rt.startupProviderCatalogRefreshPending = false;
        bootProfile('provider-catalogs:refresh-failed', { error: error?.message || String(error) });
      }
    }
    return result;
  }

  const {
    currentMainSearchModelMeta,
    runNativeWebSearch,
  } = createNativeSearch({
    getRoute: () => rt.route,
    getSearchRoute: () => rt.searchRoute,
    setSearchRoute: (next) => { rt.searchRoute = next; },
    getConfig: () => rt.config,
    getSession: () => rt.session,
    getReg: () => reg,
    ensureFullConfig,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    ensureProviderEnabled,
    normalizeSearchProviderId,
    normalizeSearchRouteConfig,
    isDefaultSearchRouteConfig,
    isSearchCapableProvider,
    searchCapableFor,
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
    collectSearchProviderModels,
    collectProviderModels,
    warmProviderModelCache,
  } = createProviderModels({
    caches: providerModelCaches,
    modelMetaByRoute,
    getRoute: () => rt.route,
    getConfig: () => rt.config,
    getReg: () => reg,
    searchCapableFor,
    sortProviderModelsRaw,
    providerModelCacheRowRaw,
    normalizeSearchProviderId,
    isSearchCapableProvider,
    ensureFullConfig,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    bootProfile,
    scheduleProviderModelWarmup: () => rt.scheduleProviderModelWarmupRef(),
    quickHelpers: providerModelQuickHelpers,
  });

  const {
    quickProviderModelRows,
    addDefaultSearchModel,
    quickSearchProviderModelRows,
    searchModelsFromRows,
    searchRowsWithDefault,
  } = createQuickModelRows({
    getRoute: () => rt.route,
    getSearchRoute: () => rt.searchRoute,
    displayConfig,
    providerModelCacheRow,
    providerModelsFromCacheRows,
    sortProviderModels,
    modelMetaByRoute,
    modelMetaKey,
    normalizeSearchProviderId,
    normalizeSearchRouteConfig,
    isSearchCapableProvider,
    searchCapableFor,
    currentMainSearchModelMeta,
  });
  Object.assign(providerModelQuickHelpers, {
    quickProviderModelRows,
    addDefaultSearchModel,
    quickSearchProviderModelRows,
    searchModelsFromRows,
    searchRowsWithDefault,
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
  });
  const ensureSessionTranscriptWriter = () => remoteTranscript.ensureSessionTranscriptWriter();
  const ensureRemoteTranscriptWriter = () => remoteTranscript.ensureRemoteTranscriptWriter();
  const pushTranscriptRebind = () => remoteTranscript.pushTranscriptRebind();
  const flushPendingTranscriptRebind = () => remoteTranscript.flushPendingTranscriptRebind();

  // Remote (channel relay) claim/release/stop live in remote-control.mjs; the
  // facade injects the mutable session + remote state they mutate.
  const remoteControl = createRemoteControl({
    getSession: () => rt.session,
    isRemoteEnabled: () => rt.remoteEnabled,
    setRemoteEnabled: (next) => { rt.remoteEnabled = next; },
    getRemoteSessionId: () => rt.remoteSessionId,
    setRemoteSessionId: (next) => { rt.remoteSessionId = next; },
    isCloseRequested: () => rt.closeRequested,
    clearChannelStartTimer: () => {
      if (prewarmTimers.channelStartTimer) {
        clearTimeout(prewarmTimers.channelStartTimer);
        prewarmTimers.channelStartTimer = null;
      }
    },
    remoteTransitions,
    channels,
    channelsEnabled,
    hasActiveAutomation,
    flushChannelProviderSave,
    invokeChannelStart,
    createCurrentSession,
    ensureSessionTranscriptWriter,
    ensureRemoteTranscriptWriter,
    getTranscriptPath: () => remoteTranscript.transcriptWriter?.transcriptPath || null,
    emitRemoteStateChange,
    getMemoryModule,
    bootProfile,
    envFlag,
  });
  const startRemote = (options) => remoteControl.startRemote(options);
  const releaseRemote = (reason) => remoteControl.releaseRemote(reason);
  const stopRemote = (reason) => remoteControl.stopRemote(reason);

  function isRemoteEnabled() {
    return rt.remoteEnabled;
  }

  function withTeardownDeadline(promise, ms, fallback = false) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  bootProfile('session-runtime:ready', {
    lazySession: true,
    providerWarmup: providerWarmupEnabled,
    codeGraphPrewarm: codeGraphPrewarmEnabled,
  });
  // Heavy session/tool/code-graph work is demand-driven. Startup restores the
  // visible pane tree only; the first real turn arms these warmups.
  bootProfile('runtime:prewarm-deferred', { reason: 'first-turn' });
  // Agent-hosted runtimes (shard spread) keep only the warmups that shorten
  // their FIRST ask (route provider + model metadata); provider-setup caches,
  // full model catalogs, statusline usage, and channel automation are
  // Lead-surface work that would otherwise run once per worker spawn.
  scheduleProviderWarmup();
  scheduleProviderModelWarmup();
  if (!rt.agentSessionSpec) {
    scheduleProviderSetupWarmup();
    scheduleModelCatalogWarmup();
    scheduleStatuslineUsageWarmup();
  }
  // Channels are opt-in: only boot the worker when this session started in (or
  // was toggled into) remote mode. Non-remote sessions never contend for the
  // channel; see startRemote()/stopRemote() and the `/remote` toggle.
  // A manual `mixdog --remote` request is deferred past the TUI's
  // first frame. startRemote() front-loads memory initialization
  // (PG + forced ONNX embed warmup in the child), eager session create, and
  // the channel-worker fork — and running it inline here interleaves that
  // CPU/disk load with engine boot, visibly delaying the first ink frame by
  // seconds. The deferred timer reuses prewarmTimers.channelStartTimer so an
  // early /remote (startRemote clears it), stopRemote(), and close() all
  // cancel it through the existing clearTimeout paths. Runtime /remote calls
  // still start immediately (user-initiated, UI already painted).
  if (rt.agentSessionSpec) {
    // Worker sessions never run channels or schedule automation probes.
  } else if (rt.remoteEnabled) {
    bootProfile('channels:manual-start-deferred', { delayMs: remoteAutoStartDelayMs });
    prewarmTimers.channelStartTimer = setTimeout(() => {
      prewarmTimers.channelStartTimer = null;
      if (rt.closeRequested || !rt.remoteEnabled) return;
      startRemote();
    }, remoteAutoStartDelayMs);
    prewarmTimers.channelStartTimer.unref?.();
  } else {
    // Automation decoupling (user decision): enabled schedules/webhooks boot
    // the worker on their own — no remote flag, no remote.autoStart, and no
    // messaging provider. A later explicit Remote ON promotes the same
    // daemon without restarting schedules or webhooks.
    prewarmTimers.channelStartTimer = setTimeout(() => {
      prewarmTimers.channelStartTimer = null;
      if (rt.closeRequested || rt.remoteEnabled) return;
      void hasActiveAutomation()
        .then((active) => {
          if (!active || rt.closeRequested || rt.remoteEnabled) return;
          bootProfile('channels:automation-autostart');
          void invokeChannelStart();
        })
        .catch(() => { /* automation probe is best-effort */ });
    }, remoteAutoStartDelayMs);
    prewarmTimers.channelStartTimer.unref?.();
  }

  // Pure settings-delegate methods (onboarding status/skip, autoClear, profile,
  // compaction, recap/memory, channels, systemShell, update settings, channel
  // token save/forget, setChannelProvider). Extracted to session-runtime/settings-api.mjs
  // and SPREAD into the API object below so the external surface is unchanged.
  const settingsApi = createSettingsApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    getSession: () => rt.session,
    getRemoteEnabled: () => rt.remoteEnabled,
    adoptConfig,
    saveConfigAndAdopt,
    scheduleChannelProviderSave,
    scheduleSkillsSave,
    cfgMod,
    hasOwn,
    normalizeAutoClearConfig,
    autoClearIdleMsForProvider,
    autoClearProviderDefaults,
    normalizeCompactionConfig,
    normalizeCompactTypeSetting,
    normalizeSystemShellConfig,
    normalizeSystemShellCommand,
    setConfiguredShell,
    setRecapEnabledInConfig,
    setMemoryToolsEnabledInConfig,
    setModuleEnabledInConfig,
    summarizeWorkflowRoutes,
    parseDurationMs,
    formatDurationMs,
    localPackageVersion,
    recapEnabledFn,
    memoryToolsEnabledFn,
    webSearchEnabled,
    channelsEnabled,
    autoUpdateEnabled,
    getUpdateCheckState: () => selfUpdate.getCheckState(),
    getUpdateProcessState: () => selfUpdate.getProcessState(),
    invalidateContextStatusCache: (...a) => invalidateContextStatusCache(...a),
    invalidatePreSessionToolSurface: (...a) => invalidatePreSessionToolSurface(...a),
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
    saveDiscordToken,
    forgetDiscordToken,
    saveTelegramToken,
    forgetTelegramToken,
    setChannelProvider,
  });

  const channelConfigApi = createChannelConfigApi({
    flushChannelProviderSave,
    channels,
    reloadChannelsSoon,
    // Automation saved mid-session boots the worker (claim-if-vacant) even
    // though the boot-time autostart window has already passed.
    ensureAutomationRuntime: () => scheduleChannelStart(0),
    awaitKeychainPrewarm,
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
    refreshProviderCatalogs: () => ensureProvidersReady(rt.config.providers || {}).then(() => reg.refreshCatalogs()),
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
  const lifecycleApi = createLifecycleApi({
    getSession: () => rt.session,
    setSession: (v) => {
      rt.session = v;
      if (v?.id) rt.reservedSessionId = null;
    },
    getRoute: () => rt.route,
    setRoute: (v) => { rt.route = v; },
    getConfig: () => rt.config,
    getMode: () => rt.mode,
    getCurrentCwd: () => rt.currentCwd,
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
    agentTool,
    pushTranscriptRebind,
    mcpClient,
    warmupTimers,
    prewarmTimers,
    flushConfigSave,
    flushChannelProviderSave,
    flushOutputStyleSave,
    flushAllConfigSavesAsync,
    withTeardownDeadline,
    closePatchRuntimeIfLoaded,
    stopSelfUpdateBootCheck: () => selfUpdate.stopBootCheck(),
    createCurrentSession,
    refreshRouteEffort,
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
    desktopSession: rt.desktopSession,
    disposeSessionTitles: () => sessionTitles.disposeAll(),
  });
  const resourceApi = createResourceApi({
    getConfig: () => rt.config,
    getSession: () => rt.session,
    getCurrentCwd: () => rt.currentCwd,
    cfgMod,
    mgr,
    hooks,
    STANDALONE_DATA_DIR,
    saveConfigAndAdopt,
    connectConfiguredMcp,
    invalidatePreSessionToolSurface,
    recreateCurrentSessionIfReady,
    normalizeMcpServerInput,
    mcpStatus,
    skillsStatus,
    skillContent,
    addProjectSkill,
    pluginsStatus,
    getMemoryModule,
    reloadFullConfig,
    awaitKeychainPrewarm,
    getActiveTurnCount: () => rt.activeTurnCount,
  });
  const modelRouteApi = createModelRouteApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    setRouteState: (v) => { rt.route = v; },
    getSession: () => rt.session,
    setSession: (v) => {
      rt.session = v;
      if (v?.id) rt.reservedSessionId = null;
    },
    getConfigHasSecrets: () => rt.configHasSecrets,
    getSearchRouteState: () => rt.searchRoute,
    setSearchRouteState: (v) => { rt.searchRoute = v; },
    cfgMod,
    reg,
    mgr,
    statusRoutes,
    resolveRoute,
    searchCapableFor,
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
    pushTranscriptRebind,
    collectSearchProviderModels,
  });
  const workflowAgentsApi = createWorkflowAgentsApi({
    getConfig: () => rt.config,
    getRoute: () => rt.route,
    setRouteState: (v) => { rt.route = v; },
    getSession: () => rt.session,
    setSession: (v) => {
      rt.session = v;
      if (v?.id) rt.reservedSessionId = null;
    },
    getConfigHasSecrets: () => rt.configHasSecrets,
    cfgMod,
    reg,
    mgr,
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
    recreateCurrentSessionIfReady,
    notifyFnForSession,
    invalidateContextStatusCache,
  });
  const sessionTurnApi = createSessionTurnApi({
    getSession: () => rt.session,
    setSession: (v) => {
      rt.session = v;
      if (v?.id) rt.reservedSessionId = null;
    },
    getCurrentCwd: () => rt.currentCwd,
    getMode: () => rt.mode,
    setMode: (v) => { rt.mode = v; },
    getActiveTurnCount: () => rt.activeTurnCount,
    setActiveTurnCount: (v) => { rt.activeTurnCount = v; },
    isFirstTurnCompleted: () => rt.firstTurnCompleted,
    setFirstTurnCompleted: (v) => { rt.firstTurnCompleted = v; },
    getCodeGraphFirstTurnPrewarmDone: () => rt.codeGraphFirstTurnPrewarmDone,
    setCodeGraphFirstTurnPrewarmDone: (v) => { rt.codeGraphFirstTurnPrewarmDone = v; },
    codeGraphPrewarmLazy,
    getRemoteEnabled: () => rt.remoteEnabled,
    getCloseRequested: () => rt.closeRequested,
    getPendingSessionReset: () => rt.pendingSessionReset,
    setPendingSessionReset: (v) => { rt.pendingSessionReset = v; },
    getTranscriptWriter: () => remoteTranscript.transcriptWriter,
    getTwKey: () => remoteTranscript.transcriptKey,
    getLastAppendedAssistant: () => rt._lastAppendedAssistant,
    setLastAppendedAssistant: (v) => { rt._lastAppendedAssistant = v; },
    scheduleCodeGraphPrewarm,
    scheduleToolRuntimeWarmup,
    scheduleSearchRuntimeWarmup,
    refreshSessionForCwdIfNeeded,
    createCurrentSession,
    ensureSessionTranscriptWriter,
    ensureRemoteTranscriptWriter,
    pushTranscriptRebind,
    flushPendingTranscriptRebind,
    channelsEnabled,
    invokeChannelStart,
    channels,
    hooks,
    hookCommonPayload,
    mgr,
    notifyFnForSession,
    bootProfile,
    scheduleProviderWarmup,
    scheduleProviderModelWarmup,
    invalidateContextStatusCache,
    agentTool,
    recreateCurrentSessionIfReady,
    invalidatePreSessionToolSurface,
    activeToolSurface,
    applyResolvedCwd,
    resolveCwdPath,
    agentStatusState,
    notificationListeners,
    remoteStateListeners,
    awaitInitialMcpConnect,
    mcpTurnGraceMs,
    awaitRoutePreparation: () => routePreparation.wait(),
    getReservedSessionId: () => rt.reservedSessionId,
    registerActiveTurnController,
    // Agent-hosted runtimes (shard spread) are ephemeral worker sessions: an
    // LLM title per spawn would be pure cost, and in-process agent
    // sessions never titled either.
    sessionTitles: rt.agentSessionSpec ? null : sessionTitles,
  });

  return {
    ...settingsApi,
    ...channelConfigApi,
    ...providerAuthApi,
    ...mediaApi,
    // Turn-scoped worktree review plus exact child apply_patch attribution.
    getTurnReviewDiff: (options = {}) => getTurnSnapshotReviewDiff(
      rt.currentCwd,
      rt.session?.id,
      options,
    ),
    revertTurnReview: () => revertTurnSnapshotReview(
      rt.currentCwd,
      rt.session?.id,
    ),
    revertTurnReviewFile: (file) => revertTurnSnapshotReviewFile(
      rt.currentCwd,
      rt.session?.id,
      file,
    ),
    get id() {
      return rt.session?.id || rt.reservedSessionId || null;
    },
    reserveSessionId(sessionId) {
      const id = String(sessionId || '').trim();
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
        throw new TypeError('session id is invalid');
      }
      if (rt.session?.id && rt.session.id !== id) {
        throw new Error(`session ${rt.session.id} is already materialized`);
      }
      rt.reservedSessionId = id;
      // Reservation is the earliest safe point to prepare keychain, memory,
      // provider metadata, hooks, and the provider transport. This starts no
      // model response and therefore incurs no inference/token usage. The first
      // submit joins this single-flight promise instead of paying cold setup.
      void createCurrentSession('reservation').catch((error) => {
        bootProfile('session:reservation-prewarm-failed', {
          error: error?.message || String(error),
        });
      });
      return id;
    },
    get provider() {
      return rt.route.provider;
    },
    get model() {
      return rt.route.model;
    },
    get effort() {
      return rt.route.effectiveEffort || rt.route.effort || rt.route.preset?.effort || null;
    },
    get fast() {
      return rt.route.fast === true;
    },
    get fastCapable() {
      return rt.route.fastCapable === true;
    },
    get effortOptions() {
      return rt.route.effortOptions || [];
    },
    get contextWindow() {
      return rt.session?.contextWindow || null;
    },
    get rawContextWindow() {
      return rt.session?.rawContextWindow || rt.session?.contextWindow || null;
    },
    get effectiveContextWindowPercent() {
      return rt.session?.effectiveContextWindowPercent || null;
    },
    get toolMode() {
      return rt.mode;
    },
    get autoClear() {
      return this.getAutoClear();
    },
    get systemShell() {
      return normalizeSystemShellConfig(rt.config.shell);
    },
    get searchRoute() {
      rt.searchRoute = normalizeSearchRouteConfig(rt.config.searchRoute) || normalizeSearchRouteConfig(rt.searchRoute);
      return rt.searchRoute;
    },
    get workflow() {
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
    get outputStyle() {
      return getOutputStyleStatusCached().current;
    },
    get cwd() {
      return rt.currentCwd;
    },
    get session() {
      return rt.session;
    },
    contextStatus() {
      // Prefer the in-flight working transcript while a turn is running so the
      // context gauge reflects LIVE growth (user turn + tool calls/results) as
      // it accumulates, instead of freezing at the pre-turn committed snapshot.
      // askSession() sets session.liveTurnMessages for the turn duration and
      // clears it on commit/cancel/error, after which we fall back to the
      // authoritative committed transcript.
      return computeContextStatus();
    },
    contextStatusForSession(session) {
      return computeContextStatusForSession(session);
    },
    renameSessionTitle(sessionId, title) {
      return mgr.updateSessionManualTitle(sessionId, title);
    },
    startRemote() {
      return startRemote();
    },
    stopRemote(reason) {
      return stopRemote(reason);
    },
    releaseRemote(reason) {
      return releaseRemote(reason);
    },
    isRemoteEnabled() {
      return isRemoteEnabled();
    },
    // Session-scoped remote: the owning session id (null when off/unassigned).
    getRemoteSessionId() {
      return rt.remoteSessionId;
    },
    // Back-compat alias for an explicit manual ON in the current session.
    claimRemoteForCurrentSession() {
      return startRemote();
    },
    // Subscribe to non-user-initiated remote flips (seat superseded). Returns
    // an unsubscribe function. TUI uses this to sync its Remote indicator and
    // show a "remote taken over" notice.
    onRemoteStateChange(listener) {
      if (typeof listener !== 'function') return () => {};
      remoteStateListeners.add(listener);
      return () => remoteStateListeners.delete(listener);
    },
    get clientHostPid() {
      return rt.session?.clientHostPid || process.pid;
    },
    ...lifecycleApi,
    ...resourceApi,
    ...modelRouteApi,
    ...workflowAgentsApi,
    ...sessionTurnApi,
  };
}
