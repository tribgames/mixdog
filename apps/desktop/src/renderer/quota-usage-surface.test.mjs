import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { CommandSurface } from './CommandSurface.tsx';
import { focusQuotaUsage, peekQuotaFocus } from './usage-surface-mode.ts';
import { prefetchQuotaUsage } from './quota-usage-cache.ts';
import { applyAccountUsageWindows } from './usage-dashboard-store.ts';
import { t } from './i18n.ts';
import { usageMoney } from './usage-format.ts';
import { quotaValue } from './quota-usage-model.ts';
import { UsageLedger, makeUsageRecord } from '../../../../src/runtime/shared/llm/usage-ledger.mjs';
import { createUsageStatsApi } from '../../../../src/session-runtime/usage-stats-api.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A five-hour Claude window opened at 13:00, read at 13:30 and 14:00, viewed at 14:30.
const opened = new Date(2026, 8, 30, 13).getTime();
const resetAt = opened + 5 * HOUR;
const at = (hours, minutes = 0) => opened + hours * HOUR + minutes * MINUTE;
const now = at(1, 30);

function harness(context) {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><main></main></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['HTMLElement', 'Node', 'history'],
    actEnvironment: false,
  });
  const root = createRoot(document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return async (props) => act(async () => root.render(React.createElement(CommandSurface, props)));
}

// The real statistics API over `ledger` behind the usage dialog, read at
// `viewedAt`, with `accounts` in every provider's account pool, `pool.selectedId` in use.
function usageHost(
  context,
  ledger,
  { viewedAt = now, accounts = [{ id: 'default', label: 'Account 1' }], pool = { selectedId: null } } = {}
) {
  context.mock.method(Date, 'now', () => viewedAt);
  const usage = createUsageStatsApi({
    ledger: () => ledger,
    importHistory: async () => {},
    accountPool: () => ({ accounts, selectedId: pool.selectedId }),
  });
  const calls = [];
  const pages = [];
  const responses = [];
  const statsReads = [];
  // Holding the gate keeps quota answers pending until it is released.
  const gate = { hold: false, release: null };
  const stats = {
    generatedAt: viewedAt,
    period: { view: 'hour', fromMs: viewedAt - 24 * HOUR, toMs: viewedAt },
    range: {},
    totals: {},
    providers: [],
    daily: [],
    hourly: [],
    coverage: {},
  };
  return {
    calls,
    pages,
    responses,
    statsReads,
    gate,
    api: {
      invokeCapability: async ({ capability, args = [] }) => {
        if (capability === 'getUsageStats') {
          statsReads.push(args[0]);
          return { value: stats };
        }
        assert.equal(capability, 'getQuotaHistory');
        // The window history reads its own pages.
        if (args[0]?.page != null) {
          pages.push(args[0]);
          return { value: await usage.getQuotaHistory(args[0]) };
        }
        calls.push(args[0]);
        if (gate.hold) await new Promise((resolve) => (gate.release = resolve));
        const value = await usage.getQuotaHistory(args[0]);
        responses.push(value);
        return { value };
      },
    },
  };
}

// A five-hour and a weekly Claude window, and a Codex one read earlier.
function quotaApi(context, { viewedAt = now } = {}) {
  const ledger = new UsageLedger(':memory:');
  context.after(() => ledger.close());
  // The test host has no price catalog, so each record carries its list price.
  const request = (ts, model, sessionId, inputTokens, costUsd) => ({
    ...makeUsageRecord({
      ts,
      provider: 'anthropic-oauth',
      model,
      sessionId,
      sourceType: 'lead',
      inputTokens,
      outputTokens: 100,
      account: 'default',
    }),
    costUsd,
    costSource: 'subscription',
  });
  // Each rise has one request behind it, so shares stay exact.
  ledger.record([
    request(at(0, 10), 'claude-sonnet-4-5', 'session-a', 1000, 0.6),
    request(at(0, 50), 'claude-opus-4-1', 'session-b', 3200, 2.4),
  ]);
  const reading = (label, ts, usedPct, reset = resetAt) => ({
    provider: 'anthropic-oauth',
    account: 'default',
    label,
    ts,
    usedPct,
    resetAt: reset,
  });
  // Codex was read earlier and never moved since: Claude, in use, opens first.
  ledger.recordQuota([
    { provider: 'openai-oauth', account: 'default', label: '5H', ts: at(0, 5), usedPct: 4, resetAt: at(4) },
  ]);
  ledger.recordQuota([reading('5H', at(0, 30), 10)]);
  ledger.recordQuota([reading('5H', at(0, 45), 10)]);
  ledger.recordQuota([reading('5H', at(1), 30), reading('7D', at(1), 12, resetAt + 5 * 24 * HOUR)]);
  return usageHost(context, ledger, { viewedAt });
}

