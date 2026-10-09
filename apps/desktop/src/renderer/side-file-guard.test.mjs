import assert from 'node:assert/strict';
import test from 'node:test';
import { createSideFileGuard, sideFileDirtyKey } from './side-file-guard.ts';
import { sideEditorOptions } from './editor-side-options.ts';
import { renderPaneProblemsView } from './app-shell-pane-problems.tsx';

test('side-mode editor options: minimap, sticky scroll off; wrapped; shell-sized scrollbars', () => {
  const base = {
    minimap: { enabled: true, side: 'right' },
    stickyScroll: { enabled: true },
    wordWrap: 'off',
    scrollbar: { arrowSize: 0, verticalScrollbarSize: 14, horizontalScrollbarSize: 12 },
  };
  const side = sideEditorOptions(base, null);
  assert.equal(side.minimap.enabled, false);
  assert.equal(side.stickyScroll.enabled, false);
  assert.equal(side.wordWrap, 'on');
  assert.deepEqual(side.scrollbar, {
    arrowSize: 0,
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
    useShadows: false,
  });
  assert.equal(sideEditorOptions(base, 'off').wordWrap, 'off', 'Alt+Z still overrides');
  assert.equal(base.minimap.enabled, true, 'main-tab options are not mutated');
});

test('a conversation pane never opens the MAIN bottom Problems panel (side files use their own split)', () => {
  const session = { kind: 'session', id: 's1' };
  const leaf = { type: 'leaf', id: 'L1', tabs: [session], activeKey: 'session:s1' };
  const deps = () => ({
    bottomPanel: { openPaneIds: new Set(['L1']), height: 200, motion: 'animated', setHeight() {}, setOpenFor() {} },
    problemsFilter: {},
    setProblemsFilter() {},
    problemsCollapseNonce: 0,
    setProblemsCollapseNonce() {},
    openFileTab() {},
    openProblemQuickFix() {},
  });
  assert.equal(renderPaneProblemsView(leaf, deps()), null);
});

const file = (rel, accessToken) => ({ project: 'C:/p', rel, nonce: 1, ...(accessToken ? { accessToken } : {}) });

function harness({ sideFiles = {}, mainTabs = [], dirty = [] } = {}) {
  const state = {
    sideFiles: { ...sideFiles },
    dirty: new Set(dirty),
    log: [],
    pending: null,
  };
  const guard = createSideFileGuard({
    sideFiles: () => Object.entries(state.sideFiles).map(([leafId, f]) => ({ leafId, file: f })),
    mainTabKeys: () => new Set(mainTabs),
    isDirty: (key) => state.dirty.has(key),
    clearDirty: (key) => state.dirty.delete(key),
    confirm: (key, target, proceed) => {
      state.log.push(['confirm', key, target.rel]);
      state.pending = proceed;
    },
    dockOpenFile: (leafId, project, rel, line, token, column) => {
      state.sideFiles[leafId] = file(rel);
      state.log.push(['dock-open', leafId, rel, line, ...(column ? [column] : [])]);
    },
    dockCloseFile: (leafId) => {
      delete state.sideFiles[leafId];
      state.log.push(['dock-close', leafId]);
    },
    openMainTab: (project, rel, line) => state.log.push(['main-tab', rel, line]),
  });
  return { guard, state };
}

test('closing a clean side file closes it at once', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') } });
  guard.closeSideFile('L1', () => state.log.push(['then']));
  assert.deepEqual(state.log, [['dock-close', 'L1'], ['then']]);
});

test('closing a dirty side file waits for the unsaved-changes dialog', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') }, dirty: [sideFileDirtyKey('L1')] });
  guard.closeSideFile('L1', () => state.log.push(['then']));
  assert.deepEqual(state.log, [['confirm', 'side-file:L1', 'a.ts']]);
  assert.ok(state.sideFiles.L1, 'edits stay mounted until the user decides');
  // Cancel never calls proceed; Save/Discard does.
  state.pending();
  assert.deepEqual(state.log.slice(1), [['dock-close', 'L1'], ['then']]);
  assert.equal(state.dirty.has('side-file:L1'), false);
});

test('replacing a dirty side file confirms first; a clean one is replaced directly', () => {
  const dirty = harness({ sideFiles: { L1: file('a.ts') }, dirty: [sideFileDirtyKey('L1')] });
  dirty.guard.openFileInSideDock('L1', 'C:/p', 'b.ts', 4);
  assert.deepEqual(dirty.state.log, [['confirm', 'side-file:L1', 'a.ts']]);
  assert.equal(dirty.state.sideFiles.L1.rel, 'a.ts');
  dirty.state.pending();
  assert.equal(dirty.state.sideFiles.L1.rel, 'b.ts');
  assert.deepEqual(dirty.state.log.at(-1), ['dock-open', 'L1', 'b.ts', 4]);

  const clean = harness({ sideFiles: { L1: file('a.ts') } });
  clean.guard.openFileInSideDock('L1', 'C:/p', 'b.ts');
  assert.deepEqual(clean.state.log, [['dock-open', 'L1', 'b.ts', undefined]]);
});

test('re-linking the file already shown never asks and re-reveals it', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') }, dirty: [sideFileDirtyKey('L1')] });
  guard.openFileInSideDock('L1', 'C:/p', 'a.ts', 9);
  assert.deepEqual(state.log, [['dock-open', 'L1', 'a.ts', 9]]);
});

test('Open in main tab with unsaved edits confirms, then moves the file', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') }, dirty: [sideFileDirtyKey('L1')] });
  guard.openFileTab('C:/p', 'a.ts', 3);
  assert.deepEqual(state.log, [['confirm', 'side-file:L1', 'a.ts']]);
  state.pending();
  assert.deepEqual(state.log.slice(1), [['dock-close', 'L1'], ['main-tab', 'a.ts', 3]]);
});

test('Open in main tab for a clean side file moves it without a dialog', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') } });
  guard.openFileTab('C:/p', 'a.ts', 3);
  assert.deepEqual(state.log, [['dock-close', 'L1'], ['main-tab', 'a.ts', 3]]);
});

test('main tabs for other files, and explorer-style opens, are untouched', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') }, dirty: [sideFileDirtyKey('L1')] });
  guard.openFileTab('C:/p', 'other.ts', 1);
  assert.deepEqual(state.log, [['main-tab', 'other.ts', 1]]);
  assert.ok(state.sideFiles.L1);
});

test('a file already open in a main tab, or another pane side dock, is never mounted twice', () => {
  const inTab = harness({ mainTabs: ['file:C:/p:a.ts'] });
  inTab.guard.openFileInSideDock('L1', 'C:/p', 'a.ts', 2);
  assert.deepEqual(inTab.state.log, [['main-tab', 'a.ts', 2]]);

  const elsewhere = harness({ sideFiles: { L2: file('a.ts') } });
  elsewhere.guard.openFileInSideDock('L1', 'C:/p', 'a.ts', 2);
  assert.deepEqual(elsewhere.state.log, [['dock-close', 'L2'], ['main-tab', 'a.ts', 2]]);
});

test('a :line:column dock open carries the column, plain opens do not', () => {
  const { guard, state } = harness();
  guard.openFileInSideDock('L1', 'C:/p', 'a.ts', 12, undefined, 3);
  guard.openFileInSideDock('L1', 'C:/p', 'a.ts', 12);
  assert.deepEqual(state.log, [
    ['dock-open', 'L1', 'a.ts', 12, 3],
    ['dock-open', 'L1', 'a.ts', 12],
  ]);
});