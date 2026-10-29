import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  PaneSideDock,
  normalizePaneSideDocks,
  paneDiffStacks,
  paneDockActiveFile,
  paneDockActiveRoot,
  paneDockEntryInGroups,
  paneDockFileCloseEndsDock,
  paneDiffShowing,
  paneDockRestored,
  reconcilePaneDockOwners,
  samePaneSideDocks,
  withPaneDockDiffClosed,
  withPaneDockDiffOpened,
  withPaneDockFileClosed,
  withPaneDockFileOpened,
} from './pane-side-dock.tsx';
import { DockHeaderRow } from './pane-dock-chrome.tsx';
import { usePublishDockPanelActions } from './dock-panel-actions.ts';
import { sessionSideDockEntryForSession } from './session-side-surface-policy.ts';
import { sideFileKey } from './side-file-tabs.ts';

// The formatter wraps long selectors across lines; compare them as single-spaced text.

const RIGHT = [['source-control'], ['browser'], ['terminal'], ['pull-requests']];
const diffA = { kind: 'diff', project: 'C:/p', rel: 'src/a.ts', source: 'unstaged' };
const diffB = { kind: 'diff', project: 'C:/p', rel: 'src/b.ts', source: 'staged' };
const keyOf = (diff) => `diff:${diff.project}:${diff.source}:${diff.hash || ''}:${diff.rel}`;
const closed = (view = 'source-control') => ({ open: false, view, surface: '', diff: null });

test('the strip toggles and the dock header agree on the showing child', () => {
  // Folded: nothing is pressed, whatever the pane remembers.
  assert.equal(paneDockActiveRoot(closed('source-control')), null);
  // A session surface wins over the remembered panel view while it is up.
  assert.equal(paneDockActiveRoot({ open: true, view: 'source-control', surface: 'browser' }), 'browser');
  assert.equal(paneDockActiveRoot({ open: true, view: 'source-control', surface: 'terminal' }), 'terminal');
  // The diff pair keeps its Source Control parent pressed.
  assert.equal(paneDockActiveRoot({ open: true, view: 'source-control', surface: 'diff' }), 'source-control');
  assert.equal(paneDockActiveRoot({ open: true, view: null, surface: '' }), null);
});

test('a pane seen for the first time follows the mode default', () => {
  assert.deepEqual(normalizePaneSideDocks(null, ['pane-1'], RIGHT, false), { 'pane-1': closed() });
  assert.deepEqual(normalizePaneSideDocks(null, ['pane-1'], RIGHT, true), { 'pane-1': { ...closed(), open: true } });
});

test('stored entries survive for live panes and dead panes drop out', () => {
  const stored = {
    'pane-1': { open: true, view: 'pull-requests', surface: '', diff: null },
    'pane-9': { open: true, view: 'source-control', surface: '', diff: null },
  };
  assert.deepEqual(normalizePaneSideDocks(stored, ['pane-1', 'pane-2'], RIGHT, false), {
    'pane-1': { open: true, view: 'pull-requests', surface: '', diff: null },
    'pane-2': closed(),
  });
});

test('a view that left the right side remaps to the first panel view', () => {
  const stored = { 'pane-1': { open: true, view: 'agents' } };
  assert.deepEqual(normalizePaneSideDocks(stored, ['pane-1'], RIGHT, false), { 'pane-1': { ...closed(), open: true } });
});

test("session-owned tools are surfaces, never the dock's panel view", () => {
  // A legacy launcher-era store with view:"browser" falls back to the first
  // REAL panel view; the browser child itself lives in `surface`.
  assert.deepEqual(
    normalizePaneSideDocks(
      { 'pane-1': { open: true, view: 'browser' } },
      ['pane-1'],
      [['browser'], ['source-control']],
      false
    ),
    { 'pane-1': { ...closed(), open: true } }
  );
  assert.deepEqual(
    normalizePaneSideDocks(
      { 'pane-1': { open: true, view: 'source-control', surface: 'browser' } },
      ['pane-1'],
      RIGHT,
      false
    ),
    { 'pane-1': { open: true, view: 'source-control', surface: 'browser', diff: null } }
  );
  assert.deepEqual(normalizePaneSideDocks({ 'pane-1': { open: true, view: 'terminal' } }, ['pane-1'], RIGHT, false), {
    'pane-1': { ...closed(), open: true },
  });
  assert.deepEqual(
    normalizePaneSideDocks(
      { 'pane-1': { open: true, view: 'source-control', surface: 'terminal' } },
      ['pane-1'],
      RIGHT,
      false
    ),
    { 'pane-1': { open: true, view: 'source-control', surface: 'terminal', diff: null } }
  );
  // A right side without the browser drops the stored browser surface.
  assert.deepEqual(
    normalizePaneSideDocks(
      { 'pane-1': { open: true, view: 'source-control', surface: 'browser' } },
      ['pane-1'],
      [['source-control']],
      false
    ),
    { 'pane-1': { open: true, view: 'source-control', surface: '', diff: null } }
  );
});

test('the stored diff survives; legacy diff LISTS keep the pointed-at one', () => {
  const stored = {
    'pane-1': {
      open: true,
      view: 'source-control',
      surface: 'diff',
      diff: diffB,
    },
    // Legacy multi-diff store: the surface key picks its diff.
    'pane-2': {
      open: true,
      view: 'source-control',
      surface: keyOf(diffA),
      diffs: [diffA, { kind: 'diff', rel: 'no-project' }, diffB],
    },
    // A stale surface key degrades to the panel view but keeps the diff.
    'pane-3': {
      open: true,
      view: 'source-control',
      surface: 'diff:gone',
      diffs: [diffA],
    },
  };
  assert.deepEqual(normalizePaneSideDocks(stored, ['pane-1', 'pane-2', 'pane-3'], RIGHT, false), {
    'pane-1': { open: true, view: 'source-control', surface: 'diff', diff: diffB },
    'pane-2': { open: true, view: 'source-control', surface: 'diff', diff: diffA },
    'pane-3': { open: true, view: 'source-control', surface: '', diff: diffA },
  });
});

test('an empty or surface-only right side closes every pane dock', () => {
  assert.deepEqual(normalizePaneSideDocks({ 'pane-1': { open: true, view: 'source-control' } }, ['pane-1'], [], true), {
    'pane-1': closed(null),
  });
  assert.deepEqual(normalizePaneSideDocks(null, ['pane-1'], [['browser'], ['terminal']], true), {
    'pane-1': closed(null),
  });
});

test('malformed stored values degrade to defaults instead of throwing', () => {
  assert.deepEqual(normalizePaneSideDocks('garbage', ['pane-1'], RIGHT, false), { 'pane-1': closed() });
  assert.deepEqual(normalizePaneSideDocks({ 'pane-1': 42 }, ['pane-1'], RIGHT, false), { 'pane-1': closed() });
});

test('dock map equality compares open, view, surface, and the diff', () => {
  const left = { 'pane-1': { open: true, view: 'source-control', surface: 'diff', diff: diffA } };
  assert.ok(
    samePaneSideDocks(left, {
      'pane-1': { open: true, view: 'source-control', surface: 'diff', diff: diffA },
    })
  );
  assert.ok(
    !samePaneSideDocks(left, {
      'pane-1': { open: true, view: 'source-control', surface: 'browser', diff: diffA },
    })
  );
  assert.ok(
    !samePaneSideDocks(left, {
      'pane-1': { open: true, view: 'source-control', surface: 'diff', diff: diffB },
    })
  );
  assert.ok(
    !samePaneSideDocks(left, {
      ...left,
      'pane-2': closed(null),
    })
  );
});

test('opening a diff replaces the previous one in place and expands', () => {
  let entry = closed();
  entry = withPaneDockDiffOpened(entry, diffA);
  assert.equal(entry.open, true);
  assert.equal(entry.surface, 'diff');
  assert.equal(entry.diff, diffA);
  entry = withPaneDockDiffOpened(entry, diffB);
  assert.equal(entry.diff, diffB);
  // Re-opening the SAME file is a no-op, not a remount.
  const again = withPaneDockDiffOpened(entry, diffB);
  assert.equal(again, entry);
});

test('closing the diff hands the body back to the panel view', () => {
  let entry = { open: true, view: 'source-control', surface: 'diff', diff: diffA };
  entry = withPaneDockDiffClosed(entry);
  assert.equal(entry.diff, null);
  assert.equal(entry.surface, '');
  assert.equal(entry.open, true);
  // Closing while the browser shows keeps the browser in front.
  const browserFront = withPaneDockDiffClosed({
    open: true,
    view: 'source-control',
    surface: 'browser',
    diff: diffB,
  });
  assert.equal(browserFront.diff, null);
  assert.equal(browserFront.surface, 'browser');
});

test("the diff child shows only when it is the open unit's surface", () => {
  assert.equal(paneDiffShowing(closed()), false);
  assert.equal(
    paneDiffShowing({
      open: false,
      view: 'source-control',
      surface: 'diff',
      diff: diffA,
    }),
    false
  );
  assert.equal(
    paneDiffShowing({
      open: true,
      view: 'source-control',
      surface: 'browser',
      diff: diffA,
    }),
    false
  );
  assert.equal(
    paneDiffShowing({
      open: true,
      view: 'source-control',
      surface: 'diff',
      diff: diffA,
    }),
    true
  );
});

const fileLink = { project: 'C:/p', rel: 'src/a.ts', line: 12 };

