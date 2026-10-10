import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useAppSessionActions } from './use-app-session-actions.ts';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
});
after(() => dom.window.close());

async function fixture(t, api) {
  window.mixdogDesktop = api;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const deleted = [];
  const snapshots = [];
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
      selection,
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
    });
    current = {
      ...actions,
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
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return { state: () => current, deleted, snapshots };
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
        f.state().setRequestedSessionId('session-b');
      });
    }
    await act(async () => {
      gate.resolve({ sessionId: 'session-b' });
      await pending;
    });
    assert.deepEqual(f.state().selection, navigate ? { kind: 'session', id: 'session-b' } : { kind: 'new' });
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
