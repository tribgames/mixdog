/**
 * Cursor's native agent protocol reports output deltas and context occupancy,
 * not per-request input/cache usage. Old adapters priced that occupancy as
 * uncached input. Keep those originals, but never aggregate them as measured
 * spend. This applies to both native auth routes, including historical imports.
 */
export function normalizeUsageMeasurement(provider, usage) {
  if (provider !== 'cursor-oauth' && provider !== 'cursor-api') return usage;
  return {
    ...usage,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    costBilled: 0,
    costEstimated: 0,
    costKnownTurns: 0,
    unmeasuredTurns: usage.turns || 0,
  };
}

export function normalizeLegacyUsageDay(original) {
  const day = structuredClone(original);
  for (const [key, route] of Object.entries(day.models || {})) {
    const provider = route.provider || key.slice(0, key.indexOf('/'));
    const measured = normalizeUsageMeasurement(provider, route);
    if (measured === route) continue;
    for (const [target, source] of [
      [day, route],
      [day.conversation, route.conversation],
    ]) {
      if (!target || !source) continue;
      const normalized = normalizeUsageMeasurement(provider, source);
      for (const field of [
        'input',
        'cacheRead',
        'cacheWrite',
        'costUsd',
        'costBilled',
        'costEstimated',
        'costKnownTurns',
      ]) {
        target[field] = Math.max(0, (target[field] || 0) - (source[field] || 0));
      }
      target.unmeasuredTurns = (target.unmeasuredTurns || 0) + normalized.unmeasuredTurns;
    }
    day.models[key] = {
      ...measured,
      ...(route.conversation
        ? {
            conversation: normalizeUsageMeasurement(provider, route.conversation),
          }
        : {}),
    };
  }
  return day;
}
