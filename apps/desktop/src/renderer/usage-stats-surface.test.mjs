import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import i18next from 'i18next';
import { UsageStatsBody, resolveUsageTrendGrouping } from './UsageStatsSurface.tsx';
import { CommandSurface } from './CommandSurface.tsx';
import { holdStatsDataCache, refreshStatsDataCache } from './command-surface-cache.ts';
import { t } from './i18n.ts';
import { usageMoney } from './usage-format.ts';
import { HOVER_POPOVER_CLOSE_DELAY_MS } from './hover-popover.ts';
import { resolveUsageStatsPeriod } from '../../../../src/standalone/usage-stats-period.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function harness(context, Component = UsageStatsBody) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://mixdog.test/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.history = dom.window.history;
  const root = createRoot(document.querySelector('main'));
  context.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return async (props) => act(async () => root.render(React.createElement(Component, props)));
}
function snapshot(view = 'hour', tokens = 1200, anchor, dates = {}) {
  const now = new Date(2026, 8, 13, 12).getTime();
  const period = resolveUsageStatsPeriod({ view, anchor, now, ...dates });
  const route = {
    turns: 1,
    sessions: 1,
    input: tokens - 200,
    output: 200,
    tokens,
    cacheRead: 500,
    cacheWrite: 800,
    cacheTokens: 1300,
    costUsd: 2,
    costCoverage: 1,
    share: 1,
    models: [],
  };
  return {
    generatedAt: now,
    period,
    range: { days: period.days, firstDay: period.startDay || '2025-01-01' },
    totals: { ...route, sessions: 1 },
    providers: [{ ...route, provider: 'openai', providerKind: 'api' }],
    daily: [{ day: period.startDay || '2026-09-01', tokens, turns: 1, costUsd: 2, costKnownTurns: 1, providers: [] }],
    hourly: Array.from({ length: 24 }, (_, hour) => ({
      key: String(hour).padStart(2, '0'),
      label: `${String(hour).padStart(2, '0')}:00`,
      tokens: hour === 9 ? tokens : 0,
      turns: hour === 9 ? 1 : 0,
      costUsd: hour === 9 ? 2 : 0,
      costKnownTurns: hour === 9 ? 1 : 0,
      providers: [],
      future: hour > 12,
    })),
    coverage: {},
  };
}
function button(label) {
  return [...document.querySelectorAll('button')].find((node) => node.textContent === t(label));
}

test('statistics open before the response and repaint cached figures immediately on reopen', async (context) => {
  const render = harness(context, CommandSurface);
  let resolve;
  const props = {
    surface: 'stats',
    open: true,
    onClose() {},
    api: {
      invokeCapability: () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    },
  };
  await render(props);
  assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
  const anchors = ['.stats-controls', '.stats-cards', '.stats-mix', '.stats-trend', '.usage-table-shell'];
  const initial = anchors.map((selector) => document.querySelector(selector));
  assert.equal(initial.every(Boolean), true);
  assert.equal(document.querySelector('.stats-surface').dataset.loading, 'true');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-card > b')].map((node) => node.textContent),
    ['', '', '', '']
  );
  assert.equal(
    [...document.querySelectorAll('.stats-controls button')].every((node) => node.disabled),
    true
  );
  assert.equal(document.querySelector('.stats-surface').textContent.includes(t('No usage recorded yet.')), false);
  await act(async () => resolve({ value: snapshot() }));
  anchors.forEach((selector, index) => assert.equal(document.querySelector(selector), initial[index]));
  assert.equal(document.querySelector('.stats-surface').dataset.loading, undefined);
  assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'false');
  assert.equal(document.querySelectorAll('.stats-card').length, 4);
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '1.2K');
  await render({ ...props, open: false });
  await render(props);
  assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '1.2K');
  assert.equal(document.querySelector('.stats-refresh-status').textContent, t('Refreshing…'));
  assert.ok(document.querySelector('.command-surface-header-actions .stats-refresh-status'));
  assert.equal(document.querySelector('.mixdog-settings__body .stats-refresh-status'), null);
  await act(async () => resolve({ value: snapshot('hour', 2400) }));
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '2.4K');
});

test('closing statistics keeps a shared read without allowing it to reopen the dialog', async (context) => {
  const render = harness(context, CommandSurface);
  const resolvers = [];
  let closeCalls = 0;
  const props = {
    surface: 'stats',
    open: true,
    onClose() {
      closeCalls++;
    },
    api: {
      invokeCapability: () =>
        new Promise((yes) => {
          resolvers.push(yes);
        }),
    },
  };
  await render(props);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(closeCalls, 1);
  await render({ ...props, open: false });
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await render(props);
  assert.equal(resolvers.length, 1, 'reopening joins the same authoritative read');
  assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
  assert.equal(document.querySelector('.stats-surface').dataset.loading, 'true');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-card > b')].map((node) => node.textContent),
    ['', '', '', '']
  );
  await act(async () => resolvers[0]({ value: snapshot('hour', 1200) }));
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '1.2K');
  await render({ ...props, open: false });
  const background = refreshStatsDataCache(props.api);
  await act(async () => {
    resolvers[1]({ value: snapshot('hour', 2400) });
    await background;
  });
  assert.equal(document.querySelector('[role="dialog"]'), null, 'a completed background read stays hidden');
});

