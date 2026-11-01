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

test('Alt+Left/Right walks history except in the browser page, the terminal and, on a Mac, the code editor and text fields', async (t) => {
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
  assert.equal(await press(host, 'ArrowLeft'), true);
  assert.equal(await press(host, 'ArrowRight'), true);
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

  // Alt+Left/Right is word motion only on a Mac: there text fields and the
  // editor keep it. On Windows and Linux it navigates from every text surface;
  // the browser page and the terminal keep it everywhere.
  for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
    const mac = platform === 'MacIntel';
    for (const [name, target, yields] of [
      ['composer textarea', plain, mac],
      ['input', input, mac],
      ['contenteditable', editable, mac],
      ['Monaco', editorInput, mac],
      ['workspace', host, false],
      ['checkbox', checkbox, false],
      ['terminal', terminal, true],
      ['browser', browser, true],
    ]) {
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

/** Renders the keymap over a plain area, the browser pane, a terminal and a code editor. */
async function mountHistorySurfaces(t) {
  const host = document.createElement('main');
  const composer = document.createElement('textarea');
  const surfaces = {};
  for (const [name, className] of [
    ['browser', 'browser-pane'],
    ['isolated', 'browser-isolated-view'],
    ['terminal', 'xterm'],
    ['editor', 'monaco-editor'],
  ]) {
    const surface = document.createElement('div');
    surface.className = className;
    const inner = document.createElement('div');
    surface.append(inner);
    surfaces[name] = inner;
  }
  document.body.append(host, composer, ...Object.values(surfaces).map((inner) => inner.parentElement));
  const root = createRoot(host);
  const calls = [];
  const noop = () => {};
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    composer.remove();
    for (const inner of Object.values(surfaces)) inner.parentElement.remove();
  });
  await act(async () => {
    root.render(
      React.createElement(Harness, {
        actions: {
          tabs: [],
          activeTabKey: '',
          navigateTab: noop,
          startTask: noop,
          startProjectlessTask: noop,
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
  return { host, composer, surfaces, calls };
}

test('Ctrl+[ / ] walks history in the app and the composer but stays with the browser page, terminal and code editor', async (t) => {
  const { host, composer, surfaces, calls } = await mountHistorySurfaces(t);
  const press = async (target, code) => {
    const event = new window.KeyboardEvent('keydown', {
      key: code === 'BracketLeft' ? '[' : ']',
      code,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    let delivered = false;
    target.addEventListener('keydown', () => (delivered = true), { once: true });
    await act(async () => target.dispatchEvent(event));
    return { claimed: event.defaultPrevented, delivered };
  };
  assert.deepEqual(await press(host, 'BracketLeft'), { claimed: true, delivered: false });
  assert.deepEqual(await press(composer, 'BracketRight'), { claimed: true, delivered: false });
  assert.deepEqual(calls, ['back', 'forward']);
  calls.length = 0;
  for (const [name, target] of Object.entries(surfaces)) {
    assert.deepEqual(await press(target, 'BracketLeft'), { claimed: false, delivered: true }, name);
    assert.deepEqual(await press(target, 'BracketRight'), { claimed: false, delivered: true }, name);
  }
  assert.deepEqual(calls, [], 'the browser page keeps its own back/forward');
});

test('mouse buttons 3/4 walk back/forward except over the browser page, terminal and code editor', async (t) => {
  const { host, composer, surfaces, calls } = await mountHistorySurfaces(t);
  const click = async (target, button) => {
    const event = new window.MouseEvent('mouseup', { button, bubbles: true, cancelable: true });
    await act(async () => target.dispatchEvent(event));
    return event.defaultPrevented;
  };
  assert.equal(await click(host, 3), true);
  assert.equal(await click(composer, 4), true);
  assert.equal(await click(host, 0), false);
  assert.equal(await click(host, 1), false);
  assert.deepEqual(calls, ['back', 'forward']);
  calls.length = 0;
  for (const [name, target] of Object.entries(surfaces)) {
    assert.equal(await click(target, 3), false, name);
    assert.equal(await click(target, 4), false, name);
  }
  assert.deepEqual(calls, []);
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

test('a presented modal dialog outranks the keymap, a parked one does not, and plain typing never queries the document', async (t) => {
  const host = document.createElement('main');
  const field = document.createElement('textarea');
  const parked = document.createElement('div');
  parked.setAttribute('aria-hidden', 'true');
  parked.innerHTML = '<section role="dialog" aria-modal="true"></section>';
  document.body.append(host, field, parked);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    field.remove();
    parked.remove();
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
          startProjectlessTask: noop,
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
  const press = async (init) => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    await act(async () => {
      field.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };
  const ctrlN = { key: 'n', code: 'KeyN', ctrlKey: true };
  assert.equal(await press(ctrlN), true, 'a parked dialog leaves the keymap working');
  parked.removeAttribute('aria-hidden');
  assert.equal(await press(ctrlN), false, 'the same dialog presented owns the key');
  parked.setAttribute('aria-hidden', 'true');
  assert.equal(await press(ctrlN), true, 'parked again');
  assert.deepEqual(calls, ['start', 'start']);

  const wide = (self) => self === document || self === document.documentElement || self === document.body;
  let queries = 0;
  const original = window.Document.prototype.querySelectorAll;
  window.Document.prototype.querySelectorAll = function (...args) {
    if (wide(this)) queries += 1;
    return original.apply(this, args);
  };
  try {
    for (const key of 'typing') assert.equal(await press({ key }), false);
  } finally {
    window.Document.prototype.querySelectorAll = original;
  }
  assert.equal(queries, 0);
});

test('Ctrl/Cmd + = - 0 step the UI size once per press, except where another surface owns the key', async (t) => {
  const { getFontSettings, setFontSettings } = await import('./appearance/font-settings.ts');
  const { registerZoomTarget } = await import('./zoom-target.ts');
  const host = document.createElement('main');
  const plain = document.createElement('div');
  const editor = document.createElement('div');
  editor.className = 'monaco-editor';
  const browser = document.createElement('div');
  browser.className = 'browser-pane';
  const terminal = document.createElement('div');
  terminal.className = 'xterm';
  const preview = document.createElement('div');
  document.body.append(host, plain, editor, browser, terminal, preview);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const node of [host, plain, editor, browser, terminal, preview]) node.remove();
    window.localStorage.clear();
  });
  const noop = () => {};
  await act(async () => {
    root.render(
      React.createElement(Harness, {
        actions: Object.fromEntries(
          [
            'navigateTab',
            'startTask',
            'openSettings',
            'toggleSidebar',
            'toggleDock',
            'togglePanel',
            'openQuickAccess',
            'openCommandPalette',
            'openFindInFiles',
            'openTabSwitcher',
            'focusSiblingPane',
            'focusVerticalPane',
            'navigateBack',
            'navigateForward',
          ]
            .map((name) => [name, noop])
            .concat([
              ['tabs', []],
              ['activeTabKey', ''],
            ])
        ),
      })
    );
  });
  const press = async (target, key, init = {}) => {
    const event = new window.KeyboardEvent('keydown', {
      key,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => target.dispatchEvent(event));
    return event.defaultPrevented;
  };
  const scale = () => getFontSettings().uiScale;

  setFontSettings({ uiScale: 1 });
  assert.equal(await press(plain, '='), true);
  assert.equal(scale(), 1.05);
  assert.equal(await press(plain, '+', { shiftKey: true }), true);
  assert.equal(scale(), 1.1);
  assert.equal(await press(plain, '-'), true);
  assert.equal(scale(), 1.05);
  assert.equal(await press(plain, '0'), true);
  assert.equal(scale(), 1);
  // Layouts that type `+` on the BracketRight key, or `0` with Shift (AZERTY),
  // still step the size and never walk history.
  setFontSettings({ uiScale: 1 });
  assert.equal(await press(plain, '+', { code: 'BracketRight' }), true);
  assert.equal(scale(), 1.05);
  assert.equal(await press(plain, '0', { shiftKey: true, code: 'Digit0' }), true);
  assert.equal(scale(), 1);
  // Meta works too, and the code editor does not own these keys.
  assert.equal(await press(editor, '=', { ctrlKey: false, metaKey: true }), true);
  assert.equal(scale(), 1.05);

  // The browser pane and the terminal own their zoom/control keys.
  setFontSettings({ uiScale: 1 });
  for (const surface of [browser, terminal]) {
    for (const key of ['=', '-', '0']) assert.equal(await press(surface, key), false, key);
  }
  // Alt chords are not zoom.
  assert.equal(await press(plain, '=', { altKey: true }), false);
  assert.equal(scale(), 1);

  // A zoom host that would take the key keeps it: no second scaling.
  let hostZoomed = 0;
  const unregister = registerZoomTarget({
    element: preview,
    enabled: () => true,
    hovered: () => true,
    command: () => {
      hostZoomed += 1;
    },
  });
  await press(plain, '=');
  unregister();
  assert.equal(scale(), 1);
  assert.equal(hostZoomed, 1);
});
