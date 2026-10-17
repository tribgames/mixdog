/**
 * routes.mjs — which provider/model answers a native web search: the
 * configured web-search route, or the Main model when the route is the
 * follow-Main default.
 */
import { webSearchRouteOrDefault } from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { routeChain, canonicalRouteProvider } from '../../runtime/shared/model-route-chain.mjs';

export function createWebSearchRouteCandidates({
  getRoute,
  getReg,
  getWebSearchRoute,
  setWebSearchRoute,
  ensureFullConfig,
  awaitKeychainPrewarm,
  ensureProvidersReady,
  ensureProviderEnabled,
  normalizeWebSearchProviderId,
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  webSearchCapableFor,
}) {
  function currentMainWebSearchModelMeta(loadedRow = null) {
    const route = getRoute();
    if (!route?.provider || !route?.model) return null;
    // Capability comes from the provider's catalog row (supportedTools etc.),
    // not from the bare model id.
    const catalogRow = getReg()?.getProvider(route.provider)?.getCachedModelInfo?.(route.model) || loadedRow;
    return { ...catalogRow, ...route, id: route.model, display: route.model, name: route.model };
  }

  /** A cold catalog (fresh or model-proxy provider instance) is loaded once
   *  before the capability check, so it never falls back to the bare id.
   *  Returns the listed row, which carries the catalog fields even when the
   *  provider keeps no per-model cache. */
  async function loadMainCatalogRow(cfg, route) {
    await ensureProvidersReady(ensureProviderEnabled(cfg, route.provider));
    const provider = getReg().getProvider(route.provider);
    if (provider?.getCachedModelInfo?.(route.model) || typeof provider?.listModels !== 'function') return null;
    const models = await provider.listModels();
    return (Array.isArray(models) ? models.find((m) => m?.id === route.model) : null) || null;
  }

  async function nativeWebSearchRoutes() {
    const route = getRoute();
    await awaitKeychainPrewarm();
    const cfg = ensureFullConfig();
    // An unset webSearchRoute IS the default ("follow the Main Model") — the
    // sidebar has always presented it that way. Materialize it here instead of
    // treating a missing key as "not configured", which used to fail the search
    // before the Main Model was ever consulted.
    const webSearchRoute = webSearchRouteOrDefault(cfg.webSearchRoute, getWebSearchRoute());
    setWebSearchRoute(webSearchRoute);
    const candidates = [];
    const seen = new Set();
    for (const selected of routeChain(webSearchRoute)) {
      const candidate = await resolveCandidate(selected, cfg, route);
      if (!candidate) continue;
      const provider = canonicalRouteProvider(candidate.provider);
      if (seen.has(provider)) continue;
      seen.add(provider);
      candidates.push({ ...candidate, provider });
    }
    return candidates;
  }

  async function resolveCandidate(webSearchRoute, cfg, route) {
    if (isDefaultWebSearchRouteConfig(webSearchRoute)) {
      const loadedRow = route?.provider && route?.model ? await loadMainCatalogRow(cfg, route) : null;
      const mainModel = currentMainWebSearchModelMeta(loadedRow);
      if (!mainModel || !webSearchCapableFor(route.provider, mainModel)) return null;
      return {
        key: `default\n${route.provider}\n${route.model}`,
        provider: normalizeWebSearchProviderId(route.provider),
        model: route.model,
        source: 'default-web-search-route',
        effort: route.effectiveEffort || route.effort || null,
        fast: route.fast === true,
        modelParameters: route.modelParameters || {},
        toolType: webSearchRoute.toolType || null,
      };
    }
    const providerName = normalizeWebSearchProviderId(webSearchRoute.provider);
    if (!isWebSearchCapableProvider(providerName)) return null;
    return {
      key: `${providerName}\n${webSearchRoute.model}`,
      provider: providerName,
      model: webSearchRoute.model,
      source: 'web-search-route',
      effort: webSearchRoute.effort || null,
      fast: webSearchRoute.fast === true,
      modelParameters: webSearchRoute.modelParameters || {},
      toolType: webSearchRoute.toolType || null,
    };
  }

  return { currentMainWebSearchModelMeta, nativeWebSearchRoutes };
}
