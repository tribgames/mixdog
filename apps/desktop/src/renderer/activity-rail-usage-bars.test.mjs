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

async function mountRail(t, { shortLong = false, usage = dashboard, roster } = {}) {
  const { root } = installTestDom(t, { expose: ['HTMLElement', 'Node', 'Element'], rootId: 'root' });
  if (roster) window.localStorage.setItem('mixdog.desktop.usage-rail-roster.v1', JSON.stringify(roster));
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
  if (usage) publishUsageDashboard(usage);
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
const width = (rect) => Number(rect.getAttribute('width'));
// Each drawn bar's fill as [class, percent of its track], top bar first.
const fills = (key) =>
  [...brand(key).querySelectorAll('.rail-usage-pin-fill')].map((fill) => [
    fill.getAttribute('class'),
    Math.round((1e4 * width(fill)) / width(fill.parentElement.querySelector('.rail-usage-pin-track'))) / 100,
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

test('the rail draws one bar per brand by default and saves the chosen two-bar mode in settings', async (t) => {
  const { root, props, stored } = await mountRail(t);
  // One bar for the long window under the mark, then that window's figure; every
  // window's value lives in the tooltip and in the Usage button's description,
  // slot by slot, which names every window the tooltip does, drawn or not.
  assert.deepEqual(fills('claude'), [['rail-usage-pin-fill', 41]]);
  const meter = brand('claude').querySelector('.rail-usage-pin-meter');
  assert.equal(meter.previousElementSibling, brand('claude').querySelector('.rail-usage-pin-mark'));
  assert.ok(meter.previousElementSibling.querySelector('svg[data-provider-icon]'));
  assert.equal(brand('claude').querySelector('circle'), null);
  const figure = () => brand('claude').querySelector('.rail-usage-pin-figure');
  assert.equal(figure().textContent, '41%');
  assert.equal(figure().previousElementSibling, meter);
  assert.equal(figure().getAttribute('aria-hidden'), 'true', 'the button’s description already reads it');
  assert.equal(brand('claude').getAttribute('role'), null);
  const toggle = () => document.querySelector('.sidebar-usage-toggle');
  assert.equal(toggle().getAttribute('aria-label'), 'Usage');
  assert.equal(
    toggle().getAttribute('aria-description'),
    'Claude · 5-hour 99% · weekly 41%; OpenCode Go OAuth · monthly 10%'
  );

  await press(await openFlyout());
  await press(document.querySelector('[role="menuitemradio"][data-rail-bars="short-long"]'));
  assert.ok(document.querySelector('.usage-menu'), 'the menu survives its own press');
  await waitFor(() => stored.usageRailShortLong === true);

  // Two stacked bars, the short window on top.
  await waitFor(() => tracks('claude').length === 2);
  assert.deepEqual(fills('claude'), [
    ['rail-usage-pin-fill tone-danger', 99],
    ['rail-usage-pin-fill', 41],
  ]);
  assert.deepEqual(
    [...brand('claude').querySelectorAll('[data-usage-window]')].map((bar) => bar.getAttribute('data-usage-window')),
    ['5H', 'W']
  );
  assert.equal(figure().textContent, '99%', 'two bars: the figure is the highest window');
  const [top, bottom] = tracks('claude').map((track) => Number(track.getAttribute('y')));
  assert.ok(top < bottom);
  // Each capsule runs under its fill on the same band, the fill clipped to it.
  for (const track of tracks('claude')) {
    const fill = track.parentElement.querySelector('.rail-usage-pin-fill');
    for (const attribute of ['y', 'height']) {
      assert.equal(track.getAttribute(attribute), fill.getAttribute(attribute));
    }
    const clip = fill.getAttribute('clip-path').match(/^url\(#(.+)\)$/)[1];
    const capsule = track.parentElement.querySelector('clipPath').firstElementChild;
    assert.equal(track.parentElement.querySelector('clipPath').id, clip);
    for (const attribute of ['x', 'y', 'width', 'height', 'rx']) {
      assert.equal(capsule.getAttribute(attribute), track.getAttribute(attribute));
    }
  }
  const clips = [...document.querySelectorAll('.rail-usage-pin-meter clipPath')].map((clip) => clip.id);
  assert.equal(new Set(clips).size, clips.length, 'every capsule clip id is unique');
  assert.equal(
    toggle().getAttribute('aria-description'),
    'Claude · 5-hour 99% · weekly 41%; OpenCode Go OAuth · monthly 10%'
  );
  // A single-window provider never gets a placeholder bar.
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

test('a two-window provider draws two bars, each in the tone of its own window', async (t) => {
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
  assert.deepEqual(fills('codex'), [
    ['rail-usage-pin-fill tone-warning', 75],
    ['rail-usage-pin-fill tone-danger', 95],
  ]);
  // 0% is a solid empty track: no fill, not busy.
  assert.equal(tracks('claude').length, 1);
  assert.deepEqual(fills('claude'), []);
  assert.equal(brand('claude').getAttribute('aria-busy'), null);
});

test('a slot still loading draws a dashed line per window instead of a capsule', async (t) => {
  await mountRail(t, { shortLong: true, usage: null, roster: [{ key: 'claude', bars: 2 }] });
  assert.equal(brand('claude').getAttribute('aria-busy'), 'true');
  assert.deepEqual(
    tracks('claude').map((track) => [track.tagName.toLowerCase(), track.getAttribute('y1'), track.getAttribute('stroke-width')]),
    [
      ['line', '1', '2'],
      ['line', '4', '2'],
    ]
  );
  assert.deepEqual(fills('claude'), []);
  assert.equal(brand('claude').querySelector('.rail-usage-pin-figure'), null, 'no figure before the quota is read');
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
