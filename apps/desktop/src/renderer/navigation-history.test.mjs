// Issue #289: Back/Forward walks sessions and editor locations in visit order,
// with session visits recorded at the single activation point.
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  createNavigationHistory,
  recordNavigationVisit,
  sessionStillExists,
  walkNavigationHistory,
} from './navigation-history.ts';
import { useEditorNavigation } from './use-editor-navigation.ts';
import { useAppSessionOpen } from './app-shell-session-open.ts';
import { applySessionLaneResult, useAppTaskLifecycle } from './app-root/use-app-task-lifecycle.ts';
import { useAppTabActions } from './app-root/use-app-tab-actions.ts';

const session = (id) => ({ kind: 'session', id });
const editor = (rel, line = 1) => ({ kind: 'editor', location: { project: '/p', rel, line } });

test('a new visit truncates forward history; editor locations interleave with sessions in visit order', async () => {
  const history = createNavigationHistory();
  recordNavigationVisit(history, session('A'));
  recordNavigationVisit(history, editor('a.ts', 5));
  // The cursor moved in the editor before the next visit: Back returns there.
  history.editorLocation.current = editor('a.ts', 40).location;
  recordNavigationVisit(history, session('B'));
  const opened = [];
  const openers = {
    available: () => true,
    openSession: (id) => {
      opened.push(id);
      recordNavigationVisit(history, session(id));
    },
    openEditor: (location) => opened.push(`${location.rel}:${location.line}`),
  };
  for (let step = 0; step < 3; step += 1) assert.equal(await walkNavigationHistory(history, -1, openers), true);
  assert.deepEqual(opened, ['a.ts:40', 'a.ts:5', 'A']);
  assert.equal(await walkNavigationHistory(history, -1, openers), false);
  recordNavigationVisit(history, session('D'));
  assert.deepEqual(history.entries, [session('A'), session('D')]);
  assert.equal(await walkNavigationHistory(history, 1, openers), false);
});

test('A→B→A keeps three visits; re-entering the current entry records nothing', () => {
  const history = createNavigationHistory();
  for (const id of ['A', 'B', 'A', 'A']) recordNavigationVisit(history, session(id));
  assert.deepEqual(history.entries, [session('A'), session('B'), session('A')]);
});

test('the history keeps the newest 50 entries per window', () => {
  const history = createNavigationHistory();
  for (let n = 0; n < 60; n += 1) recordNavigationVisit(history, session(`s${n}`));
  assert.equal(history.entries.length, 50);
  assert.deepEqual(history.entries[0], session('s10'));
  assert.equal(history.index, 49);
});

test('an archived or deleted session is not live; an unlisted worker is live while its tab is open', () => {
  const sessions = [{ id: 'A' }, { id: 'R', archived: true }];
  const leaves = [
    {
      tabs: [
        { kind: 'session', id: 'W' },
        { kind: 'session', id: 'R' },
      ],
    },
  ];
  assert.equal(sessionStillExists('A', sessions, leaves), true);
  assert.equal(sessionStillExists('R', sessions, leaves), false);
  assert.equal(sessionStillExists('W', sessions, leaves), true);
  assert.equal(sessionStillExists('gone', sessions, leaves), false);
});

test('a session that fails to activate gives way to the next live entry; the index moves only on activation', async () => {
  const history = createNavigationHistory();
  for (const id of ['A', 'B', 'C']) recordNavigationVisit(history, session(id));
  const tried = [];
  const openers = {
    available: () => true,
    openSession: async (id) => {
      tried.push(id);
      if (id === 'B') throw new Error('B failed to open');
      recordNavigationVisit(history, session(id));
    },
    openEditor() {},
  };
  assert.equal(await walkNavigationHistory(history, -1, openers), true);
  assert.deepEqual(tried, ['B', 'A']);
  assert.equal(history.index, 0);
  assert.equal(history.entries.length, 3, 'the replayed open recorded nothing');
  // Forward: B fails again, C (the next live entry) opens.
  tried.length = 0;
  assert.equal(await walkNavigationHistory(history, 1, openers), true);
  assert.deepEqual(tried, ['B', 'C']);
  assert.equal(history.index, 2);
  // Nothing live remains: the failure surfaces and the index stays.
  const only = createNavigationHistory();
  for (const id of ['B', 'C']) recordNavigationVisit(only, session(id));
  openers.openSession = async () => {
    throw new Error('B failed to open');
  };
  await assert.rejects(walkNavigationHistory(only, -1, openers), /B failed/);
  assert.equal(only.index, 1);
});

