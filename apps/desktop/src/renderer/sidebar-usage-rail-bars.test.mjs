import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { press } from './test-support/pointer-press.mjs';
import { installTestDom } from './test-support/test-dom.mjs';
import { SidebarUsage, usagePinEntries } from './SidebarUsage.tsx';
import { usagePinAccountEntries } from './usage-pin-entries.ts';
import { publishUsageDashboard } from './usage-dashboard-store.ts';
import { usagePinStackFits, usagePinStackHeight } from './rail-usage-pin-room.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const oauth = (id, windows) => ({ id, group: 'oauth', authenticated: true, windows });
const dashboardOf = (...rows) => ({ rows });
const claude = (windows) => dashboardOf(oauth('anthropic-oauth', windows));

test('short + long mode picks the shortest and the longest window, short first', () => {
  const windows = [
    { label: 'W', usedPct: 41, resetAt: NOW + 3 * DAY },
    { label: '5H', usedPct: 99, resetAt: NOW + HOUR },
    { label: 'M', usedPct: 5 },
  ];
  const [entry] = usagePinEntries(claude(windows), 'short-long');
  assert.deepEqual(
    entry.bars.map((bar) => [bar.label, bar.percent]),
    [
      ['5H', 99],
      ['M', 5],
    ]
  );
  assert.equal(entry.percent, 99);
  assert.equal(entry.hot, 0);
  // The default mode keeps the single longest-window bar.
  const [longOnly] = usagePinEntries(claude(windows));
  assert.deepEqual(
    longOnly.bars.map((bar) => bar.label),
    ['M']
  );
  // The figure follows every window, not only the drawn bars.
  assert.equal(longOnly.percent, 99);
});

test('the figure and the driving bar follow the higher of the two', () => {
  const [entry] = usagePinEntries(
    claude([
      { label: '5H', usedPct: 20 },
      { label: 'W', usedPct: 75 },
    ]),
    'short-long'
  );
  assert.equal(entry.percent, 75);
  assert.equal(entry.hot, 1);
});

test('the tooltip names every window, including ones that are not drawn', () => {
  const windows = [
    { label: '5H', usedPct: 10 },
    { label: 'W', usedPct: 95 },
    { label: 'M', usedPct: 20 },
  ];
  const [entry] = usagePinEntries(claude(windows), 'short-long');
  assert.equal(entry.percent, 95);
  assert.equal(entry.tooltip, 'Claude · 5-hour 10% · monthly 20% · weekly 95%');
});

test('a provider without a short window gets one bar and no placeholder', () => {
  for (const windows of [
    [{ label: 'M', usedPct: 30 }],
    [{ label: 'W', usedPct: 30 }],
    [{ label: 'FLASH', usedPct: 30 }],
  ]) {
    const [entry] = usagePinEntries(claude(windows), 'short-long');
    assert.equal(entry.bars.length, 1);
    assert.equal(entry.percent, 30);
  }
  // Equal-length windows are not a short/long pair.
  const [same] = usagePinEntries(
    claude([
      { label: 'W', usedPct: 30 },
      { label: '7D', usedPct: 60 },
    ]),
    'short-long'
  );
  assert.equal(same.bars.length, 1);
});

test('daily counts as a short window under a weekly one', () => {
  const [entry] = usagePinEntries(
    claude([
      { label: 'W', usedPct: 10 },
      { label: 'DAILY', usedPct: 40 },
      { label: '12H', usedPct: 15 },
    ]),
    'short-long'
  );
  assert.deepEqual(
    entry.bars.map((bar) => bar.label),
    ['12H', 'W']
  );
});

