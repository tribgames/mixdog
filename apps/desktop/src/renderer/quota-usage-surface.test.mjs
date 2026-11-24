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

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A five-hour Claude window opened at 13:00, read at 13:30 and 14:00, viewed at 14:30.
const opened = Date.parse('2026-09-30T13:00:00+09:00');
const resetAt = opened + 5 * HOUR;
const at = (hours, minutes = 0) => opened + hours * HOUR + minutes * MINUTE;
const now = at(1, 30);
const SPAN = { '5H': 5 * HOUR, '7D': 7 * 24 * HOUR };

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

function quotaWorld(
  context,
  {
    viewedAt = now,
    accounts = [{ id: 'default', label: 'Account 1' }],
    pool = { selectedId: null },
    readings,
    history = [],
    detail = {},
  }
) {
  context.mock.method(Date, 'now', () => viewedAt);
  const calls = [];
  const pages = [];
  const responses = [];
  const statsReads = [];
  // Holding the gate keeps window answers pending until it is released.
  const gate = { hold: false, release: null };
  const newest = (rows) => rows.reduce((best, row) => (row.ts > best.ts ? row : best));
  const windowAnswer = (question) => {
    const provider = question.provider || newest(readings).provider;
    const own = readings.filter((row) => row.provider === provider);
    const used = own.map((row) => row.account);
    const account = question.account || (used.includes(pool.selectedId) ? pool.selectedId : newest(own).account);
    const labels = own.filter((row) => row.account === account).map((row) => row.label);
    const label = labels.includes(question.window) ? question.window : labels.includes('7D') ? '7D' : labels.sort()[0];
    const reading = own.find((row) => row.account === account && row.label === label);
    const startMs = reading.resetAt - SPAN[label];
    const subscriptions = [...new Set(readings.map((row) => `${row.provider}\u0000${row.account}`))].map((key) => {
      const [p, a] = key.split('\u0000');
      const rank = accounts.findIndex((entry) => entry.id === a);
      return {
        provider: p,
        account: a,
        accountLabel: accounts[rank]?.label ?? a,
        accountRank: rank < 0 ? undefined : rank,
        accountInRoster: rank >= 0,
        windows: readings
          .filter((row) => row.provider === p && row.account === a)
          .map((row) => row.label)
          .sort(),
      };
    });
    const domain = { fromMs: startMs, toMs: reading.resetAt };
    const view = question.view;
    const extra = detail[`${provider}/${label}`] ?? {};
    if (view !== 'window')
      return {
        generatedAt: viewedAt,
        view,
        selection: { provider, account, label },
        subscriptions,
        period: { fromMs: viewedAt - 24 * HOUR, toMs: viewedAt },
        summary: extra.periodSummary ?? {},
        models: [],
        modelSeries: [],
        slots: [],
      };
    return {
      generatedAt: viewedAt,
      view,
      selection: { provider, account, label },
      subscriptions,
      period: { ...domain, ...(question.anchor ? { anchor: question.anchor } : {}) },
      domain,
      focus: {
        usedPct: reading.usedPct,
        resetAt: reading.resetAt,
        startMs,
        endMs: reading.resetAt,
        current: true,
        peak: reading.usedPct,
      },
      summary: {},
      points: [
        [startMs, 0, 1],
        [reading.ts, reading.usedPct, 1],
      ],
      models: [],
      modelSeries: [],
      slots: [],
      ...extra.window,
    };
  };
  const rowsOfHistory = (label) => (Array.isArray(history) ? history : (history[label] ?? []));
  const historyAnswer = (question) => {
    const from = question.page * 10;
    return {
      selection: { provider: question.provider, account: question.account, label: question.window },
      windows: rowsOfHistory(question.window).slice(from, from + 10),
      page: question.page,
      pageCount: Math.ceil(rowsOfHistory(question.window).length / 10),
    };
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
          return {
            value: {
              generatedAt: viewedAt,
              period: { view: 'hour', fromMs: viewedAt - 24 * HOUR, toMs: viewedAt },
              range: {},
              totals: {},
              providers: [],
              daily: [],
              hourly: [],
              coverage: {},
            },
          };
        }
        assert.equal(capability, 'getQuotaHistory');
        if (args[0]?.page != null) {
          pages.push(args[0]);
          return { value: historyAnswer(args[0]) };
        }
        calls.push(args[0]);
        if (gate.hold) await new Promise((resolve) => (gate.release = resolve));
        const value = windowAnswer(args[0]);
        responses.push(value);
        return { value };
      },
    },
  };
}

