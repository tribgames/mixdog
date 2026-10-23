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
const BACKGROUND_SOURCES = new Set(['memory-cycle', 'schedule', 'webhook', 'native-web-search']);

export function isConversationUsageSource(sourceType) {
  const id = typeof sourceType === 'string' ? sourceType.trim().toLowerCase() : '';
  return !BACKGROUND_SOURCES.has(id);
}

/** Turns with a known cost: the recorded count, else every turn when the usage carries any cost at all. */
export function knownCostTurns(usage, amount = num) {
  if (usage.costKnownTurns != null) return amount(usage.costKnownTurns);
  return amount(usage.costUsd) > 0 ? amount(usage.turns) : 0;
}
