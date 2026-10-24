import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { loadSettingsViewModule } from '../app-shell-components.tsx';
import { AppSidebarDrawer } from './AppSidebarDrawer.tsx';

test('AppSidebarDrawer renders sidebar drawer frame and activity rail with given state', async () => {
  const { dom } = installTestDom(null, {
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  });

  let settingsOpened = false;
  let navigationClosedMotion = null;

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
      navigationClosedMotion = motion;
    },
    openSettings: () => {
      settingsOpened = true;
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
  await act(async () => {
    root.render(React.createElement(AppSidebarDrawer, props));
  });

  const frame = dom.window.document.querySelector('.sidebar-drawer-frame');
  assert.notEqual(frame, null);
  assert.equal(frame.getAttribute('data-state'), 'open');
  assert.equal(frame.getAttribute('data-motion'), 'animated');

  const rail = dom.window.document.querySelector('.activity-rail');
  assert.notEqual(rail, null);

  const settingsButton = dom.window.document.querySelector('.sidebar-settings-button');
  assert.notEqual(settingsButton, null);
  assert.equal(settingsButton.getAttribute('aria-label'), 'Open settings');
  assert.equal(settingsButton.classList.contains('selected'), false);
  assert.equal(settingsButton.getAttribute('aria-current'), null);

  await act(async () => {
    settingsButton.click();
  });
  // The settings module loads on demand: a tap that beats it opens the dialog
  // once it has resolved (at once when it already had).
  await act(async () => {
    await loadSettingsViewModule();
  });
  assert.equal(settingsOpened, true);
  assert.equal(navigationClosedMotion, 'instant');

  // Closed sidebar behavior: when closed, sidebarPanel does not activate the rail surface
  await act(async () => {
    root.render(
      React.createElement(AppSidebarDrawer, {
        ...props,
        sidebarOpen: false,
        sidebarPanel: 'projects',
        settingsOpen: false,
      })
    );
  });
  assert.equal(frame.getAttribute('data-state'), 'closed');
  assert.equal(settingsButton.classList.contains('selected'), false);
  assert.equal(settingsButton.getAttribute('aria-current'), null);

  // Settings precedence: settingsOpen overrides closed sidebar and panel selection
  await act(async () => {
    root.render(
      React.createElement(AppSidebarDrawer, {
        ...props,
        sidebarOpen: false,
        sidebarPanel: 'projects',
        settingsOpen: true,
      })
    );
  });
  assert.equal(frame.getAttribute('data-state'), 'closed');
  assert.equal(settingsButton.classList.contains('selected'), true);
  assert.equal(settingsButton.getAttribute('aria-current'), 'page');

  // Toggle behavior: re-opening sidebar preserves settings selection precedence
  await act(async () => {
    root.render(
      React.createElement(AppSidebarDrawer, {
        ...props,
        sidebarOpen: true,
        sidebarPanel: 'projects',
        settingsOpen: true,
      })
    );
  });
  assert.equal(frame.getAttribute('data-state'), 'open');
  assert.equal(settingsButton.classList.contains('selected'), true);
  assert.equal(settingsButton.getAttribute('aria-current'), 'page');

  // Panel active when sidebar is open and settings is closed
  await act(async () => {
    root.render(
      React.createElement(AppSidebarDrawer, {
        ...props,
        sidebarOpen: true,
        sidebarPanel: 'projects',
        settingsOpen: false,
      })
    );
  });
  assert.equal(frame.getAttribute('data-state'), 'open');
  assert.equal(settingsButton.classList.contains('selected'), false);
  assert.equal(settingsButton.getAttribute('aria-current'), null);

  await act(async () => {
    root.unmount();
  });
});
