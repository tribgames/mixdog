import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import httpMod from 'node:http';
import { ensureStandaloneEnvironment } from '../standalone/seeds.mjs';
import { createStandaloneAgent } from '../standalone/agent-tool.mjs';
import { isAgentOwner } from '../runtime/agent/orchestrator/agent-owner.mjs';
import { EXPLORE_TOOL, runExplore } from '../standalone/explore-tool.mjs';
import { createStandaloneChannelWorker } from '../standalone/channel-worker.mjs';
import { createStandaloneMemoryRuntime } from '../standalone/memory-runtime-proxy.mjs';
import { createStandaloneHookBus } from '../standalone/hook-bus.mjs';
import { writeLastSessionCwd } from '../runtime/shared/user-cwd.mjs';
import { cancelBackgroundTasks } from '../runtime/shared/background-tasks.mjs';
import { createTranscriptWriter } from '../runtime/shared/transcript-writer.mjs';
import { mixdogHome } from '../runtime/shared/plugin-paths.mjs';
import { checkLatestVersion, localPackageVersion, isDevInstall } from '../runtime/shared/update-checker.mjs';
import { spawnStagedInstall, runStagedInstall, isStagedComplete } from '../runtime/shared/staged-update.mjs';
import {
  modelVisibleToolCompletionMessage,
  shouldPersistModelVisibleToolCompletion,
} from '../runtime/shared/tool-execution-contract.mjs';
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
import { markCompletionEntry } from '../runtime/agent/orchestrator/session/manager/pending-messages.mjs';
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
import { fetchOAuthUsageSnapshot } from '../runtime/agent/orchestrator/providers/oauth-usage.mjs';
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
  forgetWebhookAuthtoken,
  setChannel,
  saveDiscordToken,
  saveTelegramToken,
  saveSchedule,
  saveWebhook,
  saveWebhookAuthtoken,
  setBackend,
  setBackendAsync,
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
  estimateMessagesTokens,
  estimateRequestReserveTokens,
  estimateTranscriptContextUsage,
  estimateToolSchemaTokens,
  resolveCompactBufferTokens,
  resolveCompactTriggerTokens,
  summarizeContextMessages,
} from '../runtime/agent/orchestrator/session/context-utils.mjs';

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
  saveModelSettings,
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
import { createMcpGlue } from './mcp-glue.mjs';
import { createCwdPlugins } from './cwd-plugins.mjs';
import { createSettingsApi } from './settings-api.mjs';
import { createProviderModels } from './provider-models.mjs';
import { createProviderUsage } from './provider-usage.mjs';
import { envFlag, envPresent, envDelayMs } from './env.mjs';
import { bootProfile, profiledImport } from './boot-profile.mjs';
import { createChannelConfigApi } from './channel-config-api.mjs';
import { createProviderAuthApi } from './provider-auth-api.mjs';
import { createContextStatus } from './context-status.mjs';
import { createLifecycleApi } from './lifecycle-api.mjs';
import { createResourceApi } from './resource-api.mjs';
import { createModelRouteApi } from './model-route-api.mjs';
import { createWorkflowAgentsApi } from './workflow-agents-api.mjs';
import { createSessionTurnApi } from './session-turn-api.mjs';
// Re-exported for external consumers (scripts/tool-smoke.mjs) that imported
// these from this module before the tool-defs extraction.
export { TOOL_SEARCH_TOOL, SKILL_TOOL };
// Back-compat test alias; delegates to the extracted helper.
export function __applyStandaloneToolDefaultsForTest(tool) {
  return applyStandaloneToolDefaults(tool);
}

const RUNTIME = '../runtime/agent/orchestrator';
const SEARCH_RUNTIME = '../runtime/search/index.mjs';
const SEARCH_TOOL_DEFS = '../runtime/search/tool-defs.mjs';
const MEMORY_TOOL_DEFS = '../runtime/memory/tool-defs.mjs';
const MEMORY_RUNTIME = '../runtime/memory/index.mjs';
const CHANNEL_TOOL_DEFS = '../runtime/channels/tool-defs.mjs';
const CHANNEL_WORKER_ENTRY = '../runtime/channels/index.mjs';
const CODE_GRAPH_TOOL_DEFS = '../runtime/agent/orchestrator/tools/code-graph-tool-defs.mjs';
const CODE_GRAPH_RUNTIME = '../runtime/agent/orchestrator/tools/code-graph.mjs';
const STATUSLINE_SESSION_ROUTES = '../vendor/statusline/src/gateway/session-routes.mjs';
const __dirname = dirname(fileURLToPath(import.meta.url));
// This module lives in src/session-runtime/, but the resource root must remain
// src/ (defaults/, rules/, runtime/, vendor/ live there), so climb one level.
const STANDALONE_SOURCE_ROOT = dirname(__dirname);
// Resource root stays at src/ because defaults/, rules/, runtime/, vendor/ live
// there. User-owned standalone state lives under MIXDOG_HOME (~/.mixdog).
const STANDALONE_ROOT = STANDALONE_SOURCE_ROOT;
const MIXDOG_HOME = process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
const STANDALONE_DATA_DIR = process.env.MIXDOG_DATA_DIR || join(MIXDOG_HOME, 'data');

const resolveDefaultProvider = makeResolveDefaultProvider(isKnownProvider);
const resolveRoute = makeResolveRoute(resolveDefaultProvider);
const searchCapableFor = makeSearchCapableFor(normalizeSearchProviderId, isSearchCapableProvider);

