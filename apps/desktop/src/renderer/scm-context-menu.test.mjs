import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ScmContextMenu } from './ScmContextMenu.tsx';
import { installTestDom } from './test-support/test-dom.mjs';

const ROW_HEIGHT = 30;
const VIEWPORT = { width: 800, height: 600 };

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