test('Cursor keeps Basic as the long bar and API becomes the second bar', () => {
  const cursor = dashboardOf(
    oauth('cursor-oauth', [
      { label: 'Basic', usedPct: 0.2 },
      { label: 'API', usedPct: 70 },
    ])
  );
  const [entry] = usagePinEntries(cursor, 'short-long');
  assert.deepEqual(
    entry.bars.map((bar) => bar.label),
    ['Basic', 'API']
  );
  assert.equal(entry.percent, 70);
  assert.equal(entry.hot, 1);
  const [longOnly] = usagePinEntries(cursor, 'long');
  assert.deepEqual(
    longOnly.bars.map((bar) => bar.label),
    ['Basic']
  );
  assert.equal(longOnly.percent, 70);
});

test('account slots show the highest window of the account in both modes', () => {
  const [entry] = usagePinEntries(claude([{ label: 'W', usedPct: 1 }]));
  const pools = new Map([
    [
      'anthropic-oauth',
      {
        selectedId: 'a',
        auto: false,
        accounts: [
          {
            id: 'a',
            label: 'A',
            email: '',
            windows: [
              { label: 'Basic', usedPct: 0.2 },
              { label: 'API', usedPct: 70 },
            ],
          },
          {
            id: 'b',
            label: 'B',
            email: '',
            windows: [
              { label: '5H', usedPct: 80 },
              { label: 'W', usedPct: 10 },
            ],
          },
        ],
      },
    ],
  ]);
  for (const mode of ['long', 'short-long']) {
    const slots = usagePinAccountEntries([entry], pools, mode);
    assert.deepEqual(
      slots.map((slot) => slot.percent),
      [70, 80]
    );
  }
});

test('the rail defaults to the longest period only without a stored choice', async (t) => {
  installTestDom(t, { expose: ['HTMLElement', 'Node'], rootId: 'root' });
  const { readRailPrefs } = await import('./use-usage-rail-pin.ts');
  assert.equal(readRailPrefs().bars, 'long');
  window.localStorage.setItem('mixdog.desktop.usage-rail-prefs.v2', JSON.stringify({ bars: 'short-long' }));
  assert.equal(readRailPrefs().bars, 'short-long');
});

test('the tooltip names the provider and both windows with percent and reset time', () => {
  const now = Date.now;
  Date.now = () => NOW;
  try {
    const [entry] = usagePinEntries(
      claude([
        { label: '5H', usedPct: 99, resetAt: NOW + HOUR + 12 * 60_000 },
        { label: 'W', usedPct: 41 },
      ]),
      'short-long'
    );
    assert.equal(entry.tooltip, 'Claude · 5-hour 99% (resets in 1h 12m) · weekly 41%');
    // Long-only mode still describes both windows on hover.
    const [longOnly] = usagePinEntries(
      claude([
        { label: '5H', usedPct: 99, resetAt: NOW + HOUR + 12 * 60_000 },
        { label: 'W', usedPct: 41 },
      ])
    );
    assert.equal(longOnly.tooltip, entry.tooltip);
  } finally {
    Date.now = now;
  }
});

test('the taller two-bar stack counts toward rail room', () => {
  assert.equal(usagePinStackHeight(3, 2), usagePinStackHeight(3) + 10);
  const base = { navHeight: 400, settingsHeight: 44, rowCount: 3 };
  const railHeight = 400 + 44 + usagePinStackHeight(3);
  assert.equal(usagePinStackFits({ ...base, railHeight }), true);
  assert.equal(usagePinStackFits({ ...base, railHeight, doubleBarCount: 3 }), false);
});

function mount(
  t,
  windows = [
    { label: '5H', usedPct: 99 },
    { label: 'W', usedPct: 41 },
  ]
) {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node'], rootId: 'root' });
  publishUsageDashboard(claude(windows));
  const api = {
    async invokeCapability() {
      return { value: { selectedId: 'a', auto: true, accounts: [] } };
    },
  };
  const state = { pinned: true, railBars: 'long', toggles: 0, changes: [] };
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(SidebarUsage, {
          api,
          pinned: state.pinned,
          railBars: state.railBars,
          onTogglePin: () => {
            state.toggles += 1;
          },
          onRailBarsChange: (next) => state.changes.push(next),
        })
      )
    );
  return { state, render };
}

