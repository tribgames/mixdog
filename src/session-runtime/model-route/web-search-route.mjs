/**
 * web-search-route.mjs — the native web-search route: read with the
 * follow-Main default, list candidate models, and validate + save a selection.
 */
import { clean, hasOwn } from '../session-text.mjs';
import { coerceEffortFor } from '../effort.mjs';
import { fastCapableFor } from '../model-capabilities.mjs';
import { ensureProviderEnabled } from '../config-helpers.mjs';
import {
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  normalizeWebSearchRouteConfig,
  webSearchRouteOrDefault,
  WEB_SEARCH_DEFAULT_MODEL,
  WEB_SEARCH_DEFAULT_PROVIDER,
} from '../workflow.mjs';

const defaultWebSearchRoute = (toolType) =>
  normalizeWebSearchRouteConfig({
    provider: WEB_SEARCH_DEFAULT_PROVIDER,
    model: WEB_SEARCH_DEFAULT_MODEL,
    ...(toolType ? { toolType } : {}),
  });

export function createWebSearchRouteApi(deps) {
  const {
    getConfig,
    getWebSearchRouteState,
    setWebSearchRouteState,
    webSearchCapableFor,
    lookupModelMeta,
    saveConfigAndAdopt,
    ensureFullConfig,
    awaitKeychainPrewarm,
    ensureProvidersReady,
    invalidateProviderCaches,
    collectWebSearchProviderModels,
  } = deps;

  function getWebSearchRoute() {
    // Unset === the default marker route (follow Main), never "unconfigured".
    const webSearchRoute = webSearchRouteOrDefault(getConfig().webSearchRoute, getWebSearchRouteState());
    setWebSearchRouteState(webSearchRoute);
    return webSearchRoute;
  }

  function saveWebSearchRoute(routeToSave) {
    const nextConfig = { ...getConfig() };
    nextConfig.webSearchRoute = routeToSave;
    saveConfigAndAdopt(nextConfig);
    const webSearchRoute = normalizeWebSearchRouteConfig(getConfig().webSearchRoute);
    setWebSearchRouteState(webSearchRoute);
    invalidateProviderCaches();
    return webSearchRoute;
  }

  /** A concrete provider/model choice, validated against the live catalog. */
  async function resolveExplicitRoute(selectedRoute) {
    if (!isWebSearchCapableProvider(selectedRoute.provider)) {
      throw new Error(`provider "${selectedRoute.provider}" does not support Mixdog native web search`);
    }
    await awaitKeychainPrewarm();
    ensureFullConfig();
    await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
    const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
    if (!webSearchCapableFor(selectedRoute.provider, modelMeta)) {
      throw new Error(`model "${selectedRoute.model}" is not marked as web-search capable`);
    }
    // Route-scope isolation: the web search route stores its own effort/fast in
    // config.webSearchRoute. The shared config.modelSettings[provider/model]
    // bucket belongs to the MAIN route alone, so a web-search model pick that
    // happens to match Main must not rewrite Main's saved effort/fast.
    const effort = coerceEffortFor(selectedRoute.provider, modelMeta, selectedRoute.effort);
    const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta, effort, selectedRoute.modelParameters);
    return normalizeWebSearchRouteConfig({
      ...selectedRoute,
      ...(effort ? { effort } : {}),
      fast: fastCapable ? selectedRoute.fast === true : false,
    });
  }

  return {
    getWebSearchRoute,
    async listWebSearchModels(options = {}) {
      return await collectWebSearchProviderModels({ force: options.force === true || options.refresh === true });
    },
    async setWebSearchRoute(next) {
      const reset = hasOwn(next || {}, 'provider') && !clean(next.provider);
      const selectedRoute = reset
        ? defaultWebSearchRoute(next?.toolType)
        : normalizeWebSearchRouteConfig(next, getWebSearchRoute());
      if (!selectedRoute) throw new Error('web search route requires provider and model');
      if (isDefaultWebSearchRouteConfig(selectedRoute)) {
        await awaitKeychainPrewarm();
        ensureFullConfig();
        return saveWebSearchRoute(defaultWebSearchRoute(selectedRoute.toolType));
      }
      return saveWebSearchRoute(await resolveExplicitRoute(selectedRoute));
    },
  };
}
