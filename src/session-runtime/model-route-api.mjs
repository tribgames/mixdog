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
  normalizeSearchRouteConfig,
  isDefaultSearchRouteConfig,
  isSearchCapableProvider,
  SEARCH_DEFAULT_PROVIDER,
  SEARCH_DEFAULT_MODEL,
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

// Model/route/search-route selection + mutation surface. Extracted verbatim from
// the runtime API object; stateless helpers are imported directly and the
// runtime injects live getters/setters for the mutable config/route/searchRoute/
// session locals plus the closure callbacks (config adopt/save, effort refresh,
// provider registry, statusline).
export function createModelRouteApi(deps) {
  const {
    getConfig, getRoute, setRouteState, getSession, setSession,
    getConfigHasSecrets, getSearchRouteState, setSearchRouteState,
    cfgMod, reg, mgr, statusRoutes,
    resolveRoute, searchCapableFor, lookupModelMeta,
    adoptConfig, saveConfigAndAdopt, ensureFullConfig, ensureProvidersReady,
    persistLeadRoute, refreshRouteEffort,
    refreshStatuslineUsageSnapshot, scheduleStatuslineUsageRefresh,
    invalidateContextStatusCache, invalidateProviderCaches,
    createCurrentSession, invalidatePreSessionToolSurface,
    pushTranscriptRebind,
    collectSearchProviderModels,
  } = deps;
  return {
    getSearchRoute() {
      const sr = normalizeSearchRouteConfig(getConfig().searchRoute) || normalizeSearchRouteConfig(getSearchRouteState());
      setSearchRouteState(sr);
      return sr;
    },
    async listSearchModels(options = {}) {
      return await collectSearchProviderModels({ force: options.force === true || options.refresh === true });
    },
    async setSearchRoute(next) {
      const searchRoute = getSearchRouteState();
      let selectedRoute = normalizeSearchRouteConfig(next);
      if (!selectedRoute && next?.model && searchRoute?.provider) {
        selectedRoute = normalizeSearchRouteConfig({ ...next, provider: searchRoute.provider });
      }
      if (!selectedRoute) throw new Error('search route requires provider and model');
      if (isDefaultSearchRouteConfig(selectedRoute)) {
        ensureFullConfig();
        const routeToSave = normalizeSearchRouteConfig({
          provider: SEARCH_DEFAULT_PROVIDER,
          model: SEARCH_DEFAULT_MODEL,
          ...(selectedRoute.toolType ? { toolType: selectedRoute.toolType } : {}),
        });
        const nextConfig = { ...getConfig() };
        nextConfig.searchRoute = routeToSave;
        saveConfigAndAdopt(nextConfig);
        const sr = normalizeSearchRouteConfig(getConfig().searchRoute);
        setSearchRouteState(sr);
        invalidateProviderCaches();
        return sr;
      }
      if (!isSearchCapableProvider(selectedRoute.provider)) {
        throw new Error(`provider "${selectedRoute.provider}" does not support Mixdog native search`);
      }
      ensureFullConfig();
      await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
      const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
      if (!searchCapableFor(selectedRoute.provider, modelMeta)) {
        throw new Error(`model "${selectedRoute.model}" is not marked as web-search capable`);
      }
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      const effort = coerceEffortFor(selectedRoute.provider, modelMeta, selectedRoute.effort);
      selectedRoute = {
        ...selectedRoute,
        ...(effort ? { effort } : {}),
        fast: fastCapable ? selectedRoute.fast === true : false,
      };
      adoptConfig(saveModelSettings(cfgMod, selectedRoute, { fastCapable, baseConfig: getConfig() }), { hasSecrets: getConfigHasSecrets() });
      const routeToSave = normalizeSearchRouteConfig(selectedRoute);
      const nextConfig = { ...getConfig() };
      nextConfig.searchRoute = routeToSave;
      saveConfigAndAdopt(nextConfig);
      const sr = normalizeSearchRouteConfig(getConfig().searchRoute);
      setSearchRouteState(sr);
      invalidateProviderCaches();
      return sr;
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
      const fastCapable = fastCapableFor(selectedRoute.provider, modelMeta);
      selectedRoute = { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false };
      adoptConfig(saveModelSettings(cfgMod, selectedRoute, { fastCapable, baseConfig: getConfig() }), { hasSecrets: getConfigHasSecrets() });
      const leadRoute = persistLeadRoute(selectedRoute);
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
      if (currentSessionEmpty && session?.id && typeof createCurrentSession === 'function') {
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
        pushTranscriptRebind?.();
        invalidateContextStatusCache();
        return getRoute();
      }
      if (session) {
        const route = getRoute();
        rebuildDeferredToolSurfaceForProvider(session, route.provider);
        const updated = mgr.updateSessionRoute?.(session.id, {
          provider: route.provider,
          model: route.model,
          fast: route.fast === true,
          effort: route.effectiveEffort || null,
        });
        if (updated) setSession(updated);
        else {
          session.provider = route.provider;
          session.model = route.model;
          session.fast = route.fast === true;
          session.effort = route.effectiveEffort || null;
        }
        writeStatuslineRoute(statusRoutes, getSession(), route);
        invalidateContextStatusCache();
      }
      return getRoute();
    },
    async setFast(value) {
      const enabled = value === true;
      const modelMeta = await lookupModelMeta(getRoute().provider, getRoute().model);
      const fastCapable = fastCapableFor(getRoute().provider, modelMeta);
      if (enabled && !fastCapable) {
        throw new Error(`fast mode is not available for ${getRoute().provider}/${getRoute().model}`);
      }
      setRouteState(resolveRoute(getConfig(), { provider: getRoute().provider, model: getRoute().model, effort: getRoute().effort, fast: fastCapable ? enabled : false }));
      adoptConfig(saveModelSettings(cfgMod, getRoute(), { fastCapable, baseConfig: getConfig() }), { hasSecrets: getConfigHasSecrets() });
      const leadRoute = persistLeadRoute(getRoute());
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
      const fastCapable = fastCapableFor(getRoute().provider, modelMeta);
      adoptConfig(saveModelSettings(cfgMod, getRoute(), { fastCapable, baseConfig: getConfig() }), { hasSecrets: getConfigHasSecrets() });
      const leadRoute = persistLeadRoute(getRoute());
      if (leadRoute) {
        setRouteState(resolveRoute(getConfig(), { model: workflowPresetId('lead') }));
      }
      await refreshRouteEffort(modelMeta);
      const session = getSession();
      if (session) {
        const route = getRoute();
        session.effort = route.effectiveEffort || null;
        writeStatuslineRoute(statusRoutes, session, route);
        invalidateContextStatusCache();
      }
      return getRoute();
    },
  };
}