const tab = (label) => [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent === t(label));
const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent === t(label));
const texts = (selector) => [...document.querySelectorAll(selector)].map((node) => node.textContent);

test('the usage dialog header switches to subscription usage and opens there next time', async (context) => {
  const render = harness(context);
  const { calls, responses, api } = quotaApi(context);
  const props = { surface: 'stats', open: true, onClose() {}, api };
  await render(props);
  const heading = document.querySelector('#command-surface-title');
  assert.equal(heading.textContent, t('Usage'), 'the dialog keeps its name');
  assert.equal(heading.className, 'sr-only', 'the tabs stand in for the visible title');
  assert.equal(tab('Token usage').getAttribute('aria-selected'), 'true');
  assert.equal(document.querySelector('.mixdog-settings__header [role="tablist"]'), tab('Token usage').parentElement);
  assert.equal(calls.length, 0, 'token usage never asks for quota history');
  await act(async () => tab('OAuth usage').click());
  assert.deepEqual(calls[0], { provider: '', account: '', window: '', view: 'window' });
  assert.equal(window.localStorage.getItem('mixdog.desktop.usage-surface-mode.v1'), 'quota');
  assert.deepEqual(JSON.parse(window.localStorage.getItem('mixdog.desktop.usage-quota-subscription.v1')), {
    provider: 'anthropic-oauth',
    window: '7D',
  });

  // What is shown and its exact period share one row; the period chips follow.
  assert.ok(document.querySelector('.stats-controls > .quota-selectors + .stats-period'));
  assert.equal(document.querySelector('.quota-subscription .mx-select-value').textContent, 'Claude');
  await act(async () => document.querySelector('.quota-subscription [role="combobox"]').click());
  assert.deepEqual(texts('.mx-menu [role="option"]'), ['Claude', 'Codex'], 'the one shown, then the flyout order');
  await act(async () => document.querySelector('.quota-subscription [role="combobox"]').click());
  assert.deepEqual(texts('.quota-window'), ['5H', '7D']);
  assert.equal(document.querySelector('.quota-window[aria-pressed="true"]').textContent, '7D', 'weekly opens first');
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '12%');
  // The weekly rest, 88 %, spread over the 5 d 3.5 h left: about 17 % a day.
  assert.equal(document.querySelectorAll('.stats-card > b')[1].textContent, t('{{percent}} a day', { percent: '17%' }));
  await act(async () =>
    [...document.querySelectorAll('.quota-window')].find((node) => node.textContent === '5H').click()
  );
  assert.deepEqual(calls.at(-1), { provider: 'anthropic-oauth', account: 'default', window: '5H', view: 'window' });
  assert.deepEqual(texts('.stats-card small'), [
    t('Used'),
    t('Allowance to reset'),
    t('Est. value'),
    t('Per 1%'),
  ]);
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '30%');
  // 70 % left over the 3.5 h to the 18:00 reset: 20 % an hour.
  assert.equal(
    document.querySelectorAll('.stats-card > b')[1].textContent,
    t('{{percent}} an hour', { percent: '20%' })
  );
  assert.equal(
    document.querySelectorAll('.stats-card')[1].querySelector('em').textContent,
    t('{{time}} left', { time: '3h 30m' })
  );
  const { summary } = responses.at(-1);
  // Two priced rises and no earlier window: too little to value the limit
  // in dollars yet, and both value cards say why.
  assert.equal(summary.costPerPercent, null);
  const notEnough = t('Not enough measured usage to estimate.');
  for (const index of [2, 3]) {
    assert.equal(document.querySelectorAll('.stats-card > b')[index].textContent, '—');
    assert.equal(document.querySelectorAll('.stats-card')[index].querySelector('em').textContent, notEnough);
  }
  // 30 % in the first hour runs out 2 h 20 m later, before the 18:00 reset.
  assert.equal(document.querySelectorAll('.stats-card')[0].dataset.tone, 'danger');
  assert.deepEqual(texts('.quota-mix li > b'), ['20%', '10%', '70%']);
  assert.equal(
    [...document.querySelectorAll('.quota-trend header *')].some((node) => node.textContent === t('Trend')),
    false,
    'only the visible Trend heading is gone'
  );
  // 13:00→13:30 had no reading; 13:30→14:00 was read every quarter hour.
  assert.ok(document.querySelector('.quota-chart-unmeasured').getAttribute('d'));
  assert.ok(document.querySelector('.quota-chart-line').getAttribute('d'));
  // The forecast stops where it runs out, at 16:20.
  assert.match(document.querySelector('.quota-chart-forecast').getAttribute('d'), /L666\.7,0\.0$/);
  assert.ok(document.querySelector('.quota-chart-pace'));
  // The legend names only the models stacked under the meter; the axis ticks
  // whole hours and names now.
  assert.equal(document.querySelectorAll('.quota-chart-stack').length, 2);
  assert.equal(document.querySelectorAll('.quota-legend li').length, 2);
  assert.equal(document.querySelectorAll('.quota-legend li > i[data-series]').length, 2);
  const axis = [...document.querySelectorAll('.quota-chart-axis span')];
  assert.deepEqual(
    axis.map((node) => Math.round(Number.parseFloat(node.style.left))),
    [20, 40, 60, 80, 30]
  );
  assert.equal(axis.at(-1).textContent, t('Now'));
  assert.equal(
    document.querySelector('.quota-chart-ahead').getAttribute('x'),
    document.querySelector('.quota-chart-now').getAttribute('x1'),
    'the time still to come is shaded from now'
  );
  assert.equal(document.querySelectorAll('.quota-chart-slots > *').length, 10);
  assert.equal(document.querySelectorAll('button.quota-chart-slot').length, 3, 'only elapsed slots open a card');
  // Laid out like token usage: the subscription's row, then its models.
  assert.equal(document.querySelector('.quota-table .stats-provider-row b').textContent, 'Claude');
  assert.deepEqual(texts('.quota-table .stats-share-cell'), ['30%', '20%', '10%']);
  assert.equal(document.querySelectorAll('.quota-table .stats-model-row').length, 2);
  assert.equal(document.querySelectorAll('.quota-history-table tbody tr').length, 1);
  assert.equal(document.querySelector('.quota-history-pager'), null, 'one page needs no pager');
  assert.match(document.querySelector('.quota-history-table').textContent, new RegExp(t('In progress')));
  // A window's list-price value: the recorded money, and no rate-based figures before the rate is known.
  assert.deepEqual(
    [...document.querySelector('.quota-history-table tbody tr').cells].slice(-3).map((cell) => cell.textContent),
    [usageMoney(3), '—', '—']
  );

  await act(async () => button('Last 24 hours').click());
  assert.equal(calls.at(-1).view, 'hour');
  assert.deepEqual(texts('.stats-card small'), [
    t('Times maxed out'),
    t('Period usage'),
    t('Est. value'),
    t('Per 1%'),
  ]);
  // The day holds the whole five-hour window, which rose from 0 to 30 %.
  assert.equal(document.querySelectorAll('.stats-card > b')[1].textContent, '30%');

  await render({ ...props, open: false });
  await render(props);
  assert.equal(tab('OAuth usage').getAttribute('aria-selected'), 'true', 'the last choice reopens');
});

