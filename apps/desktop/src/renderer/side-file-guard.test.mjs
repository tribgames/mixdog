import assert from 'node:assert/strict';
import test from 'node:test';
import { createSideFileGuard, sideFileDirtyKey } from './side-file-guard.ts';
import { planSideFileOpen, sideFileKey } from './side-file-tabs.ts';
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

const withOpenedAt = (f) => ({ openedAt: 1, ...f });

function harness({ sideFiles = {}, mainTabs = [], dirty = [], linkPreview = true } = {}) {
  const state = {
    // leafId -> ordered tabs (a lone file means a one-tab list); the last is active.
    sideFiles: Object.fromEntries(
      Object.entries(sideFiles).map(([leafId, f]) => [leafId, (Array.isArray(f) ? f : [f]).map(withOpenedAt)])
    ),
    dirty: new Set(dirty),
    log: [],
    requests: [],
    pending: null,
  };
  const guard = createSideFileGuard({
    linkPreview: () => linkPreview,
    now: () => 5000,
    sideFiles: () =>
      Object.entries(state.sideFiles).flatMap(([leafId, tabs]) =>
        tabs.map((f, index) => ({ leafId, file: f, active: index === tabs.length - 1 }))
      ),
    mainTabKeys: () => new Set(mainTabs),
    isDirty: (key) => state.dirty.has(key),
    clearDirty: (key) => state.dirty.delete(key),
    confirm: (key, target, proceed) => {
      state.log.push(['confirm', key, target.rel]);
      state.pending = proceed;
    },
    dockOpenFile: (leafId, project, rel, line, accessToken, column, request) => {
      const tabs = state.sideFiles[leafId] ?? [];
      const plan = planSideFileOpen(
        { files: tabs, active: tabs.length ? sideFileKey(tabs.at(-1)) : null },
        { project, rel, accessToken, line, column },
        1,
        { preview: request?.preview, from: request?.from, now: 5000 }
      );
      // The harness keeps the active tab last.
      state.sideFiles[leafId] = [
        ...plan.files.filter((f) => sideFileKey(f) !== plan.active),
        ...plan.files.filter((f) => sideFileKey(f) === plan.active),
      ];
      state.requests.push(request);
      state.log.push(['dock-open', leafId, rel, line, ...(column ? [column] : [])]);
    },
    dockCloseFile: (leafId, fileKey) => {
      const tabs = state.sideFiles[leafId] ?? [];
      const target = fileKey ?? (tabs.length ? sideFileKey(tabs.at(-1)) : undefined);
      const closed = tabs.find((f) => sideFileKey(f) === target);
      const rest = tabs.filter((f) => f !== closed);
      if (rest.length) state.sideFiles[leafId] = rest;
      else delete state.sideFiles[leafId];
      state.log.push(['dock-close', leafId, ...(closed ? [closed.rel] : [])]);
    },
    openMainTab: (_project, rel, line) => state.log.push(['main-tab', rel, line]),
  });
  return { guard, state };
}

const dk = (leafId, rel) => sideFileDirtyKey(leafId, file(rel));
const preview = (rel) => ({ ...file(rel), preview: true });

test('closing a clean side file closes it at once', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') } });
  guard.closeSideFile('L1', () => state.log.push(['then']));
  assert.deepEqual(state.log, [['dock-close', 'L1', 'a.ts'], ['then']]);
});

test('closing a dirty side file waits for the unsaved-changes dialog', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') }, dirty: [dk('L1', 'a.ts')] });
  guard.closeSideFile('L1', () => state.log.push(['then']));
  assert.deepEqual(state.log, [['confirm', dk('L1', 'a.ts'), 'a.ts']]);
  assert.ok(state.sideFiles.L1, 'edits stay mounted until the user decides');
  // Cancel never calls proceed; Save/Discard does.
  state.pending();
  assert.deepEqual(state.log.slice(1), [['dock-close', 'L1', 'a.ts'], ['then']]);
  assert.equal(state.dirty.has(dk('L1', 'a.ts')), false);
});

test('closing one tab asks only about that tab; the others keep their edits', () => {
  const { guard, state } = harness({
    sideFiles: { L1: [file('a.ts'), file('b.ts')] },
    dirty: [dk('L1', 'a.ts'), dk('L1', 'b.ts')],
  });
  guard.closeSideFileTab('L1', sideFileKey(file('a.ts')));
  assert.deepEqual(state.log, [['confirm', dk('L1', 'a.ts'), 'a.ts']]);
  state.pending();
  assert.deepEqual(state.log.slice(1), [['dock-close', 'L1', 'a.ts']]);
  assert.deepEqual(
    state.sideFiles.L1.map((f) => f.rel),
    ['b.ts']
  );
  assert.ok(state.dirty.has(dk('L1', 'b.ts')));
});

