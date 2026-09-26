import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { UsageLedger, closeUsageLedgers, getUsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { accountProviderSend } from './usage-accounting.mjs';
import { repairUsageLedger, repairUsageLedgerAsync, usageLedgerIntegrity } from './usage-ledger-repair.mjs';
import { refreshUnpricedUsage, refreshUnpricedUsageAsync } from './usage-pricing-refresh.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';

// Removed after every test has closed its ledgers (per-test hooks run first).
const dirs = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function useLedgerPath(t, path) {
  const prior = process.env.MIXDOG_USAGE_LEDGER_PATH;
  process.env.MIXDOG_USAGE_LEDGER_PATH = path;
  t.after(() => {
    closeUsageLedgers();
    if (prior === undefined) delete process.env.MIXDOG_USAGE_LEDGER_PATH;
    else process.env.MIXDOG_USAGE_LEDGER_PATH = prior;
  });
}

const send = (responseId, extra = {}) =>
  accountProviderSend(
    'anthropic-oauth',
    { constructor: { inputExcludesCache: true } },
    async () => ({ model: 'claude-opus-4-8', responseId, usage: { inputTokens: 100, outputTokens: 10 }, ...extra }),
    'claude-opus-4-8',
    { sessionId: 'writes-session', session: { sourceType: 'lead' } }
  );

test('live sends commit through the ledger worker, in order, once each, before the send settles', async (t) => {
  useLedgerPath(t, join(tempDir(t, 'mixdog-usage-writes-'), 'ledger.sqlite'));
  const ledger = getUsageLedger();
  let inThreadRecords = 0;
  const record = ledger.record.bind(ledger);
  t.mock.method(ledger, 'record', (rows) => {
    inThreadRecords += 1;
    return record(rows);
  });
  // Concurrent sends share batches; a repeated response id stays one record.
  const ids = Array.from({ length: 24 }, (_, index) => `response-${index}`);
  await Promise.all([...ids, 'response-3', 'response-7'].map((id) => send(id)));
  assert.equal(inThreadRecords, 0, 'a live send ran its SQLite write on the event loop');
  const stored = ledger.db.prepare('SELECT id FROM events ORDER BY ts, id').all();
  assert.equal(stored.length, ids.length);
  // Awaited sends are durable as soon as the send settles.
  await send('after');
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, ids.length + 1);
});

test('usage statistics wait for queued sends; a failing row fails alone', async (t) => {
  const path = join(tempDir(t, 'mixdog-usage-writes-'), 'ledger.sqlite');
  const ledger = new UsageLedger(path);
  t.after(() => ledger.close());
  ledger.set('importedThrough', Number.MAX_SAFE_INTEGER);
  const row = (responseId) =>
    makeUsageRecord({ ts: Date.now(), provider: 'openai', model: 'gpt-5.5', inputTokens: 50, outputTokens: 5, responseId });
  const good = ledger.recordQueued(row('queued-a'));
  const bad = ledger.recordQueued({ ...row('queued-bad'), day: 'not-a-day' }).then(
    () => null,
    (error) => error
  );
  const later = ledger.recordQueued(row('queued-b'));
  const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
  const stats = await api.getUsageStats({ days: null });
  assert.equal(stats.totals.turns, 2, 'statistics must include sends queued before the request');
  await good;
  await later;
  assert.match(String((await bad)?.message), /calendar day/);
});

function unpricedRow(id, ts, model = 'claude-opus-4-8') {
  return {
    ...makeUsageRecord({ id, ts, provider: 'anthropic', model, inputTokens: 1000, outputTokens: 100 }),
    costUsd: null,
    costSource: 'unpriced',
    rates: null,
  };
}

function twinLedgers(t, rows) {
  const dir = tempDir(t, 'mixdog-usage-refresh-');
  const first = new UsageLedger(join(dir, 'a.sqlite'));
  first.record(rows);
  first.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  first.close();
  copyFileSync(join(dir, 'a.sqlite'), join(dir, 'b.sqlite'));
  const inThread = new UsageLedger(join(dir, 'a.sqlite'));
  const viaWorker = new UsageLedger(join(dir, 'b.sqlite'));
  t.after(() => {
    inThread.close();
    viaWorker.close();
  });
  return { inThread, viaWorker };
}

const withoutBackupPath = ({ backupPath, ...report }) => report;
const events = (ledger) => ledger.db.prepare('SELECT * FROM events ORDER BY id').all();

test('the worker-backed unpriced refresh matches the in-thread refresh step for step', async (t) => {
  const base = Date.now() - 60_000;
  const { inThread, viaWorker } = twinLedgers(t, [
    unpricedRow('a', base),
    unpricedRow('b', base + 1, 'unknown-model'),
    unpricedRow('c', base + 2),
  ]);
  const steps = [
    () => {},
    () => {},
    (ledger) => ledger.record([unpricedRow('d', base + 10)]),
    (ledger) => ledger.record([unpricedRow('late', base + 5, 'unknown-model')]),
    () => {},
  ];
  for (const step of steps) {
    step(inThread);
    step(viaWorker);
    const expected = refreshUnpricedUsage(inThread);
    const actual = await refreshUnpricedUsageAsync(viaWorker);
    assert.deepEqual(withoutBackupPath(actual), withoutBackupPath(expected));
    assert.deepEqual(events(viaWorker), events(inThread));
  }
  // Both refresh paths share one record of what was checked.
  assert.equal(refreshUnpricedUsage(viaWorker).skipped, true);
});

test('an async repair writes nothing when another writer changed a planned row', async (t) => {
  const base = Date.now() - 60_000;
  const { viaWorker: ledger } = twinLedgers(t, [unpricedRow('x', base), unpricedRow('y', base + 1)]);
  const price = () => ({ costUsd: 0.5, rates: { pricingModel: 'fixture' } });
  const before = events(ledger);
  const request = ledger.workerRequest.bind(ledger);
  t.mock.method(ledger, 'workerRequest', async (op, payload) => {
    if (op === 'applyRepair') {
      // Another writer prices row x first.
      ledger.db.prepare("UPDATE usage_events SET cost_usd=0.25 WHERE id=(SELECT id FROM usage_events ORDER BY ts LIMIT 1)").run();
    }
    return request(op, payload);
  });
  const result = await repairUsageLedgerAsync(ledger, { throughTs: Date.now(), onlyUnpriced: true, price });
  assert.equal(result.conflict, true);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM usage_events WHERE cost_usd=0.5').get().n, 0);
  assert.equal(events(ledger).length, before.length);

  // Without interference the async and the in-thread repair agree exactly.
  t.mock.restoreAll();
  const { inThread, viaWorker } = twinLedgers(t, [unpricedRow('x', base), unpricedRow('y', base + 1)]);
  const integrity = usageLedgerIntegrity(viaWorker.db);
  const expected = repairUsageLedger(inThread, { throughTs: base + 10, onlyUnpriced: true, price });
  const actual = await repairUsageLedgerAsync(viaWorker, { throughTs: base + 10, onlyUnpriced: true, price });
  assert.deepEqual(actual, expected);
  assert.deepEqual(events(viaWorker), events(inThread));
  assert.deepEqual(usageLedgerIntegrity(viaWorker.db), integrity);
});
