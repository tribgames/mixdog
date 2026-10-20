// One tab strip for every side view: a bot opened from the Sessions sidebar
// becomes a tab of the shared strip (its name and face) while the Sessions
// view stays, and the Bots and Schedules views keep the strip above the main area.
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
const { AppWorkspaceMain } = await import('./AppWorkspaceMain.tsx');
const { navigationKey } = await import('../text-format.ts');
const { showDraftsInSessions } = await import('./bots-page-drafts.ts');

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

test('a new-task draft shown from the Bots page opens in Sessions and keeps its tab', async (t) => {
  // User: with a first new tab open, a second tab (a bot chat) in use, going
  // back to the first new tab made it vanish from the strip (탭 날라감).
  const { host, root } = mountRoot(t);
  let workspace = null;
  let select = null;
  function Harness() {
    workspace = usePaneWorkspace(null);
    const [botsPage, setBotsPage] = React.useState(true);
    const [selection, setSelection] = React.useState({ kind: 'new' });
    select = setSelection;
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    // The app's entries: the draft becomes the selection of the focused pane.
    const show = (next) => {
      setSelection(next);
      workspace.openInFocused(next);
    };
    const entries = showDraftsInSessions(() => setBotsPage(false), {
      startTask: (draft) => show(draft?.kind === 'new' ? draft : { kind: 'new', draftId: 'fresh' }),
      navigateTab: (tab) => show(tab.selection),
    });
    const chrome = useAppPaneChrome({
      tabs: [],
      sessions: [],
      paneWorkspace: workspace,
      dirtyFileKeys: new Set(),
      workingSessionIds: new Set(),
      unreadSessionIds: new Set(),
      selectionRef,
      viewedSessionRef: { current: '' },
      unreadViewedSessionRef: { current: '' },
      setSelection,
      startTask: entries.startTask,
      activateSelection() {},
      openFileTab() {},
      startProject() {},
      navigateTab: entries.navigateTab,
      closeTab() {},
      pinPaneTab() {},
      renameSession: async () => {},
      lastSessionStorageKey: 'test:last-session',
    });
    return React.createElement(AppWorkspaceMain, {
      navigationSelection: selection,
      visibleSessionTitle: '',
      selection,
      projects: [],
      errors: [],
      paneWorkspace: workspace,
      observedAgentSessionIds: [],
      paneStripFor: chrome.paneStripFor,
      paneConversationSurface: (shown) =>
        React.createElement('div', { className: 'test-conversation' }, navigationKey(shown)),
      paneFileEditors: null,
      paneUtilityTabs: null,
      renderPaneSideDock: () => null,
      renderPaneProblems: () => null,
      activatePaneSurface() {},
      openDroppedPaths: async () => {},
      agentsPageOpen: botsPage,
    });
  }
  await act(async () => root.render(React.createElement(Harness)));
  const stripKeys = () => [...host.querySelectorAll('.workspace-tab[data-tab-key]')].map((tab) => tab.dataset.tabKey);
  const activeKey = () => host.querySelector('.workspace-tab.active')?.dataset.tabKey;
  const shownDrafts = () =>
    [...host.querySelectorAll('.test-conversation')].filter((node) => node.textContent.startsWith('new:'));

  // Bots: a new tab beside the bot chat in use.
  const chat = { kind: 'session', id: 'sess_home_github-watcher' };
  await act(async () => workspace.openInFocused(chat));
  await act(async () => workspace.openInFocused({ kind: 'new', draftId: 'first' }));
  await act(async () => {
    workspace.openInFocused(chat);
    select(chat);
  });
  await settle();
  const tabs = ['session:sess_home_github-watcher', 'new:first'];
  assert.deepEqual(stripKeys(), tabs);

  // Back to the new tab: Sessions shows it, still on the strip.
  await act(async () => host.querySelector('.workspace-tab[data-tab-key="new:first"] .workspace-tab-main').click());
  assert.deepEqual(stripKeys(), tabs);
  assert.equal(activeKey(), 'new:first');
  assert.equal(shownDrafts().length, 1, 'its composer is back');
  assert.equal(host.querySelector('[data-agents-empty]'), null);
});

