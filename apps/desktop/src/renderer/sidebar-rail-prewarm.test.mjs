// Rail pages are prepared before the user opens them (user: 사이드 뷰가 늦게
// 뜨고 튐): a page whose chunk and reference data are already held paints its
// rows in the very commit that shows it, never through a loading surface.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, Suspense, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'CustomEvent'],
  globals: {
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  },
});
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
// The desktop window (not the phone layout): the Electron shell's renderer.
Object.defineProperty(window.navigator, 'userAgent', {
  configurable: true,
  value: `${window.navigator.userAgent} Electron/38.0.0`,
});

const { resetSidebarReferenceCache, updateSidebarReference, invalidateSidebarReferenceForMutation } = await import(
  './sidebar-reference-cache.ts'
);
const { SchedulesPane } = await import('./SchedulesView.tsx');
const { WebhooksPane } = await import('./WebhooksView.tsx');
const { WorkflowsPane } = await import('./WorkflowsView.tsx');

function seedReferences(channelSetup) {
  resetSidebarReferenceCache();
  updateSidebarReference('channelSetup', channelSetup);
  updateSidebarReference('projects', []);
  updateSidebarReference('workflows', [{ id: 'default', name: 'Daily rules', description: 'House rules' }]);
  updateSidebarReference('agents', []);
  updateSidebarReference('providerSetup', {});
  updateSidebarReference('quickProviderModels', []);
  updateSidebarReference('webSearchRoute', {});
  updateSidebarReference('webSearchModels', []);
}

const CHANNEL_SETUP = {
  schedules: [{ name: 'daily-report', description: 'Daily report', time: '0 9 * * *', enabled: true }],
  webhooks: [{ name: 'github-push', description: 'GitHub push', parser: 'github', enabled: true }],
};

/** Reads that never answer: anything on screen came from the cache. */
function pendingApi(calls = []) {
  return {
    calls,
    invokeCapability(request) {
      calls.push(request.capability);
      return new Promise(() => {});
    },
  };
}

function mount() {
  const root = createRoot(document.querySelector('main'));
  let firstCommit = null;
  function FirstCommit({ children }) {
    // The DOM of the very commit that shows the page, before any effect runs.
    useLayoutEffect(() => {
      firstCommit ??= document.querySelector('main').cloneNode(true);
    });
    return children;
  }
  return {
    render: (node) => act(async () => root.render(React.createElement(FirstCommit, null, node))),
    firstCommit: () => firstCommit,
    resetFirstCommit: () => {
      firstCommit = null;
    },
    host: () => document.querySelector('main'),
    unmount: () => act(async () => root.unmount()),
  };
}

for (const [label, Pane, row] of [
  ['Schedules', SchedulesPane, /daily-report/],
  ['Webhooks', WebhooksPane, /github-push/],
  ['Workflows', WorkflowsPane, /Daily rules/],
]) {
  test(`${label} with cached references renders its rows without the InitialSurface`, async () => {
    seedReferences(CHANNEL_SETUP);
    const view = mount();
    try {
      const api = pendingApi();
      // Pre-mounted hidden, then shown: neither commit passes through a cover.
      await view.render(React.createElement(Pane, { api, active: false }));
      assert.equal(view.firstCommit().querySelector('.initial-surface'), null);
      assert.match(view.firstCommit().textContent, row);
      view.resetFirstCommit();
      await view.render(React.createElement(Pane, { api, active: true }));
      assert.equal(view.firstCommit().querySelector('.initial-surface'), null);
      assert.equal(view.host().querySelector('[aria-busy="true"]'), null);
      assert.match(view.host().textContent, row);
    } finally {
      await view.unmount();
    }
  });
}

