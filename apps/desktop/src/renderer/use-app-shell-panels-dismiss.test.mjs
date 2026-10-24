// Every route that asks the phone drawer to close says so at the request, so a
// "open Settings once loaded" waiting on the drawer drops out before the
// transition that commits the closed state (drawer-intent.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { useAppShellPanels } = await import('./use-app-shell-panels.ts');
const { subscribeDrawerDismiss } = await import('./drawer-intent.ts');

test('close routes announce the dismissal at the request; opening does not', async () => {
  let panels;
  function Harness() {
    panels = useAppShellPanels('pane-1');
    return null;
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  let dismissals = 0;
  const stop = subscribeDrawerDismiss(() => dismissals++);
  /** Whether a dismissal was announced since the last look. */
  const announced = () => {
    const was = dismissals > 0;
    dismissals = 0;
    return was;
  };
  try {
    // A drawer-style close (swipe, backdrop, back gesture, navigation).
    await act(async () => panels.applySidebarOpen(false));
    assert.equal(announced(), true);
    await act(async () => panels.applySidebarOpen(true));
    assert.equal(announced(), false, 'opening is not a dismissal');
    // The toggle button, announced when pressed.
    await act(async () => panels.toggleSidebar({ timeStamp: 1000 }));
    assert.equal(announced(), true);
    await act(async () => panels.openSidebar());
    assert.equal(announced(), false);
    // Re-selecting the visible rail destination folds the sidebar.
    await act(async () => panels.closeActiveRailPanel());
    assert.equal(announced(), true);
  } finally {
    stop();
    await act(async () => root.unmount());
  }
});
