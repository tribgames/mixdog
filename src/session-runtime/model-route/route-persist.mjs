/**
 * route-persist.mjs — how an adopted main-route selection reaches config and
 * the current session: modelSettings save, lead-preset persistence and the
 * fast/effort tuning of a session that runs on the selected route.
 */
import { saveModelSettings } from '../model-capabilities.mjs';
import { writeStatuslineRoute } from '../statusline-route.mjs';
import { sessionUsesRoute } from '../session-route-policy.mjs';

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
    invalidateContextStatusCache,
  } = deps;
  return {
    /** In-memory modelSettings update for `route`, adopted into the live config. */
    saveRouteModelSettings(route, fastCapable) {
      adoptConfig(saveModelSettings(cfgMod, route, { fastCapable, baseConfig: getConfig() }), {
        hasSecrets: getConfigHasSecrets(),
      });
    },
    persistAdoptedModelSettings(route) {
      // saveModelSettings is in-memory only. persistLeadRoute debounce-writes
      // the adopted config (including modelSettings). If the lead preset cannot
      // be normalized, still debounce-persist so effort/fast are not memory-only.
      const leadRoute = persistLeadRoute(route);
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
      writeStatuslineRoute(statusRoutes, session, route);
      invalidateContextStatusCache();
    },
  };
}
