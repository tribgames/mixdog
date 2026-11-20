import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopModelOption } from '../shared/contract';
import { isDesktopProvidersUnavailableError, useDesktopProvidersRetry } from './desktop-provider-retry';
import {
  SHARED_MODEL_CATALOG_MAX_AGE_MS,
  invalidateSharedModelCatalogRequest,
  readCachedModelCatalog,
  requestModelCatalog,
  subscribeModelCatalogInvalidation,
} from './model-catalog-cache';

/** The provider model catalog and setup a route control shows: seeded from the
 *  cached catalog, refreshed once on mount and every day after, and re-read
 *  whenever the shared request is invalidated. */
export function useProviderModelCatalog() {
  const [cachedCatalog] = useState(readCachedModelCatalog);
  const [models, setModels] = useState<DesktopModelOption[]>(cachedCatalog.models);
  const [providerSetup, setProviderSetup] = useState<unknown>(null);
  const [catalogError, setCatalogError] = useState('');
  const [providerSetupError, setProviderSetupError] = useState('');
  // A server window whose desktop proxy is away retries on the shared cadence.
  const [desktopProvidersAway, setDesktopProvidersAway] = useState(false);
  const [catalogLoaded, setCatalogLoaded] = useState(cachedCatalog.models.length > 0);
  const [startupCatalogSettled, setStartupCatalogSettled] = useState(cachedCatalog.models.length > 0);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const catalogInFlight = useRef<Promise<void> | null>(null);
  const loadCatalog = useCallback(async (force = false) => {
    if (!force && catalogInFlight.current) return catalogInFlight.current;
    const api = window.mixdogDesktop;
    if (!api?.listProviderModels) {
      setCatalogLoaded(true);
      setStartupCatalogSettled(true);
      return;
    }
    const request = (async () => {
      setCatalogRefreshing(true);
      setCatalogError('');
      setProviderSetupError('');
      setDesktopProvidersAway(false);
      const shared = requestModelCatalog(api);
      let fullApplied = false;
      const setupRequest = shared.setup
        .then((setup) => {
          if (shared.isCurrent()) setProviderSetup(setup);
        })
        .catch((reason) => {
          if (!shared.isCurrent()) return;
          console.warn('[model-catalog] provider setup refresh failed', reason);
          setProviderSetupError('unavailable');
          setDesktopProvidersAway(isDesktopProvidersUnavailableError(reason));
        });
      const fullRequest = shared.full
        .then((full) => {
          if (!shared.isCurrent() || !Array.isArray(full)) return;
          fullApplied = true;
          // An empty answer is a retryable boot miss: keep the list on screen
          // until the retry brings a real one.
          setModels((current) => (full.length === 0 && current.length > 0 ? current : full));
          setCatalogError('');
        })
        .catch((reason) => {
          if (!shared.isCurrent()) return;
          // The quick or persisted catalog stays usable. A background refresh
          // failure must not become a boot-time error surface.
          console.warn('[model-catalog] full catalog refresh failed', reason);
        })
        .finally(() => {
          if (!shared.isCurrent()) return;
          setCatalogRefreshing(false);
          setStartupCatalogSettled(true);
        });
      try {
        const quick = await shared.quick;
        // A reused shared request may already have resolved both answers.
        // Its thin quick rows must not overwrite the full catalog above.
        if (shared.isCurrent() && !fullApplied && Array.isArray(quick) && quick.length > 0) {
          setModels((current) => {
            const merged = new Map(current.map((option) => [`${option.provider}:${option.model}`, option]));
            for (const option of quick) {
              merged.set(`${option.provider}:${option.model}`, option);
            }
            return [...merged.values()];
          });
        }
      } catch (reason) {
        if (!shared.isCurrent()) return;
        console.warn('[model-catalog] quick catalog refresh failed', reason);
        setCatalogError(reason instanceof Error ? reason.message : String(reason || 'Model catalog failed.'));
      } finally {
        if (shared.isCurrent()) {
          setCatalogLoaded(true);
        }
      }
      void Promise.allSettled([fullRequest, setupRequest]);
    })().finally(() => {
      if (catalogInFlight.current === request) catalogInFlight.current = null;
    });
    catalogInFlight.current = request;
    return request;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (cancelled) return;
      refreshTimer = window.setTimeout(async () => {
        await loadCatalog();
        scheduleRefresh();
      }, SHARED_MODEL_CATALOG_MAX_AGE_MS);
    };
    void loadCatalog().then(scheduleRefresh);
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
    // One boot request and one 24h timer per mounted control (loadCatalog is
    // stable). The module-level request and daemon catalog epoch deduplicate
    // panes and sessions.
  }, [loadCatalog]);

  useEffect(
    () =>
      subscribeModelCatalogInvalidation(() => {
        void loadCatalog(true);
      }),
    [loadCatalog]
  );

  useDesktopProvidersRetry(desktopProvidersAway, invalidateSharedModelCatalogRequest);

  return {
    models,
    setModels,
    providerSetup,
    setProviderSetup,
    catalogError,
    providerSetupError,
    catalogLoaded,
    startupCatalogSettled,
    catalogRefreshing,
    loadCatalog,
  };
}
