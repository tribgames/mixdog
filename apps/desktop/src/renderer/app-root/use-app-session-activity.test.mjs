import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from '../test-support/test-dom.mjs';
import { useAppSessionActivity } from './use-app-session-activity.ts';
import { useSessionCatalog } from '../app-session-catalog.ts';
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

/** The real catalog hook feeds the real activity hook. `cached` seeds the
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
  let current;
  function Harness() {
    const catalog = useSessionCatalog(() => {});
    const [workspaceTabs, setTabs] = useState(tabs);
    useAppSessionActivity({
      sessions: catalog.sessions,
      setTabs,
      refreshSessions: catalog.refreshSessions,
      setSessionCatalogReady() {},
      subscribeSessionsRemoved: catalog.subscribeRemoved,
      closePaneTab: (key) => closedPaneKeys.push(key),
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
    tabs: [tab({ kind: 'session', id: 'a' }), tab({ kind: 'session', id: 'worker' }), tab({ kind: 'new', id: 'draft' })],
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

test('restore: a stale pool row does not resurrect a deleted Lead tab', () => {
  const ids = restorableSessionIds(
    [{ id: 'live' }],
    [{ sessionId: 'deleted', ownerSessionId: 'deleted' }, { sessionId: 'orphan-worker', ownerSessionId: 'deleted' }]
  );
  assert.deepEqual([...ids], ['live']);
});

test('restore: a worker session of a listed Lead keeps its tab', () => {
  const ids = restorableSessionIds(
    [{ id: 'lead' }],
    [{ sessionId: 'lead', ownerSessionId: 'lead' }, { sessionId: 'worker', ownerSessionId: 'lead' }]
  );
  assert.deepEqual([...ids].sort(), ['lead', 'worker']);
});
