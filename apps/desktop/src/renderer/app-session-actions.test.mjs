import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['navigator'],
});
after(() => dom.window.close());

const { usePaneWorkspace } = await import('./pane-workspace-state.ts');
const { closeSessionPaneTabs } = await import('./session-tab-cleanup.ts');
const { navigationKey } = await import('./text-format.ts');
const { useAppSessionActions } = await import('./use-app-session-actions.ts');

async function fixture(t, api) {
  window.mixdogDesktop = api;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const deleted = [];
  const snapshots = [];
  const closedPaneKeys = [];
  const opened = [];
  let current;
  function Harness() {
    const [sessions, setSessions] = useState([
      { id: 'session-a', title: 'Original', archived: false, working: false, messageCount: 2 },
      { id: 'session-b', title: 'Another session', archived: false },
    ]);
    const [tabs, setTabs] = useState(
      sessions.map(({ id, title }) => ({
        key: `session:${id}`,
        title,
        selection: { kind: 'session', id },
      }))
    );
    const [selection, setSelection] = useState({ kind: 'session', id: 'session-a' });
    // The app's own pane workspace: it keeps its active tab apart from the
    // global selection (a focused file tab leaves the selection on a session).
    const workspace = usePaneWorkspace(null);
    const focus = workspace.openInFocused;
    const closePaneTab = (key) => {
      closedPaneKeys.push(key);
      workspace.closeTabByKey(key);
    };
    const [error, setError] = useState('');
    const [requestedSessionId, setRequestedSessionId] = useState('');
    const navigationEpoch = useRef(0);
    const pendingRenames = useRef(new Map());
    const pendingArchives = useRef(new Map());
    const pendingDeletes = useRef(new Set());
    const actions = useAppSessionActions({
      sessions,
      setSessions,
      tabs,
      setTabs,
      setError,
      pendingRenames,
      pendingArchives,
      pendingDeletes,
      navigationEpoch,
      setRequestedSessionId,
      refreshSessions: async () => sessions,
      invalidateSessionListings() {},
      applySnapshot: (value) => snapshots.push(value),
      activateSelection: setSelection,
      onSessionDeleted: (id) => deleted.push(id),
      closeSessionTabs: (id) => {
        const { leaves, focusedLeafId } = workspace.now();
        return closeSessionPaneTabs(id, leaves, focusedLeafId, tabs, setTabs, closePaneTab);
      },
      openSession: (id) => {
        opened.push(id);
        focus({ kind: 'session', id });
      },
    });
    current = {
      ...actions,
      leaves: workspace.leaves,
      focus,
      sessions,
      setSessions,
      tabs,
      selection,
      setSelection,
      error,
      navigationEpoch,
      requestedSessionId,
      setRequestedSessionId,
    };
    return null;
  }
  window.localStorage.clear();
  await act(async () => root.render(React.createElement(Harness)));
  // One group holding both sessions, A shown.
  await act(async () => {
    for (const id of ['session-a', 'session-b', 'session-a']) current.focus({ kind: 'session', id });
  });
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { state: () => current, deleted, snapshots, closedPaneKeys, opened };
}

for (const action of ['rename', 'archive']) {
  test(`failed ${action} restores only its own field, preserving newer session activity`, async (t) => {
    const gate = Promise.withResolvers();
    const f = await fixture(t, {
      renameSession: () => gate.promise,
      setSessionArchived: () => gate.promise,
    });
    let pending;
    await act(async () => {
      pending = (
        action === 'rename'
          ? f.state().renameSession('session-a', 'Requested title')
          : f.state().archiveSession('session-a', true)
      ).catch((error) => error);
    });
    await act(async () => {
      f.state().setSessions((rows) =>
        rows.map((row) =>
          row.id === 'session-a' ? { ...row, working: true, messageCount: 7, custom: 'new metadata' } : row
        )
      );
    });
    await act(async () => {
      gate.reject(new Error(`${action} failed`));
      await pending;
    });
    const row = f.state().sessions.find((entry) => entry.id === 'session-a');
    assert.equal(action === 'rename' ? row.title : row.archived, action === 'rename' ? 'Original' : false);
    assert.equal(row.working, true);
    assert.equal(row.messageCount, 7);
    assert.equal(row.custom, 'new metadata');
    assert.equal(f.state().error, `${action} failed`);
  });
}

test('favoriteSession applies optimistically, calls the bridge and rolls back on failure', async (t) => {
  const calls = [];
  const gate = Promise.withResolvers();
  const f = await fixture(t, {
    setSessionFavorite: (id, favorite) => {
      calls.push([id, favorite]);
      return gate.promise;
    },
  });
  let pending;
  await act(async () => {
    pending = f
      .state()
      .favoriteSession('session-a', true)
      .catch((error) => error);
  });
  assert.equal(f.state().sessions.find((entry) => entry.id === 'session-a').favorite, true);
  await act(async () => {
    gate.reject(new Error('favorite failed'));
    await pending;
  });
  assert.deepEqual(calls, [['session-a', true]]);
  assert.notEqual(f.state().sessions.find((entry) => entry.id === 'session-a').favorite, true);
  assert.equal(f.state().error, 'favorite failed');
});

