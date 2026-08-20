import { clean, hasOwn } from './session-text.mjs';
import { coerceEffortFor, normalizeEffortInput } from './effort.mjs';
import { fastCapableFor, saveModelSettings } from './model-capabilities.mjs';
import {
  ensureProviderEnabled,
  validateRequestedModelSelector,
  findPreset,
  modelMetaLooksResolved,
} from './config-helpers.mjs';
import { getModelMetadataSync } from '../runtime/agent/orchestrator/providers/model-catalog.mjs';
import {
  workflowPresetId,
  normalizeWebSearchRouteConfig,
  isDefaultWebSearchRouteConfig,
  isWebSearchCapableProvider,
  WEB_SEARCH_DEFAULT_PROVIDER,
  WEB_SEARCH_DEFAULT_MODEL,
} from './workflow.mjs';
import { writeStatuslineRoute } from './statusline-route.mjs';
import { SUMMARY_PREFIX } from '../runtime/agent/orchestrator/session/compact.mjs';
import {
  hasUserConversationMessage,
} from '../runtime/agent/orchestrator/session/manager/prompt-utils.mjs';
import { rebuildDeferredToolSurfaceForProvider } from './tool-catalog.mjs';

function isSummaryAnchorMessage(message) {
  return message?.role === 'user'
    && typeof message.content === 'string'
    && message.content.startsWith(SUMMARY_PREFIX);
}

function hasRouteHistoryMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return hasUserConversationMessage(list) || list.some(isSummaryAnchorMessage);
}

export function shouldRecreateEmptySessionForRouteChange(
  session,
  applyToCurrentSession = false,
) {
  return applyToCurrentSession !== true
    && !!session
    && !hasRouteHistoryMessage(session.messages)
    && !hasRouteHistoryMessage(session.liveTurnMessages);
}

