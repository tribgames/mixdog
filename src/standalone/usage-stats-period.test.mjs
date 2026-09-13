import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolveUsageStatsPeriod } from './usage-stats-period.mjs';
import { usageStatsSnapshot } from './usage-stats-model.mjs';
import { UsageLedger, makeUsageRecord } from '../runtime/shared/llm/usage-ledger.mjs';
import { createUsageStatsApi } from '../session-runtime/usage-stats-api.mjs';

const now = new Date(2026, 8, 13, 12).getTime();
const period = (view, anchor) => resolveUsageStatsPeriod({ view, anchor, now });

test('hourly is always today; other views navigate complete calendar months, quarters and years', () => {
  const hour = period('hour', '2025-01-01');
  assert.equal(hour.startDay, '2026-09-13');
  assert.equal(hour.endDay, '2026-09-13');
  assert.equal(hour.previousAnchor, null);
  assert.equal(hour.nextAnchor, null);
  assert.equal(hour.toMs, now);
  const day = period('day');
  assert.equal(day.startDay, '2026-09-01');
  assert.equal(day.endDay, '2026-09-30');
  assert.equal(day.previousAnchor, '2026-08-01');
  assert.equal(day.nextAnchor, null);
  const august = period('day', '2026-08-31');
  assert.equal(august.startDay, '2026-08-01');
  assert.equal(august.endDay, '2026-08-31');
  assert.equal(august.nextAnchor, '2026-09-01');
  assert.equal(august.isCurrent, false);
  const week = period('week');
  assert.equal(week.startDay, '2026-07-01');
  assert.equal(week.endDay, '2026-09-30');
  assert.equal(week.previousAnchor, '2026-04-01');
  assert.equal(week.nextAnchor, null);
  const q4 = period('week', '2025-12-31');
  assert.equal(q4.startDay, '2025-10-01');
  assert.equal(q4.nextAnchor, '2026-01-01');
  const year = period('month', '2025-07-01');
  assert.equal(year.startDay, '2025-01-01');
  assert.equal(year.endDay, '2025-12-31');
  assert.equal(year.previousAnchor, '2024-01-01');
  assert.equal(year.nextAnchor, '2026-01-01');
});

test('future anchors clamp to the current period, leap days survive, and malformed dates are rejected', () => {
  for (const view of ['day', 'week', 'month']) {
    assert.deepEqual(period(view, '2030-12-01'), period(view));
  }
  const leap = period('day', '2024-02-29');
  assert.equal(leap.days, 29);
  assert.equal(leap.endDay, '2024-02-29');
  assert.equal(period('day', '2025-02-01').days, 28);
  assert.throws(() => period('day', '2026-02-30'), /valid calendar date/);
  assert.throws(() => period('day', '2026-09'), /calendar date/);
  assert.throws(() => period('unsupported'), /Unknown usage statistics view/);
  const all = period('all');
  assert.equal(all.fromMs, 0);
  assert.equal(all.toMs, now);
  assert.equal(all.previousAnchor, null);
  assert.equal(all.nextAnchor, null);
});

function store(t) {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  return ledger;
}
function record(ledger, id, date) {
  ledger.record([makeUsageRecord({
    id, ts: new Date(date).getTime(), provider: 'openai', model: 'period-fixture',
    inputTokens: 110, inputTokensInclusive: true, cacheReadTokens: 100, outputTokens: 1,
    costUsd: 1, sourceType: 'lead', sessionId: id,
  })]);
}
function stats(ledger, view, anchor) {
  const selected = period(view, anchor);
  return usageStatsSnapshot({
    rollup: ledger.rollup({ hourlyDay: view === 'hour' ? selected.startDay : null }),
    period: selected, now, source: 'all',
  });
}