test('a transcript file link opens the file surface as a tab; the preview tab is replaced by the next', () => {
  let entry = closed();
  entry = withPaneDockFileOpened(entry, fileLink, 1, { now: 10 });
  assert.equal(entry.open, true);
  assert.equal(entry.surface, 'file');
  assert.deepEqual(entry.files, [{ ...fileLink, nonce: 1, openedAt: 10 }]);
  assert.equal(paneDockActiveRoot(entry), null);
  entry = withPaneDockFileOpened(entry, { project: 'C:/p', rel: 'src/b.ts' }, 2, { preview: true, now: 20 });
  entry = withPaneDockFileOpened(entry, { project: 'C:/p', rel: 'src/c.ts' }, 3, { preview: true, now: 30 });
  assert.deepEqual(
    entry.files.map((file) => [file.rel, Boolean(file.preview)]),
    [
      ['src/a.ts', false],
      ['src/c.ts', true],
    ]
  );
  assert.equal(paneDockActiveFile(entry).rel, 'src/c.ts');
  assert.equal(entry.surface, 'file');
  entry = withPaneDockFileClosed(entry);
  assert.equal(paneDockActiveFile(entry).rel, 'src/a.ts');
  entry = withPaneDockFileClosed(entry);
  assert.equal(entry.files, undefined);
  assert.equal(entry.surface, '');
  assert.equal(entry.open, true);
});

test('closing the last file tab ends the dock unless the Changes tab remains', () => {
  const a = { project: 'C:/p', rel: 'src/a.ts' };
  const b = { project: 'C:/p', rel: 'src/b.ts' };
  let entry = withPaneDockFileOpened(closed(), a, 1, { now: 1 });
  const keyA = sideFileKey(entry.files[0]);
  assert.equal(paneDockFileCloseEndsDock(entry, keyA, true), true);
  assert.equal(paneDockFileCloseEndsDock({ ...entry, view: 'session-diff' }, keyA, true), false);
  // Without a session there is no Changes tab, so the view never counts.
  assert.equal(paneDockFileCloseEndsDock({ ...entry, view: 'session-diff' }, keyA, false), true);
  entry = withPaneDockFileOpened(entry, b, 2, { now: 2 });
  assert.equal(paneDockFileCloseEndsDock(entry, keyA, true), false);
  entry = withPaneDockFileClosed(entry, keyA);
  assert.equal(entry.open, true);
  assert.equal(paneDockActiveFile(entry).rel, 'src/b.ts');
  assert.equal(paneDockFileCloseEndsDock(entry, sideFileKey(entry.files[0]), true), true);
});

test('the side files persist, restore, and stay in front of a session surface', () => {
  const stored = JSON.parse(JSON.stringify({ 'pane-1': withPaneDockFileOpened(closed(), fileLink, 5, { now: 6 }) }));
  const restored = normalizePaneSideDocks(stored, ['pane-1'], RIGHT, false);
  assert.deepEqual(restored['pane-1'].files, [{ ...fileLink, nonce: 5, openedAt: 6 }]);
  assert.equal(restored['pane-1'].surface, 'file');
  assert.equal(restored['pane-1'].open, true);
  assert.ok(samePaneSideDocks(restored, restored));
  assert.ok(!samePaneSideDocks(restored, { 'pane-1': { ...restored['pane-1'], files: undefined } }));
  // A file-scoped access token never survives a restart.
  const tokened = {
    'pane-1': { ...stored['pane-1'], files: [{ ...stored['pane-1'].files[0], accessToken: 't' }] },
  };
  assert.equal(normalizePaneSideDocks(tokened, ['pane-1'], RIGHT, false)['pane-1'].surface, '');
  // The session's browser surface does not hide a freshly opened file.
  const shown = sessionSideDockEntryForSession(restored['pane-1'], 'sess', 'browser');
  assert.equal(shown.surface, 'file');
  // The session the file opened beside survives a restart, and counts as a change.
  const owned = { 'pane-1': { ...stored['pane-1'], owner: 'sess' } };
  assert.equal(normalizePaneSideDocks(owned, ['pane-1'], RIGHT, false)['pane-1'].owner, 'sess');
  assert.ok(!samePaneSideDocks(restored, normalizePaneSideDocks(owned, ['pane-1'], RIGHT, false)));
});

test("owned dock state follows its session's tab between panes and is released with its last tab", () => {
  const file = withPaneDockFileOpened(closed(), fileLink, 1, { now: 1 });
  const owned = { ...file, owner: 's1' };
  const empty = closed();
  // Still in its pane: nothing changes (same object).
  const docks = { L1: owned, L2: empty };
  assert.strictEqual(reconcilePaneDockOwners(docks, { L1: ['s1'], L2: ['s2'] }), docks);
  // Moved to L2: the file, its front place and the owner go along; L1 folds.
  const moved = reconcilePaneDockOwners(docks, { L1: ['bot'], L2: ['s2', 's1'] });
  assert.deepEqual(moved.L2.files, owned.files);
  assert.equal(moved.L2.surface, 'file');
  assert.equal(moved.L2.open, true);
  assert.equal(moved.L2.owner, 's1');
  assert.deepEqual(moved.L1, { ...closed(), surface: '', open: false });
  // A pane that closed while its session moved hands it over too.
  assert.equal(reconcilePaneDockOwners({ L1: owned }, { L2: ['s1'] }).L2.owner, 's1');
  // The destination keeps its own file tabs; the moved ones are released.
  const busy = { ...withPaneDockFileOpened(closed(), { project: 'C:/p', rel: 'b.ts' }, 2, { now: 2 }), owner: 's2' };
  const kept = reconcilePaneDockOwners({ L1: owned, L2: busy }, { L1: [], L2: ['s2', 's1'] });
  assert.strictEqual(kept.L2, busy);
  assert.equal(kept.L1.files, undefined);
  // Last tab gone (closed, archived, deleted): released, never stranded.
  const gone = reconcilePaneDockOwners(
    { L1: { ...owned, folder: { project: 'C:/p', rel: '', nonce: 1 } } },
    { L1: [] }
  );
  assert.deepEqual(gone.L1, { ...closed(), surface: '', open: false });
  // An entry with unsaved file tabs stays exactly where it is: not released,
  // not moved to a free pane holding its session, not joined into another pane.
  const dirty = { L1: owned };
  for (const panes of [{ L1: [] }, { L1: [], L2: ['s1'] }, { L2: ['s1'] }, { L2: ['s2'] }]) {
    assert.strictEqual(
      reconcilePaneDockOwners(dirty, panes, () => true),
      dirty,
      JSON.stringify(panes)
    );
  }
  const crowded = { L1: owned, L2: { ...withPaneDockFileOpened(closed(), fileLink, 3, { now: 3 }), owner: 's2' } };
  assert.strictEqual(
    reconcilePaneDockOwners(crowded, { L2: ['s2', 's1'] }, (leafId) => leafId === 'L1'),
    crowded
  );
  // Unowned entries are left alone.
  const free = { L1: file };
  assert.strictEqual(reconcilePaneDockOwners(free, { L1: [] }), free);
});

test("a parked owner front follows the owned entry's lifecycle and survives a restart", () => {
  const files = withPaneDockFileOpened(closed(), fileLink, 1, { now: 1 }).files;
  // s2 picked Source Control over s1's file: s1's front is parked.
  const parked = {
    open: true,
    view: 'source-control',
    surface: '',
    diff: null,
    files,
    activeFile: sideFileKey(files[0]),
    owner: 's1',
    parked: { open: true, surface: 'file' },
  };
  // s1 shown again: its front comes back, s2's view is parked for the others.
  const back = paneDockRestored(parked, 's1');
  assert.equal(back.surface, 'file');
  assert.deepEqual(back.parked, { open: true, surface: '' });
  assert.strictEqual(paneDockRestored(parked, 's2'), parked);
  // Restart: kept as stored; a parked file surface without files is dropped.
  assert.deepEqual(normalizePaneSideDocks({ L1: parked }, ['L1'], RIGHT, false).L1.parked, parked.parked);
  assert.equal(
    normalizePaneSideDocks({ L1: { ...parked, files: undefined } }, ['L1'], RIGHT, false).L1.parked,
    undefined
  );
  // s1's tab moves to L2: the parked front goes along and is in front there.
  const moved = reconcilePaneDockOwners({ L1: parked, L2: closed() }, { L1: ['s2'], L2: ['s1'] });
  assert.equal(moved.L2.surface, 'file');
  assert.equal(moved.L2.open, true);
  assert.equal(moved.L1.parked, undefined);
  assert.equal(moved.L1.view, 'source-control', "s2's view stays in L1");
  assert.equal(moved.L1.open, true);
  // s1 gone: released; with its file in front, the front parked for the others comes back.
  const gone = reconcilePaneDockOwners({ L1: back }, { L1: ['s2'] });
  assert.equal(gone.L1.files, undefined);
  assert.equal(gone.L1.parked, undefined);
  assert.equal(gone.L1.surface, '');
  assert.equal(gone.L1.open, true);
  // Unsaved tabs behind a parked front are never dropped either.
  const dirty = { L1: parked };
  assert.strictEqual(
    reconcilePaneDockOwners(dirty, { L1: ['s2'] }, () => true),
    dirty
  );
});

// Module-level so its identity is stable across the dock's re-renders.
function SideFileStub({ rel, side }) {
  React.useEffect(() => {
    side.onChrome({ editable: true, dirty: true, saving: false, save() {}, reveal() {} });
  }, [side.onChrome]);
  return React.createElement(
    'div',
    { 'data-testid': 'side-file' },
    rel,
    React.createElement('button', { type: 'button', 'data-testid': 'status-problems', onClick: side.onShowProblems })
  );
}

