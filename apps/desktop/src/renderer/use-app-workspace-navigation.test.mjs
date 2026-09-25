// While the Ctrl+Tab switcher is open, re-renders must not rebind its window
// listeners, and releasing Ctrl still navigates through the LATEST callbacks.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const DOM_GLOBALS = ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Event', 'CustomEvent', 'KeyboardEvent'];
const savedGlobals = DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
for (const key of DOM_GLOBALS)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
after(() => {
  dom.window.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { createRoot } = await import('react-dom/client');
const { useAppWorkspaceNavigation } = await import('./use-app-workspace-navigation.ts');

test('the open tab switcher keeps its listeners across re-renders and commits through the latest callbacks', async (t) => {
  const first = { kind: 'session', id: 'a' };
  const second = { kind: 'session', id: 'b' };
  const activated = [];
  const paneWorkspace = {
    focusedLeaf: { tabs: [first, second] },
    focusedLeafId: 'leaf',
    activateTab: (leafId, key) => activated.push([leafId, key]),
  };
  const noop = () => {};
  const props = (navigateTab) => ({
    paneWorkspace,
    requestedSessionId: '',
    focusedPaneSelection: first,
    activeTabKey: 'session:a',
    navigateTab,
    focusPaneTypingSurface: noop,
    focusSiblingPane: noop,
    focusVerticalPane: noop,
    startTask: noop,
    openSettings: noop,
    toggleSidebar: noop,
    toggleDock: noop,
    toggleBottomPanel: noop,
    setQuickAccessMode: noop,
    openDockTab: noop,
    navigateEditorHistory: noop,
  });
  let switcher = null;
  function Probe(probeProps) {
    switcher = useAppWorkspaceNavigation(probeProps).tabSwitcher;
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () =>
    root.render(
      React.createElement(
        Probe,
        props(() => {})
      )
    )
  );
  await act(async () => window.dispatchEvent(new CustomEvent('mixdog:tab-switcher', { detail: 1 })));
  assert.deepEqual(switcher, { keys: ['session:a', 'session:b'], index: 1 });

  const keyupBindings = [];
  const addEventListener = window.addEventListener;
  window.addEventListener = function (type, ...rest) {
    if (type === 'keyup') keyupBindings.push(type);
    return addEventListener.call(this, type, ...rest);
  };
  t.after(() => {
    window.addEventListener = addEventListener;
  });
  await act(async () =>
    root.render(
      React.createElement(
        Probe,
        props(() => {})
      )
    )
  );
  const navigated = [];
  await act(async () =>
    root.render(
      React.createElement(
        Probe,
        props((tab) => navigated.push(tab.key))
      )
    )
  );
  assert.deepEqual(keyupBindings, []);

  await act(async () => window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' })));
  assert.equal(switcher, null);
  assert.deepEqual(navigated, ['session:b']);
  assert.deepEqual(activated, [['leaf', 'session:b']]);
});