test('statistics show warmed figures in the first committed frame, including after closed usage growth', async (context) => {
  const commits = [];
  function Probe(props) {
    React.useLayoutEffect(() => {
      if (props.open) commits.push(document.querySelectorAll('.stats-card > b')[2]?.textContent);
    });
    return React.createElement(CommandSurface, props);
  }
  const render = harness(context, Probe);
  let update;
  let tokens = 1200;
  const api = {
    async invokeCapability() {
      return { value: snapshot('hour', tokens) };
    },
    subscribeState(listener) {
      update = listener;
      return () => {};
    },
  };
  const release = holdStatsDataCache(api);
  context.after(release);
  await refreshStatsDataCache(api);
  const props = { surface: 'stats', open: true, onClose() {}, api };
  await render(props);
  assert.equal(commits[0], '1.2K');
  await render({ ...props, open: false });
  tokens = 2400;
  update({ sessionId: 'one', stats: { inputTokens: 2200, outputTokens: 200, turns: 2 } });
  await refreshStatsDataCache(api);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  commits.length = 0;
  await render(props);
  assert.equal(commits[0], '2.4K', 'the old 1.2K value is never committed on entry');
  assert.equal(document.querySelector('.stats-surface').dataset.loading, undefined);
  assert.ok(document.querySelector('.stats-provider-row').textContent.includes('2.4K'));
  assert.ok(document.querySelector('.stats-trend').textContent.includes('2.4K'));
});

test('entry during usage warmup waits for one complete result instead of flashing old figures', async (context) => {
  const render = harness(context, CommandSurface);
  let update;
  const resolvers = [];
  const api = {
    invokeCapability: () => new Promise((resolve) => resolvers.push(resolve)),
    subscribeState(listener) {
      update = listener;
      return () => {};
    },
  };
  const release = holdStatsDataCache(api);
  context.after(release);
  const initial = refreshStatsDataCache(api);
  resolvers[0]({ value: snapshot() });
  await initial;
  const props = { surface: 'stats', open: false, onClose() {}, api };
  await render(props);
  update({ sessionId: 'one', stats: { inputTokens: 2200, outputTokens: 200, turns: 2 } });
  await render({ ...props, open: true });
  assert.equal(resolvers.length, 2, 'entry shares the background read');
  assert.equal(document.querySelector('.stats-surface').dataset.loading, 'true');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-card > b')].map((node) => node.textContent),
    ['', '', '', '']
  );
  assert.equal(document.querySelector('.stats-provider-row'), null);
  await act(async () => resolvers[1]({ value: snapshot('hour', 2400) }));
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '2.4K');
  assert.ok(document.querySelector('.stats-provider-row').textContent.includes('2.4K'));
});

test('switching statistics hosts during a read cannot display the previous host response', async (context) => {
  const render = harness(context, CommandSurface);
  const resolvers = [];
  const createApi = () => ({
    invokeCapability: () => new Promise((resolve) => resolvers.push(resolve)),
  });
  const props = { surface: 'stats', open: true, onClose() {} };
  await render({ ...props, api: createApi() });
  await render({ ...props, api: createApi() });
  assert.equal(resolvers.length, 2);
  await act(async () => resolvers[0]({ value: snapshot('hour', 9999) }));
  assert.equal(document.querySelector('.stats-surface').dataset.loading, 'true');
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '');
  await act(async () => resolvers[1]({ value: snapshot('hour', 2400) }));
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '2.4K');
});

test('an initial statistics failure presents the error without inventing an empty usage dashboard', async (context) => {
  const render = harness(context, CommandSurface);
  await render({
    surface: 'stats',
    open: true,
    onClose() {},
    api: {
      async invokeCapability() {
        throw new Error('usage offline');
      },
    },
  });
  assert.equal(document.querySelector('[role="alert"]').textContent, 'usage offline');
  assert.equal(document.querySelector('.stats-surface'), null);
});

test('a reopen refresh failure retains the cached figures beside the error', async (context) => {
  const render = harness(context, CommandSurface);
  let fail = false;
  const props = {
    surface: 'stats',
    open: true,
    onClose() {},
    api: {
      async invokeCapability() {
        if (fail) throw new Error('refresh offline');
        return { value: snapshot() };
      },
    },
  };
  await render(props);
  await render({ ...props, open: false });
  fail = true;
  await render(props);
  assert.equal(document.querySelector('[role="alert"]').textContent, 'refresh offline');
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '1.2K');
});

