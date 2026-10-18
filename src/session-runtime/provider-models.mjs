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
import { PROVIDER_CATALOG_RETRY_MS } from './provider-catalog-cache.mjs';
import { createCatalogLoader } from './provider-models/catalog-load.mjs';
import { createModelMetaIndex, modelMetaKey } from './provider-models/model-meta.mjs';
import { createRowHydration } from './provider-models/row-hydration.mjs';
import { createWebSearchCatalog } from './provider-models/web-search-catalog.mjs';

const PROVIDER_MODELS_PROFILE_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.MIXDOG_PROVIDER_MODELS_PROFILE || process.env.MIXDOG_BOOT_PROFILE || '')
);

/** How long a partial catalog (some provider failed or timed out) is served
 *  as-is before a read retries the missing providers in the background. The
 *  backoff is process-wide (provider-catalog-cache.mjs), not per session. */
export const PARTIAL_CATALOG_RETRY_MS = PROVIDER_CATALOG_RETRY_MS;

/** Rows of a partial answer say so explicitly, on quick and full reads alike:
 *  `catalogPartial`, the `catalogMissing` providers and `catalogRetryAt`
 *  (epoch ms) after which a reader should ask again. Complete answers carry
 *  none of these. */
function withCatalogState(models, partial) {
  if (!partial) return models;
  return models.map((row) => ({
    ...row,
    catalogPartial: true,
    catalogMissing: [...partial.missing],
    catalogRetryAt: partial.retryAt,
  }));
}

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
  // Per-provider model-list bound; defaults to PROVIDER_CATALOG_TIMEOUT_MS.
  providerCatalogTimeoutMs,
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
    collectProviderModels,
    ...readiness,
  });
  const loadProviderModelsFresh = createCatalogLoader({
    caches,
    config,
    reg,
    meta,
    rows,
    profile,
    providerTimeoutMs: providerCatalogTimeoutMs,
    ...readiness,
  });

  // Partial-catalog state of a loaded rows array, for readers that joined the
  // shared load instead of reading the adopted cache.
  const partialLoads = new WeakMap();
  const partialOf = (request) => (request.partial ? { missing: request.missing, retryAt: request.retryAt } : null);

  function adoptProviderModelCache(models, request, loadSecrets = true) {
    const revision = meta.syncCatalogRevision();
    const partial = partialOf(request);
    if (partial) partialLoads.set(models, partial);
    if (request.seq !== caches.providerModelsLoadSeq || !loadSecrets) return;
    const at = Date.now();
    if (request.complete) {
      caches.providerModelsCache = { models, at, revision };
    } else if (partial) {
      // Some providers answered. Serving that answer beats reloading every
      // provider on each read while one is down; it stays marked partial and
      // its missing providers are retried once the shared backoff passes. A
      // no-secrets, empty or all-failed load stays uncached and retryable
      // rather than becoming an authoritative empty catalog.
      caches.providerModelsCache = { models, at, revision, partial: true, ...partial };
    }
  }

  /** Background refill of a partial catalog: only its missing providers are
   *  asked again (provider-catalog-cache keeps the ones that answered, and
   *  holds back providers still inside the shared backoff), and readers keep
   *  the partial rows until the refill lands. */
  function refillPartialCatalog(cached) {
    if (!cached.partial || Date.now() < cached.retryAt || caches.providerModelsPromise) return;
    profile('partial:retry', { missing: cached.missing.join(',') });
    startSharedLoad({
      loadSecrets: true,
      onFailed: (err) => {
        profile('partial:retry-failed', { error: err instanceof Error ? err.message : String(err) });
        return cached.models;
      },
    });
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
    const cached = caches.providerModelsCache;
    if (!force && Array.isArray(cached.models)) {
      refillPartialCatalog(cached);
      const models = rows.providerModelsFromCacheRows(cached.models);
      // A quick read answered from the loaded catalog already IS the full
      // catalog. Saying so lets a caller skip the full read it would otherwise
      // follow up with (a phone paid the whole catalog twice at boot). Only
      // this answer carries the mark: a full read is complete by definition,
      // and an unmarked quick answer keeps meaning "follow up". A partial
      // catalog is never marked complete; it carries its partial state.
      if (cached.partial) return withCatalogState(models, cached);
      return quick ? models.map((row) => ({ ...row, catalogComplete: true })) : models;
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
      return withCatalogState(rows.providerModelsFromCacheRows(models), partialOf(request));
    }
    if (!caches.providerModelsPromise) startSharedLoad({ loadSecrets: true });
    const loaded = await caches.providerModelsPromise;
    return withCatalogState(rows.providerModelsFromCacheRows(loaded), partialLoads.get(loaded));
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
