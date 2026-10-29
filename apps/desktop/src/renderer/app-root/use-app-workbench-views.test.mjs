import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppWorkbenchViews } from './use-app-workbench-views.tsx';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

/** Mounts the hook with stub options; `overrides` replace stubs, `userAgent` picks the surface. */
async function mountViews(overrides = {}, userAgent) {
  const { dom, restore } = installTestDom(null, {
    jsdom: { url: 'about:blank' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  });
  if (userAgent) {
    Object.defineProperty(dom.window.navigator, 'userAgent', { configurable: true, value: userAgent });
    Object.defineProperty(dom.window.navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  }

  let hookResult = null;

  function TestHarness() {
    hookResult = useAppWorkbenchViews({
      sessions: [{ id: 's1', projectPath: '/projects/repo1' }],
      sessionCatalogReady: true,
      workingSessionIds: new Set(),
      unreadSessionIds: new Set(),
      sidebarSelection: { kind: 'session', id: 's1' },
      sidebarNewTask: () => {},
      sidebarNewStudio: () => {},
      prefetchSession: async () => true,
      sidebarResumeSession: () => {},
      renameSession: async () => {},
      archiveSession: async () => {},
      deleteSession: async () => {},
      sideViewDescriptors: new Map(),
      renderSidebarPanel: () => null,
      mountedSidebarPanels: new Set(),
      sessionDiffs: new Map(),
      setSessionDiff: () => {},
      snapshotStore: { get: () => ({}) },
      observedAgentSessionIds: [],
      quickAccessProjectPath: '/projects/default',
      workbenchWorkspace: { workspace: { folders: [] } },
      selectToolProject: () => {},
      dockOpenFile: () => {},
      dockOpenFileAt: () => {},
      dockOpenDiff: () => {},
      dockOpenPullRequest: () => {},
      dockOpenLeadSession: () => {},
      dockOpenAgentSession: () => {},
      paneSideDocks: {
        open: () => {},
        select: () => {},
        temporarySelect: () => {},
        openDiff: () => {},
        get: () => undefined,
        setOpen: () => {},
        setDockState: () => {},
      },
      setSidebarDiff: () => {},
      registeredProjectPath: (path) => path,
      resolvedDraftPrefsFor: (draftKey) => ({
        projectPath: draftKey === 'd1' ? '/projects/draft1' : '',
        modelSelection: null,
        workflow: null,
        orchestrationMode: 'none',
      }),
      paneWorkspace: {
        leaves: [{ id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeTabKey: 'session:s1' }],
        focusedLeafId: 'leaf-1',
        focusedLeaf: { id: 'leaf-1', tabs: [{ kind: 'session', id: 's1' }], activeTabKey: 'session:s1' },
        layout: { kind: 'leaf', id: 'leaf-1' },
        focusLeaf: () => {},
        activateTab: () => {},
      },
      sessionPaneSurfaces: {
        browserSurfaces: new Map(),
        terminalSurfaces: new Map(),
        sessionDiffs: new Map(),
        sessionPanelViews: new Map(),
        sessionSideSurfaces: new Map(),
      },
      workbenchSideLayout: {
        layout: { left: [], right: [] },
        sideOf: () => 'left',
        moveGroup: () => {},
        moveView: () => {},
      },
      closePaneRightRegion: () => {},
      selectWorkbenchSideView: () => {},
      moveWorkbenchSideGroup: () => {},
      moveWorkbenchSideView: () => {},
      openFileTab: () => {},
      desktopBootReady: true,
      bottomPanel: {
        open: false,
        tab: 'problems',
        setOpen: () => {},
        setTab: () => {},
      },
      problemsFilter: '',
      setProblemsFilter: () => {},
      problemsCollapseNonce: 0,
      setProblemsCollapseNonce: () => {},
      openProblemQuickFix: () => {},
      ...overrides,
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });
  assert.notEqual(hookResult, null);
  return {
    views: hookResult,
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      restore?.();
    },
  };
}

test('opening a bot from the Sessions drawer on the phone keeps Sessions, closes the drawer, opens the chat', async () => {
  const calls = [];
  const mounted = await mountViews(
    {
      selectWorkbenchSideView: (viewId) => calls.push(['select', viewId]),
      closeSidebarForNavigation: () => calls.push(['closeDrawer']),
      dockOpenAgentSession: (...args) => calls.push(['openChat', ...args]),
    },
    IPHONE_UA
  );
  const { isMobileRemoteSurface } = await import('../mobile-surface.ts');
  assert.equal(isMobileRemoteSurface(), true);

  const sidebar = mounted.views.renderWorkbenchSideView('left', 'sessions', true, {});
  sidebar.props.onOpenAgent('bot-home-1', 'Mixy');

  assert.deepEqual(calls, [['closeDrawer'], ['openChat', 'bot-home-1', 'Mixy', 'bot-home-1']]);
  await mounted.unmount();
});

test('useAppWorkbenchViews resolves pane project path and renders workbench side views correctly', async () => {
  const mounted = await mountViews();
  const hookResult = mounted.views;

  // Test paneProjectPathFor
  const sessionLeaf = {
    id: 'l1',
    tabs: [{ kind: 'session', id: 's1' }],
    activeTabKey: 'session:s1',
  };
  assert.equal(hookResult.paneProjectPathFor(sessionLeaf), '/projects/repo1');

  const fileLeaf = {
    id: 'l2',
    tabs: [{ kind: 'file', project: '/projects/repo2', rel: 'index.ts' }],
    activeTabKey: 'file:/projects/repo2/index.ts',
  };
  assert.equal(hookResult.paneProjectPathFor(fileLeaf), '/projects/repo2');

  const draftLeaf = {
    id: 'l3',
    tabs: [{ kind: 'new', draftId: 'd1' }],
    activeTabKey: 'new:d1',
  };
  assert.equal(hookResult.paneProjectPathFor(draftLeaf), '/projects/draft1');

  const emptyLeaf = {
    id: 'l4',
    tabs: [],
    activeTabKey: '',
  };
  assert.equal(hookResult.paneProjectPathFor(emptyLeaf), '/projects/default');

  // Test renderWorkbenchSideView
  // browser and terminal return null
  assert.equal(hookResult.renderWorkbenchSideView('left', 'browser', true, {}), null);
  assert.equal(hookResult.renderWorkbenchSideView('left', 'terminal', true, {}), null);

  // The visualize panel is one instance per session: switching the pane to
  // another session remounts it, so no pane cell (same tab id, another
  // session) keeps the previous session's content.
  const visualizeOf = (sessionId) =>
    hookResult.renderWorkbenchSideView('right', 'visualize', true, {}, { sessionId, leafId: 'leaf-1' });
  assert.equal(visualizeOf('s1').key, 's1');
  assert.notEqual(visualizeOf('s1').key, visualizeOf('s2').key);

  await mounted.unmount();
});
