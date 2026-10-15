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
const { useComposerFocus } = await import('./use-composer-focus.ts');

const sessionTab = { key: 'session:s1', title: 'Old title', selection: { kind: 'session', id: 's1' } };
const fileTab = {
  key: 'file:p:a.txt',
  title: 'a.txt',
  selection: { kind: 'file', project: 'p', rel: 'a.txt' },
};

async function mount(tabs, calls) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      React.createElement(WorkspaceTabStrip, {
        tabs,
        activeKey: tabs[0].key,
        onSelectTab() {},
        onCloseTab() {},
        onReorderTab() {},
        onPinTab: (tab) => calls.pinned.push(tab.key),
        onRenameSession: (id, title) => calls.renamed.push([id, title]),
        onNewTask() {},
      })
    )
  );
  return {
    host,
    tab: (key) => host.querySelector(`.workspace-tab[data-tab-key="${key}"]`),
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const dblclick = (node) => node.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
const type = (input, value) => {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const key = (input, name) => input.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true }));

test('double-clicking a session tab renames it in place; Enter commits the trimmed title', async () => {
  const calls = { pinned: [], renamed: [] };
  const view = await mount([sessionTab], calls);
  try {
    await act(async () => dblclick(view.tab(sessionTab.key).querySelector('.workspace-tab-main')));
    const input = view.tab(sessionTab.key).querySelector('.workspace-tab-title-input');
    assert.ok(input, 'rename field opens');
    assert.equal(input.value, 'Old title');
    assert.equal(view.tab(sessionTab.key).getAttribute('draggable'), 'false');
    await act(async () => type(input, '  New title  '));
    await act(async () => key(input, 'Enter'));
    assert.deepEqual(calls.renamed, [['s1', 'New title']]);
    assert.equal(view.tab(sessionTab.key).querySelector('.workspace-tab-title-input'), null);
  } finally {
    await view.unmount();
  }
});

test('Escape, an empty draft or an unchanged title never renames', async () => {
  const calls = { pinned: [], renamed: [] };
  const view = await mount([sessionTab], calls);
  try {
    for (const [draft, finish] of [
      ['Changed', 'Escape'],
      ['   ', 'Enter'],
      ['Old title', 'Enter'],
    ]) {
      await act(async () => dblclick(view.tab(sessionTab.key).querySelector('.workspace-tab-main')));
      const input = view.tab(sessionTab.key).querySelector('.workspace-tab-title-input');
      await act(async () => type(input, draft));
      await act(async () => key(input, finish));
      assert.equal(view.tab(sessionTab.key).querySelector('.workspace-tab-title-input'), null);
    }
    assert.deepEqual(calls.renamed, []);
  } finally {
    await view.unmount();
  }
});

// The app's activation path: every tab press asks the focused pane's composer
// to take focus (useComposerFocus defers it one timer tick).
function ActivationHarness({ calls }) {
  const textarea = React.useRef(null);
  const [focusRequest, setFocusRequest] = React.useState(0);
  useComposerFocus({ textarea, transitioning: false, focusRequest, paneActive: true });
  return React.createElement(
    React.Fragment,
    null,
    React.createElement(WorkspaceTabStrip, {
      tabs: [sessionTab],
      activeKey: sessionTab.key,
      onSelectTab() {
        setFocusRequest((value) => value + 1);
      },
      onCloseTab() {},
      onReorderTab() {},
      onPinTab: (tab) => calls.pinned.push(tab.key),
      onRenameSession: (id, title) => calls.renamed.push([id, title]),
      onNewTask() {},
    }),
    React.createElement('textarea', { ref: textarea, className: 'composer-input' })
  );
}

const settle = () => new Promise((resolve) => window.setTimeout(resolve, 20));
// One physical press as the browser delivers it: mousedown moves focus onto
// the button, then mouseup and click.
function press(node, detail) {
  node.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, button: 0, detail }));
  node.focus();
  node.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0, detail }));
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, button: 0, detail }));
}

test('a real double-click keeps the rename field focused after tab activation asks for the composer', async () => {
  const calls = { pinned: [], renamed: [] };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(ActivationHarness, { calls })));
    await act(settle);
    const composer = host.querySelector('textarea');
    const main = host.querySelector('.workspace-tab-main');

    // A single click still hands focus to the composer.
    main.focus();
    await act(async () => press(main, 1));
    await act(settle);
    assert.equal(document.activeElement, composer, 'single click activation focuses the composer');

    // Click 1, then click 2 + dblclick in the same task: the composer's deferred
    // focus tick runs after the editor has mounted and taken focus.
    await act(async () => press(main, 1));
    await act(async () => {
      press(main, 2);
      main.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, detail: 2 }));
    });
    await act(settle);
    const input = host.querySelector('.workspace-tab-title-input');
    assert.ok(input, 'rename field is still open');
    assert.equal(document.activeElement, input, 'rename field keeps focus');

    await act(async () => type(input, 'Renamed'));
    await act(async () => key(input, 'Enter'));
    assert.deepEqual(calls.renamed, [['s1', 'Renamed']]);
    assert.equal(host.querySelector('.workspace-tab-title-input'), null);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('non-session tabs keep double-click as pin and open no rename field', async () => {
  const calls = { pinned: [], renamed: [] };
  const view = await mount([fileTab, sessionTab], calls);
  try {
    await act(async () => dblclick(view.tab(fileTab.key).querySelector('.workspace-tab-main')));
    assert.deepEqual(calls.pinned, [fileTab.key]);
    assert.equal(view.host.querySelector('.workspace-tab-title-input'), null);
  } finally {
    await view.unmount();
  }
});
