import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: {
    url: 'https://mixdog.test/',
  },
  expose: ['HTMLElement'],
});

const { useAgentBrowserSurfaceRequests } = await import('./use-agent-browser-surface-requests.ts');
const { useSessionPaneSurfaces } = await import('./use-session-pane-surfaces.ts');
const { sessionSideDockEntryForSession } = await import('./session-side-surface-policy.ts');

test('agent hide folds only its browser, retains pages, and cancels deferred reveal', async () => {
  let receive;
  window.mixdogDesktop = {
    onBrowserOpenRequested(listener) {
      receive = listener;
      return () => {
        receive = null;
      };
    },
  };
  const createdPages = new Set();
  const selections = [];
  let prefetches = 0;
  let surfaces;
  const browserSurfaces = {
    ensure(sessionId) {
      createdPages.add(sessionId);
    },
    release() {
      assert.fail('visibility must not release a page');
    },
  };
  const select = (leafId, surface) => selections.push([leafId, surface]);
  const prefetch = async () => {
    prefetches += 1;
  };
  const owner = (sessionId, leafId = sessionId) => ({ sessionId, leafId });
  function Harness({ owners }) {
    surfaces = useSessionPaneSurfaces();
    useAgentBrowserSurfaceRequests({
      owners,
      focusedLeafId: 'alpha',
      surfaces: { ...surfaces, browserSurfaces },
      select,
      prefetch,
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = async (owners) => {
    await act(async () => root.render(React.createElement(Harness, { owners })));
  };
  const send = async (request) => {
    await act(async () => receive(request));
  };
  try {
    await render([owner('alpha'), owner('beta'), owner('alpha', 'alpha-copy')]);
    await send({ sessionId: 'missing', hide: true });
    assert.equal(prefetches, 0);
    assert.equal(createdPages.size, 0);

    await send({ sessionId: 'alpha' });
    await send({ sessionId: 'beta' });
    assert.deepEqual(selections, [
      ['alpha', 'browser'],
      ['beta', 'browser'],
    ]);
    assert.equal(surfaces.sessionSideSurfaces.get('alpha'), 'browser');
    await send({ sessionId: 'alpha', hide: true, reveal: true });
    assert.equal(prefetches, 2);
    assert.deepEqual([...createdPages], ['alpha', 'beta']);
    assert.equal(surfaces.sessionSideSurfaces.has('alpha'), false);
    assert.equal(surfaces.sessionSideSurfaces.get('beta'), 'browser');
    const folded = sessionSideDockEntryForSession(
      {
        open: true,
        view: 'sourceControl',
        surface: 'browser',
        diff: null,
      },
      'alpha',
      surfaces.sessionSideSurfaces.get('alpha') ?? null
    );
    assert.equal(folded.open, false);
    assert.equal(folded.surface, '');

    await send({ sessionId: 'alpha' });
    assert.equal(surfaces.sessionSideSurfaces.get('alpha'), 'browser');
    await act(async () => surfaces.setSessionSideSurface('alpha', 'terminal'));
    await send({ sessionId: 'alpha', hide: true });
    assert.equal(surfaces.sessionSideSurfaces.get('alpha'), 'terminal');

    // Ordered IPC messages can arrive in the same React batch.
    await act(async () => {
      receive({ sessionId: 'alpha' });
      receive({ sessionId: 'alpha', hide: true });
    });
    assert.equal(surfaces.sessionSideSurfaces.has('alpha'), false);

    await send({ sessionId: 'parked', reveal: false });
    assert.equal(createdPages.has('parked'), true);
    assert.equal(surfaces.sessionSideSurfaces.has('parked'), false);
    await send({ sessionId: 'hidden' });
    assert.equal(surfaces.pendingBrowserAutoReveal.current.has('hidden'), true);
    await send({ sessionId: 'hidden', hide: true });
    assert.equal(surfaces.pendingBrowserAutoReveal.current.has('hidden'), false);
    const selectionCount = selections.length;
    await render([owner('hidden')]);
    assert.equal(selections.length, selectionCount);
    assert.equal(surfaces.sessionSideSurfaces.has('hidden'), false);
    await send({ sessionId: 'hidden' });
    assert.deepEqual(selections.at(-1), ['hidden', 'browser']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

/** The real surfaces and a child's reveal requests over the panes `owners`
 *  names; `peeksOf(owner)` reads that conversation's child lines. */
async function mountChildReveals(t, pool, owners) {
  const { childSurfacePeeksOf } = await import('./child-surface-peeks.tsx');
  let receive;
  window.mixdogDesktop = {
    onBrowserOpenRequested(listener) {
      receive = listener;
      return () => {};
    },
  };
  const shell = { surfaces: null, ensured: [], selections: [], owners };
  const ownerSources = () => ({ sessions: [], pool });
  function Harness() {
    shell.surfaces = useSessionPaneSurfaces();
    useAgentBrowserSurfaceRequests({
      owners: shell.owners,
      focusedLeafId: shell.owners[0]?.leafId ?? '',
      surfaces: { ...shell.surfaces, browserSurfaces: { ensure: (id) => shell.ensured.push(id) } },
      ownerSources,
      prefetch: async () => {},
      select: (leafId, surface) => shell.selections.push([leafId, surface]),
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(async () => root.render(React.createElement(Harness)));
  await render();
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  shell.send = (request) => act(async () => receive(request));
  shell.show = async (next) => {
    shell.owners = next;
    await render();
  };
  shell.peeksOf = childSurfacePeeksOf;
  return shell;
}

// The child lines are one store for the app's lifetime: each test names its
// own sessions.
const childPool = (id) => [
  { sessionId: id('kid-1'), parentSessionId: id('boss'), ownerSessionId: id('boss'), title: '시장 조사', tag: 'w1' },
  { sessionId: id('kid-2'), parentSessionId: id('boss'), ownerSessionId: id('boss'), title: '검토', tag: 'w2' },
  { sessionId: id('kid-3'), parentSessionId: id('kid-1'), ownerSessionId: id('boss'), title: '깊이 보기', tag: 'w3' },
];
const CHILD_POOL = childPool((name) => name);

test('a child browser reveal opens its page as a borrowed tab in the owner dock, with its line there', async (t) => {
  const { borrowedBrowserTab } = await import('./browser-pane-borrowed-tab.ts');
  const shell = await mountChildReveals(t, CHILD_POOL, [{ sessionId: 'boss', leafId: 'pane-a' }]);
  await shell.send({ sessionId: 'kid-1', reveal: true, tabId: 'p3', title: '공시 검색' });
  assert.deepEqual(shell.selections, [['pane-a', 'browser']]);
  assert.equal(shell.surfaces.sessionSideSurfaces.get('boss'), 'browser');
  assert.deepEqual(borrowedBrowserTab('boss'), { ownerSessionId: 'kid-1', ownerName: '시장 조사', tabId: 'p3' });
  assert.deepEqual(
    shell.peeksOf('boss').map(({ childSessionId, childName, tabId, title, failed }) => [childSessionId, childName, tabId, title, failed]),
    [['kid-1', '시장 조사', 'p3', '공시 검색', '']]
  );
  // A failed open: its line says why, and nothing opens.
  await shell.send({ sessionId: 'kid-2', reveal: true, error: '정책에 막힌 주소' });
  assert.equal(shell.selections.length, 1);
  assert.equal(shell.ensured.includes('kid-2'), false);
  assert.equal(shell.peeksOf('boss').find((entry) => entry.childSessionId === 'kid-2').failed, '정책에 막힌 주소');
  // The child's hide folds the owner's dock showing its page.
  await shell.send({ sessionId: 'kid-1', hide: true });
  assert.equal(shell.surfaces.sessionSideSurfaces.has('boss'), false);
  assert.equal(borrowedBrowserTab('boss'), null);
});

test('a background child reveal still leaves its line in the owner, success and failure alike', async (t) => {
  const { borrowedBrowserTab } = await import('./browser-pane-borrowed-tab.ts');
  const id = (name) => `bg-${name}`;
  const shell = await mountChildReveals(t, childPool(id), [{ sessionId: 'elsewhere', leafId: 'pane-x' }]);
  await shell.send({ sessionId: id('kid-1'), reveal: true, tabId: 'p4', title: '공시' });
  await shell.send({ sessionId: id('kid-2'), reveal: true, error: '열 수 없는 주소' });
  assert.deepEqual(shell.selections, [], 'nothing on screen opens');
  assert.deepEqual(
    shell.peeksOf(id('boss')).map(({ childSessionId, failed }) => [childSessionId, failed]),
    [
      [id('kid-1'), ''],
      [id('kid-2'), '열 수 없는 주소'],
    ]
  );
  // The owner comes on screen: the waiting reveal opens there, its line kept.
  await shell.show([{ sessionId: id('boss'), leafId: 'pane-a' }]);
  assert.deepEqual(shell.selections, [['pane-a', 'browser']]);
  assert.equal(borrowedBrowserTab(id('boss'))?.tabId, 'p4');
  assert.equal(shell.peeksOf(id('boss')).length, 2);
});

test('the line goes where the reveal goes: a visible intermediate parent, now or on its return', async (t) => {
  const { borrowedBrowserTab } = await import('./browser-pane-borrowed-tab.ts');
  const id = (name) => `mid-${name}`;
  const has = (owner, child) => shell.peeksOf(id(owner)).some((entry) => entry.childSessionId === id(child));
  const shell = await mountChildReveals(t, childPool(id), [{ sessionId: id('kid-1'), leafId: 'pane-p' }]);
  // kid-3 → kid-1 (on screen) → boss (off screen).
  await shell.send({ sessionId: id('kid-3'), reveal: true, tabId: 'p5' });
  assert.deepEqual(shell.selections, [['pane-p', 'browser']]);
  assert.equal(borrowedBrowserTab(id('kid-1'))?.ownerSessionId, id('kid-3'));
  assert.equal(has('kid-1', 'kid-3'), true);
  assert.equal(has('boss', 'kid-3'), false);

  // Deferred: with none of the chain shown the line waits in the owner, and
  // moves to the intermediate parent the reveal opens in on its return.
  await shell.show([{ sessionId: 'elsewhere', leafId: 'pane-x' }]);
  await shell.send({ sessionId: id('kid-3'), reveal: true, tabId: 'p7' });
  assert.equal(has('boss', 'kid-3'), true);
  assert.equal(has('kid-1', 'kid-3'), false, 'one line per child surface');
  await shell.show([{ sessionId: id('kid-1'), leafId: 'pane-p' }]);
  assert.equal(borrowedBrowserTab(id('kid-1'))?.tabId, 'p7');
  assert.equal(shell.peeksOf(id('kid-1')).find((entry) => entry.childSessionId === id('kid-3'))?.tabId, 'p7');
  assert.equal(has('boss', 'kid-3'), false);
});

test("a child's login hand-off opens its handed-over page in the delegating conversation", async (t) => {
  const { borrowedBrowserTab } = await import('./browser-pane-borrowed-tab.ts');
  const id = (name) => `ho-${name}`;
  const shell = await mountChildReveals(t, childPool(id), [{ sessionId: id('boss'), leafId: 'pane-a' }]);
  // The user closed the owner's browser panel; a takeover opens it anyway.
  await act(async () => shell.surfaces.dismissBrowserSurface(id('boss')));
  await shell.send({ sessionId: id('kid-1'), reveal: true, handoff: true, tabId: 'p9', title: 'Sign in' });
  assert.deepEqual(shell.selections, [['pane-a', 'browser']]);
  assert.deepEqual(borrowedBrowserTab(id('boss')), { ownerSessionId: id('kid-1'), ownerName: '시장 조사', tabId: 'p9' });
});

test("closing the owner's dock drops the child page it borrowed, so the dock reopens on its own browser", async (t) => {
  const { borrowedBrowserTab } = await import('./browser-pane-borrowed-tab.ts');
  const id = (name) => `cl-${name}`;
  const shell = await mountChildReveals(t, childPool(id), [{ sessionId: id('boss'), leafId: 'pane-a' }]);
  await shell.send({ sessionId: id('kid-1'), reveal: true, tabId: 'p9' });
  assert.equal(borrowedBrowserTab(id('boss'))?.ownerSessionId, id('kid-1'));
  // The dock's ✕ (closePaneRightRegion → dismissDockEntry) dismisses the viewer's browser surface.
  await act(async () => shell.surfaces.dismissBrowserSurface(id('boss')));
  assert.equal(borrowedBrowserTab(id('boss')), null);
});

test('a waiting reveal forgets its page on hide, suppression and deletion', async (t) => {
  const { borrowedBrowserTab } = await import('./browser-pane-borrowed-tab.ts');
  const id = (name) => `pend-${name}`;
  const away = [{ sessionId: 'elsewhere', leafId: 'pane-x' }];
  const owner = [{ sessionId: id('boss'), leafId: 'pane-a' }];
  const shell = await mountChildReveals(t, childPool(id), away);
  const cancelThenReturn = async (cancel) => {
    await shell.show(away);
    await shell.send({ sessionId: id('kid-1'), reveal: true, tabId: 'p1' });
    assert.deepEqual(shell.surfaces.pendingBrowserAutoReveal.current.get(id('kid-1')), {
      tabId: 'p1',
      ownerName: '시장 조사',
    });
    await cancel();
    assert.equal(shell.surfaces.pendingBrowserAutoReveal.current.has(id('kid-1')), false);
    // A later reveal naming no page waits too; the cancelled page must not come back with it.
    await shell.send({ sessionId: id('kid-1'), reveal: true, handoff: true });
    await shell.show(owner);
    assert.equal(borrowedBrowserTab(id('boss')), null);
    assert.deepEqual(shell.selections, []);
    await shell.send({ sessionId: id('kid-1'), hide: true });
  };
  await cancelThenReturn(() => shell.send({ sessionId: id('kid-1'), hide: true }));
  await cancelThenReturn(async () => {
    await act(async () => shell.surfaces.dismissBrowserSurface(id('kid-1')));
    await shell.send({ sessionId: id('kid-1'), reveal: true });
  });
  await cancelThenReturn(() => act(async () => shell.surfaces.releaseDeletedSessionSurfaces(id('kid-1'))));
});

test("a deleted child's borrowed page is forgotten even while the owner's dock shows its terminal", async (t) => {
  const { borrowedBrowserTab } = await import('./browser-pane-borrowed-tab.ts');
  const id = (name) => `del-${name}`;
  const shell = await mountChildReveals(t, childPool(id), [{ sessionId: id('boss'), leafId: 'pane-a' }]);
  await shell.send({ sessionId: id('kid-1'), reveal: true, tabId: 'p3' });
  assert.equal(borrowedBrowserTab(id('boss'))?.tabId, 'p3');
  await act(async () => shell.surfaces.setSessionSideSurface(id('boss'), 'terminal'));
  await act(async () => shell.surfaces.releaseDeletedSessionSurfaces(id('kid-1')));
  assert.equal(borrowedBrowserTab(id('boss')), null, 'the association goes');
  assert.equal(shell.surfaces.sessionSideSurfaces.get(id('boss')), 'terminal', 'only a dock on that browser folds');
});

test('runtime unload keeps the remembered browser dock while deletion forgets it', async () => {
  let receiveRelease;
  window.mixdogDesktop = {
    onBrowserSessionReleased(listener) {
      receiveRelease = listener;
      return () => {
        receiveRelease = null;
      };
    },
  };
  let surfaces;
  function Harness() {
    surfaces = useSessionPaneSurfaces();
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await act(async () => surfaces.setSessionSideSurface('alpha', 'browser'));
    await act(async () => receiveRelease('alpha', 'unloaded'));
    assert.equal(surfaces.sessionSideSurfaces.get('alpha'), 'browser');
    await act(async () => receiveRelease('alpha', 'gone'));
    assert.equal(surfaces.sessionSideSurfaces.has('alpha'), false);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('open policy: agent work never opens the panel, a takeover does, and the "보기" press always does', async () => {
  const { usePaneSideDocks } = await import('./pane-side-dock.tsx');
  const { revealBrowserPane } = await import('./browser-page-request.ts');
  let receive, surfaces, docks;
  window.mixdogDesktop = {
    onBrowserOpenRequested(listener) {
      receive = listener;
      return () => {};
    },
  };
  function Harness() {
    surfaces = useSessionPaneSurfaces();
    docks = usePaneSideDocks({ leafIds: ['alpha'], groups: [['sourceControl'], ['browser']] });
    useAgentBrowserSurfaceRequests({
      owners: [{ sessionId: 'alpha', leafId: 'alpha' }],
      focusedLeafId: 'alpha',
      surfaces: { ...surfaces, browserSurfaces: { ensure() {} } },
      prefetch: async () => {},
      select: docks.select,
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    // The user is on another dock tab while the agent works: nothing moves.
    await act(async () => docks.select('alpha', 'sourceControl'));
    const original = docks.entryFor('alpha');
    await act(async () => receive({ sessionId: 'alpha', reveal: false }));
    assert.deepEqual(docks.entryFor('alpha'), original, 'keeping the surface live never switches the dock');
    assert.equal(surfaces.sessionSideSurfaces.has('alpha'), false);

    // The transcript's "브라우저 · 보기" opens the panel on its current page.
    await act(async () => revealBrowserPane('alpha'));
    assert.equal(docks.entryFor('alpha').surface, 'browser');
    assert.equal(docks.entryFor('alpha').open, true);
    assert.equal(surfaces.sessionSideSurfaces.get('alpha'), 'browser');

    // The user closes it; a takeover still opens it, because the user must act.
    await act(async () => {
      surfaces.dismissBrowserSurface('alpha');
      docks.setOpen('alpha', false);
    });
    await act(async () => receive({ sessionId: 'alpha', reveal: true }));
    assert.equal(docks.entryFor('alpha').open, false, 'a plain reveal respects the manual close');
    await act(async () => receive({ sessionId: 'alpha', reveal: true, handoff: true }));
    assert.equal(docks.entryFor('alpha').open, true, 'a takeover opens the panel at once');
    assert.equal(docks.entryFor('alpha').surface, 'browser');
    assert.equal(surfaces.sessionSideSurfaces.get('alpha'), 'browser', 'and it stays open after "다 했어요"');

    // Closed again: the user's own press always reopens it.
    await act(async () => {
      surfaces.dismissBrowserSurface('alpha');
      docks.setOpen('alpha', false);
    });
    await act(async () => revealBrowserPane('alpha'));
    assert.equal(docks.entryFor('alpha').open, true);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('a remote-shim open request reveals and hides that session browser surface', async () => {
  const { createRemoteApi } = await import('./remote-shim-api.ts');
  const ctx = { browserOpenListeners: new Set() };
  window.mixdogDesktop = createRemoteApi(ctx);
  const deliver = (request) => {
    for (const listener of [...ctx.browserOpenListeners]) listener(request);
  };
  const selections = [];
  let surfaces;
  function Harness() {
    surfaces = useSessionPaneSurfaces();
    useAgentBrowserSurfaceRequests({
      owners: [{ sessionId: 'alpha', leafId: 'leaf' }],
      focusedLeafId: 'leaf',
      surfaces: { ...surfaces, browserSurfaces: { ensure() {} } },
      prefetch: async () => {},
      select: (leafId, surface) => selections.push([leafId, surface]),
    });
    return null;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(ctx.browserOpenListeners.size, 1);
    await act(async () => deliver({ sessionId: 'alpha', reveal: true }));
    assert.deepEqual(selections, [['leaf', 'browser']]);
    assert.equal(surfaces.sessionSideSurfaces.get('alpha'), 'browser');
    await act(async () => deliver({ sessionId: 'alpha', hide: true }));
    assert.equal(surfaces.sessionSideSurfaces.has('alpha'), false);
  } finally {
    await act(async () => root.unmount());
    assert.equal(ctx.browserOpenListeners.size, 0);
    host.remove();
  }
});
