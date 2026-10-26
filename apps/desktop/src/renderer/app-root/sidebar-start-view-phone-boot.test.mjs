// The phone drawer opens on the rail's topmost item. Released builds up to
// v1.3.5 opened the left drawer on Bots (agents) whatever the rail's order
// was (a LEFT_HOME_VIEW rule); the start view is now the first pinned rail
// view, following the pins until the user picks. This drives the real
// phone boot — shell panels, side docks, sidebar hub and the drawer — through
// the idle mount of the Bots page and the first drawer opening, with no tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
});
window.matchMedia = (query) => ({
  matches: /max-width/.test(String(query)),
  media: String(query),
  addEventListener() {},
  removeEventListener() {},
});

const PINS_KEY = 'mixdog.desktop.activity-rail-pins.v1';
const DEFAULT_PINS = ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions', 'skills'];
const LEAVES = [{ type: 'leaf', id: 'L1', tabs: [{ kind: 'session', id: 's1' }], activeKey: 'session:s1' }];

const { useAppShellPanels } = await import('../use-app-shell-panels.ts');
const { useAppSideDocks } = await import('../use-app-side-docks.ts');
const { useSessionPaneSurfaces } = await import('../use-session-pane-surfaces.ts');
const { useAppSidebarHub } = await import('./use-app-sidebar-hub.ts');
const { AppSidebarDrawer } = await import('./AppSidebarDrawer.tsx');

const settle = (ms = 50) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

/** One phone launch: the host answers the pins read after `hostDelayMs`. */
async function launchPhone(hostPins, { hostDelayMs = 0 } = {}) {
  window.mixdogDesktop = {
    readActivityRailPins: async () => {
      await new Promise((resolve) => setTimeout(resolve, hostDelayMs));
      return { pins: hostPins, revision: 1 };
    },
    updateActivityRailPins: async (pins) => ({ pins, revision: 2 }),
    subscribeActivityRailPins: () => () => {},
  };
  const picks = [];
  const live = {};
  function Phone() {
    const sessionPaneSurfaces = useSessionPaneSurfaces();
    const shellPanels = useAppShellPanels('L1');
    const sideDocks = useAppSideDocks({
      paneWorkspace: { leaves: LEAVES, focusedLeafId: 'L1' },
      sessionSurfaces: sessionPaneSurfaces,
      applySidebarOpen: shellPanels.applySidebarOpen,
    });
    const setActiveSideViews = (action) => {
      picks.push(action);
      return sideDocks.setActiveSideViews(action);
    };
    const hub = useAppSidebarHub({
      ...shellPanels,
      ...sideDocks,
      setActiveSideViews,
      ...sessionPaneSurfaces,
      projects: [],
      projectCatalogReady: true,
      selectedProjectPath: '',
      quickAccessProjectPath: '',
      extensionsSection: 'plugins',
      setExtensionsSection() {},
      closeSidebarForNavigation() {},
      startTask() {},
      openStudioTab() {},
      openSession: async () => {},
      refreshProjects: async () => [],
      renameProject: async () => {},
      removeProject: async () => {},
      runningAutomationNames: { schedule: new Set(), webhook: new Set() },
      focusedLeafIdRef: React.useRef('L1'),
      paneLeavesRef: React.useRef(LEAVES),
      paneLeaves: LEAVES,
      focusedLeafId: 'L1',
      onboardingOpen: false,
      setOnboardingOpen() {},
      quickAccessMode: null,
      setQuickAccessMode() {},
      pendingUnsavedClose: null,
      cancelPendingTabClose() {},
      updateDialogOpen: false,
      updaterState: { status: 'idle' },
      closeDesktopUpdate() {},
      sessionPaneSurfaces,
    });
    Object.assign(live, { shellPanels, sideDocks });
    return React.createElement(AppSidebarDrawer, {
      sidebarOpen: shellPanels.sidebarOpen,
      sidebarMotion: shellPanels.sidebarMotion,
      openSidebar: shellPanels.openSidebar,
      applySidebarOpen: shellPanels.applySidebarOpen,
      settingsOpen: false,
      setSettingsOpen() {},
      onboardingActive: false,
      closeSidebarForNavigation() {},
      openSettings() {},
      updaterState: { status: 'idle' },
      openDesktopUpdate() {},
      setCommandSurface() {},
      workbenchSideLayout: sideDocks.workbenchSideLayout,
      sideViewDescriptors: hub.sideViewDescriptors,
      activeSideViews: sideDocks.activeSideViews,
      selectWorkbenchSideView: hub.selectWorkbenchSideView,
      moveWorkbenchSideGroup: hub.moveWorkbenchSideGroup,
      moveWorkbenchSideView: hub.moveWorkbenchSideView,
      renderWorkbenchSideView: (_side, id) => React.createElement('div', { 'data-view': id }),
      sidebarDiff: null,
      closeSidebarDiff() {},
      openFileTab() {},
      mountedSidebarPanels: shellPanels.mountedSidebarPanels,
    });
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(Phone)));
  return {
    picks,
    active: () => live.sideDocks.activeSideViews.left,
    railTop: () => document.querySelector('.activity-rail-navigation > [data-side-view]')?.dataset.sideView,
    railCurrent: () => document.querySelector('.activity-rail-navigation [aria-current="page"]')?.dataset.sideView,
    shownView: () => document.querySelector('.workbench-side-panel-body:not([hidden]) [data-view]')?.dataset.view,
    /** The boot idle lane's hidden mount of the Bots page (use-app-boot mountBotsPage). */
    mountBotsPage: () => act(async () => live.shellPanels.mountSidebarPanel('agents')),
    /** The phone's home button (mixdog:mobile-home). */
    tapHome: () =>
      act(async () => {
        window.dispatchEvent(new Event('mixdog:mobile-home'));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }),
    sidebarOpen: () => live.shellPanels.sidebarOpen,
    end: () => act(async () => root.unmount()),
  };
}

