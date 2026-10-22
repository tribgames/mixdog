import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppTaskLifecycle } from './use-app-task-lifecycle.ts';

test('useAppTaskLifecycle manages selection, tabs, task start, and session clear', async () => {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: {
      url: 'http://localhost/',
    },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  });

  let hookResult = null;
  const navigationEpoch = { current: 0 };
  const viewedSessionRef = { current: '' };
  const unreadViewedSessionRef = { current: '' };
  const pendingConversationHandoff = { current: null };
  const lastNewTaskPrefs = { current: null };
  const draftPanePrefs = { current: new Map() };
  const openSessionRef = { current: async () => {} };
  const resetCalls = [];

  let focusedSelection = null;
  let harnessSelection = null;
  let harnessSelectionRef = null;
  const paneWorkspace = {
    leaves: [{ id: 'leaf-1', tabs: [{ kind: 'new', draftId: 'd1' }], activeTabKey: 'new:d1' }],
    focusedLeafId: 'leaf-1',
    focusedLeaf: { id: 'leaf-1', tabs: [{ kind: 'new', draftId: 'd1' }], activeTabKey: 'new:d1' },
    openInFocused: (sel) => {
      focusedSelection = sel;
    },
    promoteInLeaf: () => {},
    splitFocused: () => {},
  };

  function TestHarness() {
    // The caller owns the selection (App.tsx reads it for draft-pane
    // preferences before this hook runs); the hook only navigates it.
    const [selection, setSelection] = React.useState({ kind: 'new', draftId: 'd1' });
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    harnessSelection = selection;
    harnessSelectionRef = selectionRef;
    hookResult = useAppTaskLifecycle({
      selection,
      setSelection,
      selectionRef,
      paneWorkspace,
      paneLeavesRef: { current: paneWorkspace.leaves },
      focusedLeafIdRef: { current: 'leaf-1' },
      viewedSessionRef,
      unreadViewedSessionRef,
      pendingConversationHandoff,
      setConversationHandoff: () => {},
      navigationEpoch,
      setRequestedSessionId: () => {},
      setComposerFocusRequest: () => {},
      closeSidebarForNavigation: () => {},
      newTaskDeferred: false,
      lastNewTaskPrefs,
      effectiveDraftProjectPath: (p) => p || '/default',
      preferredDraftProjectPath: '/preferred',
      resetNewTaskDraft: (...args) => resetCalls.push(args),
      draftPanePrefs,
      inheritedDraftPrefs: () => ({
        projectPath: '/default',
        modelSelection: null,
        workflow: null,
        orchestrationMode: 'none',
      }),
      persistDraftPanePrefs: () => {},
      setDraftPrefsVersion: () => {},
      openSessionRef,
      openProjects: () => {},
      refreshProjects: async () => {},
      stageNewTaskProject: () => {},
      sessions: [{ id: 's1', projectPath: '/projects/p1' }],
      refreshSessions: async () => [],
      applySnapshot: () => {},
      projects: [],
      clearNewTaskPreferences: () => {},
      setCommandSurface: () => {},
      setCommandSurfaceSessionId: () => {},
    });
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => {
    root.render(React.createElement(TestHarness));
  });

  assert.notEqual(hookResult, null);
  assert.equal(hookResult.selection.kind, 'new');
  assert.equal(hookResult.selection, harnessSelection);
  assert.equal(hookResult.selectionRef, harnessSelectionRef);
  const activateSelection = hookResult.activateSelection;

  // 1. activateSelection switches selection and updates viewedSessionRef
  await act(async () => {
    hookResult.activateSelection({ kind: 'session', id: 's1' }, 'Session 1');
  });
  assert.equal(hookResult.selection.kind, 'session');
  assert.equal(harnessSelection.kind, 'session');
  assert.equal(harnessSelectionRef.current.kind, 'session');
  assert.equal(viewedSessionRef.current, 's1');
  assert.equal(focusedSelection.kind, 'session');
  assert.equal(hookResult.activateSelection, activateSelection);

  // 2. tabs registry has Session 1
  assert.equal(hookResult.tabs.length, 1);
  assert.equal(hookResult.tabs[0].key, 'session:s1');

  // 3. startTask increments epoch and opens new draft
  const epochBefore = navigationEpoch.current;
  await act(async () => {
    hookResult.startTask();
  });
  assert.equal(navigationEpoch.current, epochBefore + 1);
  assert.equal(hookResult.selection.kind, 'new');
  assert.equal(hookResult.activateSelection, activateSelection);

  // 3b. startProjectlessTask opens a fresh draft with No project, even from a draft
  resetCalls.length = 0;
  const draftBefore = harnessSelectionRef.current;
  await act(async () => {
    hookResult.startProjectlessTask();
  });
  assert.equal(hookResult.selection.kind, 'new');
  assert.notEqual(harnessSelectionRef.current, draftBefore);
  assert.deepEqual(resetCalls, [[null, { projectless: true }]]);

  // 4. clearSessionToNewTask creates draft seeded from session
  await act(async () => {
    hookResult.clearSessionToNewTask('s1');
  });
  assert.equal(hookResult.selection.kind, 'new');

  await act(async () => {
    root.unmount();
  });
});
