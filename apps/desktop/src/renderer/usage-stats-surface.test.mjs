import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { UsageStatsBody } from './UsageStatsSurface.tsx';
import { CommandSurface } from './CommandSurface.tsx';
import { t } from './i18n.ts';
import { resolveUsageStatsPeriod } from '../../../../src/standalone/usage-stats-period.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function harness(context, Component = UsageStatsBody) {
    const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://mixdog.test/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    const root = createRoot(document.querySelector('main'));
    context.after(async () => { await act(async () => root.unmount()); dom.window.close(); });
    return async (props) => act(async () => root.render(React.createElement(Component, props)));
}
function snapshot(view = 'hour', tokens = 1200, anchor) {
    const now = new Date(2026, 8, 13, 12).getTime();
    const period = resolveUsageStatsPeriod({ view, anchor, now });
    const route = { turns: 1, sessions: 1, input: tokens - 200, output: 200, tokens,
        cacheRead: 500, cacheWrite: 800, cacheTokens: 1300,
        costUsd: 2, costCoverage: 1, share: 1, models: [] };
    return { period, range: { days: period.days }, totals: { ...route, sessions: 1 },
        providers: [{ ...route, provider: 'openai', providerKind: 'api' }],
        daily: [{ day: period.startDay || '2026-09-01', tokens, turns: 1, costUsd: 2, providers: [] }],
        hourly: Array.from({ length: 24 }, (_, hour) => ({
            key: String(hour).padStart(2, '0'), label: `${String(hour).padStart(2, '0')}:00`,
            tokens: hour === 9 ? tokens : 0, turns: hour === 9 ? 1 : 0, costUsd: hour === 9 ? 2 : 0,
            providers: [], future: hour > 12,
        })), coverage: {} };
}
function button(label) {
    return [...document.querySelectorAll('button')].find((node) => node.textContent === t(label));
}

test('statistics open before the response and repaint cached figures immediately on reopen', async (context) => {
    const render = harness(context, CommandSurface);
    let resolve;
    const props = { surface: 'stats', open: true, onClose() {},
        api: { invokeCapability: () => new Promise((yes) => { resolve = yes; }) } };
    await render(props);
    assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelector('.stats-surface'), null);
    await act(async () => resolve({ value: snapshot() }));
    assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'false');
    assert.equal(document.querySelectorAll('.stats-card').length, 5);
    assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '1.2K');
    await render({ ...props, open: false });
    await render(props);
    assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '1.2K');
    assert.equal(document.querySelector('.stats-refresh-status').textContent, t('Refreshing…'));
    await act(async () => resolve({ value: snapshot('hour', 2400) }));
    assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '2.4K');
});

test('closing a pending statistics request prevents its late response from opening a dialog', async (context) => {
    const render = harness(context, CommandSurface);
    const resolvers = [];
    let closeCalls = 0;
    const props = { surface: 'stats', open: true, onClose() { closeCalls++; },
        api: { invokeCapability: () => new Promise((yes) => { resolvers.push(yes); }) } };
    await render(props);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(closeCalls, 1);
    await render({ ...props, open: false });
    await render(props);
    await act(async () => resolvers[0]({ value: snapshot('hour', 999) }));
    assert.equal(document.querySelector('[role="dialog"]').getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelector('.stats-surface'), null, 'retired response cannot paint');
    await act(async () => resolvers[1]({ value: snapshot('hour', 1200) }));
    assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '1.2K');
});

test('an initial statistics failure presents the error without inventing an empty usage dashboard', async (context) => {
    const render = harness(context, CommandSurface);
    await render({ surface: 'stats', open: true, onClose() {},
        api: { async invokeCapability() { throw new Error('usage offline'); } } });
    assert.equal(document.querySelector('[role="alert"]').textContent, 'usage offline');
    assert.equal(document.querySelector('.stats-surface'), null);
});