test.afterEach(() => window.localStorage.clear());
test.after(() => restore());

test('the phone drawer first opens on the rail top, through the Bots page idle mount, with no pick', async () => {
  const phone = await launchPhone(DEFAULT_PINS);
  try {
    await settle(100);
    await phone.mountBotsPage();
    await settle(450);
    assert.equal(phone.railTop(), 'sessions');
    assert.equal(phone.active(), 'sessions', 'before any tap the start view is the rail top, not Bots');
    assert.equal(phone.shownView(), 'sessions');
    await phone.tapHome();
    assert.equal(phone.sidebarOpen(), true);
    assert.equal(phone.railCurrent(), 'sessions', 'the rail marks the top item on the first opening');
    assert.equal(phone.shownView(), 'sessions');
    assert.deepEqual(phone.picks, [], 'nothing picked a view on the user’s behalf');
  } finally {
    await phone.end();
  }
});

test('a host answer that arrives after boot moves the first opening to the new rail top', async () => {
  // The phone's cached pins are the old order; the host (the truth) reorders them.
  window.localStorage.setItem(PINS_KEY, JSON.stringify(DEFAULT_PINS));
  const hostPins = ['projects', ...DEFAULT_PINS.filter((id) => id !== 'projects')];
  const phone = await launchPhone(hostPins, { hostDelayMs: 150 });
  try {
    await phone.mountBotsPage();
    assert.equal(phone.active(), 'sessions', 'the cached order leads until the host answers');
    await settle(400);
    assert.equal(phone.railTop(), 'projects');
    assert.equal(phone.active(), 'projects');
    await phone.tapHome();
    assert.equal(phone.railCurrent(), 'projects');
    assert.equal(phone.shownView(), 'projects');
    assert.deepEqual(phone.picks, []);
  } finally {
    await phone.end();
  }
});
