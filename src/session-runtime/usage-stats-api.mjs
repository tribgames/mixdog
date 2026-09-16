// One durable accounting store. No transcript rescans or diagnostic retention
// dependencies after the one-time import of surviving historical originals.
import { getUsageLedger } from '../runtime/shared/llm/usage-ledger.mjs';
import { importUsageHistory } from '../runtime/shared/llm/usage-ledger-import.mjs';
import { refreshUnpricedUsage } from '../runtime/shared/llm/usage-pricing-refresh.mjs';
import { resolvePluginData } from '../runtime/shared/plugin-paths.mjs';
import { usageStatsSnapshot } from '../standalone/usage-stats-model.mjs';
import { resolveUsageStatsPeriod } from '../standalone/usage-stats-period.mjs';
import { usageRollupDayKey } from '../runtime/shared/llm/usage-rollup.mjs';

const MAX_MODEL_LIMIT = 50;

/** `null` = all time. `0` = today. Anything else is a trailing day count. */
function normalizeDays(value) {
  if (value === null || value === undefined || value === 'all') return null;
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.min(Math.floor(days), 3650);
}

function normalizeModelLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), MAX_MODEL_LIMIT);
}

export function createUsageStatsApi({ ledger = getUsageLedger, importHistory = importUsageHistory } = {}) {
  let importing = null;
  let imported = false;
  return {
    async getUsageStats(options = {}) {
      const store = ledger();
      if (!store) throw new Error('Usage ledger is unavailable');
      const liveSince = Number(store.get('liveSince'));
      // Until the first instrumented send establishes the cutover, the legacy
      // writer may still be active. A previous import is not a live subscription.
      if (!liveSince || !imported || Number(store.get('importedThrough')) < liveSince) {
        importing ||= importHistory(store, resolvePluginData())
          .then(() => {
            imported = true;
          })
          .finally(() => {
            importing = null;
          });
        await importing;
      }
      refreshUnpricedUsage(store);
      // Imports may take time: their newly retained timestamps must not fall
      // beyond a clock captured before the import started.
      const now = Date.now();
      // Keep the existing days API for non-desktop callers.
      const period =
        options?.view == null
          ? null
          : resolveUsageStatsPeriod({
              view: options.view,
              anchor: options.anchor,
              startDay: options.startDay,
              endDay: options.endDay,
              now,
            });
      const snapshot = usageStatsSnapshot({
        rollup: store.rollup({
          hourlyDay: period?.view === 'hour' ? period.startDay : null,
          ...(period?.view === 'hour' ? { fromMs: period.fromMs, toMs: period.toMs } : {}),
          ...(period
            ? {
                fromDay: period.startDay || undefined,
                toDay: usageRollupDayKey(period.toMs),
              }
            : {}),
        }),
        days: normalizeDays(options?.days),
        period,
        modelLimit: normalizeModelLimit(options?.modelLimit),
        // Every turn counts. Splitting the conversation out from the background
        // runners answered "what did I personally type", but the question this
        // surface is actually asked is what the machine spent, and a caller
        // that wants only its own turns can still ask for that split.
        source: options?.source === 'conversation' ? 'conversation' : 'all',
        now,
      });
      snapshot.coverage.ledger = true;
      snapshot.coverage.liveSince = liveSince || null;
      return snapshot;
    },
  };
}
