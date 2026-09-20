/**
 * set-route.mjs — select the main route: resolve and validate the request,
 * adopt it into config, then decide how the current session follows it
 * (untouched, tuned, recreated, or updated in place when empty).
 */
import { clean, hasOwn } from '../session-text.mjs';
import { fastCapableFor } from '../model-capabilities.mjs';
import {
  ensureProviderEnabled,
  findPreset,
  modelMetaLooksResolved,
  validateRequestedModelSelector,
} from '../config-helpers.mjs';
import { getModelMetadataSync } from '../../runtime/agent/orchestrator/providers/model-catalog.mjs';
import { workflowPresetId } from '../workflow.mjs';
import { writeStatuslineRoute } from '../statusline-route.mjs';
import { sessionHasRouteHistory, shouldRecreateEmptySessionForRouteChange } from '../session-route-policy.mjs';
import { rebuildDeferredToolSurfaceForProvider } from '../tool-catalog.mjs';

/** The request, completed from the live route where the caller left gaps. */
function completeRequest(deps, next) {
  const { getConfig, getRoute } = deps;
  const requested = { ...(next || {}) };
  validateRequestedModelSelector(getConfig(), requested);
  if (requested.effort === undefined && !requested.provider && !requested.model && hasOwn(getRoute(), 'effort')) {
    requested.effort = getRoute().effort;
  }
  if (!requested.provider && requested.model && !findPreset(getConfig(), requested.model)) {
    requested.provider = getRoute().provider;
  }
  return requested;
}

async function resolveSelectedRoute(deps, next) {
  const { getConfig, resolveRoute, ensureProvidersReady, lookupModelMeta } = deps;
  const providerExplicitlyRequested = clean(next?.provider) !== '';
  const selectedRoute = resolveRoute(getConfig(), completeRequest(deps, next));
  await ensureProvidersReady(ensureProviderEnabled(getConfig(), selectedRoute.provider));
  const modelMeta = await lookupModelMeta(selectedRoute.provider, selectedRoute.model);
  if (
    !providerExplicitlyRequested &&
    !selectedRoute.preset &&
    !modelMetaLooksResolved(modelMeta) &&
    !getModelMetadataSync(selectedRoute.model, selectedRoute.provider)
  ) {
    throw new Error(`unknown model: ${selectedRoute.provider}/${selectedRoute.model}`);
  }
  const fastCapable = fastCapableFor(
    selectedRoute.provider,
    modelMeta,
    selectedRoute.effort,
    selectedRoute.modelParameters
  );
  return {
    selectedRoute: { ...selectedRoute, fast: fastCapable ? selectedRoute.fast === true : false },
    fastCapable,
    modelMeta,
  };
}

/** Close the empty session and materialize a fresh one for the new provider. */
async function recreateEmptySession(deps) {
  const { getSession, setSession, mgr, statusRoutes, createCurrentSession, invalidatePreSessionToolSurface } = deps;
  // If the boot create is still finishing SessionStart/deferred-surface
  // work, drain that promise first. Otherwise createCurrentSession()
  // would return the old in-flight promise after we tombstone/null the
  // session, racing the intended rebuild for the new provider.
  await createCurrentSession('model-switch-empty-drain');
  const emptySession = getSession();
  if (!emptySession?.id || sessionHasRouteHistory(emptySession)) return;
  statusRoutes?.clearGatewaySessionRoute?.(emptySession.id);
  mgr.closeSession?.(emptySession.id, 'cli-model-switch-empty', { tombstone: true });
  setSession(null);
  invalidatePreSessionToolSurface?.();
  await createCurrentSession('model-switch-empty');
}

/** Rewrite the addressed empty session to the route it was asked to run on. */
function updateEmptySessionInPlace(deps, session) {
  const { getRoute, getSession, setSession, mgr, statusRoutes } = deps;
  const route = getRoute();
  const fields = {
    provider: route.provider,
    model: route.model,
    fast: route.fast === true,
    effort: route.effectiveEffort || null,
    modelParameters: route.modelParameters || {},
    contextPercent: route.contextPercent,
    selectedContextWindow: route.selectedContextWindow || null,
  };
  const updated = mgr.updateSessionRoute?.(session.id, fields);
  if (updated) setSession(updated);
  else Object.assign(session, fields);
  rebuildDeferredToolSurfaceForProvider(getSession(), route.provider);
  writeStatuslineRoute(statusRoutes, getSession(), route);
}

export function createSetRoute(deps, persist) {
  const {
    getConfig,
    getRoute,
    setRouteState,
    getSession,
    resolveRoute,
    refreshRouteEffort,
    refreshStatuslineUsageSnapshot,
    scheduleStatuslineUsageRefresh,
    invalidateContextStatusCache,
    createCurrentSession,
  } = deps;

  return async function setRoute(next, options = {}) {
    // Selection is for a new/inherited session. An explicit durable address
    // permits initializing an EMPTY session, never rewriting an existing
    // conversation's model, context boundary or provider cache.
    const applyToCurrentSession = options?.applyToCurrentSession === true;
    const { selectedRoute, fastCapable, modelMeta } = await resolveSelectedRoute(deps, next);
    persist.saveRouteModelSettings(selectedRoute, fastCapable);
    const leadRoute = persist.persistAdoptedModelSettings(selectedRoute);
    setRouteState(resolveRoute(getConfig(), leadRoute ? { model: workflowPresetId('lead') } : selectedRoute));
    await refreshRouteEffort(modelMeta);
    refreshStatuslineUsageSnapshot(getRoute());
    scheduleStatuslineUsageRefresh();
    const session = getSession();
    // Model/provider changes are next-session-only for a session the user
    // has already talked in or compacted (provider-keyed prompt cache). But
    // an EMPTY current session — no committed route history and no in-flight
    // first-turn prompt — has no cache to protect, so /model before the first
    // chat takes effect live: route + statusline update immediately.
    const currentSessionEmpty = !!session && !sessionHasRouteHistory(session);
    if (!currentSessionEmpty) {
      // Some desktop effort changes travel as a same-model route update.
      // Only effort/Fast may affect the source, starting with its next turn.
      if (applyToCurrentSession) persist.applySessionTuning();
      return getRoute();
    }
    if (
      shouldRecreateEmptySessionForRouteChange(session, applyToCurrentSession) &&
      session?.id &&
      typeof createCurrentSession === 'function'
    ) {
      await recreateEmptySession(deps);
      invalidateContextStatusCache();
      return getRoute();
    }
    if (session) {
      // An explicitly addressed daemon/desktop mutation must keep that
      // durable address. The caller asked to apply this route to THIS empty
      // session, so update it in place instead of closing A and silently
      // materializing B before the first prompt.
      updateEmptySessionInPlace(deps, session);
      invalidateContextStatusCache();
    }
    return getRoute();
  };
}
