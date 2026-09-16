import { pricingCatalogRevisionSync } from '../../agent/orchestrator/providers/model-catalog.mjs';
import { repairUsageLedger } from './usage-ledger-repair.mjs';

const checked = new WeakMap();

function pendingFingerprint(ledger, revision) {
  const pending = ledger.db
    .prepare(`SELECT COUNT(*) AS count,MAX(e.ts) AS latest
        FROM usage_events e JOIN usage_routes r ON r.id=e.route
        WHERE e.cost_usd IS NULL AND json_extract(r.signature,'$[4]')='unpriced'
        AND e.ts<=?`)
    .get(Date.now());
  return { count: pending.count, key: `${revision}:${pending.count}:${pending.latest}` };
}

/** Price-table changes revisit unknown costs, never overwrite a known bill or
 * estimate. New unknown records also get checked without polling old rows on
 * every dashboard render. Failed repairs are not marked successful. */
export function refreshUnpricedUsage(ledger) {
  const revision = pricingCatalogRevisionSync();
  const pending = pendingFingerprint(ledger, revision);
  if (!pending.count || checked.get(ledger) === pending.key) return { skipped: true };
  const result = repairUsageLedger(ledger, {
    throughTs: Date.now(),
    onlyUnpriced: true,
    backup: true,
  });
  checked.set(ledger, pendingFingerprint(ledger, revision).key);
  return result;
}
