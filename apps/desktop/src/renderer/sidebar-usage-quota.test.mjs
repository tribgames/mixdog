import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { press } from './test-support/pointer-press.mjs';
import { installTestDom } from './test-support/test-dom.mjs';
import { SidebarUsage, usagePinEntries } from './SidebarUsage.tsx';
import { applyAccountUsageWindows, publishUsageDashboard } from './usage-dashboard-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const dashboard = (windows) => ({ rows: [{ id: 'antigravity-oauth', group: 'oauth', authenticated: true, windows }] });

const pinPercent = (windows) => usagePinEntries(dashboard(windows))[0]?.percent ?? null;
// The drawn bars in the default long mode: the long window only.
const pinBars = (windows) =>
  (usagePinEntries(dashboard(windows), 'long')[0]?.bars ?? []).map((bar) => [bar.label, bar.percent]);

test('Antigravity pins weekly 7D as the bar and its figure, independent of order', () => {
  const windows = [
    { label: '5H', usedPct: 90, resetAt: NOW + 4 * HOUR, source: 'antigravity-quota' },
    { label: '7D', usedPct: 20, resetAt: NOW + 3 * DAY, source: 'antigravity-quota' },
  ];
  for (const ordered of [windows, [...windows].reverse()]) {
    assert.deepEqual(pinBars(ordered), [['7D', 20]]);
    assert.equal(pinPercent(ordered), 20);
  }
});

test('exhausted weekly usage is pinned; missing weekly data is never invented; known zero stays visible', () => {
  const exhausted = [
    { label: '5H', usedPct: 4, resetAt: NOW + HOUR },
    { label: '7D', usedPct: 100, resetAt: NOW + DAY },
  ];
  assert.deepEqual(pinBars(exhausted), [['7D', 100]]);
  assert.equal(pinPercent(exhausted), 100);
  const missing = [
    { label: '5H', usedPct: 4 },
    { label: '7D', usedPct: null },
  ];
  assert.deepEqual(pinBars(missing), [['5H', 4]]);
  assert.equal(pinPercent(missing), 4);
  assert.equal(pinPercent([{ label: '5H', usedPct: 4 }]), 4);
  const zero = [
    { label: '5H', usedPct: 40 },
    { label: '7D', usedPct: 0 },
  ];
  assert.deepEqual(pinBars(zero), [['7D', 0]]);
  assert.equal(pinPercent(zero), 0);
  assert.equal(pinPercent([]), null);
  const many = [
    { label: 'FLASH', usedPct: 80 },
    { label: 'PRO', usedPct: 90 },
    { label: '5H', usedPct: 4 },
    { label: '7D', usedPct: 12 },
  ];
  assert.deepEqual(pinBars(many), [['7D', 12]]);
  assert.equal(pinPercent(many), 12);
});

test('Grok usage is not borrowed by Muse Code or MiMo', () => {
  const grokOnly = usagePinEntries({
    rows: [
      { id: 'grok-oauth', group: 'oauth', authenticated: true, windows: [{ label: 'W', usedPct: 1 }] },
      { id: 'muse-code-oauth', group: 'oauth', authenticated: false, windows: [] },
      { id: 'mimo-oauth', group: 'oauth', authenticated: false, windows: [] },
    ],
  });
  assert.deepEqual(
    grokOnly.map((entry) => entry.provider),
    ['grok-oauth']
  );
  const muse = usagePinEntries({
    rows: [{ id: 'muse-code-oauth', group: 'oauth', authenticated: true, windows: [{ label: 'W', usedPct: 7 }] }],
  });
  assert.deepEqual(
    muse.map((entry) => [entry.provider, entry.percent]),
    [['muse-code-oauth', 7]]
  );
});

test('Grok, Muse Code and MiMo together each show their own quota', () => {
  const entries = usagePinEntries({
    rows: [
      { id: 'mimo-oauth', group: 'oauth', authenticated: true, windows: [{ label: 'W', usedPct: 30 }] },
      { id: 'muse-code-oauth', group: 'oauth', authenticated: true, windows: [{ label: 'W', usedPct: 20 }] },
      { id: 'grok-oauth', group: 'oauth', authenticated: true, windows: [{ label: 'W', usedPct: 10 }] },
    ],
  });
  assert.deepEqual(
    entries.map((entry) => [entry.key, entry.provider, entry.percent]),
    [
      ['grok', 'grok-oauth', 10],
      ['muse-code', 'muse-code-oauth', 20],
      ['mimo', 'mimo-oauth', 30],
    ]
  );
});