test('unmeasured Cursor usage is not displayed as zero cache, zero hit rate or a confirmed cost', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  const cursor = {
    ...stats.providers[0],
    provider: 'cursor-oauth',
    providerKind: 'oauth',
    input: null,
    output: 200,
    tokens: 200,
    cacheRead: null,
    cacheWrite: null,
    cacheHitRate: null,
    costUsd: 0,
    costCoverage: 0,
    unmeasuredTurns: 1,
    share: null,
  };
  stats.providers = [cursor];
  stats.totals = { ...cursor };
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  const row = document.querySelector('.stats-provider tr');
  assert.equal(row.cells[1].textContent, '—');
  assert.equal(row.cells[2].textContent, '1');
  assert.equal(row.cells[3].textContent, '—');
  assert.equal(row.cells[4].textContent, '200');
  assert.equal(row.cells[5].textContent, '—');
  assert.equal(row.cells[6].textContent, '—');
  assert.equal(row.cells[7].textContent, '200');
  assert.equal(row.cells[8].textContent, '—');
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '200');
  assert.equal(
    document
      .querySelector('.stats-surface')
      .textContent.includes(
        t(
          'Cursor does not report per-request input or cache usage. Context-derived historical inputs and costs are excluded; + marks incomplete totals.'
        )
      ),
    false
  );
});

test('API-only catalog estimates are not labeled subscription value, estimated or no bill', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  stats.providers.push({ ...stats.providers[0], provider: 'openai-oauth', providerKind: 'oauth', costUsd: 7 });
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  const cards = [...document.querySelectorAll('.stats-card')];
  assert.match(cards[0].querySelector('b').textContent, /7/);
  assert.match(cards[1].querySelector('b').textContent, /2/);
  assert.equal(cards[1].querySelector('small').textContent, t('API cost'));
  assert.equal(cards[1].textContent.includes(t('Not billed')), false);
  assert.equal(document.querySelector('.stats-surface').textContent.includes('(estimated)'), false);
});

test('range failures retain the displayed period and values; yearly uses the new response', async (context) => {
  const render = harness(context);
  let resolve;
  let reject;
  const request = () =>
    new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
  const data = { getUsageStats: snapshot() };
  await render({ data, request });
  const previousCards = document.querySelector('.stats-cards').textContent;
  await act(async () => button('Last 30 days').click());
  assert.equal(document.querySelector('.stats-cards').textContent, previousCards);
  assert.equal(button('Last 24 hours').getAttribute('aria-pressed'), 'true');
  await act(async () => reject(new Error('offline')));
  assert.equal(button('Last 24 hours').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[role="alert"]').textContent, 'offline');
  await act(async () => button('Last 30 days').click());
  await act(async () => resolve(snapshot('day', 700)));
  assert.equal(button('Last 30 days').getAttribute('aria-pressed'), 'true');
  await act(async () => button('All').click());
  await act(async () => resolve(snapshot('year', 900)));
  assert.equal(button('All').getAttribute('aria-pressed'), 'true');
  assert.match(document.querySelectorAll('.stats-card > b')[2].textContent, /900/);
});

test('statistics open with the last 24 hours, four cards, and no sessions or information icon', async (context) => {
  const calls = [];
  const render = harness(context, CommandSurface);
  await render({
    surface: 'stats',
    open: true,
    onClose() {},
    api: {
      async invokeCapability(request) {
        calls.push(request);
        return { value: snapshot() };
      },
    },
  });
  assert.equal(calls[0].capability, 'getUsageStats');
  assert.deepEqual(calls[0].args, [{ view: 'hour' }]);
  assert.equal(button('Last 24 hours').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-controls .stats-ranges button')].map((node) => node.textContent),
    ['Last 24 hours', 'Last 7 days', 'Last 30 days', 'Last 90 days', 'Last year', 'All', 'Custom'].map((label) =>
      t(label)
    )
  );
  assert.deepEqual(
    [...document.querySelectorAll('.stats-card small')].map((node) => node.textContent),
    ['Subscription list-price value', 'API cost', 'Tokens', 'Usage records'].map((label) => t(label))
  );
  assert.equal(document.querySelector('.stats-controls [role="img"]'), null);
  assert.equal(button('Sessions'), undefined);
  assert.equal(document.querySelector('.stats-period-arrow'), null);
  assert.equal(document.querySelectorAll('.stats-trend-bar').length, 24);
});

test('models start expanded, request counts lead numeric columns, and cache hits exclude writes', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  stats.providers[0].models = [
    { ...stats.providers[0], model: 'audit-model-one' },
    { ...stats.providers[0], model: 'audit-model-two', sessions: null, costCoverage: 0, costUsd: 0 },
  ];
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  assert.deepEqual(
    [...document.querySelectorAll('thead th')].map((th) => th.textContent),
    ['Provider', 'Usage share', 'Usage records', 'Input', 'Output', 'Cache hits', 'Hit rate', 'Tokens', 'Cost'].map(
      (key) => t(key)
    )
  );
  assert.equal(document.querySelectorAll('.stats-model-row').length, 2);
  const providerRow = document.querySelector('.stats-provider tr');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend footer span')].map((node) => node.textContent),
    ['00:00', '23:00']
  );
  assert.equal(providerRow.cells[2].textContent, '1');
  // Input = 1,000 fresh + 800 written to cache; the split lives in the tooltip.
  assert.equal(providerRow.cells[3].textContent, '1.8K');
  assert.match(providerRow.cells[3].title, /1K.*800/);
  assert.equal(providerRow.cells[5].textContent, '500');
  assert.equal(providerRow.cells[5].title, '');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-mix li b')].map((node) => node.textContent),
    ['1.8K', '200', '500']
  );
  const unknown = document.querySelectorAll('.stats-model-row')[1];
  assert.equal(unknown.cells[2].textContent, '1');
  assert.equal(unknown.cells[8].textContent, '—');
  for (const note of ['Not billed', 'Not an invoice', 'Cache excluded', 'per day']) {
    assert.equal(document.querySelector('.stats-surface').textContent.includes(t(note)), false);
  }
  const toggle = document.querySelector('.stats-provider-toggle');
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(document.querySelectorAll('.stats-model-row').length, 0);
  await act(async () => toggle.click());
  assert.equal(document.querySelectorAll('.stats-model-row').length, 2);
});

