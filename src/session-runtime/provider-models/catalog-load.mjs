// provider-models/catalog-load.mjs
// One authoritative provider catalog load: secrets and providers ready, the
// daemon-wide startup refresh joined (or a forced refresh run), then the shared
// catalog flattened into deduplicated rows with per-provider profiling.
import { modelProxyClientMode } from '../../runtime/shared/model-proxy-mode.mjs';
import { isSelectableLlmModel } from '../model-recency.mjs';
import { sharedProviderCatalog } from '../provider-catalog-cache.mjs';
import { NO_ENABLED_PROVIDERS } from '../../runtime/agent/orchestrator/providers/registry-errors.mjs';

export function createCatalogLoader({
  caches,
  config,
  reg,
  meta,
  rows,
  profile,
  ensureFullConfig,
  awaitKeychainPrewarm,
  ensureProvidersReady,
}) {
  function rowsForEntry({ name, models, error, ms }) {
    const out = [];
    for (const m of models) {
      if (!m?.id || !isSelectableLlmModel(m)) continue;
      out.push(rows.providerModelCacheRow(name, m));
    }
    profile(error ? 'provider:failed' : 'provider:done', {
      provider: name,
      ms: Number(ms || 0).toFixed(1),
      models: models.length,
      rows: out.length,
      ...(error ? { error: error?.message || String(error) } : {}),
    });
    return out;
  }

  /** Secrets, provider readiness and the catalog refresh a load must wait
   *  for. ensureProvidersReady starts the daemon-wide force refresh without
   *  blocking boot; a foreground full picker load must join that refresh,
   *  otherwise it can snapshot yesterday's provider cache moments before the
   *  refresh invalidates it, leaving the UI on the stale first-open rows.
   *  Resolves false when no provider is enabled: a fresh install has nothing
   *  to load, and the registry refuses an all-disabled init by design. */
  async function prepare({ forceRefresh, loadSecrets }) {
    if (loadSecrets) {
      const secretsStartedAt = performance.now();
      await awaitKeychainPrewarm();
      ensureFullConfig();
      profile('secrets-ready', { ms: (performance.now() - secretsStartedAt).toFixed(1) });
    }
    const providersStartedAt = performance.now();
    try {
      if (forceRefresh && modelProxyClientMode()) {
        const { loadModelProxyProviderConfig } = await import(
          '../../runtime/agent/orchestrator/providers/model-proxy-provider.mjs'
        );
        await loadModelProxyProviderConfig({ force: true });
        // Rebuild even when daemon readiness already settled on the old PC set.
        await reg().initProviders({});
      }
      await ensureProvidersReady(config().providers || {});
    } catch (error) {
      if (error?.code === NO_ENABLED_PROVIDERS) return false;
      throw error;
    }
    profile('providers-ready', { ms: (performance.now() - providersStartedAt).toFixed(1) });
    const refreshStartedAt = performance.now();
    if (!forceRefresh && typeof reg().refreshProviderCatalogsOnStartup === 'function') {
      await reg().refreshProviderCatalogsOnStartup();
    }
    if (forceRefresh && typeof reg().refreshCatalogs === 'function') {
      await reg().refreshCatalogs({ force: true });
    }
    profile('catalog-refresh-ready', { ms: (performance.now() - refreshStartedAt).toFixed(1) });
    return true;
  }

  /** `request` ({ seq }) identifies the caller's load; `request.complete`
   *  reports whether every provider answered. */
  return async function loadProviderModelsFresh({ forceRefresh = false, loadSecrets = true, request = null } = {}) {
    const startedAt = performance.now();
    profile('load:start', { forceRefresh, loadSecrets });
    // No enabled provider is an empty catalog, not a failure. The request
    // stays incomplete so this answer is never cached: connecting a provider
    // is picked up by the next read.
    if (!(await prepare({ forceRefresh, loadSecrets }))) {
      profile('load:done', { ms: (performance.now() - startedAt).toFixed(1), providers: 0, rows: 0 });
      return [];
    }
    const ownsLoad = request !== null && request.seq === caches.providerModelsLoadSeq;
    const revision = meta.syncCatalogRevision();
    // Preparation may legitimately refresh the catalog. Carry that revision
    // forward only for the still-current request, never for a superseded load.
    if (ownsLoad) request.seq = caches.providerModelsLoadSeq;
    const seq = request?.seq ?? caches.providerModelsLoadSeq;
    const catalogEntries = await sharedProviderCatalog(reg());
    if (request) request.complete = catalogEntries.every((entry) => !Object.hasOwn(entry, 'error'));
    const results = [];
    const seen = new Set();
    for (const row of catalogEntries.flatMap(rowsForEntry)) {
      const key = `${row.provider}:${row.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (meta.snapshotIsCurrent(revision, seq)) meta.remember(row.provider, row.id, row);
      // A hidden custom model leaves the picker; its metadata still resolves
      // for sessions and saved routes already on it.
      if (row.hidden !== true) results.push(row);
    }
    profile('load:done', {
      ms: (performance.now() - startedAt).toFixed(1),
      providers: catalogEntries.length,
      rows: results.length,
    });
    return results;
  };
}