test('subscription values distinguish recorded money, inferred outside use and their total', async (context) => {
  const render = harness(context);
  const ledger = new UsageLedger(':memory:');
  context.after(() => ledger.close());
  const reading = (ts, usedPct) => ({
    provider: 'anthropic-oauth',
    account: 'default',
    label: '5H',
    ts,
    usedPct,
    resetAt,
  });
  ledger.recordQuota([reading(opened, 0)]);
  let used = 0;
  for (let index = 0; index < 60; index += 1) {
    const ts = opened + (index * 2 + 1) * MINUTE;
    ledger.record([
      {
        ...makeUsageRecord({
          ts,
          provider: 'anthropic-oauth',
          account: 'default',
          model: 'model-priced',
          sessionId: 'mixed-session',
          sourceType: 'lead',
          inputTokens: 100,
          outputTokens: 10,
        }),
        costUsd: 0.5,
        costSource: 'subscription',
      },
    ]);
    used += index % 4 === 0 ? 2.5 : 0.5;
    ledger.recordQuota([reading(ts + MINUTE, used)]);
  }
  const { api } = usageHost(context, ledger, { viewedAt: at(2, 1) });
  focusQuotaUsage('anthropic-oauth');
  await render({ surface: 'stats', open: true, onClose() {}, api });
  const cards = document.querySelectorAll('.stats-card');
  assert.match(cards[2].querySelector('b').textContent, /^\$/);
  const amount = Number(cards[2].querySelector('b').textContent.replace(/[^0-9.]/g, ''));
  assert.ok(amount > 95 && amount < 105, 'before 100%, the card shows the full-limit estimate');
  assert.equal(cards[2].querySelector('em'), null, 'no forecast sentence or breakdown under the amount');
  assert.ok(cards[2].querySelector('b').title.includes(`${t('Recorded value')}: ${usageMoney(30)}`));
  const outside = [...document.querySelectorAll('.quota-table .stats-model-row')].find(
    (row) => row.firstElementChild.textContent === t('Outside Mixdog')
  );
  assert.match(outside.lastElementChild.textContent, /^\$/);
  const total = Number(
    document.querySelector('.quota-table .stats-provider-row .stats-cost-cell').textContent.replace(/[^0-9.]/g, '')
  );
  assert.ok(total > 58 && total < 62, 'the period table still shows recorded $30 plus outside use');
  assert.match(document.querySelector('.quota-history-table tbody tr').cells[3].textContent, /^\$/);
  await act(async () => document.querySelector('button.quota-chart-slot').click());
  assert.ok(!document.querySelector('.stats-trend-detail-totals').textContent.includes('≈'));
});

