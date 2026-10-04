import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UsageLedger, makeUsageRecord } from './usage-ledger.mjs';
import { quotaWindowSpanMs } from './usage-ledger-quota.mjs';
import { createUsageStatsApi } from '../../../session-runtime/usage-stats-api.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A five-hour window that opened at 13:00 and resets at 18:00.
const opened = new Date(2026, 8, 30, 13).getTime();
const resetAt = opened + 5 * HOUR;
const at = (hours, minutes = 0) => opened + hours * HOUR + minutes * MINUTE;

function store(t) {
  const ledger = new UsageLedger(':memory:');
  t.after(() => ledger.close());
  return ledger;
}
const reading = (ts, usedPct, extra = {}) => ({
  provider: 'anthropic-oauth',
  account: 'default',
  label: '5H',
  ts,
  usedPct,
  resetAt,
  ...extra,
});
// Unpriced models: the meter is split by tokens, which keeps shares exact.
const request = (ts, model, extra = {}) =>
  makeUsageRecord({
    ts,
    provider: 'anthropic-oauth',
    model,
    sessionId: 'session-a',
    sourceType: 'lead',
    inputTokens: 1000,
    outputTokens: 100,
    account: 'default',
    ...extra,
  });
const byModel = (history) => Object.fromEntries(history.models.map((row) => [row.model, row.consumed]));

test('model-scoped Claude quota never includes another family or a different account', async (t) => {
  const ledger = store(t);
  const priced = (ts, model, costUsd, account = 'default') => ({
    ...request(ts, model, { account }),
    costUsd,
    costSource: 'subscription',
  });
  ledger.record([
    priced(at(0, 10), 'claude-opus-5-5', 100),
    priced(at(0, 20), 'claude-fable-5-1', 1),
    priced(at(0, 40), 'claude-fable-5-1', 1),
    priced(at(0, 45), 'claude-sonnet-5-5', 200),
    priced(at(0, 50), 'claude-fable-5-1', 999, 'other'),
  ]);
  for (const label of ['7D', '7D Fable', '7D Opus', '7D Unknown']) {
    const extra = { label, resetAt: opened + 7 * 24 * HOUR };
    ledger.recordQuota([reading(opened, 0, extra), reading(at(0, 30), 1, extra), reading(at(1), 2, extra)]);
  }
  const fable = await ledger.quotaHistoryAsync({ account: 'default', label: '7D Fable', now: at(2) });
  assert.equal(fable.summary.costUsd, 2);
  assert.deepEqual(
    fable.models.map((row) => row.model),
    ['claude-fable-5-1']
  );
  const whole = await ledger.quotaHistoryAsync({ account: 'default', label: '7D', now: at(2) });
  assert.equal(whole.summary.costUsd, 302);
  const opus = await ledger.quotaHistoryAsync({ account: 'default', label: '7D Opus', now: at(2) });
  assert.equal(opus.summary.costUsd, 100);
  const unknown = await ledger.quotaHistoryAsync({ account: 'default', label: '7D Unknown', now: at(2) });
  assert.equal(unknown.summary.costUsd, 0);
  assert.equal(unknown.summary.costPerPercent, null);
  const listed = await ledger.quotaWindowsAsync({ account: 'default', label: '7D Fable', now: at(2) });
  assert.equal(listed.windows[0].costUsd, 2);
});

test('exact request timestamps stay on their own side of a quota reading', async (t) => {
  const ledger = store(t);
  ledger.record([
    { ...request(opened + 30_000, 'model-priced'), costUsd: 1, costSource: 'subscription' },
    { ...request(opened + 70_000, 'model-priced'), costUsd: 100, costSource: 'subscription' },
  ]);
  ledger.recordQuota([reading(opened, 0), reading(opened + MINUTE, 1)]);
  const history = await ledger.quotaHistoryAsync({ now: at(0, 2) });
  assert.equal(history.summary.costUsd, 101);
  assert.equal(history.summary.costPerPercent, 1, 'the $100 request after the reading cannot price the earlier rise');
  assert.equal(history.outside, 0, 'the request thirty seconds after the baseline is not lost to minute rounding');
});

