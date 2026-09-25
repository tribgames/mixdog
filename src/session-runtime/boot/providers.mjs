// Boot stage 6: config lifecycle (reload/save/adopt), native web search,
// provider usage/setup caches, provider model catalogs and quick model rows.
import { setConfiguredShell } from '../../runtime/agent/orchestrator/tools/builtin/shell-runtime.mjs';
import { providerSetup } from '../../standalone/provider-admin.mjs';
import { createUsageDashboard } from '../../standalone/usage-dashboard.mjs';
import {
  consumeOpenAICodexResetCredit,
  fetchOAuthUsageSnapshot,
} from '../../runtime/agent/orchestrator/providers/oauth-usage.mjs';
import { LOCAL_PROVIDER_ID, configureLocalProviderIdleTtl } from '../../runtime/local-provider/managed-runtime.mjs';
import { resolve } from 'node:path';
import { clean } from '../session-text.mjs';
import { LAZY_SECRET_PROVIDERS } from '../model-capabilities.mjs';
import { ensureProviderEnabled, normalizeSystemShellConfig } from '../config-helpers.mjs';
import {
  workflowPresetId,
  normalizeWebSearchProviderId,
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  normalizeWebSearchRouteConfig,
  normalizeWorkflowRoute,
  upsertWorkflowPreset,
} from '../workflow.mjs';
import {
  sortProviderModels as sortProviderModelsRaw,
  providerModelCacheRow as providerModelCacheRowRaw,
} from '../model-recency.mjs';
import { createNativeWebSearch } from '../native-web-search.mjs';
import { createConfigLifecycle } from '../config-lifecycle.mjs';
import { createQuickModelRows } from '../quick-model-rows.mjs';
import { createProviderModels } from '../provider-models.mjs';
import { createProviderUsage } from '../provider-usage.mjs';
import { bootProfile } from '../boot-profile.mjs';
import { STANDALONE_DATA_DIR } from '../runtime-paths.mjs';
import { outputStyleStatus, webSearchCapableFor } from './shared.mjs';

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
    getOutputStyleStatusCached,
    invalidateOutputStyleStatusCache,
    seedOutputStyleStatusCache,
    adoptConfig,
    saveConfigAndAdopt,
    scheduleSkillsSave,
    flushSkillsSave,
    scheduleOutputStyleSave,
    flushAllConfigSavesAsync,
    reloadFullConfig,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
  } = lifecycle;
  Object.assign(boot, {
    getOutputStyleStatusCached,
    invalidateOutputStyleStatusCache,
    seedOutputStyleStatusCache,
    adoptConfig,
    saveConfigAndAdopt,
    scheduleSkillsSave,
    flushSkillsSave,
    scheduleOutputStyleSave,
    flushAllConfigSavesAsync,
    reloadFullConfig,
    ensureFullConfig,
    displayConfig,
    ensureConfigForRouteProvider,
    persistLeadRoute: (routeLike) => {
      const leadRoute = normalizeWorkflowRoute(routeLike);
      if (!leadRoute) return null;
      const nextConfig = { ...(rt.config || {}) };
      nextConfig.presets = upsertWorkflowPreset(nextConfig.presets, 'lead', leadRoute);
      nextConfig.default = workflowPresetId('lead');
      saveConfigAndAdopt(nextConfig);
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
