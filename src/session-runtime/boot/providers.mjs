// Boot stage 6: config lifecycle (reload/save/adopt), native web search,
// provider usage/setup caches, provider model catalogs and quick model rows.
import { setConfiguredShell } from '../../runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
import { providerSetup } from '../services/provider-admin.mjs';
import { createUsageDashboard } from '../services/usage-dashboard.mjs';
import {
  consumeOpenAICodexResetCredit,
  fetchOAuthUsageSnapshot,
} from '../../runtime/agent/orchestrator/providers/oauth-usage.mjs';
import { LOCAL_PROVIDER_ID, configureLocalProviderIdleTtl } from '../../runtime/local-provider/managed-runtime.mjs';
import { resolve } from 'node:path';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { LAZY_SECRET_PROVIDERS } from '../../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import {
  ensureProviderEnabled,
  normalizeSystemShellConfig,
} from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import {
  workflowPresetId,
  normalizeWebSearchProviderId,
  webSearchProviderFamily,
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  normalizeWebSearchRouteConfig,
  normalizeWorkflowRoute,
  upsertWorkflowPreset,
} from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import {
  sortProviderModels as sortProviderModelsRaw,
  providerModelCacheRow as providerModelCacheRowRaw,
} from '../model-recency.mjs';
import { createNativeWebSearch } from '../native-web-search.mjs';
import { createConfigLifecycle } from '../config-lifecycle.mjs';
import { createConfigChangeEffects, SETTINGS_CHANGED_SETUP_ACTION } from '../config-change-effects.mjs';
import { resetProviderAdmissionCooldowns } from '../../runtime/agent/orchestrator/providers/admission-scheduler.mjs';
import { usesInjectedConfig } from '../session-compaction-sync.mjs';
import { createQuickModelRows } from '../quick-model-rows.mjs';
import { createProviderModels } from '../provider-models.mjs';
import { createProviderUsage } from '../provider-usage.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { standaloneDataDir } from '../runtime-paths.mjs';
import { noteCacheWarmingEnabled } from '../../runtime/agent/orchestrator/session/cache-warm.mjs';
import { refreshLiveSessionsProviderCacheOpts } from '../../runtime/agent/orchestrator/session/manager/session-lifecycle.mjs';
import {
  ensureConnectorAccountIds,
  forgetConversationConnectorAccounts,
} from '../../runtime/connectors/connector-accounts-mcp.mjs';
import { registerSessionPurgeHook } from '../../runtime/agent/orchestrator/session/store/session-observers.mjs';
import { outputStyleStatus, resolveRoute, webSearchCapableFor } from './shared.mjs';

// A conversation's connector accounts go with its session (once per process).
registerSessionPurgeHook((sessionId) => forgetConversationConnectorAccounts(sessionId));

export function wireProviders(boot) {
  wireConfigLifecycle(boot);
  wireNativeWebSearch(boot);
  wireProviderUsage(boot);
  wireProviderModels(boot);
}

