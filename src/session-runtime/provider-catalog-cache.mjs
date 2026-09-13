// Provider registries are process-global. Share raw catalog rows across
// sessions, while each session owns its saved-settings projection.
let sharedCatalogRevision = -1;
let sharedCatalogEntries = null;
let sharedCatalogPromise = null;
let sharedCatalogPromiseRevision = -1;

export function catalogRevision(registry) {
  const value = Number(registry?.providerCatalogRevision?.());
  return Number.isFinite(value) ? value : 0;
}

export async function sharedProviderCatalog(registry) {
  const revision = catalogRevision(registry);
  if (sharedCatalogRevision === revision && Array.isArray(sharedCatalogEntries)) {
    return sharedCatalogEntries;
  }
  if (sharedCatalogPromise && sharedCatalogPromiseRevision === revision) {
    return await sharedCatalogPromise;
  }
  const providers = [...registry.getAllProviders()];
  sharedCatalogPromiseRevision = revision;
  const request = Promise.all(providers.map(async ([name, provider]) => {
    if (typeof provider?.listModels !== 'function') return { name, models: [], ms: 0 };
    const startedAt = performance.now();
    try {
      const models = await provider.listModels();
      return { name, models: Array.isArray(models) ? models : [], ms: performance.now() - startedAt };
    } catch (error) {
      return { name, models: [], error, ms: performance.now() - startedAt };
    }
  })).then((entries) => {
    if (sharedCatalogPromise === request && catalogRevision(registry) === revision) {
      sharedCatalogRevision = revision;
      sharedCatalogEntries = entries;
    }
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
