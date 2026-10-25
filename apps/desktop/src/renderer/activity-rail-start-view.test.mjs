// The sidebar opens on the view at the top of the activity rail, and the rail's
// order lives in the pins store alone: reordering pins (the call the rail's
// drag-and-drop makes) moves the start view, and the layout cannot disagree.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ActivityRailNavigation } from './activity-rail-navigation.tsx';
import { useAppSideDocks } from './use-app-side-docks.ts';
import { useSideViewSelection } from './app-shell-side-views.ts';
import { useSessionPaneSurfaces } from './use-session-pane-surfaces.ts';
import { installTestDom } from './test-support/test-dom.mjs';

const PINS_KEY = 'mixdog.desktop.activity-rail-pins.v1';
const LAYOUT_KEY = 'mixdog.desktop.workbench-side-view-layout.v1';
const LAYOUT_MIGRATION_KEY = 'mixdog.desktop.workbench-side-view-layout.pane-bound-right.v1';
const LEAVES = [{ type: 'leaf', id: 'L1', tabs: [{ kind: 'session', id: 's1' }], activeKey: 'session:s1' }];
const DEFAULT_ORDER = ['sessions', 'agents', 'schedules', 'workflows', 'projects', 'extensions', 'skills'];
const Icon = () => React.createElement('span');

