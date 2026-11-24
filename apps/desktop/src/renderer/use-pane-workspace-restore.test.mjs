import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { window: testWindow } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['navigator'],
});

const { usePaneWorkspaceState } = await import('./use-pane-workspace-restore.ts');
const { navigationKey } = await import('./text-format.ts');
const { useSessionCatalog } = await import('./app-session-catalog.ts');
const { useAppSessionActivity } = await import('./app-root/use-app-session-activity.ts');
const { useAppSessionActions } = await import('./use-app-session-actions.ts');
const { closeSessionPaneTabs } = await import('./session-tab-cleanup.ts');
const { BOT_DELETED_EVENT } = await import('./agent-profile-actions.ts');
const { filterPaneLayoutSessions, paneLeaves } = await import('./pane-layout.ts');

const ELECTRON_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Mixdog/1.0 Chrome/130.0.0.0 Electron/41.0.0 Safari/537.36';
const PHONE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const PANE_LAYOUT_KEY = 'mixdog.desktop.pane-layout.v1';

const session = (id) => ({ kind: 'session', id });
const fileTab = { kind: 'file', project: '/p', rel: 'a.ts' };
const leaf = (id, ...tabs) => ({ type: 'leaf', id, tabs, activeKey: navigationKey(tabs[0]) });
// [left | [top / bottom]]: the maintainer's split layout.
const STORED = {
  layout: {
    type: 'split',
    direction: 'row',
    ratio: 0.3,
    first: leaf('left', session('s1')),
    second: {
      type: 'split',
      direction: 'column',
      ratio: 0.6,
      first: leaf('top', session('s2'), fileTab),
      second: leaf('bottom', session('s3')),
    },
  },
  focusedLeafId: 'top',
};
const STORED_TEXT = JSON.stringify(STORED);
const SESSIONS = ['s1', 's2', 's3'].map((id) => ({ id }));
const STORED_SHAPE = ['row', ['session:s1'], ['column', ['session:s2', 'file:/p:a.ts'], ['session:s3']]];
const shape = (node) =>
  node.type === 'leaf'
    ? node.tabs.map((tab) => navigationKey(tab))
    : [node.direction, shape(node.first), shape(node.second)];

const pause = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

/** A desktop bridge: the file copy, the catalog, and what the renderer reported. */
function bridge({ file = null, catalog = SESSIONS, sections = false, pool } = {}) {
  const calls = { fileReads: 0, fileWrites: [], diagnostics: [], sessionReads: 0, poolReads: 0 };
  // The core's `agentPool` section: no entry until `pool` is given or published.
  const poolListeners = new Set();
  let poolEntry = pool === undefined ? null : { section: 'agentPool', key: null, revision: 1, value: pool };
  const api = {
    catalog,
    listeners: new Set(),
    ...(sections
      ? {
          sections: {
            snapshot: async () => ({ status: 'ready', entries: poolEntry ? [poolEntry] : [] }),
            subscribe(listener) {
              poolListeners.add(listener);
              return () => poolListeners.delete(listener);
            },
          },
        }
      : {}),
    publishPool: async (rows) => {
      poolEntry = { section: 'agentPool', key: null, revision: (poolEntry?.revision ?? 0) + 1, value: rows };
      await act(async () => {
        for (const listener of [...poolListeners]) {
          listener({ kind: 'sections', changes: [{ section: 'agentPool', key: null, entry: poolEntry }] });
        }
      });
      await pause();
    },
    readPaneLayoutFile: () => {
      calls.fileReads += 1;
      return file;
    },
    writePaneLayoutFile: (layout) => calls.fileWrites.push(layout),
    listSessions: async () => {
      calls.sessionReads += 1;
      if (!api.catalog) throw new Error('daemon offline');
      return api.catalog;
    },
    listAgentPool: async () => {
      calls.poolReads += 1;
      return [];
    },
    subscribeSessions: (listener) => {
      api.listeners.add(listener);
      return () => api.listeners.delete(listener);
    },
    rendererDiagnostic: (diagnostic) => calls.diagnostics.push(diagnostic),
    pushSessions: async () => {
      await act(async () => {
        for (const listener of [...api.listeners]) listener(api.catalog ?? []);
      });
      await pause();
    },
  };
  return { api, calls };
}

/** The session lifecycle beside the restore, as the app wires them: the real catalog hook feeds the real activity hook
 *  and, with its removal notices, the real session actions; their pane close takes the session's tabs out of the pane tree. */
