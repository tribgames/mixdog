let routeMeta;

try {
  routeMeta = await import('../../../../vendor/statusline/src/gateway/route-meta.mjs');
} catch {
  routeMeta = await import('../../../gateway/route-meta.mjs');
}

export const buildGatewayLimits = routeMeta.buildGatewayLimits;
export const recordGatewayUsageEvent = routeMeta.recordGatewayUsageEvent;
export const summarizeGatewayUsage = routeMeta.summarizeGatewayUsage;
