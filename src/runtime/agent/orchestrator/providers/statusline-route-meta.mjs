let routeMeta = null;
let routeMetaPromise = null;

async function loadRouteMetaModule() {
  if (routeMeta) return routeMeta;
  if (!routeMetaPromise) {
    routeMetaPromise = import('../../../../vendor/statusline/src/gateway/route-meta.mjs').then((mod) => {
      routeMeta = mod;
      return mod;
    });
  }
  try {
    return await routeMetaPromise;
  } catch (err) {
    routeMetaPromise = null;
    routeMeta = null;
    throw err;
  }
}

function requireRouteMeta() {
  if (!routeMeta) {
    void loadRouteMetaModule().catch(() => {});
    throw new Error('statusline route-meta not loaded');
  }
  return routeMeta;
}

export function buildGatewayLimits(routeInfo, providerOut = null, usageSnapshot = null) {
  return requireRouteMeta().buildGatewayLimits(routeInfo, providerOut, usageSnapshot);
}

export function recordGatewayUsageEvent(summary) {
  return requireRouteMeta().recordGatewayUsageEvent(summary);
}

/** Resolves once every recorded usage event has been written; nothing was
 *  recorded while the module is not loaded. */
export function settleGatewayUsageWrites() {
  return routeMeta ? routeMeta.settleGatewayUsageWrites() : Promise.resolve();
}

export function summarizeGatewayUsage(routeInfo, providerOut, compact = null, durationMs = null) {
  return requireRouteMeta().summarizeGatewayUsage(routeInfo, providerOut, compact, durationMs);
}
