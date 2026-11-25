import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['history', 'navigator', 'Element', 'HTMLElement', 'Node', 'KeyboardEvent', 'MouseEvent'],
});

const { RowOverflowMenu } = await import('./RowOverflowMenu.tsx');

// Well past the hover delay, and the longest a "short" one may take.
const REST = 400;
const wait = (ms) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

const ROW = 32;
const MENU = { left: 100, right: 300, top: 100 };
const SUBMENU = { left: 304, right: 464, top: 128, bottom: 228 };

function rect({ left, right, top, bottom }) {
  return { left, right, top, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON() {} };
}

async function mountMenu(picked = []) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const leaf = (id, label) => ({ id, label, onSelect: () => picked.push(id) });
  const items = [
    leaf('open', 'Open'),
    { id: 'sections', label: 'Show sections', children: [leaf('bots', 'Bots'), leaf('recent', 'Recent')] },
    { id: 'sort', label: 'Sort', children: [leaf('by-name', 'By name'), leaf('by-date', 'By date')] },
    leaf('archive', 'Archive'),
  ];
  await act(async () => root.render(React.createElement(RowOverflowMenu, { label: 'Row', items })));
  const trigger = host.querySelector('.row-overflow-trigger');
  await act(async () => {
    trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // jsdom lays nothing out: the menu is one column of ROW-tall items, its
  // submenu a panel to the right of it.
  for (const [index, id] of items.map((item) => item.id).entries()) {
    const top = MENU.top + index * ROW;
    item(id).getBoundingClientRect = () => rect({ left: MENU.left, right: MENU.right, top, bottom: top + ROW });
  }
  return {
    trigger,
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const menus = () => [...document.querySelectorAll('.row-overflow-menu[role="menu"]')];
const item = (id) => menus()[0]?.querySelector(`[data-action-id="${id}"]`);
const submenu = () => {
  const panel = menus()[1] ?? null;
  if (panel) panel.getBoundingClientRect = () => rect(SUBMENU);
  return panel;
};
const submenuLabels = () =>
  [...(submenu()?.querySelectorAll('[role="menuitem"]') ?? [])].map((node) => node.textContent);
const expanded = (id) => item(id)?.getAttribute('aria-expanded');

function dispatchPointer(type, target, x, y, init = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, ...init });
  if (init.pointerType) Object.defineProperty(event, 'pointerType', { value: init.pointerType });
  target.dispatchEvent(event);
}

/** The pointer crosses from `from` (null: from outside the window) onto `to` at (x, y). */
const moveTo = (from, to, x, y, init = {}) =>
  act(async () => {
    if (from) dispatchPointer('pointerout', from, x, y, { relatedTarget: to, ...init });
    dispatchPointer('pointerover', to, x, y, { relatedTarget: from, ...init });
    dispatchPointer('pointermove', to, x, y, init);
  });
const moveWithin = (target, x, y) => act(async () => dispatchPointer('pointermove', target, x, y));
const press = (key) =>
  act(async () => {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    (document.activeElement || document.body).dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

test('resting on an item with a submenu opens it beside the menu after a short delay', async () => {
  const view = await mountMenu();
  try {
    assert.equal(expanded('sections'), 'false');
    await moveTo(null, item('sections'), 150, 140);
    assert.equal(expanded('sections'), 'false', 'a submenu opened the instant the pointer touched its item');
    assert.equal(submenu(), null);
    await wait(REST);
    assert.equal(expanded('sections'), 'true');
    assert.deepEqual(submenuLabels(), ['Bots', 'Recent']);
    assert.ok(item('open'), 'the submenu replaced the menu instead of opening beside it');
    assert.equal(submenu().getAttribute('aria-label'), 'Show sections menu');

    // Passing over an item without resting there opens nothing.
    await moveTo(item('sections'), item('open'), 150, 120);
    await moveTo(item('open'), item('sort'), 150, 170);
    await moveTo(item('sort'), item('archive'), 150, 200);
    await wait(REST);
    assert.equal(submenu(), null, 'resting on a plain sibling closes the submenu');
    assert.equal(expanded('sort'), 'false', 'a pass over Sort opened its submenu');
  } finally {
    await view.cleanup();
  }
});

test('moving diagonally toward the open submenu keeps it; resting on a sibling hands over or closes it', async () => {
  const view = await mountMenu();
  try {
    await moveTo(null, item('sections'), 150, 140);
    await wait(REST);
    assert.equal(expanded('sections'), 'true');
    submenu();

    // Leave Show sections through its bottom edge, heading down-right across Sort.
    await moveTo(item('sections'), item('sort'), 250, 165);
    await moveWithin(item('sort'), 270, 172);
    await wait(120);
    await moveWithin(item('sort'), 290, 180);
    await wait(120);
    assert.equal(expanded('sections'), 'true', 'crossing Sort on the way to the submenu switched to it');
    assert.equal(expanded('sort'), 'false');

    // Arriving in the submenu ends the trip: nothing switches behind it.
    const bots = submenu().querySelector('[data-action-id="bots"]');
    await moveTo(item('sort'), bots, 310, 140);
    await wait(REST);
    assert.equal(expanded('sections'), 'true');
    assert.deepEqual(submenuLabels(), ['Bots', 'Recent']);

    // Back over Sort and resting there: Sort's submenu takes over.
    await moveTo(bots, item('sort'), 250, 180);
    await wait(REST);
    assert.equal(expanded('sections'), 'false');
    assert.equal(expanded('sort'), 'true');
    assert.deepEqual(submenuLabels(), ['By name', 'By date']);

    // Leaving the menu altogether closes nothing.
    await moveTo(item('sort'), document.body, 600, 400);
    await wait(REST);
    assert.equal(expanded('sort'), 'true', 'leaving the menu closed the submenu');

    // Straight down onto a plain sibling (away from the submenu) closes it once the pointer rests.
    await moveTo(document.body, item('sort'), 200, 190);
    await moveTo(item('sort'), item('archive'), 200, 197);
    await moveWithin(item('archive'), 200, 215);
    assert.equal(expanded('sort'), 'true', 'closed with no delay');
    await wait(REST);
    assert.equal(submenu(), null);
    assert.equal(expanded('sort'), 'false');
  } finally {
    await view.cleanup();
  }
});

test('a touch passing over an item opens nothing; a tap or click opens its submenu at once', async () => {
  const picked = [];
  const view = await mountMenu(picked);
  try {
    await moveTo(null, item('sort'), 150, 170, { pointerType: 'touch' });
    await wait(REST);
    assert.equal(submenu(), null, 'a touch hover opened the submenu');
    await act(async () => dispatchPointer('click', item('sort'), 150, 170, { detail: 1 }));
    assert.equal(expanded('sort'), 'true');
    assert.notEqual(document.activeElement?.closest('[role="menu"]'), submenu(), 'a pointer open moved focus');
    await act(async () => submenu().querySelector('[data-action-id="by-date"]').click());
    assert.deepEqual(picked, ['by-date']);
    assert.equal(menus().length, 0, 'picking a submenu item closes the whole menu');
  } finally {
    await view.cleanup();
  }
});

test('ArrowRight or Enter opens a submenu on its first item; ArrowLeft and Escape return to the parent item', async () => {
  const view = await mountMenu();
  try {
    item('sections').focus();
    await press('ArrowRight');
    assert.equal(expanded('sections'), 'true');
    assert.equal(document.activeElement, submenu().querySelector('[data-action-id="bots"]'));
    await press('ArrowDown');
    assert.equal(document.activeElement, submenu().querySelector('[data-action-id="recent"]'));
    await press('ArrowLeft');
    assert.equal(submenu(), null);
    assert.equal(expanded('sections'), 'false');
    assert.equal(document.activeElement, item('sections'));

    // Enter and Space activate a button as a click without a pointer.
    item('sort').focus();
    await act(async () => item('sort').click());
    assert.equal(expanded('sort'), 'true');
    assert.equal(document.activeElement, submenu().querySelector('[data-action-id="by-name"]'));
    await press('Escape');
    assert.equal(submenu(), null, 'Escape left the submenu open');
    assert.ok(item('open'), 'Escape in the submenu closed the whole menu');
    assert.equal(document.activeElement, item('sort'));
    await press('Escape');
    assert.equal(menus().length, 0);
    assert.equal(document.activeElement, view.trigger);
  } finally {
    await view.cleanup();
  }
});

test('a hover still pending when the menu closes opens nothing in the menu reopened after it', async () => {
  const view = await mountMenu();
  try {
    await moveTo(null, item('sections'), 150, 140);
    await press('Escape');
    assert.equal(menus().length, 0);
    await act(async () => {
      view.trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(menus().length, 1, 'the menu reopened');
    await wait(REST);
    assert.equal(submenu(), null, 'the closed menu\u2019s hover opened a submenu in the new one');
    assert.equal(expanded('sections'), 'false');
  } finally {
    await view.cleanup();
  }
});

test('arrowing to another item closes a submenu the pointer opened', async () => {
  const view = await mountMenu();
  try {
    item('open').focus();
    await moveTo(null, item('sections'), 150, 140);
    await wait(REST);
    assert.equal(expanded('sections'), 'true');
    await press('ArrowDown');
    assert.equal(document.activeElement, item('sections'));
    assert.equal(expanded('sections'), 'true', 'focus reaching the open item closed its submenu');
    await press('ArrowDown');
    assert.equal(document.activeElement, item('sort'));
    assert.equal(submenu(), null);
  } finally {
    await view.cleanup();
  }
});
