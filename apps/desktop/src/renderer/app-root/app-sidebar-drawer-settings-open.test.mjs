// A tap on Settings that beats the settings module is a pending request: taps
// coalesce, and it is dropped when the user navigates elsewhere first. This
// file is the module's only user, so it is still unloaded when the test starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

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

const { settingsViewModule, loadSettingsViewModule } = await import('../app-shell-components.tsx');
const { AppSidebarDrawer } = await import('./AppSidebarDrawer.tsx');

test('repeated Settings taps wait as one request that navigating elsewhere drops', async () => {
  const Icon = () => null;
  const opened = [];
  const closed = [];
  const selected = [];
  const props = {
    // Closed, so mounting the drawer does not warm the module.
    sidebarOpen: false,
    sidebarMotion: 'instant',
    applySidebarOpen() {},
    openSidebar() {},
    settingsOpen: false,
    onboardingActive: false,
    closeSidebarForNavigation: (motion) => closed.push(motion),
    openSettings: (section) => opened.push(section ?? 'settings'),
    setSettingsOpen() {},
    setCommandSurface() {},
    workbenchSideLayout: { layout: { left: [['sessions']], right: [] } },
    sideViewDescriptors: new Map([['sessions', { id: 'sessions', label: 'Sessions', icon: Icon }]]),
    activeSideViews: { left: null, right: null },
    selectWorkbenchSideView: (id) => selected.push(id),
    moveWorkbenchSideGroup() {},
    moveWorkbenchSideView() {},
    renderWorkbenchSideView: () => null,
    sidebarDiff: null,
    closeSidebarDiff() {},
    openFileTab() {},
    mountedSidebarPanels: new Set(),
  };
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(AppSidebarDrawer, props)));
  try {
    assert.equal(settingsViewModule.peek(), null);
    const settingsButton = document.querySelector('.sidebar-settings-button');
    await act(async () => {
      settingsButton.click();
      settingsButton.click();
    });
    assert.deepEqual(opened, [], 'the module is still loading: nothing opens yet');
    assert.deepEqual(closed, [], 'the drawer stays as it is meanwhile');
    await act(async () => {
      document.querySelector('button[data-side-view="sessions"]').click();
    });
    assert.deepEqual(selected, ['sessions']);
    await act(async () => {
      await loadSettingsViewModule();
    });
    assert.deepEqual(opened, [], 'the newer destination is not covered by Settings');
    assert.deepEqual(closed, []);
    // Loaded: a later tap opens at once, and only once per tap.
    await act(async () => {
      settingsButton.click();
    });
    assert.deepEqual(opened, ['settings']);
    assert.deepEqual(closed, ['instant']);
  } finally {
    await act(async () => root.unmount());
  }
});