test('cache hit rates show one decimal in the summary, provider and model rows', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  stats.totals.cacheHitRate = 0.98346;
  stats.providers[0].cacheHitRate = 0.85496;
  stats.providers[0].models = [
    { ...stats.providers[0], model: 'rounded', cacheHitRate: 0.98356 },
    { ...stats.providers[0], model: 'zero', cacheHitRate: 0 },
    { ...stats.providers[0], model: 'full', cacheHitRate: 1 },
    { ...stats.providers[0], model: 'unknown', cacheHitRate: null },
  ];
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  assert.equal(document.querySelector('.stats-mix header span').textContent, `${t('Cache hit rate')} 98.3%`);
  assert.equal(document.querySelector('.stats-provider tr').cells[6].textContent, '85.5%');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-model-row')].map((row) => row.cells[6].textContent),
    ['98.4%', '0.0%', '100.0%', '—']
  );
});

test('incomplete session metadata is not exposed and an empty period says so', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  stats.totals = { ...stats.totals, sessions: 12, sessionsComplete: false };
  stats.providers[0] = { ...stats.providers[0], sessions: 0, sessionsComplete: false };
  stats.providers[0].models = [{ ...stats.providers[0], model: 'floor-model', sessions: 3, sessionsComplete: false }];
  stats.hourly = stats.hourly.map((hour) => ({ ...hour, tokens: 0, turns: 0, costUsd: 0 }));
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  const note = t('Some usage carries no session id; the count is a lower bound.');
  assert.equal(document.querySelectorAll('.stats-card').length, 4);
  assert.equal(document.querySelector('.stats-surface').textContent.includes(t('Sessions')), false);
  assert.equal(
    [...document.querySelectorAll('[title]')].some((node) => node.title === note),
    false
  );
  const providerRow = document.querySelector('.stats-provider tr');
  assert.equal(providerRow.cells.length, 9);
  assert.equal(providerRow.cells[2].textContent, '1');
  assert.equal(document.querySelector('.stats-model-row').cells[2].textContent, '1');
  assert.equal(document.querySelector('.stats-trend-bars'), null);
  assert.equal(document.querySelector('.stats-trend-empty').textContent, t('No usage in this period.'));
  assert.equal(document.querySelector('.stats-trend header > span'), null);
});

test('period arrows update cards and models, block future navigation, and need no return button', async (context) => {
  const render = harness(context);
  const calls = [];
  const request = async (_capability, args) => {
    const selection = args[0];
    calls.push(selection);
    const result = snapshot(selection.view, selection.anchor ? 600 : 1200, selection.anchor);
    result.providers[0].models = [{ ...result.providers[0], model: 'period-model' }];
    return result;
  };
  const named = (label) => document.querySelector(`button[aria-label="${t(label)}"]`);
  await render({ data: { getUsageStats: snapshot() }, request });
  await act(async () => button('Last 30 days').click());
  assert.equal(
    document.querySelector('.stats-period-label').textContent,
    new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric' }).formatRange(
      new Date(2026, 7, 15),
      new Date(2026, 8, 13)
    )
  );
  assert.equal(named('Next period').disabled, true);
  assert.equal(button('Current period'), undefined);
  await act(async () => named('Previous period').click());
  assert.deepEqual(calls.at(-1), { view: 'day', anchor: '2026-08-14' });
  assert.equal(named('Next period').disabled, false);
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '600');
  assert.equal(document.querySelector('.stats-model-row').cells[7].textContent, '600');
  assert.equal(button('Current period'), undefined);
  await act(async () => named('Next period').click());
  assert.deepEqual(calls.at(-1), { view: 'day', anchor: '2026-09-13' });
  assert.equal(named('Next period').disabled, true);
  await act(async () => button('Last 90 days').click());
  await act(async () => named('Previous period').click());
  assert.deepEqual(calls.at(-1), { view: 'week', anchor: '2026-06-15' });
  await act(async () => named('Next period').click());
  assert.deepEqual(calls.at(-1), { view: 'week', anchor: '2026-09-13' });
  assert.equal(named('Next period').disabled, true);
  await act(async () => button('Last year').click());
  await act(async () => named('Previous period').click());
  assert.deepEqual(calls.at(-1), { view: 'month', anchor: '2025-09-13' });
  await act(async () => button('All').click());
  assert.deepEqual(calls.at(-1), { view: 'year' });
  assert.equal(document.querySelector('.stats-period-arrow'), null);
  await act(async () => button('Last 24 hours').click());
  assert.deepEqual(calls.at(-1), { view: 'hour' });
  assert.equal(document.querySelector('.stats-period-arrow'), null);
});