function calibratedWindow(ledger, { account = 'default', costUsd = 0.5, reset = resetAt, start = opened } = {}) {
  ledger.recordQuota([reading(start, 0, { account, resetAt: reset })]);
  let used = 0;
  for (let index = 0; index < 60; index += 1) {
    const ts = start + (index * 2 + 1) * MINUTE;
    ledger.record([{ ...request(ts, 'model-priced', { account }), costUsd, costSource: 'subscription' }]);
    used += index % 4 === 0 ? 2.5 : 0.5;
    ledger.recordQuota([reading(ts + MINUTE, used, { account, resetAt: reset })]);
  }
  ledger.recordQuota([reading(start + 122 * MINUTE, used + 4, { account, resetAt: reset })]);
}

test('mixed and outside-only value is separate from recorded money across cards, slots and history', async (t) => {
  const ledger = store(t);
  calibratedWindow(ledger);
  const history = await ledger.quotaHistoryAsync({ now: at(2, 3) });
  assert.equal(history.summary.costUsd, 30);
  assert.equal(history.totals.costUsd, 30, 'the usage ledger is never inflated with inferred money');
  assert.equal(history.summary.consumed, 64);
  assert.ok(Math.abs(history.summary.costPerPercent - 1) < 0.05);
  assert.ok(Math.abs(history.summary.outsideCostUsd - 34) < 2);
  assert.equal(history.summary.estimatedTotalCostUsd, Math.round((30 + history.summary.outsideCostUsd) * 1e6) / 1e6);
  assert.ok(Math.abs(history.totals.consumed + history.outside - 64) < 0.02);
  assert.ok(
    Math.abs(history.slots.reduce((sum, row) => sum + (row.outsideCostUsd ?? 0), 0) - history.summary.outsideCostUsd) <
      0.00001
  );
  const listed = await ledger.quotaWindowsAsync({ now: at(2, 3) });
  assert.equal(listed.windows[0].outsideCostUsd, history.summary.outsideCostUsd);
  assert.equal(listed.windows[0].estimatedTotalCostUsd, history.summary.estimatedTotalCostUsd);
  const partial = await ledger.quotaHistoryAsync({
    now: at(2, 3),
    view: 'hour',
    fromMs: at(2),
    toMs: at(2, 1),
  });
  assert.ok(Math.abs(partial.summary.outside - 2) < 0.01);
  assert.ok(
    Math.abs(partial.summary.outsideCostUsd - 2) < 0.15,
    'only the overlapping half of an outside interval is valued'
  );
});

test('the five-hour meter keeps outside use out of the weekly calibration', async (t) => {
  const weekly = { label: '7D', resetAt: opened + 7 * 24 * HOUR };
  // Three five-hour windows at $10 per weekly point (four five-hour points).
  // In the last, a $2 request shares a one-point weekly rise with outside use.
  const build = (withFiveHour) => {
    const ledger = store(t);
    ledger.recordQuota([reading(opened, 0, weekly)]);
    let week = 0;
    for (const [index, spends] of [
      [0, [10, 10, 10, 10]],
      [1, [10, 10, 10, 10]],
      [2, [10, 10, 2]],
    ]) {
      const start = opened + index * 5 * HOUR;
      let five = 0;
      spends.forEach((costUsd, step) => {
        const ts = start + (step * 10 + 5) * MINUTE;
        ledger.record([{ ...request(ts, 'model-priced'), costUsd, costSource: 'subscription' }]);
        five += costUsd === 2 ? 6 : 4;
        week += 1;
        ledger.recordQuota([
          reading(ts + 5 * MINUTE, week, weekly),
          ...(withFiveHour ? [reading(ts + 5 * MINUTE, five, { resetAt: start + 5 * HOUR })] : []),
        ]);
      });
    }
    return ledger;
  };
  const now = opened + 15 * HOUR;
  const filtered = await build(true).quotaHistoryAsync({ label: '7D', now });
  const weeklyOnly = await build(false).quotaHistoryAsync({ label: '7D', now });
  assert.equal(filtered.summary.costPerPercent, 10);
  assert.ok(weeklyOnly.summary.costPerPercent < 9.9, 'the weekly meter alone treats the rise as rounding');
  assert.ok(Math.abs(filtered.outside - 0.8) < 0.01, 'the $2 request explains 0.2 of the mixed point');
  const listed = await build(true).quotaWindowsAsync({ label: '7D', now });
  assert.equal(listed.windows[0].costPerPercent, 10);
});

