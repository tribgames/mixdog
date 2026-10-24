// Switching activity-rail pages (Sessions ↔ Bots) only swaps the side panel's
// list. The active tab, the tab strip, a draft's text and the panel's open
// state stay as they were; only a row click opens or activates a tab. Clicking
// the selected rail icon again still toggles the panel.
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

const calls = [];
window.mixdogDesktop = {
  listAgentPool: async () => [],
  subscribeAgentPool: () => () => {},
  listProviderModels: async () => [],
  listProjects: async () => [],
  invokeCapability: async ({ capability }) => {
    if (capability === 'getLeadStatus') return { value: { created: true, name: 'Momo', avatar: null } };
    return { value: capability === 'listAgents' ? [] : null };
  },
  openAgentHome: async (agentId) => {
    calls.push(['openAgentHome', agentId]);
    return { sessionId: `sess_home_${agentId}` };
  },
};

const { usePaneWorkspace } = await import('../pane-workspace-state.ts');
const { paneActiveSelection } = await import('../pane-layout.ts');
const { useAppPaneChrome } = await import('../use-app-pane-chrome.tsx');
const { useSideViewSelection } = await import('../app-shell-side-views.ts');
const { AgentActivityPane } = await import('../AgentActivityPane.tsx');
const { AppWorkspaceMain } = await import('./AppWorkspaceMain.tsx');
const { navigationKey } = await import('../text-format.ts');

const settle = () =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });

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