test('an editor location that fails to open leaves the index until a live entry opens', async () => {
  const history = createNavigationHistory();
  recordNavigationVisit(history, session('A'));
  recordNavigationVisit(history, editor('a.ts', 5));
  recordNavigationVisit(history, session('B'));
  const openers = {
    available: () => true,
    openSession: async (id) => recordNavigationVisit(history, session(id)),
    openEditor() {
      throw new Error('a.ts failed to open');
    },
  };
  assert.equal(await walkNavigationHistory(history, -1, openers), true);
  assert.equal(history.index, 0, 'skipped the failed editor entry to A');
  const onlyEditor = createNavigationHistory();
  recordNavigationVisit(onlyEditor, editor('a.ts', 5));
  recordNavigationVisit(onlyEditor, session('B'));
  await assert.rejects(walkNavigationHistory(onlyEditor, -1, openers), /a\.ts failed/);
  assert.equal(onlyEditor.index, 1);
});

/** The real activation, open, agent-link and Back/Forward hooks over one pane. */
async function mountNavigation(t, sessions) {
  const { root } = installTestDom(t, {
    rootId: 'root',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'HTMLElement', 'Event', 'CustomEvent', 'localStorage'],
  });
  for (const row of sessions) applySessionLaneResult(row.id, { sessionId: row.id });
  const leaf = { id: 'leaf-1', tabs: [], activeKey: '' };
  const paneWorkspace = {
    leaves: [leaf],
    focusedLeafId: 'leaf-1',
    focusedLeaf: leaf,
    focusLeaf() {},
    openInFocused(selection) {
      if (!leaf.tabs.some((tab) => tab.kind === selection.kind && tab.id === selection.id)) leaf.tabs.push(selection);
    },
    promoteInLeaf() {},
    splitFocused() {},
  };
  const navigationHistory = { current: createNavigationHistory() };
  const view = { history: navigationHistory.current, leaf, sessions };
  const noop = () => {};
  function Harness() {
    const [selection, setSelection] = React.useState({ kind: 'new' });
    const selectionRef = React.useRef(selection);
    selectionRef.current = selection;
    const navigationEpoch = React.useRef(0);
    const lifecycle = useAppTaskLifecycle({
      selection,
      setSelection,
      selectionRef,
      paneWorkspace,
      paneLeavesRef: { current: paneWorkspace.leaves },
      focusedLeafIdRef: { current: 'leaf-1' },
      viewedSessionRef: { current: '' },
      unreadViewedSessionRef: { current: '' },
      navigationHistory,
      pendingConversationHandoff: { current: null },
      setConversationHandoff: noop,
      navigationEpoch,
      setRequestedSessionId: noop,
      setComposerFocusRequest: noop,
      closeSidebarForNavigation: noop,
      newTaskDeferred: false,
      lastNewTaskPrefs: { current: null },
      effectiveDraftProjectPath: (path) => path,
      preferredDraftProjectPath: '',
      resetNewTaskDraft: noop,
      draftPanePrefs: { current: new Map() },
      inheritedDraftPrefs: () => ({ projectPath: '', modelSelection: null, workflow: null, orchestrationMode: 'none' }),
      persistDraftPanePrefs: noop,
      setDraftPrefsVersion: noop,
      openSessionRef: { current: async () => {} },
      openProjects: noop,
      refreshProjects: async () => {},
      stageNewTaskProject: noop,
      sessions: view.sessions,
      refreshSessions: async () => [],
      applySnapshot: noop,
      projects: [],
      clearNewTaskPreferences: noop,
      setCommandSurface: noop,
      setCommandSurfaceSessionId: noop,
    });
    const { openSession } = useAppSessionOpen({
      navigationEpoch,
      closeSidebarForNavigation: noop,
      setRequestedSessionId: noop,
      sessions: view.sessions,
      tabs: lifecycle.tabs,
      finishPendingConversationHandoff: lifecycle.finishPendingConversationHandoff,
      activateSelection: lifecycle.activateSelection,
    });
    const tabActions = useAppTabActions({
      paneWorkspace,
      setTabs: lifecycle.setTabs,
      closeSidebarPanels: noop,
      setSessionSideSurface: noop,
      paneSideDocks: { select: noop, temporarySelect: noop },
      sessionPaneSurfaces: {
        agentSessionPanels: new Map(),
        browserSurfaces: new Map(),
        pendingBrowserAutoReveal: { current: new Set() },
        browserAutoRevealSuppressed: { current: new Set() },
        pendingDockReveals: { current: new Map() },
        dockRevealTick: 0,
        queueDockReveal() {},
        showSessionSurface() {},
      },
      openFileTab: noop,
      openSession,
      activeProjectPath: '',
    });
    const navigation = useEditorNavigation({
      setTabs: lifecycle.setTabs,
      openSelectionInFocusedPane: paneWorkspace.openInFocused,
      navigationHistory,
      openSession: (id) => (view.failOpens ? Promise.reject(new Error(`${id} failed to open`)) : openSession(id)),
      sessionAvailable: (id) => sessionStillExists(id, view.sessions, paneWorkspace.leaves),
    });
    Object.assign(view, {
      selection,
      openSession,
      openAgentSession: tabActions.dockOpenAgentSession,
      back: () => navigation.navigateEditorHistory(-1),
      forward: () => navigation.navigateEditorHistory(1),
    });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  view.run = (action) => act(async () => action());
  view.shown = () => (view.selection.kind === 'session' ? view.selection.id : view.selection.kind);
  return view;
}

