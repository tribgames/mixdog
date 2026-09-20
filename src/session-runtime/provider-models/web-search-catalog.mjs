// provider-models/web-search-catalog.mjs
// The native web-search model list: which enabled providers can search, a
// fresh scan of their catalogs, and the cached read that prefers quick rows or
// the already-loaded provider rows over a provider round-trip.
import { isSelectableLlmModel } from '../model-recency.mjs';
import { catalogRevision } from '../provider-catalog-cache.mjs';

export function createWebSearchCatalog({
  caches,
  config,
  reg,
  meta,
  rows,
  quickHelpers,
  normalizeWebSearchProviderId,
  isWebSearchCapableProvider,
  ensureFullConfig,
  awaitKeychainPrewarm,
  ensureProvidersReady,
}) {
  async function enabledWebSearchProviderConfig() {
    await awaitKeychainPrewarm();
    ensureFullConfig();
    const out = {};
    for (const [name, providerConfig] of Object.entries(config().providers || {})) {
      const providerName = normalizeWebSearchProviderId(name);
      if (!providerConfig?.enabled || !isWebSearchCapableProvider(providerName)) continue;
      out[providerName] = { ...providerConfig, enabled: true };
    }
    return out;
  }

  /** One provider's search-capable rows. A transient catalog/auth failure
   *  yields [] so the picker stays responsive. */
  async function scanProvider(name, { forceRefresh }) {
    const provider = reg().getProvider(name);
    if (typeof provider?.listModels !== 'function') return [];
    try {
      let models = null;
      if (forceRefresh && typeof provider._refreshModelCache === 'function') {
        models = await provider._refreshModelCache();
      }
      if (!Array.isArray(models)) models = await provider.listModels();
      if (!Array.isArray(models)) return [];
      const out = [];
      for (const m of models) {
        if (!m?.id || !isSelectableLlmModel(m)) continue;
        const row = rows.providerModelCacheRow(name, m);
        if (row.supportsWebSearch !== true) continue;
        out.push({
          ...row,
          provider: normalizeWebSearchProviderId(row.provider),
          webSearchCapable: true,
          webSearchToolType: row.webSearchToolType || 'web_search',
        });
        meta.remember(name, m.id, row);
      }
      return out;
    } catch {
      return [];
    }
  }

  async function loadWebSearchProviderModelsFresh({ forceRefresh = false } = {}) {
    const webSearchProviders = await enabledWebSearchProviderConfig();
    const providerNames = Object.keys(webSearchProviders);
    if (!providerNames.length) return [];
    await ensureProvidersReady(config().providers || {});
    const providerResults = await Promise.all(providerNames.map((name) => scanProvider(name, { forceRefresh })));
    const results = [];
    const seen = new Set();
    quickHelpers.addDefaultWebSearchModel(results, seen);
    for (const row of providerResults.flat()) {
      const key = `${normalizeWebSearchProviderId(row.provider)}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(row);
    }
    return results;
  }

  function adoptCachedRows(cachedRows, revision) {
    caches.webSearchProviderModelsCache = { models: cachedRows, at: Date.now(), revision };
    return rows.providerModelsFromCacheRows(cachedRows);
  }

  async function collectWebSearchProviderModels({ force = false } = {}) {
    const revision = meta.syncCatalogRevision();
    if (force) {
      const models = await loadWebSearchProviderModelsFresh({ forceRefresh: true });
      return adoptCachedRows(models, catalogRevision(reg()));
    }
    if (Array.isArray(caches.webSearchProviderModelsCache.models)) {
      return rows.providerModelsFromCacheRows(
        quickHelpers.webSearchRowsWithDefault(caches.webSearchProviderModelsCache.models)
      );
    }
    if (Array.isArray(caches.providerModelsCache.models)) {
      return adoptCachedRows(
        quickHelpers.webSearchRowsWithDefault(quickHelpers.webSearchModelsFromRows(caches.providerModelsCache.models)),
        revision
      );
    }
    return adoptCachedRows(
      quickHelpers.webSearchRowsWithDefault(quickHelpers.quickWebSearchProviderModelRows()),
      revision
    );
  }

  return { enabledWebSearchProviderConfig, loadWebSearchProviderModelsFresh, collectWebSearchProviderModels };
}
