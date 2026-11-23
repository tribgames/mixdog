import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

// The pane as the app wires it: the real side docks and per-session surfaces,
// the header selection, the side-file guard's open/close, and each pane drawn
// by renderPaneSideDockView. Whether Changes leads a pane's file tabs is read
// from the strip the user sees.
const session = (id) => ({ kind: 'session', id });
const paneOf = (id, tabs, activeKey) => ({ type: 'leaf', id, tabs, activeKey });
const BOT = 'sess_home_agent-marketer';
const TERMINAL_STUB = { registerSlot() {}, unregisterSlot() {}, refresh() {}, prewarm() {} };

async function mountApp(initialLeaves, initialFocus) {
  const { restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    jsdom: { url: 'https://mixdog.test/' },
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver'],
  });
  window.localStorage.clear();
  const { useAppSideDocks } = await import('./use-app-side-docks.ts');
  const { useSessionPaneSurfaces } = await import('./use-session-pane-surfaces.ts');
  const { useSideViewSelection } = await import('./app-shell-side-views.ts');
  const { renderPaneSideDockView, sideFileEditorKept } = await import('./app-shell-side-dock.tsx');
  const { bindAppFrameSideFileGuard } = await import('./app-root/app-frame-side-file-guard.ts');
  const { setLinkPreview } = await import('./link-preview-preference.ts');
  const { SideFileEditorPortals } = await import('./side-file-editor-portals.tsx');
  const { sideFileKey, sideFileTabDirtyKey } = await import('./side-file-tabs.ts');
  setLinkPreview(false);
  const mainTabs = [];
  // The app's dirty set (handleFileDirty): what the editors report.
  const dirtyFileKeys = new Set();
  const Icon = () => React.createElement('span');
  const descriptors = new Map(
    ['session-diff', 'terminal', 'visualize', 'routines', 'room', 'browser'].map((id) => [id, { id, label: id, icon: Icon }])
  );
  const api = {};
  function App() {
    const [state, setState] = useState({ leaves: initialLeaves, focused: initialFocus });
    const { leaves, focused } = state;
    const sessionSurfaces = useSessionPaneSurfaces();
    const sideDocks = useAppSideDocks({
      paneWorkspace: { leaves, focusedLeafId: focused },
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
      focusedLeafIdRef: { current: focused },
      paneLeaves: leaves,
      focusedLeafId: focused,
      browserSurfaces: sessionSurfaces.browserSurfaces,
      pendingBrowserAutoReveal: sessionSurfaces.pendingBrowserAutoReveal,
      setSessionSideSurface: sessionSurfaces.setSessionSideSurface,
      setSessionPanelView: sessionSurfaces.setSessionPanelView,
    });
    const { paneSideDocks } = sideDocks;
    // The app's own guard binding: which pane's tab owns which file tab.
    const guard = bindAppFrameSideFileGuard({
      sideFileGuardRef: { current: null },
      paneSideDocks,
      paneWorkspace: { leaves },
      dirtyFileKeys,
      handleFileDirty: () => {},
      confirmSideFileExit: (_key, _target, proceed) => proceed(),
      openFileTabRaw: (project, rel) => mainTabs.push(rel),
    });
    const context = {
      paneWorkspace: { focusLeaf: () => {} },
      paneSideDocks,
      // The terminal's xterm body does not load under node; only where the dock stands is read.
      sessionSurfaces: { ...sessionSurfaces, terminalSurfaces: TERMINAL_STUB },
      workbenchSideLayout: sideDocks.workbenchSideLayout,
      sideViewDescriptors: descriptors,
      dockBodyWarm: false,
      closePaneRightRegion: sideDocks.closePaneRightRegion,
      selectWorkbenchSideView: selectView,
      moveWorkbenchSideGroup: () => {},
      moveWorkbenchSideView: () => {},
      openFileTab: () => {},
      sideFileGuard: guard,
      renderFileProblems: () => null,
      handleFileDirty: () => {},
      registerEditorSaveHandle: () => {},
      paneProjectPathFor: () => 'C:/p',
      renderRightView: () => null,
    };
    Object.assign(api, { sessionSurfaces, sideDocks, selectView, guard, setState });
    return React.createElement(
      React.Fragment,
      null,
      leaves.map((leaf) =>
        React.createElement('div', { key: leaf.id }, renderPaneSideDockView(leaf, leaf.id === focused, context))
      ),
      React.createElement(SideFileEditorPortals, {
        kept: (fileKey) => sideFileEditorKept(sideDocks.paneSideDocks, fileKey),
      })
    );
  }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(App)));
  const fileKey = (rel) => sideFileKey({ project: 'C:/p', rel });
  return {
    api,
    /** The editor surface `rel` has in pane `leafId` (null when none is mounted there). */
    editor: (leafId, rel) =>
      document.getElementById(`side-file-slot:${leafId}:${fileKey(rel)}`)?.querySelector('.side-file-persistent-surface') ??
      null,
    /** Every side editor mounted anywhere, by its host element. */
    editors: () => document.querySelectorAll('.side-file-persistent-surface').length,
    /** The editor of `rel` reports unsaved edits. */
    markDirty: (rel) =>
      act(async () => {
        dirtyFileKeys.add(sideFileTabDirtyKey(fileKey(rel)));
        api.setState((state) => ({ ...state }));
      }),
    /** Lets an editor no slot took back leave (side-file-editor-portals). */
    settle: () => act(async () => new Promise((resolve) => setTimeout(resolve, 0))),
    /** The tabs of pane `leafId`'s file strip, as drawn. */
    strip: (leafId) =>
      [...document.querySelectorAll(`[data-pane-id="${leafId}"] .side-file-header [role="tab"]`)].map((tab) =>
        tab.textContent.trim()
      ),
    show: (leaves, focused) => act(async () => api.setState({ leaves, focused })),
    pick: (id, leafId) => act(async () => api.selectView(id, leafId)),
    open: (leafId, rel) => act(async () => api.guard.openFileInSideDock(leafId, 'C:/p', rel)),
    displayed: (leafId) => api.sideDocks.paneSideDocks.entryFor(leafId),
    async unmount() {
      await act(async () => root.unmount());
      restore();
    },
  };
}

