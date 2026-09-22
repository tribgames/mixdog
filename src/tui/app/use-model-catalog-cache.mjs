/**
 * use-model-catalog-cache.mjs — the provider/web-search model catalogs the
 * pickers open from.
 *
 * Owns three things and nothing else: the two catalog caches, the generation
 * counter that makes an invalidation stick, and the boot-time warm-up. The
 * pickers read the refs; auth flows call clearModelCaches.
 *
 * Hook order note: the refs, the callback and the effect are declared here in
 * the same order App.jsx declared them, so this hook drops into the same
 * position in App.jsx's hook list.
 */
import { useCallback, useEffect, useRef } from 'react';

export function useModelCatalogCache({ store, onboardingRef }) {
  const providerModelsCacheRef = useRef({ models: null, at: 0 });
  const webSearchModelsCacheRef = useRef({ models: null, at: 0 });
  const modelPickerRequestRef = useRef(0);
  // Generation guard for the Step 1 background prefetch: bumped on every
  // provider-scope cache clear (e.g. after auth) so a stale in-flight
  // listProviderModels() cannot repopulate the ref after invalidation.
  const onboardingPrefetchSeqRef = useRef(0);
  const clearModelCaches = useCallback((scope = 'all') => {
    if (scope === 'all' || scope === 'provider') {
      providerModelsCacheRef.current = { models: null, at: 0 };
      onboardingRef.current.providerModels = [];
      onboardingPrefetchSeqRef.current += 1;
    }
    if (scope === 'all' || scope === 'webSearch') {
      webSearchModelsCacheRef.current = { models: null, at: 0 };
    }
  }, []);
  // Boot-time catalog prefetch: warm the /model & /agents provider catalog and
  // the /websearch catalog once at startup so those pickers open instantly from
  // cache (openModelPicker still TTL-refreshes stale rows in the background).
  // Provider models load first so the web-search catalog derives from the full
  // runtime cache instead of the sparse quick rows. Guarded by the same
  // generation seq as the onboarding prefetch so an auth-triggered
  // clearModelCaches() can't be clobbered by a stale in-flight result.
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      const seq = onboardingPrefetchSeqRef.current;
      try {
        const models = await Promise.resolve(store.listProviderModels?.() || []);
        if (
          alive &&
          seq === onboardingPrefetchSeqRef.current &&
          Array.isArray(models) &&
          models.length > 0 &&
          !Array.isArray(providerModelsCacheRef.current.models)
        ) {
          providerModelsCacheRef.current = { models, at: Date.now() };
        }
      } catch {
        /* prefetch is advisory; pickers fall back to their own load */
      }
      if (!alive) return;
      try {
        const webSearchModels = await Promise.resolve(store.listWebSearchModels?.() || []);
        if (
          alive &&
          Array.isArray(webSearchModels) &&
          webSearchModels.length > 0 &&
          !Array.isArray(webSearchModelsCacheRef.current.models)
        ) {
          webSearchModelsCacheRef.current = { models: webSearchModels, at: Date.now() };
        }
      } catch {
        /* prefetch is advisory; /websearch falls back to its own load */
      }
    }, 1500);
    timer.unref?.();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [store]);
  return {
    providerModelsCacheRef,
    webSearchModelsCacheRef,
    modelPickerRequestRef,
    onboardingPrefetchSeqRef,
    clearModelCaches,
  };
}
