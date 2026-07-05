// Provider/search model catalog + cache glue, extracted from
// mixdog-session-runtime.mjs. Dependency-injected factory following the
// createWarmupSchedulers/createNativeSearch pattern: mutable cache state lives
// in a caller-owned `caches` object (so the facade's invalidateProviderCaches
// teardown still sees the same references) and all route/config/registry reads
// go through supplied accessors so live-binding is preserved (no stale
// snapshot of route/config/searchRoute).
import { clean } from './session-text.mjs';
import { effortItemsFor } from './effort.mjs';
import { fastCapableFor, fastPreferenceFor } from './model-capabilities.mjs';
import { modelSettingsFor } from './config-helpers.mjs';
import { isSelectableLlmModel } from './model-recency.mjs';

const PROVIDER_MODELS_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(String(
  process.env.MIXDOG_PROVIDER_MODELS_PROFILE || process.env.MIXDOG_BOOT_PROFILE || '',
));

export function createProviderModels({
  caches,
  modelMetaByRoute,
  getRoute,
  getConfig,
  getReg,
  searchCapableFor,
  sortProviderModelsRaw,
  providerModelCacheRowRaw,
  normalizeSearchProviderId,
  isSearchCapableProvider,
  ensureFullConfig,
  ensureProvidersReady,
  bootProfile,
  scheduleProviderModelWarmup,
  // Quick-row helpers wired in after createQuickModelRows resolves.
  quickHelpers,
}) {
  const config = () => getConfig();
  const route = () => getRoute();
  const reg = () => getReg();
  function profile(event, fields = {}) {
    if (!PROVIDER_MODELS_PROFILE_ENABLED) return;
    bootProfile(`provider-models:${event}`, fields);
  }

  function modelMetaKey(providerId, modelId) {
    return `${clean(providerId)}\n${clean(modelId)}`;
  }

  async function lookupModelMeta(providerId, modelId, { allowFetch = false } = {}) {
    const key = modelMetaKey(providerId, modelId);
    if (modelMetaByRoute.has(key)) return modelMetaByRoute.get(key);
    const providerImpl = reg().getProvider(providerId);
    if (!providerImpl || typeof providerImpl.listModels !== 'function') {
      const fallback = { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, fallback);
      return fallback;
    }
    if (typeof providerImpl.getCachedModelInfo === 'function') {
      const cached = providerImpl.getCachedModelInfo(modelId);
      if (cached) {
        const meta = { ...cached, id: cached.id || modelId, provider: providerId };
        modelMetaByRoute.set(key, meta);
        return meta;
      }
    }
    if (!allowFetch) {
      const fallback = { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, fallback);
      scheduleProviderModelWarmup();
      return fallback;
    }
    try {
      const models = await providerImpl.listModels();
      const found = Array.isArray(models) ? models.find((m) => m?.id === modelId) : null;
      const meta = found || { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, meta);
      return meta;
    } catch {
      const fallback = { id: modelId, provider: providerId };
      modelMetaByRoute.set(key, fallback);
      return fallback;
    }
  }

  function hydrateProviderModelRow(row) {
    const cfg = config();
    return {
      ...row,
      effortOptions: effortItemsFor(row.provider, row, null),
      fastCapable: fastCapableFor(row.provider, row),
      fastPreferred: fastPreferenceFor(cfg, row.provider, row.id),
      savedEffort: modelSettingsFor(cfg, row.provider, row.id).effort || null,
      savedFast: modelSettingsFor(cfg, row.provider, row.id).fast === true,
    };
  }

  const sortProviderModels = (models) => sortProviderModelsRaw(models, route().provider);
  const providerModelCacheRow = (name, m) => providerModelCacheRowRaw(name, m, searchCapableFor);

  function providerModelsFromCacheRows(rows) {
    return sortProviderModels((rows || []).map(hydrateProviderModelRow));
  }

  function enabledSearchProviderConfig() {
    ensureFullConfig();
    const out = {};
    for (const [name, providerConfig] of Object.entries(config().providers || {})) {
      const providerName = normalizeSearchProviderId(name);
      if (!providerConfig?.enabled || !isSearchCapableProvider(providerName)) continue;
      out[providerName] = { ...providerConfig, enabled: true };
    }
    return out;
  }

  async function loadSearchProviderModelsFresh({ forceRefresh = false } = {}) {
    const searchProviders = enabledSearchProviderConfig();
    const providerNames = Object.keys(searchProviders);
    if (!providerNames.length) return [];
    await ensureProvidersReady(config().providers || {});
    const providerResults = await Promise.all(providerNames.map(async (name) => {
      const provider = reg().getProvider(name);
      if (typeof provider?.listModels !== 'function') return [];
      try {
        let models = null;
        if (forceRefresh && typeof provider._refreshModelCache === 'function') {
          models = await provider._refreshModelCache();
        }
        if (!Array.isArray(models)) {
          models = await provider.listModels();
        }
        if (!Array.isArray(models)) return [];
        const rows = [];
        for (const m of models) {
          if (!m?.id || !isSelectableLlmModel(m)) continue;
          const row = providerModelCacheRow(name, m);
          if (row.supportsWebSearch !== true) continue;
          rows.push({
            ...row,
            provider: normalizeSearchProviderId(row.provider),
            searchCapable: true,
            searchToolType: row.searchToolType || 'web_search',
          });
          modelMetaByRoute.set(modelMetaKey(name, m.id), row);
        }
        return rows;
      } catch {
        // Keep the picker responsive if one search-capable provider has a
        // transient catalog/auth failure.
        return [];
      }
    }));
    const results = [];
    const seen = new Set();
    quickHelpers.addDefaultSearchModel(results, seen);
    for (const row of providerResults.flat()) {
      const key = `${normalizeSearchProviderId(row.provider)}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
    }
    return results;
  }

  async function loadProviderModelsFresh({ forceRefresh = false, loadSecrets = true } = {}) {
    const startedAt = performance.now();
    profile('load:start', { forceRefresh, loadSecrets });
    if (loadSecrets) ensureFullConfig();
    const providersStartedAt = performance.now();
    await ensureProvidersReady(config().providers || {});
    profile('providers-ready', { ms: (performance.now() - providersStartedAt).toFixed(1) });
    const allProviders = [...reg().getAllProviders()];
    const providerResults = await Promise.all(allProviders.map(async ([name, provider]) => {
      if (typeof provider?.listModels !== 'function') return [];
      const providerStartedAt = performance.now();
      try {
        let models = null;
        if (forceRefresh && typeof provider._refreshModelCache === 'function') {
          models = await provider._refreshModelCache();
        }
        if (!Array.isArray(models)) {
          models = await provider.listModels();
        }
        if (!Array.isArray(models)) return [];
        const rows = [];
        for (const m of models) {
          if (!m?.id) continue;
          if (!isSelectableLlmModel(m)) continue;
          rows.push(providerModelCacheRow(name, m));
        }
        profile('provider:done', {
          provider: name,
          ms: (performance.now() - providerStartedAt).toFixed(1),
          models: models.length,
          rows: rows.length,
        });
        return rows;
      } catch (error) {
        profile('provider:failed', {
          provider: name,
          ms: (performance.now() - providerStartedAt).toFixed(1),
          error: error?.message || String(error),
        });
        // Ignore per-provider catalog failures so one bad credential or
        // transient /models error does not hide other authenticated models.
        return [];
      }
    }));
    const results = [];
    const seen = new Set();
    for (const row of providerResults.flat()) {
      const key = `${row.provider}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
      modelMetaByRoute.set(modelMetaKey(row.provider, row.id), row);
    }
    profile('load:done', { ms: (performance.now() - startedAt).toFixed(1), providers: allProviders.length, rows: results.length });
    return results;
  }

  function shouldAdoptProviderModelCache(models, { loadSecrets = true } = {}) {
    // Background warmup deliberately avoids ensureFullConfig() so it cannot
    // block the TUI on keychain/config reload. That no-secrets path is only a
    // best-effort provider-internal prefetch. Its result may be a partial
    // catalog (for example local/env providers listed while keychain-backed
    // providers failed), so never let it become the authoritative picker cache.
    // Foreground/forced loads still adopt empty lists because they loaded the
    // authoritative config.
    return loadSecrets;
  }

  async function collectSearchProviderModels({ force = false } = {}) {
    if (!force && Array.isArray(caches.searchProviderModelsCache.models)) {
      return providerModelsFromCacheRows(quickHelpers.searchRowsWithDefault(caches.searchProviderModelsCache.models));
    }
    if (!force && Array.isArray(caches.providerModelsCache.models)) {
      const rows = quickHelpers.searchRowsWithDefault(quickHelpers.searchModelsFromRows(caches.providerModelsCache.models));
      caches.searchProviderModelsCache = { models: rows, at: Date.now() };
      return providerModelsFromCacheRows(rows);
    }
    if (!force) {
      const rows = quickHelpers.searchRowsWithDefault(quickHelpers.quickSearchProviderModelRows());
      caches.searchProviderModelsCache = { models: rows, at: Date.now() };
      return providerModelsFromCacheRows(rows);
    }
    if (force) {
      const models = await loadSearchProviderModelsFresh({ forceRefresh: true });
      caches.searchProviderModelsCache = { models, at: Date.now() };
      return providerModelsFromCacheRows(models);
    }
  }

  async function collectProviderModels({ force = false, quick = false } = {}) {
    if (!force && Array.isArray(caches.providerModelsCache.models)) {
      return providerModelsFromCacheRows(caches.providerModelsCache.models);
    }
    if (!force && quick) {
      warmProviderModelCache();
      return quickHelpers.quickProviderModelRows();
    }
    if (force) {
      const seq = ++caches.providerModelsLoadSeq;
      const models = await loadProviderModelsFresh({ forceRefresh: true, loadSecrets: true });
      if (seq === caches.providerModelsLoadSeq) caches.providerModelsCache = { models, at: Date.now() };
      return providerModelsFromCacheRows(models);
    }
    if (!caches.providerModelsPromise) {
      const seq = ++caches.providerModelsLoadSeq;
      caches.providerModelsPromise = loadProviderModelsFresh({ loadSecrets: true })
        .then((models) => {
          if (seq === caches.providerModelsLoadSeq && shouldAdoptProviderModelCache(models, { loadSecrets: true })) caches.providerModelsCache = { models, at: Date.now() };
          return models;
        })
        .finally(() => {
          caches.providerModelsPromise = null;
        });
    }
    return providerModelsFromCacheRows(await caches.providerModelsPromise);
  }

  function warmProviderModelCache() {
    if (Array.isArray(caches.providerModelsCache.models) || caches.providerModelsPromise) return caches.providerModelsPromise;
    profile('warm:start');
    const seq = ++caches.providerModelsLoadSeq;
    caches.providerModelsPromise = loadProviderModelsFresh({ loadSecrets: false })
      .then((models) => {
        if (seq === caches.providerModelsLoadSeq && shouldAdoptProviderModelCache(models, { loadSecrets: false })) {
          caches.providerModelsCache = { models, at: Date.now() };
        }
        bootProfile('provider-models:warm-ready', { count: models.length });
        return models;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        bootProfile('provider-models:warm-failed', { error: msg });
        return [];
      })
      .finally(() => {
        caches.providerModelsPromise = null;
      });
    return caches.providerModelsPromise;
  }

  return {
    modelMetaKey,
    lookupModelMeta,
    hydrateProviderModelRow,
    sortProviderModels,
    providerModelCacheRow,
    providerModelsFromCacheRows,
    enabledSearchProviderConfig,
    loadSearchProviderModelsFresh,
    loadProviderModelsFresh,
    collectSearchProviderModels,
    collectProviderModels,
    warmProviderModelCache,
  };
}