test('all-history chart groups by year and labels the actual retained date range', async (context) => {
  const render = harness(context);
  const stats = snapshot('year');
  stats.range.firstDay = '2025-12-31';
  stats.daily = [
    { day: '2025-12-31', tokens: 100, turns: 1, costUsd: 1, costKnownTurns: 1 },
    { day: '2026-01-01', tokens: 200, turns: 1, costUsd: 2, costKnownTurns: 1 },
    { day: '2026-09-13', tokens: 300, turns: 1, costUsd: 3, costKnownTurns: 1 },
  ];
  await render({ data: { getUsageStats: snapshot() }, request: async () => stats });
  await act(async () => button('All').click());
  const bars = [...document.querySelectorAll('.stats-trend-bar')];
  assert.equal(bars.length, 2);
  assert.match(bars[0].getAttribute('aria-label'), /2025.*100/);
  assert.match(bars[1].getAttribute('aria-label'), /2026.*500/);
  assert.equal(button('All').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend footer span')].map((node) => node.textContent),
    ['2025-12-31', '2026-09-13']
  );
});

test('weekly partial buckets never label a date before the last 90 days or after today', async (context) => {
  const render = harness(context);
  const stats = snapshot('week');
  stats.daily = [
    { day: '2026-06-16', tokens: 10, turns: 1 },
    { day: '2026-06-17', tokens: 20, turns: 1 },
    { day: '2026-09-13', tokens: 30, turns: 1 },
  ];
  await render({ data: { getUsageStats: snapshot() }, request: async () => stats });
  await act(async () => button('Last 90 days').click());
  const bars = [...document.querySelectorAll('.stats-trend-bar')];
  assert.match(bars[0].getAttribute('aria-label'), /^2026-06-16.*30/);
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend footer span')].map((node) => node.textContent),
    ['2026-06-16', '2026-09-13']
  );
});

test('partial totals keep their amounts and price tooltip without trailing plus signs', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  const grok = {
    ...stats.providers[0],
    provider: 'grok-oauth',
    providerKind: 'oauth',
    turns: 116,
    costCoverage: 2 / 116,
    costUsd: 1.037332,
    models: [],
  };
  grok.models = [{ ...grok, model: 'grok-deployment' }];
  stats.providers = [grok];
  stats.totals = { ...grok };
  stats.hourly = [
    {
      key: '09',
      label: '09:00',
      turns: 116,
      tokens: 1200,
      costUsd: 1.037332,
      costKnownTurns: 2,
      providers: [{ provider: grok.provider, costUsd: 1.037332 }],
    },
  ];
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  assert.equal(document.querySelectorAll('.stats-card > b')[0].textContent, '$1.04');
  assert.equal(document.querySelector('.stats-provider tr').cells[8].textContent, '$1.04');
  assert.equal(document.querySelector('.stats-model-row').cells[8].textContent, '$1.04');
  assert.equal(document.querySelector('.stats-provider tr').cells[8].title, t('Partial cost'));
  assert.equal(
    document
      .querySelector('.stats-surface')
      .textContent.includes(
        t('— means price unavailable; + marks a subtotal with unpriced usage. Subscription value is not an API bill.')
      ),
    false
  );
  await act(async () => button('Cost').click());
  assert.equal(document.querySelector('.stats-trend-bar').getAttribute('aria-label'), '09:00 · $1.04');
  assert.equal(
    document.querySelector('.stats-trend header > span').textContent,
    `${t('Peak per {{interval}}', { interval: '1 hour' })} $1.04`
  );
  assert.equal(document.querySelector('.stats-surface').textContent.includes('+'), false);
  assert.equal(document.querySelector('.stats-trend-legend').textContent.includes(`Grok · ${t('Subscription')}`), true);
});

