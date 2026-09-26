import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { rollupUsage } from './usage-ledger-rollup.mjs';
import { usageRollupDayKey } from './usage-rollup.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function fileLedger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-usage-rollup-worker-'));
  const ledger = new UsageLedger(join(dir, 'ledger.sqlite'));
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return ledger;
}

// Rows across 40 days: conversation and background sources, several routes,
// gateway summaries overlapping details (rank), and legacy whole-day totals.
function seed(ledger, base) {
  const rows = [];
  for (let index = 0; index < 160; index += 1) {
    const ts = base - Math.floor(index / 4) * (DAY / 4) - (index % 7) * 60_000;
    rows.push(
      makeUsageRecord({
        ts,
        provider: index % 3 === 0 ? 'anthropic-oauth' : 'openai',
        model: index % 2 ? 'gpt-5.5' : 'claude-opus-4-8',
        sessionId: `session-${index % 5}`,
        sourceType: index % 4 === 0 ? 'worker' : 'lead',
        inputTokens: 1000 + index,
        outputTokens: 50 + index,
        cacheReadTokens: index * 3,
        cacheWriteTokens: index % 11,
        durationMs: 100 + index,
        responseId: `response-${index}`,
        ...(index % 9 === 0 ? { origin: 'gateway' } : {}),
      })
    );
  }
  ledger.record(rows);
  ledger.preserveLegacyDays({
    [usageRollupDayKey(base - 30 * DAY)]: {
      restored: true,
      models: {
        'other/legacy': { provider: 'other', model: 'legacy', turns: 2, input: 20, output: 2, costUsd: 3 },
      },
    },
  });
}

test('the worker rollup is identical to the in-thread rollup for every query shape', async (t) => {
  const ledger = fileLedger(t);
  const now = Date.now();
  seed(ledger, now);
  const today = usageRollupDayKey(now);
  const queries = [
    {},
    { fromDay: usageRollupDayKey(now - 6 * DAY), toDay: today },
    { fromDay: usageRollupDayKey(now - 40 * DAY), toDay: usageRollupDayKey(now - 10 * DAY) },
    { hourlyDay: usageRollupDayKey(now - DAY), fromMs: now - DAY, toMs: now, fromDay: usageRollupDayKey(now - DAY), toDay: today },
    { fromMs: now - 3 * DAY - 5 * HOUR, toMs: now - DAY + HOUR, fromDay: usageRollupDayKey(now - 3 * DAY), toDay: usageRollupDayKey(now - DAY) },
  ];
  for (const query of queries) {
    assert.deepEqual(await ledger.rollupAsync(query), rollupUsage(ledger.db, query), JSON.stringify(query));
  }
});

test('usage statistics from the worker equal the in-thread statistics for every view', async (t) => {
  const ledger = fileLedger(t);
  const now = Date.now();
  seed(ledger, now);
  ledger.set('importedThrough', Number.MAX_SAFE_INTEGER);
  const noImport = async () => {};
  const viaWorker = createUsageStatsApi({ ledger: () => ledger, importHistory: noImport });
  // Same ledger, but its rollup always runs in-thread and uncached.
  const inThreadLedger = Object.create(ledger, {
    rollupAsync: { value: async (query) => rollupUsage(ledger.db, query) },
  });
  const inThread = createUsageStatsApi({ ledger: () => inThreadLedger, importHistory: noImport });
  const views = [
    {},
    { days: null },
    { days: 0 },
    { days: 7 },
    { view: 'hour' },
    { view: 'hour', source: 'conversation' },
    { view: '7d' },
    { view: 'day', source: 'conversation' },
    { view: 'week' },
    { view: 'month' },
    { view: 'all' },
    { view: 'custom', startDay: usageRollupDayKey(now - 20 * DAY), endDay: usageRollupDayKey(now - 2 * DAY) },
    {
      view: 'custom',
      startDay: usageRollupDayKey(now - 3 * DAY),
      endDay: usageRollupDayKey(now - DAY),
      startTime: '06:30',
      endTime: '18:00',
    },
  ];
  for (const options of views) {
    // Both calls resolve their period from one clock.
    const clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    const [worker, local] = [await viaWorker.getUsageStats(options), await inThread.getUsageStats(options)];
    t.mock.restoreAll();
    assert.deepEqual(worker, local, JSON.stringify(options));
  }
});

test('an unchanged ledger answers from cache; any commit refreshes through the worker', async (t) => {
  const ledger = fileLedger(t);
  const now = Date.now();
  seed(ledger, now);
  const first = await ledger.rollupAsync();
  assert.equal(await ledger.rollupAsync(), first, 'unchanged ledger must reuse the cached rollup');
  assert.equal(ledger.rollup(), first, 'sync and async rollups share one cache');
  const [a, b] = await Promise.all([ledger.rollupAsync({ fromDay: '2026-01-01' }), ledger.rollupAsync({ fromDay: '2026-01-01' })]);
  assert.equal(a, b, 'concurrent identical queries share one worker request');

  ledger.record([
    makeUsageRecord({ ts: now, provider: 'openai', model: 'fresh', inputTokens: 7, outputTokens: 1, responseId: 'fresh' }),
  ]);
  const refreshed = await ledger.rollupAsync();
  assert.notEqual(refreshed, first);
  assert.deepEqual(refreshed, rollupUsage(ledger.db, {}));

  // A commit from another connection is seen as well.
  const other = new UsageLedger(ledger.path);
  other.record([
    makeUsageRecord({ ts: now, provider: 'openai', model: 'other', inputTokens: 9, outputTokens: 1, responseId: 'other' }),
  ]);
  other.close();
  assert.deepEqual(await ledger.rollupAsync(), rollupUsage(ledger.db, {}));
});

test('the rollup query does not run on the event loop', async (t) => {
  const ledger = fileLedger(t);
  seed(ledger, Date.now());
  let inThreadQueries = 0;
  const prepare = ledger.db.prepare.bind(ledger.db);
  t.mock.method(ledger.db, 'prepare', (sql) => {
    if (/FROM (daily|usage_events|day_sessions|legacy_days)/.test(sql)) inThreadQueries += 1;
    return prepare(sql);
  });
  const result = await ledger.rollupAsync({ fromDay: '2000-01-01' });
  assert.ok(Object.keys(result.days).length > 0);
  assert.equal(inThreadQueries, 0);
});