test('a hidden pre-mounted page follows a push, so its next opening is already fresh', async () => {
  seedReferences(CHANNEL_SETUP);
  const view = mount();
  try {
    const answer = Promise.withResolvers();
    const calls = [];
    const api = {
      invokeCapability(request) {
        calls.push(request.capability);
        return request.capability === 'getChannelSetup' ? answer.promise : new Promise(() => {});
      },
    };
    await view.render(React.createElement(SchedulesPane, { api, active: false }));
    assert.deepEqual(calls, [], 'a fresh cache costs the hidden mount nothing');
    // A setup-tool change pushed while the page is hidden (setup-change-refresh).
    await act(async () => {
      invalidateSidebarReferenceForMutation('saveSchedule');
      await Promise.resolve();
    });
    assert.deepEqual(calls, ['getChannelSetup']);
    // The stale rows stay until the fresh snapshot replaces them.
    assert.match(view.host().textContent, /daily-report/);
    await act(async () => {
      answer.resolve({ value: { schedules: [{ name: 'weekly-review', time: '0 9 * * 1', enabled: true }] } });
      await answer.promise;
    });
    view.resetFirstCommit();
    await view.render(React.createElement(SchedulesPane, { api, active: true }));
    assert.equal(view.firstCommit().querySelector('.initial-surface'), null);
    assert.match(view.firstCommit().textContent, /weekly-review/);
    assert.doesNotMatch(view.firstCommit().textContent, /daily-report/);
    assert.deepEqual(calls, ['getChannelSetup'], 'opening a fresh page reads nothing again');
  } finally {
    await view.unmount();
  }
});

test('the desktop idle mount reaches a rail page already retained hidden', async () => {
  const { AppSidebarDrawer } = await import('./app-root/AppSidebarDrawer.tsx');
  const Icon = () => null;
  const hiddenRenders = [];
  let mounted = new Set();
  const props = {
    sidebarOpen: true,
    sidebarMotion: 'instant',
    sidebarPanel: null,
    closeSidebarPanels() {},
    openSidebar() {},
    toggleSidebar() {},
    applySidebarOpen() {},
    settingsOpen: false,
    openProjects() {},
    refreshProjects: async () => {},
    trackSidebarPanelModule() {},
    openSchedules() {},
    openWebhooks() {},
    closeActiveRailPanel() {},
    closeSidebarForNavigation() {},
    openSettings() {},
    setSettingsOpen() {},
    setCommandSurface() {},
    workbenchSideLayout: {
      layout: { left: [['sessions'], ['schedules']], right: [] },
      sideOf: () => 'left',
      moveGroup() {},
      moveView() {},
    },
    sideViewDescriptors: new Map([
      ['sessions', { id: 'sessions', label: 'Sessions', icon: Icon }],
      ['schedules', { id: 'schedules', label: 'Schedules', icon: Icon }],
    ]),
    activeSideViews: { left: 'sessions', right: null },
    selectWorkbenchSideView() {},
    moveWorkbenchSideGroup() {},
    moveWorkbenchSideView() {},
    renderWorkbenchSideView: (_side, id, active) => {
      if (id === 'schedules' && !active) hiddenRenders.push(mounted.has('schedules'));
      return React.createElement('div', { className: `side-view-${id}` });
    },
    sidebarDiff: null,
    closeSidebarDiff() {},
    openFileTab() {},
  };
  const root = createRoot(document.querySelector('main'));
  try {
    await act(async () =>
      root.render(React.createElement(AppSidebarDrawer, { ...props, mountedSidebarPanels: mounted }))
    );
    // The idle pre-retain hidden-mounts every destination shortly after boot.
    await act(() => new Promise((resolve) => setTimeout(resolve, 450)));
    assert.deepEqual(hiddenRenders, [false], 'retained hidden before the lane mounts the page');
    mounted = new Set(['schedules']);
    await act(async () =>
      root.render(React.createElement(AppSidebarDrawer, { ...props, mountedSidebarPanels: mounted }))
    );
    assert.deepEqual(hiddenRenders, [false, true], 'the mount renders the hidden page once more');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a rail page whose chunk is loaded renders in its first commit, never through the Suspense fallback', async () => {
  seedReferences(CHANNEL_SETUP);
  const { createSchedulesPane, loadSidebarPanelModule } = await import('./app-shell-components.tsx');
  await loadSidebarPanelModule.schedules();
  const RailSchedules = createSchedulesPane();
  const view = mount();
  try {
    await view.render(
      React.createElement(
        Suspense,
        { fallback: React.createElement('i', { className: 'suspense-fallback' }) },
        React.createElement(RailSchedules, { api: pendingApi(), active: true })
      )
    );
    const commit = view.firstCommit();
    assert.equal(commit.querySelector('.suspense-fallback'), null);
    assert.equal(commit.querySelector('.initial-surface'), null);
    assert.match(commit.textContent, /daily-report/);
  } finally {
    await view.unmount();
  }
});
