// Provider/web-search model catalog + cache glue.
// Dependency-injected factory following the
// createWarmupSchedulers/createNativeWebSearch pattern: mutable cache state lives
// in a caller-owned `caches` object (so the facade's invalidateProviderCaches
// teardown still sees the same references) and all route/config/registry reads
// go through supplied accessors so live-binding is preserved (no stale
// snapshot of route/config/webSearchRoute). This module owns the cache
// lifecycle (collect / warm / adopt); the pieces live under ./provider-models/:
//   model-meta         — per-route metadata + catalog revision invalidation
//   row-hydration      — saved model settings layered onto catalog rows
//   web-search-catalog — the native web-search model list
//   catalog-load       — one authoritative provider catalog load
import { createCatalogLoader } from './provider-models/catalog-load.mjs';
import { createModelMetaIndex, modelMetaKey } from './provider-models/model-meta.mjs';
import { createRowHydration } from './provider-models/row-hydration.mjs';
import { createWebSearchCatalog } from './provider-models/web-search-catalog.mjs';

const PROVIDER_MODELS_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.MIXDOG_PROVIDER_MODELS_PROFILE || process.env.MIXDOG_BOOT_PROFILE || '')
);

export function createProviderModels({
  caches,
  modelMetaByRoute,
  getRoute,
  getConfig,
  getReg,
  webSearchCapableFor,
  sortProviderModelsRaw,
  providerModelCacheRowRaw,
  normalizeWebSearchProviderId,
  isWebSearchCapableProvider,
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
  function profile(event, fields = {}) {
    if (!PROVIDER_MODELS_PROFILE_ENABLED) return;
    bootProfile(`provider-models:${event}`, fields);
  }
  const meta = createModelMetaIndex({ caches, modelMetaByRoute, reg, scheduleProviderModelWarmup });
  const rows = createRowHydration({
    config,
    route,
    sortProviderModelsRaw,
    providerModelCacheRowRaw,
    webSearchCapableFor,
  });
  const readiness = { ensureFullConfig, awaitKeychainPrewarm, ensureProvidersReady };
  const webSearch = createWebSearchCatalog({
    caches,
    config,
    reg,
    meta,
    rows,
    quickHelpers,
    normalizeWebSearchProviderId,
    isWebSearchCapableProvider,
    ...readiness,
  });
  const loadProviderModelsFresh = createCatalogLoader({ caches, config, reg, meta, rows, profile, ...readiness });

  function adoptProviderModelCache(models, request, loadSecrets = true) {
    const revision = meta.syncCatalogRevision();
    // No-secrets and failed loads may be partial. Keep them retryable rather
    // than turning a transient failure into an authoritative empty catalog.
    if (request.seq === caches.providerModelsLoadSeq && loadSecrets && request.complete) {
      caches.providerModelsCache = { models, at: Date.now(), revision };
    }
  }

  /** The shared in-flight load every concurrent reader joins. `onFailed`, when
   *  given, is part of the shared promise so joiners see its value too;
   *  `caches.providerModelsPromise` is cleared once it settles so a later read
   *  can start a fresh one. */
  function startSharedLoad({ loadSecrets, onLoaded = (models) => models, onFailed = null }) {
    const request = { seq: ++caches.providerModelsLoadSeq };
    const loaded = loadProviderModelsFresh({ loadSecrets, request }).then((models) => {
      adoptProviderModelCache(models, request, loadSecrets);
      return onLoaded(models);
    });
    const settled = onFailed ? loaded.catch(onFailed) : loaded;
    const promise = settled.finally(() => {
      if (caches.providerModelsPromise === promise) caches.providerModelsPromise = null;
    });
    caches.providerModelsPromise = promise;
    return promise;
  }

  async function collectProviderModels({ force = false, quick = false } = {}) {
    meta.syncCatalogRevision();
    if (!force && Array.isArray(caches.providerModelsCache.models)) {
      return rows.providerModelsFromCacheRows(caches.providerModelsCache.models);
    }
    if (!force && quick) {
      // A user-facing quick read seeds the authoritative secrets-aware load.
      // Desktop asks quick first and full second; a no-secrets warm here made
      // the full request join a partial catalog and only recover on re-entry.
      warmProviderModelCache({ loadSecrets: true });
      return quickHelpers.quickProviderModelRows();
    }
    if (force) {
      const request = { seq: ++caches.providerModelsLoadSeq };
      const models = await loadProviderModelsFresh({ forceRefresh: true, loadSecrets: true, request });
      adoptProviderModelCache(models, request);
      return rows.providerModelsFromCacheRows(models);
    }
    if (!caches.providerModelsPromise) startSharedLoad({ loadSecrets: true });
    return rows.providerModelsFromCacheRows(await caches.providerModelsPromise);
  }

  function warmProviderModelCache({ loadSecrets = false } = {}) {
    meta.syncCatalogRevision();
    if (Array.isArray(caches.providerModelsCache.models) || caches.providerModelsPromise)
      return caches.providerModelsPromise;
    profile('warm:start');
    return startSharedLoad({
      loadSecrets,
      onLoaded: (models) => {
        bootProfile('provider-models:warm-ready', { count: models.length });
        return models;
      },
      onFailed: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        bootProfile('provider-models:warm-failed', { error: msg });
        return [];
      },
    });
  }

  return {
    modelMetaKey,
    lookupModelMeta: meta.lookupModelMeta,
    hydrateProviderModelRow: rows.hydrateProviderModelRow,
    sortProviderModels: rows.sortProviderModels,
    providerModelCacheRow: rows.providerModelCacheRow,
    providerModelsFromCacheRows: rows.providerModelsFromCacheRows,
    enabledWebSearchProviderConfig: webSearch.enabledWebSearchProviderConfig,
    loadWebSearchProviderModelsFresh: webSearch.loadWebSearchProviderModelsFresh,
    loadProviderModelsFresh,
    collectWebSearchProviderModels: webSearch.collectWebSearchProviderModels,
    collectProviderModels,
    warmProviderModelCache,
  };
}