function useLifecycle(workspace) {
  const catalog = useSessionCatalog(() => {});
  const [tabs, setTabs] = React.useState([]);
  const closePaneTab = (key) =>
    workspace.setState((prev) => {
      const keep = new Set(
        paneLeaves(prev.layout).flatMap((node) =>
          node.tabs.flatMap((tab) => (tab.kind === 'session' && navigationKey(tab) !== key ? [tab.id] : []))
        )
      );
      const layout = filterPaneLayoutSessions(prev.layout, keep);
      if (layout === prev.layout || !layout) return prev;
      const leaves = paneLeaves(layout);
      return {
        layout,
        focusedLeafId: leaves.some((node) => node.id === prev.focusedLeafId) ? prev.focusedLeafId : leaves[0].id,
      };
    });
  useAppSessionActivity({
    sessions: catalog.sessions,
    setTabs,
    refreshSessions: catalog.refreshSessions,
    setSessionCatalogReady() {},
    closePaneTab,
  });
  useAppSessionActions({
    sessions: catalog.sessions,
    setSessions: catalog.setSessions,
    tabs,
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
    closeSessionTabs: (id) => closeSessionPaneTabs(id, [], '', tabs, setTabs, closePaneTab),
    openSession() {},
    navigationEpoch: React.useRef(0),
    setRequestedSessionId() {},
    subscribeSessionsRemoved: catalog.subscribeRemoved,
    selectionRef: React.useRef({ kind: 'new' }),
    viewedSessionRef: React.useRef(''),
    unreadViewedSessionRef: React.useRef(''),
    setSelection() {},
    lastSessionStorageKey: 'test:last-session',
  });
}

async function mount(t, { ua = ELECTRON_UA, local = null, desktop, lifecycle = false }) {
  Object.defineProperty(testWindow.navigator, 'userAgent', { configurable: true, get: () => ua });
  testWindow.localStorage.clear();
  if (local !== null) testWindow.localStorage.setItem(PANE_LAYOUT_KEY, local);
  testWindow.mixdogDesktop = desktop;
  const renders = [];
  function Harness() {
    const workspace = usePaneWorkspaceState(null);
    // biome-ignore lint/correctness/useHookAtTopLevel: `lifecycle` is fixed for the harness's whole mount, so every render calls the same hooks
    if (lifecycle) useLifecycle(workspace);
    renders.push(workspace);
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
  await pause();
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    host.remove();
    delete testWindow.mixdogDesktop;
  };
  t.after(unmount);
  const current = () => renders.at(-1);
  const pageHide = () => act(async () => void testWindow.dispatchEvent(new testWindow.Event('pagehide')));
  return { renders, current, pageHide, unmount };
}

test('localStorage empty + file present: the stored split tree restores from the file', async (t) => {
  const { api, calls } = bridge({ file: STORED_TEXT });
  const { renders, current } = await mount(t, { desktop: api });
  assert.equal(calls.fileReads, 1);
  // First paint already carries the file's geometry, before the catalog answers; restoring is local and gates nothing.
  assert.deepEqual(shape(renders[0].state.layout), STORED_SHAPE);
  assert.equal(renders[0].restorePending, false);
  assert.equal(current().restorePending, false);
  assert.deepEqual(shape(current().state.layout), STORED_SHAPE);
  assert.equal(current().state.focusedLeafId, 'top');
  assert.equal(current().restoredFromStorage, true);
});

test('a layout the file holds goes through the same validation as localStorage', async (t) => {
  for (const file of ['not json', '{"layout":{"type":"leaf"}}', '', '{"layout":null}']) {
    const { api } = bridge({ file });
    const { renders, current, unmount } = await mount(t, { desktop: api });
    assert.equal(renders[0].state.layout.tabs[0].kind, 'new', JSON.stringify(file));
    assert.equal(current().restoredFromStorage, false);
    await unmount();
  }
});

test('a valid localStorage layout is the first-paint source: the file is not read', async (t) => {
  const { api, calls } = bridge({ file: JSON.stringify({ layout: leaf('other', fileTab), focusedLeafId: 'other' }) });
  const { current } = await mount(t, { desktop: api, local: STORED_TEXT });
  assert.equal(calls.fileReads, 0);
  assert.deepEqual(shape(current().state.layout), STORED_SHAPE);
});

