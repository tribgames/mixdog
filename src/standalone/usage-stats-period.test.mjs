import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolveUsageStatsPeriod } from './usage-stats-period.mjs';
import { usageStatsSnapshot } from './usage-stats-model.mjs';
import { UsageLedger, makeUsageRecord } from '../runtime/shared/llm/usage-ledger.mjs';
import { createUsageStatsApi } from '../session-runtime/usage-stats-api.mjs';

const now = new Date(2026, 8, 13, 12).getTime();
const period = (view, anchor) => resolveUsageStatsPeriod({ view, anchor, now });

test('presets select the last 24 hours, 30 dates, 90 dates and 365 dates without future slots', () => {
  const hour = period('hour', '2025-01-01');
  assert.equal(hour.startDay, '2026-09-12');
  assert.equal(hour.endDay, '2026-09-13');
  assert.equal(hour.previousAnchor, null);
  assert.equal(hour.nextAnchor, null);
  assert.equal(hour.toMs, now);
  assert.equal(hour.fromMs, now - 24 * 60 * 60 * 1000);
  assert.equal(hour.endMs, now);
  const seven = period('7d');
  assert.equal(seven.startDay, '2026-09-07');
  assert.equal(seven.endDay, '2026-09-13');
  assert.equal(seven.previousAnchor, '2026-09-06');
  assert.equal(seven.days, 7);
  const day = period('day');
  assert.equal(day.startDay, '2026-08-15');
  assert.equal(day.endDay, '2026-09-13');
  assert.equal(day.previousAnchor, '2026-08-14');
  assert.equal(day.nextAnchor, null);
  const august = period('day', day.previousAnchor);
  assert.equal(august.startDay, '2026-07-16');
  assert.equal(august.endDay, '2026-08-14');
  assert.equal(august.nextAnchor, '2026-09-13');
  assert.equal(august.isCurrent, false);
  const week = period('week');
  assert.equal(week.startDay, '2026-06-16');
  assert.equal(week.endDay, '2026-09-13');
  assert.equal(week.previousAnchor, '2026-06-15');
  assert.equal(week.nextAnchor, null);
  const earlier = period('week', week.previousAnchor);
  assert.equal(earlier.startDay, '2026-03-18');
  assert.equal(earlier.endDay, '2026-06-15');
  assert.equal(earlier.nextAnchor, '2026-09-13');
  const year = period('month');
  assert.equal(year.startDay, '2025-09-14');
  assert.equal(year.endDay, '2026-09-13');
  assert.equal(year.previousAnchor, '2025-09-13');
  assert.equal(year.nextAnchor, null);
  for (const view of ['7d', 'day', 'week', 'month']) {
    const current = period(view);
    const previous = period(view, current.previousAnchor);
    assert.equal(previous.toMs + 1, current.fromMs, 'adjacent pages never overlap or leave gaps');
    assert.deepEqual(period(view, previous.nextAnchor), current);
    assert.equal(current.toMs, now);
    assert.equal(current.endMs, now);
  }
});

test('future anchors clamp to the current period, leap days survive, and malformed dates are rejected', () => {
  for (const view of ['day', 'week', 'month']) {
    assert.deepEqual(period(view, '2030-12-01'), period(view));
  }
  const leap = period('day', '2024-02-29');
  assert.equal(leap.days, 30);
  assert.equal(leap.startDay, '2024-01-31');
  assert.equal(leap.endDay, '2024-02-29');
  assert.equal(period('day', '2025-02-01').days, 30);
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
    rollup: ledger.rollup({
      hourlyDay: view === 'hour' ? selected.startDay : null,
      fromDay: selected.startDay || undefined, toDay: selected.endDay,
      ...(view === 'hour' ? { fromMs: selected.fromMs, toMs: selected.toMs } : {}),
    }),
    period: selected, now, source: 'all',
  });
}

test('cards, providers, models and chart data share the trailing range and never invent future dates', (t) => {
  const ledger = store(t);
  const dates = [
    '2025-01-01T00:00:00', '2025-12-31T23:59:59', '2026-01-01T00:00:00', '2026-03-31T23:59:59',
    '2026-04-01T00:00:00', '2026-06-30T23:59:59', '2026-07-01T00:00:00',
    '2026-07-20T12:00:00', '2026-08-31T23:59:59', '2026-09-01T00:00:00', '2026-09-13T00:59:59',
    '2026-09-13T01:00:00', '2026-09-30T12:00:00', '2026-12-31T12:00:00',
  ];
  dates.forEach((date, i) => record(ledger, `request-${i}`, date));
  for (const [view, anchor, records] of [
    ['hour', undefined, 2], ['7d', undefined, 2], ['day', undefined, 4], ['day', '2026-08-14', 1],
    ['week', undefined, 7], ['week', '2026-06-15', 2],
    ['month', undefined, 11], ['month', '2025-09-13', 1], ['all', undefined, 12],
  ]) {
    const result = stats(ledger, view, anchor);
    assert.equal(result.totals.turns, records, `${view}/${anchor}: records`);
    assert.equal(result.totals.tokens, records * 111);
    assert.equal(result.totals.costUsd, records);
    assert.equal(result.totals.sessions, records);
    assert.equal(result.providers[0].models[0].tokens, records * 111);
    assert.equal(result.daily.reduce((sum, row) => sum + row.tokens, 0), records * 111);
    assert.equal(result.previous, null, 'no full-period comparison against an unfinished current period');
    assert.equal(result.daily.some((row) => row.future || row.day > result.period.endDay), false);
  }
  const month = stats(ledger, 'day');
  assert.equal(month.daily.length, 30);
  assert.equal(month.daily[0].day, '2026-08-15');
  assert.equal(month.daily.at(-1).day, '2026-09-13');
  assert.equal(month.daily.at(-1).tokens, 222);
  assert.equal(month.daily.at(-1).future, false);
  assert.equal(stats(ledger, 'week').daily.length, 90);
  assert.equal(stats(ledger, 'month').daily.length, 365);
  const hours = stats(ledger, 'hour').hourly;
  assert.equal(hours.length, 24);
  assert.equal(hours[12].tokens, 111);
  assert.equal(hours[13].tokens, 111);
  assert.equal(hours[0].tokens, 0);
  assert.equal(hours[23].future, false);
});

