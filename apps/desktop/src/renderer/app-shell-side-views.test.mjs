import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import { useSideViewSelection, useSideViewReordering } from './app-shell-side-views.ts';

test('useSideViewSelection routes right-side views to paneSideDocks.select and left-side views to sidebarOpen', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });

  let selectedPaneLeafId = null;
  let selectedDockViewId = null;
  let sidebarOpenApplied = null;
  let activeLeftView = 'sessions';

  const focusedLeafIdRef = { current: 'leaf-1' };
  const paneLeavesRef = {
    current: [{ id: 'leaf-1', tabs: [{ kind: 'session', id: 'session-1' }], activeKey: 'session:session-1' }],
  };

  const actions = {
    sideOf: (id) => (id === 'browser' || id === 'terminal' ? 'right' : 'left'),
    selectDock: (leafId, viewId) => {
      selectedPaneLeafId = leafId;
      selectedDockViewId = viewId;
    },
    activeSideViews: { left: 'sessions', right: 'browser' },
    setActiveSideViews: (updater) => {
      const next = typeof updater === 'function' ? updater({ left: activeLeftView, right: 'browser' }) : updater;
      activeLeftView = next.left;
    },
    sidebarOpen: false,
    applySidebarOpen: (open) => {
      sidebarOpenApplied = open;
    },
    closeSidebarPanels: () => {},
    mountSidebarPanel: () => {},
    trackSidebarPanelModule: () => {},
    refreshProjects: async () => {},
    paneLeavesRef,
    focusedLeafIdRef,
    paneLeaves: paneLeavesRef.current,
    focusedLeafId: 'leaf-1',
    browserSurfaces: {
      ensure: () => {},
    },
    pendingBrowserAutoReveal: { current: new Set() },
    setSessionSideSurface: () => {},
    setSessionPanelView: () => {},
    // The dock chunk is in (boot warm-up): a dock view opens at once.
    dockOpenGate: { module: { peek: () => ({}), load: async () => ({}) }, waits: () => true },
  };

  let selectFn;
  function TestHarness() {
    selectFn = useSideViewSelection(actions);
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () => {
      root.render(React.createElement(TestHarness));
    });

    // Right-side selection (browser) targets pane dock
    await act(async () => {
      selectFn('browser', 'leaf-1');
    });
    assert.equal(selectedPaneLeafId, 'leaf-1');
    assert.equal(selectedDockViewId, 'browser');

    // Left-side selection using non-lazy view (agents) sets active left view and opens sidebar
    await act(async () => {
      selectFn('agents');
    });
    assert.equal(activeLeftView, 'agents');
    assert.equal(sidebarOpenApplied, true);

    // Test ref-advance: update focusedLeafIdRef, select without explicit leafId -> uses new ref value
    focusedLeafIdRef.current = 'leaf-2';
    paneLeavesRef.current = [
      ...paneLeavesRef.current,
      { id: 'leaf-2', tabs: [{ kind: 'session', id: 'session-2' }], activeKey: 'session:session-2' },
    ];

    await act(async () => {
      selectFn('terminal');
    });
    assert.equal(selectedPaneLeafId, 'leaf-2');
    assert.equal(selectedDockViewId, 'terminal');
  } finally {
    await act(async () => {
      root.unmount();
    });
    restore();
  }
});

/** A Visualize chunk whose import the test finishes by hand. */
function slowVisualizeModule() {
  const gate = Promise.withResolvers();
  let loaded = null;
  return {
    peek: () => loaded,
    load: () => gate.promise.then(() => loaded),
    finish: () => {
      loaded = {};
      gate.resolve();
    },
    fail: () => gate.reject(new Error('chunk failed')),
  };
}