test('a limit window is valued at Mixdog’s own rate over the whole limit, outside use excluded', () => {
  // $40 of Mixdog requests and $30 of outside use; Mixdog's rate is $2 per point.
  const summary = { costUsd: 40, outsideCostUsd: 30, estimatedTotalCostUsd: 70, costPerPercent: 2 };
  assert.equal(quotaValue(summary, true), usageMoney(200), 'the same value before and after the meter reaches 100%');
  assert.equal(quotaValue(summary), usageMoney(70), 'calendar periods and history retain their actual totals');
  assert.equal(quotaValue({ ...summary, costPerPercent: null }, true), '—');
});

test('subscription usage opens at once from its last answer, on the subscription shown last', async (context) => {
  const render = harness(context);
  const { calls, statsReads, gate, api } = quotaApi(context);
  window.localStorage.setItem('mixdog.desktop.usage-surface-mode.v1', 'quota');
  const props = { surface: 'stats', open: true, onClose() {}, api };
  await render(props);
  assert.equal(statsReads.length, 0, 'token statistics wait for their own tab');
  assert.equal(document.querySelector('.quota-subscription .mx-select-value').textContent, 'Claude');
  await act(async () => document.querySelector('.quota-subscription [role="combobox"]').click());
  await act(async () =>
    [...document.querySelectorAll('.mx-menu [role="option"]')].find((node) => node.textContent === 'Codex').click()
  );
  assert.deepEqual(calls.at(-1), { provider: 'openai-oauth', account: '', window: '7D', view: 'window' });
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '4%');

  await render({ ...props, open: false });
  gate.hold = true;
  await render(props);
  // Codex has no weekly window here, so its five-hour one was shown — and is
  // asked for again, on the account in use.
  assert.deepEqual(calls.at(-1), { provider: 'openai-oauth', account: '', window: '5H', view: 'window' });
  assert.equal(document.querySelector('.quota-surface').dataset.loading, undefined, 'the last answer paints at once');
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '4%');
  await act(async () => gate.release());

  await act(async () => tab('Token usage').click());
  assert.equal(statsReads.length, 1, 'the token tab reads its statistics when chosen');
});

