// provider-models/catalog-load.mjs
// One authoritative provider catalog load: secrets and providers ready, the
// daemon-wide startup refresh joined (or a forced refresh run), then the shared
// catalog flattened into deduplicated rows with per-provider profiling.
import { isSelectableLlmModel } from '../model-recency.mjs';
import { sharedProviderCatalog } from '../provider-catalog-cache.mjs';

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
   *  refresh invalidates it, leaving the UI on the stale first-open rows. */
  async function prepare({ forceRefresh, loadSecrets }) {
    if (loadSecrets) {
      const secretsStartedAt = performance.now();
      await awaitKeychainPrewarm();
      ensureFullConfig();
      profile('secrets-ready', { ms: (performance.now() - secretsStartedAt).toFixed(1) });
    }
    const providersStartedAt = performance.now();
    await ensureProvidersReady(config().providers || {});
    profile('providers-ready', { ms: (performance.now() - providersStartedAt).toFixed(1) });
    const refreshStartedAt = performance.now();
    if (!forceRefresh && typeof reg().refreshProviderCatalogsOnStartup === 'function') {
      await reg().refreshProviderCatalogsOnStartup();
    }
    if (forceRefresh && typeof reg().refreshCatalogs === 'function') {
      await reg().refreshCatalogs({ force: true });
    }
    profile('catalog-refresh-ready', { ms: (performance.now() - refreshStartedAt).toFixed(1) });
  }

  /** `request` ({ seq }) identifies the caller's load; `request.complete`
   *  reports whether every provider answered. */
  return async function loadProviderModelsFresh({ forceRefresh = false, loadSecrets = true, request = null } = {}) {
    const startedAt = performance.now();
    profile('load:start', { forceRefresh, loadSecrets });
    await prepare({ forceRefresh, loadSecrets });
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
      results.push(row);
      if (meta.snapshotIsCurrent(revision, seq)) meta.remember(row.provider, row.id, row);
    }
    profile('load:done', {
      ms: (performance.now() - startedAt).toFixed(1),
      providers: catalogEntries.length,
      rows: results.length,
    });
    return results;
  };
}