async function mountPhoneSelection(module, waits = () => true, dockOpenGate = undefined, extra = {}) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });
  const docked = [];
  const leaf = { id: 'leaf-1', tabs: [{ kind: 'session', id: 'session-1' }], activeKey: 'session:session-1' };
  const other = { id: 'leaf-2', tabs: [{ kind: 'session', id: 'session-3' }], activeKey: 'session:session-3' };
  const paneLeavesRef = { current: [leaf, other] };
  const focusedLeafIdRef = { current: 'leaf-1' };
  const actions = {
    sideOf: (id) => (['browser', 'terminal', 'visualize', 'session-diff'].includes(id) ? 'right' : 'left'),
    selectDock: (leafId, viewId) => docked.push(`${leafId}:${viewId}`),
    activeSideViews: { left: 'sessions', right: 'browser' },
    setActiveSideViews: (update) => docked.push(`left:${update({ left: 'sessions', right: 'browser' }).left}`),
    sidebarOpen: false,
    applySidebarOpen: () => {},
    closeSidebarPanels: () => {},
    mountSidebarPanel: () => {},
    trackSidebarPanelModule: () => {},
    refreshProjects: async () => {},
    paneLeavesRef,
    focusedLeafIdRef,
    browserSurfaces: { ensure: () => {} },
    pendingBrowserAutoReveal: { current: new Set() },
    setSessionSideSurface: () => {},
    setSessionPanelView: () => {},
    visualizeOpenGate: { module, waits },
    ...(dockOpenGate ? { dockOpenGate } : {}),
    ...extra,
  };
  let select;
  function Harness({ paneLeaves, focusedLeafId }) {
    select = useSideViewSelection({ ...actions, paneLeaves, focusedLeafId });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  /** Commits a navigation, as the pane workspace does: new leaves and focus. */
  const navigate = ({ shows = paneLeavesRef.current[0].activeKey, focus = focusedLeafIdRef.current } = {}) =>
    act(async () => {
      paneLeavesRef.current = [{ ...paneLeavesRef.current[0], activeKey: shows }, paneLeavesRef.current[1]];
      focusedLeafIdRef.current = focus;
      root.render(React.createElement(Harness, { paneLeaves: paneLeavesRef.current, focusedLeafId: focus }));
    });
  await navigate();
  return {
    docked,
    navigate,
    select: (id, leafId = 'leaf-1') => act(async () => select(id, leafId)),
    settle: (finish) =>
      act(async () => {
        finish();
        await new Promise((resolve) => setImmediate(resolve));
      }),
    unmount: async () => {
      await act(async () => root.unmount());
      restore();
    },
  };
}

test('a phone Visualize tap before its chunk loads opens the sheet once the chunk is in, not before', async () => {
  const module = slowVisualizeModule();
  const view = await mountPhoneSelection(module);
  try {
    await view.select('visualize');
    assert.deepEqual(view.docked, [], 'no sheet slides open without its body');
    await view.select('visualize');
    // A commit that navigates nowhere keeps the request.
    await view.navigate();
    await view.settle(module.finish);
    assert.deepEqual(view.docked, ['leaf-1:visualize'], 'repeated taps open once');
    await view.select('visualize');
    assert.deepEqual(view.docked, ['leaf-1:visualize', 'leaf-1:visualize'], 'loaded: opens at once');
  } finally {
    await view.unmount();
  }
});

test('a pending phone Visualize open drops on another side view, a drawer dismissal or any pane navigation', async () => {
  const { announceDrawerDismiss } = await import('./drawer-intent.ts');
  const cases = [
    ['another side view', (view) => view.select('terminal'), ['leaf-1:terminal']],
    ['a drawer dismissal', () => act(async () => announceDrawerDismiss()), []],
    ['a pane switch', (view) => view.navigate({ shows: 'session:session-2' }), []],
    [
      'a pane switch that comes back (A, B, then A) before the chunk is in',
      async (view) => {
        await view.navigate({ shows: 'session:session-2' });
        await view.navigate({ shows: 'session:session-1' });
      },
      [],
    ],
    ['focus moving to another pane', (view) => view.navigate({ focus: 'leaf-2' }), []],
    [
      'focus moving away and back',
      async (view) => {
        await view.navigate({ focus: 'leaf-2' });
        await view.navigate({ focus: 'leaf-1' });
      },
      [],
    ],
  ];
  for (const [label, moveOn, expected] of cases) {
    const module = slowVisualizeModule();
    const view = await mountPhoneSelection(module);
    try {
      await view.select('visualize');
      await moveOn(view);
      await view.settle(module.finish);
      assert.deepEqual(view.docked, expected, `${label} drops the pending open`);
    } finally {
      await view.unmount();
    }
  }
});

