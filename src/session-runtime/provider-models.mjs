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

// Raw provider model lists are process-global because the provider registry is
// process-global in the daemon. Session runtimes keep only the cheap
// hydrated projection (saved effort/fast/current-route ordering). This stops
// every open pane from repeating the same provider list walk after startup.
let sharedCatalogRevision = -1;
let sharedCatalogEntries = null;
let sharedCatalogPromise = null;
let sharedCatalogPromiseRevision = -1;

function catalogRevision(registry) {
  const value = Number(registry?.providerCatalogRevision?.());
  return Number.isFinite(value) ? value : 0;
}

async function sharedProviderCatalog(registry) {
  const revision = catalogRevision(registry);
  if (sharedCatalogRevision === revision && Array.isArray(sharedCatalogEntries)) {
    return sharedCatalogEntries;
  }
  if (sharedCatalogPromise && sharedCatalogPromiseRevision === revision) {
    return await sharedCatalogPromise;
  }
  const providers = [...registry.getAllProviders()];
  sharedCatalogPromiseRevision = revision;
  let request;
  request = Promise.all(providers.map(async ([name, provider]) => {
    if (typeof provider?.listModels !== 'function') return { name, models: [], ms: 0 };
    const startedAt = performance.now();
    try {
      const models = await provider.listModels();
      return { name, models: Array.isArray(models) ? models : [], ms: performance.now() - startedAt };
    } catch (error) {
      return { name, models: [], error, ms: performance.now() - startedAt };
    }
  })).then((entries) => {
    sharedCatalogRevision = catalogRevision(registry);
    sharedCatalogEntries = entries;
    return entries;
  }).finally(() => {
    if (sharedCatalogPromise === request) {
      sharedCatalogPromise = null;
      sharedCatalogPromiseRevision = -1;
    }
  });
  sharedCatalogPromise = request;
  return await request;
}

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
  awaitKeychainPrewarm,
  ensureProvidersReady,
  bootProfile,
  scheduleProviderModelWarmup,
  // Quick-row helpers wired in after createQuickModelRows resolves.
  quickHelpers,
}) {
  const config = () => getConfig();
  const route = () => getRoute();
  const reg = () => getReg();
  let observedCatalogRevision = catalogRevision(reg());
  function syncCatalogRevision() {
    const revision = catalogRevision(reg());
    if (revision === observedCatalogRevision) return revision;
    observedCatalogRevision = revision;
    caches.providerModelsLoadSeq += 1;
    caches.providerModelsCache = { models: null, at: 0, revision };
    caches.providerModelsPromise = null;
    caches.searchProviderModelsCache = { models: null, at: 0, revision };
    modelMetaByRoute.clear();
    return revision;
  }
  function profile(event, fields = {}) {
    if (!PROVIDER_MODELS_PROFILE_ENABLED) return;
    bootProfile(`provider-models:${event}`, fields);
  }

  function modelMetaKey(providerId, modelId) {
    return `${clean(providerId)}\n${clean(modelId)}`;
  }

  async function lookupModelMeta(providerId, modelId, { allowFetch = false } = {}) {
    syncCatalogRevision();
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
    const saved = modelSettingsFor(cfg, row.provider, row.id);
    return {
      ...row,
      effortOptions: effortItemsFor(row.provider, row, null),
      fastCapable: fastCapableFor(row.provider, row),
      fastPreferred: Object.prototype.hasOwnProperty.call(saved, 'fast')
        ? saved.fast === true
        : (row.defaultFast === true || fastPreferenceFor(cfg, row.provider, row.id)),
      savedEffort: saved.effort || null,
      savedFast: Object.prototype.hasOwnProperty.call(saved, 'fast') ? saved.fast === true : undefined,
      savedModelParameters: saved.modelParameters || {},
    };
  }

  const sortProviderModels = (models) => sortProviderModelsRaw(models, route().provider);
  const providerModelCacheRow = (name, m) => providerModelCacheRowRaw(name, m, searchCapableFor);

  function providerModelsFromCacheRows(rows) {
    return sortProviderModels((rows || []).map(hydrateProviderModelRow));
  }

  async function enabledSearchProviderConfig() {
    await awaitKeychainPrewarm();
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
    const searchProviders = await enabledSearchProviderConfig();
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
    if (loadSecrets) {
      await awaitKeychainPrewarm();
      ensureFullConfig();
    }
    const providersStartedAt = performance.now();
    await ensureProvidersReady(config().providers || {});
    profile('providers-ready', { ms: (performance.now() - providersStartedAt).toFixed(1) });
    // ensureProvidersReady starts the daemon-wide force refresh without
    // blocking boot. A foreground full picker load must join that refresh;
    // otherwise it can snapshot yesterday's provider cache moments before the
    // refresh invalidates it, leaving the UI on the stale first-open rows.
    if (!forceRefresh && typeof reg().refreshProviderCatalogsOnStartup === 'function') {
      await reg().refreshProviderCatalogsOnStartup();
    }
    if (forceRefresh && typeof reg().refreshCatalogs === 'function') {
      await reg().refreshCatalogs({ force: true });
    }
    syncCatalogRevision();
    const catalogEntries = await sharedProviderCatalog(reg());
    const providerResults = catalogEntries.map(({ name, models, error, ms }) => {
      const rows = [];
      for (const m of models) {
        if (!m?.id || !isSelectableLlmModel(m)) continue;
        rows.push(providerModelCacheRow(name, m));
      }
      profile(error ? 'provider:failed' : 'provider:done', {
        provider: name,
        ms: Number(ms || 0).toFixed(1),
        models: models.length,
        rows: rows.length,
        ...(error ? { error: error?.message || String(error) } : {}),
      });
      return rows;
    });
    const results = [];
    const seen = new Set();
    for (const row of providerResults.flat()) {
      const key = `${row.provider}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
      modelMetaByRoute.set(modelMetaKey(row.provider, row.id), row);
    }
    profile('load:done', { ms: (performance.now() - startedAt).toFixed(1), providers: catalogEntries.length, rows: results.length });
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
    const revision = syncCatalogRevision();
    if (!force && Array.isArray(caches.searchProviderModelsCache.models)) {
      return providerModelsFromCacheRows(quickHelpers.searchRowsWithDefault(caches.searchProviderModelsCache.models));
    }
    if (!force && Array.isArray(caches.providerModelsCache.models)) {
      const rows = quickHelpers.searchRowsWithDefault(quickHelpers.searchModelsFromRows(caches.providerModelsCache.models));
      caches.searchProviderModelsCache = { models: rows, at: Date.now(), revision };
      return providerModelsFromCacheRows(rows);
    }
    if (!force) {
      const rows = quickHelpers.searchRowsWithDefault(quickHelpers.quickSearchProviderModelRows());
      caches.searchProviderModelsCache = { models: rows, at: Date.now(), revision };
      return providerModelsFromCacheRows(rows);
    }
    if (force) {
      const models = await loadSearchProviderModelsFresh({ forceRefresh: true });
      caches.searchProviderModelsCache = { models, at: Date.now(), revision: catalogRevision(reg()) };
      return providerModelsFromCacheRows(models);
    }
  }

  async function collectProviderModels({ force = false, quick = false } = {}) {
    syncCatalogRevision();
    if (!force && Array.isArray(caches.providerModelsCache.models)) {
      return providerModelsFromCacheRows(caches.providerModelsCache.models);
    }
    if (!force && quick) {
      // A user-facing quick read seeds the authoritative secrets-aware load.
      // Desktop asks quick first and full second; a no-secrets warm here made
      // the full request join a partial catalog and only recover on re-entry.
      warmProviderModelCache({ loadSecrets: true });
      return quickHelpers.quickProviderModelRows();
    }
    if (force) {
      const seq = ++caches.providerModelsLoadSeq;
      const models = await loadProviderModelsFresh({ forceRefresh: true, loadSecrets: true });
      if (seq === caches.providerModelsLoadSeq) {
        caches.providerModelsCache = { models, at: Date.now(), revision: catalogRevision(reg()) };
      }
      return providerModelsFromCacheRows(models);
    }
    if (!caches.providerModelsPromise) {
      const seq = ++caches.providerModelsLoadSeq;
      caches.providerModelsPromise = loadProviderModelsFresh({ loadSecrets: true })
        .then((models) => {
          if (seq === caches.providerModelsLoadSeq && shouldAdoptProviderModelCache(models, { loadSecrets: true })) {
            caches.providerModelsCache = { models, at: Date.now(), revision: catalogRevision(reg()) };
          }
          return models;
        })
        .finally(() => {
          caches.providerModelsPromise = null;
        });
    }
    return providerModelsFromCacheRows(await caches.providerModelsPromise);
  }

  function warmProviderModelCache({ loadSecrets = false } = {}) {
    syncCatalogRevision();
    if (Array.isArray(caches.providerModelsCache.models) || caches.providerModelsPromise) return caches.providerModelsPromise;
    profile('warm:start');
    const seq = ++caches.providerModelsLoadSeq;
    caches.providerModelsPromise = loadProviderModelsFresh({ loadSecrets })
      .then((models) => {
        if (seq === caches.providerModelsLoadSeq && shouldAdoptProviderModelCache(models, { loadSecrets })) {
          caches.providerModelsCache = { models, at: Date.now(), revision: catalogRevision(reg()) };
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