test('the strip’s + on the Bots page opens its new task in Sessions', async (t) => {
  const { host, root } = mountRoot(t);
  const calls = [];
  function Harness() {
    const workspace = usePaneWorkspace(null);
    const entries = showDraftsInSessions(() => calls.push('leaveBotsPage'), {
      startTask: () => calls.push('startTask'),
      navigateTab: () => calls.push('navigateTab'),
    });
    const chrome = useAppPaneChrome({
      tabs: [],
      sessions: [],
      paneWorkspace: workspace,
      dirtyFileKeys: new Set(),
      workingSessionIds: new Set(),
      unreadSessionIds: new Set(),
      selectionRef: { current: { kind: 'new' } },
      viewedSessionRef: { current: '' },
      unreadViewedSessionRef: { current: '' },
      setSelection() {},
      startTask: entries.startTask,
      activateSelection() {},
      openFileTab() {},
      startProject() {},
      navigateTab: entries.navigateTab,
      closeTab() {},
      pinPaneTab() {},
      renameSession: async () => {},
      lastSessionStorageKey: 'test:last-session',
    });
    return React.createElement('div', null, ...workspace.leaves.map((leaf) => chrome.paneStripFor(leaf)));
  }
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => host.querySelector('.workspace-tab-new').click());
  assert.deepEqual(calls, ['leaveBotsPage', 'startTask']);
  // A session tab is not a draft: Bots stays.
  calls.length = 0;
  showDraftsInSessions(() => calls.push('leaveBotsPage'), {
    startTask() {},
    navigateTab: () => calls.push('navigateTab'),
  }).navigateTab({ key: 'session:sess_a', title: '', selection: { kind: 'session', id: 'sess_a' } });
  assert.deepEqual(calls, ['navigateTab']);
});

test('the Bots and Schedules views keep the tab strip above the main area', async (t) => {
  const { host, root } = mountRoot(t);
  let workspace = null;
  function Harness({ agentsPageOpen }) {
    workspace = usePaneWorkspace(null);
    return React.createElement(AppWorkspaceMain, {
      // The focused pane's draft tab is active.
      navigationSelection: { kind: 'new' },
      visibleSessionTitle: 'New task',
      selection: { kind: 'new' },
      projects: [],
      errors: [],
      paneWorkspace: workspace,
      observedAgentSessionIds: [],
      paneStripFor: (leaf) =>
        leaf.tabs.length
          ? React.createElement('div', { className: 'test-strip' }, leaf.tabs.map(navigationKey).join(','))
          : null,
      paneConversationSurface: (selection) =>
        React.createElement('div', { className: 'test-conversation' }, navigationKey(selection)),
      paneFileEditors: null,
      paneUtilityTabs: null,
      renderPaneSideDock: () => null,
      renderPaneProblems: () => null,
      activatePaneSurface() {},
      openDroppedPaths: async () => {},
      agentsPageOpen,
    });
  }
  const render = (agentsPageOpen) => act(async () => root.render(React.createElement(Harness, { agentsPageOpen })));
  const strip = () => host.querySelector('.test-strip')?.textContent ?? null;
  const shownDrafts = () =>
    [...host.querySelectorAll('.test-conversation')].filter((node) => node.textContent.startsWith('new:'));

  // Bots with only the untouched new-task draft: an empty main area, no
  // draft tab, composer or logo.
  await render(true);
  assert.equal(workspace.leaves.length, 1);
  assert.equal(strip(), null, 'no draft tab and no strip without real tabs');
  assert.equal(shownDrafts().length, 0, 'no draft composer');
  assert.ok(host.querySelector('[data-agents-empty]'), 'an empty main area');

  // Schedules (any other side view), and Sessions again: the draft is back.
  await render(false);
  assert.equal(strip(), 'new:default', 'the shared strip shows its tabs');
  assert.equal(shownDrafts().length, 1);
  assert.equal(host.querySelector('[data-agents-empty]'), null);

  // Real tabs beside the active draft: Bots keeps them in the strip, without the draft.
  await act(async () => workspace.openInFocused({ kind: 'session', id: 'sess_real' }));
  await act(async () => workspace.openInFocused({ kind: 'new', draftId: 'second' }));
  const keys = workspace.leaves[0].tabs.map(navigationKey);
  assert.ok(keys.includes('session:sess_real') && keys.some((key) => key.startsWith('new:')), keys.join(','));
  await render(true);
  assert.equal(strip(), 'session:sess_real', 'the strip keeps its real tabs only');
  assert.equal(shownDrafts().length, 0);
  assert.ok(host.querySelector('[data-agents-empty]'));
  await render(false);
  assert.equal(strip(), keys.join(','));
});