test('cards, model/provider totals and chart data use the same selected period, with empty future slots', (t) => {
  const ledger = store(t);
  const dates = [
    '2025-12-31T23:59:59', '2026-01-01T00:00:00', '2026-03-31T23:59:59',
    '2026-04-01T00:00:00', '2026-06-30T23:59:59', '2026-07-01T00:00:00',
    '2026-08-31T23:59:59', '2026-09-01T00:00:00', '2026-09-13T00:59:59',
    '2026-09-13T01:00:00', '2026-09-30T12:00:00', '2026-12-31T12:00:00',
  ];
  dates.forEach((date, i) => record(ledger, `request-${i}`, date));
  for (const [view, anchor, records] of [
    ['hour', undefined, 2], ['day', undefined, 3], ['day', '2026-08-01', 1],
    ['week', undefined, 5], ['week', '2026-04-01', 2],
    ['month', undefined, 9], ['month', '2025-01-01', 1], ['all', undefined, 10],
  ]) {
    const result = stats(ledger, view, anchor);
    assert.equal(result.totals.turns, records, `${view}/${anchor}: records`);
    assert.equal(result.totals.tokens, records * 11);
    assert.equal(result.totals.costUsd, records);
    assert.equal(result.totals.sessions, records);
    assert.equal(result.providers[0].models[0].tokens, records * 11);
    assert.equal(result.daily.reduce((sum, row) => sum + row.tokens, 0), records * 11);
    assert.equal(result.previous, null, 'no full-period comparison against an unfinished current period');
  }
  const month = stats(ledger, 'day');
  assert.equal(month.daily.length, 30);
  assert.equal(month.daily.at(-1).day, '2026-09-30');
  assert.equal(month.daily.at(-1).tokens, 0);
  assert.equal(month.daily.at(-1).future, true);
  assert.equal(stats(ledger, 'week').daily.length, 92);
  assert.equal(stats(ledger, 'month').daily.length, 365);
  const hours = stats(ledger, 'hour').hourly;
  assert.equal(hours.length, 24);
  assert.equal(hours[0].tokens, 11);
  assert.equal(hours[1].tokens, 11);
  assert.equal(hours[2].tokens, 0);
  assert.equal(hours[23].future, true);
});

test('hourly buckets retain source precedence and label timeless legacy usage separately instead of inventing hours', (t) => {
  const ledger = store(t);
  record(ledger, 'first-hour', '2026-09-13T00:59:59');
  record(ledger, 'second-hour', '2026-09-13T01:00:00');
  ledger.record([makeUsageRecord({
    id: 'overlapping-summary', ts: now, provider: 'openai', model: 'period-fixture',
    inputTokens: 9999, outputTokens: 99, costUsd: 999, origin: 'gateway',
  })]);
  ledger.preserveLegacyDays({
    '2026-09-13': { restored: true, models: {
      'other/legacy': { provider: 'other', model: 'legacy', turns: 2, input: 20, output: 2, costUsd: 3 },
    } },
  });
  const result = stats(ledger, 'hour');
  assert.equal(result.hourly.length, 25);
  const unknown = result.hourly.at(-1);
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.tokens, 22);
  assert.equal(unknown.turns, 2);
  assert.equal(unknown.costUsd, 3);
  assert.equal(result.hourly.reduce((sum, row) => sum + row.tokens, 0), result.totals.tokens);
  assert.equal(result.hourly.reduce((sum, row) => sum + row.costUsd, 0), 5);
});

test('the hourly response clock includes timestamps retained during a slow historical import', async (t) => {
  const ledger = store(t);
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {
      clock += 3000;
      record(ledger, 'during-import', new Date(clock));
    },
  });
  const result = await api.getUsageStats({ view: 'hour' });
  assert.equal(result.totals.tokens, 11);
  assert.equal(result.hourly.reduce((sum, row) => sum + row.tokens, 0), 11);
});

test('hourly grids follow real 23/25-hour DST days while monthly navigation stays calendar-based', () => {
  const script = `
    import { resolveUsageStatsPeriod } from ${JSON.stringify(new URL('./usage-stats-period.mjs', import.meta.url).href)};
    import { hourlySeries } from ${JSON.stringify(new URL('./usage-stats-hours.mjs', import.meta.url).href)};
    const count = (date) => hourlySeries({}, resolveUsageStatsPeriod({view:'hour',now:new Date(date).getTime()})).length;
    console.log(JSON.stringify([count('2026-03-08T12:00:00'),count('2026-11-01T12:00:00'),
      resolveUsageStatsPeriod({view:'day',anchor:'2026-03-01',now:new Date('2026-04-01T12:00:00').getTime()}).days]));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [23, 25, 31]);
});
