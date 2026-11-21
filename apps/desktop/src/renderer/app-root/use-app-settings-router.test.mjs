import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppSettingsRouter } from './use-app-settings-router.ts';

async function mountRouter() {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
    actEnvironment: false,
  });
  globalThis.window.mixdogDesktop = {
    getRemoteAccessInfo: async () => null,
  };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const state = {
    settingsOpen: false,
    settingsSection: null,
    activeSideViews: { left: 'projects', right: null },
    sidebarOpen: false,
    mountedPanel: null,
    loadedPanel: null,
  };
  window.__mixdogSidebarPanelLoader = () => new Promise(() => {});

  const hook = { current: null };
  function TestHarness() {
    hook.current = useAppSettingsRouter({
      workbenchSideLayout: { sideOf: () => 'left' },
      setExtensionsSection: () => {},
      setSettingsOpen: (open) => {
        state.settingsOpen = open;
      },
      setCommandSurface: () => {},
      mountSidebarPanel: (panel) => {
        state.mountedPanel = panel;
      },
      trackSidebarPanelModule: (panel) => {
        state.loadedPanel = panel;
      },
      paneSideDocks: { open: () => {} },
      focusedLeafIdRef: { current: 'leaf-1' },
      setActiveSideViews: (update) => {
        state.activeSideViews = update(state.activeSideViews);
      },
      applySidebarOpen: (open) => {
        state.sidebarOpen = open;
      },
      setSettingsSection: (s) => {
        state.settingsSection = s;
      },
      uiOpenRequest: null,
      sessionId: 's1',
      openConversationCommandSurface: () => {},
      setupUiRequest: null,
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });
  return { hook, state, unmount: () => act(async () => root.unmount()) };
}

test('useAppSettingsRouter opens the settings dialog at the requested section', async () => {
  const { hook, state, unmount } = await mountRouter();
  assert.equal(typeof hook.current.openSettings, 'function');
  await act(async () => {
    hook.current.openSettings('theme');
  });
  assert.equal(state.settingsOpen, true);
  assert.equal(state.settingsSection, 'theme');
  await unmount();
});

test('useAppSettingsRouter routes workflow and websearch sections to the workflows side panel', async () => {
  const { hook, state, unmount } = await mountRouter();
  for (const section of ['workflow', 'websearch']) {
    state.activeSideViews = { left: 'projects', right: null };
    state.settingsOpen = true;
    await act(async () => hook.current.openSettings(section));
    assert.equal(state.settingsOpen, false);
    assert.equal(state.activeSideViews.left, 'workflows');
    assert.equal(state.sidebarOpen, true);
    assert.equal(state.mountedPanel, 'workflows');
    assert.equal(state.loadedPanel, 'workflows');
  }
  await unmount();
});
