import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAppSidebarHub } from './use-app-sidebar-hub.ts';

test('useAppSidebarHub wires sidebar surface, side views descriptors, and reordering', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  let hookResult = null;
  const leavesRef = { current: [] };
  const focusedLeafIdRef = { current: 'leaf-1' };

  function TestHarness() {
    hookResult = useAppSidebarHub({
      schedulesOpen: false,
      webhooksOpen: false,
      projectsOpen: false,
      sidebarOpen: true,
      applySidebarOpen: () => {},
      sidebarViewGroups: [],
      loadedSidebarPanels: new Set(),
      failedSidebarPanels: new Set(),
      mountedSidebarPanels: new Set(),
      sidebarPanes: {},
      markSidebarPanelFailed: () => {},
      retrySidebarPanel: () => {},
      closeSidebarPanels: () => {},
      mountSidebarPanel: () => {},
      runningAutomationNames: { schedule: new Set(), webhook: new Set() },
      projects: [],
      projectCatalogReady: true,
      selectedProjectPath: '',
      extensionsSection: 'plugins',
      setExtensionsSection: () => {},
      projectsSection: 'projects',
      setProjectsSection: () => {},
      closeSidebarForNavigation: () => {},
      startTask: () => {},
      openStudioTab: () => {},
      openSession: async () => {},
      refreshProjects: async () => [],
      renameProject: async () => {},
      removeProject: async () => {},
      bottomPanel: { open: false, tab: 'problems', setOpen: () => {}, setTab: () => {} },
      focusedPaneDockOpen: false,
      paneSideDocks: { open: () => {}, setOpen: () => {}, select: () => {} },
      focusedLeafIdRef,
      paneLeavesRef: leavesRef,
      settingsOpen: false,
      setSettingsOpen: () => {},
      commandSurface: null,
      setCommandSurface: () => {},
      setCommandSurfaceSessionId: () => {},
      onboardingOpen: false,
      setOnboardingOpen: () => {},
      quickAccessMode: null,
      setQuickAccessMode: () => {},
      pendingUnsavedClose: null,
      cancelPendingTabClose: () => {},
      updateDialogOpen: false,
      updaterState: { status: 'idle' },
      closeDesktopUpdate: () => {},
      trackSidebarPanelModule: () => {},
      workbenchSideLayout: {
        layout: { left: [], right: [] },
        sideOf: () => 'left',
        moveGroup: () => {},
        moveView: () => {},
      },
      activeSideViews: { left: null, right: null },
      setActiveSideViews: () => {},
      browserSurfaces: new Map(),
      sessionPaneSurfaces: { pendingBrowserAutoReveal: { current: new Set() } },
      setSessionSideSurface: () => {},
      setSessionPanelView: () => {},
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);
  assert.equal(typeof hookResult.selectWorkbenchSideView, 'function');
  assert.equal(typeof hookResult.moveWorkbenchSideGroup, 'function');
  assert.equal(typeof hookResult.sidebarNewTask, 'function');

  await act(async () => {
    root.unmount();
  });
});