test('subscription usage read ahead is read once and paints the dialog at once', async (context) => {
  const render = harness(context);
  const { calls, pages, gate, api } = quotaApi(context);
  // Boot reads ahead, and so does the usage flyout as it opens or a meter is hovered.
  prefetchQuotaUsage(api);
  prefetchQuotaUsage(api);
  await act(async () => {});
  assert.deepEqual(calls, [{ provider: '', account: '', window: '', view: 'window' }], 'one read serves both');
  assert.deepEqual(
    pages,
    [{ provider: 'anthropic-oauth', account: 'default', window: '7D', page: 0 }],
    'with the history of the window it shows'
  );
  prefetchQuotaUsage(api);
  await act(async () => {});
  assert.deepEqual([calls.length, pages.length], [1, 1], 'fresh answers are not read ahead again');

  window.localStorage.setItem('mixdog.desktop.usage-surface-mode.v1', 'quota');
  gate.hold = true;
  await render({ surface: 'stats', open: true, onClose() {}, api });
  assert.equal(document.querySelector('.quota-surface').dataset.loading, undefined);
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '12%');
  await act(async () => gate.release());
});

test('a hovered slot names who moved the meter in it', async (context) => {
  const render = harness(context);
  const { api } = quotaApi(context);
  focusQuotaUsage({ provider: 'anthropic-oauth', window: '5H' });
  await render({ surface: 'stats', open: true, onClose() {}, api });
  const slot = document.querySelectorAll('button.quota-chart-slot')[1];
  await act(async () => slot.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  const detail = document.querySelector('.stats-trend-detail');
  assert.ok(detail);
  assert.equal(slot.getAttribute('aria-expanded'), 'true');
  assert.equal(slot.getAttribute('data-tooltip'), '', 'the card is the hint; no second bubble');
  assert.equal(detail.querySelector('dd').textContent, '10% → 30%');
  assert.deepEqual(
    [...detail.querySelectorAll('li > b')].map((node) => node.textContent),
    ['+20%']
  );
  // Leaving the slots and crossing back into the chart's frame reopens nothing.
  const chart = document.querySelector('.quota-chart');
  await act(async () => document.querySelector('.stats-trend-detail button').click());
  await act(async () => chart.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  assert.equal(document.querySelector('.stats-trend-detail'), null, 'the frame alone never reopens the card');
});

test('the running slot keeps its whole span, read up to now and forecast after', async (context) => {
  const render = harness(context);
  // 14:40: the 14:30 slot is ten minutes old.
  const { api } = quotaApi(context, { viewedAt: at(1, 40) });
  focusQuotaUsage({ provider: 'anthropic-oauth', window: '5H' });
  await render({ surface: 'stats', open: true, onClose() {}, api });
  const slots = [...document.querySelectorAll('button.quota-chart-slot')];
  const running = slots.at(-1);
  assert.equal(running.style.flexBasis, slots[0].style.flexBasis, 'as wide as every other half hour');
  assert.equal(Math.round(Number.parseFloat(running.style.getPropertyValue('--quota-slot-elapsed'))), 33);
  await act(async () => running.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  const rows = [...document.querySelectorAll('.stats-trend-detail .quota-slot-split li')];
  assert.deepEqual(
    rows.map((row) => row.querySelector('span').textContent.split(' · ')[0]),
    [t('Used'), t('Forecast')]
  );
  // Read at 30 % since 14:00; 30 % an hour forecasts 60 % by the slot's end at 15:00.
  assert.deepEqual(
    rows.map((row) => row.querySelector('b').textContent),
    ['30% → 30%', '30% → 60%']
  );
  // The next slot has yet to start: moving onto it closes the card.
  await act(async () =>
    running.nextElementSibling.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  );
  assert.equal(document.querySelector('.stats-trend-detail'), null);
  // Each model's layer runs up to now.
  const nowAt = Number(document.querySelector('.quota-chart-now').getAttribute('x1'));
  assert.deepEqual(
    [...document.querySelectorAll('.quota-chart-stack')].map((path) =>
      Math.max(...[...path.getAttribute('d').matchAll(/[ML](-?[\d.]+),/g)].map((match) => Number(match[1])))
    ),
    [nowAt, nowAt]
  );
});

test('the window history pages ten windows at a time and opens the one clicked', async (context) => {
  const render = harness(context);
  const ledger = new UsageLedger(':memory:');
  context.after(() => ledger.close());
  // Twelve five-hour windows back to back, the n-th read once at n %; the last is open.
  const readAt = (index) => resetAt - (11 - index) * 5 * HOUR - 4 * HOUR;
  for (let index = 0; index < 12; index += 1) {
    ledger.recordQuota([
      {
        provider: 'anthropic-oauth',
        account: 'default',
        label: '5H',
        ts: readAt(index),
        usedPct: index + 1,
        resetAt: readAt(index) + 4 * HOUR,
      },
    ]);
  }
  const { calls, pages, api } = usageHost(context, ledger);
  focusQuotaUsage({ provider: 'anthropic-oauth', window: '5H' });
  await render({ surface: 'stats', open: true, onClose() {}, api });
  const peaks = () =>
    [...document.querySelectorAll('.quota-history-table tbody tr')].map((row) => row.cells[1].textContent);
  const pageText = () => document.querySelector('.quota-history-pager span').textContent;
  assert.ok(
    document.querySelector('.quota-history-table + .quota-history-pager'),
    'past ten windows a pager sits below'
  );
  assert.deepEqual(pages, [{ provider: 'anthropic-oauth', account: 'default', window: '5H', page: 0 }]);
  assert.deepEqual(peaks(), ['12%', '11%', '10%', '9%', '8%', '7%', '6%', '5%', '4%', '3%']);
  assert.equal(pageText(), '1 / 2');
  await act(async () => document.querySelector(`.quota-history-pager [aria-label="${t('Next')}"]`).click());
  assert.equal(pages.at(-1).page, 1);
  assert.deepEqual(peaks(), ['2%', '1%']);
  assert.equal(pageText(), '2 / 2');

  await act(async () => document.querySelectorAll('.quota-history-open')[1].click());
  assert.equal(calls.at(-1).anchor, String(readAt(0)), 'the oldest window opens');
  assert.equal(pageText(), '2 / 2', 'on the page it was picked from');
  assert.equal(document.querySelector('.quota-history-table tr[data-active="true"]').cells[1].textContent, '1%');
});

test('a provider meter opens its own subscription window', async (context) => {
  const render = harness(context);
  const { calls, api } = quotaApi(context);
  focusQuotaUsage({ provider: 'anthropic-oauth', window: '7D' });
  await render({ surface: 'stats', open: true, onClose() {}, api });
  assert.equal(peekQuotaFocus(), null, 'the request is consumed by the opening it asked for');
  assert.equal(tab('OAuth usage').getAttribute('aria-selected'), 'true');
  assert.deepEqual(calls[0], { provider: 'anthropic-oauth', account: '', window: '7D', view: 'window' });
  assert.equal(document.querySelector('.quota-window[aria-pressed="true"]').textContent, '7D');
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '12%');
});

test('the allowance to reset never spreads the rest past what is left', async (context) => {
  const render = harness(context);
  const ledger = new UsageLedger(':memory:');
  context.after(() => ledger.close());
  const reading = (label, usedPct, reset) => ({
    provider: 'anthropic-oauth',
    account: 'default',
    label,
    ts: now - 10 * MINUTE,
    usedPct,
    resetAt: reset,
  });
  // The weekly resets in 12 h with 60 % left; the five-hour in 30 min with 60 % left.
  ledger.recordQuota([reading('7D', 40, now + 12 * HOUR), reading('5H', 40, now + 30 * MINUTE)]);
  const { api } = usageHost(context, ledger);
  window.localStorage.setItem('mixdog.desktop.usage-surface-mode.v1', 'quota');
  await render({ surface: 'stats', open: true, onClose() {}, api });
  assert.equal(document.querySelector('.quota-window[aria-pressed="true"]').textContent, '7D');
  // Under a day left: 60 % over 12 h reads per hour, not 120 % a day.
  assert.equal(
    document.querySelectorAll('.stats-card > b')[1].textContent,
    t('{{percent}} an hour', { percent: '5%' })
  );
  await act(async () =>
    [...document.querySelectorAll('.quota-window')].find((node) => node.textContent === '5H').click()
  );
  // Under an hour left: the rest itself, not 120 % an hour.
  assert.equal(
    document.querySelectorAll('.stats-card > b')[1].textContent,
    t('{{percent}} an hour', { percent: '60%' })
  );
});

test('a subscription is listed once and its accounts are picked beside it', async (context) => {
  const render = harness(context);
  const ledger = new UsageLedger(':memory:');
  context.after(() => ledger.close());
  const reading = (provider, account, ts, usedPct) => ({
    provider,
    account,
    label: '7D',
    ts,
    usedPct,
    resetAt: resetAt + 5 * 24 * HOUR,
  });
  // Three Claude accounts: the second in use, the third moved after the first.
  ledger.recordQuota([reading('openai-oauth', 'default', at(0, 5), 4)]);
  ledger.recordQuota([reading('anthropic-oauth', 'default', at(0, 10), 30)]);
  ledger.recordQuota([reading('anthropic-oauth', 'spare', at(0, 20), 20)]);
  ledger.recordQuota([reading('anthropic-oauth', 'work', at(0, 30), 10)]);
  const { calls, api } = usageHost(context, ledger, {
    accounts: [
      { id: 'default', label: 'Account 1' },
      { id: 'work', label: 'Account 2' },
      { id: 'spare', label: 'Account 3' },
    ],
  });
  window.localStorage.setItem('mixdog.desktop.usage-surface-mode.v1', 'quota');
  await render({ surface: 'stats', open: true, onClose() {}, api });
  const picker = (name) => document.querySelector(`.quota-${name} [role="combobox"]`);
  const options = async (name) => {
    await act(async () => picker(name).click());
    const shown = texts('.mx-menu [role="option"]');
    await act(async () => picker(name).click());
    return shown;
  };
  const choose = async (name, label) => {
    await act(async () => picker(name).click());
    await act(async () =>
      [...document.querySelectorAll('.mx-menu [role="option"]')].find((node) => node.textContent === label).click()
    );
  };
  assert.equal(document.querySelector('.quota-subscription .mx-select-value').textContent, 'Claude');
  assert.equal(document.querySelector('.quota-account .mx-select-value').textContent, 'Account 2');
  assert.deepEqual(await options('subscription'), ['Claude', 'Codex'], 'each subscription once');
  assert.deepEqual(
    await options('account'),
    ['Account 2', 'Account 1', 'Account 3'],
    'the one shown, then the pool order'
  );

  await choose('account', 'Account 1');
  assert.deepEqual(calls.at(-1), { provider: 'anthropic-oauth', account: 'default', window: '7D', view: 'window' });
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '30%');

  await choose('subscription', 'Codex');
  assert.deepEqual(
    calls.at(-1),
    { provider: 'openai-oauth', account: '', window: '7D', view: 'window' },
    'another subscription opens on its account in use'
  );
  assert.equal(document.querySelector('.quota-account'), null, 'one account needs no second choice');
});

test('subscription usage follows the account in use when it switches', async (context) => {
  const render = harness(context);
  const ledger = new UsageLedger(':memory:');
  context.after(() => ledger.close());
  const reading = (account, ts, usedPct) => ({
    provider: 'anthropic-oauth',
    account,
    label: '7D',
    ts,
    usedPct,
    resetAt: resetAt + 5 * 24 * HOUR,
  });
  // Account 1 moved last, but the pool has Account 2 in use.
  ledger.recordQuota([reading('work', at(0, 10), 100)]);
  ledger.recordQuota([reading('default', at(0, 20), 30)]);
  const pool = { selectedId: 'work' };
  const { calls, api } = usageHost(context, ledger, {
    accounts: [
      { id: 'default', label: 'Account 1' },
      { id: 'work', label: 'Account 2' },
    ],
    pool,
  });
  window.localStorage.setItem('mixdog.desktop.usage-surface-mode.v1', 'quota');
  const props = { surface: 'stats', open: true, onClose() {}, api };
  await render(props);
  const shownAccount = () => document.querySelector('.quota-account .mx-select-value').textContent;
  assert.equal(shownAccount(), 'Account 2', 'the account in use opens, not the one that moved last');
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '100%');

  // The exhausted account is swapped out while the dialog is open.
  pool.selectedId = 'default';
  await act(async () => applyAccountUsageWindows('openai-oauth', undefined));
  assert.equal(shownAccount(), 'Account 2', "another provider's switch changes nothing");
  await act(async () => applyAccountUsageWindows('anthropic-oauth', undefined));
  assert.deepEqual(calls.at(-1), { provider: 'anthropic-oauth', account: '', window: '7D', view: 'window' });
  assert.equal(shownAccount(), 'Account 1');
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '30%');

  // A reopening starts on the account in use again, whatever was picked before.
  await act(async () => document.querySelector('.quota-account [role="combobox"]').click());
  await act(async () =>
    [...document.querySelectorAll('.mx-menu [role="option"]')].find((node) => node.textContent === 'Account 2').click()
  );
  assert.equal(shownAccount(), 'Account 2');
  await render({ ...props, open: false });
  await render(props);
  assert.equal(shownAccount(), 'Account 1');
});