test('Sessions → Bots → Sessions keeps the active tab, the strip, the draft text and the open panel', async (t) => {
  const { host, root } = mountRoot(t);
  calls.length = 0;
  const opened = [];
  let workspace = null;
  function Harness() {
    workspace = usePaneWorkspace(null);
    const [activeSideViews, setActiveSideViews] = React.useState({ left: 'sessions', right: null });
    const [sidebarOpen, setSidebarOpen] = React.useState(true);
    const selectView = useSideViewSelection({
      sideOf: () => 'left',
      selectDock() {},
      activeSideViews,
      setActiveSideViews,
      sidebarOpen,
      applySidebarOpen: setSidebarOpen,
      closeSidebarPanels() {},
      mountSidebarPanel() {},
      trackSidebarPanelModule() {},
      refreshProjects: async () => {},
      paneLeavesRef: { current: workspace.leaves },
      focusedLeafIdRef: { current: workspace.focusedLeafId },
      paneLeaves: workspace.leaves,
      focusedLeafId: workspace.focusedLeafId,
      browserSurfaces: { ensure() {} },
      pendingBrowserAutoReveal: { current: new Set() },
      setSessionSideSurface() {},
      setSessionPanelView() {},
    });
    const focused = workspace.leaves.find((leaf) => leaf.id === workspace.focusedLeafId) ?? workspace.leaves[0];
    const selection = (focused && paneActiveSelection(focused)) ?? { kind: 'new' };
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
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
    const panel = !sidebarOpen
      ? null
      : activeSideViews.left === 'agents'
        ? React.createElement(AgentActivityPane, {
            active: true,
            sessions: [],
            onOpenSession: (id, title) => {
              opened.push([id, title]);
              workspace.openInFocused({ kind: 'session', id });
            },
          })
        : React.createElement('div', { className: 'test-sessions-list' }, 'sessions');
    return React.createElement(
      'div',
      null,
      ...['sessions', 'agents'].map((id) =>
        React.createElement(
          'button',
          { key: id, type: 'button', 'data-side-view': id, onClick: () => selectView(id) },
          id
        )
      ),
      React.createElement('aside', { className: 'test-panel' }, panel),
      React.createElement(AppWorkspaceMain, {
        navigationSelection: selection,
        visibleSessionTitle: '',
        selection,
        projects: [],
        errors: [],
        paneWorkspace: workspace,
        observedAgentSessionIds: [],
        paneStripFor: chrome.paneStripFor,
        paneConversationSurface: (shown) =>
          React.createElement(
            'div',
            { className: 'test-conversation', 'data-surface': navigationKey(shown) },
            shown.kind === 'new' ? React.createElement('textarea', { className: 'test-draft' }) : null
          ),
        paneFileEditors: null,
        paneUtilityTabs: null,
        renderPaneSideDock: () => null,
        renderPaneProblems: () => null,
        activatePaneSurface() {},
        openDroppedPaths: async () => {},
      })
    );
  }
  await act(async () => root.render(React.createElement(Harness)));

  const rail = (id) => host.querySelector(`button[data-side-view="${id}"]`);
  const stripKeys = () => [...host.querySelectorAll('.workspace-tab[data-tab-key]')].map((tab) => tab.dataset.tabKey);
  const activeKey = () => host.querySelector('.workspace-tab.active')?.dataset.tabKey;
  const surfaces = () => [...host.querySelectorAll('.test-conversation')].map((node) => node.dataset.surface);
  const draft = () => host.querySelector('.test-draft');
  const state = () => ({
    strip: stripKeys(),
    active: activeKey(),
    surfaces: surfaces(),
    draftText: draft()?.value ?? null,
    list: host.querySelector('.test-sessions-list')
      ? 'sessions'
      : host.querySelector('.agent-contact-list')
        ? 'bots'
        : null,
  });
  const click = async (id) => {
    await act(async () => rail(id).click());
    await settle();
  };

  // A coding session and an untouched-then-typed draft, the draft active.
  const coding = { kind: 'session', id: 'work-1' };
  await act(async () => workspace.openInFocused(coding));
  await act(async () => workspace.openInFocused({ kind: 'new', draftId: 'd1' }));
  await settle();
  draft().value = 'half-written task';
  const tabs = ['session:work-1', 'new:d1'];
  assert.deepEqual(stripKeys(), tabs);
  assert.equal(activeKey(), 'new:d1');
  const before = state();
  assert.equal(before.list, 'sessions');
  assert.equal(before.draftText, 'half-written task');

  // Sessions → Bots → Sessions, twice, with the draft active.
  for (let round = 0; round < 2; round += 1) {
    await click('agents');
    assert.equal(state().list, 'bots', 'the Bots list shows');
    assert.deepEqual({ ...state(), list: null }, { ...before, list: null }, 'Bots changes only the panel list');
    await click('sessions');
    assert.deepEqual(state(), before, 'back on Sessions nothing else moved');
  }

  // The coding session active: same round trip.
  await act(async () => workspace.openInFocused(coding));
  await settle();
  assert.equal(activeKey(), 'session:work-1');
  const codingState = state();
  assert.deepEqual(codingState.strip, tabs);
  for (let round = 0; round < 2; round += 1) {
    await click('agents');
    assert.equal(state().list, 'bots');
    assert.deepEqual({ ...state(), list: null }, { ...codingState, list: null });
    await click('sessions');
    assert.deepEqual(state(), codingState);
  }
  await act(async () => workspace.openInFocused({ kind: 'new', draftId: 'd1' }));
  await settle();

  // Nothing was opened by showing the Bots page; the selected rail icon still toggles the panel.
  assert.deepEqual(opened, []);
  assert.equal(
    calls.some(([call]) => call === 'openAgentHome'),
    false
  );
  await click('agents');
  await click('agents');
  assert.equal(host.querySelector('.test-panel').children.length, 0, 'the selected icon closes the panel');
  assert.equal(activeKey(), 'new:d1');
  await click('agents');
  assert.equal(state().list, 'bots');
  assert.deepEqual(stripKeys(), tabs);

  // A row click is what opens a bot chat.
  const row = host.querySelector('[data-agent-contact="lead"]');
  assert.ok(row, 'Mixy is listed');
  await act(async () => row.querySelector('button, [role="button"]').click());
  await settle();
  assert.deepEqual(opened, [['sess_home_lead', 'Momo']]);
});
