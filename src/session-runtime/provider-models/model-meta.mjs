// provider-models/model-meta.mjs
// Per-route model metadata keyed by (provider, model), and the catalog
// revision that decides when every provider-derived cache must be dropped.
import { clean } from '../session-text.mjs';
import { catalogRevision } from '../provider-catalog-cache.mjs';

export function modelMetaKey(providerId, modelId) {
  return `${clean(providerId)}\n${clean(modelId)}`;
}

export function createModelMetaIndex({ caches, modelMetaByRoute, reg, scheduleProviderModelWarmup }) {
  let observedCatalogRevision = catalogRevision(reg());

  /** Invalidates the provider caches when the registry's catalog moved on;
   *  returns the current revision either way. */
  function syncCatalogRevision() {
    const revision = catalogRevision(reg());
    if (revision === observedCatalogRevision) return revision;
    observedCatalogRevision = revision;
    caches.providerModelsLoadSeq += 1;
    caches.providerModelsCache = { models: null, at: 0, revision };
    caches.providerModelsPromise = null;
    caches.webSearchProviderModelsCache = { models: null, at: 0, revision };
    modelMetaByRoute.clear();
    return revision;
  }

  /** A load that started under (revision, seq) may only write metadata while
   *  both are still current. */
  function snapshotIsCurrent(revision, seq) {
    return revision === catalogRevision(reg()) && seq === caches.providerModelsLoadSeq;
  }

  function remember(providerId, modelId, meta) {
    modelMetaByRoute.set(modelMetaKey(providerId, modelId), meta);
  }

  async function lookupModelMeta(providerId, modelId, { allowFetch = false } = {}) {
    const revision = syncCatalogRevision();
    const seq = caches.providerModelsLoadSeq;
    const key = modelMetaKey(providerId, modelId);
    if (modelMetaByRoute.has(key)) return modelMetaByRoute.get(key);
    const fallback = () => ({ id: modelId, provider: providerId });
    const providerImpl = reg().getProvider(providerId);
    if (!providerImpl || typeof providerImpl.listModels !== 'function') {
      const meta = fallback();
      modelMetaByRoute.set(key, meta);
      return meta;
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
      const meta = fallback();
      modelMetaByRoute.set(key, meta);
      scheduleProviderModelWarmup();
      return meta;
    }
    try {
      const models = await providerImpl.listModels();
      const found = Array.isArray(models) ? models.find((m) => m?.id === modelId) : null;
      const meta = found || fallback();
      if (snapshotIsCurrent(revision, seq)) modelMetaByRoute.set(key, meta);
      return meta;
    } catch {
      // A failed fetch is not authoritative: nothing is pinned.
      return fallback();
    }
  }

  return { syncCatalogRevision, snapshotIsCurrent, remember, lookupModelMeta };
}