// Config reload/save/adopt family + output-style status cache
// (config-lifecycle.mjs). Boot retains ownership of the
// config/webSearchRoute/configHasSecrets mutable state via getter/setter
// injection.
function wireConfigLifecycle(boot) {
  const { rt, cfgMod, sharedCfgMod } = boot;
  // Every stored connector account gets its identity (an injected config is
  // not the stored one). True when the stored config changed.
  boot.ensureConnectorAccountIds = () => {
    if (usesInjectedConfig(boot.params)) return false;
    try {
      return ensureConnectorAccountIds();
    } catch (error) {
      console.warn(`[connectors] giving accounts their identity failed: ${error?.message || error}`);
      return false;
    }
  };
  const lifecycle = createConfigLifecycle({
    getConfig: () => rt.config,
    setConfig: (next) => {
      rt.config = next;
      configureLocalProviderIdleTtl(next.providers?.[LOCAL_PROVIDER_ID]?.idleTtlSeconds);
    },
    getWebSearchRoute: () => rt.webSearchRoute,
    setWebSearchRoute: (next) => {
      rt.webSearchRoute = next;
    },
    getConfigHasSecrets: () => rt.configHasSecrets,
    setConfigHasSecrets: (next) => {
      rt.configHasSecrets = next;
    },
    getRoute: () => rt.route,
    getSession: () => rt.session,
    injectedConfig: usesInjectedConfig(boot.params),
    setRouteState: (next) => {
      rt.route = next;
    },
    resolveRoute,
    cfgMod,
    sharedCfgMod,
    setConfiguredShell,
    normalizeSystemShellConfig,
    normalizeWebSearchRouteConfig,
    outputStyleStatus,
    LAZY_SECRET_PROVIDERS,
    clean,
    resolve,
    // Late-bound: the effect targets (notification bus, MCP connect, context
    // status) are wired by later boot stages.
    onConfigChanged: createConfigChangeEffects({
      invalidateContextStatusCache: () => boot.invalidateContextStatusCache?.(),
      reinitProviders: () => boot.reinitProviders(),
      releaseAdmissionCooldowns: resetProviderAdmissionCooldowns,
      // Fails (so the change step retries it) when a server failed to connect
      // (other than needing a sign-in, which waits on the user) or the
      // identities failed; the servers reconcile either way.
      reconcileMcp: async () => {
        // An account written by hand gets its identity; that write is one
        // more change, reconciled in turn.
        let idsError = null;
        if (!usesInjectedConfig(boot.params)) {
          try {
            ensureConnectorAccountIds();
          } catch (error) {
            idsError = error;
          }
        }
        const status = await boot.connectConfiguredMcp?.({ reconcile: true });
        if (idsError) throw idsError;
        const failed = (status?.servers || []).filter((row) => row.enabled !== false && row.status === 'failed');
        if (failed.length) {
          throw new Error(`MCP servers failed to connect: ${failed.map((row) => `${row.name} (${row.error})`).join(', ')}`);
        }
      },
      noteCacheWarmingEnabled,
      refreshLiveSessionsCacheOpts: (config) => refreshLiveSessionsProviderCacheOpts(config),
      // Attached surfaces (TUI, desktop session lanes) re-read open settings.
      announceSettingsChange: () =>
        boot.emitRuntimeNotification?.('Settings changed', {
          kind: 'setup-changed',
          action: SETTINGS_CHANGED_SETUP_ACTION,
        }),
    }),
    STANDALONE_DATA_DIR: standaloneDataDir(),
  });
  const {
    disposeConfigSync,
    getOutputStyleStatusCached,
    invalidateOutputStyleStatusCache,
    seedOutputStyleStatusCache,
    adoptConfig,
    saveConfigAndAdopt,
    confirmLeadFill,
    scheduleSkillsSave,
    flushSkillsSave,
    scheduleOutputStyleSave,
    flushAllConfigSavesAsync,
    reloadFullConfig,
    applyConfigChange,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
  } = lifecycle;
  Object.assign(boot, {
    applyConfigChange,
    disposeConfigSync,
    getOutputStyleStatusCached,
    invalidateOutputStyleStatusCache,
    seedOutputStyleStatusCache,
    adoptConfig,
    saveConfigAndAdopt,
    confirmLeadFill,
    scheduleSkillsSave,
    flushSkillsSave,
    scheduleOutputStyleSave,
    flushAllConfigSavesAsync,
    reloadFullConfig,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
    persistLeadRoute: (routeLike, { onlyIfAbsent = false } = {}) => {
      const leadRoute = normalizeWorkflowRoute(routeLike);
      if (!leadRoute) return null;
      const nextConfig = { ...(rt.config || {}) };
      nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, 'lead', leadRoute);
      nextConfig.default = workflowPresetId('lead');
      // A conditional fill reaches the file only while no Lead route is stored.
      saveConfigAndAdopt(nextConfig, { leadFill: onlyIfAbsent });
      return leadRoute;
    },
  });
}