const trigger = () => document.querySelector('.sidebar-usage-menu');
const menu = () => document.querySelector('[role="menu"]');
const radios = () => [...document.querySelectorAll('[role="menuitemradio"][data-rail-bars]')];

test('the ··· menu replaces the pin button and opens, closes on Escape and returns focus', async (t) => {
  const { render } = mount(t);
  await render();
  assert.equal(document.querySelector('.sidebar-usage-pin'), null);
  assert.equal(trigger().getAttribute('aria-label'), 'Usage menu');
  assert.equal(trigger().getAttribute('aria-expanded'), 'false');
  await press(trigger());
  assert.equal(trigger().getAttribute('aria-expanded'), 'true');
  assert.ok(menu());
  assert.equal(document.activeElement.getAttribute('role'), 'menuitemcheckbox');
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(menu(), null);
  assert.equal(document.activeElement, trigger());
  await press(trigger());
  await act(async () => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(menu(), null);
});

test('arrow keys rove through the enabled items', async (t) => {
  const { render } = mount(t);
  await render();
  await press(trigger());
  const keys = (key) =>
    act(async () => menu().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true })));
  const items = [...document.querySelectorAll('[role^="menuitem"]')];
  // Pin, Expand all accounts, two bar modes, three slot counts.
  assert.equal(items.length, 7);
  assert.equal(document.activeElement, items[0]);
  await keys('ArrowDown');
  assert.equal(document.activeElement, items[1]);
  await keys('End');
  assert.equal(document.activeElement, items[6]);
  await keys('ArrowDown');
  assert.equal(document.activeElement, items[0]);
  await keys('ArrowUp');
  assert.equal(document.activeElement, items[6]);
  await keys('Home');
  assert.equal(document.activeElement, items[0]);
});

test('the pin item toggles the rail pin and the radios apply the bar mode', async (t) => {
  const { state, render } = mount(t);
  await render();
  await press(trigger());
  const pin = document.querySelector('[role="menuitemcheckbox"]');
  assert.equal(pin.getAttribute('aria-checked'), 'true');
  assert.equal(pin.textContent, 'Pin to rail');
  assert.equal(pin.querySelector('svg') !== null, true, 'the checked pin shows a check mark');
  await press(pin);
  assert.equal(state.toggles, 1);
  assert.equal(menu().getAttribute('aria-label'), 'Usage menu');
  assert.deepEqual(
    radios().map((radio) => [radio.textContent, radio.getAttribute('aria-checked')]),
    [
      ['Longest period only', 'true'],
      ['5-hour + longest period', 'false'],
    ]
  );
  assert.deepEqual(
    radios().map((radio) => radio.getAttribute('data-tooltip')),
    ['Only the longest period, such as monthly or weekly', '5-hour and weekly as two bars; the number shows the higher']
  );
  assert.equal(document.querySelector('.usage-menu-hint'), null);
  assert.equal(radios()[0].querySelector('svg') !== null, true);
  assert.equal(radios()[1].querySelector('svg'), null);
  await press(radios()[1]);
  assert.deepEqual(state.changes, ['short-long']);
  state.railBars = 'short-long';
  await render();
  assert.deepEqual(
    radios().map((radio) => radio.getAttribute('aria-checked')),
    ['false', 'true']
  );
});

test('the bar radios are disabled while the rail pin is off', async (t) => {
  const { state, render } = mount(t);
  state.pinned = false;
  await render();
  await press(trigger());
  assert.equal(document.querySelector('[role="menuitemcheckbox"]').getAttribute('aria-checked'), 'false');
  assert.ok(radios().every((radio) => radio.disabled));
  await press(radios()[1]);
  assert.deepEqual(state.changes, []);
  // Disabled radios are skipped by keyboard roving.
  // Only Pin to rail and Expand all accounts stay enabled.
  assert.equal(document.querySelectorAll('[role^="menuitem"]:not(:disabled)').length, 2);
});
