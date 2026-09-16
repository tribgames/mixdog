import assert from 'node:assert/strict';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { usageStatsSnapshot } from '../../../standalone/usage-stats-model.mjs';
import { resolveUsageStatsPeriod } from '../../../standalone/usage-stats-period.mjs';

const now = new Date(2026, 8, 13, 12).getTime();

test('native Cursor historical counts survive but fabricated inputs and costs never reach cards or charts', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  // Preserve the exact old adapter record, including its inflated price.
  const original = {
    ...makeUsageRecord({
      id: 'old-cursor',
      ts: now,
      provider: 'cursor-oauth',
      model: 'claude-opus-4-8',
      inputTokens: 2_000_000,
      outputTokens: 7,
      sourceType: 'lead',
      sessionId: 'session',
    }),
    costUsd: 50,
    costSource: 'subscription',
  };
  ledger.record([original]);
  const before = ledger.db.prepare('SELECT * FROM events').all();
  for (const view of ['hour', 'day', 'all']) {
    const period = resolveUsageStatsPeriod({ view, now });
    const rollup = ledger.rollup({
      fromDay: period.startDay || undefined,
      toDay: '2026-09-13',
      hourlyDay: view === 'hour' ? period.startDay : null,
      ...(view === 'hour' ? { fromMs: period.fromMs, toMs: period.toMs } : {}),
    });
    const stats = usageStatsSnapshot({ rollup, period, now, source: 'all' });
    assert.equal(stats.totals.turns, 1);
    assert.equal(stats.totals.sessions, 1);
    assert.equal(stats.totals.tokens, 7);
    assert.equal(stats.totals.unmeasuredTurns, 1);
    assert.equal(stats.totals.costCoverage, 0);
    assert.equal(stats.totals.costUsd, 0);
    assert.equal(stats.providers[0].input, null);
    assert.equal(stats.providers[0].cacheRead, null);
    assert.equal(stats.providers[0].cacheHitRate, null);
    const chart = view === 'hour' ? stats.hourly : stats.daily;
    assert.equal(
      chart.reduce((sum, row) => sum + row.tokens, 0),
      7
    );
    assert.equal(
      chart.reduce((sum, row) => sum + row.costUsd, 0),
      0
    );
    assert.equal(
      chart.reduce((sum, row) => sum + (row.unmeasuredTurns || 0), 0),
      1
    );
  }
  assert.deepEqual(ledger.db.prepare('SELECT * FROM events').all(), before);
  assert.equal(before[0].input, 2_000_000);
  assert.equal(before[0].cost_usd, 50);
});

test('unknown native input prevents an output-only catalog valuation for either Cursor auth route', () => {
  for (const provider of ['cursor-api', 'cursor-oauth']) {
    const record = makeUsageRecord({
      ts: now,
      provider,
      model: 'claude-opus-4-8',
      inputTokens: null,
      inputTokensKnown: false,
      outputTokens: 7,
    });
    assert.equal(record.input, 0);
    assert.equal(record.output, 7);
    assert.equal(record.costUsd, null);
    assert.equal(record.costSource, 'unpriced');
    assert.equal(record.rates.unpricedReason, 'unmeasured-input');
    assert.equal(record.rates.inputTokensKnown, false);
    assert.equal(record.rates.requestedModel, null, 'an unrecorded requested id is not invented');
  }
});

test('period-scoped reads match full-history selection, retain precedence and do not lose cross-route sessions', (t) => {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  const rows = [];
  for (let day = 0; day < 80; day++) {
    const date = new Date(now);
    date.setDate(date.getDate() - day);
    for (const provider of ['openai', 'anthropic-oauth', 'cursor-api']) {
      for (const origin of ['live', 'gateway'])
        for (const sessionId of ['a', 'b']) {
          rows.push(
            makeUsageRecord({
              id: `${day}-${provider}-${origin}-${sessionId}`,
              ts: date.getTime(),
              provider,
              model: 'fixture',
              origin,
              sessionId,
              sourceType: 'lead',
              inputTokens: 100,
              outputTokens: 10,
              costUsd: 1,
            })
          );
        }
    }
  }
  ledger.record(rows);
  for (const view of ['hour', 'day', 'week', 'month', 'all']) {
    const period = resolveUsageStatsPeriod({ view, now });
    const options = {
      hourlyDay: view === 'hour' ? period.startDay : null,
      ...(view === 'hour' ? { fromMs: period.fromMs, toMs: period.toMs } : {}),
    };
    const full = usageStatsSnapshot({ rollup: ledger.rollup(options), period, now, source: 'all' });
    const scoped = usageStatsSnapshot({
      rollup: ledger.rollup({
        ...options,
        fromDay: period.startDay || undefined,
        toDay: '2026-09-13',
      }),
      period,
      now,
      source: 'all',
    });
    assert.deepEqual(scoped, full, view);
    assert.equal(scoped.totals.sessions, 2);
    if (view === 'hour') {
      // Both exact endpoints belong to the rolling 24-hour range.
      assert.equal(scoped.totals.turns, 12);
      assert.equal(scoped.totals.tokens, 920); // Two endpoints, each 4 measured × 110 + 2 output-only × 10.
    }
  }
});
