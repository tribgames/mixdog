import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ScmContextMenu } from './ScmContextMenu.tsx';
import { installTestDom } from './test-support/test-dom.mjs';

const ROW_HEIGHT = 30;
const VIEWPORT = { width: 800, height: 600 };

test('an open menu outlives the live updates of an agent turn; a user wheel outside still closes it', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div><div id="transcript"></div><div id="sidebar"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  const root = createRoot(document.getElementById('root'));
  const state = {
    label: 'Row actions',
    x: 40,
    y: 40,
    items: ['open', 'rename', 'delete'].map((id) => ({ id, label: id, onSelect() {} })),
  };
  let closes = 0;
  // The owning pane passes a fresh `() => setMenu(null)` on every render.
  const render = () =>
    act(async () => {
      root.render(React.createElement(ScmContextMenu, { state, onClose: () => (closes += 1) }));
      await Promise.resolve();
    });
  const item = (id) => document.querySelector(`[data-action-id="${id}"]`);
  try {
    await render();
    item('rename').focus();
    // A streamed token re-renders the pane, pins the transcript to its end and
    // keeps the sidebar rows in place on a re-sort: all programmatic scrolls.
    await render();
    await act(async () => {
      document.getElementById('transcript').dispatchEvent(new window.Event('scroll'));
      document.getElementById('sidebar').dispatchEvent(new window.Event('scroll'));
      await Promise.resolve();
    });
    assert.equal(closes, 0, 'a live update closed the menu');
    assert.equal(document.activeElement, item('rename'), 'a live re-render moved focus off the chosen item');
    await act(async () =>
      item('rename').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    assert.equal(document.activeElement, item('delete'), 'arrow navigation inside the menu');
    assert.equal(closes, 0, "the menu's own arrow key closed it");
    await act(async () => item('rename').dispatchEvent(new window.WheelEvent('wheel', { bubbles: true })));
    assert.equal(closes, 0, 'a wheel over the menu itself closed it');
    await act(async () =>
      document.getElementById('sidebar').dispatchEvent(new window.WheelEvent('wheel', { bubbles: true }))
    );
    assert.equal(closes, 1, 'a user scroll outside the menu leaves it open');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('opening a submenu near the bottom re-places the taller menu inside the viewport', async () => {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  const proto = window.HTMLElement.prototype;
  const original = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    offsetWidth: Object.getOwnPropertyDescriptor(proto, 'offsetWidth'),
    innerHeight: Object.getOwnPropertyDescriptor(window, 'innerHeight'),
    innerWidth: Object.getOwnPropertyDescriptor(window, 'innerWidth'),
  };
  // jsdom does no layout: a menu is one fixed-width column of ROW_HEIGHT rows.
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get() {
      return this.getAttribute('role') === 'menu' ? this.querySelectorAll('button').length * ROW_HEIGHT : 0;
    },
  });
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get: () => 200 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  const root = createRoot(document.getElementById('root'));
  const leaf = (id) => ({ id, label: id, onSelect() {} });
  const state = {
    label: 'Row actions',
    x: 100,
    y: 500,
    items: [
      leaf('open'),
      { id: 'move', label: 'Move to project', children: Array.from({ length: 8 }, (_, i) => leaf(`project-${i}`)) },
    ],
  };
  const menu = () => document.querySelector('[role="menu"]');
  const bottom = () => Number.parseFloat(menu().style.top) + menu().scrollHeight;
  try {
    await act(async () => root.render(React.createElement(ScmContextMenu, { state, onClose() {} })));
    assert.equal(Number.parseFloat(menu().style.top), 500, 'two rows fit below the pointer');

    await act(async () => document.querySelector('[data-action-id="move"]').click());
    assert.equal(menu().querySelectorAll('button').length, 9, 'Back row plus eight projects');
    assert.ok(bottom() <= VIEWPORT.height - 8, `submenu bottom ${bottom()} stays inside the viewport`);
    assert.ok(Number.parseFloat(menu().style.top) >= 8);

    await act(async () => document.querySelector('[data-action-id="__back"]').click());
    assert.equal(Number.parseFloat(menu().style.top), 500, 'the root list returns to the pointer');
  } finally {
    await act(async () => root.unmount());
    for (const [target, key] of [
      [proto, 'scrollHeight'],
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
