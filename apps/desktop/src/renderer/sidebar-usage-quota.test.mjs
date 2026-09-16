import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { SidebarUsage, usagePinEntries } from './SidebarUsage.tsx';
import { publishUsageDashboard } from './usage-dashboard-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const dashboard = (windows) => ({ rows: [{ id: 'antigravity-oauth', group: 'oauth', authenticated: true, windows }] });

const pinPercent = (windows) => usagePinEntries(dashboard(windows))[0]?.percent ?? null;

test('Antigravity pins weekly 7D usage like other providers, independent of window order', () => {
  const windows = [
    { label: '5H', usedPct: 90, resetAt: NOW + 4 * HOUR, source: 'antigravity-quota' },
    { label: '7D', usedPct: 20, resetAt: NOW + 3 * DAY, source: 'antigravity-quota' },
  ];
  assert.equal(pinPercent(windows), 20);
  assert.equal(pinPercent([...windows].reverse()), 20);
});

test('exhausted weekly usage is pinned; missing weekly data is never invented; known zero stays visible', () => {
  assert.equal(
    pinPercent([
      { label: '5H', usedPct: 4, resetAt: NOW + HOUR },
      { label: '7D', usedPct: 100, resetAt: NOW + DAY },
    ]),
    100
  );
  assert.equal(
    pinPercent([
      { label: '5H', usedPct: 4 },
      { label: '7D', usedPct: null },
    ]),
    4
  );
  assert.equal(pinPercent([{ label: '5H', usedPct: 4 }]), 4);
  assert.equal(
    pinPercent([
      { label: '5H', usedPct: 40 },
      { label: '7D', usedPct: 0 },
    ]),
    0
  );
  assert.equal(pinPercent([]), null);
  assert.equal(
    pinPercent([
      { label: 'FLASH', usedPct: 80 },
      { label: 'PRO', usedPct: 90 },
      { label: '5H', usedPct: 4 },
      { label: '7D', usedPct: 12 },
    ]),
    12
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
    entries.map(({ key, percent }) => [key, percent]),
    [
      ['codex', 20],
      ['cursor', 10],
    ]
  );
});

function renderUsage(t, windows) {
  const now = Date.now;
  Date.now = () => NOW;
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', { url: 'https://mixdog.test/' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
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
  return act(async () => root.render(React.createElement(SidebarUsage, { api })));
}

function meterRows() {
  return [...document.querySelectorAll('[data-usage-provider="antigravity"] .sidebar-usage-meter')].map((row) => [
    row.querySelector('small').textContent,
    row.querySelector('b').textContent,
    row.querySelector('em').textContent,
  ]);
}

test('Antigravity meters show distinct server 5H and 7D usage and reset times', async (t) => {
  await renderUsage(t, [
    { label: '5H', usedPct: 4, resetAt: NOW + 4 * HOUR + 16 * 60_000, source: 'antigravity-quota' },
    { label: '7D', usedPct: 18, resetAt: NOW + 3 * DAY + 2 * HOUR, source: 'antigravity-quota' },
  ]);
  assert.deepEqual(meterRows(), [
    ['5H', '4%', '4h 16m'],
    ['7D', '18%', '3d 2h'],
  ]);
});

test('Antigravity meters never invent a missing weekly window', async (t) => {
  await renderUsage(t, [
    { label: '5H', usedPct: 4, resetAt: NOW + 4 * HOUR + 16 * 60_000, source: 'antigravity-quota' },
  ]);
  assert.deepEqual(meterRows(), [['5H', '4%', '4h 16m']]);
});

test('Antigravity meters keep reset presentation and never invent a weekly percentage', async (t) => {
  await renderUsage(t, [
    { label: '5H', usedPct: 100, resetAt: NOW - 1_000, source: 'antigravity-quota' },
    { label: '7D', usedPct: null, resetAt: NOW + 3 * DAY + 2 * HOUR, source: 'antigravity-quota' },
  ]);
  assert.deepEqual(meterRows(), [
    ['5H', '—', '—'],
    ['7D', '—', '3d 2h'],
  ]);
});