// Model/route/web-search-route selection + mutation surface. Extracted verbatim from
// the runtime API object; stateless helpers are imported directly and the
// runtime injects live getters/setters for the mutable config/route/webSearchRoute/
// session locals plus the closure callbacks (config adopt/save, effort refresh,
// provider registry, statusline).
export function createModelRouteApi(deps) {
  const {
    getConfig, getRoute, setRouteState, getSession, setSession,
    getConfigHasSecrets, getWebSearchRouteState, setWebSearchRouteState,
    cfgMod, reg, mgr, statusRoutes,
    resolveRoute, webSearchCapableFor, lookupModelMeta,
    adoptConfig, saveConfigAndAdopt, ensureFullConfig, awaitKeychainPrewarm,
    ensureProvidersReady,
    persistLeadRoute, refreshRouteEffort,
    refreshStatuslineUsageSnapshot, scheduleStatuslineUsageRefresh,
    invalidateContextStatusCache, invalidateProviderCaches,
    createCurrentSession, invalidatePreSessionToolSurface,
    collectWebSearchProviderModels,
  } = deps;
  function persistAdoptedModelSettings(route) {
    // saveModelSettings is in-memory only. persistLeadRoute debounce-writes
    // the adopted config (including modelSettings). If the lead preset cannot
    // be normalized, still debounce-persist so effort/fast are not memory-only.
    const leadRoute = persistLeadRoute(route);
    if (!leadRoute) saveConfigAndAdopt(getConfig());
    return leadRoute;
  }
  return {
    getWebSearchRoute() {
      // Unset === the default marker route (follow Main), never "unconfigured".
      const webSearchRoute = normalizeWebSearchRouteConfig(getConfig().webSearchRoute)
        || normalizeWebSearchRouteConfig(getWebSearchRouteState())
        || normalizeWebSearchRouteConfig({
          provider: WEB_SEARCH_DEFAULT_PROVIDER,
          model: WEB_SEARCH_DEFAULT_MODEL,
        });
      setWebSearchRouteState(webSearchRoute);
      return webSearchRoute;
    },
    async listWebSearchModels(options = {}) {
      return await collectWebSearchProviderModels({ force: options.force === true || options.refresh === true });
    },
    async setWebSearchRoute(next) {
      let selectedRoute = clean(next?.provider)
        ? normalizeWebSearchRouteConfig(next)
        : normalizeWebSearchRouteConfig({
          provider: WEB_SEARCH_DEFAULT_PROVIDER,
          model: WEB_SEARCH_DEFAULT_MODEL,
          ...(next?.toolType ? { toolType: next.toolType } : {}),
        });
      if (!selectedRoute) throw new Error('web search route requires provider and model');
      if (isDefaultWebSearchRouteConfig(selectedRoute)) {
        await awaitKeychainPrewarm();
        ensureFullConfig();
        const routeToSave = normalizeWebSearchRouteConfig({
          provider: WEB_SEARCH_DEFAULT_PROVIDER,
          model: WEB_SEARCH_DEFAULT_MODEL,
          ...(selectedRoute.toolType ? { toolType: selectedRoute.toolType } : {}),
        });
        const nextConfig = { ...getConfig() };
        nextConfig.webSearchRoute = routeToSave;
        saveConfigAndAdopt(nextConfig);
        const webSearchRoute = normalizeWebSearchRouteConfig(getConfig().webSearchRoute);
        setWebSearchRouteState(webSearchRoute);
        invalidateProviderCaches();
        return webSearchRoute;
      }
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
      const fastCapable = fastCapableFor(
        selectedRoute.provider,
        modelMeta,
        effort,
        selectedRoute.modelParameters,
      );
      selectedRoute = {
        ...selectedRoute,
        ...(effort ? { effort } : {}),
        fast: fastCapable ? selectedRoute.fast === true : false,
      };
      const routeToSave = normalizeWebSearchRouteConfig(selectedRoute);
      const nextConfig = { ...getConfig() };
      nextConfig.webSearchRoute = routeToSave;
      saveConfigAndAdopt(nextConfig);
      const webSearchRoute = normalizeWebSearchRouteConfig(getConfig().webSearchRoute);
      setWebSearchRouteState(webSearchRoute);
      invalidateProviderCaches();
      return webSearchRoute;
    },
    async setRoute(next, options = {}) {
      // Model/provider changes take effect on the NEXT session only — never
      // rewrite a running session's provider/model in place (provider-keyed
      // prompt cache). `route` still updates immediately for the next session.
      const applyToCurrentSession = options?.applyToCurrentSession === true;
      const requested = { ...(next || {}) };
      validateRequestedModelSelector(getConfig(), requested);
      const providerExplicitlyRequested = clean(next?.provider) !== '';
      if (requested.effort === undefined && !requested.provider && !requested.model && hasOwn(getRoute(), 'effort')) {
        requested.effort = getRoute().effort;
      }
      if (!requested.provider && requested.model && !findPreset(getConfig(), requested.model)) {
        requested.provider = getRoute().provider;
      }
      let selectedRoute = resolveRoute(getConfig(), requested);
      await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      if (!providerExplicitlyRequested
        && !selectedRoute.preset
        && !modelMetaLooksResolved(modelMeta)
        && !getModelMetadataSync(selectedRoute.model, selectedRoute.provider)) {
        throw new Error(`unknown model: ${selectedRoute.provider}/${selectedRoute.model}`);
      }
      const fastCapable = fastCapableFor(
        selectedRoute.provider,
        modelMeta,
        selectedRoute.effort,
        selectedRoute.modelParameters,
      );
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
      adoptConfig(saveModelSettings(cfgMod, selectedRoute, { fastCapable, baseConfig: getConfig() }), { hasSecrets: getConfigHasSecrets() });
      const leadRoute = persistAdoptedModelSettings(selectedRoute);
      setRouteState(resolveRoute(getConfig(), leadRoute
        ? { model: workflowPresetId('lead') }
        : selectedRoute));
      await refreshRouteEffort(modelMeta);
      refreshStatuslineUsageSnapshot(getRoute());
      scheduleStatuslineUsageRefresh();
      const session = getSession();
      // Model/provider changes are next-session-only for a session the user
      // has already talked in or compacted (provider-keyed prompt cache). But
      // an EMPTY current session — no committed route history and no in-flight
      // first-turn prompt — has no cache to protect, so /model before the first
      // chat takes effect live: route + statusline update immediately.
      const currentSessionEmpty = !!session
        && !hasRouteHistoryMessage(session.messages)
        && !hasRouteHistoryMessage(session.liveTurnMessages);
      const applyLive = applyToCurrentSession || currentSessionEmpty;
      if (!applyLive) {
        return getRoute();
      }
      if (shouldRecreateEmptySessionForRouteChange(session, applyToCurrentSession)
        && session?.id
        && typeof createCurrentSession === 'function') {
        // If the boot create is still finishing SessionStart/deferred-surface
        // work, drain that promise first. Otherwise createCurrentSession()
        // would return the old in-flight promise after we tombstone/null the
        // session, racing the intended rebuild for the new provider.
        await createCurrentSession('model-switch-empty-drain');
        const emptySession = getSession();
        if (!emptySession?.id
          || hasRouteHistoryMessage(emptySession.messages)
          || hasRouteHistoryMessage(emptySession.liveTurnMessages)) {
          invalidateContextStatusCache();
          return getRoute();
        }
        statusRoutes?.clearGatewaySessionRoute?.(emptySession.id);
        mgr.closeSession?.(emptySession.id, 'cli-model-switch-empty', { tombstone: true });
        setSession(null);
        invalidatePreSessionToolSurface?.();
        await createCurrentSession('model-switch-empty');
        invalidateContextStatusCache();
        return getRoute();
      }
      if (session) {
        // An explicitly addressed daemon/desktop mutation must keep that
        // durable address. The caller asked to apply this route to THIS empty
        // session, so update it in place instead of closing A and silently
        // materializing B before the first prompt.
        const route = getRoute();
        const updated = mgr.updateSessionRoute?.(session.id, {
          provider: route.provider,
          model: route.model,
          fast: route.fast === true,
          effort: route.effectiveEffort || null,
          modelParameters: route.modelParameters || {},
          contextPercent: route.contextPercent,
          selectedContextWindow: route.selectedContextWindow || null,
        });
        if (updated) setSession(updated);
        else {
          session.provider = route.provider;
          session.model = route.model;
          session.fast = route.fast === true;
          session.effort = route.effectiveEffort || null;
          session.modelParameters = route.modelParameters || {};
          session.contextPercent = route.contextPercent;
          session.selectedContextWindow = route.selectedContextWindow || null;
        }
        rebuildDeferredToolSurfaceForProvider(getSession(), route.provider);
        writeStatuslineRoute(statusRoutes, getSession(), route);
        invalidateContextStatusCache();
      }
      return getRoute();
    },
    async setFast(value) {
      const enabled = value === true;
      const modelMeta = await lookupModelMeta(getRoute().provider, getRoute().model);
      const fastCapable = fastCapableFor(
        getRoute().provider,
        modelMeta,
        getRoute().effectiveEffort || getRoute().effort,
        getRoute().modelParameters,
      );
      if (enabled && !fastCapable) {
        throw new Error(`fast mode is not available for ${getRoute().provider}/${getRoute().model}`);
      }
      setRouteState(resolveRoute(getConfig(), {
        provider: getRoute().provider,
        model: getRoute().model,
        effort: getRoute().effort,
        fast: fastCapable ? enabled : false,
        modelParameters: getRoute().modelParameters,
      }));
      adoptConfig(saveModelSettings(cfgMod, getRoute(), { fastCapable, baseConfig: getConfig() }), { hasSecrets: getConfigHasSecrets() });
      const leadRoute = persistAdoptedModelSettings(getRoute());
      if (leadRoute) setRouteState(resolveRoute(getConfig(), { model: workflowPresetId('lead') }));
      await refreshRouteEffort(modelMeta);
      const session = getSession();
      if (session) {
        const route = getRoute();
        session.fast = route.fast === true;
        session.effort = route.effectiveEffort || null;
        writeStatuslineRoute(statusRoutes, session, route);
        invalidateContextStatusCache();
      }
      return getRoute().fast === true;
    },
    async toggleFast() {
      return await this.setFast(!(getRoute().fast === true));
    },
    async setEffort(value) {
      const normalized = normalizeEffortInput(value);
      setRouteState({ ...getRoute(), effort: normalized });
      const modelMeta = await lookupModelMeta(getRoute().provider, getRoute().model);
      const fastCapable = fastCapableFor(
        getRoute().provider,
        modelMeta,
        normalized,
        getRoute().modelParameters,
      );
      adoptConfig(saveModelSettings(cfgMod, getRoute(), { fastCapable, baseConfig: getConfig() }), { hasSecrets: getConfigHasSecrets() });
      const leadRoute = persistAdoptedModelSettings(getRoute());
      if (leadRoute) {
        setRouteState(resolveRoute(getConfig(), { model: workflowPresetId('lead') }));
      }
      await refreshRouteEffort(modelMeta);
      const session = getSession();
      if (session) {
        const route = getRoute();
        session.fast = route.fast === true;
        session.effort = route.effectiveEffort || null;
        writeStatuslineRoute(statusRoutes, session, route);
        invalidateContextStatusCache();
      }
      return getRoute();
    },
  };
}
