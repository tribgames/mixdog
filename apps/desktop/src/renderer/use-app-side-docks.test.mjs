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
