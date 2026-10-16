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

function tempDir(prefix) {
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
  useLedgerPath(t, join(tempDir('mixdog-usage-writes-'), 'ledger.sqlite'));
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

test('a completed call without usage is recorded as unmeasured and makes session totals inexact', async (t) => {
  useLedgerPath(t, join(tempDir('mixdog-usage-unmeasured-'), 'ledger.sqlite'));
  const ledger = getUsageLedger();
  const sendIn = (sessionId, result) =>
    accountProviderSend('anthropic', {}, async () => result, 'claude-opus-4-8', {
      sessionId,
      session: { sourceType: 'lead' },
    });
  const usage = { inputTokens: 100, outputTokens: 10 };
  const model = 'claude-opus-4-8';
  await sendIn('mixed', { model, responseId: 'r1', usage });
  await sendIn('mixed', { model, responseId: 'r2' });
  await sendIn('mixed', { model, responseId: 'r3', usage });
  await sendIn('measured', { model, responseId: 'r4', usage });
  await sendIn('measured', { model, responseId: 'r5', usage });
  // A failed call is not a completed one: it still records nothing without usage.
  await assert.rejects(
    accountProviderSend(
      'anthropic',
      {},
      async () => {
        throw new Error('boom');
      },
      model,
      { sessionId: 'failed' }
    )
  );

  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 5, 'every completed call is recorded');
  const unmeasured = ledger.db
    .prepare("SELECT * FROM events WHERE session_id='mixed' AND rates LIKE '%\"inputTokensKnown\":false%'")
    .all();
  assert.equal(unmeasured.length, 1);
  assert.equal(JSON.parse(unmeasured[0].rates).inputTokensKnown, false);
  assert.equal(unmeasured[0].cost_source, 'unpriced');

  const read = (sessionId, sessionIds) =>
    createUsageStatsApi({
      ledger: () => ledger,
      importHistory: async () => {},
      getSessionId: () => sessionId,
    }).getSessionUsage({
      sessionIds,
    });
  const mixed = await read('mixed', ['measured']);
  assert.equal(mixed.turns, 3);
  assert.equal(mixed.unmeasuredTurns, 1);
  assert.equal(mixed.cacheHitRate, null);
  // Measured calls are counted exactly as before, and a fully measured session stays exact.
  assert.equal(mixed.input, 200);
  assert.equal(mixed.output, 20);
  const measured = mixed.sessions.measured;
  assert.equal(measured.turns, 2);
  assert.equal(measured.unmeasuredTurns, 0);
  assert.equal(measured.input, 200);
});

test('usage statistics wait for queued sends; a failing row fails alone', async (t) => {
  const path = join(tempDir('mixdog-usage-writes-'), 'ledger.sqlite');
  const ledger = new UsageLedger(path);
  t.after(() => ledger.close());
  ledger.set('importedThrough', Number.MAX_SAFE_INTEGER);
  const row = (responseId) =>
    makeUsageRecord({
      ts: Date.now(),
      provider: 'openai',
      model: 'gpt-5.5',
      inputTokens: 50,
      outputTokens: 5,
      responseId,
    });
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
  const dir = tempDir('mixdog-usage-refresh-');
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
      ledger.db
        .prepare('UPDATE usage_events SET cost_usd=0.25 WHERE id=(SELECT id FROM usage_events ORDER BY ts LIMIT 1)')
        .run();
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