test("a session terminal's X closes the dock of its session even when that pane is not focused", async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'CustomEvent'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const { requestPaneDockClose } = await import('./pane-dock-chrome.tsx');
  const Icon = () => React.createElement('span');
  const closes = [];
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(PaneSideDock, {
          leafId: 'pane-1',
          sessionId: 's1',
          groups: [['terminal']],
          descriptors: new Map([['terminal', { id: 'terminal', label: 'Terminal', icon: Icon }]]),
          focused: false,
          onSelect() {},
          onClose: () => closes.push('pane-1'),
          onCloseDiff() {},
          onMoveGroup() {},
          onMoveView() {},
          onFocusPane() {},
          openFileTab() {},
          renderTerminalSurface: () => null,
          renderView: () => null,
          entry: { open: true, view: 'source-control', surface: 'terminal', diff: null },
        })
      )
    );
    await act(async () => requestPaneDockClose('terminal', 's2'));
    assert.deepEqual(closes, [], "another session's X leaves this dock open");
    await act(async () => requestPaneDockClose('terminal'));
    assert.deepEqual(closes, [], 'without a session only the focused dock takes the X');
    await act(async () => requestPaneDockClose('terminal', 's1'));
    assert.deepEqual(closes, ['pane-1'], 'its own session closes it without focusing the pane first');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('a stored Profile view outside the session groups never titles the Changes body', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const Icon = () => React.createElement('span');
  const descriptors = new Map([
    ['session-diff', { id: 'session-diff', label: 'Changes', icon: Icon }],
    ['routines', { id: 'routines', label: 'Profile', icon: Icon }],
  ]);
  const props = (groups) => ({
    leafId: 'pane-1',
    sessionId: 's1',
    sessionBound: true,
    groups,
    descriptors,
    focused: true,
    onSelect() {},
    onClose() {},
    onCloseDiff() {},
    onMoveGroup() {},
    onMoveView() {},
    onFocusPane() {},
    openFileTab() {},
    renderView: (id) => React.createElement('div', { className: `body-${id}` }),
    entry: { open: true, view: 'routines', surface: '', diff: null },
  });
  assert.equal(
    paneDockEntryInGroups(props([['session-diff']]).entry, [['session-diff']]).view,
    'session-diff',
    'the view the panel falls back to'
  );
  assert.equal(paneDockEntryInGroups(props([]).entry, [['routines'], ['session-diff']]).view, 'routines');
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(PaneSideDock, props([['session-diff']]))));
    assert.equal(document.querySelector('.pane-side-dock-chrome'), null, 'no panel title row over Changes');
    assert.equal(document.body.textContent.includes('Profile'), false);
    await act(async () => root.render(React.createElement(PaneSideDock, props([['routines'], ['session-diff']]))));
    assert.equal(document.querySelector('.pane-side-dock-chrome .dock-header-title')?.textContent, 'Profile');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('the side file header offers Open in main tab', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const calls = [];
  const Icon = () => React.createElement('span');
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(PaneSideDock, {
          leafId: 'pane-1',
          groups: [['source-control']],
          descriptors: new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]),
          focused: true,
          onSelect() {},
          onClose() {},
          onCloseDiff() {},
          onCloseFile: () => calls.push(['close']),
          onMoveGroup() {},
          onMoveView() {},
          onFocusPane() {},
          openFileTab: (...args) => calls.push(['open', ...args]),
          renderFileSurface: (file, _active, side) => React.createElement(SideFileStub, { rel: file.rel, side }),
          renderFileProblems: (file) =>
            React.createElement('div', { 'data-testid': 'side-problems' }, `problems:${file.rel}`),
          renderView: () => null,
          entry: withPaneDockFileOpened(closed(), { ...fileLink, accessToken: 'tok' }, 1, { now: 2 }),
        })
      )
    );
    assert.equal(document.querySelector('[data-testid="side-file"]')?.textContent, 'src/a.ts');
    // ONE header row for the file: no separate dock title row, no extra strip.
    assert.equal(document.querySelectorAll('.pane-side-dock-header').length, 0);
    assert.equal(document.querySelector('.pane-side-dock-title'), null);
    assert.equal(document.querySelectorAll('.dock-header-row').length, 1);
    assert.equal(document.querySelectorAll('.browser-tab-toolbar').length, 0);
    const strip = document.querySelector('.dock-header-row');
    const tab = strip.querySelector('.dock-header-left .browser-tab.is-active.dock-header-chip');
    const chip = tab.querySelector('.browser-tab-select');
    assert.equal(chip.textContent, 'a.ts');
    assert.equal(chip.getAttribute('title'), 'src/a.ts');
    assert.deepEqual(
      [...strip.querySelectorAll('.dock-header-controls .browser-pane-nav-button')].map((b) =>
        b.getAttribute('aria-label')
      ),
      ['Save', 'More actions', 'Expand', 'Close panel']
    );
    // Problems opens only from the editor's bottom status bar, never the strip.
    assert.equal(strip.querySelector('[aria-label="Problems"]'), null);
    assert.equal(document.querySelector('.editor-breadcrumbs'), null);
    // Problems: the status-bar button opens a split INSIDE the side file slot,
    // under the editor, scoped to this file; its own X closes it again.
    assert.equal(document.querySelector('.pane-side-file-problems'), null);
    await act(async () => document.querySelector('[data-testid="status-problems"]').click());
    const split = document.querySelector('.pane-side-file-problems');
    assert.ok(split, 'the split opens');
    assert.equal(split.textContent.includes('problems:src/a.ts'), true);
    const body = document.querySelector('.pane-side-file-body');
    assert.ok(body.contains(split) && body.contains(document.querySelector('.pane-side-file-editor')));
    assert.deepEqual(
      [...body.children].map((c) => c.className.split(' ')[0]),
      ['pane-side-file-editor', 'pane-side-file-problems'],
      'editor above, split below, sharing the slot height'
    );
    assert.ok(split.querySelector('.pane-side-file-problems-resize'), 'resizable');
    assert.equal(document.querySelectorAll('.workbench-side-surface-slot .pane-side-file-body').length, 1);
    await act(async () => split.querySelector('button[aria-label="Close panel"]').click());
    assert.equal(document.querySelector('.pane-side-file-problems'), null);
    assert.ok(document.querySelector('.pane-side-file-editor'), 'the editor keeps the full height');
    await act(async () => document.querySelector('.side-file-header .dock-header-more').click());
    const button = [...document.querySelectorAll('.dock-header-menu [role="menuitem"]')].find((item) =>
      item.textContent.includes('Open in main tab')
    );
    assert.ok(button);
    await act(async () => button.click());
    // The host's main-tab open takes the file over (and closes this side file).
    assert.deepEqual(calls, [['open', 'C:/p', 'src/a.ts', 12, 'tok']]);
    // The header X closes the file through the host's guarded path.
    await act(async () => document.querySelector('button[aria-label="Close panel"]').click());
    assert.deepEqual(calls.at(-1), ['close']);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('phone sheet: the pane header row is the top row and its ⋯ menu switches panes', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  Object.defineProperty(dom.window.navigator, 'userAgent', {
    configurable: true,
    get: () => 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile',
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const calls = [];
  const Icon = () => React.createElement('span');
  const descriptors = new Map([
    ['session-diff', { id: 'session-diff', label: 'Changes', icon: Icon }],
    ['terminal', { id: 'terminal', label: 'Terminal', icon: Icon }],
  ]);
  const root = createRoot(document.getElementById('root'));
  const render = (entry) =>
    act(async () =>
      root.render(
        React.createElement(PaneSideDock, {
          leafId: 'pane-1',
          groups: [['session-diff'], ['terminal']],
          descriptors,
          focused: true,
          sessionBound: true,
          onOpenFiles: () => calls.push(['files']),
          onSelect: (id) => calls.push(['select', id]),
          onClose: () => calls.push(['fold']),
          onCloseDiff() {},
          onCloseFile: () => calls.push(['close-file']),
          onMoveGroup() {},
          onMoveView() {},
          onFocusPane() {},
          openFileTab() {},
          renderFileSurface: (file, _active, side) => React.createElement(SideFileStub, { rel: file.rel, side }),
          renderView: () => null,
          entry,
        })
      )
    );
  try {
    await render(withPaneDockFileOpened(closed('session-diff'), fileLink, 1, { now: 2 }));
    // No title/icon bar: the file's own PC header row is the top row, and the
    // pane switch (Files, Changes, Terminal) lives in its ⋯ menu.
    assert.equal(document.querySelector('.pane-side-dock-header'), null);
    assert.equal(document.querySelectorAll('.dock-header-row').length, 1);
    const openMenu = async () => {
      await act(async () => document.querySelector('.dock-header-row .dock-header-more').click());
      return [...document.querySelectorAll('.dock-header-menu [role="menuitem"]')];
    };
    let items = await openMenu();
    const labels = items.map((item) => item.textContent);
    assert.deepEqual(labels.slice(-3), ['Files', 'Changes', 'Terminal']);
    await act(async () => items.find((item) => item.textContent === 'Changes').click());
    items = await openMenu();
    await act(async () => items.find((item) => item.textContent === 'Files').click());
    assert.deepEqual(calls, [['select', 'session-diff'], ['files']]);
    // The header X closes the showing file through the guarded path.
    await act(async () => document.querySelector('.dock-header-row button[aria-label="Close panel"]').click());
    assert.deepEqual(calls.at(-1), ['close-file']);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('file tabs: select, double-click keeps a preview, close and the menu act per tab', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MouseEvent'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const calls = [];
  const Icon = () => React.createElement('span');
  let entry = withPaneDockFileOpened(closed(), fileLink, 1, { now: 1 });
  entry = withPaneDockFileOpened(entry, { project: 'C:/p', rel: 'src/b.ts' }, 2, { preview: true, now: 2 });
  const aKey = sideFileKey(fileLink);
  const bKey = sideFileKey({ project: 'C:/p', rel: 'src/b.ts' });
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(PaneSideDock, {
          leafId: 'pane-1',
          groups: [['source-control']],
          descriptors: new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]),
          focused: true,
          onSelect() {},
          onClose() {},
          onCloseDiff() {},
          onCloseFileTab: (key) => calls.push(['close-tab', key]),
          onActivateFile: (key) => calls.push(['activate', key]),
          onKeepFile: (key) => calls.push(['keep', key]),
          onMoveGroup() {},
          onMoveView() {},
          onFocusPane() {},
          openFileTab() {},
          renderFileSurface: (file) => React.createElement('div', { 'data-testid': `file-${file.rel}` }),
          renderView: () => null,
          entry,
        })
      )
    );
    const tabs = [...document.querySelectorAll('.side-file-header [role="tab"]')];
    assert.deepEqual(
      tabs.map((tab) => tab.textContent),
      ['a.ts', 'b.ts']
    );
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.ok(tabs[1].closest('.browser-tab').classList.contains('is-preview'));
    assert.ok(tabs[1].getAttribute('title').includes('Preview tab'));
    // Every tab keeps its own mounted editor; only the active one shows.
    const bodies = [...document.querySelectorAll('.pane-side-file-tab')];
    assert.deepEqual(
      bodies.map((body) => body.hidden),
      [true, false]
    );
    await act(async () => tabs[0].click());
    await act(async () =>
      tabs[1].closest('.browser-tab').dispatchEvent(new dom.window.MouseEvent('dblclick', { bubbles: true }))
    );
    await act(async () => document.querySelector('.side-file-header .browser-tab-close').click());
    await act(async () =>
      tabs[1]
        .closest('.browser-tab')
        .dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    );
    const items = [...document.querySelectorAll('.dock-header-menu [role="menuitem"]')];
    assert.deepEqual(
      items.map((item) => item.textContent),
      ['Keep Open', 'Close tab']
    );
    await act(async () => items[0].click());
    assert.equal(document.querySelector('.dock-header-menu'), null);
    assert.deepEqual(calls, [
      ['activate', aKey],
      ['keep', bKey],
      ['close-tab', aKey],
      ['keep', bKey],
    ]);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('mobile always stacks the visible diff so Goal has a visible DIFF anchor', () => {
  assert.equal(paneDiffStacks(true, 1_200, 640, true), true);
  assert.equal(paneDiffStacks(true, 1_200, 640, false), false);
  assert.equal(paneDiffStacks(true, 500, 640, false), true);
  assert.equal(paneDiffStacks(false, 500, 640, true), false);
});

test('a cold pane dock opens with its body in the same commit', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  let nextFrame = 1;
  const pendingFrames = new Map();
  dom.window.requestAnimationFrame = (callback) => {
    const frame = nextFrame++;
    pendingFrames.set(frame, callback);
    return frame;
  };
  dom.window.cancelAnimationFrame = (frame) => pendingFrames.delete(frame);

  const noop = () => {};
  const Icon = () => React.createElement('span');
  const descriptors = new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]);
  const baseProps = {
    leafId: 'pane-1',
    groups: [['source-control']],
    descriptors,
    focused: true,
    onSelect: noop,
    onClose: noop,
    onCloseDiff: noop,
    onMoveGroup: noop,
    onMoveView: noop,
    onFocusPane: noop,
    openFileTab: noop,
    renderView: () => React.createElement('div', { 'data-testid': 'heavy-dock-body' }, 'ready'),
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(PaneSideDock, {
          ...baseProps,
          entry: closed(),
        })
      )
    );
    await act(async () =>
      root.render(
        React.createElement(PaneSideDock, {
          ...baseProps,
          entry: { ...closed(), open: true },
        })
      )
    );

    const dock = document.querySelector('.pane-side-dock');
    const panel = document.querySelector('.workbench-side-panel');
    assert.equal(dock?.dataset.open, 'true');
    assert.ok(panel);
    assert.equal(panel.hidden, false);
    // No frame hand-off: the opening commit already carries the body.
    assert.ok(document.querySelector('[data-testid="heavy-dock-body"]'));
    assert.equal(pendingFrames.size, 0);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('a warm pane dock reopens with its width and its active body in the click commit', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node'],
  });
  let nextFrame = 1;
  const pendingFrames = new Map();
  dom.window.requestAnimationFrame = (callback) => {
    const frame = nextFrame++;
    pendingFrames.set(frame, callback);
    return frame;
  };
  dom.window.cancelAnimationFrame = (frame) => pendingFrames.delete(frame);
  const runFrames = () =>
    act(async () => {
      while (pendingFrames.size) {
        const callbacks = [...pendingFrames.values()];
        pendingFrames.clear();
        for (const callback of callbacks) callback(16);
      }
    });

  const { registerTranscriptWidthSync } = await import('./transcript-list-resize-patch.ts');
  let widthSyncs = 0;
  const unregister = registerTranscriptWidthSync(() => widthSyncs++);
  const noop = () => {};
  const Icon = () => React.createElement('span');
  const descriptors = new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]);
  const activity = [];
  const baseProps = {
    leafId: 'pane-1',
    groups: [['source-control']],
    descriptors,
    focused: true,
    onSelect: noop,
    onClose: noop,
    onCloseDiff: noop,
    onMoveGroup: noop,
    onMoveView: noop,
    onFocusPane: noop,
    openFileTab: noop,
    renderView: (_id, active) => {
      activity.push(active);
      return React.createElement('div', { 'data-testid': 'dock-body' }, 'ready');
    },
  };
  const render = (open) =>
    act(async () => root.render(React.createElement(PaneSideDock, { ...baseProps, entry: { ...closed(), open } })));
  const root = createRoot(document.getElementById('root'));
  try {
    await render(true);
    await runFrames();
    await render(false);
    await runFrames();
    assert.equal(activity.at(-1), false);
    const syncsBeforeOpen = widthSyncs;
    activity.length = 0;

    await render(true);
    const dock = document.querySelector('.pane-side-dock');
    assert.equal(dock.dataset.open, 'true', 'the sheet takes its width in the click commit');
    assert.equal(activity.at(-1), true, 'the body is active in the same commit');
    assert.equal(pendingFrames.size, 0, 'nothing waits for a later frame');
    assert.ok(widthSyncs > syncsBeforeOpen, "the commit that moved the pane's edge re-measured the transcripts");

    // A desktop close hides the body in the close commit (no exit slide).
    await render(false);
    assert.equal(activity.at(-1), false);
    assert.equal(dock.dataset.closing, undefined);
  } finally {
    unregister();
    await act(async () => root.unmount());
    restore();
  }
});

