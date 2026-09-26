import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { priceUsage } from './cost.mjs';
import { usageCostSource, usageRouteKind } from './usage-ledger.mjs';
import { normalizeUsageMeasurement } from './usage-measurement.mjs';

// Excludes only the two fields a repair may change: route attribution and price.
export function usageLedgerIntegrity(db) {
  const hash = createHash('sha256');
  let records = 0;
  for (const row of db
    .prepare(`SELECT id,ts,day,session,input,output,cache_read,cache_write,duration_ms
        FROM usage_events ORDER BY id`)
    .iterate()) {
    hash.update(JSON.stringify({ ...row, id: Buffer.from(row.id).toString('hex') }));
    records++;
  }
  return { records, sha256: hash.digest('hex') };
}

function validateRepairOptions({ throughTs, sinceTs = null, providerOverrides = {}, onlyUnpriced = false }) {
  if (!Number.isSafeInteger(throughTs) || throughTs <= 0)
    throw new Error('Repair requires an explicit timestamp bound');
  if (sinceTs !== null && !Number.isSafeInteger(sinceTs)) throw new Error('Invalid repair lower bound');
  for (const [from, to] of Object.entries(providerOverrides)) {
    if (!from || typeof to !== 'string' || !to) throw new Error('Invalid provider correction');
  }
  if (onlyUnpriced && Object.keys(providerOverrides).length)
    throw new Error('Automatic repricing cannot change providers');
}

/** The rows a repair examines, with their route signatures. */
export function selectUsageRepairCandidates(db, { throughTs, sinceTs = null, onlyUnpriced = false }) {
  // `+e.ts`: a bound of "now" matches every row, so a scan beats one
  // primary-key search per usage_events_time entry.
  return db
    .prepare(`SELECT e.*,r.signature FROM usage_events e
            JOIN usage_routes r ON r.id=e.route WHERE +e.ts<=?
            ${sinceTs === null ? '' : 'AND +e.ts>?'}
            ${onlyUnpriced ? "AND e.cost_usd IS NULL AND json_extract(r.signature,'$[4]')='unpriced'" : ''}`)
    .all(...(sinceTs === null ? [throughTs] : [throughTs, sinceTs]));
}

// Pricing is the only CPU-heavy step of a repair (every catalog lookup runs
// on this thread's catalog state). It yields every PLAN_CHUNK rows so the
// asynchronous repair can hand the event loop back between chunks.
const PLAN_CHUNK = 200;

function* planUsageRepair(rows, { providerOverrides = {}, price = priceUsage }) {
  const report = { reattributed: 0, repriced: 0, stillUnpriced: 0, changes: {} };
  const changes = [];
  let index = 0;
  for (const row of rows) {
    if (++index % PLAN_CHUNK === 0) yield;
    const signature = JSON.parse(row.signature);
    const originalProvider = signature[0];
    const provider = Object.hasOwn(providerOverrides, originalProvider)
      ? providerOverrides[originalProvider]
      : originalProvider;
    const moved = provider !== originalProvider;
    const kind = moved ? usageRouteKind(provider) : signature[2];
    let cost = row.cost_usd;
    const oldRates = signature[5] ? JSON.parse(signature[5]) : null;
    if (moved || signature[4] === 'unpriced') {
      const unmeasured =
        oldRates?.inputTokensKnown === false || normalizeUsageMeasurement(provider, { turns: 1 }).unmeasuredTurns;
      const inputTokensKnown = unmeasured ? false : undefined;
      const priced =
        kind === 'local'
          ? { costUsd: 0, rates: null }
          : price({
              provider,
              model: signature[1],
              pricingModel: oldRates?.pricingModel,
              requestedModel: oldRates?.requestedModel,
              inputTokensKnown,
              uncachedInputTokens: row.input,
              outputTokens: row.output,
              cacheReadTokens: row.cache_read,
              cacheWriteTokens: row.cache_write,
              cacheWrite1hTokens: oldRates?.cacheWrite1hTokens,
              fast: oldRates?.fast,
              serviceTier: oldRates?.serviceTier,
              ts: row.ts,
              historical: true,
            });
      cost = priced.costUsd;
      if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error('Invalid repair price');
      signature[4] = usageCostSource({ kind, costUsd: cost, subscription: kind === 'oauth' || kind === 'quota-api' });
      signature[5] = priced.rates ? JSON.stringify(priced.rates) : null;
      if (row.cost_usd === null && cost !== null) report.repriced++;
    }
    signature[0] = provider;
    signature[2] = kind;
    if (moved) report.reattributed++;
    if (cost === null) report.stillUnpriced++;
    const encoded = JSON.stringify(signature);
    if (encoded === row.signature && cost === row.cost_usd) continue;
    changes.push({ row, encoded, cost });
    const key = `${originalProvider} → ${provider} / ${signature[1]}`;
    report.changes[key] = (report.changes[key] || 0) + 1;
  }
  return { report, changes };
}

