import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { UsageLedger } from '../src/runtime/shared/llm/usage-ledger.mjs';
import { repairUsageLedger, usageLedgerIntegrity } from '../src/runtime/shared/llm/usage-ledger-repair.mjs';
import { usageStatsSnapshot } from '../src/standalone/usage-stats-model.mjs';

// Usage: node scripts/audit-usage-ledger.mjs --ledger=<absolute file>
//        [--reattribute-xai-to-grok] [--apply]
// Raw files and a consistent SQLite snapshot survive both dry runs and apply.
const options = process.argv.slice(2);
const ledgerArg = options.find((arg) => arg.startsWith('--ledger='))?.slice(9);
if (!ledgerArg || !isAbsolute(ledgerArg) || !/\.sqlite$/i.test(ledgerArg)) {
    throw new Error('Supply an exact absolute --ledger=<file.sqlite> path');
}
for (const arg of options) {
    if (!arg.startsWith('--ledger=') && !['--reattribute-xai-to-grok', '--apply'].includes(arg)) {
        throw new Error(`Unknown argument: ${arg}`);
    }
}
const source = resolve(ledgerArg);
const auditRoot = join(dirname(source), 'audits');
mkdirSync(auditRoot, { recursive: true });
const workspace = mkdtempSync(join(auditRoot, 'usage-'));
const raw = join(workspace, 'original-files');
mkdirSync(raw);
for (const suffix of ['', '-wal', '-shm']) {
    try { copyFileSync(source + suffix, join(raw, basename(source) + suffix)); }
    catch (error) { if (!suffix || error.code !== 'ENOENT') throw error; }
}
const snapshotPath = join(workspace, 'backup.sqlite');
const original = new DatabaseSync(source, { readOnly: true });
try { await backup(original, snapshotPath); } finally { original.close(); }
const workingPath = join(workspace, 'working.sqlite');
copyFileSync(snapshotPath, workingPath);
const throughTs = Date.now();
const providerOverrides = options.includes('--reattribute-xai-to-grok') ? { xai: 'grok-oauth' } : {};
const summarize = (ledger) => {
    const stats = usageStatsSnapshot({ rollup: ledger.rollup(), now: throughTs, source: 'all' });
    const sum = (rows, key) => rows.reduce((n, row) => n + Number(row[key] || 0), 0);
    for (const key of ['turns', 'input', 'output', 'cacheRead', 'cacheWrite', 'costKnownTurns']) {
        assert.equal(sum(stats.providers, key), stats.totals[key], `provider sum: ${key}`);
    }
    for (const rows of [stats.providers, stats.daily]) {
        assert.ok(Math.abs(sum(rows, 'costUsd') - stats.totals.costUsd) <= rows.length * 0.000001 + 0.000001, 'cost sum');
        assert.equal(sum(rows, 'tokens'), stats.totals.tokens, 'token sum');
        assert.equal(sum(rows, 'turns'), stats.totals.turns, 'record sum');
    }
    assert.ok(Math.abs(stats.totals.costBilled + stats.totals.costEstimated - stats.totals.costUsd) < 0.000002, 'cost categories');
    assert.ok(stats.totals.costKnownTurns <= stats.totals.turns, 'price coverage');
    for (const p of stats.providers) {
        assert.equal(sum(p.models, 'turns'), p.turns, `model sum: ${p.provider}`);
    }
    return {
        integrity: usageLedgerIntegrity(ledger.db), totals: stats.totals,
        providers: stats.providers.map(({ provider, providerKind, turns, tokens, costUsd, costUnpricedTurns }) =>
            ({ provider, providerKind, turns, tokens, costUsd, costUnpricedTurns })),
    };
};
const working = new UsageLedger(workingPath);
let before, preview, after;
try {
    assert.deepEqual(working.db.prepare('PRAGMA quick_check').all().map((r) => r.quick_check), ['ok']);
    before = summarize(working);
    preview = repairUsageLedger(working, { throughTs, providerOverrides });
    after = summarize(working);
    assert.deepEqual(before.integrity, after.integrity);
} finally { working.close(); }
const report = { source, workspace, backup: snapshotPath, throughTs, providerOverrides, before, preview, after, applied: false };
writeFileSync(join(workspace, 'report.json'), JSON.stringify(report, null, 2));
if (options.includes('--apply')) {
    const live = new UsageLedger(source);
    try {
        // The transaction repairs only the bounded history. Concurrent new
        // requests are retained and indexed too; no database file is replaced.
        report.appliedRepair = repairUsageLedger(live, { throughTs, providerOverrides });
        report.live = summarize(live);
        assert.deepEqual(live.db.prepare('PRAGMA quick_check').all().map((r) => r.quick_check), ['ok']);
        report.applied = true;
    } finally { live.close(); }
    writeFileSync(join(workspace, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ workspace, backup: snapshotPath, applied: report.applied,
    preview, ...(report.appliedRepair ? { appliedRepair: report.appliedRepair } : {}),
    totals: (report.live || after).totals, providers: (report.live || after).providers }, null, 2));