test('a :line:column link keeps its column through the dock', () => {
  const stored = JSON.parse(
    JSON.stringify({ 'pane-1': withPaneDockFileOpened(closed(), { ...fileLink, column: 3 }, 9) })
  );
  const restored = normalizePaneSideDocks(stored, ['pane-1'], RIGHT, false);
  assert.equal(restored['pane-1'].files[0].column, 3);
});

test('Open in main tab and Open in default app are ⋯ items with different icons', async () => {
  const { sideFileActions } = await import('./side-surface-strip.tsx');
  const actions = sideFileActions(
    { editable: false, dirty: false, saving: false, save() {}, reveal() {}, openDefault() {} },
    () => {}
  );
  const byId = (id) => actions.find((a) => a.id === id);
  assert.ok(byId('open-default') && byId('open-main') && byId('reveal'));
  assert.notEqual(byId('open-default').icon, byId('open-main').icon);
  assert.equal(
    actions.some((a) => a.inline),
    false,
    'nothing but Save-while-dirty is a header button'
  );
  assert.equal(
    sideFileActions({ editable: true, dirty: true, saving: false, save() {}, reveal() {} }, () => {}).filter(
      (a) => a.inline
    ).length,
    1
  );
});

test('default widths: every surface 500 on one shared width; every surface clamps to 280..1160', async () => {
  const dock = await import('./pane-side-dock.tsx');
  assert.equal(dock.PANE_SIDE_DOCK_DEFAULT_WIDTH, 500);
  assert.equal(dock.PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH, 500);
  assert.equal(dock.PANE_SIDE_DOCK_MIN_WIDTH, 280);
  assert.equal(dock.PANE_SIDE_DOCK_MAX_WIDTH, 1160);
  // The user-resized width wins over the default, clamped to the limits.
  const store = new Map([
    ['k', '640'],
    ['small', '10'],
    ['diff', '900'],
    ['huge', '5000'],
  ]);
  const previous = globalThis.window;
  globalThis.window = { localStorage: { getItem: (key) => store.get(key) ?? null } };
  try {
    assert.equal(dock.readStoredWidth('k', 320, 1160, 500), 640);
    assert.equal(dock.readStoredWidth('small', 240, 1160, 280), 240);
    assert.equal(dock.readStoredWidth('none', 240, 1160, 280), 280);
    const { PANE_SIDE_DOCK_MIN_WIDTH: min, PANE_SIDE_DOCK_MAX_WIDTH: max } = dock;
    assert.equal(dock.readStoredWidth('small', min, max, 500), 280);
    assert.equal(dock.readStoredWidth('diff', min, max, 500), 900, 'a 900 diff width is kept');
    assert.equal(dock.readStoredWidth('huge', min, max, 500), 1160);
  } finally {
    globalThis.window = previous;
  }
});

test('shared dock width: v2 wins, the legacy browser key only seeds an absent or empty v2, old keys are ignored', async () => {
  const dock = await import('./pane-side-dock.tsx');
  const V2 = 'mixdog.desktop.pane-side-dock-width.v2';
  const LEGACY_BROWSER = 'mixdog.desktop.pane-side-dock-browser-width.v1';
  const OLD_PANEL = 'mixdog.desktop.pane-side-dock-width.v1';
  const OLD_TERMINAL = 'mixdog.desktop.pane-side-dock-terminal-width.v1';
  const previous = globalThis.window;
  const read = (entries) => {
    const store = new Map(Object.entries(entries));
    globalThis.window = { localStorage: { getItem: (key) => store.get(key) ?? null } };
    return dock.readSharedDockWidth();
  };
  try {
    assert.equal(read({ [V2]: '640' }), 640, 'v2 valid');
    assert.equal(read({ [V2]: '640', [LEGACY_BROWSER]: '900' }), 640, 'v2 beats legacy');
    assert.equal(read({ [V2]: 'corrupt', [LEGACY_BROWSER]: '900' }), 500, 'corrupt v2 falls back to the default');
    assert.equal(read({ [LEGACY_BROWSER]: '900' }), 900, 'absent v2 seeds from legacy');
    assert.equal(read({ [V2]: '', [LEGACY_BROWSER]: '900' }), 900, 'empty v2 seeds from legacy');
    assert.equal(read({ [LEGACY_BROWSER]: '5000' }), 1160, 'legacy seed is clamped');
    assert.equal(read({}), 500, 'both absent');
    assert.equal(read({ [OLD_PANEL]: '700', [OLD_TERMINAL]: '333' }), 500, 'old panel/terminal keys are ignored');
    assert.equal(read({ [V2]: '640', [OLD_PANEL]: '700', [OLD_TERMINAL]: '333' }), 640);
    assert.equal(read({ [LEGACY_BROWSER]: '900', [OLD_PANEL]: '700', [OLD_TERMINAL]: '333' }), 900);
  } finally {
    globalThis.window = previous;
  }
});