test('other providers retain their existing quota-window selection', () => {
  const entries = usagePinEntries({
    rows: [
      {
        id: 'openai-oauth',
        group: 'oauth',
        windows: [
          { label: '5H', usedPct: 90 },
          { label: '7D', usedPct: 20 },
        ],
      },
      {
        id: 'cursor-oauth',
        group: 'oauth',
        windows: [
          { label: 'Basic', usedPct: 10 },
          { label: 'API', usedPct: 50 },
        ],
      },
    ],
  });
  assert.deepEqual(
    entries.map(({ key, percent, bars }) => [key, percent, bars.map((bar) => bar.label)]),
    [
      ['codex', 20, ['7D']],
      ['cursor', 10, ['Basic']],
    ]
  );
});

async function renderUsage(t, windows, props = {}) {
  const now = Date.now;
  Date.now = () => NOW;
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><main></main></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['HTMLElement'],
    actEnvironment: false,
  });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    Date.now = now;
    await act(async () => root.unmount());
    dom.window.close();
  });
  publishUsageDashboard(dashboard(windows));
  const api = {
    async invokeCapability() {
      return { value: { selectedId: 'a', auto: true, accounts: [] } };
    },
  };
  await act(async () => root.render(React.createElement(SidebarUsage, { api, ...props })));
  return { root, api };
}

function meterRows() {
  return [...document.querySelectorAll('[data-usage-provider="antigravity"] .sidebar-usage-meter')].map((row) => [
    row.querySelector('small').textContent,
    row.querySelector('b').textContent,
    row.querySelector('em').textContent,
  ]);
}

test('the pin toggle lives in the ··· menu and keeps its toggle action', async (t) => {
  let toggles = 0;
  const props = {
    pinned: false,
    onTogglePin: () => {
      toggles++;
    },
  };
  const { root, api } = await renderUsage(t, [], props);
  assert.equal(document.querySelector('.sidebar-usage-pin'), null);
  const button = document.querySelector('.sidebar-usage-menu');
  assert.equal(button.getAttribute('aria-label'), 'Usage menu');
  await press(button);
  const item = document.querySelector('[role="menuitemcheckbox"]');
  assert.equal(item.getAttribute('aria-checked'), 'false');
  await press(item);
  assert.equal(toggles, 1);
  await act(async () => root.render(React.createElement(SidebarUsage, { api, ...props, pinned: true })));
  assert.equal(document.querySelector('[role="menuitemcheckbox"]').getAttribute('aria-checked'), 'true');
});

test('Antigravity meters show distinct server 5H and 7D usage and reset times', async (t) => {
  await renderUsage(t, [
    { label: '5H', usedPct: 4, resetAt: NOW + 4 * HOUR + 16 * 60_000, source: 'antigravity-quota' },
    { label: '7D', usedPct: 18, resetAt: NOW + 3 * DAY + 2 * HOUR, source: 'antigravity-quota' },
  ]);
  assert.deepEqual(meterRows(), [
    ['5H', '4%', 'Resets in 4h 16m'],
    ['7D', '18%', 'Resets in 3d 2h'],
  ]);
});

test('Antigravity meters never invent a missing weekly window', async (t) => {
  await renderUsage(t, [
    { label: '5H', usedPct: 4, resetAt: NOW + 4 * HOUR + 16 * 60_000, source: 'antigravity-quota' },
  ]);
  assert.deepEqual(meterRows(), [['5H', '4%', 'Resets in 4h 16m']]);
});

function connectedRowText() {
  const row = document.querySelector('[data-usage-provider="antigravity"]');
  return {
    state: row?.querySelector('.sidebar-usage-line small')?.textContent ?? null,
    meters: [...(row?.querySelectorAll('.sidebar-usage-meter-empty small') ?? [])].map((node) => node.textContent),
  };
}

test('a connected provider without quota windows reads as connected with no current window', async (t) => {
  await renderUsage(t, []);
  assert.deepEqual(connectedRowText(), { state: 'Connected', meters: ['No usage limits to show'] });
});

test('a connected provider still checking its quota shows only the usage loader', async (t) => {
  await renderUsage(t, [{ label: '5H', usedPct: 4 }]);
  // An account switch with no recorded usage keeps the provider and marks it checking.
  await act(async () => applyAccountUsageWindows('antigravity-oauth', []));
  assert.deepEqual(connectedRowText(), { state: null, meters: ['Loading usage…'] });
});

test('Antigravity meters keep reset presentation and never invent a weekly percentage', async (t) => {
  await renderUsage(t, [
    { label: '5H', usedPct: 100, resetAt: NOW - 1_000, source: 'antigravity-quota' },
    { label: '7D', usedPct: null, resetAt: NOW + 3 * DAY + 2 * HOUR, source: 'antigravity-quota' },
  ]);
  assert.deepEqual(meterRows(), [
    ['5H', '—', '—'],
    ['7D', '—', 'Resets in 3d 2h'],
  ]);
});