test("a pending open in an unfocused pane survives the focus move its own tap makes; later navigation still drops it", async () => {
  const own = slowVisualizeModule();
  const view = await mountPhoneSelection(own);
  try {
    // The pane's toggle focuses its pane, then asks for the view there.
    await view.select('visualize', 'leaf-2');
    await view.navigate({ focus: 'leaf-2' });
    await view.settle(own.finish);
    assert.deepEqual(view.docked, ['leaf-2:visualize'], 'the tap that focused the pane still opens its view');
  } finally {
    await view.unmount();
  }
  const later = slowVisualizeModule();
  const moved = await mountPhoneSelection(later);
  try {
    await moved.select('visualize', 'leaf-2');
    await moved.navigate({ focus: 'leaf-2' });
    await moved.navigate({ focus: 'leaf-1' });
    await moved.settle(later.finish);
    assert.deepEqual(moved.docked, [], 'a navigation after the tap drops the open');
  } finally {
    await moved.unmount();
  }
});

test('a failed Visualize import still opens, so the panel reports it; the desktop never waits', async () => {
  const failing = slowVisualizeModule();
  const phone = await mountPhoneSelection(failing);
  try {
    await phone.select('visualize');
    await phone.settle(failing.fail);
    assert.deepEqual(phone.docked, ['leaf-1:visualize']);
  } finally {
    await phone.unmount();
  }
  const desktop = await mountPhoneSelection(slowVisualizeModule(), () => false);
  try {
    await desktop.select('visualize');
    assert.deepEqual(desktop.docked, ['leaf-1:visualize']);
  } finally {
    await desktop.unmount();
  }
});

test('a dock-view tap before the dock chunk loads opens the page once the chunk is in, not before', async () => {
  const module = slowVisualizeModule();
  const phone = await mountPhoneSelection(slowVisualizeModule(), () => true, { module, waits: () => true });
  try {
    await phone.select('agents');
    await phone.select('agents');
    assert.deepEqual(phone.docked, [], 'the drawer does not open Search over a placeholder');
    await phone.settle(module.finish);
    assert.deepEqual(phone.docked, ['left:agents'], 'repeated taps open once, with the chunk');
    await phone.select('agents');
    assert.deepEqual(phone.docked, ['left:agents', 'left:agents'], 'loaded: opens at once');
  } finally {
    await phone.unmount();
  }
  const slow = slowVisualizeModule();
  const moved = await mountPhoneSelection(slowVisualizeModule(), () => true, { module: slow, waits: () => true });
  try {
    await moved.select('agents');
    await moved.select('terminal');
    await moved.settle(slow.finish);
    assert.deepEqual(moved.docked, ['leaf-1:terminal'], 'another view drops the pending dock-view open');
  } finally {
    await moved.unmount();
  }
  const failing = slowVisualizeModule();
  const failed = await mountPhoneSelection(slowVisualizeModule(), () => true, { module: failing, waits: () => true });
  try {
    await failed.select('agents');
    await failed.settle(failing.fail);
    assert.deepEqual(failed.docked, ['left:agents'], 'a failed import still opens, so the dock reports it');
  } finally {
    await failed.unmount();
  }
});

