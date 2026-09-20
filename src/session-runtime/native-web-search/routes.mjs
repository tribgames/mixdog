/**
 * routes.mjs — which provider/model answers a native web search: the
 * configured web-search route, or the Main model when the route is the
 * follow-Main default.
 */
import { WEB_SEARCH_DEFAULT_MODEL, WEB_SEARCH_DEFAULT_PROVIDER } from '../workflow.mjs';

export function createWebSearchRouteCandidates({
  getRoute,
  getWebSearchRoute,
  setWebSearchRoute,
  ensureFullConfig,
  awaitKeychainPrewarm,
  normalizeWebSearchProviderId,
  normalizeWebSearchRouteConfig,
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  webSearchCapableFor,
}) {
  function currentMainWebSearchModelMeta() {
    const route = getRoute();
    if (!route?.provider || !route?.model) return null;
    return { ...route, id: route.model, display: route.model, name: route.model };
  }

  async function nativeWebSearchRoutes() {
    const route = getRoute();
    await awaitKeychainPrewarm();
    const cfg = ensureFullConfig();
    // An unset webSearchRoute IS the default ("follow the Main Model") — the
    // sidebar has always presented it that way. Materialize it here instead of
    // treating a missing key as "not configured", which used to fail the search
    // before the Main Model was ever consulted.
    const webSearchRoute =
      normalizeWebSearchRouteConfig(cfg.webSearchRoute) ||
      normalizeWebSearchRouteConfig(getWebSearchRoute()) ||
      normalizeWebSearchRouteConfig({
        provider: WEB_SEARCH_DEFAULT_PROVIDER,
        model: WEB_SEARCH_DEFAULT_MODEL,
      });
    setWebSearchRoute(webSearchRoute);
    if (!webSearchRoute) return [];
    if (isDefaultWebSearchRouteConfig(webSearchRoute)) {
      const mainModel = currentMainWebSearchModelMeta();
      if (!mainModel || !webSearchCapableFor(route.provider, mainModel)) return [];
      return [
        {
          key: `default\n${route.provider}\n${route.model}`,
          provider: normalizeWebSearchProviderId(route.provider),
          model: route.model,
          source: 'default-web-search-route',
          effort: route.effectiveEffort || route.effort || null,
          fast: route.fast === true,
          toolType: webSearchRoute.toolType || null,
        },
      ];
    }
    const providerName = normalizeWebSearchProviderId(webSearchRoute.provider);
    if (!isWebSearchCapableProvider(providerName)) return [];
    return [
      {
        key: `${providerName}\n${webSearchRoute.model}`,
        provider: providerName,
        model: webSearchRoute.model,
        source: 'web-search-route',
        effort: webSearchRoute.effort || null,
        fast: webSearchRoute.fast === true,
        toolType: webSearchRoute.toolType || null,
      },
    ];
  }

  return { currentMainWebSearchModelMeta, nativeWebSearchRoutes };
}
