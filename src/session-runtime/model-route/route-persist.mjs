/**
 * route-persist.mjs — how an adopted main-route selection reaches config and
 * the current session: modelSettings save, lead-preset persistence and the
 * fast/effort tuning of a session that runs on the selected route.
 */
import { saveModelSettings } from '../../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import { writeStatuslineRoute } from '../statusline-route.mjs';
import { sessionUsesRoute } from '../../runtime/agent/orchestrator/runtime-core/session-route-policy.mjs';

/** Re-tuning the live model (effort, Fast, context, or re-picking it) is not a
 *  main-model choice: new tasks keep their main model unless it is that model. */
function tunesNonMainModel(liveRoute, route, mainRoute) {
  const sameModel = (other) => other?.provider === route.provider && other?.model === route.model;
  return sameModel(liveRoute) && !sameModel(mainRoute);
}

export function createRoutePersistence(deps) {
  const {
    getConfig,
    getRoute,
    getSession,
    getConfigHasSecrets,
    cfgMod,
    statusRoutes,
    adoptConfig,
    saveConfigAndAdopt,
    persistLeadRoute,
    resolveRoute,
    invalidateContextStatusCache,
  } = deps;
  return {
    /** In-memory modelSettings update for `route`, adopted into the live config. */
    saveRouteModelSettings(route, fastCapable) {
      adoptConfig(saveModelSettings(cfgMod, route, { fastCapable, baseConfig: getConfig() }), {
        hasSecrets: getConfigHasSecrets(),
      });
    },
    persistAdoptedModelSettings(route, { keepMainModel = false } = {}) {
      // saveModelSettings is in-memory only. persistLeadRoute debounce-writes
      // the adopted config (including modelSettings). If the lead preset cannot
      // be normalized, still debounce-persist so effort/fast are not memory-only.
      const leadRoute =
        keepMainModel || tunesNonMainModel(getRoute(), route, resolveRoute(getConfig(), {}))
          ? null
          : persistLeadRoute(route);
      if (!leadRoute) saveConfigAndAdopt(getConfig());
      return leadRoute;
    },
    applySessionTuning() {
      const session = getSession();
      const route = getRoute();
      // A selection for the heir must not leak its tuning into the source model.
      if (!sessionUsesRoute(session, route)) return;
      session.fast = route.fast === true;
      session.effort = route.effectiveEffort || null;
      // The request path reads session.modelParameters; keep only serviceTier in step.
      const { serviceTier: _previous, ...otherParameters } = session.modelParameters || {};
      const serviceTier = route.modelParameters?.serviceTier;
      session.modelParameters = serviceTier ? { ...otherParameters, serviceTier } : otherParameters;
      writeStatuslineRoute(statusRoutes, session, route);
      invalidateContextStatusCache();
    },
  };
}