test('closing the whole dock confirms every dirty tab in turn', () => {
  const { guard, state } = harness({
    sideFiles: { L1: [file('a.ts'), file('b.ts'), file('c.ts')] },
    dirty: [dk('L1', 'a.ts'), dk('L1', 'c.ts')],
  });
  guard.closeSideFile('L1', () => state.log.push(['then']));
  assert.deepEqual(state.log, [['confirm', dk('L1', 'a.ts'), 'a.ts']]);
  state.pending();
  assert.deepEqual(state.log.slice(1, 3), [
    ['dock-close', 'L1', 'a.ts'],
    ['dock-close', 'L1', 'b.ts'],
  ]);
  assert.deepEqual(state.log.at(-1), ['confirm', dk('L1', 'c.ts'), 'c.ts']);
  state.pending();
  assert.deepEqual(state.log.slice(-2), [['dock-close', 'L1', 'c.ts'], ['then']]);
});

test('replacing a dirty preview tab confirms first; a clean one is replaced directly', () => {
  const dirty = harness({ sideFiles: { L1: preview('a.ts') }, dirty: [dk('L1', 'a.ts')] });
  dirty.guard.openFileInSideDock('L1', 'C:/p', 'b.ts', 4);
  assert.deepEqual(dirty.state.log, [['confirm', dk('L1', 'a.ts'), 'a.ts']]);
  assert.equal(dirty.state.sideFiles.L1[0].rel, 'a.ts');
  dirty.state.pending();
  assert.deepEqual(dirty.state.log.slice(1), [
    ['dock-close', 'L1', 'a.ts'],
    ['dock-open', 'L1', 'b.ts', 4],
  ]);
  assert.deepEqual(
    dirty.state.sideFiles.L1.map((f) => f.rel),
    ['b.ts']
  );

  const clean = harness({ sideFiles: { L1: preview('a.ts') } });
  clean.guard.openFileInSideDock('L1', 'C:/p', 'b.ts');
  assert.deepEqual(clean.state.log, [['dock-open', 'L1', 'b.ts', undefined]]);
  assert.deepEqual(clean.state.requests, [{ preview: true }]);
});

test('a dirty normal tab is never asked about: a new file just adds a tab', () => {
  for (const linkPreview of [true, false]) {
    const { guard, state } = harness({ sideFiles: { L1: file('a.ts') }, dirty: [dk('L1', 'a.ts')], linkPreview });
    guard.openFileInSideDock('L1', 'C:/p', 'b.ts');
    assert.deepEqual(state.log, [['dock-open', 'L1', 'b.ts', undefined]]);
    assert.deepEqual(
      state.sideFiles.L1.map((f) => [f.rel, Boolean(f.preview)]),
      [
        ['a.ts', false],
        ['b.ts', linkPreview],
      ]
    );
  }
});

test('the origin tab of a fresh preview is kept, so nothing is replaced or confirmed', () => {
  const { guard, state } = harness({
    sideFiles: { L1: { ...preview('a.ts'), openedAt: 4000 } },
    dirty: [dk('L1', 'a.ts')],
  });
  guard.openFileInSideDock('L1', 'C:/p', 'b.ts', undefined, undefined, undefined, sideFileKey(file('a.ts')));
  assert.deepEqual(state.log, [['dock-open', 'L1', 'b.ts', undefined]]);
  assert.deepEqual(state.requests, [{ preview: true, from: sideFileKey(file('a.ts')) }]);
  assert.deepEqual(
    state.sideFiles.L1.map((f) => [f.rel, Boolean(f.preview)]),
    [
      ['a.ts', false],
      ['b.ts', true],
    ]
  );
});

test('re-linking a file that has a tab never asks and re-reveals it', () => {
  const { guard, state } = harness({
    sideFiles: { L1: [file('a.ts'), file('b.ts')] },
    dirty: [dk('L1', 'a.ts'), dk('L1', 'b.ts')],
  });
  guard.openFileInSideDock('L1', 'C:/p', 'a.ts', 9);
  assert.deepEqual(state.log, [['dock-open', 'L1', 'a.ts', 9]]);
});

test('Open in main tab with unsaved edits confirms, then moves the file', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') }, dirty: [dk('L1', 'a.ts')] });
  guard.openFileTab('C:/p', 'a.ts', 3);
  assert.deepEqual(state.log, [['confirm', dk('L1', 'a.ts'), 'a.ts']]);
  state.pending();
  assert.deepEqual(state.log.slice(1), [
    ['dock-close', 'L1', 'a.ts'],
    ['main-tab', 'a.ts', 3],
  ]);
});

test('Open in main tab for a clean side file moves it without a dialog', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') } });
  guard.openFileTab('C:/p', 'a.ts', 3);
  assert.deepEqual(state.log, [
    ['dock-close', 'L1', 'a.ts'],
    ['main-tab', 'a.ts', 3],
  ]);
});

test('main tabs for other files, and explorer-style opens, are untouched', () => {
  const { guard, state } = harness({ sideFiles: { L1: file('a.ts') }, dirty: [dk('L1', 'a.ts')] });
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
  assert.deepEqual(elsewhere.state.log, [
    ['dock-close', 'L2', 'a.ts'],
    ['main-tab', 'a.ts', 2],
  ]);
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
