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

/**
 * Bounded correction. Automatic use can only revisit unpriced records and
 * takes a coherent backup under the writer reservation before its first write.
 * Provider overrides require operator evidence; unknown model aliases are NOT
 * inferred. Existing known prices remain fixed unless the billing route changes.
 */
export function repairUsageLedger(
  ledger,
  { throughTs, providerOverrides = {}, price = priceUsage, onlyUnpriced = false, backup = false } = {}
) {
  if (!Number.isSafeInteger(throughTs) || throughTs <= 0)
    throw new Error('Repair requires an explicit timestamp bound');
  for (const [from, to] of Object.entries(providerOverrides)) {
    if (!from || typeof to !== 'string' || !to) throw new Error('Invalid provider correction');
  }
  if (onlyUnpriced && Object.keys(providerOverrides).length)
    throw new Error('Automatic repricing cannot change providers');
  const db = ledger.db;
  db.exec('BEGIN IMMEDIATE');
  try {
    const before = usageLedgerIntegrity(db);
    const insertRoute = db.prepare('INSERT OR IGNORE INTO usage_routes(signature) VALUES (?)');
    const findRoute = db.prepare('SELECT id FROM usage_routes WHERE signature=?');
    const update = db.prepare('UPDATE usage_events SET route=?,cost_usd=? WHERE id=?');
    const report = { reattributed: 0, repriced: 0, stillUnpriced: 0, changes: {} };
    const changes = [];
    const rows = db
      .prepare(`SELECT e.*,r.signature FROM usage_events e
            JOIN usage_routes r ON r.id=e.route WHERE e.ts<=?
            ${onlyUnpriced ? "AND e.cost_usd IS NULL AND json_extract(r.signature,'$[4]')='unpriced'" : ''}`)
      .all(throughTs);
    for (const row of rows) {
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
    if (changes.length && backup && ledger.path !== ':memory:') {
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
    if (changes.length) ledger.rebuildIndexes();
    const after = usageLedgerIntegrity(db);
    if (before.records !== after.records || before.sha256 !== after.sha256) {
      throw new Error('Repair changed immutable request records');
    }
    if (changes.length)
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
    db.exec('COMMIT');
    return { ...report, integrity: after };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
