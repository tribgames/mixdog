import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppTaskLifecycle } from './use-app-task-lifecycle.ts';
import { createNavigationHistory } from '../navigation-history.ts';

async function mountLaunchLifecycle(tabs, prefs = new Map()) {
  const { dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div id="root"></div></body></html>',
    jsdom: { url: 'http://localhost/' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent'],
  });
  const state = { hook: null, selectionRef: null, resets: [], opened: [] };
  const leaf = { id: 'leaf-1', tabs, activeKey: 'new:default' };
  const paneWorkspace = {
    leaves: [leaf],
    focusedLeafId: 'leaf-1',
    focusedLeaf: leaf,
    openInFocused: (sel) => state.opened.push(sel),
    promoteInLeaf: () => {},
    splitFocused: () => {},
  };
  function Harness() {
    const [selection, setSelection] = React.useState(tabs[0]);
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    state.selectionRef = selectionRef;
    state.hook = useAppTaskLifecycle({
      selection,
      setSelection,
      selectionRef,
      paneWorkspace,
      paneLeavesRef: { current: paneWorkspace.leaves },
      focusedLeafIdRef: { current: 'leaf-1' },
      viewedSessionRef: { current: '' },
      unreadViewedSessionRef: { current: '' },
      navigationHistory: { current: createNavigationHistory() },
      pendingConversationHandoff: { current: null },
      setConversationHandoff: () => {},
      navigationEpoch: { current: 0 },
      setRequestedSessionId: () => {},
      setComposerFocusRequest: () => {},
      closeSidebarForNavigation: () => {},
      newTaskDeferred: false,
      lastNewTaskPrefs: { current: null },
      effectiveDraftProjectPath: (p) => p || '',
      preferredDraftProjectPath: '',
      resetNewTaskDraft: (...args) => state.resets.push(args),
      draftPanePrefs: { current: prefs },
      inheritedDraftPrefs: () => ({ projectPath: '', modelSelection: null, workflow: null, orchestrationMode: null }),
      persistDraftPanePrefs: () => {},
      setDraftPrefsVersion: () => {},
      openSessionRef: { current: async () => {} },
      openProjects: () => {},
      refreshProjects: async () => {},
      stageNewTaskProject: () => {},
      sessions: [],
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
    root.render(React.createElement(Harness));
  });
  return { state, unmount: () => act(async () => root.unmount()) };
}

test('a launch focuses an untouched draft tab instead of adding another blank one', async () => {
  const { stashComposerDraft } = await import('../composer-draft.ts');
  // The fresh-profile layout: one default draft tab that nobody typed into.
  const blank = await mountLaunchLifecycle([{ kind: 'new' }]);
  await act(async () => blank.state.hook.startLaunchProjectlessTask());
  assert.deepEqual(blank.state.selectionRef.current, { kind: 'new' }, 'the existing blank draft takes the launch');
  assert.deepEqual(blank.state.resets, [[null, { projectless: true }]]);
  await blank.unmount();

  // A draft with typed text is the user's work: the launch opens its own.
  stashComposerDraft('draft:typed', 'half a thought');
  const typed = await mountLaunchLifecycle([{ kind: 'new', draftId: 'typed' }]);
  await act(async () => typed.state.hook.startLaunchProjectlessTask());
  const fresh = typed.state.selectionRef.current;
  assert.equal(fresh.kind, 'new');
  assert.notEqual(fresh.draftId, 'typed');
  await typed.unmount();

  // A configured empty draft (project chosen, no text) is not untouched: the
  // launch takes the genuinely untouched one and leaves the project alone.
  const configured = { projectPath: '/work/a', modelSelection: null, workflow: null };
  const prefs = new Map([['cfg', configured]]);
  const both = await mountLaunchLifecycle(
    [
      { kind: 'new', draftId: 'cfg' },
      { kind: 'new', draftId: 'clean' },
    ],
    prefs
  );
  await act(async () => both.state.hook.startLaunchProjectlessTask());
  assert.deepEqual(both.state.selectionRef.current, { kind: 'new', draftId: 'clean' });
  assert.equal(prefs.get('cfg').projectPath, '/work/a');
  await both.unmount();

  // Only configured drafts exist: the launch adds its own and keeps them.
  const only = await mountLaunchLifecycle([{ kind: 'new', draftId: 'cfg' }], new Map([['cfg', configured]]));
  await act(async () => only.state.hook.startLaunchProjectlessTask());
  const added = only.state.selectionRef.current;
  assert.notEqual(added.draftId, 'cfg');
  assert.ok(added.draftId);
  await only.unmount();

  // The user-invoked projectless task still always opens a new tab.
  const manual = await mountLaunchLifecycle([{ kind: 'new' }]);
  await act(async () => manual.state.hook.startProjectlessTask());
  assert.ok(manual.state.selectionRef.current.draftId, 'Ctrl+Alt+N adds a draft tab');
  await manual.unmount();
});

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
  const navigationHistory = { current: createNavigationHistory() };
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
      navigationHistory,
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