test('custom ranges validate explicit calendar dates and include both selected endpoints through the API', async (t) => {
  const ledger = store(t);
  t.mock.method(Date, 'now', () => now);
  record(ledger, 'before', '2026-08-14T23:59:59');
  record(ledger, 'start', '2026-08-15T00:00:00');
  record(ledger, 'end', '2026-08-17T23:59:59');
  record(ledger, 'after', '2026-08-18T00:00:00');
  const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
  const result = await api.getUsageStats({ view: 'custom', startDay: '2026-08-15', endDay: '2026-08-17' });
  assert.equal(result.totals.tokens, 222);
  assert.equal(result.totals.turns, 2);
  assert.equal(result.period.days, 3);
  assert.deepEqual(result.daily.map((day) => day.day), ['2026-08-15', '2026-08-16', '2026-08-17']);
  assert.equal(result.period.previousAnchor, null);
  assert.equal(result.period.nextAnchor, null);
  const custom = (startDay, endDay) => resolveUsageStatsPeriod({ view: 'custom', startDay, endDay, now });
  assert.throws(() => custom(undefined, '2026-08-17'), /requires a start and end/);
  assert.throws(() => custom('2026-08-18', '2026-08-17'), /must not follow/);
  assert.throws(() => custom('2026-02-30', '2026-08-17'), /valid calendar date/);
  assert.throws(() => custom('2026-09-13', '2026-09-14'), /future dates/);
  const leap = custom('2024-02-28', '2024-03-01');
  assert.equal(leap.days, 3);
});

test('rolling hours retain source precedence and leave timeless legacy usage in calendar views', (t) => {
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
  assert.equal(result.hourly.length, 24);
  assert.equal(result.hourly.some((hour) => hour.unknown), false);
  assert.equal(result.totals.turns, 2);
  assert.equal(result.hourly.reduce((sum, row) => sum + row.tokens, 0), result.totals.tokens);
  assert.equal(result.hourly.reduce((sum, row) => sum + row.costUsd, 0), 2);
  assert.equal(stats(ledger, 'day').totals.turns, 4);
});

test('the last 24 hours use exact timestamps for cards, models and hourly bands, including background usage', async (t) => {
  const ledger = store(t);
  const clock = new Date(2026, 8, 13, 12, 34, 56, 789).getTime();
  t.mock.method(Date, 'now', () => clock);
  const start = clock - 24 * 60 * 60 * 1000;
  for (const [id, ts, sourceType] of [
    ['before', start - 1, 'lead'], ['start', start, 'lead'],
    ['background', start + 60 * 60 * 1000, 'native-web-search'],
    ['now', clock, 'lead'], ['future', clock + 1, 'lead'],
  ]) {
    ledger.record([makeUsageRecord({ id, ts, provider: 'openai', model: 'boundary',
      inputTokens: 110, inputTokensInclusive: true, cacheReadTokens: 100,
      outputTokens: 1, costUsd: 1, sessionId: id, sourceType })]);
  }
  const api = createUsageStatsApi({ ledger: () => ledger, importHistory: async () => {} });
  const result = await api.getUsageStats({ view: 'hour' });
  assert.equal(result.totals.turns, 3);
  assert.equal(result.totals.input, 30);
  assert.equal(result.totals.output, 3);
  assert.equal(result.totals.cacheRead, 300);
  assert.equal(result.totals.costUsd, 3);
  assert.equal(result.providers[0].models[0].tokens, 333);
  assert.equal(result.hourly.length, 24);
  assert.equal(result.hourly[0].label, '12:34');
  assert.equal(result.hourly[0].fromMs, start);
  assert.equal(result.hourly[0].toMs, start + 3600000);
  assert.equal(result.hourly.at(-1).toMs, clock);
  assert.equal(result.hourly[0].tokens, 111);
  assert.equal(result.hourly[1].tokens, 111);
  assert.equal(result.hourly.at(-1).tokens, 111);
  assert.equal(result.hourly.reduce((sum, hour) => sum + hour.tokens, 0), 333);
  assert.equal(result.hourly.reduce((sum, hour) => sum + hour.costUsd, 0), 3);
  assert.equal(result.daily.reduce((sum, day) => sum + day.tokens, 0), 333);
  const conversation = await api.getUsageStats({ view: 'hour', source: 'conversation' });
  assert.equal(conversation.totals.turns, 2);
  assert.equal(conversation.hourly.reduce((sum, hour) => sum + hour.tokens, 0), 222);
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
  assert.equal(result.totals.tokens, 111);
  assert.equal(result.hourly.reduce((sum, row) => sum + row.tokens, 0), 111);
});

test('rolling grids retain 24 elapsed hours across DST while monthly navigation stays calendar-based', () => {
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
  assert.deepEqual(JSON.parse(child.stdout), [24, 24, 30]);
});
