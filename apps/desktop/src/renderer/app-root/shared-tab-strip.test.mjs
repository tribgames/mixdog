// One tab strip for every side view: a bot opened from the Sessions sidebar
// becomes a tab of the shared strip (its name and face) while the Sessions
// view stays.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/', pretendToBeVisual: true },
  expose: ['Element', 'HTMLElement', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent', 'navigator'],
});
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.MutationObserver ??= window.MutationObserver;

const AGENTS = [
  {
    id: 'github-watcher',
    custom: true,
    kind: 'bot',
    definition: { name: 'GitHub Watcher' },
    route: { provider: 'anthropic', model: 'claude-x' },
    avatar: { kind: 'mascot', variant: 'perky-calm-collar', color: '#5b9bff' },
  },
];
window.mixdogDesktop = {
  invokeCapability: async ({ capability }) => ({ value: capability === 'listAgents' ? AGENTS : null }),
  openAgentHome: async (agentId) => ({ sessionId: `sess_home_${agentId}` }),
};

const { usePaneWorkspace } = await import('../pane-workspace-state.ts');
const { useAppPaneChrome } = await import('../use-app-pane-chrome.tsx');
const { useAppWorkbenchViews } = await import('./use-app-workbench-views.tsx');
const { navigationKey } = await import('../text-format.ts');

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

function mountRoot(t) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { host, root };
}

function workbenchViewOptions(paneWorkspace, overrides) {
  return {
    sessions: [],
    sessionCatalogReady: true,
    projects: [],
    workingSessionIds: new Set(),
    unreadSessionIds: new Set(),
    sidebarSelection: { kind: 'new' },
    sidebarNewTask() {},
    sidebarNewStudio() {},
    prefetchSession: async () => true,
    sidebarResumeSession() {},
    renameSession: async () => {},
    archiveSession: async () => {},
    favoriteSession: async () => {},
    deleteSession: async () => {},
    sideViewDescriptors: new Map(),
    renderSidebarPanel: () => null,
    mountedSidebarPanels: new Set(),
    snapshotStore: { get: () => ({}) },
    observedAgentSessionIds: [],
    quickAccessProjectPath: '',
    workbenchWorkspace: { workspace: { folders: [] } },
    selectToolProject() {},
    dockOpenFile() {},
    dockOpenFileAt() {},
    dockOpenDiff() {},
    dockOpenPullRequest() {},
    dockOpenLeadSession() {},
    paneSideDocks: { entryFor: () => ({}), select() {}, openDiff() {} },
    setSidebarDiff() {},
    registeredProjectPath: (path) => path,
    resolvedDraftPrefsFor: () => ({ projectPath: '' }),
    paneWorkspace,
    sessionPaneSurfaces: {},
    workbenchSideLayout: { layout: { left: [], right: [] } },
    closePaneRightRegion() {},
    moveWorkbenchSideGroup() {},
    moveWorkbenchSideView() {},
    openFileTab() {},
    desktopBootReady: false,
    bottomPanel: { open: false },
    problemsFilter: {},
    setProblemsFilter() {},
    problemsCollapseNonce: 0,
    setProblemsCollapseNonce() {},
    openProblemQuickFix() {},
    ...overrides,
  };
}

test('a bot clicked in the Sessions sidebar opens as a tab of the shared strip; the Sessions view stays', async (t) => {
  const { host, root } = mountRoot(t);
  const selectedViews = [];
  const opened = [];
  function Harness() {
    const workspace = usePaneWorkspace(null);
    const [tabs, setTabs] = React.useState([]);
    // The app's openSession: registers the tab and opens it in the focused pane.
    const dockOpenAgentSession = (sessionId, title, ownerSessionId) => {
      opened.push([sessionId, title, ownerSessionId]);
      const selection = { kind: 'session', id: sessionId };
      setTabs((current) => [...current, { key: navigationKey(selection), title, selection }]);
      workspace.openInFocused(selection);
    };
    const views = useAppWorkbenchViews(
      workbenchViewOptions(workspace, {
        dockOpenAgentSession,
        selectWorkbenchSideView: (id) => selectedViews.push(id),
      })
    );
    const chrome = useAppPaneChrome({
      tabs,
      sessions: [],
      paneWorkspace: workspace,
      dirtyFileKeys: new Set(),
      workingSessionIds: new Set(),
      unreadSessionIds: new Set(),
      selectionRef: { current: { kind: 'new' } },
      viewedSessionRef: { current: '' },
      unreadViewedSessionRef: { current: '' },
      setSelection() {},
      startTask() {},
      activateSelection() {},
      openFileTab() {},
      startProject() {},
      navigateTab() {},
      closeTab() {},
      pinPaneTab() {},
      renameSession: async () => {},
      lastSessionStorageKey: 'test:last-session',
    });
    return React.createElement(
      'div',
      null,
      views.renderWorkbenchSideView('left', 'sessions', true, {}),
      ...workspace.leaves.map((leaf) =>
        React.createElement('div', { key: leaf.id, className: 'test-strip' }, chrome.paneStripFor(leaf))
      )
    );
  }
  await act(async () => root.render(React.createElement(Harness)));
  await settle();
  const row = host.querySelector('[data-agent-contact="github-watcher"] .session-row-main');
  assert.ok(row, 'the Sessions sidebar lists the bot');
  await act(async () => row.click());
  await settle();

  assert.deepEqual(opened, [['sess_home_github-watcher', 'GitHub Watcher', 'sess_home_github-watcher']]);
  assert.deepEqual(selectedViews, [], 'the side view stays on Sessions');
  const strip = host.querySelector('.test-strip');
  assert.equal(strip.querySelector('.mx-chat-header'), null, 'no bot-only header in the strip’s place');
  const tab = strip.querySelector('.workspace-tab[data-tab-key="session:sess_home_github-watcher"]');
  assert.ok(tab, 'the bot chat is a tab of the strip');
  assert.ok(tab.classList.contains('active'));
  assert.equal(tab.querySelector('.workspace-tab-main > span:last-child').textContent, 'GitHub Watcher');
  assert.ok(tab.querySelector('.workspace-tab-main > .mx-chat-tab-face svg'), 'the tab carries the bot’s face');
  assert.ok(strip.querySelector('.workspace-tab-new'), 'the strip keeps its +');
});