test('calibration never leaks between accounts, and a changed allowance replaces the earlier window', async (t) => {
  const ledger = store(t);
  calibratedWindow(ledger);
  calibratedWindow(ledger, { account: 'work', costUsd: 1 });
  calibratedWindow(ledger, { costUsd: 0.25, start: resetAt, reset: resetAt + 5 * HOUR });
  const current = await ledger.quotaHistoryAsync({ now: at(7, 3), account: 'default' });
  const other = await ledger.quotaHistoryAsync({ now: at(7, 3), account: 'work' });
  assert.ok(Math.abs(current.summary.costPerPercent - 0.5) < 0.025);
  assert.ok(Math.abs(other.summary.costPerPercent - 2) < 0.1);
});

test('a new window continues the earlier window from its first reading, identically in every view', async (t) => {
  const ledger = store(t);
  calibratedWindow(ledger);
  // The next window has only its first rise from zero: one request showing a
  // whole rounded-up step, which bounds its use but does not measure it.
  const next = resetAt + 5 * HOUR;
  ledger.record([{ ...request(resetAt + 5 * MINUTE, 'model-priced'), costUsd: 0.1, costSource: 'subscription' }]);
  ledger.recordQuota([reading(resetAt, 0, { resetAt: next }), reading(resetAt + 10 * MINUTE, 1, { resetAt: next })]);
  const now = resetAt + 11 * MINUTE;
  const history = await ledger.quotaHistoryAsync({ now });
  assert.ok(Math.abs(history.summary.costPerPercent - 1) < 0.05, 'the earlier window supplies the value');
  assert.equal(history.outside, 0, 'the first rise from zero is not outside use');
  const listed = await ledger.quotaWindowsAsync({ now });
  assert.equal(listed.windows[0].costPerPercent, history.summary.costPerPercent);
  const range = await ledger.quotaHistoryAsync({ now, view: 'hour', fromMs: opened, toMs: now });
  assert.equal(range.summary.costPerPercent > 0.95, true);
});

test('each week judges outside use by its own five-hour windows, so a new plan is not outside use', async (t) => {
  const ledger = store(t);
  const week = 7 * 24 * HOUR;
  // The same $10 requests move the meters twice as far in the second week.
  for (const [index, dollarsPerPoint] of [
    [0, 10],
    [1, 5],
  ]) {
    const opensAt = opened + index * week;
    const weekly = { label: '7D', resetAt: opensAt + week };
    ledger.recordQuota([reading(opensAt, 0, weekly)]);
    let used = 0;
    for (let five = 0; five < 3; five += 1) {
      const start = opensAt + five * 5 * HOUR;
      let fiveUsed = 0;
      for (let step = 0; step < 4; step += 1) {
        const ts = start + (step * 10 + 5) * MINUTE;
        ledger.record([{ ...request(ts, 'model-priced'), costUsd: 10, costSource: 'subscription' }]);
        used += 10 / dollarsPerPoint;
        fiveUsed += 40 / dollarsPerPoint;
        ledger.recordQuota([
          reading(ts + 5 * MINUTE, used, weekly),
          reading(ts + 5 * MINUTE, fiveUsed, { resetAt: start + 5 * HOUR }),
        ]);
      }
    }
  }
  const history = await ledger.quotaHistoryAsync({ label: '7D', now: opened + week + 15 * HOUR });
  assert.ok(Math.abs(history.summary.costPerPercent - 5) < 0.25);
  assert.equal(history.outside, 0);
});

test('sparse weekly history keeps the existing full-limit projection and values known outside usage', async (t) => {
  const ledger = store(t);
  ledger.record([
    { ...request(at(0, 10), 'model-priced'), costUsd: 20, costSource: 'subscription' },
    { ...request(at(1, 10), 'model-priced'), costUsd: 30, costSource: 'subscription' },
  ]);
  ledger.recordQuota([reading(at(0, 30), 2), reading(at(1, 30), 5), reading(at(2, 30), 6)]);
  const history = await ledger.quotaHistoryAsync({ now: at(3) });
  assert.equal(history.summary.costPerPercent, 10, 'large reading gaps do not erase historical value');
  assert.equal(history.summary.costUsd, 50);
  assert.equal(history.summary.outsideCostUsd, 10);
  assert.equal(history.summary.estimatedTotalCostUsd, 60);
  const listed = await ledger.quotaWindowsAsync({ now: at(3) });
  assert.equal(listed.windows[0].costPerPercent, 10);
});

test('sparse, unpriced, saturated and unobserved intervals do not invent a conversion rate', async (t) => {
  const ledger = store(t);
  ledger.record([request(at(0, 10), 'model-unpriced')]);
  ledger.recordQuota([reading(at(0, 30), 10), reading(at(3), 100)]);
  const history = await ledger.quotaHistoryAsync({ now: at(3) });
  assert.equal(history.summary.costPerPercent, null);
  assert.equal(history.summary.outsideCostUsd, null);
  assert.equal(history.summary.estimatedTotalCostUsd, null);
});