test('a reopen refresh failure retains the cached figures beside the error', async (context) => {
    const render = harness(context, CommandSurface);
    let fail = false;
    const props = { surface: 'stats', open: true, onClose() {},
        api: { async invokeCapability() {
            if (fail) throw new Error('refresh offline');
            return { value: snapshot() };
        } } };
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
    const cursor = { ...stats.providers[0], provider: 'cursor-oauth', providerKind: 'oauth',
        input: null, output: 200, tokens: 200, cacheRead: null, cacheWrite: null,
        cacheHitRate: null, costUsd: 0, costCoverage: 0, unmeasuredTurns: 1, share: null };
    stats.providers = [cursor];
    stats.totals = { ...cursor };
    await render({ data: { getUsageStats: stats }, request: async () => stats });
    const row = document.querySelector('.stats-provider tr');
    assert.equal(row.cells[3].textContent, '—');
    assert.equal(row.cells[4].textContent, '200');
    assert.equal(row.cells[5].textContent, '—');
    assert.equal(row.cells[6].textContent, '—');
    assert.equal(row.cells[7].textContent, '200+');
    assert.equal(row.cells[8].textContent, '—');
    assert.equal(document.querySelector('.stats-provider-toggle small').textContent, '—');
    assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '200+');
    assert.match(document.querySelector('[role="note"]').textContent, /Cursor/);
});

test('API-only catalog estimates are not labeled subscription value or no bill', async (context) => {
    const render = harness(context);
    const stats = snapshot();
    stats.providers.push({ ...stats.providers[0], provider: 'openai-oauth', providerKind: 'oauth', costUsd: 7 });
    await render({ data: { getUsageStats: stats }, request: async () => stats });
    const cards = [...document.querySelectorAll('.stats-card')];
    assert.match(cards[0].querySelector('b').textContent, /7/);
    assert.match(cards[1].querySelector('b').textContent, /2/);
    assert.equal(cards[1].textContent.includes(t('Not billed')), false);
});

test('range failures retain the displayed period and values; returning to All uses the new response', async (context) => {
    const render = harness(context);
    let resolve;
    let reject;
    const request = () => new Promise((yes, no) => { resolve = yes; reject = no; });
    const data = { getUsageStats: snapshot() };
    await render({ data, request });
    const previousCards = document.querySelector('.stats-cards').textContent;
    await act(async () => button('By day').click());
    assert.equal(document.querySelector('.stats-cards').textContent, previousCards);
    assert.equal(button('By hour').getAttribute('aria-pressed'), 'true');
    await act(async () => reject(new Error('offline')));
    assert.equal(button('By hour').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('[role="alert"]').textContent, 'offline');
    await act(async () => button('By day').click());
    await act(async () => resolve(snapshot('day', 700)));
    assert.equal(button('By day').getAttribute('aria-pressed'), 'true');
    await act(async () => button('All').click());
    await act(async () => resolve(snapshot('all', 900)));
    assert.equal(button('All').getAttribute('aria-pressed'), 'true');
    assert.match(document.querySelectorAll('.stats-card > b')[2].textContent, /900/);
});

test('statistics open with an hourly today request and no period arrows', async (context) => {
    const calls = [];
    const render = harness(context, CommandSurface);
    await render({
        surface: 'stats', open: true, onClose() {},
        api: { async invokeCapability(request) { calls.push(request); return { value: snapshot() }; } },
    });
    assert.equal(calls[0].capability, 'getUsageStats');
    assert.deepEqual(calls[0].args, [{ view: 'hour' }]);
    assert.equal(button('By hour').getAttribute('aria-pressed'), 'true');
    assert.equal(document.querySelector('.stats-period-arrow'), null);
    assert.equal(document.querySelectorAll('.stats-trend-bars > i').length, 24);
});