test('a file opened from the conversation has its tab alone unless its own session opened Changes', async () => {
  const app = await mountApp([paneOf('L1', [session('s1')], 'session:s1')], 'L1');
  try {
    // Changes shown once and closed with the panel: the pane still remembers it as its view.
    await app.pick('session-diff', 'L1');
    await act(async () => app.api.sideDocks.closePaneRightRegion('L1'));
    assert.equal(app.api.sideDocks.focusedPaneDockOpen, false);
    await app.open('L1', 'shots/image-1a2061b028c4dab0.png');
    assert.deepEqual(app.strip('L1'), ['image-1a2061b028c4dab0.png']);
  } finally {
    await app.unmount();
  }
});

test("another tab's Changes never joins this tab's file strip, a session's or a bot chat's", async () => {
  for (const other of ['s2', BOT]) {
    const tabs = [session('s1'), session(other)];
    const app = await mountApp([paneOf('L1', tabs, 'session:s1')], 'L1');
    try {
      await app.pick('session-diff', 'L1');
      await app.show([paneOf('L1', tabs, `session:${other}`)], 'L1');
      await app.open('L1', 'image.png');
      assert.deepEqual(app.strip('L1'), ['image.png'], other);
    } finally {
      await app.unmount();
    }
  }
  // s1 has Changes ahead of a.png; s2 opens b.png in the same pane.
  const tabs = [session('s1'), session('s2')];
  const app = await mountApp([paneOf('L1', tabs, 'session:s1')], 'L1');
  try {
    await app.pick('session-diff', 'L1');
    await app.open('L1', 'a.png');
    assert.deepEqual(app.strip('L1'), ['Changes', 'a.png']);
    await app.show([paneOf('L1', tabs, 'session:s2')], 'L1');
    await app.open('L1', 'b.png');
    assert.deepEqual(app.strip('L1'), ['b.png']);
    await app.show([paneOf('L1', tabs, 'session:s1')], 'L1');
    assert.deepEqual(app.strip('L1'), ['Changes', 'a.png']);
  } finally {
    await app.unmount();
  }
});

