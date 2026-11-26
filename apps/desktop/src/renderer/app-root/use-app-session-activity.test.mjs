import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { retitleSessionTabs, useAppSessionActivity } from './use-app-session-activity.ts';
import { useSessionCatalog } from '../app-session-catalog.ts';
import { closeSessionPaneTabs } from '../session-tab-cleanup.ts';
import { useAppSessionActions } from '../use-app-session-actions.ts';
import { markPartialCatalog } from '../../shared/session-catalog.ts';
import { writeCachedSessionCatalog } from '../session-catalog-cache.ts';
import { restorableSessionIds } from '../use-pane-workspace-restore.ts';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
});
after(() => dom.window.close());

const session = (id) => ({ id, title: id, preview: id, archived: false });
const tab = (selection) => ({
  key: selection.kind === 'session' ? `session:${selection.id}` : `${selection.kind}:${selection.id}`,
  title: selection.id,
  selection,
});

/** The real catalog hook feeds the real activity hook, and its removal
 *  notices the real session actions (no pane is focused). `cached` seeds the
 *  startup cache; `listed` is what the host's first listSessions() returns
 *  (a function may reject); `push` delivers a host store push. */
async function fixture(t, { cached = [], listed, tabs }) {
  window.localStorage.clear();
  writeCachedSessionCatalog(cached.map(session));
  let listSessions = typeof listed === 'function' ? listed : async () => listed.map(session);
  let pushListener = null;
  window.mixdogDesktop = {
    listSessions: () => listSessions(),
    subscribeSessions: (listener) => {
      pushListener = listener;
      return () => {
        pushListener = null;
      };
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const closedPaneKeys = [];
  const readyCalls = [];
  const reconcileUnread = () => {};
  const setSessionCatalogReady = (ready) => readyCalls.push(ready);
  let current;
  function Harness() {
    const catalog = useSessionCatalog(reconcileUnread);
    const [workspaceTabs, setTabs] = useState(tabs);
    const closePaneTab = (key) => closedPaneKeys.push(key);
    useAppSessionActivity({
      sessions: catalog.sessions,
      setTabs,
      refreshSessions: catalog.refreshSessions,
      setSessionCatalogReady,
      closePaneTab,
    });
    useAppSessionActions({
      sessions: catalog.sessions,
      setSessions: catalog.setSessions,
      tabs: workspaceTabs,
      setTabs,
      setError() {},
      refreshSessions: catalog.refreshSessions,
      pendingRenames: catalog.pendingRenames,
      pendingArchives: catalog.pendingArchives,
      pendingDeletes: catalog.pendingDeletes,
      invalidateSessionListings: catalog.invalidateInFlight,
      applySnapshot() {},
      activateSelection() {},
      onSessionDeleted() {},
      closeSessionTabs: (id) => closeSessionPaneTabs(id, [], '', workspaceTabs, setTabs, closePaneTab),
      openSession() {},
      navigationEpoch: useRef(0),
      setRequestedSessionId() {},
      subscribeSessionsRemoved: catalog.subscribeRemoved,
      selectionRef: useRef({ kind: 'new' }),
      viewedSessionRef: useRef(''),
      unreadViewedSessionRef: useRef(''),
      setSelection() {},
      lastSessionStorageKey: 'test:last-session',
    });
    current = { catalog, tabs: workspaceTabs };
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete window.mixdogDesktop;
  });
  return {
    state: () => current,
    closedPaneKeys,
    readyCalls,
    push: (ids) => act(async () => pushListener(ids.map(session))),
    refresh: () => act(async () => current.catalog.refreshSessions().catch(() => undefined)),
    setListing: (next) => {
      listSessions = next;
    },
  };
}

const keys = (f) => f.state().tabs.map(({ key }) => key);
const twoTabs = [tab({ kind: 'session', id: 'a' }), tab({ kind: 'session', id: 'b' })];

test('an authoritative host catalog without a listed session closes its tab', async (t) => {
  const f = await fixture(t, { listed: ['a', 'b'], tabs: twoTabs });
  await f.push(['b']);
  assert.deepEqual(keys(f), ['session:b']);
  assert.deepEqual(f.closedPaneKeys, ['session:a']);
});

test('an empty list during reconnect closes nothing', async (t) => {
  const f = await fixture(t, { listed: ['a', 'b'], tabs: twoTabs });
  await f.push([]);
  assert.deepEqual(keys(f), ['session:a', 'session:b']);
  assert.deepEqual(f.closedPaneKeys, []);
});

test('a failed host listing closes nothing', async (t) => {
  const f = await fixture(t, { listed: ['a', 'b'], tabs: twoTabs });
  f.setListing(async () => {
    throw new Error('transport down');
  });
  await f.refresh();
  assert.deepEqual(keys(f), ['session:a', 'session:b']);
  assert.deepEqual(f.closedPaneKeys, []);
});

test('the cached catalog never closes tabs, but the first host catalog dropping a stale id does', async (t) => {
  const f = await fixture(t, { cached: ['a', 'b'], listed: () => new Promise(() => {}), tabs: twoTabs });
  assert.deepEqual(keys(f), ['session:a', 'session:b']);
  assert.deepEqual(f.closedPaneKeys, []);
  f.setListing(async () => [session('b')]);
  await f.refresh();
  assert.deepEqual(keys(f), ['session:b']);
  assert.deepEqual(f.closedPaneKeys, ['session:a']);
});

test('a session tab never listed (brand-new or agent worker) and drafts stay open', async (t) => {
  const f = await fixture(t, {
    listed: ['a'],
    tabs: [
      tab({ kind: 'session', id: 'a' }),
      tab({ kind: 'session', id: 'worker' }),
      tab({ kind: 'new', id: 'draft' }),
    ],
  });
  await f.push(['a', 'c']);
  await f.push(['a']);
  assert.deepEqual(keys(f), ['session:a', 'session:worker', 'new:draft']);
  // Only the listed-then-vanished session is reported; worker and draft are not.
  assert.deepEqual(f.closedPaneKeys, ['session:c']);
});

test('an in-flight local delete keeps owning its tab cleanup', async (t) => {
  const f = await fixture(t, { listed: ['a', 'b'], tabs: twoTabs });
  f.state().catalog.pendingDeletes.current.add('a');
  await f.push(['b']);
  assert.deepEqual(keys(f), ['session:a', 'session:b']);
  assert.deepEqual(f.closedPaneKeys, []);
});

// A catalog update on a phone with hundreds of sessions: only the sessions a
// tab shows are titled, not the whole catalog on every update.
test('a catalog update titles only the sessions a tab shows', () => {
  const read = [];
  const counted = (id, title) =>
    new Proxy(
      { id, title, preview: id },
      {
        get(target, key) {
          if (key !== 'id') read.push(id);
          return target[key];
        },
      }
    );
  const sessions = Array.from({ length: 300 }, (_, index) => counted(`s${index}`, `Session ${index}`));
  sessions[7] = counted('s7', 'Renamed seven');
  const tabs = [
    tab({ kind: 'session', id: 's7' }),
    tab({ kind: 'session', id: 's9', title: 'Pinned' }),
    tab({ kind: 'settings', id: 'general' }),
  ];
  const next = retitleSessionTabs(tabs, sessions);
  assert.equal(next[0].title, 'Renamed seven');
  assert.equal(next[1], tabs[1], 'a selection-pinned title stays');
  assert.equal(next[2], tabs[2]);
  assert.deepEqual([...new Set(read)], ['s7'], 'no other session is read');
  // Nothing changed: the same array comes back (no tab state update).
  assert.equal(retitleSessionTabs(next, sessions), next);
});

test('restore: a stale pool row does not resurrect a deleted Lead tab', () => {
  const ids = restorableSessionIds(
    [{ id: 'live' }],
    [
      { sessionId: 'deleted', ownerSessionId: 'deleted' },
      { sessionId: 'orphan-worker', ownerSessionId: 'deleted' },
    ]
  );
  assert.deepEqual([...ids], ['live']);
});

test('restore: a worker session of a listed Lead keeps its tab', () => {
  const ids = restorableSessionIds(
    [{ id: 'lead' }],
    [
      { sessionId: 'lead', ownerSessionId: 'lead' },
      { sessionId: 'worker', ownerSessionId: 'lead' },
    ]
  );
  assert.deepEqual([...ids].sort(), ['lead', 'worker']);
});

test('the catalog first renders as ready with the host list, also when a push already holds that list', async (t) => {
  // React's own scheduling: act() would flush the push's transition before the ready render could overtake it.
  const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  const mounted = [];
  t.after(() => {
    for (const { root, host } of mounted) {
      root.unmount();
      host.remove();
    }
    delete window.mixdogDesktop;
    globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment;
  });
  for (const order of ['replayed to the late subscriber', 'pushed while the read is out']) {
    window.localStorage.clear();
    const listed = [session('a')];
    let push = null;
    window.mixdogDesktop = {
      listSessions: async () => {
        if (order === 'pushed while the read is out') push(listed);
        return listed;
      },
      // The phone's catalog hands what it already holds to a subscriber that arrives after the first sync.
      subscribeSessions: (listener) => {
        push = listener;
        if (order === 'replayed to the late subscriber') listener(listed);
        return () => {};
      },
    };
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    const firstReady = new Promise((resolve) => {
      function Harness() {
        const catalog = useSessionCatalog(() => {});
        const [ready, setReady] = useState(false);
        useAppSessionActivity({
          sessions: catalog.sessions,
          setTabs() {},
          refreshSessions: catalog.refreshSessions,
          setSessionCatalogReady: setReady,
          closePaneTab() {},
        });
        if (ready) resolve(catalog.sessions.map(({ id }) => id));
        return null;
      }
      root.render(React.createElement(Harness));
    });
    assert.deepEqual(await firstReady, ['a'], order);
  }
});

test('a first page closes no tab and does not ready the catalog; a walk that failed behind it is read again and readies it once whole', async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    cached: ['a', 'b'],
    tabs: twoTabs,
    listed: async () => {
      reads += 1;
      if (reads === 1) return markPartialCatalog(['a'].map(session));
      if (reads === 2) throw new Error('connection lost');
      return ['a', 'b'].map(session);
    },
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
  assert.deepEqual(keys(f), ['session:a', 'session:b'], 'the session on a later page keeps its tab');
  assert.deepEqual(f.closedPaneKeys, []);
  assert.deepEqual(f.readyCalls, [], 'a first page is not the catalog');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1_200)));
  assert.deepEqual(f.readyCalls, [true], 'ready once the whole list arrived');
  assert.deepEqual(keys(f), ['session:a', 'session:b']);
});