const outputStyleStatus = (dataDir = STANDALONE_DATA_DIR, opts = {}) => outputStyleStatusRaw(STANDALONE_ROOT, dataDir || STANDALONE_DATA_DIR, opts);
// Workflow/agent pack loaders bound to this runtime's root/data layout.
const {
  listWorkflowPacks,
  activeWorkflowId,
  loadWorkflowPack,
  workflowSummary,
  activeWorkflowSummary,
  loadAgentDefinition,
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

export function __renderToolSearchForTest(args = {}, session = {}, mode = 'full') {
  return renderToolSearch(args, session, mode);
}

export function __saveModelSettingsForTest(cfgMod, route, options = {}) {
  return saveModelSettings(cfgMod, route, options);
}

export async function createMixdogSessionRuntime({
  provider,
  model,
  cwd = process.cwd(),
  toolMode = 'full',
  remote = false,
} = {}) {
  bootProfile('session-runtime:start', { provider, model, toolMode, cwd });
  let remoteEnabled = remote === true;
  // Transient marker: an AUTO start (config/delayed autoStart) has forked the
  // worker to ATTEMPT a claim-if-vacant but has NOT asserted remote for this
  // session yet. remoteEnabled flips only if the worker reports it acquired the
  // seat (the 'acquired' notification). Lets the deferred start chain proceed
  // past its remoteEnabled guards without prematurely showing this session as
  // remote (single-holder: a live owner must not be stolen by autoStart).
  let remoteClaimPending = false;
  // Remote-mode transcript writer (Discord outbound). Lazily created per
  // session.id + cwd inside ask(); only active while remoteEnabled.
  let _transcriptWriter = null;
  let _twKey = '';
  // One-shot: an 'acquired' verdict (or other rebind trigger) landed before a
  // session/writer existed, so the rebind push could not fire. Set true when a
  // push is deferred; the next session-create / turn-start flushes it exactly
  // once so the daemon forwarder always ends bound to THIS session's transcript.
  let _pendingRebind = false;
  // Last assistant text handed to the transcript writer (via onAssistantText),
  // so the post-turn final-content append can skip an exact duplicate.
  let _lastAppendedAssistant = '';
  process.env.MIXDOG_QUIET_SESSION_LOG ??= '1';
  const standaloneStartedAt = performance.now();
  ensureStandaloneEnvironment({
    rootDir: STANDALONE_ROOT,
    dataDir: STANDALONE_DATA_DIR,
  });
  bootProfile('standalone-env:ready', { ms: (performance.now() - standaloneStartedAt).toFixed(1) });

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
  const memoryRuntime = createStandaloneMemoryRuntime({
    // Entry constants are module-relative ('../runtime/...'); resolve against
    // this module's dir, not STANDALONE_ROOT, or the 'src/' segment is lost.
    entry: join(__dirname, MEMORY_RUNTIME),
    dataDir: pluginDataDir,
    cwd,
  });
  let memoryModPromise = null;
  let searchModPromise = null;
  let codeGraphModPromise = null;

  // Memory module is always-on. `memoryEnabled()` is kept as a thin alias that
  // now always returns true (callers/compaction helpers still reference it);
  // the user-facing toggle is `recap` (background cycles only), read via
  // recapEnabled(config).
  const memoryEnabled = () => true;
  const recapEnabledFn = () => recapEnabled(config, true);
  const channelsEnabled = () => moduleEnabled(config, 'channels', true);

  async function getMemoryModule() {
    const startedAt = performance.now();
    memoryModPromise ??= Promise.resolve(memoryRuntime);
    const mod = await memoryModPromise;
    if (typeof mod?.init === 'function') {
      await mod.init();
    }
    bootProfile('memory-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  async function getSearchModule() {
    const startedAt = performance.now();
    searchModPromise ??= import(SEARCH_RUNTIME);
    const mod = await searchModPromise;
    bootProfile('search-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  async function getCodeGraphModule() {
    const startedAt = performance.now();
    codeGraphModPromise ??= import(CODE_GRAPH_RUNTIME);
    const mod = await codeGraphModPromise;
    bootProfile('code-graph-runtime:ready', { ms: (performance.now() - startedAt).toFixed(1) });
    return mod;
  }

  function persistLeadRoute(routeLike) {
    const leadRoute = normalizeWorkflowRoute(routeLike);
    if (!leadRoute) return null;

    const nextConfig = { ...(config || {}) };
    nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, 'lead', leadRoute);
    nextConfig.workflowRoutes = {
      ...(nextConfig.workflowRoutes || {}),
      lead: leadRoute,
    };
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
  let config = cfgMod.loadConfig({ secrets: false });
  setConfiguredShell(normalizeSystemShellConfig(config.shell).command);
  let configHasSecrets = false;
  let route = resolveRoute(config, { provider, model });
  let searchRoute = normalizeSearchRouteConfig(config.searchRoute);
  bootProfile('config:ready', { ms: (performance.now() - configStartedAt).toFixed(1) });
  let mode = normalizeToolMode(toolMode);
  let session = null;
  let sessionCreatePromise = null;
  let currentCwd = cwd;
  let sessionNeedsCwdRefresh = false;
  // session_manage tool: reset request scheduled by the model mid-turn,
  // consumed by the TUI engine at turn end ('clear' | 'compact_clear').
  let pendingSessionReset = null;
  let closeRequested = false;
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
  };
  const prewarmState = {
    codeGraphPrewarmInFlight: false,
    codeGraphPrewarmQueuedCwd: '',
    channelStartPromise: null,
  };
  let activeTurnCount = 0;
  let firstTurnCompleted = false;
  function hookTranscriptPath(sessionId) {
    const id = clean(sessionId);
    if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
    return join(dataDir, 'sessions', `${id}.json`);
  }
  function hookEffortPayload() {
    const level = clean(route.effectiveEffort || route.effort);
    return level ? { level: level.toLowerCase() } : undefined;
  }
  function hookCommonPayload(extra = {}) {
    const sid = clean(extra.session_id || extra.sessionId || session?.id);
    return {
      ...(sid ? { session_id: sid, transcript_path: hookTranscriptPath(sid) } : {}),
      cwd: currentCwd,
      permission_mode: session?.permissionMode || 'default',
      ...(hookEffortPayload() ? { effort: hookEffortPayload() } : {}),
      ...extra,
    };
  }
  const sessionPrewarmDelayMs = envDelayMs('MIXDOG_SESSION_PREWARM_DELAY_MS', 50, { min: 0, max: 10_000 });
  const providerSetupWarmupDelayMs = envDelayMs('MIXDOG_PROVIDER_SETUP_WARMUP_DELAY_MS', 300, { min: 0, max: 60_000 });
  const modelCatalogWarmupDelayMs = envDelayMs('MIXDOG_MODEL_CATALOG_WARMUP_DELAY_MS', 200, { min: 0, max: 60_000 });
  const providerWarmupDelayMs = envDelayMs('MIXDOG_PROVIDER_WARMUP_DELAY_MS', 1_500, { min: 0, max: 60_000 });
  // Background model-catalog prefetch delay. Kept short so the first `/model`
  // open finds a warm cache instead of paying a cold full network load. The
  // work is async + unref'd, so short-lived detached runtimes still exit
  // cleanly without waiting on it. Operators can raise it via env if a
  // detached runtime must avoid the /models round-trip entirely.
  const providerModelWarmupDelayMs = envDelayMs('MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS', 2_000, { min: 0, max: 120_000 });
  const codeGraphPrewarmDelayMs = envDelayMs('MIXDOG_CODE_GRAPH_PREWARM_DELAY_MS', 250, { min: 0, max: 60_000 });
  const statuslineUsageWarmupDelayMs = envDelayMs('MIXDOG_STATUSLINE_USAGE_WARMUP_DELAY_MS', 800, { min: 0, max: 60_000 });
  // Idle keep-alive: re-fetch usage before the statusline's 10-min staleness cut
  // (LIVE_USAGE_SNAPSHOT_MAX_AGE_MS) so the usage segment does not disappear
  // while the session sits idle with no turns to trigger a refresh.
  const statuslineUsageRefreshDelayMs = envDelayMs('MIXDOG_STATUSLINE_USAGE_REFRESH_MS', 240_000, { min: 30_000, max: 540_000 });
  const channelStartDelayMs = envDelayMs('MIXDOG_CHANNEL_START_DELAY_MS', 10_000, { min: 0, max: 120_000 });
  const backgroundBusyRetryMs = envDelayMs('MIXDOG_BACKGROUND_BUSY_RETRY_MS', 1_000, { min: 50, max: 10_000 });
  const sessionPrewarmEnabled = !envFlag('MIXDOG_DISABLE_SESSION_PREWARM')
    && (envFlag('MIXDOG_ENABLE_SESSION_PREWARM') || envPresent('MIXDOG_SESSION_PREWARM_DELAY_MS'));
  const providerWarmupEnabled = !envFlag('MIXDOG_DISABLE_PROVIDER_WARMUP')
    && (
      envFlag('MIXDOG_ENABLE_PROVIDER_WARMUP')
      || envFlag('MIXDOG_PROVIDER_WARMUP_BEFORE_FIRST_TURN')
      || envPresent('MIXDOG_PROVIDER_WARMUP_DELAY_MS')
      || envPresent('MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS')
    );
  // Boot-time model-catalog prefetch is intentionally decoupled from the
  // heavier providerWarmupEnabled gate (which stays opt-in for provider
  // *init* side effects). Fetching the model list in the background after a
  // short delay is cheap, fire-and-forget, and unref'd, so it is ON by
  // default — otherwise the FIRST `/model` open always paid a cold full
  // network load. Operators can still disable it explicitly.
  const modelPrefetchEnabled = !envFlag('MIXDOG_DISABLE_PROVIDER_WARMUP')
    && !envFlag('MIXDOG_DISABLE_MODEL_PREFETCH');
  const codeGraphPrewarmEnabled = !envFlag('MIXDOG_DISABLE_CODE_GRAPH_PREWARM');
  const modelCatalogWarmupEnabled = !envFlag('MIXDOG_DISABLE_MODEL_CATALOG_WARMUP');
  // Lazy code-graph prewarm (default ON): do NOT prewarm at startup / on cwd
  // change — that fired ~250ms after the first frame and, in a large tree,
  // burned a worker (and felt like a freeze) before the user did anything.
  // Instead prewarm ONCE on the first real turn, when a code lookup is actually
  // imminent. Operators who want the old eager behavior can set
  // MIXDOG_CODE_GRAPH_PREWARM_EAGER=1.
  const codeGraphPrewarmLazy = codeGraphPrewarmEnabled && !envFlag('MIXDOG_CODE_GRAPH_PREWARM_EAGER');
  let codeGraphFirstTurnPrewarmDone = false;
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
  let providerInitPromise = null;
  let lastProjectMcpKey = null;
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
    getConfig: () => config,
    getCurrentCwd: () => currentCwd,
    state: mcpState,
  });
  let preSessionToolSurface = null;
  const hooksStartedAt = performance.now();
  const hooks = createStandaloneHookBus({ dataDir: cfgMod.getPluginData() });
  hooks.emit('runtime:start', { cwd: currentCwd, provider: route.provider, model: route.model, toolMode: mode });
  bootProfile('hooks:ready', { ms: (performance.now() - hooksStartedAt).toFixed(1) });

  // ---------------------------------------------------------------------
  // Self-update (npm registry version check + optional auto-install).
  // updateCheckState mirrors the last-known checkLatestVersion() result;
  // updateProcessState tracks the in-flight install lifecycle so the TUI can
  // poll getUpdateStatus() instead of needing a push/event channel. Both are
  // purely in-memory (per runtime instance) — the on-disk cache lives inside
  // update-checker.mjs and is what actually enforces the 24h TTL.
  let updateCheckState = {
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
    lastCheckedAt: 0,
  };
  // phase: 'idle' | 'checking' | 'installing' | 'installed' | 'failed'
  let updateProcessState = { phase: 'idle', version: null, error: null };
  // Boot detects an available update and STAGES it in the background (a hidden,
  // detached npm install into ~/.mixdog/data/staging/<ver>). The staged package
  // is swapped into the global dir on the next clean launch (cli.mjs
  // pre-import), never while a session is live — so npm never overwrites the
  // .mjs files node currently holds (the old shutdown `npm install -g` did, and
  // caused Windows TAR_ENTRY_ERROR / ENOENT). The live-session refcount that a
  // concurrent launch consults to defer its swap is registered earlier, in
  // cli.mjs (pre-import), so this process is visible before any runtime loads.

  function autoUpdateEnabled() {
    return config?.update?.auto !== false;
  }

  async function checkForUpdateInternal({ force = false } = {}) {
    if (updateProcessState.phase !== 'installing') updateProcessState.phase = 'checking';
    try {
      const result = await checkLatestVersion({ force, dataDir: cfgMod.getPluginData?.() || STANDALONE_DATA_DIR });
      updateCheckState = {
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        updateAvailable: result.updateAvailable,
        lastCheckedAt: result.lastCheckedAt,
      };
    } catch {
      // checkLatestVersion() is already silent-safe; this catch is belt-and-
      // braces so a boot-time call can never crash the runtime.
    } finally {
      if (updateProcessState.phase === 'checking') updateProcessState.phase = 'idle';
    }
    return updateCheckState;
  }

  async function runUpdateNowInternal() {
    if (updateProcessState.phase === 'installing') {
      return { ...updateProcessState, alreadyInstalling: true, error: 'update already in progress' };
    }
    if (isDevInstall()) {
      updateProcessState = { phase: 'failed', version: null, error: 'dev install — update skipped' };
      return updateProcessState;
    }
    const ver = updateCheckState.latestVersion;
    if (!ver || !updateCheckState.updateAvailable) {
      updateProcessState = { phase: 'idle', version: null, error: null };
      return { ...updateProcessState, error: 'no update available' };
    }
    // "Update now" stages the new version (verified, self-contained) rather than
    // installing over the live global dir; the swap applies on the next launch.
    // phase 'installed' here means "staged & ready — restart to apply".
    updateProcessState = { phase: 'installing', version: ver, error: null };
    try {
      const result = await runStagedInstall(ver);
      if (result?.ok) {
        updateProcessState = { phase: 'installed', version: result.version || ver, error: null };
      } else {
        updateProcessState = { phase: 'failed', version: null, error: result?.error || 'update failed' };
      }
    } catch (err) {
      updateProcessState = { phase: 'failed', version: null, error: err?.message || String(err) };
    }
    return updateProcessState;
  }

  // Non-blocking boot hook: fires after the runtime object below is fully
  // constructed (setTimeout(0) defers past the synchronous return), so a
  // slow/hanging registry request can never delay session boot. The check
  // ALWAYS runs (populates updateCheckState for the maintenance picker), but
  // when an update is available it kicks off a hidden BACKGROUND staging
  // install (spawnStagedInstall) into ~/.mixdog/data/staging/<ver>. The actual
  // swap into the global dir happens on the next clean launch (cli.mjs
  // pre-import), so npm never overwrites files this live process holds.
  // force:true — always hit the registry at boot (the 24h disk cache went
  // stale-visible: it kept reporting an older "latest" than the installed
  // version). checkLatestVersion() still falls back to the cache offline.
  // isDevInstall() gate: a git checkout / clone (or non-node_modules install)
  // must never self-update — staging + swap would fight the working tree.
  const updateBootTimer = setTimeout(() => {
    void (async () => {
      await checkForUpdateInternal({ force: true });
      if (!(autoUpdateEnabled() && !isDevInstall() && updateCheckState.updateAvailable)) return;
      const ver = updateCheckState.latestVersion;
      if (!ver) return;
      // The notice fires ONLY once staging has completed (a ready-to-apply
      // package sits on disk) — never upfront — so the user sees no "update
      // available / installs on quit" nag while the background stage runs
      // silently. The wording lives in the notice surface (notification-plan):
      // this emit only carries meta.version. TUI maps meta.kind 'update-notice'
      // to a transcript notice, never a model-visible message; tone 'info' =
      // non-urgent, applies on the next launch.
      const announceReady = () => {
        emitRuntimeNotification('update ready', { kind: 'update-notice', version: ver, tone: 'info' });
      };
      // Already staged in a prior session → announce immediately.
      if (isStagedComplete(ver)) { announceReady(); return; }
      try { spawnStagedInstall(ver); } catch { /* best-effort background stage */ }
      // Poll for staging completion, then announce once. The interval is
      // unref'd so it never holds the process open, and gives up silently
      // after the cap — the next launch retries.
      const POLL_MS = 3_000;
      const MAX_MS = 10 * 60 * 1000;
      const startedAt = Date.now();
      const poll = setInterval(() => {
        if (isStagedComplete(ver)) {
          clearInterval(poll);
          announceReady();
        } else if (Date.now() - startedAt > MAX_MS) {
          clearInterval(poll);
        }
      }, POLL_MS);
      poll.unref?.();
    })().catch(() => {});
  }, 0);
  updateBootTimer.unref?.();

  function emitRuntimeNotification(content, meta = {}) {
    const text = String(content || '').trim();
    if (!text) return false;
    const event = { content: text, meta: meta && typeof meta === 'object' ? meta : {} };
    let handled = false;
    for (const listener of [...notificationListeners]) {
      try {
        if (listener(event) === true) handled = true;
      } catch {}
    }
    return handled;
  }

  function notifyFnForSession(callerSessionId) {
    return (text, meta = {}) => {
      const handledByRuntimeListener = emitRuntimeNotification(text, meta);
      let enqueued = false;
      // TUI sessions consume raw execution notifications for UI/task cards via
      // onNotification, but those raw envelopes are internal-only in pending
      // drain. Always mirror terminal completions with a model-visible wrapper
      // while keeping the raw text for UI display.
      if (callerSessionId && typeof mgr.enqueuePendingMessage === 'function'
        && shouldPersistModelVisibleToolCompletion(text, meta)) {
        try {
          const visible = modelVisibleToolCompletionMessage(text, meta);
          // Terminal completion (gated by shouldPersistModelVisibleToolCompletion)
          // → tag so drain discards it on resume rather than replaying out-of-order.
          if (visible) enqueued = mgr.enqueuePendingMessage(callerSessionId, markCompletionEntry(visible)) > 0;
        } catch {}
      }
      // Headless/API listeners may exist but not consume the event; preserve
      // the old fallback for non-terminal notifications only when unhandled.
      if (!enqueued && !handledByRuntimeListener && callerSessionId
        && typeof mgr.enqueuePendingMessage === 'function') {
        try {
          const visible = modelVisibleToolCompletionMessage(text, meta);
          // modelVisibleToolCompletionMessage only returns non-empty for a
          // persistable terminal completion, so this fallback is a completion
          // too → tag it (genuine non-completion notifications yield '' above).
          if (visible) enqueued = mgr.enqueuePendingMessage(callerSessionId, markCompletionEntry(visible)) > 0;
        } catch {}
      }
      return enqueued || handledByRuntimeListener;
    };
  }

  function skillsStatus() {
    const skills = typeof contextMod.collectSkillsCached === 'function'
      ? contextMod.collectSkillsCached(currentCwd)
      : [];
    const norm = (value) => String(value || '').replace(/\\/g, '/').toLowerCase();
    const cwdNorm = norm(currentCwd);
    const sourceForSkill = (filePath) => {
      const path = norm(filePath);
      if (cwdNorm && path.startsWith(`${cwdNorm}/.mixdog/skills/`)) return 'project';
      return 'skill';
    };
    return {
      cwd: currentCwd,
      count: skills.length,
      skills: skills.map((skill) => ({
        name: skill.name,
        description: skill.description || '',
        filePath: skill.filePath || null,
        source: sourceForSkill(skill.filePath),
      })),
    };
  }

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
    getCurrentCwd: () => currentCwd,
    setCurrentCwd: (next) => { currentCwd = next; },
    getConfig: () => config,
    getSession: () => session,
    getRoute: () => route,
    getLastProjectMcpKey: () => lastProjectMcpKey,
    setLastProjectMcpKey: (next) => { lastProjectMcpKey = next; },
    isCodeGraphPrewarmLazy: () => codeGraphPrewarmLazy,
    isCodeGraphFirstTurnPrewarmDone: () => codeGraphFirstTurnPrewarmDone,
    getCodeGraphPrewarmDelayMs: () => codeGraphPrewarmDelayMs,
    setSessionNeedsCwdRefresh: (next) => { sessionNeedsCwdRefresh = next; },
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

  function skillContent(name) {
    const res = typeof contextMod.loadSkillResource === 'function'
      ? contextMod.loadSkillResource(name, currentCwd)
      : null;
    if (!res) throw new Error(`skill not found: ${name}`);
    return { name, content: res.content, dir: res.dir };
  }

  function skillToolContent(name) {
    if (typeof contextMod.isSkillDisabled === 'function' && contextMod.isSkillDisabled(name)) {
      const label = String(name || '').trim() || 'skill';
      return `Error: skill "${label}" is disabled`;
    }
    const skill = skillContent(name);
    // Return the general tool envelope so the main/Lead session behaves the
    // same as agent-loop sessions: the model-visible tool_result is the short
    // stub (`Loaded skill: <name>`) and the full SKILL.md body is delivered
    // ONCE as a separate injected role:'user' message (newMessages). The
    // envelope passes through internal-tools._normalize untouched (it preserves
    // __toolEnvelope objects), and the agent loop's central normalizeToolEnvelope
    // splits it into stub + injected user body.
    return contextMod.buildSkillToolEnvelope(skill.name, skill.content, skill.dir);
  }

  function addProjectSkill(input = {}) {
    const name = clean(input.name).replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!name) throw new Error('skill name is required');
    const dir = join(currentCwd, '.mixdog', 'skills', name);
    const filePath = join(dir, 'SKILL.md');
    if (existsSync(filePath)) throw new Error(`skill already exists: ${name}`);
    const description = clean(input.description) || 'Project skill.';
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, [
      '---',
      `name: ${name}`,
      `description: ${description}`,
      '---',
      '',
      '# Instructions',
      '',
      'Describe when and how to use this skill.',
      '',
    ].join('\n'), 'utf8');
    return { name, filePath };
  }

  const agentToolStartedAt = performance.now();
  const agentTool = createStandaloneAgent({
    cfgMod,
    reg,
    mgr,
    dataDir: cfgMod.getPluginData(),
    cwd,
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
      const status = agentTool.getStatus?.({ clientHostPid: session?.clientHostPid || process.pid }) || {};
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
    entry: join(__dirname, CHANNEL_WORKER_ENTRY),
    rootDir: STANDALONE_ROOT,
    dataDir: cfgMod.getPluginData(),
    cwd,
    onNotify: (msg) => {
      // Single-holder remote: the worker reports it lost the bridge seat to a
      // newer remote session. Drop remote mode entirely on this session (no
      // handover, no retry) and tell UI listeners so the indicator updates.
      if (msg?.method === 'notifications/mixdog/remote') {
        // Any acquire/supersede verdict resolves an in-flight auto claim attempt.
        remoteClaimPending = false;
        if (msg?.params?.state === 'superseded' && remoteEnabled) {
          stopRemote('superseded-by-newer-remote-session');
          emitRemoteStateChange(false, 'superseded');
        }
        // Symmetric acquire: the worker took the bridge seat (boot make-before-
        // break or activate). Flip remote ON via the same side-state a user
        // /remote toggles — remoteEnabled + transcript writer — but WITHOUT
        // re-invoking channel start (the worker is already running; startRemote
        // would re-fork/activate). Idempotent: no-op when already enabled.
        if (msg?.params?.state === 'acquired' && !remoteEnabled) {
          remoteEnabled = true;
          ensureRemoteTranscriptWriter();
          // Auto-acquire: the worker restored yesterday's transcript from
          // persisted status and we just created the CURRENT writer. Push the
          // repoint now instead of waiting for the next inbound parent-chain
          // steal, so outbound forwarding never tails a stale transcript.
          pushTranscriptRebind();
          emitRemoteStateChange(true, 'acquired');
        }
        return;
      }
      if (msg?.method !== 'notifications/claude/channel') return;
      const params = msg?.params && typeof msg.params === 'object' ? msg.params : {};
      const meta = params.meta && typeof params.meta === 'object' ? params.meta : {};
      const content = channelNotificationModelContent(params);
      if (!content) return;
      const handled = emitRuntimeNotification(content, meta);
      if (!handled && session?.id && shouldMirrorChannelNotificationToPending(meta)) {
        try { mgr.enqueuePendingMessage(session.id, content); } catch {}
      }
    },
  });
  bootProfile('channels:worker-ready', { ms: (performance.now() - channelsStartedAt).toFixed(1) });
  const toolsStartedAt = performance.now();
  const standaloneTools = [
    TOOL_SEARCH_TOOL,
    SKILL_TOOL,
    CWD_TOOL,
    SESSION_MANAGE_TOOL,
    EXPLORE_TOOL,
    ...(searchToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'search' || tool?.name === 'web_fetch'),
    ...(memoryToolDefs?.TOOL_DEFS || []).filter((tool) => tool?.name === 'recall' || tool?.name === 'memory'),
    ...(channelToolDefs?.TOOL_DEFS || []).filter((tool) => channels.isChannelTool(tool?.name)),
    ...(codeGraphToolDefs?.CODE_GRAPH_TOOL_DEFS || []).filter((tool) => tool?.name === 'code_graph'),
    ...agentTool.tools,
  ].map(applyStandaloneToolDefaults);
  bootProfile('tools:ready', { ms: (performance.now() - toolsStartedAt).toFixed(1), count: standaloneTools.length });

  function invalidatePreSessionToolSurface() {
    preSessionToolSurface = null;
  }

  const { contextStatus: computeContextStatus, invalidateContextStatusCache } = createContextStatus({
    getSession: () => session,
    getRoute: () => route,
    getCurrentCwd: () => currentCwd,
    getMode: () => mode,
  });

  function buildPreSessionToolSurface() {
    const previewTools = typeof mgr.previewSessionTools === 'function'
      ? mgr.previewSessionTools(toolSpecForMode(mode), [])
      : [];
    const tools = filterDisallowedTools(previewTools, LEAD_DISALLOWED_TOOLS);
    const surface = { tools: Array.isArray(tools) ? tools.slice() : [] };
    applyDeferredToolSurface(surface, deferredSurfaceModeForLead(mode), standaloneTools, { provider: route.provider });
    return surface;
  }

  function activeToolSurface() {
    if (session) return session;
    preSessionToolSurface ??= buildPreSessionToolSurface();
    return preSessionToolSurface;
  }

  function applyPreSessionToolSelection() {
    if (!session || !preSessionToolSurface) return;
    const selected = Array.isArray(preSessionToolSurface.deferredSelectedTools)
      ? preSessionToolSurface.deferredSelectedTools
      : [];
    const discovered = Array.isArray(preSessionToolSurface.deferredDiscoveredTools)
      ? preSessionToolSurface.deferredDiscoveredTools
      : [];
    const replay = [...new Set([...selected, ...discovered])];
    if (replay.length) selectDeferredTools(session, replay, deferredSurfaceModeForLead(mode));
  }
  internalTools.setInternalToolsProvider({
    tools: standaloneTools,
    executor: async (name, args, callerCtx = {}) => {
      const callerCwd = callerCtx?.callerCwd || currentCwd;
      if (name === 'search' || name === 'web_fetch') {
        const callerSessionId = callerCtx?.callerSessionId || session?.id || null;
        const searchMod = await getSearchModule();
        if (!searchMod?.handleToolCall) throw new Error('search runtime is not available');
        return await searchMod.handleToolCall(name, args || {}, {
          callerCwd,
          callerSessionId,
          routingSessionId: callerSessionId,
          clientHostPid: callerCtx?.clientHostPid || session?.clientHostPid || process.pid,
          notifyFn: notifyFnForSession(callerSessionId),
          nativeSearch: name === 'search'
            ? async (searchArgs) => runNativeWebSearch(searchArgs, { signal: callerCtx?.signal || session?.controller?.signal })
            : undefined,
        });
      }
      if (name === 'recall' || name === 'memory' || name === 'search_memories') {
        const memoryMod = await getMemoryModule();
        if (!memoryMod?.handleToolCall) throw new Error('memory runtime is not available');
        return await memoryMod.handleToolCall(name, args || {});
      }
      if (name === 'code_graph') {
        const codeGraphMod = await getCodeGraphModule();
        if (!codeGraphMod?.executeCodeGraphTool) throw new Error('code_graph runtime is not available');
        return await codeGraphMod.executeCodeGraphTool(name, args || {}, args?.cwd || callerCwd);
      }
      if (name === 'tool_search' || name === 'load_tool') {
        return renderToolSearch(args, activeToolSurface(), mode, { mcpStatus });
      }
      if (name === 'explore') {
        const callerSessionId = callerCtx?.callerSessionId || session?.id || null;
        return await runExplore(args || {}, {
          callerCwd: args?.cwd ? resolveCwdPath(args.cwd) : callerCwd,
          callerSessionId,
          routingSessionId: callerSessionId,
          clientHostPid: callerCtx?.clientHostPid || session?.clientHostPid || process.pid,
          notifyFn: notifyFnForSession(callerSessionId),
        });
      }
      if (name === 'cwd') {
        const action = clean(args?.action || (args?.path ? 'set' : 'get')).toLowerCase();
        if (action === 'set') {
          applyResolvedCwd(resolveCwdPath(args?.path));
        } else if (action !== 'get') {
          throw new Error(`cwd: unknown action "${action}"`);
        }
        return JSON.stringify({ cwd: currentCwd, sessionId: session?.id || null }, null, 2);
      }
      if (name === 'session_manage') {
        // Lead/owner sessions only: an agent worker resetting its own
        // transcript mid-task would corrupt the delegation contract, and it
        // must never reach the owner conversation either.
        const callerSessionId = callerCtx?.callerSessionId || null;
        if (callerSessionId && session?.id && callerSessionId !== session.id) {
          throw new Error('session_manage: only the lead session may reset the conversation');
        }
        if (!session?.id) throw new Error('session_manage: no active session');
        const action = clean(args?.action).toLowerCase();
        if (action !== 'clear' && action !== 'compact_clear') {
          throw new Error(`session_manage: unknown action "${action}" (use clear | compact_clear)`);
        }
        // Never clear mid-turn — the loop is still reading the transcript.
        // Schedule and let the TUI engine consume it at turn end (same
        // boundary the idle auto-clear uses).
        // Pin to the current session id so a resume/new-session between
        // scheduling and consumption can never clear the wrong conversation.
        pendingSessionReset = { action, sessionId: session.id };
        return action === 'clear'
          ? 'Session reset scheduled: full clear will run when this turn ends. All prior context will be gone.'
          : 'Session reset scheduled: the conversation will be summarized (compact) and cleared when this turn ends; key context carries forward in the summary.';
      }
      if (name === 'Skill') {
        return skillToolContent(args?.name);
      }
      if (name === 'agent') {
        const callerSessionId = callerCtx?.callerSessionId || session?.id || null;
        return await agentTool.execute(args, {
          callerCwd,
          invocationSource: 'model-tool',
          callerSessionId,
          clientHostPid: callerCtx?.clientHostPid || session?.clientHostPid || process.pid,
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
  try { lastProjectMcpKey = resolve(currentCwd) + '\u0000' + JSON.stringify(readProjectMcpServers(currentCwd)); } catch { lastProjectMcpKey = null; }
  void connectConfiguredMcp()
    .then((status) => bootProfile('mcp:ready', {
      connected: Number(status?.connectedCount || 0),
      failed: Number(status?.failedCount || 0),
    }))
    .catch((error) => bootProfile('mcp:failed', { error: error?.message || String(error) }));

  function reloadChannelsSoon() {
    channels.execute('reload_config', {}).catch(() => {});
  }

  function invalidateProviderCaches() {
    providerModelCaches.providerModelsCache = { models: null, at: 0 };
    providerModelCaches.providerModelsPromise = null;
    providerModelCaches.providerModelsLoadSeq += 1;
    providerModelCaches.searchProviderModelsCache = { models: null, at: 0 };
    providerUsageCaches.usageDashboardCache = { dashboard: null, at: 0 };
    providerUsageCaches.usageDashboardPromise = null;
    providerUsageCaches.providerSetupCache = { setup: null, at: 0 };
    providerUsageCaches.providerSetupQuickCache = { setup: null, at: 0 };
    providerUsageCaches.providerSetupPromise = null;
    providerInitPromise = null;
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
    flushBackendSave,
    scheduleBackendSave,
    scheduleSkillsSave,
    flushSkillsSave,
    flushOutputStyleSave,
    scheduleOutputStyleSave,
    reloadFullConfig,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
  } = createConfigLifecycle({
    getConfig: () => config,
    setConfig: (next) => { config = next; },
    getSearchRoute: () => searchRoute,
    setSearchRoute: (next) => { searchRoute = next; },
    getConfigHasSecrets: () => configHasSecrets,
    setConfigHasSecrets: (next) => { configHasSecrets = next; },
    getRoute: () => route,
    cfgMod,
    sharedCfgMod,
    setBackend,
    setBackendAsync,
    setConfiguredShell,
    normalizeSystemShellConfig,
    normalizeSearchRouteConfig,
    outputStyleStatus,
    LAZY_SECRET_PROVIDERS,
    clean,
    resolve,
    STANDALONE_DATA_DIR,
  });

  async function ensureProvidersReady(providerConfig = config.providers || {}) {
    if (providerInitPromise) return await providerInitPromise;
    providerInitPromise = reg.initProviders(providerConfig)
      .finally(() => {
        providerInitPromise = null;
      });
    return await providerInitPromise;
  }

  const {
    currentMainSearchModelMeta,
    runNativeWebSearch,
  } = createNativeSearch({
    getRoute: () => route,
    getSearchRoute: () => searchRoute,
    setSearchRoute: (next) => { searchRoute = next; },
    getConfig: () => config,
    getSession: () => session,
    getReg: () => reg,
    ensureFullConfig,
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
  let scheduleProviderSetupWarmupRef = () => {};
  const {
    refreshStatuslineUsageSnapshot,
    cachedProviderSetup,
    getUsageDashboard,
  } = createProviderUsage({
    caches: providerUsageCaches,
    getConfig: () => config,
    getReg: () => reg,
    displayConfig,
    providerSetup,
    createUsageDashboard,
    fetchOAuthUsageSnapshot,
    isCloseRequested: () => closeRequested,
    getProviderSetupWarmupTimer: () => warmupTimers.providerSetupWarmupTimer,
    scheduleProviderSetupWarmup: (delayMs) => scheduleProviderSetupWarmupRef(delayMs),
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
  let scheduleProviderModelWarmupRef = () => {};
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
    getRoute: () => route,
    getConfig: () => config,
    getReg: () => reg,
    searchCapableFor,
    sortProviderModelsRaw,
    providerModelCacheRowRaw,
    normalizeSearchProviderId,
    isSearchCapableProvider,
    ensureFullConfig,
    ensureProvidersReady,
    bootProfile,
    scheduleProviderModelWarmup: () => scheduleProviderModelWarmupRef(),
    quickHelpers: providerModelQuickHelpers,
  });

  const {
    quickProviderModelRows,
    addDefaultSearchModel,
    quickSearchProviderModelRows,
    searchModelsFromRows,
    searchRowsWithDefault,
  } = createQuickModelRows({
    getRoute: () => route,
    getSearchRoute: () => searchRoute,
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

  async function resolveMissingRouteModelForFirstTurn() {
    if (routeHasModel()) return route;
    const models = await collectProviderModels();
    const picked = models[0] || null;
    if (!picked) {
      throw new Error('No provider models available. Open /providers to sign in, then /model to choose a model.');
    }
    route = {
      ...route,
      provider: picked.provider,
      model: picked.id,
      preset: null,
    };
    return route;
  }

  async function refreshRouteEffort(modelMetaOverride = null) {
    await ensureProvidersReady(ensureProviderEnabled(config, route.provider));
    const modelMeta = modelMetaOverride || await lookupModelMeta(route.provider, route.model);
    const requested = hasOwn(route, 'effort') ? route.effort : (route.preset?.effort || null);
    const effectiveEffort = coerceEffortFor(route.provider, modelMeta, requested);
    const fastCapable = fastCapableFor(route.provider, modelMeta);
    // Carry the catalog display name onto the route so the statusline shows a
    // human label (e.g. "Claude Fable 5") for preset-less direct models instead
    // of the raw id. `name` is only trusted when it differs from the raw model
    // id (some providers echo the id as `name`), so it can't clobber a better
    // already-resolved label. Falls back to existing route.modelDisplay, then unset.
    const metaName = clean(modelMeta?.name);
    const modelDisplay = clean(modelMeta?.display) || clean(modelMeta?.displayName)
      || (metaName && metaName !== clean(route.model) ? metaName : '')
      || clean(route.modelDisplay);
    route = {
      ...route,
      fast: fastCapable ? route.fast === true : false,
      fastCapable,
      effectiveEffort,
      effortOptions: effortItemsFor(route.provider, modelMeta, effectiveEffort),
      ...(modelDisplay ? { modelDisplay } : {}),
    };
    return route;
  }

  function routeHasModel() {
    return !!clean(route?.model);
  }

  function requireModelRoute() {
    if (routeHasModel()) return;
    throw new Error('No model configured. Open /providers to sign in, then /model to choose a model.');
  }

  async function recreateCurrentSessionIfReady() {
    if (!routeHasModel()) {
      session = null;
      return null;
    }
    return await createCurrentSession();
  }

  async function createCurrentSession(reason = 'demand') {
    if (sessionCreatePromise) return await sessionCreatePromise;
    if (session?.id && !sessionNeedsCwdRefresh) {
      const liveSession = mgr.getSession(session.id);
      if (liveSession && liveSession.closed !== true && liveSession.status !== 'closed') {
        session = liveSession;
        return session;
      }
      session = null;
    }

    const startedAt = performance.now();
    bootProfile('session:create:start', { mode, reason });
    const promise = (async () => {
      ensureConfigForRouteProvider();
      await resolveMissingRouteModelForFirstTurn();
      requireModelRoute();
      bootProfile('session:create:route-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      // refreshRouteEffort (effort/model-meta) and loadCoreMemoryContext (memory
      // files) are independent — refreshRouteEffort only touches route effort/
      // display fields, never provider/model that the memory load reads — so run
      // them concurrently instead of serially on the boot path.
      const [, coreMemoryContext] = await Promise.all([
        refreshRouteEffort(),
        loadCoreMemoryContext(),
      ]);
      bootProfile('session:create:effort-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      const providerImpl = reg.getProvider(route.provider);
      if (!providerImpl) {
        throw new Error(`Provider "${route.provider}" is not configured.`);
      }
      bootProfile('session:create:provider-ready', { ms: (performance.now() - startedAt).toFixed(1) });
      if (closeRequested) throw new Error('runtime is closing');
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      // Load the active WORKFLOW.md pack once for both summary + context block.
      const { summary: workflow, context: workflowContext } = activeWorkflowContext(config, dataDir);
      const sessionOpts = {
        provider: route.provider,
        model: route.model,
        preset: route.preset || undefined,
        tools: toolSpecForMode(mode),
        owner: 'cli',
        agent: 'lead',
        lane: 'cli',
        sourceType: 'lead',
        sourceName: 'main',
        clientHostPid: process.pid,
        disallowedTools: LEAD_DISALLOWED_TOOLS,
        cwd: currentCwd,
        coreMemoryContext,
        workflow,
        workflowContext,
        fast: route.fast === true,
        compaction: config.compaction && typeof config.compaction === 'object'
          ? normalizeCompactionConfig(config.compaction, { memoryEnabled: memoryEnabled() })
          : undefined,
      };
      if (hasOwn(route, 'effort') || route.effectiveEffort) {
        sessionOpts.effort = route.effectiveEffort || null;
      }
      session = mgr.createSession(sessionOpts);
      sessionNeedsCwdRefresh = false;
      attachSessionHooks(session, { hooks, hookCommonPayload, getCwd: () => currentCwd });
      // Every-create MCP fold (NO blocking): seed the INITIAL deferred surface +
      // BP1 manifest from whatever MCP servers are ALREADY connected at create
      // time. There is no await — a boot connect still mid-handshake is caught on
      // the first user turn by refreshInitialDeferredMcpSurface (session-turn-api),
      // which re-folds the live registry into the initial manifest before the
      // prompt renders. This fold keeps recreate paths (cwd change with MCP
      // already connected) seeding their manifest instead of re-announcing late.
      let connectedMcpTools = [];
      try { connectedMcpTools = mcpClient.getMcpTools?.() || []; }
      catch { connectedMcpTools = []; }
      applyDeferredToolSurface(
        session,
        deferredSurfaceModeForLead(mode),
        connectedMcpTools.length ? [...standaloneTools, ...connectedMcpTools] : standaloneTools,
        { provider: route.provider },
      );
      // Session-local one-shot: mark this FRESH session eligible for the
      // first-turn deferred-surface refresh (session-turn-api). A resumed
      // session (prior transcript) is NEVER marked, so its already-baked BP1 is
      // never rebuilt or re-announced — the gate is per-session, not the
      // process-wide firstTurnCompleted.
      session.deferredInitialRefreshPending = !/resume/i.test(String(reason || ''));
      applyPreSessionToolSelection();
      writeStatuslineRoute(statusRoutes, session, route);
      hooks.emit('session:create', { sessionId: session.id, provider: route.provider, model: route.model, toolMode: mode, cwd: currentCwd });
      // SessionStart: bridge to the standard project hook bus. Best-effort;
      // a hook error must never break session creation. additionalContext is
      // injected before the first user turn as a system-reminder context pair.
      try {
        const startSource = /resume/i.test(String(reason || ''))
          ? 'resume'
          : (/clear/i.test(String(reason || '')) ? 'clear' : 'startup');
        const startDispatch = await hooks.dispatch('SessionStart', hookCommonPayload({ session_id: session.id, source: startSource, model: route.model }));
        const startContext = Array.isArray(startDispatch?.additionalContext)
          ? startDispatch.additionalContext.join('\n\n')
          : String(startDispatch?.additionalContext || '');
        if (startContext.trim()) {
          session.messages.push({ role: 'user', content: `<system-reminder>\n# SessionStart Hook Context\n${startContext.trim()}\n</system-reminder>` });
          session.messages.push({ role: 'assistant', content: '.' });
          session.updatedAt = Date.now();
        }
      } catch { /* best-effort: never break session create */ }
      bootProfile('session:create:ready', {
        ms: (performance.now() - startedAt).toFixed(1),
        reason,
        tools: Array.isArray(session.tools) ? session.tools.length : 0,
        catalog: Array.isArray(session.deferredToolCatalog) ? session.deferredToolCatalog.length : 0,
      });
      // A rebind push may have been deferred (e.g. 'acquired' landed before this
      // session existed). The writer is now bindable — flush it exactly once.
      flushPendingTranscriptRebind();
      return session;
    })();

    sessionCreatePromise = promise;
    try {
      return await promise;
    } finally {
      if (sessionCreatePromise === promise) sessionCreatePromise = null;
    }
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
    getRoute: () => route,
    getConfig: () => config,
    isCloseRequested: () => closeRequested,
    getActiveTurnCount: () => activeTurnCount,
    getSessionCreatePromise: () => sessionCreatePromise,
    getProviderModelsCache: () => providerModelCaches.providerModelsCache,
    getProviderModelsPromise: () => providerModelCaches.providerModelsPromise,
    reloadFullConfig,
    ensureConfigForRouteProvider,
    ensureProvidersReady,
    ensureProviderEnabled,
    refreshStatuslineUsageSnapshot,
    warmProviderModelCache,
    cachedProviderSetup,
    warmCatalogsInBackground,
    isFirstTurnCompleted: () => firstTurnCompleted,
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
  scheduleProviderModelWarmupRef = scheduleProviderModelWarmup;
  scheduleProviderSetupWarmupRef = scheduleProviderSetupWarmup;

  const {
    scheduleCodeGraphPrewarm,
    scheduleLeadSessionPrewarm,
    invokeChannelStart,
    scheduleChannelStart,
  } = createPrewarmSchedulers({
    timers: prewarmTimers,
    bootProfile,
    getCurrentCwd: () => currentCwd,
    isCloseRequested: () => closeRequested,
    getActiveTurnCount: () => activeTurnCount,
    getSessionCreatePromise: () => sessionCreatePromise,
    getSession: () => session,
    isRemoteEnabled: () => remoteEnabled,
    channelsEnabled,
    getCodeGraphModule,
    createCurrentSession,
    channels,
    envFlag,
    delays: {
      codeGraphPrewarmDelayMs,
      channelStartDelayMs,
      sessionPrewarmDelayMs,
      backgroundBusyRetryMs,
    },
    flags: {
      codeGraphPrewarmEnabled,
      sessionPrewarmEnabled,
    },
    state: prewarmState,
  });

  // Eagerly create/refresh the remote transcript writer for the CURRENT
  // session + cwd, publish the session record, and ensure the transcript
  // file exists on disk. Called from startRemote() (so the channel worker's
  // activate-time discovery finds THIS session immediately instead of
  // waiting for the first turn) and from ask() at turn start. Returns true
  // when a writer is bound.
  function ensureRemoteTranscriptWriter() {
    if (!remoteEnabled || !session?.id) return false;
    const twKey = `${session.id}\u0000${currentCwd}`;
    if (_twKey !== twKey) {
      try {
        _transcriptWriter = createTranscriptWriter({
          mixdogHome: mixdogHome(),
          sessionId: session.id,
          cwd: currentCwd,
          pid: process.pid,
        });
        _transcriptWriter.writeSessionRecord();
        _twKey = twKey;
      } catch (error) {
        process.stderr.write(`mixdog: transcript-writer: init failed: ${error?.message || error}\n`);
        _transcriptWriter = null;
        _twKey = '';
        return false;
      }
    } else {
      // Same binding — refresh updatedAt so worker-side discovery keeps
      // ranking this session as the live parent-chain candidate.
      try { _transcriptWriter?.writeSessionRecord(); } catch {}
    }
    try { _transcriptWriter?.ensureTranscriptFile(); }
    catch (error) { process.stderr.write(`mixdog: transcript-writer: ensureTranscriptFile failed: ${error?.message || error}\n`); }
    return _transcriptWriter != null;
  }

  // Push the CURRENT transcript path to the channel worker so outbound
  // forwarding repoints immediately at the moments the binding can go stale
  // (auto-acquire, newSession/resume, clear) instead of waiting for the next
  // inbound parent-chain steal. Best-effort: ensures the writer, then fires
  // the dedicated idempotent worker op — a missing/not-ready worker or a bind
  // failure must never throw into the lead paths that call this.
  function pushTranscriptRebind() {
    if (!remoteEnabled) return;
    // Writer not bindable yet (e.g. 'acquired' before the session exists in
    // lazy mode): defer instead of silently dropping the push. flushPending-
    // TranscriptRebind() re-fires this exactly once when the writer is ready.
    if (!ensureRemoteTranscriptWriter()) { _pendingRebind = true; return; }
    const transcriptPath = _transcriptWriter?.transcriptPath;
    if (!transcriptPath || !channelsEnabled()) { _pendingRebind = true; return; }
    _pendingRebind = false;
    executeTranscriptRebind(transcriptPath, 1);
  }

  // Fire the idempotent worker op with bounded retry. A rejected/throwing
  // channels.execute retries a few times with short backoff; the final failure
  // surfaces one stderr line (not only the env-gated bootProfile) so a lost
  // rebind is diagnosable by default. Best-effort throughout — never throws
  // into the lead paths that call pushTranscriptRebind().
  function executeTranscriptRebind(transcriptPath, attempt) {
    const maxAttempts = 3;
    const onError = (error) => {
      const detail = error?.message || String(error);
      bootProfile('channels:rebind-push-failed', { attempt, error: detail });
      if (attempt < maxAttempts && remoteEnabled && !closeRequested) {
        const timer = setTimeout(() => {
          // Abort the retry chain silently if remote was dropped or the writer
          // moved on (supersede→re-acquire, newSession/clear): re-firing the
          // captured path would rebind forwarding back to a stale transcript.
          if (!remoteEnabled || !channelsEnabled()) return;
          if (_transcriptWriter?.transcriptPath !== transcriptPath) return;
          executeTranscriptRebind(transcriptPath, attempt + 1);
        }, 150 * attempt);
        timer.unref?.();
      } else {
        process.stderr.write(`mixdog: channels: rebind_current_transcript failed after ${attempt} attempt(s): ${detail}\n`);
      }
    };
    try {
      void channels.execute('rebind_current_transcript', { transcriptPath }).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  // Re-fire a deferred rebind exactly once, after a session/writer becomes
  // available (session create or turn start). No-op unless a push was deferred,
  // so no unconditional rebind fires per turn for already-bound sessions.
  function flushPendingTranscriptRebind() {
    if (!_pendingRebind || !remoteEnabled) return;
    pushTranscriptRebind();
  }

  // Remote (Discord channel) mode is opt-in per session. Only a session that
  // explicitly enables remote — via `mixdog --remote` or the runtime toggle —
  // boots the channel worker and contends for channel ownership.
  // startRemote() is FORCE-TAKEOVER: it always (re)claims the bridge seat and
  // rebinds output forwarding to this session, even when the worker is
  // already running (e.g. `/remote` re-issued after another session took the
  // seat, or to re-pin forwarding onto the current transcript).
  function startRemote(options = {}) {
    const intent = options?.intent === 'auto' ? 'auto' : 'explicit';
    // Claim intent reaches the worker's boot claim via MIXDOG_REMOTE_INTENT
    // (last-wins for explicit, claim-if-vacant for auto). It is set transiently
    // around the worker fork below (see invokeChannelStart) and restored right
    // after — NOT here on the shared process.env — so unrelated children forked
    // during the boot window never inherit a stale intent.
    if (intent === 'auto') {
      // Auto-start (config/delayed): do NOT flip this session to remote up
      // front. Boot the worker to ATTEMPT a claim-if-vacant; remoteEnabled is
      // set only when the worker reports it actually acquired the seat (the
      // 'acquired' notification). A live owner already holding the seat makes
      // the worker back off silently and this session stays non-remote.
      remoteClaimPending = true;
    } else {
      remoteEnabled = true;
    }
    // Boot the memory daemon eagerly. The channels worker forwards
    // transcript ingests/entries to the memory HTTP service, whose port is
    // published to active-instance.json by getMemoryModule().init(). Without
    // this, memory only starts on the first turn's getMemoryModule() call —
    // so early channel traffic finds no memory_port and gets buffered (or,
    // pre-drainer, silently dropped). Runs BEFORE channel claim so the port is
    // racing to be live by the time the worker sends its first ingest.
    //
    // Not fire-and-forget: init() only resolves the module handle, so a bare
    // getMemoryModule() could return before /health reports ok — leaving early
    // ingests to hit a not-yet-listening port. Await the proxy start() and then
    // poll /health with a bounded retry so the daemon is provably reachable
    // (or logged failed) rather than assumed-up. Still non-blocking to the
    // caller: the whole probe is detached, but it internally awaits readiness.
    void (async () => {
      try {
        // Yield one event-loop tick before the heavy chain below (module
        // resolve, daemon fork/health-poll) starts, so Ink's next render
        // (scheduled via setImmediate/timers) and any queued keypress
        // events get a turn first instead of being starved by this
        // detached chain's synchronous setup work.
        await new Promise((r) => setImmediate(r));
        const mod = await getMemoryModule();
        const started = typeof mod?.start === 'function' ? await mod.start() : null;
        const port = started?.port;
        if (!port) { bootProfile('channels:memory-eager-init-failed', { error: 'no port from start()' }); return; }
        for (let i = 0; i < 30; i++) {
          try {
            const ok = await new Promise((res) => {
              const req = httpMod.request({ hostname: '127.0.0.1', port, path: '/health', timeout: 1500 }, (r) => {
                let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => {
                  try { res(JSON.parse(d)?.status === 'ok'); } catch { res(false); }
                });
              });
              req.on('error', () => res(false));
              req.on('timeout', () => { req.destroy(); res(false); });
              req.end();
            });
            if (ok) { bootProfile('channels:memory-eager-init-ready', { port }); return; }
          } catch {}
          await new Promise((r) => setTimeout(r, 500));
        }
        bootProfile('channels:memory-eager-init-failed', { error: `health not ok after retries (port ${port})` });
      } catch (error) {
        bootProfile('channels:memory-eager-init-failed', { error: error?.message || String(error) });
      }
    })();
    // Publish this session's record + transcript file BEFORE the worker's
    // activate-time discovery polls, so output forwarding binds to this
    // terminal session immediately instead of waiting for the first turn.
    // No-op when the session has not been created yet (lazy mode); that
    // case is covered by the turn-start rebind in ask().
    ensureRemoteTranscriptWriter();
    // A backend switch may still be sitting in its debounce window; flush it
    // so the channel worker boots against the backend the user just chose,
    // not the previous on-disk value.
    try { flushBackendSave(); } catch {}
    if (envFlag('MIXDOG_DISABLE_CHANNEL_START')) {
      bootProfile('channels:start-skipped');
      return true;
    }
    if (!channelsEnabled()) {
      bootProfile('channels:start-disabled');
      return true;
    }
    if (closeRequested) return true;
    if (prewarmTimers.channelStartTimer) {
      clearTimeout(prewarmTimers.channelStartTimer);
      prewarmTimers.channelStartTimer = null;
    }
    bootProfile('channels:start-scheduled', { delayMs: 0, immediate: true });
    void (async () => {
      // Yield before the createCurrentSession/transcript/fork chain below —
      // same rationale as the memory-eager-init yield above: this detached
      // chain runs synchronous config/fs work (createCurrentSession, backend
      // flush, transcript writer) back-to-back, and without a tick break it
      // can run ahead of Ink's queued render/input handling.
      await new Promise((r) => setImmediate(r));
      // Immediate-occupancy guarantee: make sure a session + transcript
      // exist BEFORE the worker boots — a freshly-forked worker claims and
      // runs transcript discovery inside its own start(), so publishing the
      // session record/file first lets that very first discovery pass bind
      // output forwarding to THIS terminal instead of a persisted/stale
      // neighbour. Lazy mode means the session may not exist yet at /remote
      // time; create it here (idempotent — reuses a live session, joins an
      // in-flight create). On create failure we still claim: that matches
      // the pre-eager behavior (bind resolves on the first turn's rebind).
      try { await createCurrentSession('remote-start'); }
      catch (error) { bootProfile('channels:remote-session-create-failed', { error: error?.message || String(error) }); }
      ensureRemoteTranscriptWriter();
      // Re-check after the awaits above: stopRemote()/superseded or runtime
      // close may have landed mid-chain — do not boot/claim for a session
      // that already turned remote off.
      if ((!remoteEnabled && !remoteClaimPending) || closeRequested) { remoteClaimPending = false; return; }
      // Set the fork-inherited intent immediately before the worker fork (the
      // fork reads process.env synchronously inside invokeChannelStart) and
      // restore the prior value the instant it resolves, so the pollution
      // window is just this fork rather than the whole boot chain.
      const _prevIntent = process.env.MIXDOG_REMOTE_INTENT;
      try {
        process.env.MIXDOG_REMOTE_INTENT = intent;
        await invokeChannelStart();
      } finally {
        if (_prevIntent === undefined) delete process.env.MIXDOG_REMOTE_INTENT;
        else process.env.MIXDOG_REMOTE_INTENT = _prevIntent;
      }
      if ((!remoteEnabled && !remoteClaimPending) || closeRequested) { remoteClaimPending = false; return; }
      // Explicit start: unconditional claim + forwarder rebind (last-wins seat
      // overwrite + transcript rebind onto this session). AUTO start SKIPS this
      // — the freshly-forked worker already ran its claim-if-vacant boot claim,
      // and forcing activate here would steal a live owner that autoStart is
      // meant to yield to. The worker's acquire notification drives remote ON.
      if (intent !== 'auto') {
        await channels.execute('activate_channel_bridge', { active: true });
      }
      // Claim attempt dispatched; the worker's acquire/supersede notification
      // now owns the remoteEnabled transition. Drop the transient marker.
      remoteClaimPending = false;
    })().catch((error) => { remoteClaimPending = false; bootProfile('channels:claim-failed', { error: error?.message || String(error) }); });
    return true;
  }

  function stopRemote(reason) {
    remoteEnabled = false;
    // A pending auto-claim is abandoned by an explicit stop/supersede.
    remoteClaimPending = false;
    // Cancel any pending deferred start so it can't fire after remote is off.
    if (prewarmTimers.channelStartTimer) { clearTimeout(prewarmTimers.channelStartTimer); prewarmTimers.channelStartTimer = null; }
    // Route /remote-off and supersede through a WAITING stop: the runtime keeps
    // running, so we don't block on it (no await), but the waiting path runs the
    // full SIGTERM -> taskkill /T /F escalation ladder to guarantee the worker
    // dies rather than lingering as a zombie holding the bridge seat.
    channels.stop(reason || 'remote-disabled').catch(() => {});
    return true;
  }

  function isRemoteEnabled() {
    return remoteEnabled;
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
    prewarmSession: sessionPrewarmEnabled,
    providerWarmup: providerWarmupEnabled,
    codeGraphPrewarm: codeGraphPrewarmEnabled,
  });
  scheduleLeadSessionPrewarm();
  // Lazy mode (default): skip the startup prewarm entirely; the first turn
  // triggers it instead (see ask()). Eager mode keeps the old startup schedule.
  if (!codeGraphPrewarmLazy) {
    scheduleCodeGraphPrewarm(codeGraphPrewarmDelayMs, 'startup');
  } else {
    bootProfile('code-graph:prewarm-lazy', { reason: 'startup-deferred-to-first-turn' });
  }
  scheduleProviderSetupWarmup();
  scheduleModelCatalogWarmup();
  scheduleProviderWarmup();
  // Warm the provider model catalog in the background, but keep it on its own
  // delay so short-lived detached runtimes can exit before /models I/O starts.
  // Operators that want earlier catalog warming can lower
  // MIXDOG_PROVIDER_MODEL_WARMUP_DELAY_MS explicitly.
  scheduleProviderModelWarmup();
  scheduleStatuslineUsageWarmup();
  // Channels are opt-in: only boot the worker when this session started in (or
  // was toggled into) remote mode. Non-remote sessions never contend for the
  // channel; see startRemote()/stopRemote() and the `/remote` toggle.
  // `remote.autoStart` in mixdog-config.json makes every session claim remote
  // at boot (same force-takeover semantics as `mixdog --remote` / `/remote`).
  // The flag lives in the TOP-LEVEL `remote` section of mixdog-config.json
  // (sibling of agent/ui/channels), not inside the agent section that
  // cfgMod.loadConfig returns — read it via the shared whole-file reader.
  // `config?.remote?.autoStart` is kept for back-compat with agent-section
  // placement.
  // `remote` (from `mixdog --remote`) is EXPLICIT force-takeover. Config
  // `remote.autoStart` is AUTO: it must claim the seat ONLY if no live owner
  // exists (claim-if-vacant) and back off silently otherwise — so it does NOT
  // set remoteEnabled up front (that would assert remote before the claim is
  // known to have won). Track it as a separate deferred auto request; the
  // worker's acquire notification flips remoteEnabled if/when it wins the seat.
  let remoteAutoStartRequested = false;
  if (!remoteEnabled) {
    try {
      if (config?.remote?.autoStart === true
        || sharedCfgMod?.readSection?.('remote')?.autoStart === true) {
        remoteAutoStartRequested = true;
      }
    } catch { /* unreadable config never blocks boot */ }
  }
  // Boot-time remote start (autoStart or --remote) is DEFERRED past the TUI's
  // first frame. startRemote() front-loads heavy work — memory daemon fork
  // (PG + forced ONNX embed warmup in the child), eager session create, and
  // the channel-worker fork — and running it inline here interleaves that
  // CPU/disk load with engine boot, visibly delaying the first ink frame by
  // seconds. The deferred timer reuses prewarmTimers.channelStartTimer so an
  // early /remote (startRemote clears it), stopRemote(), and close() all
  // cancel it through the existing clearTimeout paths. Runtime /remote calls
  // still start immediately (user-initiated, UI already painted).
  if (remoteEnabled || remoteAutoStartRequested) {
    const remoteStartIntent = remoteEnabled ? 'explicit' : 'auto';
    const remoteAutoStartDelayMs = envDelayMs('MIXDOG_REMOTE_AUTOSTART_DELAY_MS', 1_500, { min: 0, max: 60_000 });
    bootProfile('channels:autostart-deferred', { delayMs: remoteAutoStartDelayMs, intent: remoteStartIntent });
    prewarmTimers.channelStartTimer = setTimeout(() => {
      prewarmTimers.channelStartTimer = null;
      if (closeRequested) return;
      // Explicit: a /remote-off before the timer clears remoteEnabled — skip.
      // Auto: always attempt (claim-if-vacant is safe when a live owner exists).
      if (remoteStartIntent === 'explicit' && !remoteEnabled) return;
      startRemote({ intent: remoteStartIntent });
    }, remoteAutoStartDelayMs);
    prewarmTimers.channelStartTimer.unref?.();
  }

  // Pure settings-delegate methods (onboarding status/skip, autoClear, profile,
  // compaction, recap/memory, channels, systemShell, update settings, channel
  // token save/forget, setBackend). Extracted to session-runtime/settings-api.mjs
  // and SPREAD into the API object below so the external surface is unchanged.
  const settingsApi = createSettingsApi({
    getConfig: () => config,
    getRoute: () => route,
    getSession: () => session,
    getRemoteEnabled: () => remoteEnabled,
    adoptConfig,
    saveConfigAndAdopt,
    scheduleBackendSave,
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
    setModuleEnabledInConfig,
    summarizeWorkflowRoutes,
    parseDurationMs,
    formatDurationMs,
    localPackageVersion,
    memoryEnabled,
    recapEnabledFn,
    channelsEnabled,
    autoUpdateEnabled,
    getUpdateCheckState: () => updateCheckState,
    getUpdateProcessState: () => updateProcessState,
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
    saveWebhookAuthtoken,
    forgetWebhookAuthtoken,
    setBackend,
  });

  const channelConfigApi = createChannelConfigApi({ flushBackendSave, channels, reloadChannelsSoon });
  const providerAuthApi = createProviderAuthApi({
    cfgMod,
    getConfig: () => config,
    saveConfigAndAdopt,
    displayConfig,
    reloadFullConfig,
    invalidateProviderCaches,
    warmProviderModelCache,
    cachedProviderSetup,
    getUsageDashboard,
    collectProviderModels,
  });
  const lifecycleApi = createLifecycleApi({
    getSession: () => session,
    setSession: (v) => { session = v; },
    getRoute: () => route,
    setRoute: (v) => { route = v; },
    getConfig: () => config,
    getMode: () => mode,
    getCurrentCwd: () => currentCwd,
    setCloseRequested: (v) => { closeRequested = v; },
    getMemoryModPromise: () => memoryModPromise,
    setMemoryModPromise: (v) => { memoryModPromise = v; },
    setSessionNeedsCwdRefresh: (v) => { sessionNeedsCwdRefresh = v; },
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
    flushBackendSave,
    flushOutputStyleSave,
    withTeardownDeadline,
    closePatchRuntimeIfLoaded,
    createCurrentSession,
    refreshRouteEffort,
    invalidateContextStatusCache,
    invalidatePreSessionToolSurface,
    applyResolvedCwd,
    resolveRoute,
    applyDeferredToolSurface,
    standaloneTools,
  });
  const resourceApi = createResourceApi({
    getConfig: () => config,
    getSession: () => session,
    getCurrentCwd: () => currentCwd,
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
    getActiveTurnCount: () => activeTurnCount,
  });
  const modelRouteApi = createModelRouteApi({
    getConfig: () => config,
    getRoute: () => route,
    setRouteState: (v) => { route = v; },
    getSession: () => session,
    setSession: (v) => { session = v; },
    getConfigHasSecrets: () => configHasSecrets,
    getSearchRouteState: () => searchRoute,
    setSearchRouteState: (v) => { searchRoute = v; },
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
    persistLeadRoute,
    refreshRouteEffort,
    refreshStatuslineUsageSnapshot,
    scheduleStatuslineUsageRefresh,
    invalidateContextStatusCache,
    invalidateProviderCaches,
    collectSearchProviderModels,
  });
  const workflowAgentsApi = createWorkflowAgentsApi({
    getConfig: () => config,
    getRoute: () => route,
    setRouteState: (v) => { route = v; },
    getSession: () => session,
    setSession: (v) => { session = v; },
    getConfigHasSecrets: () => configHasSecrets,
    cfgMod,
    reg,
    mgr,
    STANDALONE_DATA_DIR,
    resolveRoute,
    lookupModelMeta,
    adoptConfig,
    saveConfigAndAdopt,
    displayConfig,
    agentRouteFromConfig,
    loadAgentDefinition,
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
    getSession: () => session,
    setSession: (v) => { session = v; },
    getCurrentCwd: () => currentCwd,
    getMode: () => mode,
    setMode: (v) => { mode = v; },
    getActiveTurnCount: () => activeTurnCount,
    setActiveTurnCount: (v) => { activeTurnCount = v; },
    isFirstTurnCompleted: () => firstTurnCompleted,
    setFirstTurnCompleted: (v) => { firstTurnCompleted = v; },
    getCodeGraphFirstTurnPrewarmDone: () => codeGraphFirstTurnPrewarmDone,
    setCodeGraphFirstTurnPrewarmDone: (v) => { codeGraphFirstTurnPrewarmDone = v; },
    codeGraphPrewarmLazy,
    getRemoteEnabled: () => remoteEnabled,
    getCloseRequested: () => closeRequested,
    getPendingSessionReset: () => pendingSessionReset,
    setPendingSessionReset: (v) => { pendingSessionReset = v; },
    getTranscriptWriter: () => _transcriptWriter,
    getTwKey: () => _twKey,
    getLastAppendedAssistant: () => _lastAppendedAssistant,
    setLastAppendedAssistant: (v) => { _lastAppendedAssistant = v; },
    scheduleCodeGraphPrewarm,
    refreshSessionForCwdIfNeeded,
    createCurrentSession,
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
    awaitInitialMcpConnect,
  });

  return {
    ...settingsApi,
    ...channelConfigApi,
    ...providerAuthApi,
    get id() {
      return session?.id || null;
    },
    get provider() {
      return route.provider;
    },
    get model() {
      return route.model;
    },
    get effort() {
      return route.effectiveEffort || route.effort || route.preset?.effort || null;
    },
    get fast() {
      return route.fast === true;
    },
    get fastCapable() {
      return route.fastCapable === true;
    },
    get effortOptions() {
      return route.effortOptions || [];
    },
    get contextWindow() {
      return session?.contextWindow || null;
    },
    get rawContextWindow() {
      return session?.rawContextWindow || session?.contextWindow || null;
    },
    get effectiveContextWindowPercent() {
      return session?.effectiveContextWindowPercent || null;
    },
    get toolMode() {
      return mode;
    },
    get autoClear() {
      return this.getAutoClear();
    },
    get systemShell() {
      return normalizeSystemShellConfig(config.shell);
    },
    get searchRoute() {
      searchRoute = normalizeSearchRouteConfig(config.searchRoute) || normalizeSearchRouteConfig(searchRoute);
      return searchRoute;
    },
    get workflow() {
      const dataDir = cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
      const active = activeWorkflowSummary(config, dataDir);
      if (session?.workflow && typeof session.workflow === 'object') {
        const current = workflowSummary(session.workflow);
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
      return currentCwd;
    },
    get session() {
      return session;
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
    startRemote() {
      return startRemote();
    },
    stopRemote(reason) {
      return stopRemote(reason);
    },
    isRemoteEnabled() {
      return isRemoteEnabled();
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
      return session?.clientHostPid || process.pid;
    },
    ...lifecycleApi,
    ...resourceApi,
    ...modelRouteApi,
    ...workflowAgentsApi,
    ...sessionTurnApi,
  };
}
