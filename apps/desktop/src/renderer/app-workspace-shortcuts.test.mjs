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
  expose: ['navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement'],
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
    const event = new window.KeyboardEvent('keydown', {
      key,
      code,
      shiftKey,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
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

  // Ctrl+Left/Right stays a word jump everywhere; Ctrl+PageDown crosses tabs.
  assert.equal(await press(plain, 'ArrowRight'), false);
  assert.equal(await press(plain, 'PageDown'), true);
  assert.equal(await press(plain, 'ArrowDown'), true);
  assert.deepEqual(navigated, ['b']);
  assert.deepEqual(vertical, ['down']);
});

test('Alt+Left/Right walks history except in the browser page, the terminal and text on a Mac', async (t) => {
  const host = document.createElement('main');
  const plain = document.createElement('textarea');
  const terminal = document.createElement('div');
  terminal.className = 'xterm';
  const browser = document.createElement('div');
  browser.className = 'browser-pane';
  document.body.append(host, plain, terminal, browser);
  const root = createRoot(host);
  t.after(async () => {
    delete navigator.platform;
    await act(async () => root.unmount());
    host.remove();
    plain.remove();
    terminal.remove();
    browser.remove();
  });
  const calls = [];
  const noop = () => {};
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
          navigateBack: () => calls.push('back'),
          navigateForward: () => calls.push('forward'),
        },
      })
    );
  });
  const press = async (target, key) => {
    const event = new window.KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  assert.equal(await press(plain, 'ArrowLeft'), true);
  assert.equal(await press(plain, 'ArrowRight'), true);
  assert.equal(await press(terminal, 'ArrowLeft'), false);
  assert.equal(await press(browser, 'ArrowLeft'), false);
  assert.deepEqual(calls, ['back', 'forward']);
  const input = document.createElement('input');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  const editor = document.createElement('div');
  editor.className = 'monaco-editor';
  const editorInput = document.createElement('div');
  editor.append(editorInput);
  const editable = document.createElement('div');
  // jsdom lacks effective contenteditable; this checks routing, not native editing.
  Object.defineProperty(editable, 'isContentEditable', { value: true });
  host.append(input, checkbox, editor, editable);

  for (const [platform, mac] of [
    ['MacIntel', true],
    ['Win32', false],
    ['Linux x86_64', false],
  ]) {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    for (const [name, target, textTarget] of [
      ['textarea', plain, true],
      ['input', input, true],
      ['contenteditable', editable, true],
      ['Monaco', editorInput, true],
      ['workspace', host, false],
      ['checkbox', checkbox, false],
    ]) {
      const yields = mac && textTarget;
      const label = `${platform}/${name}`;
      let delivered = 0;
      const onKey = () => delivered++;
      target.addEventListener('keydown', onKey);
      calls.length = 0;
      assert.equal(await press(target, 'ArrowLeft'), !yields, label);
      assert.equal(await press(target, 'ArrowRight'), !yields, label);
      assert.deepEqual(calls, yields ? [] : ['back', 'forward'], label);
      assert.equal(delivered, yields ? 2 : 0, label);
      target.removeEventListener('keydown', onKey);
    }
  }
});

test('Ctrl+Alt+N starts a task without a project; Ctrl+N is unchanged; AltGr is not claimed', async (t) => {
  const host = document.createElement('main');
  const plain = document.createElement('textarea');
  document.body.append(host, plain);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    plain.remove();
  });
  const calls = [];
  const noop = () => {};
  await act(async () => {
    root.render(
      React.createElement(Harness, {
        actions: {
          tabs: [],
          activeTabKey: '',
          navigateTab: noop,
          startTask: () => calls.push('start'),
          startProjectlessTask: () => calls.push('projectless'),
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
  const press = async (init, altGraph = false) => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    if (altGraph) event.getModifierState = (name) => name === 'AltGraph';
    await act(async () => {
      plain.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  assert.equal(await press({ key: 'n', code: 'KeyN', ctrlKey: true }), true);
  assert.equal(await press({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true }), true);
  // macOS: Option+N is a dead key, so only the physical code identifies it.
  assert.equal(await press({ key: 'Dead', code: 'KeyN', metaKey: true, altKey: true }), true);
  assert.deepEqual(calls, ['start', 'projectless', 'projectless']);

  calls.length = 0;
  assert.equal(await press({ key: 'ń', code: 'KeyN', ctrlKey: true, altKey: true }, true), false);
  assert.equal(await press({ key: 'N', code: 'KeyN', ctrlKey: true, altKey: true, shiftKey: true }), false);
  assert.deepEqual(calls, []);
});