test('the browser ⋯ menu carries device view, copy link, system browser and credentials', async () => {
  const { browserHeaderActions } = await import('./BrowserPane.lazy.tsx');
  const fills = [];
  const actions = browserHeaderActions({
    currentUrl: 'https://a.test/',
    viewportPresetId: 'responsive',
    selectViewportPreset() {},
    credentialSuggestions: [{ id: 'c1', label: 'me@a.test' }],
    credentialBusy: false,
    credentialStatus: 'idle',
    fillStoredCredential: (id) => fills.push(id),
  });
  // Every browser action lives in ⋯ (including open in system browser); none is a header button.
  assert.ok(actions.every((item) => !item.inline));
  assert.ok(actions.some((item) => item.id === 'open-external'));
  assert.equal(
    actions.some((item) => item.id === 'import'),
    false,
    'import moved to the nav row'
  );
  const labels = actions.map((item) => item.label);
  assert.ok(labels.includes('Device view'));
  assert.equal(labels.includes('Copy link'), false, 'copy link was removed from ⋯');
  assert.ok(labels.includes('Open in system browser'));
  assert.ok(labels.includes('Fill with stored credentials'));
  assert.equal(actions.filter((item) => item.checked && item.id !== 'zoom-bar').length, 1);
  const zoomBar = actions.find((item) => item.id === 'zoom-bar');
  assert.equal(zoomBar.label, 'Zoom bar');
  assert.equal(zoomBar.checkbox, true);
  actions.find((item) => item.id === 'credential-c1').onSelect();
  assert.deepEqual(fills, ['c1']);
});

test('the side editor gutter is slim and its status bar is the 24px problems/cursor/language row', async () => {
  const { sideEditorOptions } = await import('./editor-side-options.ts');
  const options = sideEditorOptions({}, null);
  assert.equal(options.glyphMargin, false);
  assert.equal(options.folding, false);
  assert.equal(options.lineNumbersMinChars, 3);
  assert.ok(options.lineDecorationsWidth <= 12);
  // No overview-ruler marks painted over the slim scrollbar thumb.
  assert.equal(options.overviewRulerLanes, 0);
  assert.equal(options.hideCursorInOverviewRuler, true);
});

test('dock header tab lists behave like the pane tab strip for 2-6 browser and terminal tabs at 280/500px', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { BrowserTabStrip } = await import('./BrowserTabStrip.tsx');
  for (const count of [2, 3, 4, 5, 6]) {
    const tabs = Array.from({ length: count }, (_, i) => ({
      id: `p${i}`,
      title: `A long page title number ${i}`,
      url: `https://a.test/${i}`,
      active: i === 0,
      loading: false,
      kind: 'page',
    }));
    const html = renderToStaticMarkup(
      React.createElement(BrowserTabStrip, { tabs, async onSelect() {}, async onCreate() {}, async onClose() {} })
    );
    for (const width of [280, 500]) {
      // Structure is width-independent: one list holding every tab, + outside it.
      assert.equal(html.match(/class="browser-tab(?: is-active)?"/g).length, count, `${count} tabs @${width}`);
      assert.equal(html.match(/class="browser-tab-list"/g).length, 1);
      assert.ok(html.indexOf('browser-tab-new') > html.lastIndexOf('browser-tab-select'));
      assert.doesNotMatch(html, /style="[^"]*overflow/);
    }
  }
});

test('scrollTabListByWheel maps the vertical wheel to horizontal scroll like the pane strip', async () => {
  const { scrollTabListByWheel } = await import('./pane-dock-chrome.tsx');
  const calls = [];
  const list = { scrollBy: (o) => calls.push(o.left) };
  scrollTabListByWheel({ deltaX: 0, deltaY: 40 }, list);
  scrollTabListByWheel({ deltaX: -25, deltaY: 3 }, list);
  scrollTabListByWheel({ deltaX: 0, deltaY: 0 }, list);
  assert.deepEqual(calls, [40, -25]);
});

test('in-flow dock surfaces get the same expand control from the dock context, left of close', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { DockHeaderRow, PaneDockExpandContext } = await import('./pane-dock-chrome.tsx');
  const labels = (html) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
  const row = (value) =>
    renderToStaticMarkup(
      React.createElement(
        PaneDockExpandContext.Provider,
        { value },
        React.createElement(DockHeaderRow, { left: 'x', onClose() {} })
      )
    );
  assert.deepEqual(labels(row({ expanded: false, toggle() {} })).slice(-2), ['Expand', 'Close panel']);
  assert.deepEqual(labels(row({ expanded: true, toggle() {} })).slice(-2), ['Restore', 'Close panel']);
  // No dock context (phone sheet, browser/terminal roots with their own props): no control.
  assert.deepEqual(labels(row(null)), ['Close panel']);
});

test('expandedDockRect measures the main panel and is undefined without a host', async () => {
  const { expandedDockRect } = await import('./surface-slots.ts');
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { restore } = installTestDom(null, {
    html: '<!doctype html><html><body><div class="main-panel"><div id="h"></div></div></body></html>',
    expose: ['Element'],
  });
  try {
    document.querySelector('.main-panel').getBoundingClientRect = () => ({
      left: 10,
      top: 20,
      width: 800,
      height: 600,
      right: 810,
      bottom: 620,
    });
    assert.deepEqual(expandedDockRect(document.getElementById('h')), { left: 10, top: 20, width: 800, height: 600 });
    assert.equal(expandedDockRect(null), undefined);
  } finally {
    restore();
  }
});