test('a repeated reading extends its row and a drifting reset stays one window', (t) => {
  const ledger = store(t);
  ledger.recordQuota([reading(at(0, 30), 10), reading(at(0, 35), 10)]);
  ledger.recordQuota([reading(at(1), 20, { resetAt: resetAt + 30_000 }), reading(at(0, 50), 15)]);
  const rows = ledger.db.prepare('SELECT ts,seen_until,used_pct,reset_at FROM quota_samples ORDER BY ts').all();
  assert.deepEqual(
    rows.map((row) => [row.ts, row.seen_until, row.used_pct, row.reset_at]),
    [
      [at(0, 30), at(0, 35), 10, resetAt],
      [at(1), at(1), 20, resetAt],
    ],
    'the late 13:50 reading is ignored and the 30 s reset drift keeps the first reset'
  );
  assert.equal(quotaWindowSpanMs('7D Opus'), 7 * 24 * HOUR);
  assert.equal(quotaWindowSpanMs('M'), null);
});

test('the open window splits each rise over the requests behind it and forecasts the pace', async (t) => {
  const ledger = store(t);
  ledger.record([
    request(at(0, 10), 'model-a'),
    request(at(0, 40), 'model-a'),
    request(at(0, 50), 'model-b', { inputTokens: 3200 }),
    request(at(3, 30), 'model-b'),
    // Another account of the same subscription moves its own meter only.
    request(at(3, 40), 'model-a', { account: 'work', inputTokens: 90_000 }),
  ]);
  ledger.recordQuota([reading(at(0, 30), 10), reading(at(0, 35), 10)]);
  ledger.recordQuota([reading(at(1), 20)]);
  ledger.recordQuota([reading(at(2), 25)]);
  ledger.recordQuota([reading(at(3, 48), 40), reading(at(3, 48), 70, { account: 'work' })]);
  const history = await ledger.quotaHistoryAsync({ now: at(3, 48) });

  assert.deepEqual(history.selection, { provider: 'anthropic-oauth', account: 'default', label: '5H' });
  assert.deepEqual(
    history.subscriptions.map((row) => row.account),
    ['default', 'work']
  );
  assert.equal(history.period.fromMs, opened);
  assert.equal(history.period.toMs, resetAt);
  assert.equal(history.focus.usedPct, 40);
  assert.equal(history.focus.current, true);
  // 10 % before 13:30 is model-a's; 13:30→14:00 splits 1,100 : 3,300 tokens;
  // 14:00→15:00 had no Mixdog request; 15:00→16:48 is model-b's.
  assert.deepEqual(byModel(history), { 'model-a': 12.5, 'model-b': 22.5 });
  assert.equal(history.outside, 5);
  assert.equal(history.summary.consumed, 40);
  // The last hour rose from 31.7 % to 40 %: about 8.3 % an hour runs out after the reset.
  assert.equal(history.forecast.exhaustAt, null);
  assert.equal(history.forecast.ratePerHour, 8.33);
  assert.equal(history.forecast.atResetPct, 50);
  assert.equal(history.slotMs, 30 * MINUTE);
  assert.equal(history.slots.length, 10);
  // The unattributed 5 % spreads over the hour it rose in.
  assert.deepEqual(
    history.slots.filter((slot) => slot.outside > 0).map((slot) => [slot.fromMs, slot.outside]),
    [
      [at(1), 2.5],
      [at(1, 30), 2.5],
    ]
  );
  assert.equal(history.points[0][0], opened, 'the path opens at zero when the window opened');
  const listed = await ledger.quotaWindowsAsync({ now: at(3, 48) });
  assert.deepEqual(
    listed.windows.map((row) => row.current),
    [true]
  );
  assert.equal(listed.windows[0].peak, 40);
  assert.equal(listed.windows[0].tokens, history.totals.tokens, 'a listed window adds up what its own view does');
});

