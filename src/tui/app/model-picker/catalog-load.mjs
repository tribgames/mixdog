// model-picker/catalog-load.mjs
// Where the picker's model rows come from: the UI cache, a quick-then-full
// load, or a forced refresh — and the freshness policy that refreshes a stale
// cache in the background for the NEXT open.

// Cached picker opens stay instant, but a catalog older than this is treated as
// stale: cached rows render immediately and a background force refresh updates
// the picker in place. Avoids the "stale /model & /agents catalog" without
// paying a remote provider-list round-trip on every open.
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

export function createModelCatalog({ store, providerModelsCacheRef, webSearchModelsCacheRef }) {
  let providerModelsTtlRefreshPromise = null;

  // A saved route changes each row's remembered effort/Fast, never the catalog
  // itself. Dropping the cached rows after a save forced the NEXT open to paint
  // a "Loading models..." panel before the list (the picker looked like it
  // closed and reopened). Marking them stale keeps that open instant — cached
  // rows paint at once — and the TTL path force-refreshes in the background.
  const markModelCatalogStale = () => {
    for (const ref of [providerModelsCacheRef, webSearchModelsCacheRef]) {
      const models = Array.isArray(ref?.current?.models) ? ref.current.models : null;
      if (models && models.length > 0) ref.current = { models, at: 0 };
    }
  };

  /** Resolves the rows to paint. `paintLoading` runs when a load is needed.
   *  Returns null after a reported load failure. */
  const loadCatalog = async (options, paintLoading) => {
    const cacheRef = options.cacheRef === 'webSearch' ? webSearchModelsCacheRef : providerModelsCacheRef;
    const loadModels = typeof options.loadModels === 'function' ? options.loadModels : store.listProviderModels;
    let providerModels = Array.isArray(cacheRef.current.models) ? cacheRef.current.models : [];
    let refreshModelsPromise = null;
    let renderedQuickModels = false;
    if (!providerModels.length || options.refreshModels === true) {
      paintLoading();
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        if (options.refreshModels !== true && options.cacheRef !== 'webSearch') {
          refreshModelsPromise = Promise.resolve(loadModels({ force: false }));
          providerModels = await loadModels({ quick: true });
          renderedQuickModels = Array.isArray(providerModels) && providerModels.length > 0;
          if (!renderedQuickModels) {
            providerModels = await refreshModelsPromise;
          }
        } else {
          providerModels = await loadModels({ force: options.refreshModels === true });
        }
        cacheRef.current = { models: providerModels, at: Date.now() };
      } catch (e) {
        store.pushNotice(`could not list models: ${e?.message || e}`, 'error');
        return null;
      }
    }
    // Served straight from a non-empty UI cache: if that cache is older than the
    // TTL, render the cached rows now and quietly force a background refresh so
    // the catalog can't drift stale. Never applies to the web-search cache (its own
    // quick paths refresh differently) or explicit refreshModels opens.
    const cacheAt = Number(cacheRef.current.at) || 0;
    const cacheIsStale =
      providerModels.length > 0 &&
      options.refreshModels !== true &&
      options.cacheRef !== 'webSearch' &&
      !refreshModelsPromise &&
      Date.now() - cacheAt > MODEL_CACHE_TTL_MS;
    return { cacheRef, loadModels, providerModels, refreshModelsPromise, renderedQuickModels, cacheIsStale };
  };

  // Freshness policy: an open picker keeps the catalog it first rendered.
  // Background refreshes only update the cache, so fresh rows apply on the
  // NEXT open (re-entry) instead of re-sorting the list mid-selection.
  const scheduleBackgroundRefresh = ({
    cacheRef,
    loadModels,
    refreshModelsPromise,
    renderedQuickModels,
    cacheIsStale,
  }) => {
    const adoptFreshModels = (freshModels) => {
      if (!Array.isArray(freshModels) || freshModels.length === 0) return;
      cacheRef.current = { models: freshModels, at: Date.now() };
    };
    if (renderedQuickModels && refreshModelsPromise) {
      void refreshModelsPromise.then(adoptFreshModels).catch(() => {});
    } else if (cacheIsStale) {
      if (!providerModelsTtlRefreshPromise) {
        providerModelsTtlRefreshPromise = Promise.resolve(loadModels({ force: true }))
          .then((freshModels) => {
            adoptFreshModels(freshModels);
            return freshModels;
          })
          .finally(() => {
            providerModelsTtlRefreshPromise = null;
          });
      }
      void providerModelsTtlRefreshPromise.catch(() => {});
    }
  };

  return { markModelCatalogStale, loadCatalog, scheduleBackgroundRefresh };
}