test('a persisted change reaches the profile file once, on the renderer debounce and the page-hide flush', async (t) => {
  const { api, calls } = bridge({ file: STORED_TEXT });
  const { current, pageHide } = await mount(t, { desktop: api });
  await pageHide();
  assert.deepEqual(calls.fileWrites, [JSON.stringify(current().state)]);
  await pageHide();
  assert.equal(calls.fileWrites.length, 1, 'an unchanged layout sends nothing');

  await act(async () =>
    current().setState((prev) => ({
      ...prev,
      layout: { ...prev.layout, ratio: 0.5 },
    }))
  );
  assert.equal(calls.fileWrites.length, 1, 'the change waits for the debounce');
  await pause(300);
  assert.equal(calls.fileWrites.length, 2);
  assert.equal(calls.fileWrites[1], JSON.stringify(current().state));
  assert.equal(testWindow.localStorage.getItem(PANE_LAYOUT_KEY), calls.fileWrites[1], 'the same JSON as localStorage');
  await pageHide();
  assert.equal(calls.fileWrites.length, 2);
});

// The stored layout is the initial value only: facts (the session catalog, the pushed `agentPool` section) reconcile the LIVE
// tree. A restored session tab goes only when both are known and neither vouches for it; the pool is never requested.
const fileB = { kind: 'file', project: '/p', rel: 'b.ts' };
const LEAD = [{ id: 's1' }];
const WORKER_POOL = [{ sessionId: 'w1', ownerSessionId: 's1' }];
/** [left: s1, a.ts | right: ...right], the right leaf focused. */
const workerStored = (...right) =>
  JSON.stringify({
    layout: {
      type: 'split',
      direction: 'row',
      ratio: 0.5,
      first: leaf('left', session('s1'), fileTab),
      second: leaf('right', ...right),
    },
    focusedLeafId: 'right',
  });
const persisted = () => testWindow.localStorage.getItem(PANE_LAYOUT_KEY);
/** Closes a.ts and opens b.ts in the left leaf, focuses it and moves the split. */
const editLeft = (current) =>
  act(async () =>
    current().setState((prev) => ({
      layout: {
        ...prev.layout,
        ratio: 0.3,
        first: { ...prev.layout.first, tabs: [session('s1'), fileB], activeKey: navigationKey(fileB) },
      },
      focusedLeafId: 'left',
    }))
  );

test('edits made before a late pool survive it, and both stored copies hold the live layout', async (t) => {
  const { api, calls } = bridge({ catalog: LEAD, sections: true });
  const { current } = await mount(t, { desktop: api, local: workerStored(session('w1'), session('gone')) });
  assert.equal(current().restorePending, false);
  await editLeft(current);
  await pause(300);
  assert.equal(persisted(), JSON.stringify(current().state), 'persisted while the pool is unknown');

  await api.publishPool(WORKER_POOL);
  assert.deepEqual(shape(current().state.layout), ['row', ['session:s1', 'file:/p:b.ts'], ['session:w1']]);
  assert.equal(current().state.layout.ratio, 0.3);
  assert.equal(current().state.layout.first.activeKey, navigationKey(fileB));
  assert.equal(current().state.focusedLeafId, 'left');
  await pause(300);
  assert.equal(persisted(), JSON.stringify(current().state));
  assert.equal(calls.fileWrites.at(-1), JSON.stringify(current().state));
  assert.deepEqual([calls.sessionReads, calls.poolReads], [1, 0]);
});

test('a pool that never arrives keeps worker tabs in place, gates nothing, and persists them with edits', async (t) => {
  const { api, calls } = bridge({ catalog: LEAD, sections: true });
  const { current, pageHide, unmount } = await mount(t, {
    desktop: api,
    local: workerStored(session('w1'), session('gone')),
  });
  assert.equal(current().restorePending, false);
  assert.deepEqual(shape(current().state.layout), [
    'row',
    ['session:s1', 'file:/p:a.ts'],
    ['session:w1', 'session:gone'],
  ]);
  await editLeft(current);
  await pageHide();
  assert.equal(persisted(), JSON.stringify(current().state));
  assert.deepEqual(shape(JSON.parse(persisted()).layout), [
    'row',
    ['session:s1', 'file:/p:b.ts'],
    ['session:w1', 'session:gone'],
  ]);
  assert.equal(calls.fileWrites.at(-1), persisted());
  assert.deepEqual([calls.sessionReads, calls.poolReads], [1, 0]);
  await unmount();

  // No sections support proves nothing either; and an unreadable catalog with a known pool is unknown too.
  for (const desktop of [bridge({ catalog: LEAD }), bridge({ catalog: null, sections: true, pool: [] })]) {
    const view = await mount(t, { desktop: desktop.api, local: workerStored(session('w1'), session('gone')) });
    assert.deepEqual(shape(view.current().state.layout), [
      'row',
      ['session:s1', 'file:/p:a.ts'],
      ['session:w1', 'session:gone'],
    ]);
    assert.deepEqual([desktop.calls.sessionReads, desktop.calls.poolReads], [1, 0]);
    await view.unmount();
  }
});