// Inside the caller's write transaction.
function applyPlannedRepair(ledger, { report, changes, throughTs, providerOverrides = {}, backup = false }) {
  const db = ledger.db;
  // Nothing has been written yet in this transaction, and without changes
  // nothing will be: there is nothing to verify, so the whole-ledger hash
  // (~0.6 s over 120k rows) is only taken around real writes.
  if (!changes.length) return { ...report, integrity: null };
  const insertRoute = db.prepare('INSERT OR IGNORE INTO usage_routes(signature) VALUES (?)');
  const findRoute = db.prepare('SELECT id FROM usage_routes WHERE signature=?');
  const update = db.prepare('UPDATE usage_events SET route=?,cost_usd=? WHERE id=?');
  const before = usageLedgerIntegrity(db);
  if (backup && ledger.path !== ':memory:') {
    const directory = mkdtempSync(join(dirname(ledger.path), 'pricing-backup-'));
    report.backupPath = join(directory, 'ledger.sqlite');
    const reader = new DatabaseSync(ledger.path, { readOnly: true });
    try {
      reader.prepare('VACUUM INTO ?').run(report.backupPath);
    } finally {
      reader.close();
    }
  }
  for (const { row, encoded, cost } of changes) {
    insertRoute.run(encoded);
    update.run(findRoute.get(encoded).id, cost, row.id);
  }
  ledger.rebuildIndexes();
  const after = usageLedgerIntegrity(db);
  if (before.records !== after.records || before.sha256 !== after.sha256) {
    throw new Error('Repair changed immutable request records');
  }
  ledger.set(
    'lastUsageRepair',
    JSON.stringify({
      at: Date.now(),
      throughTs,
      providerOverrides,
      ...report,
      integrity: after,
    })
  );
  return { ...report, integrity: after };
}

function drainPlan(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/**
 * Bounded correction. Automatic use can only revisit unpriced records and
 * takes a coherent backup under the writer reservation before its first write.
 * Provider overrides require operator evidence; unknown model aliases are NOT
 * inferred. Existing known prices remain fixed unless the billing route changes.
 */
export function repairUsageLedger(ledger, options = {}) {
  validateRepairOptions(options);
  const { throughTs, sinceTs = null, providerOverrides = {}, onlyUnpriced = false, backup = false } = options;
  const db = ledger.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = selectUsageRepairCandidates(db, { throughTs, sinceTs, onlyUnpriced });
    const plan = drainPlan(planUsageRepair(rows, options));
    const result = applyPlannedRepair(ledger, { ...plan, throughTs, providerOverrides, backup });
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * repairUsageLedger without blocking the event loop. The ledger worker reads
 * the candidates; pricing runs here in chunks (it must use this thread's
 * catalog state to price exactly like the synchronous repair); the worker then
 * applies the plan in one write transaction with the same backup, index
 * rebuild and immutability check. The candidates are not locked while they
 * are priced, so the worker first confirms each planned row still has the
 * route and cost it was priced from; if another writer changed one, nothing is
 * written and the result carries `conflict: true` (a later refresh retries).
 */
export async function repairUsageLedgerAsync(ledger, options = {}) {
  validateRepairOptions(options);
  const { throughTs, sinceTs = null, providerOverrides = {}, onlyUnpriced = false, backup = false } = options;
  const rows = await ledger.workerRequest('repairCandidates', { throughTs, sinceTs, onlyUnpriced });
  const steps = planUsageRepair(rows, options);
  let step = steps.next();
  while (!step.done) {
    await new Promise((resolve) => setImmediate(resolve));
    step = steps.next();
  }
  const { report, changes } = step.value;
  if (!changes.length) return { ...report, integrity: null };
  return ledger.workerRequest('applyRepair', {
    report,
    changes: changes.map(({ row, encoded, cost }) => ({
      row: { id: row.id, route: row.route, cost_usd: row.cost_usd },
      encoded,
      cost,
    })),
    throughTs,
    providerOverrides,
    backup,
  });
}

/** Worker side of repairUsageLedgerAsync: apply a plan whose rows are unchanged. */
export function applyUsageRepairIfUnchanged(ledger, plan) {
  const db = ledger.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT route,cost_usd FROM usage_events WHERE id=?');
    for (const { row } of plan.changes) {
      const now = current.get(row.id);
      if (!now || now.route !== row.route || now.cost_usd !== row.cost_usd) {
        db.exec('ROLLBACK');
        return { ...plan.report, conflict: true, integrity: null };
      }
    }
    const result = applyPlannedRepair(ledger, plan);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