test('each tab of a pane keeps its own file tabs and panel', async () => {
  const tabs = [session('s1'), session('s2')];
  const app = await mountApp([paneOf('L1', tabs, 'session:s1')], 'L1');
  const fileShown = () => {
    const shown = app.displayed('L1');
    return shown.open && shown.surface === 'file';
  };
  try {
    await app.open('L1', 'a.png');
    assert.deepEqual(app.strip('L1'), ['a.png']);
    await app.show([paneOf('L1', tabs, 'session:s2')], 'L1');
    assert.deepEqual(app.strip('L1'), [], "s2 never sees s1's file");
    await app.open('L1', 'b.png');
    assert.deepEqual(app.strip('L1'), ['b.png']);
    await app.show([paneOf('L1', tabs, 'session:s1')], 'L1');
    assert.deepEqual(app.strip('L1'), ['a.png']);
    assert.ok(fileShown(), "s1's panel is open on a.png as it left it");
    await app.show([paneOf('L1', tabs, 'session:s2')], 'L1');
    assert.deepEqual(app.strip('L1'), ['b.png']);
    assert.ok(fileShown(), "s2's panel is open on b.png");
  } finally {
    await app.unmount();
  }
});

test("another tab's file keeps an editor only while it holds unsaved edits", async () => {
  const tabs = [session('s1'), session('s2')];
  const app = await mountApp([paneOf('L1', tabs, 'session:s1')], 'L1');
  try {
    await app.open('L1', 'a.ts');
    await app.settle();
    assert.ok(app.editor('L1', 'a.ts'), "s1's file has its editor");
    // Clean behind s2: nothing of it stays mounted.
    await app.show([paneOf('L1', tabs, 'session:s2')], 'L1');
    await app.settle();
    assert.equal(app.editors(), 0, "a clean held file costs nothing");
    // In front again it opens as a file tab opens.
    await app.show([paneOf('L1', tabs, 'session:s1')], 'L1');
    await app.settle();
    assert.ok(app.editor('L1', 'a.ts'));
    // Unsaved: behind s2 its editor stays, unseen, and is the same one back in front.
    await app.markDirty('a.ts');
    const editor = app.editor('L1', 'a.ts');
    const body = editor.firstElementChild;
    await app.show([paneOf('L1', tabs, 'session:s2')], 'L1');
    await app.settle();
    assert.strictEqual(app.editor('L1', 'a.ts'), editor);
    assert.equal(editor.parentElement.hidden, true);
    await app.show([paneOf('L1', tabs, 'session:s1')], 'L1');
    await app.settle();
    assert.strictEqual(app.editor('L1', 'a.ts'), editor);
    assert.strictEqual(editor.firstElementChild, body, 'not remounted');
    assert.equal(editor.parentElement.hidden, false);
  } finally {
    await app.unmount();
  }
});

test("an unsaved file's editor is never remounted when its draft becomes the session", async () => {
  const draft = { kind: 'new', draftId: 'd2' };
  const app = await mountApp([paneOf('L1', [draft], 'new:d2')], 'L1');
  try {
    await app.open('L1', 'notes.md');
    await app.settle();
    await app.markDirty('notes.md');
    const editor = app.editor('L1', 'notes.md');
    const body = editor.firstElementChild;
    assert.ok(body);
    const { noteDraftPromotion } = await import('./composer-draft.ts');
    noteDraftPromotion('d2', 's4');
    await app.show([paneOf('L1', [session('s4')], 'session:s4')], 'L1');
    await app.settle();
    assert.deepEqual(app.strip('L1'), ['notes.md']);
    assert.strictEqual(app.editor('L1', 'notes.md'), editor);
    assert.strictEqual(editor.firstElementChild, body, 'the same editor, edit and cursor included');
    assert.equal(editor.parentElement.hidden, false);
  } finally {
    await app.unmount();
  }
});

