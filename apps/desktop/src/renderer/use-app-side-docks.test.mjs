// Phone back button vs the right side dock: the dock the user sees is the
// pane entry overridden by its session's own surface (diff, visualize,
// browser, terminal), so back must follow that displayed state — and fold it —
// whichever way the dock was opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useAppSideDocks } from './use-app-side-docks.ts';
import { useSessionPaneSurfaces } from './use-session-pane-surfaces.ts';
import { useAppMobileBack } from './app-shell-mobile-back.ts';
import { useSideViewSelection } from './app-shell-side-views.ts';
import { sideFileKey, sideFileTabDirtyKey } from './side-file-tabs.ts';
import { paneDockEntryForSession } from './session-side-surface-policy.ts';

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mixdog.test/' });
dom.window.document.documentElement.setAttribute('data-mixdog-mobile-tabs', '');
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] ?? value });
}
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom.window });

const session = (id) => ({ kind: 'session', id });
const leaf = (id, sessionId) => ({ type: 'leaf', id, tabs: [session(sessionId)], activeKey: `session:${sessionId}` });
const diff = { kind: 'diff', project: 'C:/p', rel: 'src/a.ts', source: 'session' };

function afterPopState(trigger) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('popstate never arrived')), 2_000);
    const once = () => {
      clearTimeout(timer);
      dom.window.removeEventListener('popstate', once);
      setTimeout(resolve, 0);
    };
    dom.window.addEventListener('popstate', once);
    trigger();
  });
}

const backProps = {
  sidebarOpen: false,
  applySidebarOpen: () => {},
  bottomPanelOpen: false,
  setBottomPanelOpen: () => {},
  settingsOpen: false,
  setSettingsOpen: () => {},
  commandSurface: null,
  closeCommandSurface: () => {},
  onboardingOpen: false,
  setOnboardingOpen: () => {},
  closeQuickAccess: () => {},
  pendingUnsavedClose: false,
  cancelPendingTabClose: () => {},
  updateDialogOpen: false,
  updaterState: { status: 'idle' },
  closeDesktopUpdate: () => {},
};