function fakeHost(pins) {
  let state = pins ? { pins, revision: 1 } : null;
  const listeners = new Set();
  return {
    readActivityRailPins: async () => state,
    updateActivityRailPins: async (next) => {
      state = { pins: next, revision: (state?.revision ?? 0) + 1 };
      for (const listener of listeners) listener(state);
      return state;
    },
    subscribeActivityRailPins: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function setup(t) {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  const mounted = [];
  t.after(async () => {
    for (const root of mounted) await act(async () => root.unmount());
    restore();
  });
  /** One app launch: the side docks and the real rail over the same host. */
  const launch = async (host) => {
    window.mixdogDesktop = host;
    const record = { sidebarOpen: false };
    function App() {
      const [, rerender] = React.useState(0);
      const sessionSurfaces = useSessionPaneSurfaces();
      const sideDocks = useAppSideDocks({
        paneWorkspace: { leaves: LEAVES, focusedLeafId: 'L1' },
        sessionSurfaces,
        applySidebarOpen: (open) => {
          record.sidebarOpen = open;
          rerender((count) => count + 1);
        },
      });
      // The real sidebar selection (rail click / drawer toggle), wired as the hub does.
      const selectView = useSideViewSelection({
        sideOf: sideDocks.workbenchSideLayout.sideOf,
        selectDock: sideDocks.paneSideDocks.select,
        activeSideViews: sideDocks.activeSideViews,
        setActiveSideViews: sideDocks.setActiveSideViews,
        sidebarOpen: record.sidebarOpen,
        applySidebarOpen: (open) => {
          record.sidebarOpen = open;
          rerender((count) => count + 1);
        },
        closeSidebarPanels: () => {},
        mountSidebarPanel: () => {},
        trackSidebarPanelModule: () => {},
        refreshProjects: async () => {},
        paneLeavesRef: { current: LEAVES },
        focusedLeafIdRef: { current: 'L1' },
        paneLeaves: LEAVES,
        focusedLeafId: 'L1',
        browserSurfaces: sessionSurfaces.browserSurfaces,
        pendingBrowserAutoReveal: sessionSurfaces.pendingBrowserAutoReveal,
        setSessionSideSurface: sessionSurfaces.setSessionSideSurface,
        setSessionPanelView: sessionSurfaces.setSessionPanelView,
      });
      Object.assign(record, { sideDocks, selectView, rerender });
      return React.createElement(ActivityRailNavigation, {
        entries: sideDocks.workbenchSideLayout.layout.left.flat().map((id) => ({ id, label: id, icon: Icon })),
        activeId: sideDocks.activeSideViews.left,
        onSelect: selectView,
      });
    }
    document.getElementById('root').replaceChildren(document.createElement('div'));
    const root = createRoot(document.getElementById('root').firstChild);
    mounted.push(root);
    await act(async () => root.render(React.createElement(App)));
    await act(async () => {});
    return {
      active: () => record.sideDocks.activeSideViews.left,
      railTop: () => document.querySelector('.activity-rail-navigation > [data-side-view]')?.dataset.sideView,
      /** The rail click / drawer selection handler. */
      select: (id) => act(async () => record.selectView(id)),
      /** The dock-tab open handler (OPEN_DOCK_TAB_EVENT). */
      openTab: (tab) => act(async () => record.sideDocks.openDockTab(tab)),
      sidebarOpen: () => record.sidebarOpen,
      setSidebarOpen: (open) =>
        act(async () => {
          record.sidebarOpen = open;
          record.rerender((count) => count + 1);
        }),
      end: async () => {
        mounted.splice(mounted.indexOf(root), 1);
        await act(async () => root.unmount());
      },
    };
  };
  return launch;
}

test('reordering the pins moves the start view of the next launch to the new top', async (t) => {
  const launch = setup(t);
  const host = fakeHost(DEFAULT_ORDER);
  const first = await launch(host);
  assert.equal(first.active(), 'sessions');
  assert.equal(first.railTop(), 'sessions');
  await first.end();

  // The same call the rail's drag-and-drop makes, then a reload with a stale local cache.
  await host.updateActivityRailPins(['projects', 'sessions', 'agents', 'schedules', 'workflows', 'extensions', 'skills']);
  window.localStorage.setItem(PINS_KEY, JSON.stringify(DEFAULT_ORDER));
  const second = await launch(host);
  assert.equal(second.railTop(), 'projects');
  assert.equal(second.active(), 'projects');
});

test('a stored layout that disagrees with the pins cannot decide the start view', async (t) => {
  const launch = setup(t);
  window.localStorage.setItem(LAYOUT_MIGRATION_KEY, '1');
  window.localStorage.setItem(
    LAYOUT_KEY,
    JSON.stringify({ left: [['agents'], ['sessions'], ['projects'], ['skills']], right: [] })
  );
  const app = await launch(fakeHost(['skills', 'projects', 'agents', 'sessions']));
  assert.equal(app.railTop(), 'skills');
  assert.equal(app.active(), 'skills');
});

test('an unpinned view never leads, even first in the layout', async (t) => {
  const launch = setup(t);
  window.localStorage.setItem(LAYOUT_MIGRATION_KEY, '1');
  window.localStorage.setItem(LAYOUT_KEY, JSON.stringify({ left: [['sessions'], ['agents'], ['projects']], right: [] }));
  const app = await launch(fakeHost(['projects', 'agents']));
  assert.equal(app.railTop(), 'projects');
  assert.equal(app.active(), 'projects');
});

test('the start view follows the pins until the user picks a view, then the pick holds', async (t) => {
  const launch = setup(t);
  const host = fakeHost(DEFAULT_ORDER);
  const app = await launch(host);
  assert.equal(app.active(), 'sessions');
  await act(async () => {
    await host.updateActivityRailPins(['skills', ...DEFAULT_ORDER.filter((id) => id !== 'skills')]);
  });
  assert.equal(app.railTop(), 'skills');
  assert.equal(app.active(), 'skills', 'before any pick the start view is the rail top');
  await app.select('schedules');
  await act(async () => {
    await host.updateActivityRailPins(['projects', ...DEFAULT_ORDER.filter((id) => id !== 'projects')]);
  });
  assert.equal(app.railTop(), 'projects');
  assert.equal(app.active(), 'schedules', 'a picked view is not pulled back to the rail top');
});

const reorder = (host, first) =>
  act(async () => {
    await host.updateActivityRailPins([first, ...DEFAULT_ORDER.filter((id) => id !== first)]);
  });

test('selecting the already-active view through the sidebar handler still freezes the view', async (t) => {
  const launch = setup(t);
  const host = fakeHost(DEFAULT_ORDER);
  const app = await launch(host);
  assert.equal(app.active(), 'sessions');
  await app.select('sessions');
  assert.equal(app.sidebarOpen(), true);
  await reorder(host, 'projects');
  assert.equal(app.railTop(), 'projects');
  assert.equal(app.active(), 'sessions');
});

test('clicking the shown view to fold the drawer still freezes the view', async (t) => {
  const launch = setup(t);
  const host = fakeHost(DEFAULT_ORDER);
  const app = await launch(host);
  await app.setSidebarOpen(true);
  await app.select('sessions');
  assert.equal(app.sidebarOpen(), false, 'the shown view toggles the drawer closed');
  await reorder(host, 'projects');
  assert.equal(app.active(), 'sessions');
});

test('opening the already-active dock tab freezes the view against a later reorder', async (t) => {
  const launch = setup(t);
  const host = fakeHost(['agents', ...DEFAULT_ORDER.filter((id) => id !== 'agents')]);
  const app = await launch(host);
  assert.equal(app.active(), 'agents');
  await app.openTab('agents');
  await reorder(host, 'sessions');
  assert.equal(app.railTop(), 'sessions');
  assert.equal(app.active(), 'agents');
});

test('without a pick, a reorder still moves the start view', async (t) => {
  const launch = setup(t);
  const host = fakeHost(['agents', ...DEFAULT_ORDER.filter((id) => id !== 'agents')]);
  const app = await launch(host);
  assert.equal(app.active(), 'agents');
  await reorder(host, 'sessions');
  assert.equal(app.active(), 'sessions');
});