test('dock expansion toggles and resets when the surface, the view or the open state changes', async (t) => {
  const { root } = installTestDom(t, { rootId: 'root' });
  const { useDockExpansion } = await import('./pane-side-dock-hooks.ts');
  // A measurable host inside the main panel, so expansion has geometry to clear.
  const panel = document.createElement('div');
  panel.className = 'main-panel';
  panel.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 600, right: 810, bottom: 620 });
  const host = document.createElement('div');
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 400, right: 300, bottom: 400 });
  panel.append(host);
  document.body.append(panel);
  t.after(() => panel.remove());
  const hostRef = { current: host };
  let dock;
  function Probe(props) {
    dock = useDockExpansion(hostRef, props.surface, props.view, props.open);
    return null;
  }
  const render = (props) => act(async () => root.render(React.createElement(Probe, props)));
  const base = { surface: '', view: 'source-control', open: true };
  await render(base);
  assert.equal(dock.expanded, false);
  await act(async () => dock.toggleExpanded());
  assert.equal(dock.expanded, true);
  await act(async () => dock.toggleExpanded());
  assert.equal(dock.expanded, false, 'toggling again restores');
  for (const change of [{ surface: 'file:a.ts' }, { view: 'browser' }, { open: false }]) {
    await render(base);
    await act(async () => dock.toggleExpanded());
    assert.equal(dock.expanded, true);
    assert.notEqual(dock.expandedRect, undefined, 'expansion measures the main panel');
    await render({ ...base, ...change });
    assert.equal(dock.expanded, false, `${Object.keys(change)[0]} change resets expansion`);
    assert.equal(dock.expandedRect, undefined, `${Object.keys(change)[0]} change clears the geometry`);
  }
});
test('side file: status lives in a second row; ⋯ holds only real actions', async () => {
  const { sideFileActions, SideFileStrip } = await import('./side-surface-strip.tsx');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const calls = [];
  const chrome = {
    editable: true,
    dirty: true,
    saving: false,
    save() {},
    reveal() {},
    problems: { errors: 2, warnings: 5, onToggle: () => calls.push('problems') },
    cursor: { label: 'Ln 12, Col 1', short: '12:1', onGoto: () => calls.push('goto') },
    language: 'TypeScript',
    format: () => calls.push('format'),
    viewToggle: { value: 'rendered', renderedLabel: 'Preview', modes: ['rendered', 'source'], onChange() {} },
  };
  const actions = sideFileActions(chrome, () => {});
  // ⋯ keeps Reveal, Open in main tab and Format; Save is the only header button.
  assert.deepEqual(
    actions.filter((a) => a.inline).map((a) => a.id),
    ['save']
  );
  assert.deepEqual(
    actions.filter((a) => !a.inline).map((a) => a.id),
    ['reveal', 'open-main', 'format']
  );
  for (const id of ['problems', 'cursor', 'language', 'view'])
    assert.equal(
      actions.some((a) => a.id === id),
      false,
      id
    );
  actions.find((a) => a.id === 'format').onSelect();
  assert.deepEqual(calls, ['format']);

  // The header is the single top row; the status row is the card's footer.
  const tabOf = (rel, extra = {}) => ({ project: 'C:/p', rel, nonce: 1, openedAt: 1, ...extra });
  const stripProps = (files, activeKey, over = {}) => ({
    files,
    activeKey,
    chrome,
    onSelect() {},
    onCloseTab() {},
    onKeep() {},
    onOpenInMain() {},
    onClose() {},
    ...over,
  });
  const deep = tabOf('src/deep/a.ts');
  const header = renderToStaticMarkup(React.createElement(SideFileStrip, stripProps([deep], sideFileKey(deep))));
  assert.equal(header.includes('side-file-status-row'), false, 'no second row under the header');
  // A preview tab is marked (italic via .is-preview) and carries the hint.
  const previewTab = tabOf('src/deep/b.ts', { preview: true });
  const tabs = renderToStaticMarkup(
    React.createElement(SideFileStrip, stripProps([deep, previewTab], sideFileKey(previewTab)))
  );
  assert.equal((tabs.match(/class="browser-tab dock-header-chip/g) ?? []).length, 2);
  assert.equal((tabs.match(/is-preview/g) ?? []).length, 1);
  assert.ok(tabs.includes('Preview tab'), 'preview hint');
  const keepActions = sideFileActions(
    chrome,
    () => {},
    () => {}
  );
  assert.equal(keepActions[0].id, 'keep-open');
  const { SideFileStatusRow } = await import('./side-file-status-row.tsx');
  // Source mode: toggle (left) + problems, cursor, language (right); no path.
  const source = renderToStaticMarkup(
    React.createElement(SideFileStatusRow, {
      chrome: { ...chrome, viewToggle: { ...chrome.viewToggle, value: 'source' } },
    })
  );
  assert.equal(source.includes('src/deep/a.ts'), false, 'the footer carries no path');
  assert.equal(source.includes('side-file-path'), false);
  assert.ok(source.includes('side-file-status-problems') && source.includes('>2<') && source.includes('>5<'));
  assert.ok(source.includes('>12:1<'));
  assert.ok(source.includes('TypeScript'));
  // The footer carries no view switch: it lives in the file header.
  assert.equal(source.includes('editor-view-switch') || source.includes('role="radio'), false);
  // Rendered mode: the right side is empty.
  const rendered = renderToStaticMarkup(React.createElement(SideFileStatusRow, { chrome }));
  for (const marker of ['side-file-status-problems', 'side-file-status-cursor', 'side-file-status-language'])
    assert.equal(rendered.includes(marker), false, `rendered: ${marker}`);
  // Plain code (no toggle): only the right-side items.
  const code = renderToStaticMarkup(
    React.createElement(SideFileStatusRow, { chrome: { ...chrome, viewToggle: undefined } })
  );
  assert.ok(code.includes('side-file-status-cursor') && code.includes('side-file-status-problems'));
  // Previews (image/pdf/office/binary: no cursor, no view toggle) get NO footer; the chip tooltip carries the path.
  const { sideFileHasFooter } = await import('./side-file-status-row.tsx');
  const previewChrome = { editable: false, dirty: false, saving: false, save() {}, reveal() {}, openDefault() {} };
  assert.equal(sideFileHasFooter(previewChrome), false);
  assert.equal(sideFileHasFooter(null), false);
  assert.equal(sideFileHasFooter({ ...chrome, viewToggle: undefined }), true, 'plain code keeps its footer');
  assert.equal(sideFileHasFooter({ ...chrome, viewToggle: { ...chrome.viewToggle, value: 'source' } }), true);
  assert.equal(sideFileHasFooter(chrome), false, 'a rendered Markdown view has nothing to report');
  assert.equal(
    sideFileHasFooter({ ...previewChrome, tableSize: { rows: 2, columns: 3 } }),
    true,
    'a rendered table keeps its size footer'
  );
  // The header carries the one view switch (+ outline toggle), left of the action buttons.
  const markdownChrome = {
    ...chrome,
    viewToggle: { value: 'rich', renderedLabel: 'Preview', modes: ['rendered', 'rich', 'source'], onChange() {} },
    toc: { open: true, onToggle() {} },
  };
  const markdownHeader = renderToStaticMarkup(
    React.createElement(SideFileStrip, stripProps([deep], sideFileKey(deep), { chrome: markdownChrome }))
  );
  assert.deepEqual(
    [...markdownHeader.matchAll(/role="radio" aria-checked="(true|false)"[^>]*>([^<]*)</g)].map((m) => [m[2], m[1]]),
    [
      ['Preview', 'false'],
      ['Rich', 'true'],
      ['Source', 'false'],
    ]
  );
  assert.ok(markdownHeader.indexOf('editor-view-switch') < markdownHeader.indexOf('aria-label="Table of contents"'));
  assert.deepEqual(
    sideFileActions(markdownChrome, () => {})
      .filter((a) => a.inline)
      .map((a) => a.id),
    ['toc', 'save']
  );
  const previewHeader = renderToStaticMarkup(
    React.createElement(
      SideFileStrip,
      stripProps([tabOf('decks/deck.pptx')], sideFileKey(tabOf('decks/deck.pptx')), { chrome: previewChrome })
    )
  );
  assert.ok(previewHeader.includes('class="browser-tab-select" title="decks/deck.pptx"'));
});

test('side file second row hides language first, then the cursor; counts stay', async () => {
  const L = await import('./side-file-status-layout.ts');
  const base = L.SIDE_STATUS_PADDING + L.SIDE_STATUS_PATH_MIN_WIDTH + L.SIDE_STATUS_PROBLEMS_WIDTH;
  assert.deepEqual(L.sideStatusLayout(500), { cursor: true, language: true });
  assert.deepEqual(L.sideStatusLayout(280), { cursor: true, language: true });
  const full = base + L.SIDE_STATUS_CURSOR_WIDTH + L.SIDE_STATUS_LANGUAGE_WIDTH;
  assert.deepEqual(L.sideStatusLayout(full), { cursor: true, language: true });
  assert.deepEqual(L.sideStatusLayout(full - 1), { cursor: true, language: false });
  assert.deepEqual(L.sideStatusLayout(base + L.SIDE_STATUS_CURSOR_WIDTH - 1), { cursor: false, language: false });
  assert.deepEqual(L.sideStatusLayout(0), { cursor: true, language: true });
  assert.equal(L.SIDE_STATUS_TOGGLE_WIDTH, undefined);
});

test('browser nav row hides Forward first, then Import; Back, Reload and the address always stay', async () => {
  const { browserNavLayout, BROWSER_NAV_PADDING, BROWSER_NAV_SLOT_WIDTH, BROWSER_NAV_ADDRESS_MIN_WIDTH } = await import(
    './browser-nav-layout.ts'
  );
  const base = BROWSER_NAV_PADDING + 2 * BROWSER_NAV_SLOT_WIDTH + BROWSER_NAV_ADDRESS_MIN_WIDTH;
  assert.deepEqual(browserNavLayout(500, true), { forward: true, import: true });
  assert.deepEqual(browserNavLayout(280, true), { forward: true, import: true });
  // Narrowing: Forward goes first...
  assert.deepEqual(browserNavLayout(base + BROWSER_NAV_SLOT_WIDTH * 2 - 1, true), { forward: false, import: true });
  // ...then Import.
  assert.deepEqual(browserNavLayout(base + BROWSER_NAV_SLOT_WIDTH - 1, true), { forward: false, import: false });
  assert.deepEqual(browserNavLayout(120, true), { forward: false, import: false });
  // Without an import source Forward only needs one extra slot.
  assert.deepEqual(browserNavLayout(base + BROWSER_NAV_SLOT_WIDTH, false), { forward: true, import: false });
  assert.deepEqual(browserNavLayout(0, true), { forward: true, import: true });
});

test('expanded surfaces stay inside the main panel frame (no overlap of its border pixels)', async () => {
  const { expandedDockRect, expandedSheetBounds, expandedSurfaceRect } = await import('./surface-slots.ts');
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  const { restore, dom } = installTestDom(null, {
    html: '<!doctype html><html><body><div class="app-shell"><div class="main-panel"><div id="h"></div></div></div></body></html>',
    expose: ['Element'],
  });
  try {
    dom.window.matchMedia = () => ({ matches: true });
    const panel = document.querySelector('.main-panel');
    // Border box 304..1314 x 36..783: the frame occupies the outer 1px on top / right / bottom.
    panel.getBoundingClientRect = () => ({ left: 304, top: 36, width: 1010, height: 747, right: 1314, bottom: 783 });
    // Measured while the panel has NO border yet (dock mode): the constant inset still applies.
    panel.style.border = '0';
    assert.deepEqual(expandedSheetBounds(panel), { left: 304, top: 37, width: 1009, bottom: 782 });
    assert.deepEqual(expandedDockRect(document.getElementById('h')), { left: 304, top: 37, width: 1009, height: 745 });
    const rect = expandedSurfaceRect(document.getElementById('h'), true, { header: null });
    assert.ok(rect.left >= 304 && rect.left + rect.width <= 1313 && rect.top >= 37 && rect.top + rect.height <= 782);
    // Folded sidebar: the left border belongs to the panel's frame too.
    document.querySelector('.app-shell').classList.add('sidebar-collapsed');
    assert.deepEqual(expandedSheetBounds(panel), { left: 305, top: 37, width: 1008, bottom: 782 });
    // Phone / narrow layouts have no frame.
    dom.window.matchMedia = () => ({ matches: false });
    assert.deepEqual(expandedSheetBounds(panel), { left: 304, top: 36, width: 1010, bottom: 783 });
  } finally {
    restore();
  }
});

// Mounts a dock in jsdom with pointer capture stubbed, so the panel's resize
// handle runs its real preview/cancel/commit gesture.
function mountResizableDock({ stored = {}, cellWidth = 0, pointerType = 'mouse' } = {}) {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MouseEvent'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  for (const [key, value] of Object.entries(stored)) dom.window.localStorage.setItem(key, String(value));
  const captured = new Set();
  const proto = dom.window.Element.prototype;
  proto.setPointerCapture = (id) => {
    captured.add(`${id}`);
  };
  proto.hasPointerCapture = (id) => captured.has(`${id}`);
  proto.releasePointerCapture = (id) => captured.delete(`${id}`);
  const host = document.getElementById('root');
  let width = cellWidth;
  Object.defineProperty(host, 'clientWidth', { configurable: true, get: () => width });
  const pointer = (type, clientX) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    return event;
  };
  const handle = () => document.querySelector('.workbench-side-panel-resize');
  const renderedWidth = () =>
    document.querySelector('.workbench-side-panel')?.style.getPropertyValue('--workbench-side-panel-width');
  return {
    dom,
    restore,
    root: createRoot(host),
    setCellWidth: (next) => {
      width = next;
    },
    renderedWidth,
    stored: (key) => dom.window.localStorage.getItem(key),
    down: (x) => act(async () => handle().dispatchEvent(pointer('pointerdown', x))),
    move: (x) => act(async () => handle().dispatchEvent(pointer('pointermove', x))),
    up: (x) => act(async () => handle().dispatchEvent(pointer('pointerup', x))),
    cancel: () => act(async () => dom.window.dispatchEvent(new dom.window.Event('blur'))),
    escape: () =>
      act(async () =>
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      ),
  };
}

const PANEL_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-width.v2';
const DIFF_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-diff-width.v1';

function resizableDockProps(entry, groups = [['source-control'], ['browser'], ['terminal']]) {
  const Icon = () => React.createElement('span');
  return {
    leafId: 'pane-1',
    groups,
    descriptors: new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]),
    focused: true,
    onSelect() {},
    onClose() {},
    onCloseDiff() {},
    onMoveGroup() {},
    onMoveView() {},
    onFocusPane() {},
    openFileTab() {},
    renderBrowserSurface: () => React.createElement('div', { 'data-testid': 'browser' }),
    renderTerminalSurface: () => React.createElement('div', { 'data-testid': 'terminal' }),
    renderView: () => React.createElement('div', { 'data-testid': 'view' }),
    entry,
  };
}

