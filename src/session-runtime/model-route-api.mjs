/**
 * model-route-api.mjs — model/route/web-search-route selection + mutation
 * surface. Stateless helpers are imported by the modules below and the
 * runtime injects live getters/setters for the mutable
 * config/route/webSearchRoute/session locals plus the closure callbacks
 * (config adopt/save, effort refresh, provider registry, statusline).
 *
 *   model-route/route-persist.mjs    — modelSettings save, lead persistence, session tuning
 *   model-route/web-search-route.mjs — native web-search route read/list/set
 *   model-route/set-route.mjs        — main route selection + empty-session follow-up
 *   model-route/route-tuning.mjs     — setFast / toggleFast / setEffort
 */
import { createRoutePersistence } from './model-route/route-persist.mjs';
import { createWebSearchRouteApi } from './model-route/web-search-route.mjs';
import { createSetRoute } from './model-route/set-route.mjs';
import { createRouteTuning } from './model-route/route-tuning.mjs';

export { shouldRecreateEmptySessionForRouteChange } from './session-route-policy.mjs';

export function createModelRouteApi(deps) {
  const persist = createRoutePersistence(deps);
  return {
    ...createWebSearchRouteApi(deps),
    setRoute: createSetRoute(deps, persist),
    ...createRouteTuning(deps, persist),
  };
}