// The Claude five-hour window: opened at 13:00, no reading until 13:30 (10 %), 30 % at 14:00, held since; Opus took 20 points and Sonnet 10.
// Its half-hour slots: those that have started are read, the rest are still to come.
function claudeFiveHour(viewedAt) {
  const model = (name, consumed, tokens, costUsd) => ({
    model: name,
    consumed,
    turns: 1,
    input: tokens - 100,
    output: 100,
    cacheRead: 0,
    tokens,
    costUsd,
    outputTokensPerSecond: 50,
  });
  const opus = model('claude-opus-4-1', 20, 3300, 2.4);
  const sonnet = model('claude-sonnet-4-5', 10, 1100, 0.6);
  const slot = (index, fields) => ({
    fromMs: at(0, 30 * index),
    toMs: at(0, 30 * (index + 1)),
    future: at(0, 30 * index) >= viewedAt,
    ...fields,
  });
  const slots = [
    slot(0, { startPct: 0, endPct: 10, tokens: 1100, costUsd: 0.6, models: [sonnet] }),
    slot(1, { startPct: 10, endPct: 30, tokens: 3300, costUsd: 2.4, models: [opus] }),
    slot(2, { startPct: 30, endPct: 30, tokens: 0, costUsd: 0, models: [] }),
    ...[3, 4, 5, 6, 7, 8, 9].map((index) =>
      slot(index, { startPct: 30, endPct: 30, tokens: 0, costUsd: 0, models: [] })
    ),
  ];
  return {
    window: {
      focus: { usedPct: 30, resetAt, startMs: opened, endMs: resetAt, current: true, paced: true, peak: 30 },
      forecast: { fromMs: at(1), fromPct: 30, ratePerHour: 30, exhaustAt: at(3, 20), atResetPct: 100 },
      summary: { consumed: 30, costUsd: 3, estimatedTotalCostUsd: 3, costPerPercent: null },
      totals: { turns: 2, input: 4200, output: 200, tokens: 4400, costUsd: 3 },
      models: [opus, sonnet],
      modelSeries: [opus, sonnet].map((entry) => ({
        ...entry,
        key: entry.model,
        points: [
          [at(0), 0],
          [viewedAt, entry.consumed],
        ],
      })),
      points: [
        [at(0), 0, 1],
        [at(0, 30), 10, 2],
        [at(0, 45), 10, 1],
        [at(1), 30, 1],
        [viewedAt, 30, 1],
      ],
      slots,
    },
    periodSummary: { maxedOut: 0, consumed: 30 },
    history: [
      {
        key: String(opened),
        startMs: opened,
        endMs: resetAt,
        peak: 30,
        current: true,
        costUsd: 3,
        estimatedTotalCostUsd: 3,
        costPerPercent: null,
      },
    ],
  };
}

// A five-hour and a weekly Claude window, and a Codex one read earlier.
function quotaApi(context, { viewedAt = now } = {}) {
  const claude = { provider: 'anthropic-oauth', account: 'default' };
  const five = claudeFiveHour(viewedAt);
  return quotaWorld(context, {
    viewedAt,
    history: { '5H': five.history },
    detail: { 'anthropic-oauth/5H': five },
    readings: [
      { provider: 'openai-oauth', account: 'default', label: '5H', ts: at(0, 5), usedPct: 4, resetAt: at(4) },
      { ...claude, label: '5H', ts: at(1), usedPct: 30, resetAt },
      { ...claude, label: '7D', ts: at(1), usedPct: 12, resetAt: resetAt + 5 * 24 * HOUR },
    ],
  });
}

