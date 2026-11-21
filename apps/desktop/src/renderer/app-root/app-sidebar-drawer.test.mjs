import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { loadSettingsViewModule } from '../app-shell-components.tsx';
import { AppSidebarDrawer } from './AppSidebarDrawer.tsx';

async function mountDrawer() {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  });
  const state = { settingsOpened: false, navigationClosedMotion: null };
  const props = {
    sidebarOpen: true,
    sidebarMotion: 'animated',
    sidebarPanel: null,
    closeSidebarPanels: () => {},
    openSidebar: () => {},
    toggleSidebar: () => {},
    settingsOpen: false,
    openProjects: () => {},
    refreshProjects: async () => {},
    trackSidebarPanelModule: () => {},
    openSchedules: () => {},
    openWebhooks: () => {},
    closeActiveRailPanel: () => {},
    closeSidebarForNavigation: (motion) => {
      state.navigationClosedMotion = motion;
    },
    openSettings: () => {
      state.settingsOpened = true;
    },
    setCommandSurface: () => {},
    workbenchSideLayout: {
      layout: { left: [], right: [] },
      sideOf: () => 'left',
      moveGroup: () => {},
      moveView: () => {},
    },
    sideViewDescriptors: new Map(),
    activeSideViews: { left: null, right: null },
    selectWorkbenchSideView: () => {},
    moveWorkbenchSideGroup: () => {},
    moveWorkbenchSideView: () => {},
    renderWorkbenchSideView: () => React.createElement('div', { className: 'mock-side-view' }),
    sidebarDiff: null,
    closeSidebarDiff: () => {},
    openFileTab: () => {},
  };
  const root = createRoot(dom.window.document.getElementById('root'));
  const render = (overrides = {}) =>
    act(async () => {
      root.render(React.createElement(AppSidebarDrawer, { ...props, ...overrides }));
    });
  await render();
  const document = dom.window.document;
  return {
    state,
    render,
    frame: document.querySelector('.sidebar-drawer-frame'),
    rail: document.querySelector('.activity-rail'),
    settingsButton: document.querySelector('.sidebar-settings-button'),
    unmount: () => act(async () => root.unmount()),
  };
}

test('AppSidebarDrawer renders the drawer frame and activity rail with an unselected settings button', async () => {
  const { frame, rail, settingsButton, unmount } = await mountDrawer();
  assert.notEqual(frame, null);
  assert.equal(frame.getAttribute('data-state'), 'open');
  assert.equal(frame.getAttribute('data-motion'), 'animated');
  assert.notEqual(rail, null);
  assert.notEqual(settingsButton, null);
  assert.equal(settingsButton.getAttribute('aria-label'), 'Open settings');
  assert.equal(settingsButton.classList.contains('selected'), false);
  assert.equal(settingsButton.getAttribute('aria-current'), null);
  await unmount();
});

test('AppSidebarDrawer opens settings once the settings module has loaded and closes the drawer instantly', async () => {
  const { state, settingsButton, unmount } = await mountDrawer();
  await act(async () => {
    settingsButton.click();
  });
  await act(async () => {
    await loadSettingsViewModule();
  });
  assert.equal(state.settingsOpened, true);
  assert.equal(state.navigationClosedMotion, 'instant');
  await unmount();
});

test('AppSidebarDrawer: a closed sidebar does not activate the rail surface for its panel', async () => {
  const { frame, settingsButton, render, unmount } = await mountDrawer();
  await render({ sidebarOpen: false, sidebarPanel: 'projects', settingsOpen: false });
  assert.equal(frame.getAttribute('data-state'), 'closed');
  assert.equal(settingsButton.classList.contains('selected'), false);
  assert.equal(settingsButton.getAttribute('aria-current'), null);
  await unmount();
});

test('AppSidebarDrawer: settingsOpen selects the settings button over a closed sidebar and its panel', async () => {
  const { frame, settingsButton, render, unmount } = await mountDrawer();
  await render({ sidebarOpen: false, sidebarPanel: 'projects', settingsOpen: true });
  assert.equal(frame.getAttribute('data-state'), 'closed');
  assert.equal(settingsButton.classList.contains('selected'), true);
  assert.equal(settingsButton.getAttribute('aria-current'), 'page');
  await unmount();
});

test('AppSidebarDrawer: reopening the sidebar keeps the settings selection', async () => {
  const { frame, settingsButton, render, unmount } = await mountDrawer();
  await render({ sidebarOpen: false, sidebarPanel: 'projects', settingsOpen: true });
  await render({ sidebarOpen: true, sidebarPanel: 'projects', settingsOpen: true });
  assert.equal(frame.getAttribute('data-state'), 'open');
  assert.equal(settingsButton.classList.contains('selected'), true);
  assert.equal(settingsButton.getAttribute('aria-current'), 'page');
  await unmount();
});

test('AppSidebarDrawer: an open sidebar with settings closed leaves the settings button unselected', async () => {
  const { frame, settingsButton, render, unmount } = await mountDrawer();
  await render({ sidebarOpen: true, sidebarPanel: 'projects', settingsOpen: false });
  assert.equal(frame.getAttribute('data-state'), 'open');
  assert.equal(settingsButton.classList.contains('selected'), false);
  assert.equal(settingsButton.getAttribute('aria-current'), null);
  await unmount();
});
