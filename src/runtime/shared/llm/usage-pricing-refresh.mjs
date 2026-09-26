import { pricingCatalogRevisionSync } from '../../agent/orchestrator/providers/model-catalog.mjs';
import { repairUsageLedger, repairUsageLedgerAsync } from './usage-ledger-repair.mjs';

const checked = new WeakMap();
const refreshing = new WeakMap();

// `+e.ts` keeps the planner off usage_events_time: a bound of "now" matches
// every row, and each index hit costs a primary-key search in this WITHOUT
// ROWID table (~300 ms vs ~13 ms for a scan over 120k real rows).
export function unpricedPendingCounts(db, now) {
  const { count, latest } = db
    .prepare(`SELECT COUNT(*) AS count,MAX(e.ts) AS latest
        FROM usage_events e JOIN usage_routes r ON r.id=e.route
        WHERE e.cost_usd IS NULL AND json_extract(r.signature,'$[4]')='unpriced'
        AND +e.ts<=?`)
    .get(now);
  return { count, latest };
}

// Unpriced rows appended after `since.latest`. When they account for every
// new unpriced row, the rows at or before it were already examined under this
// price table and only the appended ones need a repair pass.
export function unpricedCountAfter(db, now, latest) {
  return db
    .prepare(`SELECT COUNT(*) AS count FROM usage_events e JOIN usage_routes r ON r.id=e.route
        WHERE e.cost_usd IS NULL AND json_extract(r.signature,'$[4]')='unpriced'
        AND +e.ts<=? AND +e.ts>?`)
    .get(now, latest).count;
}

function fingerprint(revision, pending) {
  return {
    revision,
    count: pending.count,
    latest: pending.latest,
    key: `${revision}:${pending.count}:${pending.latest}`,
  };
}

function ledgerStamp(ledger) {
  const { local, shared } = ledger.changeStamp.get();
  return `${local}:${shared}`;
}

// The refresh decision, written once. It yields the three ledger operations
// it needs — ['pending'], ['after', latest], ['repair', options] — so the
// synchronous refresh runs them in-thread and the asynchronous one runs the
// queries and repair writes on the ledger worker.
function* refreshSteps(ledger) {
  const revision = pricingCatalogRevisionSync();
  const previous = checked.get(ledger);
  // An unchanged ledger under the same price table has nothing new to check.
  const stamp = ledgerStamp(ledger);
  if (previous?.revision === revision && previous.stamp === stamp) return { skipped: true };
  const pending = fingerprint(revision, yield ['pending']);
  if (!pending.count || previous?.key === pending.key) {
    checked.set(ledger, { ...pending, stamp });
    return { skipped: true };
  }
  const incremental =
    previous?.revision === revision &&
    Number.isSafeInteger(previous.latest) &&
    previous.count + (yield ['after', previous.latest]) === pending.count;
  const result = yield [
    'repair',
    {
      throughTs: Date.now(),
      ...(incremental ? { sinceTs: previous.latest } : {}),
      onlyUnpriced: true,
      backup: true,
    },
  ];
  // Another writer repriced a planned row first: nothing was written, and the
  // next refresh re-examines instead of trusting this pass.
  if (result.conflict) return result;
  // Taken before the settled fingerprint: a commit landing in between moves
  // the stamp again, so it can never be skipped by the next refresh.
  const settledStamp = ledgerStamp(ledger);
  checked.set(ledger, { ...fingerprint(revision, yield ['pending']), stamp: settledStamp });
  return result;
}

/** Price-table changes revisit unknown costs, never overwrite a known bill or
 * estimate. New unknown records also get checked without polling old rows on
 * every dashboard render. Failed repairs are not marked successful. */
export function refreshUnpricedUsage(ledger) {
  const steps = refreshSteps(ledger);
  let step = steps.next();
  while (!step.done) {
    const [op, argument] = step.value;
    let value;
    if (op === 'pending') value = unpricedPendingCounts(ledger.db, Date.now());
    else if (op === 'after') value = unpricedCountAfter(ledger.db, Date.now(), argument);
    else value = repairUsageLedger(ledger, argument);
    step = steps.next(value);
  }
  return step.value;
}

/**
 * refreshUnpricedUsage with its SQLite queries and repair writes on the ledger
 * worker and its pricing chunked on this thread (repairUsageLedgerAsync), so a
 * dashboard refresh never stalls the event loop. Concurrent callers for one
 * ledger share a single refresh. An in-memory ledger refreshes in-thread.
 */
export function refreshUnpricedUsageAsync(ledger) {
  if (ledger.path === ':memory:') return Promise.resolve().then(() => refreshUnpricedUsage(ledger));
  let running = refreshing.get(ledger);
  if (!running) {
    running = runRefreshAsync(ledger).finally(() => refreshing.delete(ledger));
    refreshing.set(ledger, running);
  }
  return running;
}

async function runRefreshAsync(ledger) {
  const steps = refreshSteps(ledger);
  let step = steps.next();
  while (!step.done) {
    const [op, argument] = step.value;
    let value;
    if (op === 'pending') value = await ledger.workerRequest('unpricedPending', { now: Date.now() });
    else if (op === 'after') value = await ledger.workerRequest('unpricedAfter', { now: Date.now(), latest: argument });
    else value = await repairUsageLedgerAsync(ledger, argument);
    step = steps.next(value);
  }
  return step.value;
}
