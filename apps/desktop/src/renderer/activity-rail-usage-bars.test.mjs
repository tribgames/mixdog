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

async function mountRail(t, { shortLong = false, usage = dashboard } = {}) {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  // jsdom has no layout: give the rail room for the pinned stack.
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 2000 });
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const stored = { usagePinned: true, usageRailShortLong: shortLong };
  window.mixdogDesktop = {
    readActivityRailPins: async () => null,
    subscribeActivityRailPins: () => () => {},
    readSettings: async () => ({ ...stored }),
    updateSetting: async (key, value) => {
      stored[key] = value;
      return { ...stored };
    },
  };
  publishUsageDashboard(usage);
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
  await waitFor(() => document.querySelector('[data-usage-pin]'));
  return { root, props, stored };
}

const brand = (key) => document.querySelector(`[data-usage-pin="${key}"]`);
const tracks = (key) => [...brand(key).querySelectorAll('.rail-usage-pin-track')];
// Each drawn ring's arc as [class, dash], outer ring first.
const arcs = (key) =>
  [...brand(key).querySelectorAll('.rail-usage-pin-fill')].map((arc) => [
    arc.getAttribute('class'),
    arc.getAttribute('stroke-dasharray'),
  ]);

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

test('the usage flyout closes on Escape and on a press outside it, not on a press inside it', async (t) => {
  await mountRail(t);
  const popup = () => document.querySelector('.rail-usage-popup');
  const pointerdown = (target) =>
    act(async () => {
      target.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    });

  const menu = await openFlyout();
  await pointerdown(menu);
  assert.ok(popup(), 'a press inside the flyout keeps it open');
  await pointerdown(document.body);
  assert.equal(popup(), null, 'a press outside closes it');

  await openFlyout();
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  assert.equal(popup(), null, 'Escape closes it');
});

test('the rail draws one ring per brand by default and saves the chosen two-ring mode in settings', async (t) => {
  const { root, props, stored } = await mountRail(t);
  // One ring for the long window, no figure under it; the values live in the
  // tooltip and in the Usage button's description, slot by slot, which names
  // every window the tooltip does, drawn or not.
  assert.deepEqual(arcs('claude'), [['rail-usage-pin-fill', '41 100']]);
  assert.equal(brand('claude').querySelector('small'), null);
  assert.equal(brand('claude').getAttribute('role'), null);
  const toggle = () => document.querySelector('.sidebar-usage-toggle');
  assert.equal(toggle().getAttribute('aria-label'), 'Usage');
  assert.equal(
    toggle().getAttribute('aria-description'),
    'Claude · 5-hour 99% · weekly 41%; OpenCode Go OAuth · monthly 10%'
  );
  assert.equal(brand('claude').querySelector('.rail-usage-pin-ring.is-nested'), null);

  await press(await openFlyout());
  await press(document.querySelector('[role="menuitemradio"][data-rail-bars="short-long"]'));
  assert.ok(document.querySelector('.usage-menu'), 'the menu survives its own press');
  await waitFor(() => stored.usageRailShortLong === true);

  // Two concentric rings, the short window outside.
  await waitFor(() => tracks('claude').length === 2);
  assert.deepEqual(arcs('claude'), [
    ['rail-usage-pin-fill tone-danger', '99 100'],
    ['rail-usage-pin-fill', '41 100'],
  ]);
  assert.ok(brand('claude').querySelector('.rail-usage-pin-ring.is-nested'));
  // The arc is the reading: the track under it is thinner.
  for (const track of tracks('claude')) {
    const arc = track.parentElement.querySelector('.rail-usage-pin-fill');
    assert.ok(Number(track.getAttribute('stroke-width')) < Number(arc.getAttribute('stroke-width')));
  }
  assert.equal(
    toggle().getAttribute('aria-description'),
    'Claude · 5-hour 99% · weekly 41%; OpenCode Go OAuth · monthly 10%'
  );
  // A single-window provider never gets a placeholder ring.
  assert.equal(tracks('opencode-go-oauth').length, 1);
  assert.match(brand('claude').getAttribute('data-tooltip'), /^Claude · 5-hour 99% · weekly 41%$/);

  // A fresh mount restores the stored mode.
  await act(async () => root.render(null));
  const host = document.body.appendChild(document.createElement('div'));
  const second = createRoot(host);
  await act(async () => second.render(React.createElement(ActivityRail, props)));
  await waitFor(() => brand('claude') && tracks('claude').length === 2);
  await act(async () => second.unmount());
});

test('a two-window provider draws two rings, each in the tone of its own window', async (t) => {
  await mountRail(t, {
    shortLong: true,
    usage: {
      rows: [
        {
          id: 'openai-oauth',
          group: 'oauth',
          windows: [
            { label: '5H', usedPct: 75 },
            { label: 'W', usedPct: 95 },
          ],
        },
        { id: 'anthropic-oauth', group: 'oauth', windows: [{ label: 'W', usedPct: 0 }] },
      ],
    },
  });
  await waitFor(() => brand('codex') && tracks('codex').length === 2);
  assert.deepEqual(arcs('codex'), [
    ['rail-usage-pin-fill tone-warning', '75 100'],
    ['rail-usage-pin-fill tone-danger', '95 100'],
  ]);
  // 0% is a solid empty track: no arc, not busy.
  assert.equal(tracks('claude').length, 1);
  assert.deepEqual(arcs('claude'), []);
  assert.equal(brand('claude').getAttribute('aria-busy'), null);
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
