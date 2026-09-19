import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAppWorkbenchViews } from './use-app-workbench-views.tsx';

test('useAppWorkbenchViews resolves pane project path and renders workbench side views correctly', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Event', 'CustomEvent']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);

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

  await act(async () => {
    root.unmount();
  });
});