test('records made before accounts were recorded belong to the account in use when recording began', async (t) => {
  const ledger = store(t);
  ledger.record([
    // Written before records named an account.
    request(at(0, 10), 'model-a', { account: '' }),
    request(at(0, 20), 'model-a'),
    request(at(0, 40), 'model-b', { account: 'work' }),
  ]);
  ledger.recordQuota([reading(at(0, 50), 10), reading(at(0, 50), 10, { account: 'work' })]);
  const first = await ledger.quotaHistoryAsync({ now: at(1), account: 'default' });
  assert.equal(first.totals.turns, 2, 'the first account named keeps the older records');
  const other = await ledger.quotaHistoryAsync({ now: at(1), account: 'work' });
  assert.deepEqual(byModel(other), { 'model-b': 10 }, 'another account never counts them');
  assert.equal(other.totals.turns, 1);
});

test('windows reset, page and add up over a period', async (t) => {
  const ledger = store(t);
  const nextReset = resetAt + 5 * HOUR;
  ledger.record([request(at(0, 20), 'model-a'), request(at(5, 40), 'model-a')]);
  ledger.recordQuota([reading(at(0, 30), 10)]);
  ledger.recordQuota([reading(at(3), 100)]);
  ledger.recordQuota([reading(at(5, 45), 5, { resetAt: nextReset })]);
  const now = at(6);
  const latest = await ledger.quotaHistoryAsync({ now });
  assert.equal(latest.period.fromMs, resetAt, 'the second window opened when the first reset');
  assert.equal(latest.period.nextAnchor, null);
  const listed = await ledger.quotaWindowsAsync({ now });
  assert.deepEqual([listed.total, listed.pageCount], [2, 1]);
  assert.equal(listed.windows[1].exhaustedAt, at(3));
  assert.equal(listed.windows[1].peak, 100);

  const earlier = await ledger.quotaHistoryAsync({ now, anchor: latest.period.previousAnchor });
  assert.equal(earlier.period.toMs, resetAt);
  assert.equal(earlier.focus.current, false);
  assert.equal(earlier.focus.exhaustedAt, at(3));
  assert.equal(earlier.forecast, null);
  assert.deepEqual(earlier.points.slice(-2), [
    [resetAt, 100, 2],
    [resetAt, 0, 1],
  ]);

  const day = await ledger.quotaHistoryAsync({ now, view: 'hour', fromMs: now - 24 * HOUR, toMs: now });
  assert.equal(day.summary.maxedOut, 1);
  assert.equal(day.summary.consumed, 105);
  assert.deepEqual(
    day.peaks.map((row) => [row.peak, row.peakAt]),
    [
      [100, at(3)],
      [5, at(5, 45)],
    ]
  );
});

test('the window history pages newest first, each page reading its windows and their calibration', async (t) => {
  const ledger = store(t);
  // Twelve five-hour windows back to back, the n-th read once at n %.
  for (let index = 0; index < 12; index += 1) {
    const reset = resetAt + index * 5 * HOUR;
    ledger.recordQuota([reading(reset - 4 * HOUR, index + 1, { resetAt: reset })]);
  }
  ledger.record([request(at(0, 20), 'model-a')]);
  const now = resetAt + 11 * 5 * HOUR - HOUR;
  const first = await ledger.quotaWindowsAsync({ now });
  assert.deepEqual([first.page, first.pageCount, first.total], [0, 2, 12]);
  assert.deepEqual(
    first.windows.map((row) => row.peak),
    [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]
  );
  assert.equal(first.windows[0].current, true);
  const last = await ledger.quotaWindowsAsync({ now, page: 1 });
  assert.deepEqual(
    last.windows.map((row) => row.peak),
    [2, 1]
  );
  assert.equal(last.windows[1].tokens, 1100, 'the oldest window counts the request behind it');
  assert.equal((await ledger.quotaWindowsAsync({ now, page: 9 })).page, 1, 'a page past the end is the last');
});

test('an idle meter stays one row, and the subscription whose meter moved opens first', async (t) => {
  const ledger = store(t);
  // An idle window reads 0 % against a reset that moves with the clock.
  const idle = (ts) => ({
    provider: 'openai-oauth',
    account: 'default',
    label: '5H',
    ts,
    usedPct: 0,
    resetAt: ts + 5 * HOUR,
  });
  ledger.recordQuota([idle(at(0))]);
  ledger.recordQuota([reading(at(0, 30), 10)]);
  ledger.recordQuota([idle(at(1))]);
  ledger.recordQuota([idle(at(2))]);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) AS n FROM quota_samples WHERE provider='openai-oauth'").get().n, 1);
  const history = await ledger.quotaHistoryAsync({ now: at(2) });
  assert.equal(history.selection.provider, 'anthropic-oauth', 'measured last is not moved last');
  const codex = await ledger.quotaHistoryAsync({ now: at(2), provider: 'openai-oauth' });
  assert.equal(codex.period, null, 'an idle meter opened no window');
});

