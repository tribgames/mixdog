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
