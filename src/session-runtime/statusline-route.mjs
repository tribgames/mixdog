// Statusline route serialization. Pure helpers.
import { clean, hasOwn } from './session-text.mjs';

export function routeForStatusline(route) {
  const out = {
    mode: 'fixed',
    defaultProvider: route.provider,
    defaultModel: route.model,
  };
  const preset = route.preset || {};
  if (preset.id) out.presetId = preset.id;
  if (preset.name) out.presetName = preset.name;
  // Prefer the preset's curated label, then the route's resolved model display
  // (set by refreshRouteEffort from the live/offline catalog). Without the
  // route fallback, a preset-less direct model (e.g. claude-fable-5) reaches
  // the statusline with no display and renders as the raw id.
  const modelDisplay = clean(preset.modelDisplay) || clean(route.modelDisplay);
  if (modelDisplay) out.modelDisplay = modelDisplay;
  if (route.fast === true || route.fast === false) out.fast = route.fast;
  else if (preset.fast === true || preset.fast === false) out.fast = preset.fast;
  if (route.effectiveEffort) {
    out.effort = route.effectiveEffort;
    out.displayEffort = route.effectiveEffort;
  } else if (hasOwn(route, 'effort')) {
    delete out.effort;
    delete out.displayEffort;
  }
  return out;
}

export function writeStatuslineRoute(statusRoutes, session, route) {
  if (!session?.id || !route) return;
  const clientHostPid = session?.clientHostPid || process.pid;
  statusRoutes?.writeGatewaySessionRoute?.(session.id, routeForStatusline(route), { clientHostPid });
}