test('seven-day and custom controls submit explicit date bounds without pagination on a custom range', async (context) => {
  const render = harness(context);
  const calls = [];
  const request = async (_capability, [options]) => {
    calls.push(options);
    return snapshot(options.view, 1200, options.anchor, {
      startDay: options.startDay,
      endDay: options.endDay,
    });
  };
  await render({ data: { getUsageStats: snapshot() }, request });
  await act(async () => button('Last 7 days').click());
  assert.deepEqual(calls.at(-1), { view: '7d' });
  await act(async () => button('Custom').click());
  assert.equal(button('Custom').getAttribute('aria-pressed'), 'true');
  assert.equal(button('Custom').classList.contains('is-active'), true);
  assert.equal(button('Last 7 days').getAttribute('aria-pressed'), 'false');
  assert.equal(button('Last 7 days').classList.contains('is-active'), false);
  assert.equal(calls.length, 1, 'opening the editor must not query an unapplied range');
  await act(async () => button('Last 7 days').click());
  assert.equal(document.querySelector('.stats-custom-range'), null);
  assert.equal(button('Last 7 days').getAttribute('aria-pressed'), 'true');
  assert.equal(button('Custom').getAttribute('aria-pressed'), 'false');
  assert.equal(calls.length, 1);
  await act(async () => button('Custom').click());
  assert.deepEqual(
    ['start', 'end'].map((edge) => document.querySelector(`.mx-daterange-day[data-range="${edge}"]`).dataset.day),
    ['2026-09-07', '2026-09-13']
  );
  assert.deepEqual(
    [...document.querySelectorAll('.mx-daterange-clock .mx-select-value')].map((node) => node.textContent),
    [t('All day'), '00', t('All day'), '00'],
    'clock times stay optional; a range without them keeps whole days'
  );
  await act(async () => button('Apply').click());
  assert.deepEqual(calls.at(-1), { view: 'custom', startDay: '2026-09-07', endDay: '2026-09-13' });
  assert.equal(button('Custom').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend footer span')].map((node) => node.textContent),
    ['2026-09-07', '2026-09-13']
  );
  // A custom range pages by its own length instead of losing the arrows.
  const arrows = [...document.querySelectorAll('.stats-period-arrow')];
  assert.equal(arrows.length, 2);
  assert.equal(arrows[1].disabled, true, 'the newest page has no future to step into');
  await act(async () => arrows[0].click());
  assert.deepEqual(calls.at(-1), { view: 'custom', startDay: '2026-08-31', endDay: '2026-09-06' });
});

test('custom ranges pick the finest calendar unit that keeps the chart within thirty bars', async (context) => {
  assert.deepEqual(resolveUsageTrendGrouping('2026-09-01', '2026-09-30').grain, 'day');
  assert.deepEqual(resolveUsageTrendGrouping('2026-08-01', '2026-09-30').grain, 'week');
  assert.deepEqual(resolveUsageTrendGrouping('2024-11-06', '2026-09-14').grain, 'month');
  assert.deepEqual(resolveUsageTrendGrouping('2020-01-01', '2026-09-14').grain, 'year');
  assert.deepEqual(resolveUsageTrendGrouping('1990-01-01', '2026-09-14'), {
    grain: 'year',
    step: 2,
    firstYear: 1990,
    lastYear: 2026,
  });
  const render = harness(context);
  const calls = [];
  // React in this suite loads before the DOM exists, so date inputs cannot
  // be driven by events; the editor is seeded from the all-history range instead.
  const request = async (_capability, [options]) => {
    calls.push(options);
    const stats = snapshot(options.view, 1200, options.anchor, { startDay: options.startDay, endDay: options.endDay });
    if (options.view === 'year') stats.range.firstDay = '2024-11-06';
    if (options.view === 'custom') {
      stats.daily = [
        { day: '2024-11-06', tokens: 100, turns: 1, costUsd: 1, costKnownTurns: 1 },
        { day: '2025-02-28', tokens: 200, turns: 1, costUsd: 2, costKnownTurns: 1 },
        { day: '2026-09-13', tokens: 300, turns: 1, costUsd: 3, costKnownTurns: 1 },
      ];
    }
    return stats;
  };
  await render({ data: { getUsageStats: snapshot() }, request });
  await act(async () => button('All').click());
  await act(async () => button('Custom').click());
  const endDay = '2026-09-13'; // the snapshot clock's today
  // The calendar opens on the month holding the end of the seeded range; its
  // 2024 start is kept in state, not on screen.
  assert.equal(document.querySelector('.mx-daterange-day[data-range="end"]').dataset.day, endDay);
  await act(async () => button('Apply').click());
  assert.deepEqual(calls.at(-1), { view: 'custom', startDay: '2024-11-06', endDay });
  const bars = [...document.querySelectorAll('.stats-trend-bar')];
  assert.equal(bars.length, 3, 'months with usage; the 23-month span never exceeds the bar cap');
  assert.match(bars[0].getAttribute('aria-label'), /^2024-11.*100/);
  assert.match(bars[1].getAttribute('aria-label'), /^2025-02.*200/);
  assert.match(document.querySelector('.stats-trend header span').textContent, /month/);
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend footer span')].map((node) => node.textContent),
    ['2024-11-06', endDay]
  );
});