test('a session push that beats the mount read governs over the read’s older rows', async (t) => {
  const { api, calls } = bridge({ catalog: LEAD, sections: true, pool: WORKER_POOL });
  let answer;
  api.listSessions = () => {
    calls.sessionReads += 1;
    return new Promise((resolve) => (answer = resolve));
  };
  const { current } = await mount(t, { desktop: api, local: workerStored(session('w1'), session('kept')) });
  // The push lists `kept`; the read, older, does not.
  await act(async () => {
    for (const listener of [...api.listeners]) listener([{ id: 's1' }, { id: 'kept' }]);
  });
  await act(async () => answer(LEAD));
  await pause();
  assert.deepEqual(shape(current().state.layout), [
    'row',
    ['session:s1', 'file:/p:a.ts'],
    ['session:w1', 'session:kept'],
  ]);
  assert.deepEqual([calls.sessionReads, calls.poolReads], [1, 0]);
});

// Bootstrap validation happens once, when the catalog and the pool are first both known; after it, tabs close only through the
// session lifecycle's own rules. An agent home keeps its fixed id for good and is never judged by absence.
const HOME = 'sess_home_lead';
const leafTabs = (current, id) =>
  paneLeaves(current().state.layout)
    .find((node) => node.id === id)
    ?.tabs.map((tab) => navigationKey(tab));
const addToLeft = (current, ...tabs) =>
  act(async () =>
    current().setState((prev) => {
      const left = prev.layout.type === 'leaf' ? prev.layout : prev.layout.first;
      const grown = { ...left, tabs: [...left.tabs, ...tabs] };
      return { ...prev, layout: prev.layout.type === 'leaf' ? grown : { ...prev.layout, first: grown } };
    })
  );

test('a home cleared after start stays open and persisted; an explicit bot deletion still closes it', async (t) => {
  const { api, calls } = bridge({ catalog: [{ id: 's1' }, { id: HOME }], sections: true, pool: [] });
  const { current } = await mount(t, { desktop: api, local: workerStored(session(HOME)), lifecycle: true });
  assert.deepEqual(leafTabs(current, 'right'), [`session:${HOME}`]);
  // `/clear` empties the home: the catalog leaves it out.
  api.catalog = [{ id: 's1' }];
  await api.pushSessions();
  await pause(300);
  assert.deepEqual(leafTabs(current, 'right'), [`session:${HOME}`], 'the cleared home stays open');
  assert.equal(persisted(), JSON.stringify(current().state));
  await act(async () =>
    testWindow.dispatchEvent(new testWindow.CustomEvent(BOT_DELETED_EVENT, { detail: { sessionId: HOME } }))
  );
  await pause();
  assert.deepEqual(shape(current().state.layout), ['session:s1', 'file:/p:a.ts'], 'deleting the bot closes its home');
  assert.equal(calls.poolReads, 0);
});

test('a home absent from the first catalog and a published empty pool survives bootstrap', async (t) => {
  const { api, calls } = bridge({ catalog: LEAD, sections: true, pool: [] });
  const { current } = await mount(t, { desktop: api, local: workerStored(session(HOME), session('gone')) });
  assert.deepEqual(leafTabs(current, 'right'), [`session:${HOME}`], 'the home stays; the unvouched session goes');
  assert.deepEqual([calls.sessionReads, calls.poolReads], [1, 0]);
});

