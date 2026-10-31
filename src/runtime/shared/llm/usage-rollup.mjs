/**
 * Day keys, conversation-source classification and numeric helpers shared by the
 * usage ledger and the stats model. The daily JSON rollup these helpers were
 * written for is no longer produced; its past day records are still imported
 * by usage-ledger-import.mjs.
 */

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Local calendar day, so "today" in the UI means the user's today. */
export function usageRollupDayKey(ts) {
  const date = new Date(Number.isFinite(Number(ts)) ? Number(ts) : Date.now());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

// A turn belongs to the user's conversation unless it came from one of these
// background runners. An unknown source counts as conversation on purpose: a
// new runner showing up in the user's totals is visible and correctable, while
// silently dropping the user's own turns is neither.
const BACKGROUND_SOURCES = new Set(['memory-cycle', 'schedule', 'webhook', 'native-web-search', 'cache-warm']);

export function isConversationUsageSource(sourceType) {
  const id = typeof sourceType === 'string' ? sourceType.trim().toLowerCase() : '';
  return !BACKGROUND_SOURCES.has(id);
}

/**
 * SQL: 1 when a route's requests ran in Fast mode (a Fast/Priority/Ultrafast
 * tier was sent), read off the route signature's stored rates. Mirrors the
 * pricing rule in cost.mjs: the OpenAI API reporting "default" means a
 * Priority request was downgraded to Standard. Routes recorded before tiers
 * were kept, or without one, are normal.
 */
export const fastRouteSql = (signature) => `(
    COALESCE(json_extract(json_extract(${signature},'$[5]'),'$.requestServiceTier') IN ('fast','priority','ultrafast'),0)
    AND NOT (COALESCE(json_extract(${signature},'$[2]'),'')='api'
        AND COALESCE(json_extract(json_extract(${signature},'$[5]'),'$.serviceTier'),'')='default'))`;

/** Marks a model key as that model's Fast-mode calls: a route of its own beside the normal one. */
export const FAST_KEY = '\u0000fast';
export const rollupRouteKey = (provider, model, fast) => `${provider}/${model}${fast ? FAST_KEY : ''}`;

/**
 * Orders model rows by each model's combined fields (descending, in order),
 * keeping a model's Fast row directly under its normal row.
 */
export function sortFastBesideModel(rows, modelOf, fields) {
  const sums = new Map();
  for (const row of rows) {
    const sum = sums.get(modelOf(row)) || fields.map(() => 0);
    fields.forEach((field, index) => {
      sum[index] += row[field];
    });
    sums.set(modelOf(row), sum);
  }
  return rows.sort((a, b) => {
    const x = sums.get(modelOf(a));
    const y = sums.get(modelOf(b));
    const lead = fields.findIndex((_, index) => y[index] !== x[index]);
    if (lead >= 0) return y[lead] - x[lead];
    return modelOf(a).localeCompare(modelOf(b)) || Number(a.fast === true) - Number(b.fast === true);
  });
}

/** Turns with a known cost: the recorded count, else every turn when the usage carries any cost at all. */
export function knownCostTurns(usage, amount = num) {
  if (usage.costKnownTurns != null) return amount(usage.costKnownTurns);
  return amount(usage.costUsd) > 0 ? amount(usage.turns) : 0;
}