test('chart hover and click expose compact token totals and provider splits, with outside dismissal', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  stats.providers[0] = { ...stats.providers[0], input: 600, output: 200, tokens: 800, costUsd: 1.5 };
  stats.providers.push({
    ...stats.providers[0],
    provider: 'anthropic-oauth',
    providerKind: 'oauth',
    input: 300,
    output: 100,
    tokens: 400,
    costUsd: 0.5,
  });
  stats.hourly[9] = {
    ...stats.hourly[9],
    turns: 2,
    costKnownTurns: 2,
    fromMs: new Date(2026, 8, 13, 9).getTime(),
    toMs: new Date(2026, 8, 13, 10).getTime(),
    providers: [
      { provider: 'openai', tokens: 800, turns: 1, costUsd: 1.5, costKnownTurns: 1 },
      { provider: 'anthropic-oauth', tokens: 400, turns: 1, costUsd: 0.5, costKnownTurns: 1 },
    ],
  };
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  const bar = [...document.querySelectorAll('.stats-trend-bar')].find((node) =>
    node.getAttribute('aria-label').startsWith('09:00')
  );
  await act(async () => bar.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  const detail = document.querySelector('.stats-trend-detail');
  assert.ok(detail);
  assert.equal(bar.getAttribute('aria-expanded'), 'true');
  assert.equal(bar.hasAttribute('title'), false, 'the native tooltip must not cover the detail card');
  assert.deepEqual(
    [...detail.querySelectorAll('dd')].map((node) => node.textContent),
    ['1.2K', '$2.00', '2']
  );
  assert.deepEqual(
    [...detail.querySelectorAll('li > b')].map((node) => node.textContent),
    ['800', '400']
  );
  assert.match(detail.querySelector('.stats-trend-detail-heading').textContent, /Sep 13.*9:00.*10:00/);
  await act(async () => bar.click());
  await act(async () =>
    document
      .querySelector('.stats-trend-bars')
      .dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
  );
  assert.ok(document.querySelector('.stats-trend-detail'), 'a clicked card remains pinned');
  await act(async () => document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })));
  assert.equal(document.querySelector('.stats-trend-detail'), null);
  await act(async () => bar.click());
  assert.ok(document.querySelector('.stats-trend-detail'), 'tap/click opens the same card without hover');
  await act(async () => document.querySelector('.stats-trend-detail button').click());
  assert.equal(document.querySelector('.stats-trend-detail'), null);
  await act(async () => button('Cost').click());
  await act(async () => bar.click());
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend-detail li > b')].map((node) => node.textContent),
    ['$1.50', '$0.50']
  );
  await act(async () => button('Usage records').click());
  await act(async () => bar.click());
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend-detail li > b')].map((node) => node.textContent),
    ['1', '1']
  );
});

test('a rolling-window refresh keeps the hovered bucket instead of renaming it', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  // The server keys 24-hour buckets by absolute start time, so a read taken a
  // few minutes later carries the same 24 slots under brand-new keys.
  const rolled = (offsetMs) => ({
    ...stats,
    hourly: stats.hourly.map((bucket, hour) => ({
      ...bucket,
      key: String(new Date(2026, 8, 13, hour).getTime() + offsetMs),
      label: `${String(hour).padStart(2, '0')}:${String(offsetMs / 60000).padStart(2, '0')}`,
    })),
  });
  await render({ data: { getUsageStats: rolled(0) }, request: async () => stats });
  const bar = document.querySelectorAll('.stats-trend-bar')[9];
  await act(async () => bar.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  assert.ok(document.querySelector('.stats-trend-detail'));
  await render({ data: { getUsageStats: rolled(5 * 60 * 1000) }, request: async () => stats });
  assert.equal(document.querySelectorAll('.stats-trend-bar')[9], bar, 'the bars are reused, not rebuilt');
  assert.ok(document.querySelector('.stats-trend-detail'), 'the hovered bucket survives a background refresh');
  assert.equal(document.querySelector('.stats-trend-detail dd').textContent, '1.2K');
  assert.equal(document.querySelectorAll('.stats-trend-bar')[9].getAttribute('aria-label'), '09:05 · 1.2K');
});

test('a scroller that does not carry the chart never dismisses the hover card', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  const bar = document.querySelectorAll('.stats-trend-bar')[9];
  await act(async () => bar.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  assert.ok(document.querySelector('.stats-trend-detail'));
  const elsewhere = document.createElement('div');
  document.body.append(elsewhere);
  context.after(() => elsewhere.remove());
  // A background transcript scrolls on every streamed token and cannot move
  // the bar the card hangs off.
  await act(async () => elsewhere.dispatchEvent(new window.Event('scroll')));
  assert.ok(document.querySelector('.stats-trend-detail'), 'an unrelated scroller leaves the card open');
  await act(async () => document.querySelector('.stats-trend-detail').dispatchEvent(new window.Event('scroll')));
  assert.ok(document.querySelector('.stats-trend-detail'), 'scrolling the card itself leaves it open');
  // The scroller around the chart moves the anchor, so the card still goes.
  await act(async () => document.querySelector('.stats-trend').dispatchEvent(new window.Event('scroll')));
  assert.equal(document.querySelector('.stats-trend-detail'), null);
});

test('chart hover detail cannot capture the pointer outside the bars, but pinned detail stays interactive', async (context) => {
  const render = harness(context);
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('./desktop/28-usage-explorer.css', import.meta.url), 'utf8');
  document.head.append(style);
  const stats = snapshot();
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  const bar = document.querySelectorAll('.stats-trend-bar')[9];
  const enter = () => act(async () => bar.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  const leave = async () => {
    // A pointer-transparent card lets the surface behind it receive the pointer.
    await act(async () =>
      bar.dispatchEvent(
        new window.MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
        })
      )
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, HOVER_POPOVER_CLOSE_DELAY_MS + 50)));
  };
  await enter();
  const detail = document.querySelector('.stats-trend-detail');
  assert.ok(detail);
  for (const node of [detail, ...detail.querySelectorAll('*')]) {
    assert.equal(
      window.getComputedStyle(node).pointerEvents,
      'none',
      'neither the hover card nor its children may extend the chart hover area'
    );
  }
  await leave();
  assert.equal(document.querySelector('.stats-trend-detail'), null);
  assert.equal(bar.getAttribute('aria-expanded'), 'false');

  await enter();
  await act(async () => bar.click());
  const pinned = document.querySelector('.stats-trend-detail');
  assert.equal(window.getComputedStyle(pinned).pointerEvents, 'auto');
  assert.equal(window.getComputedStyle(pinned.querySelector('button')).pointerEvents, 'auto');
  await leave();
  assert.equal(document.querySelector('.stats-trend-detail'), pinned);
  await act(async () => pinned.querySelector('button').click());
  assert.equal(document.querySelector('.stats-trend-detail'), null);
});