test('models start expanded, sessions lead numeric columns, and cache hits exclude writes', async (context) => {
    const render = harness(context);
    const stats = snapshot();
    stats.providers[0].models = [
        { ...stats.providers[0], model: 'audit-model-one' },
        { ...stats.providers[0], model: 'audit-model-two', sessions: null, costCoverage: 0, costUsd: 0 },
    ];
    await render({ data: { getUsageStats: stats }, request: async () => stats });
    assert.deepEqual([...document.querySelectorAll('thead th')].map((th) => th.textContent),
        ['Provider', 'Sessions', 'Usage records', 'Input', 'Output', 'Cache hits', 'Hit rate', 'Tokens', 'Cost'].map((key) => t(key)));
    assert.equal(document.querySelectorAll('.stats-model-row').length, 2);
    const providerRow = document.querySelector('.stats-provider tr');
    assert.deepEqual([...document.querySelectorAll('.stats-trend footer span')].map((node) => node.textContent),
        ['00:00', '23:00']);
    assert.equal(providerRow.cells[1].textContent, '1');
    assert.equal(providerRow.cells[5].textContent, '500');
    assert.match(providerRow.cells[5].title, /800/);
    const unknown = document.querySelectorAll('.stats-model-row')[1];
    assert.equal(unknown.cells[1].textContent, '—');
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

test('an incomplete session count shows the seen sessions as a floor and an empty period says so', async (context) => {
    const render = harness(context);
    const stats = snapshot();
    stats.totals = { ...stats.totals, sessions: 12, sessionsComplete: false };
    stats.providers[0] = { ...stats.providers[0], sessions: 0, sessionsComplete: false };
    stats.providers[0].models = [{ ...stats.providers[0], model: 'floor-model', sessions: 3, sessionsComplete: false }];
    stats.hourly = stats.hourly.map((hour) => ({ ...hour, tokens: 0, turns: 0, costUsd: 0 }));
    await render({ data: { getUsageStats: stats }, request: async () => stats });
    const note = t('Some usage carries no session id; the count is a lower bound.');
    const sessionsCard = document.querySelectorAll('.stats-card')[4];
    assert.equal(sessionsCard.querySelector('b').textContent, '12+');
    assert.equal(sessionsCard.querySelector('b').title, note);
    const providerRow = document.querySelector('.stats-provider tr');
    assert.equal(providerRow.cells[1].textContent, '—');
    assert.equal(providerRow.cells[1].title, note);
    assert.equal(document.querySelector('.stats-model-row').cells[1].textContent, '3+');
    assert.equal(document.querySelector('.stats-trend-bars'), null);
    assert.equal(document.querySelector('.stats-trend-empty').textContent, t('No usage in this period.'));
    assert.equal(document.querySelector('.stats-trend header > span'), null);
});

test('period navigation changes cards and model rows together, blocks future navigation and returns to current', async (context) => {
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
    await act(async () => button('By day').click());
    assert.equal(named('Next period').disabled, true);
    assert.equal(button('Current period'), undefined);
    await act(async () => named('Previous period').click());
    assert.deepEqual(calls.at(-1), { view: 'day', anchor: '2026-08-01' });
    assert.equal(named('Next period').disabled, false);
    assert.equal(document.querySelectorAll('.stats-card > b')[2].textContent, '600');
    assert.equal(document.querySelector('.stats-model-row').cells[7].textContent, '600');
    await act(async () => button('Current period').click());
    assert.deepEqual(calls.at(-1), { view: 'day' });
    assert.equal(named('Next period').disabled, true);
    await act(async () => button('By week').click());
    await act(async () => named('Previous period').click());
    assert.deepEqual(calls.at(-1), { view: 'week', anchor: '2026-04-01' });
    await act(async () => named('Next period').click());
    assert.deepEqual(calls.at(-1), { view: 'week', anchor: '2026-07-01' });
    assert.equal(named('Next period').disabled, true);
    await act(async () => button('By month').click());
    await act(async () => named('Previous period').click());
    assert.deepEqual(calls.at(-1), { view: 'month', anchor: '2025-01-01' });
    await act(async () => button('All').click());
    assert.deepEqual(calls.at(-1), { view: 'all' });
    assert.equal(document.querySelector('.stats-period-arrow'), null);
    await act(async () => button('By hour').click());
    assert.deepEqual(calls.at(-1), { view: 'hour' });
    assert.equal(document.querySelector('.stats-period-arrow'), null);
});