test('sessions opened A, B, C walk Back to B and A and Forward to B without recording, and a new visit truncates', async (t) => {
  const view = await mountNavigation(t, [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }]);
  for (const id of ['A', 'B', 'C']) await view.run(() => view.openSession(id));
  assert.equal(view.shown(), 'C');
  await view.run(view.back);
  assert.equal(view.shown(), 'B');
  await view.run(view.back);
  assert.equal(view.shown(), 'A');
  await view.run(view.forward);
  assert.equal(view.shown(), 'B');
  assert.deepEqual(view.history.entries, [session('A'), session('B'), session('C')]);
  await view.run(() => view.openSession('D'));
  assert.deepEqual(view.history.entries, [session('A'), session('B'), session('D')]);
  await view.run(view.forward);
  assert.equal(view.shown(), 'D');
});

test('an agent-link open is recorded and walkable', async (t) => {
  const view = await mountNavigation(t, [{ id: 'A' }]);
  await view.run(() => view.openSession('A'));
  await view.run(() => view.openAgentSession('worker-1', 'Reviewer', 'A'));
  assert.equal(view.shown(), 'worker-1');
  assert.deepEqual(view.history.entries, [session('A'), session('worker-1')]);
  await view.run(view.back);
  assert.equal(view.shown(), 'A');
  // An unlisted worker stays reachable while its tab is open.
  await view.run(view.forward);
  assert.equal(view.shown(), 'worker-1');
});

test('a Back step where every candidate fails to open is reported, not an unhandled rejection, and keeps the index', async (t) => {
  const view = await mountNavigation(t, [{ id: 'A' }, { id: 'B' }]);
  for (const id of ['A', 'B']) await view.run(() => view.openSession(id));
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  view.failOpens = true;
  await view.run(view.back);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(view.history.index, 1);
  assert.equal(view.shown(), 'B');
});

test('Back skips a session that no longer exists', async (t) => {
  const view = await mountNavigation(t, [{ id: 'A' }, { id: 'B' }, { id: 'C' }]);
  for (const id of ['A', 'B', 'C']) await view.run(() => view.openSession(id));
  // B is deleted: it leaves the catalog and its tab closes.
  view.sessions.splice(1, 1);
  view.leaf.tabs.splice(
    view.leaf.tabs.findIndex((tab) => tab.id === 'B'),
    1
  );
  await view.run(view.back);
  assert.equal(view.shown(), 'A');
  await view.run(view.forward);
  assert.equal(view.shown(), 'C');
});