test('Korean chart hover uses the same thousand, ten-thousand and hundred-million token units as the table', async (context) => {
  const render = harness(context);
  const language = i18next.language;
  context.after(async () => {
    await i18next.changeLanguage(language);
  });
  await i18next.changeLanguage('ko');
  const stats = snapshot('hour', 135803667);
  stats.providers = [
    { ...stats.providers[0], provider: 'openai', tokens: 123456789, turns: 1000 },
    { ...stats.providers[0], provider: 'anthropic-oauth', tokens: 12345678, turns: 300 },
    { ...stats.providers[0], provider: 'xai', tokens: 1200, turns: 87 },
  ];
  stats.totals.turns = 1387;
  stats.hourly[9] = { ...stats.hourly[9], turns: 1387, providers: stats.providers };
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  const bar = [...document.querySelectorAll('.stats-trend-bar')].find((node) =>
    node.getAttribute('aria-label').startsWith('09:00')
  );
  await act(async () => bar.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })));
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '1.4억');
  assert.equal(document.querySelector('.stats-trend-detail dd').textContent, '1.4억');
  assert.deepEqual(
    [...document.querySelectorAll('td.stats-total-cell')].map((node) => node.textContent),
    ['1.2억', '1234.6만', '1.2천']
  );
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend-detail li > b')].map((node) => node.textContent),
    ['1.2억', '1234.6만', '1.2천']
  );
  assert.equal(document.querySelectorAll('.stats-trend-detail dd')[2].textContent, '1,387');
  await act(async () => button('Usage records').click());
  await act(async () => bar.click());
  assert.deepEqual(
    [...document.querySelectorAll('.stats-trend-detail li > b')].map((node) => node.textContent),
    ['1,000', '300', '87']
  );
});

test('Escape closes the chart detail before the owning statistics dialog', async (context) => {
  const render = harness(context, CommandSurface);
  let closed = 0;
  await render({
    surface: 'stats',
    open: true,
    onClose() {
      closed++;
    },
    api: {
      async invokeCapability() {
        return { value: snapshot() };
      },
    },
  });
  const bar = document.querySelector('.stats-trend-bar');
  await act(async () => bar.click());
  assert.ok(document.querySelector('.stats-trend-detail'));
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(document.querySelector('.stats-trend-detail'), null);
  assert.equal(closed, 0);
  assert.ok(document.querySelector('.command-surface'));
});

test('only a confirmed empty response uses the compact empty state', async (context) => {
  const render = harness(context);
  await render({ data: {}, request: async () => ({}), loading: true });
  assert.equal(document.querySelector('.stats-surface').dataset.empty, undefined);
  const empty = snapshot();
  empty.providers = [];
  empty.totals = { turns: 0, input: 0, output: 0, tokens: 0, costUsd: 0 };
  empty.hourly = [];
  empty.daily = [];
  await render({ data: { getUsageStats: empty }, request: async () => ({}), loading: false });
  assert.equal(document.querySelector('.stats-surface').dataset.empty, 'true');
  assert.equal(document.querySelector('.usage-empty').textContent, t('No usage recorded yet.'));
  assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '0');
  await render({ data: { getUsageStats: snapshot() }, request: async () => ({}), loading: false });
  assert.equal(document.querySelector('.stats-surface').dataset.empty, undefined);
});

test('wholly unpriced cost chart says price unavailable, while actual zero-cost usage remains zero', async (context) => {
  const render = harness(context);
  const stats = snapshot();
  stats.hourly = [{ key: '09', turns: 1, tokens: 100, costUsd: 0, costKnownTurns: 0 }];
  await render({ data: { getUsageStats: stats }, request: async () => stats });
  await act(async () => button('Cost').click());
  assert.equal(document.querySelector('.stats-trend-empty').textContent, t('Price unavailable'));
  assert.equal(usageMoney(null), '—');
  assert.equal(usageMoney(0), '$0.00');
  assert.equal(usageMoney(7585.29), '$7,585.29');
  assert.equal(usageMoney(0.000001), '$0.000001');
  assert.equal(usageMoney(0.0000001), '<$0.000001');
  const free = { ...stats, hourly: [{ ...stats.hourly[0], costKnownTurns: 1 }] };
  await render({ data: { getUsageStats: free }, request: async () => free });
  assert.equal(document.querySelector('.stats-trend-empty').textContent, `${t('Cost')} $0.00`);
});