test("a clean file keeps its slot and editor through its draft becoming the session", async () => {
  const draft = { kind: 'new', draftId: 'd3' };
  const app = await mountApp([paneOf('L1', [draft], 'new:d3')], 'L1');
  try {
    await app.open('L1', 'clean.md');
    await app.settle();
    const editor = app.editor('L1', 'clean.md');
    const slot = editor.parentElement;
    const body = editor.firstElementChild;
    const { noteDraftPromotion } = await import('./composer-draft.ts');
    noteDraftPromotion('d3', 's5');
    await app.show([paneOf('L1', [session('s5')], 'session:s5')], 'L1');
    await app.settle();
    assert.strictEqual(app.editor('L1', 'clean.md'), editor);
    assert.strictEqual(editor.parentElement, slot, 'the slot never left, not even for a frame');
    assert.strictEqual(editor.firstElementChild, body, 'cursor, scroll and undo stay with the same editor');
  } finally {
    await app.unmount();
  }
});

test("a later draft of the same scope keeps its file out of the session an earlier one became", async () => {
  const draft = { kind: 'new' };
  const app = await mountApp([paneOf('L1', [draft], 'new:default')], 'L1');
  try {
    const { noteDraftPromotion } = await import('./composer-draft.ts');
    noteDraftPromotion('', 's6');
    await app.show([paneOf('L1', [session('s6')], 'session:s6')], 'L1');
    await app.settle();
    await app.show([paneOf('L1', [session('s6'), draft], 'new:default')], 'L1');
    await app.open('L1', 'later.png');
    assert.deepEqual(app.strip('L1'), ['later.png']);
    await app.show([paneOf('L1', [session('s6'), draft], 'session:s6')], 'L1');
    await app.settle();
    assert.deepEqual(app.strip('L1'), []);
    await app.show([paneOf('L1', [session('s6'), draft], 'new:default')], 'L1');
    assert.deepEqual(app.strip('L1'), ['later.png']);
  } finally {
    await app.unmount();
  }
});

test("an unsaved file's editor is kept when its folded tab moves into a pane whose dock never opened", async () => {
  const { sideFileKey } = await import('./side-file-tabs.ts');
  const app = await mountApp(
    [paneOf('L1', [session('s1'), session('s2')], 'session:s1'), paneOf('L2', [session('s3')], 'session:s3')],
    'L1'
  );
  try {
    await app.open('L1', 'a.ts');
    await app.settle();
    await app.markDirty('a.ts');
    const editor = app.editor('L1', 'a.ts');
    const body = editor.firstElementChild;
    await act(async () => app.api.sideDocks.closePaneRightRegion('L1'));
    await app.show(
      [paneOf('L1', [session('s2')], 'session:s2'), paneOf('L2', [session('s3'), session('s1')], 'session:s1')],
      'L2'
    );
    await app.settle();
    assert.equal(document.querySelector('.pane-side-file-tab'), null, 'no pane draws a slot for it');
    // The user opens the file in its new pane: the same editor, edit included.
    await act(async () => app.api.sideDocks.paneSideDocks.activateFile('L2', sideFileKey({ project: 'C:/p', rel: 'a.ts' })));
    await app.settle();
    assert.strictEqual(app.editor('L2', 'a.ts'), editor);
    assert.strictEqual(editor.firstElementChild, body);
    assert.equal(editor.parentElement.hidden, false);
  } finally {
    await app.unmount();
  }
});