const tab = (label) => [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent === t(label));
const button = (label) => [...document.querySelectorAll('button')].find((node) => node.textContent === t(label));
const texts = (selector) => [...document.querySelectorAll(selector)].map((node) => node.textContent);
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

test('the window history pages ten windows at a time and opens the one clicked', async (context) => {
  const render = harness(context);
  // Twelve five-hour windows back to back, the n-th read once at n %; the last is open.
  const readAt = (index) => resetAt - (11 - index) * 5 * HOUR - 4 * HOUR;
  const windows = Array.from({ length: 12 }, (_, index) => ({
    key: String(readAt(index)),
    startMs: readAt(index) + 4 * HOUR - 5 * HOUR,
    endMs: readAt(index) + 4 * HOUR,
    peak: index + 1,
    current: index === 11,
  })).reverse();
  const { calls, pages, api } = quotaWorld(context, {
    readings: [
      {
        provider: 'anthropic-oauth',
        account: 'default',
        label: '5H',
        ts: readAt(11),
        usedPct: 12,
        resetAt: readAt(11) + 4 * HOUR,
      },
    ],
    history: windows,
  });
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
  // The weekly resets in 12 h with 60 % left; the five-hour in 30 min with 60 % left.
  const reading = (label, usedPct, reset) => ({
    provider: 'anthropic-oauth',
    account: 'default',
    label,
    ts: now - 10 * MINUTE,
    usedPct,
    resetAt: reset,
  });
  const { api } = quotaWorld(context, {
    readings: [reading('7D', 40, now + 12 * HOUR), reading('5H', 40, now + 30 * MINUTE)],
  });
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
  const reading = (provider, account, ts, usedPct) => ({
    provider,
    account,
    label: '7D',
    ts,
    usedPct,
    resetAt: resetAt + 5 * 24 * HOUR,
  });
  // Three Claude accounts: the second in use, the third moved after the first.
  const { calls, api } = quotaWorld(context, {
    readings: [
      reading('openai-oauth', 'default', at(0, 5), 4),
      reading('anthropic-oauth', 'default', at(0, 10), 30),
      reading('anthropic-oauth', 'spare', at(0, 20), 20),
      reading('anthropic-oauth', 'work', at(0, 30), 10),
    ],
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
  const reading = (account, ts, usedPct) => ({
    provider: 'anthropic-oauth',
    account,
    label: '7D',
    ts,
    usedPct,
    resetAt: resetAt + 5 * 24 * HOUR,
  });
  // Account 1 moved last, but the pool has Account 2 in use.
  const pool = { selectedId: 'work' };
  const { calls, api } = quotaWorld(context, {
    readings: [reading('work', at(0, 10), 100), reading('default', at(0, 20), 30)],
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

test('a limit window is valued at Mixdog’s own rate over the whole limit, outside use excluded', () => {
  // $40 of Mixdog requests and $30 of outside use; Mixdog's rate is $2 per point.
  const summary = { costUsd: 40, outsideCostUsd: 30, estimatedTotalCostUsd: 70, costPerPercent: 2 };
  assert.equal(quotaValue(summary, true), usageMoney(200), 'the same value before and after the meter reaches 100%');
  assert.equal(quotaValue(summary), usageMoney(70), 'calendar periods and history retain their actual totals');
  assert.equal(quotaValue({ ...summary, costPerPercent: null }, true), '—');
});

const seoulZone = (context) => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'Asia/Seoul';
  context.after(() => {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  });
};

async function openClaudeFiveHour(context) {
  seoulZone(context);
  const render = harness(context);
  const world = quotaApi(context);
  focusQuotaUsage({ provider: 'anthropic-oauth', window: '5H' });
  const props = { surface: 'stats', open: true, onClose() {}, api: world.api };
  await render(props);
  return { ...world, render, props };
}

test('the usage dialog header switches to subscription usage and opens there next time', async (context) => {
  seoulZone(context);
  const render = harness(context);
  const { calls, api } = quotaApi(context);
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

  await render({ ...props, open: false });
  await render(props);
  assert.equal(tab('OAuth usage').getAttribute('aria-selected'), 'true', 'the last choice reopens');
});

test('subscription usage opens on the weekly window beside its selectors', async (context) => {
  seoulZone(context);
  const render = harness(context);
  const { api } = quotaApi(context);
  window.localStorage.setItem('mixdog.desktop.usage-surface-mode.v1', 'quota');
  await render({ surface: 'stats', open: true, onClose() {}, api });
  assert.ok(document.querySelector('.stats-controls > .quota-selectors + .stats-period'));
  assert.equal(document.querySelector('.quota-subscription .mx-select-value').textContent, 'Claude');
  await act(async () => document.querySelector('.quota-subscription [role="combobox"]').click());
  assert.deepEqual(texts('.mx-menu [role="option"]'), ['Claude', 'Codex'], 'the one shown, then the flyout order');
  await act(async () => document.querySelector('.quota-subscription [role="combobox"]').click());
  assert.deepEqual(texts('.quota-window'), ['5H', '7D']);
  assert.equal(document.querySelector('.quota-window[aria-pressed="true"]').textContent, '7D', 'weekly opens first');
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '12%');
  assert.equal(document.querySelectorAll('.stats-card > b')[1].textContent, t('{{percent}} a day', { percent: '17%' }));
});

test('the five-hour window reads its used share, allowance and unvalued cost', async (context) => {
  const { calls, responses } = await openClaudeFiveHour(context);
  assert.deepEqual(calls.at(-1), { provider: 'anthropic-oauth', account: '', window: '5H', view: 'window' });
  assert.deepEqual(texts('.stats-card small'), [t('Used'), t('Allowance to reset'), t('Est. value'), t('Per 1%')]);
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '30%');
  assert.equal(
    document.querySelectorAll('.stats-card > b')[1].textContent,
    t('{{percent}} an hour', { percent: '20%' })
  );
  assert.equal(
    document.querySelectorAll('.stats-card')[1].querySelector('em').textContent,
    t('{{time}} left', { time: '3h 30m' })
  );
  const { summary } = responses.at(-1);
  assert.equal(summary.costPerPercent, null);
  const notEnough = t('Not enough measured usage to estimate.');
  for (const index of [2, 3]) {
    assert.equal(document.querySelectorAll('.stats-card > b')[index].textContent, '—');
    assert.equal(document.querySelectorAll('.stats-card')[index].querySelector('em').textContent, notEnough);
  }
  assert.equal(document.querySelectorAll('.stats-card')[0].dataset.tone, 'danger');
});

test('the five-hour chart draws the measured line, the forecast, the models and the slots', async (context) => {
  await openClaudeFiveHour(context);
  assert.deepEqual(texts('.quota-mix li > b'), ['20%', '10%', '70%']);
  assert.equal(
    [...document.querySelectorAll('.quota-trend header *')].some((node) => node.textContent === t('Trend')),
    false,
    'only the visible Trend heading is gone'
  );
  assert.ok(document.querySelector('.quota-chart-unmeasured').getAttribute('d'));
  assert.ok(document.querySelector('.quota-chart-line').getAttribute('d'));
  assert.match(document.querySelector('.quota-chart-forecast').getAttribute('d'), /L666\.7,0\.0$/);
  assert.ok(document.querySelector('.quota-chart-pace'));
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
});

test('the five-hour table lists the subscription, its models and the window history', async (context) => {
  await openClaudeFiveHour(context);
  assert.equal(document.querySelector('.quota-table .stats-provider-row b').textContent, 'Claude');
  assert.deepEqual(texts('.quota-table .stats-share-cell'), ['30%', '20%', '10%']);
  assert.equal(document.querySelectorAll('.quota-table .stats-model-row').length, 2);
  assert.equal(document.querySelectorAll('.quota-history-table tbody tr').length, 1);
  assert.equal(document.querySelector('.quota-history-pager'), null, 'one page needs no pager');
  assert.match(document.querySelector('.quota-history-table').textContent, new RegExp(t('In progress')));
  assert.deepEqual(
    [...document.querySelector('.quota-history-table tbody tr').cells].slice(-3).map((cell) => cell.textContent),
    [usageMoney(3), '—', '—']
  );
});

test('the last-24-hours period reads the day the window rose in', async (context) => {
  const { calls } = await openClaudeFiveHour(context);
  await act(async () => button('Last 24 hours').click());
  assert.equal(calls.at(-1).view, 'hour');
  assert.deepEqual(texts('.stats-card small'), [t('Times maxed out'), t('Period usage'), t('Est. value'), t('Per 1%')]);
  assert.equal(document.querySelectorAll('.stats-card > b')[1].textContent, '30%');
});

test('subscription values distinguish recorded money, inferred outside use and their total', async (context) => {
  const render = harness(context);
  // Sixty priced requests ($30 of list-price value) moved the meter from 0 to 30 %; 30 % more came from outside Mixdog.
  const model = {
    model: 'model-priced',
    consumed: 30,
    turns: 60,
    input: 6000,
    output: 600,
    cacheRead: 0,
    tokens: 6600,
    costUsd: 30,
  };
  const { api } = quotaWorld(context, {
    viewedAt: at(2, 1),
    readings: [{ provider: 'anthropic-oauth', account: 'default', label: '5H', ts: at(2), usedPct: 60, resetAt }],
    history: [
      {
        key: String(opened),
        startMs: opened,
        endMs: resetAt,
        peak: 60,
        current: true,
        costUsd: 30,
        estimatedTotalCostUsd: 60,
        costPerPercent: 1,
      },
    ],
    detail: {
      'anthropic-oauth/5H': {
        window: {
          focus: { usedPct: 60, resetAt, startMs: opened, endMs: resetAt, current: true, peak: 60 },
          summary: { consumed: 30, costUsd: 30, outsideCostUsd: 30, estimatedTotalCostUsd: 60, costPerPercent: 1 },
          totals: { turns: 60, input: 6000, output: 600, tokens: 6600, costUsd: 30 },
          outside: 30,
          models: [model],
          slots: [
            {
              fromMs: opened,
              toMs: at(0, 30),
              startPct: 0,
              endPct: 15,
              tokens: 3300,
              costUsd: 15,
              estimatedTotalCostUsd: 30,
              models: [{ ...model, consumed: 15 }],
              outside: 15,
            },
          ],
        },
      },
    },
  });
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

/** A window where Mixdog's records moved the meter 20 % and the readings left `unattributed` % unassigned. */
async function openUnattributed(context, unattributed) {
  const render = harness(context);
  const model = { model: 'model-priced', consumed: 20, turns: 10, input: 1000, output: 100, tokens: 1100, costUsd: 10 };
  const { api } = quotaWorld(context, {
    viewedAt: at(2, 1),
    readings: [{ provider: 'anthropic-oauth', account: 'default', label: '5H', ts: at(2), usedPct: 25, resetAt }],
    detail: {
      'anthropic-oauth/5H': {
        window: {
          focus: { usedPct: 25, resetAt, startMs: opened, endMs: resetAt, current: true, peak: 25 },
          summary: { consumed: 20 + unattributed, costUsd: 10, outsideCostUsd: 0, costPerPercent: 0.5, unattributed },
          totals: { turns: 10, input: 1000, output: 100, tokens: 1100, costUsd: 10 },
          outside: 0,
          unattributed,
          models: [model],
          modelSeries: [
            { ...model, key: model.model, points: [[opened, 0], [at(0, 30), 20]] },
            ...(unattributed > 0 ? [{ key: '', part: 'unattributed', points: [[opened, 0], [at(0, 30), unattributed]] }] : []),
          ],
          points: [
            [opened, 0, 1],
            [at(0, 30), 20 + unattributed, 1],
            [at(2), 25, 1],
          ],
          slots: [
            {
              fromMs: opened,
              toMs: at(0, 30),
              startPct: 0,
              endPct: 25,
              consumed: 20 + unattributed,
              tokens: 1100,
              models: [model],
              outside: 0,
              unattributed,
            },
          ],
        },
      },
    },
  });
  focusQuotaUsage('anthropic-oauth');
  await render({ surface: 'stats', open: true, onClose() {}, api });
  return [...document.querySelectorAll('.quota-table .stats-model-row')].filter(
    (row) => row.firstElementChild.textContent === t('Unattributed')
  );
}

test('points the readings cannot assign show as an unpriced Unattributed share', async (context) => {
  const [row, ...more] = await openUnattributed(context, 2.04);

  assert.equal(more.length, 0);
  assert.equal(row.cells[1].textContent, '2%');
  assert.deepEqual(
    [...row.cells].slice(2, -1).map((cell) => cell.textContent),
    [''],
    'no requests, speed or tokens'
  );
  assert.equal(row.lastElementChild.textContent, '—', 'never priced');
  assert.equal(
    row.firstElementChild.title,
    t(
      "Meter moved across an unmeasured gap or within this meter's observed jitter range, so it cannot be assigned to Mixdog or outside use."
    )
  );
  assert.ok(document.querySelector('.quota-mix .stats-mix-bar [data-series="unattributed"]'));
  const legend = document.querySelector('.quota-mix li [data-series="unattributed"]').parentElement;
  assert.equal(legend.textContent, `${t('Unattributed')}2%`);
});

test("a slot's hover card lists the share its readings cannot assign beside its models", async (context) => {
  await openUnattributed(context, 2.04);

  await act(async () => document.querySelector('button.quota-chart-slot').click());

  const items = [...document.querySelectorAll('.stats-trend-detail li')].map((li) => li.textContent);
  assert.deepEqual(items, ['model-priced+20%', `${t('Unattributed')}+2%`]);
  const unattributed = document.querySelector('.stats-trend-detail li [data-series="unattributed"]').closest('li');
  assert.equal(
    unattributed.title,
    t(
      "Meter moved across an unmeasured gap or within this meter's observed jitter range, so it cannot be assigned to Mixdog or outside use."
    )
  );
});

test('the chart stacks the share its readings cannot assign as its own layer', async (context) => {
  await openUnattributed(context, 2.04);

  assert.deepEqual(
    [...document.querySelectorAll('.quota-chart-stack')].map((path) => path.dataset.series),
    ['0', 'unattributed']
  );
  assert.deepEqual(texts('.quota-legend li'), ['model-priced', t('Unattributed')]);
  assert.equal(document.querySelector('.quota-legend li:last-child > i').dataset.series, 'unattributed');
});

test('a window the readings fully assign shows no Unattributed share', async (context) => {
  assert.deepEqual(await openUnattributed(context, 0), []);
  assert.equal(document.querySelector('.quota-mix [data-series="unattributed"]'), null);
  assert.deepEqual(texts('.quota-legend li'), ['model-priced']);

  await act(async () => document.querySelector('button.quota-chart-slot').click());

  assert.ok(document.querySelector('.stats-trend-detail li'), 'the hover card is open');
  assert.equal(document.querySelector('.stats-trend-detail [data-series="unattributed"]'), null);
});

test('subscription usage lists Fast calls as a second model row marked Fast', async (context) => {
  const render = harness(context);
  const route = (fields) => ({ turns: 1, input: 100, output: 300, cacheRead: 0, tokens: 400, ...fields });
  const both = route({ model: 'model-both', outputTokensPerSecond: 150, consumed: 4 });
  const bothFast = route({
    model: 'model-both',
    speedTier: 'fast',
    outputTokensPerSecond: 300,
    consumed: 4,
    output: 600,
    tokens: 700,
  });
  const normal = route({ model: 'model-normal', outputTokensPerSecond: 150, consumed: 2 });
  const models = [both, bothFast, normal];
  const { api } = quotaWorld(context, {
    viewedAt: at(2, 1),
    readings: [{ provider: 'anthropic-oauth', account: 'default', label: '5H', ts: at(0, 40), usedPct: 10, resetAt }],
    detail: {
      'anthropic-oauth/5H': {
        window: {
          focus: { usedPct: 10, resetAt, startMs: opened, endMs: resetAt, current: true, peak: 10 },
          summary: { consumed: 10 },
          models,
          modelSeries: models.map((entry) => ({
            ...entry,
            key: entry.model,
            points: [
              [opened, 0],
              [at(2, 1), entry.consumed],
            ],
          })),
          slots: [{ fromMs: opened, toMs: at(0, 30), startPct: 0, endPct: 10, tokens: 1500, models }],
        },
      },
    },
  });
  focusQuotaUsage('anthropic-oauth');
  await render({ surface: 'stats', open: true, onClose() {}, api });
  const rows = [...document.querySelectorAll('.quota-table .stats-model-row')].filter(
    (row) => row.firstElementChild.textContent !== t('Outside Mixdog')
  );
  assert.equal(rows.length, 3);
  const names = rows.map((row) => row.cells[0].textContent);
  assert.equal(names.includes('model-both'), true);
  assert.equal(names.indexOf(`model-both · ${t('Fast')}`), names.indexOf('model-both') + 1);
  assert.equal(names.includes('model-normal'), true);
  const speed = (name) => rows[names.indexOf(name)].cells[3].textContent;
  // The chart legend and a slot's tooltip name the Fast entry too, never the internal key.
  const fastName = `model-both · ${t('Fast')}`;
  const legend = [...document.querySelectorAll('.quota-legend li')].map((li) => li.textContent);
  assert.ok(legend.includes(fastName), `legend: ${legend}`);
  let detail = '';
  for (const slot of document.querySelectorAll('button.quota-chart-slot')) {
    await act(async () => slot.click());
    detail = document.querySelector('.quota-chart-detail, .stats-trend-detail')?.textContent ?? '';
    if (detail.includes(fastName)) break;
  }
  assert.ok(detail.includes(fastName), `tooltip: ${detail}`);
  assert.equal(document.body.textContent.includes('\u0000'), false);
  assert.equal(speed('model-both'), '150');
  assert.equal(speed(`model-both · ${t('Fast')}`), '300');
  assert.equal(
    rows[names.indexOf(`model-both · ${t('Fast')}`)].querySelector('.model-route-label-fast').textContent,
    t('Fast')
  );
});

test('quota rows, series and a slot tooltip distinguish all three speeds of one model', async (context) => {
  const render = harness(context);
  const models = ['standard', 'fast', 'ultrafast'].map((speedTier) => ({
    model: 'model-a',
    speedTier,
    consumed: 1,
  }));
  const domain = { fromMs: opened, toMs: resetAt };
  const answer = {
    generatedAt: now,
    view: 'window',
    selection: { provider: 'anthropic-oauth', account: 'default', label: '5H' },
    subscriptions: [{ provider: 'anthropic-oauth', account: 'default', windows: ['5H'] }],
    period: domain,
    domain,
    points: [
      [opened, 0, 1],
      [now, 3, 1],
    ],
    models,
    modelSeries: models.map(({ model, speedTier }) => ({
      key: model,
      speedTier,
      points: [
        [opened, 0],
        [now, 1],
      ],
    })),
    slots: [{ ...domain, models, startPct: 0, endPct: 3 }],
  };
  const api = { invokeCapability: async () => ({ value: answer }) };
  focusQuotaUsage('anthropic-oauth');
  await render({ surface: 'stats', open: true, onClose() {}, api });
  const names = ['model-a', `model-a · ${t('Fast')}`, `model-a · ${t('Ultrafast')}`];
  assert.deepEqual(texts('.quota-table .stats-model-cell'), names);
  assert.deepEqual(texts('.quota-legend li'), names);
  const inks = [...document.querySelectorAll('.quota-legend [data-series]')].map((node) => node.dataset.series);
  assert.equal(new Set(inks).size, 3);
  await act(async () => document.querySelector('button.quota-chart-slot').click());
  assert.deepEqual(texts('.stats-trend-detail .usage-model-label'), names);
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