for (const navigate of [false, true]) {
  test(`session deletion ${navigate ? 'preserves a newer navigation' : 'opens a draft when its session is still selected'}`, async (t) => {
    const gate = Promise.withResolvers();
    const f = await fixture(t, { deleteSession: () => gate.promise });
    let pending;
    await act(async () => {
      pending = f.state().deleteSession('session-a');
    });
    if (navigate) {
      await act(async () => {
        f.state().navigationEpoch.current += 1;
        f.state().setSelection({ kind: 'session', id: 'session-b' });
        f.state().focus({ kind: 'session', id: 'session-b' });
        f.state().setRequestedSessionId('session-b');
      });
    }
    await act(async () => {
      gate.resolve({ sessionId: 'session-b' });
      await pending;
    });
    // Without a newer navigation the neighbour tab opens (not a draft); the
    // deleted session's pane tab closes either way.
    assert.deepEqual(
      f.state().selection,
      navigate ? { kind: 'session', id: 'session-b' } : { kind: 'session', id: 'session-a' }
    );
    assert.deepEqual(f.opened, navigate ? [] : ['session-b']);
    assert.deepEqual(f.closedPaneKeys, ['session:session-a']);
    assert.equal(f.state().requestedSessionId, navigate ? 'session-b' : '');
    assert.deepEqual(
      f.state().sessions.map(({ id }) => id),
      ['session-b']
    );
    assert.deepEqual(
      f.state().tabs.map(({ key }) => key),
      ['session:session-b']
    );
    assert.deepEqual(f.deleted, ['session-a']);
    assert.deepEqual(f.snapshots, [{ sessionId: 'session-b' }]);
  });
}

test('deleting a non-active session closes its pane tab without navigating', async (t) => {
  const f = await fixture(t, { deleteSession: async () => ({ sessionId: 'session-a' }) });
  await act(async () => {
    await f.state().deleteSession('session-b');
  });
  assert.deepEqual(f.closedPaneKeys, ['session:session-b']);
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.state().selection, { kind: 'session', id: 'session-a' });
  assert.deepEqual(
    f.state().tabs.map(({ key }) => key),
    ['session:session-a']
  );
});

test('sequential multi-delete closes every deleted session tab', async (t) => {
  const f = await fixture(t, { deleteSession: async () => ({ sessionId: '' }) });
  await act(async () => {
    await f.state().deleteSession('session-b');
  });
  await act(async () => {
    await f.state().deleteSession('session-a');
  });
  assert.deepEqual(f.closedPaneKeys, ['session:session-b', 'session:session-a']);
  assert.deepEqual(f.state().tabs, []);
});

test('archiving the shown session closes its tabs and activates the neighbour; restoring reopens none', async (t) => {
  const calls = [];
  const f = await fixture(t, {
    setSessionArchived: async (id, archived) => {
      calls.push([id, archived]);
    },
  });
  await act(async () => {
    await f.state().archiveSession('session-a', true);
  });
  assert.deepEqual(calls, [['session-a', true]]);
  assert.deepEqual(f.closedPaneKeys, ['session:session-a']);
  assert.deepEqual(
    f.state().tabs.map(({ key }) => key),
    ['session:session-b']
  );
  assert.deepEqual(f.opened, ['session-b']);
  await act(async () => {
    await f.state().archiveSession('session-a', false);
  });
  assert.deepEqual(f.closedPaneKeys, ['session:session-a']);
  assert.deepEqual(
    f.state().tabs.map(({ key }) => key),
    ['session:session-b']
  );
  assert.deepEqual(f.opened, ['session-b']);
});

test('archiving a background session closes its tab without navigating; a failed archive keeps it', async (t) => {
  let fail = true;
  const f = await fixture(t, {
    setSessionArchived: async () => {
      if (fail) throw new Error('archive failed');
    },
  });
  await act(async () => {
    await f
      .state()
      .archiveSession('session-b', true)
      .catch(() => {});
  });
  assert.deepEqual(f.closedPaneKeys, []);
  assert.equal(f.state().tabs.length, 2);
  fail = false;
  await act(async () => {
    await f.state().archiveSession('session-b', true);
  });
  assert.deepEqual(f.closedPaneKeys, ['session:session-b']);
  assert.deepEqual(
    f.state().tabs.map(({ key }) => key),
    ['session:session-a']
  );
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.state().selection, { kind: 'session', id: 'session-a' });
});