test('a Search tap waits for its project root listing too, then opens with rows already cached', async () => {
  const { resetExplorerRootCache, peekExplorerRoot, setCurrentExplorerProject } = await import(
    './explorer-root-cache.ts'
  );
  const { utilityDockModule } = await import('./app-snapshot-views.tsx');
  await utilityDockModule.load();
  const reads = [];
  const api = {
    listProjectDir: (project, rel) => {
      const read = Promise.withResolvers();
      reads.push({ project, rel, read });
      return read.promise;
    },
  };
  const loaded = { peek: () => ({}), load: async () => ({}) };
  {
    resetExplorerRootCache();
    setCurrentExplorerProject('C:/demo');
    const view = await mountPhoneSelection(loaded, () => true, undefined, { explorerProjectPath: 'C:/demo' });
    window.mixdogDesktop = api;
    try {
      await view.select('search');
      await view.select('search');
      assert.deepEqual(view.docked, [], 'the chunk is in but the root is not: nothing opens yet');
      assert.equal(reads.length, 1, 'one read serves both taps');
      assert.equal(peekExplorerRoot('C:/demo'), undefined);
      await act(async () => {
        reads[0].read.resolve([{ name: 'src', dir: true }]);
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.deepEqual(view.docked, ['left:search'], 'opens once, with the root cached for its first frame');
      assert.equal(peekExplorerRoot('C:/demo').length, 1);
      await view.select('search');
      assert.deepEqual(view.docked, ['left:search', 'left:search'], 'cached root: opens at once');
    } finally {
      await view.unmount();
    }
    // A failed read opens anyway: the tree reports it itself.
    resetExplorerRootCache();
    setCurrentExplorerProject('C:/demo');
    reads.length = 0;
    const failing = await mountPhoneSelection(loaded, () => true, undefined, { explorerProjectPath: 'C:/demo' });
    window.mixdogDesktop = api;
    try {
      await failing.select('search');
      assert.deepEqual(failing.docked, []);
      await act(async () => {
        reads[0].read.reject(new Error('EACCES'));
        await new Promise((resolve) => setImmediate(resolve));
      });
      assert.deepEqual(failing.docked, ['left:search']);
      // The failure is kept for the tree that opens: a further tap opens at once, no new read.
      await failing.select('search');
      assert.deepEqual(failing.docked, ['left:search', 'left:search']);
      assert.equal(reads.length, 1);
    } finally {
      await failing.unmount();
    }
    // Another view, or a drawer dismissal, drops the pending Search open.
    const { announceDrawerDismiss } = await import('./drawer-intent.ts');
    for (const moveOn of [(v) => v.select('terminal'), () => act(async () => announceDrawerDismiss())]) {
      resetExplorerRootCache();
      setCurrentExplorerProject('C:/demo');
      reads.length = 0;
      const dropped = await mountPhoneSelection(loaded, () => true, undefined, { explorerProjectPath: 'C:/demo' });
      window.mixdogDesktop = api;
      try {
        await dropped.select('search');
        await moveOn(dropped);
        const before = [...dropped.docked];
        await act(async () => {
          reads[0].read.resolve([]);
          await new Promise((resolve) => setImmediate(resolve));
        });
        assert.deepEqual(dropped.docked, before, 'a request the user moved on from never opens');
      } finally {
        await dropped.unmount();
      }
    }
  }
});

test('useSideViewReordering enforces right-side immovable invariant', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><div id="root"></div>',
    jsdom: { url: 'about:blank' },
  });

  let moveGroupCalled = false;
  let moveViewCalled = false;
  const sideOf = (id) => (id === 'browser' ? 'right' : 'left');
  const moveGroup = () => {
    moveGroupCalled = true;
  };
  const moveView = () => {
    moveViewCalled = true;
  };
  const setActiveSideViews = () => {};
  const applySidebarOpen = () => {};

  let reordering;
  function TestHarness() {
    reordering = useSideViewReordering(sideOf, moveGroup, moveView, setActiveSideViews, applySidebarOpen);
    return null;
  }

  const root = createRoot(dom.window.document.getElementById('root'));
  try {
    await act(async () => {
      root.render(React.createElement(TestHarness));
    });

    // 1. Moving a right-side group/view is prohibited and must NOT call moveGroup/moveView
    await act(async () => {
      reordering.moveWorkbenchSideGroup('browser', 'left', 'sessions', 'after');
    });
    assert.equal(moveGroupCalled, false, 'Moving right-side group must be blocked');

    await act(async () => {
      reordering.moveWorkbenchSideView('browser', 'left', 'sessions', 'after');
    });
    assert.equal(moveViewCalled, false, 'Moving right-side view must be blocked');

    // 2. Moving to right side is also blocked
    await act(async () => {
      reordering.moveWorkbenchSideGroup('sessions', 'right', 'browser', 'after');
    });
    assert.equal(moveGroupCalled, false, 'Moving group to right side must be blocked');

    // 3. Moving left-to-left is allowed
    await act(async () => {
      reordering.moveWorkbenchSideGroup('sessions', 'left', 'agents', 'after');
    });
    assert.equal(moveGroupCalled, true, 'Moving left group to left must be permitted');
  } finally {
    await act(async () => {
      root.unmount();
    });
    restore();
  }
});