test('an early reset opens the current window before the next request', async (t) => {
  const ledger = store(t);
  ledger.recordQuota([reading(at(0, 30), 10), reading(at(1), 40)]);
  // The provider resets the window two hours early; nothing has run since.
  const early = at(2);
  ledger.recordQuota([reading(early, 0, { resetAt: early + 5 * HOUR }), reading(at(2, 30), 0, { resetAt: early + 5 * HOUR })]);
  const now = at(2, 31);
  const history = await ledger.quotaHistoryAsync({ now });
  assert.equal(history.period.fromMs, early);
  assert.equal(history.period.toMs, early + 5 * HOUR);
  assert.equal(history.period.isCurrent, true);
  assert.equal(history.focus.usedPct, 0);
  const earlier = await ledger.quotaHistoryAsync({ now, anchor: history.period.previousAnchor });
  assert.equal(earlier.period.toMs, early, 'the reset closed the earlier window');
  assert.equal(earlier.period.isCurrent, false);
  assert.equal(earlier.focus.peak, 40);
  const listed = await ledger.quotaWindowsAsync({ now });
  assert.deepEqual(
    listed.windows.map((row) => [row.peak, row.current]),
    [
      [0, true],
      [40, false],
    ]
  );
});

test('a subscription opens on its weekly window unless another was asked for', async (t) => {
  const ledger = store(t);
  const week = resetAt + 5 * 24 * HOUR;
  ledger.recordQuota([reading(at(0, 30), 10), reading(at(0, 30), 20, { label: '7D Opus', resetAt: week })]);
  ledger.recordQuota([reading(at(0, 30), 30, { label: '7D', resetAt: week })]);
  const opened = await ledger.quotaHistoryAsync({ now: at(1) });
  assert.deepEqual(opened.subscriptions[0].windows, ['5H', '7D', '7D Opus']);
  assert.equal(opened.selection.label, '7D');
  assert.equal((await ledger.quotaHistoryAsync({ now: at(1), label: '5H' })).selection.label, '5H');
});

test('a monthly window opens one calendar month before its reset', async (t) => {
  const ledger = store(t);
  const reset = new Date(2026, 9, 15).getTime();
  ledger.recordQuota([
    { provider: 'opencode-go', account: 'default', label: 'M', ts: at(0), usedPct: 12, resetAt: reset },
  ]);
  const history = await ledger.quotaHistoryAsync({ now: at(1) });
  assert.equal(history.period.fromMs, new Date(2026, 8, 15).getTime());
  assert.equal(history.focus.paced, true);
});

test('a file ledger records readings and reads history on its worker', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-quota-worker-'));
  const ledger = new UsageLedger(join(dir, 'ledger.sqlite'));
  t.after(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  ledger.record([request(at(0, 20), 'model-a')]);
  await ledger.recordQuotaQueued([reading(at(0, 30), 10)]);
  const history = await ledger.quotaHistoryAsync({ now: at(1) });
  assert.deepEqual(byModel(history), { 'model-a': 10 });
  assert.equal(history.focus.usedPct, 10);
});

test('the statistics API names accounts and pages by view', async (t) => {
  const ledger = store(t);
  ledger.record([request(at(0, 20), 'model-a')]);
  ledger.recordQuota([reading(at(0, 30), 10)]);
  t.mock.method(Date, 'now', () => at(1));
  const api = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    accountPool: () => ({ accounts: [{ id: 'default', label: 'Personal' }] }),
  });
  const history = await api.getQuotaHistory({});
  assert.equal(history.subscriptions[0].accountLabel, 'Personal');
  assert.deepEqual(
    history.models.map((row) => [row.model, row.consumed]),
    [['model-a', 10]]
  );
  const week = await api.getQuotaHistory({ view: '7d' });
  assert.equal(week.period.view, '7d');
  assert.equal(week.period.days, 7);
  assert.equal(week.summary.consumed, 10);
  const table = await api.getQuotaHistory({ page: 0 });
  assert.equal(table.selection.label, '5H');
  assert.deepEqual(
    table.windows.map((row) => row.peak),
    [10]
  );
  const empty = createUsageStatsApi({ ledger: () => store(t), importHistory: async () => {} });
  assert.equal((await empty.getQuotaHistory({})).selection, null);
  assert.equal((await empty.getQuotaHistory({ page: 0 })).total, 0);
});
