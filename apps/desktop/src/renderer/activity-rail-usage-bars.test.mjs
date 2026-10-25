import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityRail } from './ActivityRail.tsx';
import { press } from './test-support/pointer-press.mjs';
import { installTestDom } from './test-support/test-dom.mjs';
import { waitFor } from './test-support/wait-for.mjs';
import { publishUsageDashboard } from './usage-dashboard-store.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const dashboard = {
  rows: [
    {
      id: 'anthropic-oauth',
      group: 'oauth',
      authenticated: true,
      windows: [
        { label: '5H', usedPct: 99 },
        { label: 'W', usedPct: 41 },
      ],
    },
    { id: 'opencode-go-oauth', authenticated: true, windows: [{ label: 'M', usedPct: 10 }] },
  ],
};

async function mountRail(t) {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  // jsdom has no layout: give the rail room for the pinned stack.
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 2000 });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const stored = { usagePinned: true, usageRailShortLong: false };
  window.mixdogDesktop = {
    readActivityRailPins: async () => null,
    subscribeActivityRailPins: () => () => {},
    readSettings: async () => ({ ...stored }),
    updateSetting: async (key, value) => {
      stored[key] = value;
      return { ...stored };
    },
  };
  publishUsageDashboard(dashboard);
  const props = {
    settingsOpen: false,
    onOpenSettings() {},
    usageApi: {
      async invokeCapability() {
        return { value: { selectedId: 'a', auto: true, accounts: [] } };
      },
    },
    navigationItems: [],
    activeNavigationId: null,
    onSelectNavigation() {},
  };
  await act(async () => root.render(React.createElement(ActivityRail, props)));
  await waitFor(() => document.querySelector('[data-usage-pin="claude"]'));
  return { root, props, stored };
}

const brand = (key) => document.querySelector(`[data-usage-pin="${key}"]`);
const meters = (key) => [...brand(key).querySelectorAll(':scope > i')];

// The flyout body loads asynchronously: open it and wait for its menu.
async function openFlyout() {
  await press(document.querySelector('.sidebar-usage-toggle'));
  await waitFor(() => document.querySelector('.sidebar-usage-menu'));
  return document.querySelector('.sidebar-usage-menu');
}

// The module may already be loaded when the press settles (a fast runner, or
// another test warmed it): until the menu exists the placeholder must hold its
// place, and it is gone once the menu is up.
test('a flyout opened before its module is ready shows the loading placeholder until the menu', async (t) => {
  await mountRail(t);
  await press(document.querySelector('.sidebar-usage-toggle'));
  if (!document.querySelector('.sidebar-usage-menu')) {
    assert.ok(document.querySelector('.initial-surface[aria-busy="true"]'), 'placeholder while loading');
  }
  await waitFor(() => document.querySelector('.sidebar-usage-menu'));
  assert.equal(document.querySelector('.initial-surface[aria-busy="true"]'), null);
});

test('the rail draws one bar per brand by default and saves the chosen two-bar mode in settings', async (t) => {
  const { root, props, stored } = await mountRail(t);
  assert.equal(meters('claude').length, 1);
  assert.equal(brand('claude').querySelector('small').textContent, '99%');
  assert.ok(meters('claude')[0].classList.contains('is-thick'));

  await press(await openFlyout());
  await press(document.querySelector('[role="menuitemradio"][data-rail-bars="short-long"]'));
  assert.ok(document.querySelector('.usage-menu'), 'the menu survives its own press');
  await waitFor(() => stored.usageRailShortLong === true);

  // Two stacked meters, short window first; one figure = the higher; the tone
  // colors only the bar that drives it.
  const claudeBars = meters('claude');
  assert.equal(claudeBars.length, 2);
  assert.deepEqual(
    claudeBars.map((bar) => bar.firstElementChild.style.width),
    ['99%', '41%']
  );
  assert.deepEqual(
    claudeBars.map((bar) => [bar.classList.contains('is-thick'), bar.classList.contains('tone-danger')]),
    [
      [true, true],
      [false, false],
    ]
  );
  assert.ok(brand('claude').className.includes('tone-danger'));
  assert.equal(brand('claude').querySelector('small').textContent, '99%');
  // A single-window provider never gets a placeholder bar.
  assert.equal(meters('opencode-go-oauth').length, 1);
  assert.match(brand('claude').getAttribute('data-tooltip'), /^Claude · 5-hour 99% · weekly 41%$/);

  // A fresh mount restores the stored mode.
  await act(async () => root.render(null));
  const host = document.body.appendChild(document.createElement('div'));
  const second = createRoot(host);
  await act(async () => second.render(React.createElement(ActivityRail, props)));
  await waitFor(() => brand('claude') && meters('claude').length === 2);
  await act(async () => second.unmount());
});

test('the pin switch in the portaled menu survives a real pointer press and saves the pin', async (t) => {
  const { stored } = await mountRail(t);
  await press(await openFlyout());
  await waitFor(() => document.querySelector('[role="menuitemcheckbox"]'));
  await press(document.querySelector('[role="menuitemcheckbox"]'));
  assert.ok(document.querySelector('.usage-menu'), 'the menu survives its own press');
  await waitFor(() => stored.usagePinned === false);
  await waitFor(() => document.querySelector('[role="menuitemradio"]').disabled);
});
