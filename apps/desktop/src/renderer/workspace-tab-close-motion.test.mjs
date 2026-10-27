// A closing tab stays the very DOM node that was open (not a rebuilt ghost), so
// its width transition starts from where it stands; consecutive closes keep
// every ghost and survivor on its node.
import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['Element', 'HTMLElement', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'navigator'],
});
window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
window.cancelAnimationFrame = (handle) => window.clearTimeout(handle);
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver ??= window.MutationObserver;

const { WorkspaceTabStrip } = await import('./WorkspaceTabStrip.tsx');

const tabs = ['a', 'b', 'c', 'd'].map((id) => ({
  key: `session:${id}`,
  title: id,
  selection: { kind: 'session', id },
}));

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const calls = { selected: [], closed: [], reordered: [] };
  return {
    host,
    calls,
    render: (list, activeKey) =>
      act(async () =>
        root.render(
          React.createElement(WorkspaceTabStrip, {
            tabs: list,
            activeKey,
            onSelectTab: (tab) => calls.selected.push(tab.key),
            onCloseTab: (tab) => calls.closed.push(tab.key),
            onReorderTab: (...args) => calls.reordered.push(args),
            onNewTask() {},
          })
        )
      ),
    nodes: () => [...host.querySelectorAll('.workspace-tabs > .workspace-tab')],
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('consecutive closes keep the closing tabs and the survivors on their nodes', async () => {
  const { render, nodes, unmount } = mount();
  try {
    const [a, b, c, d] = tabs;
    await render([a, b, c, d], b.key);
    const open = new Map(nodes().map((node) => [node.dataset.tabKey, node]));
    await render([a, c, d], c.key);
    await render([a, d], d.key);
    const shown = nodes();
    assert.deepEqual(
      shown.map((node) => `${node.classList.contains('closing') ? '~' : ''}${node.dataset.tabKey.slice(-1)}`),
      ['a', '~b', '~c', 'd']
    );
    for (const node of shown)
      assert.equal(node, open.get(node.dataset.tabKey), `${node.dataset.tabKey} keeps its node`);
  } finally {
    await unmount();
  }
});

test('a closing tab cannot be focused, selected, closed again, dragged or opened as a menu', async () => {
  const { host, calls, render, nodes, unmount } = mount();
  const fire = (node, event) => act(async () => node.dispatchEvent(event));
  const mouse = (type, init = {}) => new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  try {
    const [a, b, c] = tabs;
    await render([a, b, c], a.key);
    const live = nodes().find((node) => node.dataset.tabKey === c.key);
    assert.equal(live.hasAttribute('inert'), false);
    assert.equal(live.getAttribute('draggable'), 'true');
    // The same gestures on an open tab do act, so the closing assertions are not vacuous.
    await fire(live.querySelector('.workspace-tab-main'), mouse('click'));
    await fire(live, mouse('mousedown', { button: 1 }));
    assert.deepEqual(calls.selected, [c.key]);
    assert.deepEqual(calls.closed, [c.key]);

    calls.selected.length = 0;
    calls.closed.length = 0;
    await render([a, c], a.key);
    const ghost = nodes().find((node) => node.dataset.tabKey === b.key);
    assert.ok(ghost.classList.contains('closing'));
    assert.equal(ghost.hasAttribute('inert'), true, 'closing cell is inert');
    assert.equal(ghost.getAttribute('draggable'), 'false');
    for (const control of ghost.querySelectorAll('button'))
      assert.equal(control.tabIndex, -1, `${control.className} leaves the tab order`);

    await fire(ghost.querySelector('.workspace-tab-main'), mouse('click'));
    await fire(ghost.querySelector('.workspace-tab-close'), mouse('click'));
    await fire(ghost, mouse('mousedown', { button: 1 }));
    await fire(ghost, mouse('dblclick'));
    const drag = new window.Event('dragstart', { bubbles: true, cancelable: true });
    await fire(ghost, drag);
    const menu = mouse('contextmenu');
    await fire(ghost, menu);
    ghost.querySelector('.workspace-tab-main').focus();
    await act(async () => {});

    assert.deepEqual(calls.selected, [], 'no selection');
    assert.deepEqual(calls.closed, [], 'no second close');
    assert.deepEqual(calls.reordered, [], 'no drag reorder');
    assert.equal(drag.defaultPrevented, true, 'drag is refused');
    assert.equal(menu.defaultPrevented, false, 'no tab menu is claimed');
    assert.equal(document.querySelector('.workspace-tab-context-menu'), null);
    assert.equal(ghost.querySelector('.workspace-tab-title-input'), null);
    assert.equal(ghost.getAttribute('aria-grabbed'), 'false');
    assert.equal(host.querySelectorAll('.workspace-tab.dragging').length, 0);
  } finally {
    await unmount();
  }
});