test("an unsaved file's editor goes along, the same one, when its tab is dragged to another pane", async () => {
  const app = await mountApp(
    [paneOf('L1', [session('s1'), session('s2')], 'session:s1'), paneOf('L2', [session('s3')], 'session:s3')],
    'L1'
  );
  try {
    await app.open('L1', 'a.ts');
    await app.settle();
    await app.markDirty('a.ts');
    const editor = app.editor('L1', 'a.ts');
    const body = editor.firstElementChild;
    assert.ok(body);
    await app.show(
      [paneOf('L1', [session('s2')], 'session:s2'), paneOf('L2', [session('s3'), session('s1')], 'session:s1')],
      'L2'
    );
    await app.settle();
    assert.deepEqual(app.strip('L1'), []);
    assert.deepEqual(app.strip('L2'), ['a.ts']);
    assert.equal(app.editor('L1', 'a.ts'), null);
    assert.strictEqual(app.editor('L2', 'a.ts'), editor);
    assert.strictEqual(editor.firstElementChild, body, 'the same editor, edit and cursor included');
    assert.equal(editor.parentElement.hidden, false, 'on screen in its new pane');
  } finally {
    await app.unmount();
  }
});

test("a session's open Changes leads its file even after another tab moved the pane, and closing the file returns to it", async () => {
  const tabs = [session('s1'), session('s2')];
  const app = await mountApp([paneOf('L1', tabs, 'session:s1')], 'L1');
  try {
    await app.pick('session-diff', 'L1');
    await app.show([paneOf('L1', tabs, 'session:s2')], 'L1');
    await app.pick('terminal', 'L1');
    await app.show([paneOf('L1', tabs, 'session:s1')], 'L1');
    assert.equal(app.api.sideDocks.focusedPaneDockOpen, true, "s1's Changes shows again");
    await app.open('L1', 'image.png');
    assert.deepEqual(app.strip('L1'), ['Changes', 'image.png']);
    const close = document.querySelector('[data-pane-id="L1"] .side-file-header .browser-tab-close');
    await act(async () => close.click());
    assert.equal(app.api.sideDocks.focusedPaneDockOpen, true, 'the panel stays');
    assert.equal(app.api.sessionSurfaces.sessionPanelViews.get('s1'), 'session-diff', "s1's Changes is kept");
    const shown = app.displayed('L1');
    assert.deepEqual([shown.surface, shown.files], ['', undefined], 'Changes is in front again');
  } finally {
    await app.unmount();
  }
});

test("a draft's file becomes the session's: Changes picked after it leads it", async () => {
  const draft = { kind: 'new', draftId: 'd1' };
  const app = await mountApp([paneOf('L1', [draft], 'new:d1')], 'L1');
  try {
    await app.open('L1', 'notes.md');
    assert.deepEqual(app.strip('L1'), ['notes.md']);
    // The first message turns the tab into the session (use-app-submit-routing notes it).
    const { noteDraftPromotion } = await import('./composer-draft.ts');
    noteDraftPromotion('d1', 's3');
    await app.show([paneOf('L1', [session('s3')], 'session:s3')], 'L1');
    await app.pick('session-diff', 'L1');
    // Back on the file: what its tab in the Changes strip does.
    const { sideFileKey } = await import('./side-file-tabs.ts');
    const [file] = app.displayed('L1').files;
    await act(async () => app.api.sideDocks.paneSideDocks.activateFile('L1', sideFileKey(file)));
    assert.deepEqual(app.strip('L1'), ['Changes', 'notes.md']);
  } finally {
    await app.unmount();
  }
});

test('a tab dragged to another pane keeps Changes ahead of its file', async () => {
  const app = await mountApp([paneOf('L1', [session('s1')], 'session:s1'), paneOf('L2', [session('s2')], 'session:s2')], 'L1');
  try {
    await app.pick('session-diff', 'L1');
    await app.open('L1', 'image.png');
    assert.deepEqual(app.strip('L1'), ['Changes', 'image.png']);
    await app.show(
      [paneOf('L1', [session('s3')], 'session:s3'), paneOf('L2', [session('s2'), session('s1')], 'session:s1')],
      'L2'
    );
    assert.deepEqual(app.strip('L2'), ['Changes', 'image.png']);
    assert.deepEqual(app.strip('L1'), []);
  } finally {
    await app.unmount();
  }
});