function wireNativeWebSearch(boot) {
  const { rt, ensureFullConfig, awaitKeychainPrewarm, ensureProvidersReady } = boot;
  const { currentMainWebSearchModelMeta, runNativeWebSearch } = createNativeWebSearch({
    getRoute: () => rt.route,
    getWebSearchRoute: () => rt.webSearchRoute,
    setWebSearchRoute: (next) => {
      rt.webSearchRoute = next;
    },
    getConfig: () => rt.config,
    getSession: () => rt.session,
    getReg: () => boot.reg,
    ensureFullConfig,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    ensureProviderEnabled,
    normalizeWebSearchProviderId,
    webSearchProviderFamily,
    isDefaultWebSearchRouteConfig,
    isWebSearchCapableProvider,
    webSearchCapableFor,
  });
  Object.assign(boot, { currentMainWebSearchModelMeta, runNativeWebSearch });
}

// Late-bound: createWarmupSchedulers is constructed after this factory, but
// cachedProviderSetup(quick) may nudge scheduleProviderSetupWarmup on a cold
// quick-cache fill. Thread it by reference so the scheduler is reachable once
// it exists (a pre-scheduler quick fill simply skips the warmup nudge).
function wireProviderUsage(boot) {
  const { rt, providerUsageCaches, displayConfig, warmupTimers } = boot;
  rt.scheduleProviderSetupWarmupRef = () => {};
  const {
    refreshStatuslineUsageSnapshot,
    cachedProviderSetup,
    hasProviderSetupCached,
    getUsageDashboard,
    consumeCodexRateLimitResetCredit,
  } = createProviderUsage({
    caches: providerUsageCaches,
    getReg: () => boot.reg,
    displayConfig,
    providerSetup,
    createUsageDashboard,
    fetchOAuthUsageSnapshot,
    consumeOpenAICodexResetCredit,
    isCloseRequested: () => rt.closeRequested,
    getProviderSetupWarmupTimer: () => warmupTimers.providerSetupWarmupTimer,
    scheduleProviderSetupWarmup: (delayMs) => rt.scheduleProviderSetupWarmupRef(delayMs),
  });
  Object.assign(boot, {
    refreshStatuslineUsageSnapshot,
    cachedProviderSetup,
    hasProviderSetupCached,
    getUsageDashboard,
    consumeCodexRateLimitResetCredit,
  });
}

// provider-models and quick-model-rows are mutually dependent (rows need
// cache-row helpers, the model factory needs quick fallbacks), so the quick
// surface is threaded in by reference after both are constructed. Likewise
// lookupModelMeta may fire scheduleProviderModelWarmup on a cache miss before
// the warmup scheduler exists; the miss handling is best-effort.
function wireProviderModels(boot) {
  const { rt, providerModelCaches, modelMetaByRoute, displayConfig, currentMainWebSearchModelMeta } = boot;
  const providerModelQuickHelpers = {};
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
    getReg: () => boot.reg,
    webSearchCapableFor,
    sortProviderModelsRaw,
    providerModelCacheRowRaw,
    normalizeWebSearchProviderId,
    isWebSearchCapableProvider,
    ensureFullConfig: boot.ensureFullConfig,
    awaitKeychainPrewarm: boot.awaitKeychainPrewarm,
    ensureProvidersReady: boot.ensureProvidersReady,
    bootProfile,
    scheduleProviderModelWarmup: () => rt.scheduleProviderModelWarmupRef(),
    quickHelpers: providerModelQuickHelpers,
  });
  Object.assign(
    providerModelQuickHelpers,
    createQuickModelRows({
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
    })
  );
  Object.assign(boot, {
    modelMetaKey,
    lookupModelMeta,
    sortProviderModels,
    providerModelCacheRow,
    providerModelsFromCacheRows,
    collectWebSearchProviderModels,
    collectProviderModels,
    warmProviderModelCache,
  });
}