test('a pool whose first publication excludes a restored worker removes that worker alone', async (t) => {
  const { api, calls } = bridge({ catalog: LEAD, sections: true });
  const { current } = await mount(t, { desktop: api, local: workerStored(session('w1'), session('w2')) });
  // Edits while the pool is unknown; focus stays on the right leaf.
  await act(async () =>
    current().setState((prev) => ({
      ...prev,
      layout: {
        ...prev.layout,
        ratio: 0.3,
        first: { ...prev.layout.first, tabs: [session('s1'), fileB], activeKey: navigationKey(fileB) },
      },
    }))
  );
  await api.publishPool([{ sessionId: 'w2', ownerSessionId: 's1' }]);
  assert.deepEqual(shape(current().state.layout), ['row', ['session:s1', 'file:/p:b.ts'], ['session:w2']]);
  assert.equal(current().state.layout.ratio, 0.3);
  assert.equal(
    current().state.layout.second.activeKey,
    'session:w2',
    'the removed tab’s selection moves to what remains'
  );
  assert.equal(current().state.focusedLeafId, 'right');
  await pause(300);
  assert.equal(persisted(), JSON.stringify(current().state));
  assert.deepEqual([calls.sessionReads, calls.poolReads], [1, 0]);
});

test('a worker validated at bootstrap and excluded by a later pool is left alone by the restore', async (t) => {
  const { api, calls } = bridge({ catalog: LEAD, sections: true, pool: WORKER_POOL });
  const { current } = await mount(t, { desktop: api, local: workerStored(session('w1')) });
  await api.publishPool([]);
  await pause(300);
  assert.deepEqual(leafTabs(current, 'right'), ['session:w1']);
  assert.equal(persisted(), JSON.stringify(current().state));
  assert.deepEqual([calls.sessionReads, calls.poolReads], [1, 0]);
});

test('after bootstrap a non-empty catalog dropping a listed session closes its tabs, restored or opened later; an empty one closes nothing', async (t) => {
  const row = (id) => ({ id, title: id, preview: id, archived: false });
  const { api, calls } = bridge({ catalog: ['s1', 's2', 's3'].map(row), sections: true, pool: [] });
  const { current } = await mount(t, { desktop: api, local: workerStored(session('s2')), lifecycle: true });
  await addToLeft(current, session('s3'));
  assert.deepEqual(shape(current().state.layout), [
    'row',
    ['session:s1', 'file:/p:a.ts', 'session:s3'],
    ['session:s2'],
  ]);
  api.catalog = [row('s1')];
  await api.pushSessions();
  assert.deepEqual(
    shape(current().state.layout),
    ['session:s1', 'file:/p:a.ts'],
    'the restored s2 and the later s3 close'
  );
  await addToLeft(current, session('s4'));
  api.catalog = [];
  await api.pushSessions();
  assert.deepEqual(
    shape(current().state.layout),
    ['session:s1', 'file:/p:a.ts', 'session:s4'],
    'an empty catalog closes nothing'
  );
  assert.equal(calls.poolReads, 0);
});

test('a restored tab closed and reopened under the same id before the facts arrive is not closed by bootstrap', async (t) => {
  const { api, calls } = bridge({ catalog: LEAD, sections: true });
  const { current } = await mount(t, { desktop: api, local: workerStored(session('w1')) });
  await act(async () => current().setState((prev) => ({ layout: prev.layout.first, focusedLeafId: 'left' })));
  await pause();
  await addToLeft(current, session('w1'));
  await pause();
  await api.publishPool([]);
  assert.deepEqual(shape(current().state.layout), ['session:s1', 'file:/p:a.ts', 'session:w1']);
  assert.deepEqual([calls.sessionReads, calls.poolReads], [1, 0]);
});

test('the phone surface keeps its behaviour: no file is read, none is written, tabs are not restored', async (t) => {
  const { api, calls } = bridge({ file: STORED_TEXT });
  const { current, pageHide, unmount } = await mount(t, { ua: PHONE_UA, desktop: api, local: STORED_TEXT });
  assert.equal(calls.fileReads, 0);
  assert.equal(current().state.layout.tabs[0].kind, 'new');
  assert.equal(current().restoredFromStorage, false);
  await pageHide();
  await pause(300);
  assert.deepEqual(calls.fileWrites, []);
  // localStorage still follows the live phone tree, as before.
  assert.equal(JSON.parse(testWindow.localStorage.getItem(PANE_LAYOUT_KEY)).layout.tabs[0].kind, 'new');

  await unmount();

  const { api: emptyApi, calls: emptyCalls } = bridge({ file: STORED_TEXT });
  await mount(t, { ua: PHONE_UA, desktop: emptyApi });
  assert.equal(emptyCalls.fileReads, 0, 'not even with localStorage empty');
});
