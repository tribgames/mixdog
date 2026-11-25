import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ScmContextMenu } from './ScmContextMenu.tsx';
import { installTestDom } from './test-support/test-dom.mjs';

const ROW_HEIGHT = 30;
const VIEWPORT = { width: 800, height: 600 };

async function mountScmMenu(t) {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div><div id="transcript"></div><div id="sidebar"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  const root = createRoot(document.getElementById('root'));
  t.after(async () => {
    await act(async () => root.unmount());
    restore();
  });
  const state = {
    label: 'Row actions',
    x: 40,
    y: 40,
    items: ['open', 'rename', 'delete'].map((id) => ({ id, label: id, onSelect() {} })),
  };
  const menu = { closes: 0 };
  // The owning pane passes a fresh `() => setMenu(null)` on every render.
  const render = () =>
    act(async () => {
      root.render(React.createElement(ScmContextMenu, { state, onClose: () => (menu.closes += 1) }));
      await Promise.resolve();
    });
  const item = (id) => document.querySelector(`[data-action-id="${id}"]`);
  await render();
  item('rename').focus();
  return { menu, render, item };
}

test('an open menu outlives the live updates of an agent turn', async (t) => {
  const { menu, render, item } = await mountScmMenu(t);
  // A streamed token re-renders the pane, pins the transcript to its end and
  // keeps the sidebar rows in place on a re-sort: all programmatic scrolls.
  await render();
  await act(async () => {
    document.getElementById('transcript').dispatchEvent(new window.Event('scroll'));
    document.getElementById('sidebar').dispatchEvent(new window.Event('scroll'));
    await Promise.resolve();
  });
  assert.equal(menu.closes, 0, 'a live update closed the menu');
  assert.equal(document.activeElement, item('rename'), 'a live re-render moved focus off the chosen item');
});

test('the arrow keys and the wheel over the menu itself neither close it nor lose focus navigation', async (t) => {
  const { menu, item } = await mountScmMenu(t);
  await act(async () =>
    item('rename').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  );
  assert.equal(document.activeElement, item('delete'), 'arrow navigation inside the menu');
  assert.equal(menu.closes, 0, "the menu's own arrow key closed it");
  await act(async () => item('rename').dispatchEvent(new window.WheelEvent('wheel', { bubbles: true })));
  assert.equal(menu.closes, 0, 'a wheel over the menu itself closed it');
});

test('a user wheel outside the menu closes it', async (t) => {
  const { menu } = await mountScmMenu(t);
  await act(async () =>
    document.getElementById('sidebar').dispatchEvent(new window.WheelEvent('wheel', { bubbles: true }))
  );
  assert.equal(menu.closes, 1, 'a user scroll outside the menu leaves it open');
});

test('a submenu opens beside its item, flipping left at the right edge and moving up at the bottom', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'KeyboardEvent'],
  });
  const proto = window.HTMLElement.prototype;
  const original = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    offsetHeight: Object.getOwnPropertyDescriptor(proto, 'offsetHeight'),
    offsetWidth: Object.getOwnPropertyDescriptor(proto, 'offsetWidth'),
    innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
    innerWidth: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
  };
  // jsdom does no layout: a menu is one fixed-width column of ROW_HEIGHT rows.
  const menuHeight = (node) =>
    node.getAttribute('role') === 'menu' ? node.querySelectorAll('button').length * ROW_HEIGHT : 0;
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get() {
      return menuHeight(this);
    },
  });
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get() {
      return menuHeight(this);
    },
  });
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  const root = createRoot(document.getElementById('root'));
  const leaf = (id) => ({ id, label: id, onSelect() {} });
  const menus = () => [...document.querySelectorAll('[role="menu"]')];
  const box = (left, top, height) => ({ left, top, right: left + 200, bottom: top + height, width: 200, height });
  const render = (x, y) => {
    const state = {
      label: 'Row actions',
      x,
      y,
      items: [
        leaf('open'),
        { id: 'move', label: 'Move to project', children: Array.from({ length: 8 }, (_, i) => leaf(`project-${i}`)) },
      ],
    };
    return act(async () => root.render(React.createElement(ScmContextMenu, { state, onClose() {} })));
  };
  // Opens Move to project from the keyboard with the menu standing at (x, y).
  const openSubmenu = async (x, y) => {
    await render(x, y);
    const [menu] = menus();
    menu.getBoundingClientRect = () => box(x, y, 2 * ROW_HEIGHT);
    const move = menu.querySelector('[data-action-id="move"]');
    move.getBoundingClientRect = () => box(x, y + ROW_HEIGHT, ROW_HEIGHT);
    move.focus();
    await act(async () =>
      move.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    );
    assert.equal(menus().length, 2, 'the submenu opens beside the menu');
    return { menu, submenu: menus()[1] };
  };
  const at = (node) => [Number.parseFloat(node.style.left), Number.parseFloat(node.style.top)];
  try {
    let { menu, submenu } = await openSubmenu(100, 100);
    assert.deepEqual(at(submenu), [304, 130], 'right of the menu, level with its item');
    assert.equal(submenu.querySelectorAll('button').length, 8, 'the submenu holds only its own items');

    await act(async () => root.render(null));
    ({ menu, submenu } = await openSubmenu(560, 500));
    assert.deepEqual(at(menu), [560, 500], 'the menu itself stays at the pointer');
    assert.deepEqual(at(submenu), [356, VIEWPORT.height - 8 - 8 * ROW_HEIGHT], 'flipped left, moved up to fit');
  } finally {
    await act(async () => root.unmount());
    for (const [target, key] of [
      [proto, 'scrollHeight'],
      [proto, 'offsetHeight'],
      [proto, 'offsetWidth'],
      [window, 'innerHeight'],
      [window, 'innerWidth'],
    ]) {
      if (original[key]) Object.defineProperty(target, key, original[key]);
      else delete target[key];
    }
    restore();
  }
});
