#!/usr/bin/env node
// Golden twin of how Node's session sums round: a session of 1,000 records at 0.000001 and one
// at 0.0000005 (Node's whole-session SUM, then its six-decimal display) against the sliced
// partial sums a build cut across steps would give. Runs the real UsageLedger, the real
// resumable build (buildSessionDaysStep), readSessionUsage and sessionUsageSnapshot, and records
// the rows it inserted so the Rust ledger can append the same records and must read the same
// bytes.
//
//   node benchmarks/rust-core/recorders/record-ledger-sums.mjs [--tree C:/Project/mixdog]
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const tree = resolve(arg('tree', 'C:/Project/mixdog'));
const repo = resolve(import.meta.dirname, '../../..');
const out = join(repo, 'native/core/fixtures/ledger-queries/sums-rounding.json');
const treeUrl = pathToFileURL(tree).href;
const llm = (file) => `${treeUrl}/src/runtime/shared/llm/${file}`;
const ledgerMod = await import(llm('usage-ledger.mjs'));
const rollupMod = await import(llm('usage-ledger-rollup.mjs'));
const modelMod = await import(`${treeUrl}/src/session-runtime/services/usage-stats-model.mjs`);

const work = mkdtempSync(join(tmpdir(), 'ledger-sums-'));
process.env.MIXDOG_DATA_DIR = work;
const ledger = new ledgerMod.UsageLedger(join(work, 'ledger.sqlite'));
const TS = 1_800_000_000_000;
const rows = [];
for (let i = 0; i <= 1000; i++) {
  rows.push(
    ledgerMod.makeUsageRecord({
      id: `${i}`.padStart(64, '0'),
      ts: TS + i,
      provider: 'prov',
      model: 'm',
      kind: 'api',
      sessionId: 'rounding',
      sourceType: 'user',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: i === 1000 ? 0.0000005 : 0.000001,
      durationMs: 100,
    })
  );
}
for (let at = 0; at < rows.length; at += 200) ledger.record(rows.slice(at, at + 200));
const db = ledger.db;
db.exec('DELETE FROM usage_session_days; UPDATE usage_session_days_state SET complete=0,next=0 WHERE id=1');
while (!rollupMod.buildSessionDaysStep(db, 40_000)) { /* Node's own step */ }
const usage = rollupMod.readSessionUsage(db, ['rounding'], []);
const snapshot = modelMod.sessionUsageSnapshot(usage);
const records = rows.map((row) => ({ ...row, rates: row.rates ? JSON.stringify(row.rates) : null }));
writeFileSync(out, `${JSON.stringify({ records, usage, snapshot }, null, 1)}\n`);
console.log(`wrote ${out}: costUsd ${usage.costUsd} -> ${snapshot.costUsd ?? JSON.stringify(snapshot).slice(0, 200)}`);
