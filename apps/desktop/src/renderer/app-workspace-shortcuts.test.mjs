import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['navigator'],
});

const { useWorkspaceShortcuts } = await import('./app-workspace-shortcuts.ts');

function Harness({ actions }) {
  useWorkspaceShortcuts(actions);
  return null;
}

test('Ctrl+T and Ctrl+` remain unclaimed', async (t) => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  let actionCalls = 0;
  const noop = () => {
    actionCalls += 1;
  };
  await act(async () => {
    root.render(
      React.createElement(Harness, {
        actions: {
          tabs: [],
          activeTabKey: '',
          navigateTab: noop,
          startTask: noop,
          openSettings: noop,
          toggleSidebar: noop,
          toggleDock: noop,
          togglePanel: noop,
          openQuickAccess: noop,
          openCommandPalette: noop,
          openFindInFiles: noop,
          openTabSwitcher: noop,
          focusSiblingPane: noop,
          focusVerticalPane: noop,
          navigateBack: noop,
          navigateForward: noop,
        },
      })
    );
  });

  const events = [];
  for (const key of ['t', '`']) {
    await act(async () => {
      const event = new window.KeyboardEvent('keydown', {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      events.push(event);
      window.dispatchEvent(event);
    });
  }
  assert.equal(actionCalls, 0);
  assert.deepEqual(
    events.map((event) => event.defaultPrevented),
    [false, false]
  );
});

test('app-level Ctrl+F, Ctrl+K, Ctrl+digit and bracket shortcuts', async (t) => {
  const host = document.createElement('main');
  const editor = document.createElement('div');
  editor.className = 'monaco-editor';
  const plain = document.createElement('div');
  document.body.append(host, editor, plain);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    editor.remove();
    plain.remove();
  });

  const calls = [];
  const record = (name) => () => calls.push(name);
  let sessionSearches = 0;
  const onSearch = () => {
    sessionSearches += 1;
  };
  window.addEventListener('mixdog:open-session-search', onSearch);
  t.after(() => window.removeEventListener('mixdog:open-session-search', onSearch));
  const render = (tabs) =>
    act(async () => {
      root.render(
        React.createElement(Harness, {
          actions: {
            tabs,
            activeTabKey: tabs[0]?.key ?? '',
            navigateTab: (tab) => calls.push(`tab:${tab.key}`),
            startTask: record('start'),
            openSettings: record('settings'),
            toggleSidebar: record('sidebar'),
            toggleDock: record('dock'),
            togglePanel: record('panel'),
            openQuickAccess: record('quick'),
            openCommandPalette: record('palette'),
            openFindInFiles: record('find'),
            openTabSwitcher: record('switcher'),
            focusSiblingPane: record('sibling'),
            focusVerticalPane: record('vertical'),
            navigateBack: record('back'),
            navigateForward: record('forward'),
          },
        })
      );
    });
  const press = async (target, key, code = '', shiftKey = false) => {
    const event = new window.KeyboardEvent('keydown', { key, code, shiftKey, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(event));
    return event.defaultPrevented;
  };

  await render([]);
  assert.equal(await press(plain, 'f'), true);
  assert.equal(sessionSearches, 1);

  await render([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  assert.equal(await press(plain, 'f'), false);
  assert.equal(sessionSearches, 1);
  await press(plain, 'k');
  await press(plain, '/');
  await press(plain, '2');
  await press(plain, '9');
  assert.equal(await press(plain, '5'), false);
  await press(plain, '[', 'BracketLeft');
  await press(plain, ']', 'BracketRight');
  await press(plain, '}', 'BracketRight', true);
  assert.deepEqual(calls, ['palette', 'palette', 'tab:b', 'tab:c', 'back', 'forward', 'tab:b']);

  calls.length = 0;
  await press(plain, 'b');
  await press(plain, 'B', '', true);
  assert.deepEqual(calls, ['dock', 'sidebar']);

  calls.length = 0;
  assert.equal(await press(editor, 'k'), false);
  assert.equal(await press(editor, '/'), false);
  assert.equal(await press(editor, ']', 'BracketRight'), false);
  assert.deepEqual(calls, []);
});

test('a focused code editor keeps Ctrl+Arrow for word jumps and line scrolling', async (t) => {
  const host = document.createElement('main');
  const editor = document.createElement('div');
  editor.className = 'monaco-editor';
  const editorInput = document.createElement('div');
  editor.append(editorInput);
  const plain = document.createElement('div');
  document.body.append(host, editor, plain);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    editor.remove();
    plain.remove();
  });

  const navigated = [];
  const vertical = [];
  const noop = () => {};
  const tabs = [{ key: 'a' }, { key: 'b' }];
  await act(async () => {
    root.render(
      React.createElement(Harness, {
        actions: {
          tabs,
          activeTabKey: 'a',
          navigateTab: (tab) => navigated.push(tab.key),
          startTask: noop,
          openSettings: noop,
          toggleSidebar: noop,
          toggleDock: noop,
          togglePanel: noop,
          openQuickAccess: noop,
          openCommandPalette: noop,
          openFindInFiles: noop,
          openTabSwitcher: noop,
          focusSiblingPane: noop,
          focusVerticalPane: (direction) => vertical.push(direction),
          navigateBack: noop,
          navigateForward: noop,
        },
      })
    );
  });

  const press = async (target, key) => {
    const event = new window.KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  assert.equal(await press(editorInput, 'ArrowRight'), false);
  assert.equal(await press(editorInput, 'ArrowDown'), false);
  assert.deepEqual(navigated, []);
  assert.deepEqual(vertical, []);

  assert.equal(await press(plain, 'ArrowRight'), true);
  assert.equal(await press(plain, 'ArrowDown'), true);
  assert.deepEqual(navigated, ['b']);
  assert.deepEqual(vertical, ['down']);
});