test('panel resize (rendered): preview applies live, commit persists the one shared width for every surface', async () => {
  const dock = mountResizableDock({ stored: { [PANEL_WIDTH_KEY]: 500, [DIFF_WIDTH_KEY]: 700 } });
  try {
    const panel = { ...closed(), open: true };
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(panel))));
    assert.equal(dock.renderedWidth(), '500px');
    await dock.down(1000);
    await dock.move(950);
    assert.equal(dock.renderedWidth(), '550px', 'preview applies the dragged width');
    assert.equal(dock.stored(PANEL_WIDTH_KEY), '500', 'preview never persists');
    await dock.up(950);
    assert.equal(dock.renderedWidth(), '550px');
    assert.equal(dock.stored(PANEL_WIDTH_KEY), '550', 'commit persists the panel preference');
    assert.equal(dock.stored(DIFF_WIDTH_KEY), '700', 'the diff width is independent');
    // The terminal opens at the width the panel was resized to, and resizing it
    // changes what the browser opens at next.
    const terminal = { ...panel, surface: 'terminal' };
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(terminal))));
    assert.equal(dock.renderedWidth(), '550px');
    await dock.down(1000);
    await dock.move(960);
    await dock.up(960);
    assert.equal(dock.stored(PANEL_WIDTH_KEY), '590');
    const browser = { ...panel, surface: 'browser' };
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(browser))));
    assert.equal(dock.renderedWidth(), '590px');
    assert.equal(dock.stored(DIFF_WIDTH_KEY), '700');
  } finally {
    await act(async () => dock.root.unmount());
    dock.restore();
  }
});

test('panel resize (rendered): Escape cancels the drag and restores the size it started at', async () => {
  const dock = mountResizableDock({ stored: { [PANEL_WIDTH_KEY]: 500 }, cellWidth: 2_000 });
  try {
    const open = { ...closed(), open: true };
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(open))));
    await dock.down(1000);
    await dock.move(1100);
    assert.equal(dock.renderedWidth(), '400px', 'preview applies');
    await dock.escape();
    assert.equal(dock.renderedWidth(), '500px');
    assert.equal(dock.stored(PANEL_WIDTH_KEY), '500', 'cancel never persists');
  } finally {
    await act(async () => dock.root.unmount());
    dock.restore();
  }
});

test('panel resize (rendered): cancel restores the stored preference, not the constrained rendered width', async () => {
  // room = 764 - 360 (workspace floor) - 4 (sheet frame) = 400 < the stored 500.
  const dock = mountResizableDock({ stored: { [PANEL_WIDTH_KEY]: 500 }, cellWidth: 764 });
  try {
    const open = { ...closed(), open: true };
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(open))));
    assert.equal(dock.renderedWidth(), '400px', 'rendered width is constrained by the cell');
    await dock.down(1000);
    await dock.move(1100);
    assert.equal(dock.renderedWidth(), '300px', 'preview applies');
    await dock.cancel();
    assert.equal(dock.renderedWidth(), '400px');
    assert.equal(dock.stored(PANEL_WIDTH_KEY), '500', 'cancel never persists');
    // Widen the cell (re-measured on reopen): the restored preference is the
    // stored 500, not the 400 that was rendered when the gesture began.
    dock.setCellWidth(2_000);
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(closed()))));
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(open))));
    assert.equal(dock.renderedWidth(), '500px');
  } finally {
    await act(async () => dock.root.unmount());
    dock.restore();
  }
});

test('a 1160 stored width in a narrow window still leaves the conversation its floor', async () => {
  // room = 764 - 360 (workspace floor) - 4 (sheet frame) = 400.
  const dock = mountResizableDock({ stored: { [PANEL_WIDTH_KEY]: 1160 }, cellWidth: 764 });
  try {
    const open = { ...closed(), open: true };
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(open))));
    assert.equal(dock.renderedWidth(), '400px');
  } finally {
    await act(async () => dock.root.unmount());
    dock.restore();
  }
});

// Module-level so its identity is stable; holds an unsaved buffer in state.
function DirtyFileStub({ rel, active, side }) {
  const [edits, setEdits] = React.useState(0);
  React.useEffect(() => {
    side.onChrome({
      editable: true,
      dirty: edits > 0,
      saving: false,
      save() {},
      reveal() {},
      cursor: { short: 'Ln 1, Col 1', label: 'Ln 1, Col 1', onGoto() {} },
    });
  }, [side.onChrome, edits]);
  return React.createElement(
    'div',
    { 'data-testid': `editor-${rel}`, 'data-active': active ? 'true' : 'false', 'data-edits': String(edits) },
    React.createElement('button', {
      type: 'button',
      'data-testid': `edit-${rel}`,
      onClick: () => setEdits((n) => n + 1),
    }),
    React.createElement('button', { type: 'button', 'data-testid': `problems-${rel}`, onClick: side.onShowProblems })
  );
}

