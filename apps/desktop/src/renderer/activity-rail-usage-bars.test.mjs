import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityRail } from './ActivityRail.tsx';
import { installTestDom } from './test-support/test-dom.mjs';
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
    { id: 'opencode-go', authenticated: true, windows: [{ label: 'M', usedPct: 10 }] },
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
    usageApi: { async invokeCapability() { return { value: { selectedId: 'a', auto: true, accounts: [] } }; } },
    navigationItems: [],
    activeNavigationId: null,
    onSelectNavigation() {},
  };
  await act(async () => root.render(React.createElement(ActivityRail, props)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  return { root, props, stored };
}

const brand = (key) => document.querySelector(`[data-usage-pin="${key}"]`);
const meters = (key) => [...brand(key).querySelectorAll(':scope > i')];

test('the rail draws one bar per brand by default and saves the chosen two-bar mode in settings', async (t) => {
  const { root, props, stored } = await mountRail(t);
  assert.equal(meters('claude').length, 1);
  assert.equal(brand('claude').querySelector('small').textContent, '41%');

  await act(async () => document.querySelector('.sidebar-usage-toggle').dispatchEvent(
    new window.MouseEvent('click', { bubbles: true })
  ));
  const menuButton = document.querySelector('.sidebar-usage-menu');
  assert.ok(menuButton);
  await act(async () => menuButton.click());
  await act(async () =>
    document.querySelector('[role="menuitemradio"][data-rail-bars="short-long"]').click()
  );

  // Two stacked meters, short window first; one figure = the higher; the tone
  // colors only the bar that drives it.
  assert.equal(stored.usageRailShortLong, true);
  const claudeBars = meters('claude');
  assert.equal(claudeBars.length, 2);
  assert.deepEqual(
    claudeBars.map((bar) => bar.firstElementChild.style.width),
    ['99%', '41%']
  );
  assert.deepEqual(
    claudeBars.map((bar) => bar.classList.contains('is-cool')),
    [false, true]
  );
  assert.equal(brand('claude').className.includes('tone-danger'), true);
  assert.equal(brand('claude').querySelector('small').textContent, '99%');
  // A single-window provider never gets a placeholder bar.
  assert.equal(meters('opencode-go').length, 1);
  assert.match(brand('claude').getAttribute('data-tooltip'), /^Claude · 5-hour 99% · weekly 41%$/);

  // A fresh mount restores the stored mode.
  await act(async () => root.render(null));
  const host = document.body.appendChild(document.createElement('div'));
  const second = createRoot(host);
  await act(async () => second.render(React.createElement(ActivityRail, props)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.equal(meters('claude').length, 2);
  await act(async () => second.unmount());
});