/** Mounts the real side-dock + mobile-back hooks the way the hub wires them. */
async function mountPhone({ leaves, focusedLeafId }) {
  const api = {};
  function Harness() {
    const sessionSurfaces = useSessionPaneSurfaces();
    const sideDocks = useAppSideDocks({
      paneWorkspace: { leaves, focusedLeafId },
      sessionSurfaces,
      applySidebarOpen: () => {},
    });
    const [menuOpen, setMenuOpen] = useState(false);
    Object.assign(api, { sessionSurfaces, sideDocks, setMenuOpen });
    useAppMobileBack({
      ...backProps,
      focusedPaneDockOpen: sideDocks.focusedPaneDockOpen,
      closeFocusedPaneDock: () => sideDocks.closePaneRightRegion(focusedLeafId),
      quickAccessMode: menuOpen ? 'commands' : null,
      closeQuickAccess: () => setMenuOpen(false),
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  api.unmount = () => act(async () => root.unmount());
  api.displayedOpen = () => {
    const sessionId = leaves.find((candidate) => candidate.id === focusedLeafId).tabs[0].id;
    return Boolean(
      api.sessionSurfaces.sessionDiffs.get(sessionId) ||
        api.sessionSurfaces.sessionSideSurfaces.get(sessionId) ||
        api.sessionSurfaces.sessionPanelViews.get(sessionId) ||
        api.sideDocks.paneSideDocks.entryFor(focusedLeafId).open
    );
  };
  return api;
}

function installWatchers() {
  const watchers = [];
  const activation = { isActive: true };
  dom.window.CloseWatcher = class {
    onclose = null;
    destroyed = false;
    constructor() {
      watchers.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
  };
  Object.defineProperty(dom.window.navigator, 'userActivation', { configurable: true, value: activation });
  return {
    watchers,
    activation,
    live: () => watchers.filter((watcher) => !watcher.destroyed),
    uninstall() {
      delete dom.window.CloseWatcher;
      delete dom.window.navigator.userActivation;
    },
  };
}

const LEAVES = [leaf('L1', 's1')];

// Each test starts from an empty dock store: a pane entry an earlier test left
// stored open would be restored on mount (a reload brings a terminal back).
test.beforeEach(() => dom.window.localStorage.clear());

/** Hardware back on the history path, then let React settle the close. */
async function back() {
  await act(async () => {
    await afterPopState(() => dom.window.history.back());
  });
}

test('history path: a session diff that never touched the pane entry closes on back', async () => {
  const phone = await mountPhone({ leaves: LEAVES, focusedLeafId: 'L1' });
  try {
    assert.equal(phone.sideDocks.focusedPaneDockOpen, false);
    await act(async () => phone.sessionSurfaces.setSessionDiff('s1', diff));
    assert.equal(phone.sideDocks.paneSideDocks.entryFor('L1').open, false, 'the pane entry stays closed');
    assert.equal(phone.sideDocks.focusedPaneDockOpen, true, 'back must see the displayed dock');

    await back();
    assert.equal(phone.sessionSurfaces.sessionDiffs.has('s1'), false);
    assert.equal(phone.sideDocks.focusedPaneDockOpen, false);
  } finally {
    await phone.unmount();
  }
});

test('history path: visualize opened by the agent (no activation) closes on back', async () => {
  const phone = await mountPhone({ leaves: LEAVES, focusedLeafId: 'L1' });
  try {
    await act(async () => {
      phone.sessionSurfaces.setSessionSideSurface('s1', null);
      phone.sessionSurfaces.setSessionPanelView('s1', 'visualize');
    });
    assert.equal(phone.sideDocks.focusedPaneDockOpen, true);

    await back();
    assert.equal(phone.sessionSurfaces.sessionPanelViews.has('s1'), false);
    assert.equal(phone.displayedOpen(), false);
  } finally {
    await phone.unmount();
  }
});

test('history path: a menu inside the dock closes first, then the dock', async () => {
  const phone = await mountPhone({ leaves: LEAVES, focusedLeafId: 'L1' });
  try {
    await act(async () => phone.sessionSurfaces.setSessionSideSurface('s1', 'terminal'));
    await act(async () => phone.setMenuOpen(true));

    await back();
    assert.equal(phone.sideDocks.focusedPaneDockOpen, true, 'first back only closes the menu');

    await back();
    assert.equal(phone.displayedOpen(), false, 'second back folds the dock');
  } finally {
    await phone.unmount();
  }
});

test('back folds the dock of the focused pane, not the first one', async () => {
  const leaves = [leaf('L1', 's1'), leaf('L2', 's2')];
  const phone = await mountPhone({ leaves, focusedLeafId: 'L2' });
  try {
    await act(async () => phone.sessionSurfaces.setSessionDiff('s2', diff));
    assert.equal(phone.sideDocks.focusedPaneDockOpen, true);

    await back();
    assert.equal(phone.sessionSurfaces.sessionDiffs.has('s2'), false);
    assert.equal(phone.sideDocks.focusedPaneDockOpen, false);
  } finally {
    await phone.unmount();
  }
});

const DOCK_KEY = 'mixdog.desktop.pane-side-dock.v1';

test("reload: a terminal dock stored open comes back open on its pane's session, and only there", async () => {
  dom.window.localStorage.clear();
  const entry = (open, surface) => ({ open, view: null, surface, diff: null });
  dom.window.localStorage.setItem(
    DOCK_KEY,
    JSON.stringify({ L1: entry(true, 'terminal'), L2: entry(false, 'terminal'), L3: entry(true, '') })
  );
  const leaves = [leaf('L1', 's1'), leaf('L2', 's2'), leaf('L3', 's3')];
  const phone = await mountPhone({ leaves, focusedLeafId: 'L1' });
  try {
    assert.equal(phone.sessionSurfaces.sessionSideSurfaces.get('s1'), 'terminal');
    assert.equal(phone.sideDocks.focusedPaneDockOpen, true, 'the displayed dock is the terminal');
    assert.equal(phone.sessionSurfaces.sessionSideSurfaces.has('s2'), false, 'a dock closed on purpose stays closed');
    assert.equal(phone.sessionSurfaces.sessionSideSurfaces.has('s3'), false, 'no terminal surface to restore');
  } finally {
    // Folded again like every other test here: the mobile-back hook keeps
    // module-level history bookkeeping that an unmount with an open dock leaves behind.
    // A UI-side close pops the dock's history sentinel; wait for that popstate
    // echo, or the next test opens its dock while the echo is still pending
    // and gets a sentinel instead of a CloseWatcher.
    // The sentinel is popped by the layer's effect cleanup, which runs when
    // the closing act settles, so listen before it and wait after it.
    const echo = new Promise((resolve) =>
      dom.window.addEventListener('popstate', () => setTimeout(resolve, 0), { once: true })
    );
    await act(async () => phone.sideDocks.closePaneRightRegion('L1'));
    await act(async () => {
      await echo;
    });
    await phone.unmount();
    dom.window.localStorage.clear();
  }
});

test('CloseWatcher path: a user-opened dock closes through its watcher', async () => {
  const { live, uninstall } = installWatchers();
  const phone = await mountPhone({ leaves: LEAVES, focusedLeafId: 'L1' });
  try {
    const state = dom.window.history.state;
    await act(async () => phone.sessionSurfaces.setSessionSideSurface('s1', 'terminal'));
    assert.equal(live().length, 1);
    assert.equal(dom.window.history.state, state, 'user opens never touch history');

    await act(async () => live()[0].onclose());
    assert.equal(phone.displayedOpen(), false);
  } finally {
    await phone.unmount();
    uninstall();
  }
});

test('CloseWatcher path: an agent-opened visualize dock (no activation) falls back to a sentinel', async () => {
  const { watchers, activation, uninstall } = installWatchers();
  const phone = await mountPhone({ leaves: LEAVES, focusedLeafId: 'L1' });
  try {
    activation.isActive = false;
    await act(async () => phone.sessionSurfaces.setSessionPanelView('s1', 'visualize'));
    assert.equal(watchers.length, 0, 'no CloseWatcher without activation');
    assert.equal(dom.window.history.state?.mixdogBack, 1);

    await back();
    assert.equal(phone.displayedOpen(), false);
  } finally {
    await phone.unmount();
    uninstall();
  }
});

test('file tabs opened beside a session stay with it: a bot chat in the same pane shows no foreign panel', async () => {
  const BOT = 'sess_home_agent-marketer';
  const pane = (active) => ({
    type: 'leaf',
    id: 'L1',
    tabs: [session('s1'), session(BOT)],
    activeKey: `session:${active}`,
  });
  const api = {};
  function Harness() {
    const [leaves, setLeaves] = useState([pane('s1')]);
    const sessionSurfaces = useSessionPaneSurfaces();
    const sideDocks = useAppSideDocks({
      paneWorkspace: { leaves, focusedLeafId: 'L1' },
      sessionSurfaces,
      applySidebarOpen: () => {},
    });
    Object.assign(api, { sessionSurfaces, sideDocks, show: (id) => setLeaves([pane(id)]) });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  try {
    // A chat file link in s1 opens the image in the pane's side dock.
    await act(async () => api.sideDocks.paneSideDocks.openFile('L1', 'C:/p', 'image-9cb6.png'));
    assert.equal(api.sideDocks.focusedPaneDockOpen, true);

    await act(async () => api.show(BOT));
    assert.equal(api.sideDocks.focusedPaneDockOpen, false, "the bot chat shows no panel of s1's");

    await act(async () => api.show('s1'));
    assert.equal(api.sideDocks.focusedPaneDockOpen, true, 'back on s1 its file returns');

    // The bot's own panel opens and closes over the pane without touching s1's file.
    await act(async () => api.show(BOT));
    await act(async () => api.sideDocks.toggleDock());
    assert.equal(api.sideDocks.focusedPaneDockOpen, true, "the bot's toggle opens its own panel");
    await act(async () => api.sideDocks.toggleDock());
    assert.equal(api.sideDocks.focusedPaneDockOpen, false);
    await act(async () => api.show('s1'));
    assert.equal(api.sideDocks.focusedPaneDockOpen, true);
    assert.equal(api.sideDocks.paneSideDocks.entryFor('L1').surface, 'file', "s1's file is still in front for s1");
  } finally {
    await act(async () => root.unmount());
  }
});

/** Mounts the side docks over a pane list the test can replace. */
async function mountPanes(initial, focusedLeafId = 'L1') {
  const api = {};
  function Harness() {
    const [state, setState] = useState({ leaves: initial, focusedLeafId });
    const sessionSurfaces = useSessionPaneSurfaces();
    const sideDocks = useAppSideDocks({ paneWorkspace: state, sessionSurfaces, applySidebarOpen: () => {} });
    Object.assign(api, {
      sessionSurfaces,
      sideDocks,
      setPanes: (leaves, focused = 'L1') => setState({ leaves, focusedLeafId: focused }),
    });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  api.unmount = () => act(async () => root.unmount());
  return api;
}

const DRAFT = { kind: 'new', draftId: 'd1' };
const paneOf = (id, tabs, activeKey) => ({ type: 'leaf', id, tabs, activeKey });

test("a toggle on a draft or another session never overwrites the owner's file", async () => {
  const tabs = [session('s1'), session('s2'), DRAFT];
  const api = await mountPanes([paneOf('L1', tabs, 'session:s1')]);
  try {
    await act(async () => api.sideDocks.paneSideDocks.openFile('L1', 'C:/p', 'image-9cb6.png'));
    const owned = ownerSide(api.sideDocks.paneSideDocks.entryFor('L1'), 's1');
    for (const key of ['new:d1', 'session:s2']) {
      await act(async () => api.setPanes([paneOf('L1', tabs, key)]));
      await act(async () => api.sideDocks.toggleDock());
      assert.deepEqual(
        ownerSide(api.sideDocks.paneSideDocks.entryFor('L1'), 's1'),
        owned,
        `${key}'s toggle leaves s1's side as s1 left it`
      );
      if (api.sideDocks.focusedPaneDockOpen) await act(async () => api.sideDocks.toggleDock());
      assert.equal(api.sideDocks.focusedPaneDockOpen, false);
      assert.deepEqual(
        ownerSide(api.sideDocks.paneSideDocks.entryFor('L1'), 's1'),
        owned,
        `${key}'s close leaves it too`
      );
    }
    await act(async () => api.setPanes([paneOf('L1', tabs, 'session:s1')]));
    assert.equal(api.sideDocks.focusedPaneDockOpen, true, 's1 gets its file back');
    assert.equal(api.sideDocks.paneSideDocks.entryFor('L1').surface, 'file');
  } finally {
    await api.unmount();
  }
});

test("an owned file follows its session's tab to another pane and is released when the session's tab closes", async () => {
  const BOT = 'sess_home_agent-marketer';
  const api = await mountPanes([
    paneOf('L1', [session('s1'), session(BOT)], 'session:s1'),
    paneOf('L2', [session('s2')], 'session:s2'),
  ]);
  try {
    await act(async () => api.sideDocks.paneSideDocks.openFile('L1', 'C:/p', 'image-9cb6.png'));
    // s1's tab moves to L2: its file goes with it, L1 lets it go.
    await act(async () =>
      api.setPanes(
        [paneOf('L1', [session(BOT)], `session:${BOT}`), paneOf('L2', [session('s2'), session('s1')], 'session:s1')],
        'L2'
      )
    );
    assert.equal(api.sideDocks.focusedPaneDockOpen, true, 's1 shows its file in its new pane');
    assert.equal(api.sideDocks.paneSideDocks.entryFor('L2').owner, 's1');
    assert.equal(api.sideDocks.paneSideDocks.entryFor('L1').files, undefined, 'the old pane holds nothing of s1');
    assert.equal(api.sideDocks.paneSideDocks.entryFor('L1').owner, undefined);
    // s1's tab closes: the owned file is released, not stranded behind a session no tab shows.
    await act(async () =>
      api.setPanes([paneOf('L1', [session(BOT)], `session:${BOT}`), paneOf('L2', [session('s2')], 'session:s2')], 'L2')
    );
    const released = api.sideDocks.paneSideDocks.entryFor('L2');
    assert.equal(released.owner, undefined);
    assert.equal(released.files, undefined);
    assert.equal(released.surface, '');
    assert.equal(api.sideDocks.focusedPaneDockOpen, false);
    assert.equal(JSON.parse(dom.window.localStorage.getItem(DOCK_KEY)).L2.owner, undefined, 'nothing owned persists');
  } finally {
    await api.unmount();
  }
});

/** Mounts the side docks with the real header selection (useSideViewSelection) over one pane. */
async function mountHeader(tabs) {
  const api = {};
  function Harness() {
    const [leaves, setLeaves] = useState([paneOf('L1', tabs, 'session:s1')]);
    const sessionSurfaces = useSessionPaneSurfaces();
    const sideDocks = useAppSideDocks({
      paneWorkspace: { leaves, focusedLeafId: 'L1' },
      sessionSurfaces,
      applySidebarOpen: () => {},
    });
    const selectView = useSideViewSelection({
      sideOf: sideDocks.workbenchSideLayout.sideOf,
      selectDock: sideDocks.paneSideDocks.select,
      activeSideViews: sideDocks.activeSideViews,
      setActiveSideViews: sideDocks.setActiveSideViews,
      sidebarOpen: false,
      applySidebarOpen: () => {},
      closeSidebarPanels: () => {},
      mountSidebarPanel: () => {},
      trackSidebarPanelModule: () => {},
      refreshProjects: async () => {},
      paneLeavesRef: { current: leaves },
      focusedLeafIdRef: { current: 'L1' },
      paneLeaves: leaves,
      focusedLeafId: 'L1',
      browserSurfaces: sessionSurfaces.browserSurfaces,
      pendingBrowserAutoReveal: sessionSurfaces.pendingBrowserAutoReveal,
      setSessionSideSurface: sessionSurfaces.setSessionSideSurface,
      setSessionPanelView: sessionSurfaces.setSessionPanelView,
    });
    Object.assign(api, { sideDocks, selectView, show: (key) => setLeaves([paneOf('L1', tabs, key)]) });
    return null;
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  await act(async () => root.render(React.createElement(Harness)));
  api.unmount = () => act(async () => root.unmount());
  api.entry = () => api.sideDocks.paneSideDocks.entryFor('L1');
  return api;
}

/** The pane entry's side its owner sees: the parts a non-owner must not change. */
const ownerSide = (entry, owner) => {
  const seen = paneDockEntryForSession(entry, owner);
  return {
    open: seen.open,
    surface: seen.surface,
    files: seen.files,
    activeFile: seen.activeFile,
    folder: seen.folder,
    diff: seen.diff,
    owner: seen.owner,
  };
};

test("the header buttons on another session never replace the owner's file", async () => {
  const api = await mountHeader([session('s1'), session('s2')]);
  try {
    await act(async () => api.sideDocks.paneSideDocks.openFile('L1', 'C:/p', 'image-9cb6.png'));
    const owned = ownerSide(api.entry(), 's1');
    await act(async () => api.show('session:s2'));
    for (const view of ['visualize', 'terminal']) {
      await act(async () => api.selectView(view, 'L1'));
      assert.equal(api.sideDocks.focusedPaneDockOpen, true, `s2's ${view} shows from its own session`);
      assert.deepEqual(ownerSide(api.entry(), 's1'), owned, `s2's ${view} leaves s1's side as it was`);
    }
    await act(async () => api.show('session:s1'));
    assert.equal(api.sideDocks.focusedPaneDockOpen, true);
    assert.deepEqual(ownerSide(api.entry(), 's1'), owned, "s1's file is back in front, unchanged");
    assert.equal(api.entry().surface, 'file');
  } finally {
    await api.unmount();
  }
});

test("a pane-level view picked on another session opens there; the owner's file comes back in front", async () => {
  // The shipped right side pins its views (normalizeWorkbenchSideViewLayout):
  // its one pane-level view is Pull Requests (Source Control and Search live
  // on the left rail), off in this build, so the pane docks run here over a
  // right side that carries it.
  const { usePaneSideDocks } = await import('./pane-side-dock.tsx');
  const GROUPS = [['session-diff'], ['visualize'], ['browser'], ['terminal'], ['pull-requests']];
  const api = {};
  function Harness() {
    const [shown, setShown] = useState('s1');
    const docks = usePaneSideDocks({
      leafIds: ['L1'],
      groups: GROUPS,
      sessionOf: () => shown,
      paneSessions: { L1: ['s1', 's2'] },
    });
    Object.assign(api, { docks, shown, show: setShown });
    return null;
  }
  const mount = async () => {
    const root = createRoot(dom.window.document.getElementById('root'));
    await act(async () => root.render(React.createElement(Harness)));
    return () => act(async () => root.unmount());
  };
  const seen = () => paneDockEntryForSession(api.docks.entryFor('L1'), api.shown);
  let unmount = await mount();
  try {
    await act(async () => api.docks.openFile('L1', 'C:/p', 'image-9cb6.png'));
    const owned = ownerSide(api.docks.entryFor('L1'), 's1');
    assert.equal(seen().surface, 'file');

    await act(async () => api.show('s2'));
    assert.equal(seen().open, false, "s2 sees nothing of s1's");
    // The header pick on s2 opens the pane-level view for s2.
    await act(async () => api.docks.select('L1', 'pull-requests'));
    assert.equal(seen().open, true, 'Pull Requests opens for s2');
    assert.equal(seen().view, 'pull-requests');
    assert.equal(seen().surface, '');
    assert.deepEqual(api.docks.entryFor('L1').files, owned.files, "s1's file tabs stay mounted behind it");

    await act(async () => api.show('s1'));
    assert.deepEqual(ownerSide(api.docks.entryFor('L1'), 's1'), owned, "s1's file is back in front, unchanged");
    assert.equal(api.docks.entryFor('L1').surface, 'file', 'restored in the stored entry, not only on screen');

    await act(async () => api.show('s2'));
    assert.equal(seen().open, true, 'Pull Requests is still open for s2');
    assert.equal(seen().view, 'pull-requests');
    assert.equal(seen().surface, '');

    // A restart keeps both fronts: s2's pane-level view and s1's file.
    await unmount();
    unmount = await mount();
    assert.equal(api.shown, 's1');
    assert.deepEqual(ownerSide(api.docks.entryFor('L1'), 's1'), owned, "after a restart s1's file is in front");
    await act(async () => api.show('s2'));
    assert.equal(seen().open, true);
    assert.equal(seen().view, 'pull-requests');
    // s2 folds its view; s1's file is untouched by that.
    await act(async () => api.docks.toggle('L1'));
    assert.equal(seen().open, false);
    await act(async () => api.show('s1'));
    assert.deepEqual(ownerSide(api.docks.entryFor('L1'), 's1'), owned);
  } finally {
    await unmount();
  }
});

test('a file opened from a chat link outside the project (access token) survives tab switches', async () => {
  const BOT = 'sess_home_lead';
  const tabs = [session('s1'), session(BOT)];
  const api = await mountPanes([paneOf('L1', tabs, 'session:s1')]);
  try {
    await act(async () =>
      api.sideDocks.paneSideDocks.openFile('L1', 'C:/tmp', 'image-9cb6a1.png', undefined, 'token-1')
    );
    const opened = api.sideDocks.paneSideDocks.entryFor('L1').files;
    await act(async () => api.setPanes([paneOf('L1', tabs, `session:${BOT}`)]));
    assert.equal(api.sideDocks.focusedPaneDockOpen, false);
    await act(async () => api.setPanes([paneOf('L1', tabs, 'session:s1')]));
    assert.equal(api.sideDocks.focusedPaneDockOpen, true, "s1's linked file is back in front");
    assert.deepEqual(api.sideDocks.paneSideDocks.entryFor('L1').files, opened);
    assert.equal(api.sideDocks.paneSideDocks.entryFor('L1').surface, 'file');
    // Splitting and moving s1's tab to the new pane re-shapes the panes: the
    // linked file is live state, so it follows s1 instead of being dropped.
    await act(async () => api.setPanes([paneOf('L1', tabs, 'session:s1'), paneOf('L2', [DRAFT], 'new:d1')]));
    assert.deepEqual(api.sideDocks.paneSideDocks.entryFor('L1').files, opened, 'a split keeps the linked file');
    await act(async () =>
      api.setPanes([paneOf('L1', [session(BOT)], `session:${BOT}`), paneOf('L2', [DRAFT, session('s1')], 'session:s1')])
    );
    assert.deepEqual(api.sideDocks.paneSideDocks.entryFor('L2').files, opened, 'the linked file followed s1');
    assert.equal(api.sideDocks.paneSideDocks.entryFor('L2').surface, 'file');
    assert.equal(api.sideDocks.paneSideDocks.entryFor('L1').files?.length ?? 0, 0, 'L1 released it');
  } finally {
    await api.unmount();
  }
});

test('access tokens never reach storage: a chat-link file stays live only, across tab switches and a split', async () => {
  const BOT = 'sess_home_lead';
  const tabs = [session('s1'), session(BOT)];
  const stored = () => dom.window.localStorage.getItem(DOCK_KEY) ?? '';
  const api = await mountPanes([paneOf('L1', tabs, 'session:s1')]);
  try {
    const pinned = { preview: false };
    await act(async () =>
      api.sideDocks.paneSideDocks.openFile('L1', 'C:/p', 'src/a.ts', undefined, undefined, undefined, pinned)
    );
    await act(async () =>
      api.sideDocks.paneSideDocks.openFile('L1', 'C:/tmp', 'image-9cb6a1.png', undefined, 'token-1', undefined, pinned)
    );
    const check = (step) => {
      assert.doesNotMatch(stored(), /accessToken|token-1|image-9cb6a1/, `${step}: no token file in storage`);
      assert.deepEqual(
        (JSON.parse(stored()).L1.files ?? []).map((file) => file.rel),
        ['src/a.ts'],
        `${step}: the project file is still stored`
      );
      assert.ok(
        api.sideDocks.paneSideDocks.entryFor('L1').files.some((file) => file.accessToken === 'token-1'),
        `${step}: the live entry keeps the linked file`
      );
    };
    check('opened');
    await act(async () => api.setPanes([paneOf('L1', tabs, `session:${BOT}`)]));
    await act(async () => api.setPanes([paneOf('L1', tabs, 'session:s1')]));
    check('tab switches');
    await act(async () => api.setPanes([paneOf('L1', tabs, 'session:s1'), paneOf('L2', [DRAFT], 'new:d1')]));
    check('split');
  } finally {
    await api.unmount();
  }
});

test('unsaved file tabs never move or join another pane: their entry stays exactly where it is', async () => {
  const BOT = 'sess_home_agent-marketer';
  const files = (leafId) => (api.sideDocks.paneSideDocks.entryFor(leafId).files ?? []).map((entry) => entry.rel);
  const markDirty = (leafId) => {
    api.sideDocks.paneSideDocks.dirtyKeysRef.current = new Set(
      (api.sideDocks.paneSideDocks.entryFor(leafId).files ?? []).map((entry) =>
        sideFileTabDirtyKey(leafId, sideFileKey(entry))
      )
    );
  };
  const api = await mountPanes([
    paneOf('L1', [session('s1'), session(BOT)], 'session:s1'),
    paneOf('L2', [session('s2')], 'session:s2'),
  ]);
  try {
    await act(async () => api.sideDocks.paneSideDocks.openFile('L1', 'C:/p', 'draft.ts'));
    const dirty = api.sideDocks.paneSideDocks.entryFor('L1');
    markDirty('L1');
    // s1's tab moves to a free L2 while L1 stays: the dirty entry is not remounted there.
    await act(async () =>
      api.setPanes(
        [paneOf('L1', [session(BOT)], `session:${BOT}`), paneOf('L2', [session('s2'), session('s1')], 'session:s1')],
        'L2'
      )
    );
    assert.strictEqual(api.sideDocks.paneSideDocks.entryFor('L1'), dirty, 'L1 keeps the dirty entry untouched');
    assert.deepEqual(files('L2'), [], 'nothing moved to L2');
    // L1 closes with it (its last tab leaves): no join into L2 either; the pane's
    // dock entry goes the way a closed pane's entry always went.
    await act(async () =>
      api.setPanes([paneOf('L2', [session('s2'), session('s1'), session(BOT)], 'session:s1')], 'L2')
    );
    assert.deepEqual(files('L2'), [], 'the dirty tabs never join L2');
    assert.deepEqual(Object.keys(api.sideDocks.paneSideDocks.docks), ['L2']);
  } finally {
    await api.unmount();
  }
});

test('CloseWatcher path: dock + menu close one layer per back', async () => {
  const { live, uninstall } = installWatchers();
  const phone = await mountPhone({ leaves: LEAVES, focusedLeafId: 'L1' });
  try {
    await act(async () => phone.sessionSurfaces.setSessionSideSurface('s1', 'terminal'));
    await act(async () => phone.setMenuOpen(true));
    assert.equal(live().length, 2);

    await act(async () => live()[1].onclose());
    assert.equal(phone.sideDocks.focusedPaneDockOpen, true);

    await act(async () => live()[0].onclose());
    assert.equal(phone.displayedOpen(), false);
  } finally {
    await phone.unmount();
    uninstall();
  }
});