test('archiving the session behind a focused file tab leaves the file focused', async (t) => {
  const f = await fixture(t, { setSessionArchived: async () => {} });
  const file = { kind: 'file', project: 'p', rel: 'notes.md' };
  // The global selection stays on session A while the pane shows the file.
  await act(async () => f.state().focus(file));
  await act(async () => {
    await f.state().archiveSession('session-a', true);
  });
  assert.deepEqual(f.closedPaneKeys, ['session:session-a']);
  assert.equal(f.state().leaves[0].activeKey, navigationKey(file));
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.state().selection, { kind: 'session', id: 'session-a' });
});

test('bulk archive decides each move from the pane as each tab closes, with no render between', async (t) => {
  const gates = new Map([
    ['session-a', Promise.withResolvers()],
    ['session-b', Promise.withResolvers()],
  ]);
  const f = await fixture(t, { setSessionArchived: (id) => gates.get(id).promise });
  let pending;
  await act(async () => {
    pending = Promise.all([f.state().archiveSession('session-a', true), f.state().archiveSession('session-b', true)]);
  });
  // Both finish in one batch. A closes first: its neighbour B opens and is the
  // focused tab at once. B was therefore shown when it closed, so navigation
  // leaves it for a draft.
  await act(async () => {
    gates.get('session-a').resolve();
    gates.get('session-b').resolve();
    await pending;
  });
  assert.deepEqual(f.closedPaneKeys, ['session:session-a', 'session:session-b']);
  assert.deepEqual(f.state().tabs, []);
  assert.deepEqual(f.state().selection, { kind: 'new' });
  assert.deepEqual(f.opened, ['session-b']);
});

test('closeSessionPaneTabs falls back to the group neighbour, else another group, else a draft', () => {
  const closed = [];
  const close = (key) => closed.push(key);
  const setTabs = () => {};
  const leaf = (id, ids, activeId) => ({
    id,
    activeKey: `session:${activeId}`,
    tabs: ids.map((sid) => ({ kind: 'session', id: sid })),
  });
  assert.deepEqual(
    closeSessionPaneTabs(
      'b',
      [leaf('l', ['a', 'b', 'c'], 'b')],
      'l',
      [{ key: 'session:c', title: 'C' }],
      setTabs,
      close
    ),
    { shown: true, fallback: { selection: { kind: 'session', id: 'c' }, title: 'C' } }
  );
  assert.deepEqual(
    closeSessionPaneTabs('b', [leaf('l', ['b'], 'b'), leaf('m', ['a'], 'a')], 'l', [], setTabs, close).fallback
      ?.selection,
    { kind: 'session', id: 'a' }
  );
  assert.deepEqual(closeSessionPaneTabs('b', [leaf('l', ['b'], 'b')], 'l', [], setTabs, close), {
    shown: true,
    fallback: null,
  });
  // An unfocused or inactive tab never changes the active selection.
  assert.deepEqual(closeSessionPaneTabs('b', [leaf('l', ['a', 'b'], 'a')], 'l', [], setTabs, close), {
    shown: false,
    fallback: null,
  });
  assert.deepEqual(closed, ['session:b', 'session:b', 'session:b', 'session:b']);
});

test('closeSessionPaneTabs never falls back to the deleted session open in other panes', () => {
  const close = () => {};
  const setTabs = () => {};
  const leaf = (id, ids, activeId) => ({
    id,
    activeKey: `session:${activeId}`,
    tabs: ids.map((sid) => ({ kind: 'session', id: sid })),
  });
  // Other pane shows A as active with B behind it: B is the post-deletion active.
  assert.deepEqual(
    closeSessionPaneTabs(
      'a',
      [leaf('l', ['a'], 'a'), leaf('m', ['a', 'b'], 'a')],
      'l',
      [{ key: 'session:b', title: 'B' }],
      setTabs,
      close
    ).fallback,
    { selection: { kind: 'session', id: 'b' }, title: 'B' }
  );
  // A open in three panes: skip panes left empty, use the first surviving active tab.
  assert.deepEqual(
    closeSessionPaneTabs(
      'a',
      [leaf('l', ['a'], 'a'), leaf('m', ['a'], 'a'), leaf('n', ['c', 'a'], 'a')],
      'l',
      [{ key: 'session:c', title: 'C' }],
      setTabs,
      close
    ).fallback,
    { selection: { kind: 'session', id: 'c' }, title: 'C' }
  );
  // Only the deleted session remains anywhere: draft.
  assert.equal(
    closeSessionPaneTabs(
      'a',
      [leaf('l', ['a'], 'a'), leaf('m', ['a'], 'a'), leaf('n', ['a'], 'a')],
      'l',
      [],
      setTabs,
      close
    ).fallback,
    null
  );
});