test('file surface (rendered): header → editor → problems → footer, hidden editors keep their buffers', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MouseEvent'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const Icon = () => React.createElement('span');
  let entry = withPaneDockFileOpened(closed(), fileLink, 1, { now: 1 });
  entry = withPaneDockFileOpened(entry, { project: 'C:/p', rel: 'src/b.ts' }, 2, { now: 2 });
  const aKey = sideFileKey(fileLink);
  const props = (next) => ({
    leafId: 'pane-1',
    groups: [['source-control']],
    descriptors: new Map([['source-control', { id: 'source-control', label: 'Source Control', icon: Icon }]]),
    focused: true,
    onSelect() {},
    onClose() {},
    onCloseDiff() {},
    onMoveGroup() {},
    onMoveView() {},
    onFocusPane() {},
    openFileTab() {},
    renderFileSurface: (file, active, side) => React.createElement(DirtyFileStub, { rel: file.rel, active, side }),
    renderFileProblems: (file) => React.createElement('div', { 'data-testid': 'side-problems' }, file.rel),
    renderView: () => null,
    entry: next,
  });
  const root = createRoot(document.getElementById('root'));
  const editor = (rel) => document.querySelector(`[data-testid="editor-${rel}"]`);
  try {
    await act(async () => root.render(React.createElement(PaneSideDock, props(entry))));
    await act(async () => document.querySelector('[data-testid="edit-src/b.ts"]').click());
    await act(async () => document.querySelector('[data-testid="problems-src/b.ts"]').click());
    const card = document.querySelector('.workbench-side-surface-slot');
    assert.equal(card.dataset.surfaceActive, 'true');
    assert.deepEqual(
      [...card.children].map((child) => child.className.split(' ')[0]),
      ['dock-header-row', 'pane-side-file-body', 'side-file-status-row'],
      'header, body, footer last'
    );
    assert.ok(card.children[0].classList.contains('side-file-header'));
    const body = card.querySelector('.pane-side-file-body');
    assert.deepEqual(
      [...body.children].map((child) => child.className.split(' ')[0]),
      ['pane-side-file-editor', 'pane-side-file-problems']
    );
    assert.equal(body.querySelector('[data-testid="side-problems"]').textContent, 'src/b.ts');
    // One mounted editor per tab; only the active one shows and is active.
    const tabs = [...body.querySelectorAll('.pane-side-file-editor > .pane-side-file-tab')];
    assert.deepEqual(
      tabs.map((tab) => tab.hidden),
      [true, false]
    );
    assert.equal(editor('src/a.ts').dataset.active, 'false');
    assert.equal(editor('src/b.ts').dataset.active, 'true');
    // Switching tabs hides — never unmounts — the dirty editor.
    const dirty = editor('src/b.ts');
    await act(async () => root.render(React.createElement(PaneSideDock, props({ ...entry, activeFile: aKey }))));
    assert.equal(editor('src/b.ts'), dirty, 'same mounted editor');
    assert.equal(dirty.dataset.edits, '1', 'unsaved buffer survives');
    assert.equal(dirty.closest('.pane-side-file-tab').hidden, true);
    assert.equal(editor('src/a.ts').dataset.active, 'true');
    // Folding to the panel view hides the card but keeps every editor mounted.
    await act(async () => root.render(React.createElement(PaneSideDock, props({ ...entry, surface: '' }))));
    const hiddenCard = document.querySelector('.workbench-side-surface-slot');
    assert.equal(hiddenCard.dataset.surfaceActive, 'false');
    assert.equal(hiddenCard.getAttribute('aria-hidden'), 'true');
    assert.equal(editor('src/b.ts'), dirty);
    assert.equal(dirty.dataset.edits, '1');
    assert.equal(editor('src/b.ts').dataset.active, 'false');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

// ── Phone header (behavioural) ──
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

function mountPhoneDock() {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    globals: { navigator: { userAgent: PHONE_UA, platform: 'iPhone', maxTouchPoints: 5 } },
    expose: ['Element', 'HTMLElement', 'Node', 'MutationObserver'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  return { dom, restore, root: createRoot(document.getElementById('root')) };
}

const phoneDescriptors = () => {
  const Icon = () => React.createElement('span');
  return new Map(
    ['source-control', 'browser', 'terminal', 'pull-requests'].map((id) => [
      id,
      { id, label: id[0].toUpperCase() + id.slice(1), icon: Icon },
    ])
  );
};

function phoneDockProps(leafId, extra) {
  return {
    leafId,
    groups: [['source-control'], ['browser'], ['terminal'], ['pull-requests']],
    descriptors: phoneDescriptors(),
    onSelect() {},
    onClose() {},
    onCloseDiff() {},
    onMoveGroup() {},
    onMoveView() {},
    onFocusPane() {},
    openFileTab() {},
    renderView: () => null,
    entry: { ...closed(), open: true },
    ...extra,
  };
}

const headerOf = (leafId) => document.querySelector(`[data-pane-id="${leafId}"] .dock-header-row`);
async function openMore(leafId) {
  await act(async () => headerOf(leafId).querySelector('.dock-header-more').click());
  return [...document.querySelectorAll('.dock-header-menu button')];
}
const menuItem = (items, label) => items.find((button) => button.textContent === label);

test('phone header: only the focused pane drives the ⋯ switch, never a hidden pane with a draft', async () => {
  const { root, restore } = mountPhoneDock();
  const selected = [];
  const panes = (focusedLeaf) =>
    React.createElement(
      React.Fragment,
      null,
      // Pane A has a session; pane B is an unfocused New Task draft.
      React.createElement(PaneSideDock, {
        ...phoneDockProps('A', { focused: focusedLeaf === 'A', sessionBound: true }),
        onSelect: (id) => selected.push(['A', id]),
      }),
      React.createElement(PaneSideDock, {
        ...phoneDockProps('B', { focused: focusedLeaf === 'B', sessionBound: false }),
        onSelect: (id) => selected.push(['B', id]),
      })
    );
  try {
    await act(async () => root.render(panes('A')));
    let items = await openMore('A');
    assert.equal(menuItem(items, 'Terminal').disabled, false, 'the hidden draft pane must not disable Terminal');
    assert.equal(menuItem(items, 'Source-control').disabled, true, 'the showing pane is listed, not selectable');
    await act(async () => menuItem(items, 'Browser').click());
    assert.deepEqual(selected, [['A', 'browser']]);

    // Focus moves to the draft pane: the store follows it, with nothing left from A.
    await act(async () => root.render(panes('B')));
    items = await openMore('B');
    assert.equal(menuItem(items, 'Terminal').disabled, true, 'the focused draft pane disables Terminal');
    assert.equal(menuItem(items, 'Browser').disabled, true, 'session-bound views are inert in the draft');
    await act(async () => menuItem(items, 'Pull-requests').click());
    assert.deepEqual(
      selected,
      [
        ['A', 'browser'],
        ['B', 'pull-requests'],
      ],
      'the menu now acts on the focused pane B'
    );

    // No focused pane: no stale switch entries, so neither header has a ⋯.
    await act(async () => root.render(panes('none')));
    assert.equal(document.querySelectorAll('.dock-header-more').length, 0);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('phone Changes panel: shared header with ⋯ switching and a × that closes the panel', async () => {
  const { root, restore } = mountPhoneDock();
  const selected = [];
  function Harness() {
    const [entry, setEntry] = React.useState({
      ...closed(),
      open: true,
      surface: 'diff',
      diff: diffA,
    });
    return React.createElement(PaneSideDock, {
      ...phoneDockProps('A', { focused: true, sessionBound: true, entry }),
      onSelect: (id) => selected.push(id),
      onClose: () => setEntry((current) => ({ ...current, open: false })),
    });
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const header = headerOf('A');
    assert.ok(header, 'the Changes panel draws the shared header on the phone');
    assert.equal(header.getAttribute('aria-label'), 'Changes');
    assert.equal(header.querySelector('.browser-tab-select')?.textContent, 'a.ts');
    const items = await openMore('A');
    await act(async () => menuItem(items, 'Terminal').click());
    assert.deepEqual(selected, ['terminal'], '⋯ switches the pane');
    await act(async () => headerOf('A').querySelector('.dock-header-close').click());
    assert.equal(headerOf('A'), null, '× closes the panel');
    assert.equal(document.querySelector('[data-pane-id="A"]').getAttribute('data-open'), 'false');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('phone Changes view lists no Profile after the profile was shown', async () => {
  const { root, restore } = mountPhoneDock();
  const Icon = () => React.createElement('span');
  const descriptors = new Map([
    ['routines', { id: 'routines', label: 'Profile', icon: Icon }],
    ['session-diff', { id: 'session-diff', label: 'Changes', icon: Icon }],
    ['terminal', { id: 'terminal', label: 'Terminal', icon: Icon }],
  ]);
  const resetAction = [{ id: 'agent-reset', label: 'Reset conversation', icon: Icon, onSelect() {} }];
  function ProfileStub({ active }) {
    usePublishDockPanelActions('A', active, resetAction);
    return null;
  }
  const renderView = (id, active) => {
    if (id === 'routines') return React.createElement(ProfileStub, { active });
    // The Changes view draws its own shared header, as SessionDiffPane does.
    if (id === 'session-diff') {
      return React.createElement(DockHeaderRow, { left: 'Changes', ariaLabel: 'Changes', actions: [] });
    }
    return null;
  };
  const dock = (entry, groups) =>
    React.createElement(PaneSideDock, {
      ...phoneDockProps('A', { focused: true, sessionBound: true, entry, groups, descriptors, renderView }),
    });
  // A coding session's right side never holds the home thread's Profile.
  const codingGroups = [['session-diff'], ['terminal']];
  const labels = (items) => items.map((button) => button.textContent);
  try {
    // A home thread showed its Profile (its ⋯ actions are published) ...
    await act(async () =>
      root.render(dock({ ...closed('routines'), open: true }, [['routines'], ['session-diff'], ['terminal']]))
    );
    assert.ok(labels(await openMore('A')).includes('Reset conversation'));
    await act(async () => document.body.click());
    // ... then the pane's session is a coding one showing Changes.
    await act(async () => root.render(dock({ ...closed('session-diff'), open: true }, codingGroups)));
    const items = labels(await openMore('A'));
    assert.equal(items.includes('Profile'), false, 'no Profile entry in the Changes header');
    assert.equal(items.includes('Reset conversation'), false, 'no stale Profile action either');
    assert.equal(items.includes('Terminal'), true);
    await act(async () => document.body.click());
    // The changes card of a home thread opens a diff over the Profile view.
    const home = [['routines'], ['session-diff'], ['terminal']];
    await act(async () =>
      root.render(
        dock({ ...closed('routines'), open: true, surface: 'diff', diff: { ...diffA, source: 'session' } }, home)
      )
    );
    const diffItems = await openMore('A');
    assert.equal(menuItem(diffItems, 'Profile').disabled, false, 'Profile is a target, not the showing pane');
    assert.equal(menuItem(diffItems, 'Changes').disabled, true, 'Changes is the showing pane');
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

// A PNG tapped in the transcript, an attachment chip or the Changes list opens
// as a side-dock file tab while the pane's view is still Changes.
const pngFile = { project: 'C:/p', rel: 'shots/Screenshot 2025-10-18.png' };
function pngDockProps() {
  const Icon = () => React.createElement('span');
  return phoneDockProps('A', {
    focused: true,
    sessionBound: true,
    groups: [['session-diff'], ['terminal']],
    descriptors: new Map([
      ['session-diff', { id: 'session-diff', label: 'Changes', icon: Icon }],
      ['terminal', { id: 'terminal', label: 'Terminal', icon: Icon }],
    ]),
    entry: withPaneDockFileOpened(closed('session-diff'), pngFile, 1, { now: 1 }),
    renderFileSurface: (file, _active, side) => React.createElement(SideFileStub, { rel: file.rel, side }),
  });
}

test('phone sheet: a PNG opened beside Changes is headed by its file name, Changes stays in ⋯', async () => {
  const { root, restore } = mountPhoneDock();
  try {
    await act(async () => root.render(React.createElement(PaneSideDock, pngDockProps())));
    const header = document.querySelector('[data-pane-id="A"] .side-file-header');
    assert.equal(header.querySelector('[data-side-leading-tab]'), null, 'no Changes chip ahead of the file');
    assert.deepEqual(
      [...header.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      ['Screenshot 2025-10-18.png']
    );
    assert.equal(header.querySelector('.dock-header-left').textContent, 'Screenshot 2025-10-18.png');
    // The way back to Changes is the shared pane switch.
    const items = await openMore('A');
    assert.equal(menuItem(items, 'Changes').disabled, false);
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('desktop dock: the Changes tab still leads the file tabs', async () => {
  const { dom, restore } = installTestDom(null, {
    html: '<!doctype html><html><body><main id="root"></main></body></html>',
    expose: ['navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver'],
  });
  dom.window.requestAnimationFrame = (callback) => {
    callback(16);
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(PaneSideDock, pngDockProps())));
    const header = document.querySelector('[data-pane-id="A"] .side-file-header');
    assert.deepEqual(
      [...header.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent),
      ['Changes', 'Screenshot 2025-10-18.png']
    );
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('panel resize (rendered): a touch drag on the handle previews and commits like the mouse', async () => {
  const dock = mountResizableDock({ stored: { [PANEL_WIDTH_KEY]: 400 }, pointerType: 'touch' });
  try {
    const panel = { ...closed(), open: true };
    await act(async () => dock.root.render(React.createElement(PaneSideDock, resizableDockProps(panel))));
    await dock.down(1000);
    await dock.move(920);
    assert.equal(dock.renderedWidth(), '480px', 'the finger drags the edge live');
    assert.equal(dock.stored(PANEL_WIDTH_KEY), '400', 'preview never persists');
    await dock.up(920);
    assert.equal(dock.stored(PANEL_WIDTH_KEY), '480', 'lifting the finger commits');
  } finally {
    await act(async () => dock.root.unmount());
    dock.restore();
  }
});
