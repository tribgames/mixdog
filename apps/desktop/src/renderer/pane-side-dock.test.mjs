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
  paneDiffShowing,
  samePaneSideDocks,
  withPaneDockDiffClosed,
  withPaneDockDiffOpened,
  withPaneDockFileClosed,
  withPaneDockFileOpened,
} from './pane-side-dock.tsx';
import { sessionSideDockEntryForSession } from './session-side-surface-policy.ts';
import { sideFileKey } from './side-file-tabs.ts';

// The formatter wraps long selectors across lines; compare them as single-spaced text.
const flattenCss = (css) =>
  css
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')');

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
    await act(async () =>
      document.querySelector('.side-file-header .browser-tab-close').click()
    );
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

test('every side-dock surface draws exactly one shared DockHeaderRow, no inner header row', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');
  const count = (source, pattern) => source.match(pattern)?.length ?? 0;
  const surfaces = {
    // [source that owns the row, inner header rows that must not exist]
    file: ['./side-surface-strip.tsx', /<header|editor-breadcrumbs/g],
    browser: ['./BrowserPane.lazy.tsx', /<header/g],
    terminal: ['./SessionTerminalTabs.tsx', /<header/g],
  };
  for (const [name, [file, inner]] of Object.entries(surfaces)) {
    const source = await read(file);
    assert.equal(count(source, /<DockHeaderRow/g), 1, `${name}: exactly one header row`);
    assert.equal(count(source, inner), 0, `${name}: no second header row`);
  }
  // Tabs live in the row's left slot; the strip draws no row of its own.
  assert.match(await read('./BrowserTabStrip.tsx'), /className="browser-tab-toolbar"/);
  assert.doesNotMatch(await read('./BrowserTabStrip.tsx'), /Maximize2|onToggleExpanded/);
  // The dock draws the diff/panel row only; the legacy title row is phone-only.
  const dock = await read('./pane-side-dock.tsx');
  assert.match(dock, /!mobileSheet && openNow && !sessionSurfaceShowing/);
  assert.match(dock, /headerShowing && mobileSheet/);
  assert.match(dock, /renderDiffHeaderControls\?: \(\) => ReactNode/);
  assert.match(dock, /t\('Changes'\)/);
  // Diff in side chrome returns before its own <header>, and the dock passes it.
  const diff = await read('./GitDiffPane.tsx');
  assert.ok(diff.indexOf("chrome === 'side'") < diff.indexOf('<header className="workspace-git-diff-header"'));
  assert.match(await read('./pane-side-dock.tsx'), /chrome="side"/);
  assert.doesNotMatch(await read('./pane-side-dock.tsx'), /pane-dock-diff-back/);
  // The editor drops its breadcrumb row whenever the dock hosts it.
  assert.match(await read('./EditorPane.lazy.tsx'), /const editorBreadcrumbs = onSideChrome \? null :/);
});

test('mobile always stacks the visible diff so Goal has a visible DIFF anchor', () => {
  assert.equal(paneDiffStacks(true, 1_200, 640, true), true);
  assert.equal(paneDiffStacks(true, 1_200, 640, false), false);
  assert.equal(paneDiffStacks(true, 500, 640, false), true);
  assert.equal(paneDiffStacks(false, 500, 640, true), false);
});

test('a cold pane dock paints its open shell before mounting the heavy body', async () => {
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
    assert.equal(document.querySelector('[data-testid="heavy-dock-body"]'), null);
    assert.equal(pendingFrames.size, 1);

    await act(async () => {
      const callbacks = [...pendingFrames.values()];
      pendingFrames.clear();
      callbacks.forEach((callback) => {
        callback(16);
      });
    });
    assert.ok(document.querySelector('[data-testid="heavy-dock-body"]'));
  } finally {
    await act(async () => root.unmount());
    restore();
  }
});

test('stacked side surfaces are opaque (Mica-proof) and hide the panel body beneath', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');
  const css = await read('./pane-layout.css');
  const slot = css.match(/\.workbench-side-surface-slot \{[^}]*\}/)[0];
  // Mica clears --mx-workspace-sheet inside .workbench-side-panel; the root's
  // solid copy --mx-sheet-ink is what keeps the slot opaque there.
  assert.match(slot, /background: var\(--mx-sheet-ink, var\(--mx-workspace-sheet\)\)/);
  assert.match(
    await read('./desktop/03-titlebar.css'),
    /\.workbench-side-panel,[^{]*\{[^}]*--mx-workspace-sheet: transparent/
  );
  const layout = await read('./workbench-side-view-layout.tsx');
  assert.match(layout, /style=\{selected && surfacesActive \? \{ visibility: 'hidden' \} : undefined\}/);
  assert.match(layout, /inert=\{!selected \|\| surfacesActive \? true : undefined\}/);
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

test('a :line:column link keeps its column through the dock and reveal', async () => {
  const { readFile } = await import('node:fs/promises');
  const stored = JSON.parse(
    JSON.stringify({ 'pane-1': withPaneDockFileOpened(closed(), { ...fileLink, column: 3 }, 9) })
  );
  const restored = normalizePaneSideDocks(stored, ['pane-1'], RIGHT, false);
  assert.equal(restored['pane-1'].files[0].column, 3);
  const editor = await readFile(new URL('./EditorPane.lazy.tsx', import.meta.url), 'utf8');
  assert.match(editor, /editor\.setPosition\(\{ lineNumber: reveal\.line, column \}\)/);
  assert.match(await readFile(new URL('./app-shell-side-dock.tsx', import.meta.url), 'utf8'), /column: file\.column/);
});

test('document page slots keep their aspect ratio instead of shrinking in the flex column', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./desktop/26-editor.css', import.meta.url), 'utf8');
  const rule = css.match(/\.editor-pane-document-page \{[^}]*\}/)[0];
  assert.match(rule, /flex: none;/);
  assert.match(rule, /overflow: hidden;/);
});

test('default widths: file/browser/diff 500, terminal 280 with its own stored width', async () => {
  const dock = await import('./pane-side-dock.tsx');
  assert.equal(dock.PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH, 500);
  assert.equal(dock.PANE_SIDE_DOCK_BROWSER_DEFAULT_WIDTH, 500);
  assert.equal(dock.PANE_SIDE_DOCK_TERMINAL_DEFAULT_WIDTH, 280);
  // Every surface floors at the same 280px.
  assert.equal(dock.PANE_SIDE_DOCK_MIN_WIDTH, 280);
  for (const min of [
    dock.PANE_SIDE_DOCK_TERMINAL_MIN_WIDTH,
    dock.PANE_SIDE_DOCK_BROWSER_MIN_WIDTH,
    dock.PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
  ])
    assert.equal(min, 280);
  // The user-resized width wins over the default, clamped to the limits.
  const store = new Map([
    ['k', '640'],
    ['small', '10'],
  ]);
  const previous = globalThis.window;
  globalThis.window = { localStorage: { getItem: (key) => store.get(key) ?? null } };
  try {
    assert.equal(dock.readStoredWidth('k', 320, 1160, 500), 640);
    assert.equal(dock.readStoredWidth('small', 240, 1160, 280), 240);
    assert.equal(dock.readStoredWidth('none', 240, 1160, 280), 280);
  } finally {
    globalThis.window = previous;
  }
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./pane-side-dock.tsx', import.meta.url), 'utf8');
  assert.match(source, /pane-side-dock-terminal-width\.v1/);
  assert.match(source, /terminalShowing \? terminalPref : browserPref/);
});

test('joined surface: one continuous sheet with single dividers and outer-only radii', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = flattenCss(await readFile(new URL('./pane-layout.css', import.meta.url), 'utf8'));
  const block = css.slice(css.indexOf('/* ── Sheet framing (desktop) ──'));
  assert.match(block, /--mx-dock-header-height: 44px;/);
  assert.match(block, /--mx-sheet-gap: 2px;/);
  assert.match(block, /--mx-sheet-radius: 10px;/);
  assert.match(block, /--mx-sheet-surface: var\(--mx-sheet-ink, var\(--mx-workspace-sheet\)\);/);
  assert.match(block, /@media \(min-width: 761px\)/);
  const scope = ':root:not\\(\\[data-mixdog-mobile-tabs\\]\\)';
  const esc = (s) => s.replace(/[.[\]()>:="*+|]/g, '\\$&');
  const rule = (selector) => block.match(new RegExp(scope + ' ' + esc(selector) + ' \\{([^}]*)\\}'))?.[1] ?? '';
  const flat = (body) => {
    assert.match(body, /margin: 0;/);
    assert.match(body, /border: 0;/);
    assert.match(body, /border-radius: 0;/);
  };
  // Left panel: leftmost element. Gap on left and bottom only; its right border IS the divider.
  const left = rule('.workbench-side-panel[data-side="left"]');
  assert.match(left, /height: calc\(100% - var\(--mx-sheet-gap\)\)/);
  assert.match(left, /margin: 0 0 var\(--mx-sheet-gap\) var\(--mx-sheet-gap\);/);
  assert.match(left, /border: 1px solid var\(--mx-border\);/);
  assert.match(left, /border-radius: var\(--mx-sheet-radius\) 0 0 var\(--mx-sheet-radius\);/);
  // Workspace: .main-panel owns the outer top/right/bottom edge and the right corners; no left
  // border while the panel is open (single divider), left edge + all corners once it is folded.
  const main = rule('.main-panel');
  assert.match(main, /margin: 0 var\(--mx-sheet-gap\) var\(--mx-sheet-gap\) 0;/);
  assert.match(main, /border: 1px solid var\(--mx-border\);\s*\/\*[^*]*\*\/\s*border-left: 0;/);
  assert.match(main, /border-radius: 0 var\(--mx-sheet-radius\) var\(--mx-sheet-radius\) 0;/);
  assert.match(main, /box-shadow: none;/);
  const folded = rule('.app-shell.sidebar-collapsed .main-panel');
  assert.match(folded, /margin-left: var\(--mx-sheet-gap\);/);
  assert.match(folded, /border-left: 1px solid var\(--mx-border\);/);
  assert.match(folded, /border-radius: var\(--mx-sheet-radius\);/);
  // The rail stays flat.
  assert.match(
    block,
    /\.app-shell \.activity-rail,[^{]*\.app-shell\.sidebar-collapsed \.activity-rail \{\s*border-right-color: transparent;/
  );
  // Cell rows have no borders, gaps or radii of their own.
  const rows = block.match(
    new RegExp(
      scope +
        ' \\.pane-cell > \\.workspace-tabs-shell,[^{]*\\.pane-surface-stack,[^{]*\\.pane-footer-slot \\{([^}]*)\\}'
    )
  )[1];
  flat(rows);
  assert.doesNotMatch(block, /pane-cell > \.workspace-tabs-shell \{[^}]*border-radius: var\(--mx-sheet-radius\)/);
  // Split cells meet on the handle's single hairline; hover / drag keeps the accent.
  assert.match(rule('.pane-resize-handle::after'), /background: var\(--mx-border\);/);
  assert.match(rule('.pane-resize-handle:is(:hover, .is-dragging)::after'), /background: var\(--mx-focus\);/);
  // The dock is a separate floating sheet again: own border + radius, a 4px gap from the workspace
  // sheet on its left; the window-edge and bottom gaps come from .main-panel's margins.
  const open = block.match(new RegExp(scope + ' \\.pane-side-dock\\[data-open="true"\\] \\{([^}]*)\\}'))[1];
  assert.match(open, /border: 1px solid var\(--mx-border\);/);
  assert.match(open, /border-radius: var\(--mx-sheet-radius\);/);
  assert.match(open, /background: var\(--mx-sheet-surface\);/);
  const INL = '.pane-side-dock[data-open="true"]:not([data-overlay="true"]):not([data-expanded="true"])';
  const inline = block.match(new RegExp(scope + ' ' + esc(INL) + ' \\{([^}]*)\\}'))[1];
  assert.match(inline, /margin: 0 0 0 var\(--mx-sheet-gap\);/);
  assert.match(inline, /box-shadow: none;/);
  assert.doesNotMatch(inline, /border/);
  // Overlay keeps the sheet look (inset, border, radius) plus its shadow.
  assert.match(css, /\.pane-side-dock\[data-overlay="true"\] \{[^}]*box-shadow: var\(--mx-overlay\);/);
  // The main panel's frame must not wrap an open inline dock: it drops its border and radius, and
  // each pane cell draws its own sheet frame, closing the right side (border + corners) at the dock.
  const SURFACE_EXPANDED = ':not\\(:has\\([^{]*?data-expanded="true"\\]\\)\\)';
  const unframed = block.match(
    new RegExp(scope + SURFACE_EXPANDED + ' \\.main-panel:has\\(' + esc(INL) + '\\) \\{([^}]*)\\}')
  )[1];
  // An expanded browser/terminal lives on its own container, not on the dock's data-expanded: the
  // cells-draw-the-frame rules must step aside so the panel draws the single frame it is measured for.
  assert.doesNotMatch(block, new RegExp(scope + ' \\.main-panel:has\\(\\.pane-side-dock'));
  assert.match(unframed, /border: 0;\s*border-radius: 0;/);
  assert.match(block, /\.pane-cell:has\(> \.pane-side-dock\[data-open="true"\][^{]*\) \{\s*--open-right: 1;/);
  assert.match(block, /\.pane-cell::after \{[^}]*border-right-width: calc\(1px \* var\(--open-right\)\);/);
  assert.match(
    block,
    /calc\(var\(--mx-sheet-radius\) \* var\(--no-top\) \* var\(--open-right\)\)\s*calc\(var\(--mx-sheet-radius\) \* var\(--no-bottom\) \* var\(--open-right\)\)/
  );
  // Expanded: flush in .main-panel's content box. No border, margin or shadow; only the inner radius of
  // the main panel's outer corners (fixed boxes are not clipped by it): right corners, all when folded.
  const expandedDock = rule('.pane-side-dock[data-open="true"][data-expanded="true"]');
  assert.match(expandedDock, /margin: 0;\s*border: 0;/);
  assert.match(expandedDock, /box-shadow: none;/);
  assert.match(
    expandedDock,
    /border-radius: 0 calc\(var\(--mx-sheet-radius\) - 1px\) calc\(var\(--mx-sheet-radius\) - 1px\) 0;/
  );
  assert.doesNotMatch(expandedDock, /margin: 0 var|border: 1px/);
  for (const kind of ['terminal', 'browser']) {
    const box = block.match(
      new RegExp('session-' + kind + '-surface-container\\[data-expanded="true"\\](?:,[^{]*)? \\{([^}]*)\\}')
    )[1];
    assert.match(box, /border: 0;/);
    assert.match(box, /box-shadow: none;/);
  }
  assert.match(
    block,
    /:has\(\.app-shell\.sidebar-collapsed\) \.pane-side-dock\[data-open="true"\]\[data-expanded="true"\] \{\s*border-radius: calc\(var\(--mx-sheet-radius\) - 1px\);/
  );
  // No adjacent doubled borders remain between the cell parts.
  assert.doesNotMatch(block, /\.pane-cell:has\(> \.pane-footer-slot/);
  // The Mica 8px corner only applies to the narrow (non-joined) layout.
  const mica = await readFile(new URL('./desktop/03-titlebar.css', import.meta.url), 'utf8');
  assert.match(
    mica,
    /@media \(max-width: 760px\) \{\s*html\[data-window-material="mica"\] \.workbench-side-panel\[data-side="left"\],[^{]*\{\s*border-top-left-radius: 8px;/
  );
  // The column reserves the dock's gap and borders so the conversation floor holds.
  const dockSource = await readFile(new URL('./pane-side-dock.tsx', import.meta.url), 'utf8');
  // --mx-sheet-gap (2px) + the dock's two 1px borders.
  assert.match(dockSource, /PANE_SIDE_DOCK_SHEET_FRAME_WIDTH = 2 \+ 2;/);
  assert.match(dockSource, /DESKTOP_WORKSPACE_MIN_WIDTH - sheetFrame/);
});

test('joined surface: outer radii in every state (panel open|folded x dock open|closed, splits)', async () => {
  const { readFileSync } = await import('node:fs');
  const css = flattenCss(readFileSync(new URL('./pane-layout.css', import.meta.url), 'utf8'));
  // Reduce the sheet block to the declarations that decide borders and radii, then resolve them by
  // hand per state: the rightmost clip is .main-panel (dock or last cell sits inside it), the leftmost
  // is the left panel, or .main-panel once folded.
  const block = css.slice(css.indexOf('/* ── Sheet framing (desktop) ──'));
  const get = (selector, prop) =>
    block.match(new RegExp(selector.replace(/[.[\]()>:="*+|]/g, '\\$&') + ' \\{[^}]*?' + prop + ': ([^;]+);'))?.[1];
  const R = 'var(--mx-sheet-radius)';
  const panel = get(':root:not([data-mixdog-mobile-tabs]) .workbench-side-panel[data-side="left"]', 'border-radius');
  const mainOpen = get(':root:not([data-mixdog-mobile-tabs]) .main-panel', 'border-radius');
  const mainFolded = get(
    ':root:not([data-mixdog-mobile-tabs]) .app-shell.sidebar-collapsed .main-panel',
    'border-radius'
  );
  const corners = (radius) => {
    const v = radius.split(' ');
    const [tl, tr = tl, br = tl, bl = tr] = v.length === 1 ? [v[0]] : v;
    return { tl: tl !== '0', tr: tr !== '0', br: br !== '0', bl: bl !== '0' };
  };
  assert.deepEqual(corners(panel), { tl: true, tr: false, br: false, bl: true }, 'panel: left corners only');
  assert.deepEqual(
    corners(mainOpen),
    { tl: false, tr: true, br: true, bl: false },
    'workspace (panel open): right corners only'
  );
  assert.deepEqual(
    corners(mainFolded),
    { tl: true, tr: true, br: true, bl: true },
    'workspace (panel folded): all corners'
  );
  assert.equal(panel, R + ' 0 0 ' + R);
  // Dock open or closed never adds corners of its own: the inline dock and every cell row are square.
  // Dock open: the workspace cell keeps its own right corners (and border) where the dock follows;
  // the left corners need the folded sidebar and no left neighbour, so a joined split stays square inside.
  assert.match(
    block,
    /border-radius:\s*calc\(var\(--mx-sheet-radius\) \* var\(--no-top\) \* var\(--no-left\) \* var\(--folded\)\)/
  );
  assert.match(
    block,
    /:has\(\.app-shell\.sidebar-collapsed\):not\(:has\([^{]*\)\) \.main-panel:has\([^{]*\) \.pane-cell \{\s*--folded: 1;/
  );
  assert.match(block, /\.pane-split-row > \.pane-split-cell:last-child \.pane-cell \{\s*--no-left: 0;/);
  assert.match(block, /\.pane-split-row > \.pane-split-cell:first-child \.pane-cell \{\s*--open-right: 0;/);
  assert.match(block, /\.pane-split-column > \.pane-split-cell:last-child \.pane-cell \{\s*--no-top: 0;/);
  assert.match(block, /\.pane-split-column > \.pane-split-cell:first-child \.pane-cell \{\s*--no-bottom: 0;/);
  const rows = block.match(/\.pane-cell > \.workspace-tabs-shell,[^{]*\{([^}]*)\}/)[1];
  assert.match(rows, /border-radius: 0;/);
  // Split panes: cells are square rows divided by handles, so only .main-panel contributes outer corners.
  assert.doesNotMatch(block, /\.pane-split[^{]*\{[^}]*border-radius/);
  assert.match(css, /\.pane-side-dock\[data-overlay="true"\] \{\s*position: absolute;/);
  assert.match(
    css,
    /\.pane-side-dock\[data-expanded="true"\] \{\s*z-index: 40;\s*margin: 0;\s*box-shadow: var\(--mx-floating\);/
  );
});

test('the header row is as tall as the pane tab strip row and has no rule of its own', async () => {
  const { readFile } = await import('node:fs/promises');
  const strip = await readFile(new URL('./tab-strip.css', import.meta.url), 'utf8');
  const row = strip.match(/\.dock-header-row \{[^}]*\}/)[0];
  assert.match(row, /height: var\(--mx-dock-header-height, 44px\)/);
  assert.match(row, /border-bottom: 0;/);
  // A tab strip inside the row draws neither its own height nor its own rule.
  assert.match(strip, /\.dock-header-row \.browser-tab-toolbar \{[^}]*border-bottom: 0;/);
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
  assert.equal(actions.filter((item) => item.checked).length, 1);
  actions.find((item) => item.id === 'credential-c1').onSelect();
  assert.deepEqual(fills, ['c1']);
  const { readFile } = await import('node:fs/promises');
  const pane = await readFile(new URL('./BrowserPane.lazy.tsx', import.meta.url), 'utf8');
  // The nav row ends where the main tab's popup strip (or the import dialog) begins.
  const toolbarEnd = [pane.indexOf('{mainTab && tabs.length > 1'), pane.indexOf('<BrowserImportDialog')]
    .filter((index) => index > 0)
    .reduce((first, index) => Math.min(first, index));
  const toolbar = pane.slice(pane.indexOf('className="browser-pane-toolbar"'), toolbarEnd);
  assert.doesNotMatch(toolbar, /OpenSelect|ExternalLink|KeyRound/);
  // Import sits at the right end of the nav row, after the address field,
  // with the link glyph (the former Copy link icon).
  assert.ok(toolbar.indexOf('browserAddressField(') < toolbar.indexOf('browser-pane-import-button'));
  assert.match(toolbar, /<Link2 size=\{15\} \/>/);
  assert.match(toolbar, /data-tooltip=\{t\('Import from browser'\)\}/);
  assert.match(toolbar, /navLayout\.import &&/);
  assert.equal(toolbar.trimEnd().endsWith('</div>'), true);
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
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./desktop/26-editor.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.editor-statusbar/);
  const editor = await readFile(new URL('./EditorPane.lazy.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(editor, /editor-statusbar|editorStatusBar/);
});

test('dock header chips use the pane workspace tab styling', async () => {
  const { readFile } = await import('node:fs/promises');
  const strip = await readFile(new URL('./tab-strip.css', import.meta.url), 'utf8');
  const tabs = await readFile(new URL('./desktop/04-workspace-tabs.css', import.meta.url), 'utf8');
  const body = (css, selector) =>
    css.match(new RegExp(`${selector.replace(/[.[\]()>:]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  // Same label tier (size/weight) and icon size as .workspace-tab-main.
  assert.match(body(tabs, '.workspace-tab-main span'), /font-size: var\(--mx-font-item\)/);
  assert.match(body(tabs, '.workspace-tab-main span'), /font-weight: var\(--mx-weight-regular\)/);
  assert.match(body(strip, '.browser-tab-select'), /font-size: var\(--mx-font-item\)/);
  assert.match(body(strip, '.browser-tab-select'), /font-weight: var\(--mx-weight-regular\)/);
  assert.match(body(strip, '.browser-tab.is-active .browser-tab-select'), /font-weight: var\(--mx-weight-medium\)/);
  assert.match(body(strip, '.browser-tab-select svg'), /width: 15px;\s*height: 15px;/);
  // Same plate fills (idle 3%, active 14%), 30px tall in the 44px row, and radius.
  assert.match(body(strip, '.browser-tab::before'), /3%/);
  assert.match(body(strip, '.browser-tab::before'), /border-radius: var\(--mx-radius-md\)/);
  assert.match(body(strip, '.browser-tab.is-active::before'), /14%/);
  assert.match(body(strip, '.dock-header-row .browser-tab::before'), /inset: 7px 3px;/);
  assert.match(body(tabs, '.pane-cell .workspace-tab:not(.drop-target-right)::before'), /inset: 7px 3px 6px;/);
  assert.match(body(strip, '.browser-tab'), /color: var\(--mx-tab-idle-ink\)/);
  // The file chip is a browser-tab, not its own outlined style.
  assert.doesNotMatch(strip, /\.dock-header-chip \{[^}]*(font-size|background|border-radius)/);
});

test('browser address field reads as an input: outlined, no fill, hover border, accent focus ring', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./desktop/32-browser-pane.css', import.meta.url), 'utf8');
  const field = css.match(/\.browser-pane-address \{([^}]*)\}/)[1];
  assert.match(field, /background: transparent;/);
  assert.doesNotMatch(field, /color-mix/);
  assert.match(field, /border: 1px solid var\(--mx-border\);/);
  assert.match(css.match(/\.browser-pane-address:hover \{([^}]*)\}/)[1], /border-color: var\(--mx-border-strong\)/);
  assert.match(css.match(/\.browser-pane-address:focus \{([^}]*)\}/)[1], /box-shadow: 0 0 0 1px var\(--mx-focus\)/);
  assert.match(field, /border-radius: var\(--mx-radius-pill\)/);
  assert.match(field, /color: var\(--mx-text\)/);
  assert.match(css.match(/\.browser-pane-address::placeholder \{([^}]*)\}/)[1], /color: var\(--mx-text-faint\)/);
  assert.match(css.match(/\.browser-pane-address:focus \{([^}]*)\}/)[1], /border-color: var\(--mx-focus\)/);
  // --mx-text is theme-aware, so the same mix reads on dark and light.
  const tokens = await readFile(new URL('./desktop/01-tokens.css', import.meta.url), 'utf8');
  assert.match(tokens, /:root\[data-mixdog-theme="light"\]/);
  assert.match(tokens, /--mx-text-faint:/);
});

test('dock header tab lists behave like the pane tab strip for 2-6 browser and terminal tabs at 280/500px', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./tab-strip.css', import.meta.url), 'utf8');
  const rule = (selector) =>
    css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()>:]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  const list = rule('.browser-tab-list');
  assert.match(list, /overflow-x: scroll;/);
  assert.match(list, /overflow-y: hidden;/);
  assert.match(list, /scrollbar-width: none;/);
  assert.doesNotMatch(css, /scrollbar-width: thin/);
  assert.doesNotMatch(css, /overflow-x: auto/);
  assert.match(rule('.browser-tab-list::-webkit-scrollbar'), /display: none;/);
  // Tabs shrink to the pane tab floors before the list scrolls; titles ellipsize.
  assert.match(rule('.browser-tab'), /flex: 0 1 160px;/);
  assert.match(rule('.browser-tab'), /min-width: 30px;/);
  assert.match(rule('.browser-tab.is-active'), /min-width: 56px;/);
  assert.match(rule('.browser-tab-select span'), /text-overflow: ellipsis;/);
  assert.match(rule('.browser-tab-select span'), /overflow: hidden;/);
  // + and the row controls are fixed: the list is the only shrinking/scrolling part.
  assert.match(rule('.browser-tab-new'), /flex: 0 0 30px;/);
  assert.match(rule('.dock-header-controls'), /flex: none;/);
  assert.match(rule('.dock-header-row .browser-tab-toolbar'), /flex: 0 1 auto;/);
  // Plates are centred: 7px top and bottom inside the 44px row, tab fills the row.
  assert.match(rule('.dock-header-row .browser-tab::before'), /inset: 7px 3px;/);
  assert.match(rule('.browser-tab'), /height: 100%;/);
  assert.match(rule('.dock-header-row .browser-tab-toolbar'), /height: 100%;/);

  const { renderToStaticMarkup } = await import('react-dom/server');
  const { BrowserTabStrip } = await import('./BrowserTabStrip.tsx');
  const terminal = await readFile(new URL('./SessionTerminalTabs.tsx', import.meta.url), 'utf8');
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
  // The terminal strip reuses the same classes and the shared wheel mapping.
  assert.match(terminal, /className="browser-tab-list"/);
  assert.match(terminal, /scrollTabListByWheel\(event, strip\.current\)/);
  assert.match(terminal, /className="browser-tab-new"/);
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

test('dock header buttons and tab icons match the pane strip toggles, +, and tab glyphs', async () => {
  const { readFile } = await import('node:fs/promises');
  const strip = await readFile(new URL('./tab-strip.css', import.meta.url), 'utf8');
  const markdown = await readFile(new URL('./desktop/22-markdown.css', import.meta.url), 'utf8');
  const tabs = await readFile(new URL('./desktop/04-workspace-tabs.css', import.meta.url), 'utf8');
  const body = (css, selector) =>
    css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()>:="*]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  const prop = (block, name) => block.match(new RegExp(`${name}: ([^;]+);`))?.[1];
  // Button box, plate radius, idle ink: pane-dock-toggle vs dock header button.
  const toggle = body(markdown, '.pane-dock-toggle');
  const nav = body(strip, '.browser-pane-nav-button');
  const dockNav = body(strip, '.dock-header-controls .browser-pane-nav-button');
  assert.equal(prop(nav, 'width'), prop(toggle, 'width'));
  assert.equal(prop(nav, 'height'), prop(toggle, 'height'));
  assert.equal(prop(nav, 'border-radius'), prop(toggle, 'border-radius'));
  assert.equal(prop(nav, 'color'), prop(toggle, 'color'));
  assert.equal(prop(dockNav, 'flex'), prop(toggle, 'flex'));
  assert.equal(
    prop(body(strip, '.browser-pane-nav-button:hover:not(:disabled)'), 'background'),
    prop(body(markdown, '.pane-dock-toggle:hover,\n.pane-dock-toggle:focus-visible'), 'background')
  );
  // Icon size and stroke.
  const toggleSvg = body(markdown, '.pane-dock-toggle svg.lucide');
  const dockSvg = body(
    strip,
    '.dock-header-controls .browser-pane-nav-button svg.lucide,\n.browser-pane-toolbar:not(.browser-remote-pane .browser-pane-toolbar) .browser-pane-nav-button svg.lucide'
  );
  for (const name of ['width', 'height', 'stroke-width'])
    assert.equal(prop(dockSvg, name), prop(toggleSvg, name), name);
  assert.equal(prop(dockSvg, 'stroke-width'), '1.5px');
  // New reference: toggles and the strip + and every dock icon are 15px on a 1.5px line, like the tabs' leading icons.
  const stripPlus = body(markdown, '.workspace-tabs-shell > .workspace-tab-new svg.lucide');
  const tabIcon = body(tabs, '.workspace-tab-main > svg');
  const uniform = [
    toggleSvg,
    stripPlus,
    dockSvg,
    body(strip, '.browser-tab-new svg.lucide'),
    body(strip, '.browser-tab-select svg'),
    tabIcon,
  ];
  for (const svg of uniform) {
    assert.equal(prop(svg, 'width'), '15px');
    assert.equal(prop(svg, 'height'), '15px');
  }
  for (const svg of [
    toggleSvg,
    stripPlus,
    dockSvg,
    body(strip, '.browser-tab-new svg.lucide'),
    body(strip, '.browser-tab-select svg.lucide'),
    body(tabs, '.workspace-tab-main > svg.lucide'),
  ])
    assert.equal(prop(svg, 'stroke-width'), '1.5px');
  assert.equal(prop(body(tabs, '.workspace-tab-new svg'), 'padding'), '4.5px');
  assert.equal(prop(body(strip, '.browser-tab-new svg'), 'padding'), '4.5px');
  const src = (name) => readFile(new URL(name, import.meta.url), 'utf8');
  assert.match(await src('./pane-dock-toggles.tsx'), /<Icon size=\{15\}/);
  assert.match(await src('./WorkspaceTabStrip.tsx'), /<Plus size=\{15\}/);
  assert.match(await src('./BrowserTabStrip.tsx'), /<Plus size=\{15\}/);
  assert.match(await src('./SessionTerminalTabs.tsx'), /<Plus size=\{15\}/);
  assert.equal((await src('./pane-dock-chrome.tsx')).match(/size=\{16\}/g), null);
  const browserSrc = await src('./BrowserPane.lazy.tsx');
  const navRow = browserSrc.slice(
    browserSrc.indexOf('className="browser-pane-toolbar"'),
    browserSrc.indexOf('<BrowserImportDialog')
  );
  assert.equal(navRow.match(/size=\{16\}/g), null);
  // Pressed plate.
  assert.equal(
    prop(body(strip, '.dock-header-controls .browser-pane-nav-button[aria-pressed="true"]'), 'background'),
    'var(--mx-pressed)'
  );
  // ＋ and tab X: same hit box, ink, glyph size/stroke and hover plate as the pane strip.
  const plus = body(tabs, '.workspace-tab-new');
  const dockPlus = body(strip, '.browser-tab-new');
  for (const name of ['width', 'flex', 'align-self', 'color'])
    assert.equal(prop(dockPlus, name), prop(plus, name), `+ ${name}`);

  assert.match(
    body(tabs, '.workspace-tab-new svg,\n.workspace-tab-new .codicon'),
    /border-radius: var\(--mx-radius-md\)/
  );
  assert.equal(prop(body(strip, '.browser-tab-new svg'), 'border-radius'), 'var(--mx-radius-md)');
  const closeDock = body(strip, '.browser-tab-close');
  const closePane = body(tabs, '.workspace-tab-close');
  for (const name of ['width', 'height', 'border-radius'])
    assert.equal(prop(closeDock, name), prop(closePane, name), `X ${name}`);
  assert.equal(
    prop(body(strip, '.browser-tab-close svg'), 'width'),
    prop(body(tabs, '.workspace-tab-close svg'), 'width')
  );
  // Tab glyph tier: 14px lucide, and the same lucide components as the pane tabs.
  assert.equal(
    prop(body(strip, '.browser-tab-select svg'), 'width'),
    prop(body(tabs, '.workspace-tab-main > svg'), 'width')
  );
  const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');
  assert.match(
    await read('./WorkspaceTabStrip.tsx'),
    /case 'file':\s*return <FileText size=\{size\} \/>;[\s\S]*case 'terminal':\s*return <Terminal size=\{size\} \/>/
  );
  assert.match(await read('./side-surface-strip.tsx'), /FileText as FileIcon/);
  assert.match(await read('./SessionTerminalTabs.tsx'), /<Terminal size=\{15\}/);
  assert.doesNotMatch(await read('./SessionTerminalTabs.tsx'), /SquareTerminal/);
  // Every header control is a 16px lucide mark (open-in-system-browser included).
  const chrome = await read('./pane-dock-chrome.tsx');
  assert.match(chrome, /<Glyph size=\{15\} aria-hidden=\{true\} \/>/);
  assert.match(chrome, /<MoreHorizontal size=\{15\}/);
  assert.match(chrome, /<X size=\{15\}/);
  assert.match(await read('./BrowserPane.lazy.tsx'), /icon: ExternalLink/);
});

test('a pane bottom panel sits inside the workspace sheet and the dock spans the full cell height', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./pane-layout.css', import.meta.url), 'utf8');
  const rule = (selector) =>
    css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]()>:="*+]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
  // Three explicit rows: strip | stack | bottom panel; the dock spans all three.
  assert.match(rule('.pane-cell'), /grid-template-rows: auto minmax\(0, 1fr\) auto auto;/);
  assert.match(rule('.pane-cell > .bottom-panel'), /grid-column: 1;\s*grid-row: 3;/);
  assert.match(
    css.match(/\.pane-cell > \.pane-side-dock,\s*\.pane-cell > \.pane-side-dock-spacer \{([^}]*)\}/)[1],
    /grid-column: 2;\s*grid-row: 1 \/ span 4;/
  );
  // The panel is a flat row under the stack, divided by one hairline (desktop sheet band only).
  const tail = css.slice(css.lastIndexOf('@media (min-width: 941px)'));
  const panel = tail.match(/\.pane-cell > \.bottom-panel:not\(\[data-state="closed"\]\) \{([^}]*)\}/)[1];
  assert.match(panel, /margin: 0;\s*border: 0;\s*border-top: 1px solid var\(--mx-border\);\s*border-radius: 0;/);
  assert.match(panel, /background: var\(--mx-sheet-surface\);/);
  assert.match(tail, /:root:not\(\[data-mixdog-mobile-tabs\]\)/);
  // Every pane cell (split panes included) gets its own panel row: PaneWorkspace renders
  // strip, stack, problems and dock as direct children of each cell.
  const workspace = await readFile(new URL('./PaneWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(
    workspace,
    /renderStrip\?\.\(leaf\)\}\s*\{renderPaneSurfaceStack\(leaf, focused\)\}\s*\{renderProblems\?\.\(leaf, focused\)\}\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="pane-footer-slot" \/>\s*\{renderSideDock\?\.\(leaf, focused\)\}/
  );
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
  const { readFile } = await import('node:fs/promises');
  const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');
  for (const file of ['./side-surface-strip.tsx', './SessionDiffPane.tsx', './pane-side-dock.tsx'])
    assert.match(await read(file), /<DockHeaderRow/);
});

test('toggling expand sets and clears the dock sheet geometry; a surface switch or close resets it', async () => {
  const { readFile } = await import('node:fs/promises');
  const dock = await readFile(new URL('./pane-side-dock.tsx', import.meta.url), 'utf8');
  assert.match(dock, /data-expanded=\{dockExpanded \? 'true' : 'false'\}/);
  assert.match(
    dock,
    /position: 'fixed',\s*left: expandedRect\.left,\s*top: expandedRect\.top,\s*width: expandedRect\.width,\s*height: expandedRect\.height/
  );
  assert.match(dock, /dockExpanded && expandedRect && \(\s*<div className="pane-side-dock-spacer"/);
  const hooks = await readFile(new URL('./pane-side-dock-hooks.ts', import.meta.url), 'utf8');
  assert.match(hooks, /if \(!expanded \|\| !openNow \|\| !host\) \{\s*setExpandedRect\(undefined\);/);
  assert.match(hooks, /setExpanded\(false\);\s*\}, \[surface, view, openNow\]\);/);
  assert.match(dock, /const dockExpanded = expanded && openNow && !mobileSheet;/);
  assert.match(dock, /mobileSheet \? null : \{ expanded: dockExpanded, toggle: toggleExpanded \}/);
  const slots = await readFile(new URL('./surface-slots.ts', import.meta.url), 'utf8');
  assert.match(slots, /export function expandedDockRect/);
  assert.match(slots, /const panel = expandedSheetBounds\(panelNode\);/);
  const css = await readFile(new URL('./pane-layout.css', import.meta.url), 'utf8');
  assert.match(css, /\.pane-side-dock\[data-expanded="true"\] \{\s*z-index: 40;\s*margin: 0;/);
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
    viewToggle: { value: 'rendered', renderedLabel: 'Preview', onChange() {} },
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
  const keepActions = sideFileActions(chrome, () => {}, () => {});
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
  // Segmented toggle: two options, aria-pressed on exactly the active one.
  const segments = [...source.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => [
    m[2],
    m[1],
  ]);
  assert.deepEqual(segments, [
    ['Preview', 'false'],
    ['Source', 'true'],
  ]);
  assert.ok(
    source.indexOf('side-file-view-toggle') < source.indexOf('side-file-status-items'),
    'toggle is on the left'
  );
  // Rendered mode: the right side is empty.
  const rendered = renderToStaticMarkup(React.createElement(SideFileStatusRow, { chrome }));
  assert.deepEqual(
    [...rendered.matchAll(/<button[^>]*aria-pressed="(true|false)"/g)].map((m) => m[1]),
    ['true', 'false']
  );
  for (const marker of ['side-file-status-problems', 'side-file-status-cursor', 'side-file-status-language'])
    assert.equal(rendered.includes(marker), false, 'rendered: ' + marker);
  // Plain code (no toggle): only the right-side items.
  const code = renderToStaticMarkup(
    React.createElement(SideFileStatusRow, { chrome: { ...chrome, viewToggle: undefined } })
  );
  assert.equal(code.includes('side-file-view-toggle'), false);
  assert.ok(code.includes('side-file-status-cursor') && code.includes('side-file-status-problems'));
  // Previews (image/pdf/office/binary: no cursor, no view toggle) get NO footer; the chip tooltip carries the path.
  const { sideFileHasFooter } = await import('./side-file-status-row.tsx');
  const previewChrome = { editable: false, dirty: false, saving: false, save() {}, reveal() {}, openDefault() {} };
  assert.equal(sideFileHasFooter(previewChrome), false);
  assert.equal(sideFileHasFooter(null), false);
  assert.equal(sideFileHasFooter(chrome), true);
  assert.equal(
    sideFileHasFooter({ ...previewChrome, viewToggle: chrome.viewToggle }),
    true,
    'md/csv preview mode keeps its toggle footer'
  );
  const previewHeader = renderToStaticMarkup(
    React.createElement(
      SideFileStrip,
      stripProps([tabOf('decks/deck.pptx')], sideFileKey(tabOf('decks/deck.pptx')), { chrome: previewChrome })
    )
  );
  assert.ok(previewHeader.includes('class="browser-tab-select" title="decks/deck.pptx"'));
  // Order inside the side file card: header, body (editor then problems), footer last.
  const { readFile } = await import('node:fs/promises');
  const dock = await readFile(new URL('./pane-side-dock.tsx', import.meta.url), 'utf8');
  const slot = dock.slice(dock.indexOf('<SideFileStrip'), dock.indexOf('{browserSurface && ('));
  const at = (needle) => slot.indexOf(needle);
  assert.ok(
    at('<SideFileStrip') < at('pane-side-file-editor') && at('pane-side-file-editor') < at('<SideFileProblems')
  );
  assert.ok(at('<SideFileProblems') < at('<SideFileStatusRow'), 'footer follows the problems panel');
  assert.match(
    slot.trimEnd(),
    /sideFileHasFooter\(fileChrome\) && <SideFileStatusRow[^>]*\/>\}\s*<\/div>\s*\)\}$/,
    'footer is the last child of the card, text editors only'
  );
  // Diff, Changes and the Files tree draw no footer.
  for (const file of ['./SessionDiffPane.tsx', './pane-dock-files.tsx'])
    assert.doesNotMatch(
      await readFile(new URL(file, import.meta.url), 'utf8'),
      /<SideFileStatusRow|side-file-status-row/,
      file
    );
  const css = await readFile(new URL('./tab-strip.css', import.meta.url), 'utf8');
  // Fixed 24px footer with a top hairline and no background of its own.
  assert.match(css.match(/\.side-file-status-row \{([^}]*)\}/)[1], /height: 24px;/);
  assert.match(css.match(/\.side-file-status-row \{([^}]*)\}/)[1], /border-top: 1px solid var\(--mx-border\);/);
  // A single-row header has no rule under it; the browser nav row owns its own divider.
  assert.match(css.match(/\n\.dock-header-row \{([^}]*)\}/)[1], /border-bottom: 0;/);
  assert.doesNotMatch(css.match(/\n\.dock-header-row \{([^}]*)\}/)[1], /border-bottom: 1px/);
  const pane = await readFile(new URL('./desktop/32-browser-pane.css', import.meta.url), 'utf8');
  assert.match(pane.match(/\.browser-pane-toolbar \{([^}]*)\}/)[1], /border-bottom: 1px solid/);
  // Table view: a flush spreadsheet grid (no inset box), themed through the app tokens.
  const editor = await readFile(new URL('./desktop/26-editor.css', import.meta.url), 'utf8');
  assert.doesNotMatch(editor, /\.editor-table-scroll/);
  const grid = editor.match(/\.editor-table-grid\.rdg \{([^}]*)\}/)[1];
  assert.doesNotMatch(grid, /margin:|border-radius:/);
  assert.match(grid, /--rdg-border-color: var\(--mx-border-muted\);/);
  assert.match(grid, /--rdg-selection-color: var\(--editor-table-accent\);/);
  assert.match(grid, /--editor-table-accent: var\(--mx-accent, var\(--mx-focus\)\);/);
  assert.match(grid, /--rdg-selection-width: 2px;/);
  assert.match(grid, /--editor-table-tint: color-mix\(in srgb, var\(--mx-text\) 4%, var\(--mx-bg-base\)\);/);
  assert.match(grid, /--rdg-row-hover-background-color: color-mix\(in srgb, var\(--mx-text\) 3%, transparent\);/);
  assert.match(
    editor,
    /is-active-column[\s\S]*?color-mix\(in srgb, var\(--editor-table-accent\) 14%, var\(--editor-table-tint\)\)/
  );
  assert.match(editor.match(/\.editor-markdown-preview \{([^}]*)\}/)[1], /padding: 16px 20px 12px;/);
  assert.match(css.match(/\.side-file-status-row \{([^}]*)\}/)[1], /background: transparent;/);
  assert.match(css.match(/\.side-file-status-row \{([^}]*)\}/)[1], /flex: none;/);
  assert.match(css.match(/\.side-file-status-cursor \{([^}]*)\}/)[1], /tabular-nums/);
  assert.match(css.match(/\.side-file-status-problems \{([^}]*)\}/)[1], /min-width: 52px;/);
});

test('side file second row hides language first, then the cursor; counts and the toggle stay', async () => {
  const L = await import('./side-file-status-layout.ts');
  const base = (toggle) =>
    L.SIDE_STATUS_PADDING +
    L.SIDE_STATUS_PATH_MIN_WIDTH +
    L.SIDE_STATUS_PROBLEMS_WIDTH +
    (toggle ? L.SIDE_STATUS_TOGGLE_WIDTH : 0);
  for (const toggle of [false, true]) {
    assert.deepEqual(L.sideStatusLayout(500, toggle), { cursor: true, language: true });
    assert.deepEqual(L.sideStatusLayout(280, false), { cursor: true, language: true });
    assert.deepEqual(
      L.sideStatusLayout(280, true),
      { cursor: true, language: false },
      'with the toggle the language yields at the 280px floor'
    );
    const full = base(toggle) + L.SIDE_STATUS_CURSOR_WIDTH + L.SIDE_STATUS_LANGUAGE_WIDTH;
    assert.deepEqual(L.sideStatusLayout(full, toggle), { cursor: true, language: true });
    assert.deepEqual(L.sideStatusLayout(full - 1, toggle), { cursor: true, language: false });
    assert.deepEqual(L.sideStatusLayout(base(toggle) + L.SIDE_STATUS_CURSOR_WIDTH - 1, toggle), {
      cursor: false,
      language: false,
    });
  }
  assert.deepEqual(L.sideStatusLayout(0, true), { cursor: true, language: true });
  // The problems counts and toggle are rendered regardless of the layout flags.
  const { readFile } = await import('node:fs/promises');
  const row = await readFile(new URL('./side-file-status-row.tsx', import.meta.url), 'utf8');
  assert.match(row, /\{toggle && \(/);
  assert.match(row, /\{showStatus && problems && \(/);
  assert.match(row, /chrome\?\.cursor && layout\.cursor/);
  assert.match(row, /chrome\?\.language && layout\.language/);
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
  const { readFile } = await import('node:fs/promises');
  const pane = await readFile(new URL('./BrowserPane.lazy.tsx', import.meta.url), 'utf8');
  assert.match(pane, /navLayout\.forward && \(/);
  assert.match(pane, /navLayout\.import && \(/);
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
  // The expanded containers round their inner corners to the frame: right corners, all when folded.
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('./pane-layout.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /session-terminal-surface-container\[data-expanded="true"\],[^{]*session-browser-surface-container\[data-expanded="true"\] \{\s*border: 0;\s*border-radius: 0 calc\(var\(--mx-sheet-radius\) - 1px\) calc\(var\(--mx-sheet-radius\) - 1px\) 0;/
  );
  assert.match(
    css,
    /\.pane-side-dock-header\[data-surface-expanded="true"\] \{\s*border-radius: 0 calc\(var\(--mx-sheet-radius\) - 1px\) 0 0;/
  );
});

test('vertical resize handles: 13px hit area centred on the divider, accent centred on its pixel', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = flattenCss(await readFile(new URL('./pane-layout.css', import.meta.url), 'utf8'));
  const block = css.slice(css.indexOf('/* ── Sheet framing (desktop) ──'));
  const scope = ':root:not\\(\\[data-mixdog-mobile-tabs\\]\\)';
  const rule = (selector) => block.match(new RegExp(scope + ' ' + selector + ' \\{([^}]*)\\}'))?.[1] ?? '';
  // Left panel: the divider is its right border, 1px past the padding edge: right -7 + width 13 => centre on it.
  const left = rule('\\.workbench-side-panel\\[data-side="left"\\] > \\.workbench-side-panel-resize');
  assert.match(left, /right: -7px;\s*width: 13px;/);
  assert.match(block, /\.workbench-side-panel\[data-side="left"\] \{[^}]*overflow: visible;/);
  // Dock and diff-column edge: a 12px hit area centred in the 2px gap between the two sheets
  // (gap = [D-2, D), D = dock border box; padding edge = D+1; left -8 => D-7 .. D+5, centre D-1).
  const dock = block.match(
    new RegExp(
      scope +
        ' \\.pane-side-dock \\.workbench-side-panel\\[data-side="right"\\] > \\.workbench-side-panel-resize,\\s*' +
        scope +
        ' \\.pane-dock-diff-resize \\{([^}]*)\\}'
    )
  )[1];
  assert.match(dock, /left: -8px;\s*width: 12px;/);
  // Accent: 2px at 50% - 1px of the 12px box => [D-2, D), exactly the gap; drawn on hover / drag only.
  const after = block.match(/\.pane-dock-diff-resize::after \{([^}]*)\}/)[1];
  assert.match(after, /left: calc\(50% - 1px\);\s*right: auto;\s*width: 2px;/);
  assert.match(after, /background: transparent;/);
  assert.match(block, /\.pane-dock-diff-resize:is\(:hover, :active\)::after \{\s*background: var\(--mx-focus\);/);
  // With a diff pair showing, the panel's own handle sits on the internal 1px divider: centred on it.
  const pair = block.match(
    /\.pane-dock-diff-column:not\(\[hidden\]\) ~ \.workbench-side-panel\[data-side="right"\] > \.workbench-side-panel-resize \{([^}]*)\}/
  )[1];
  assert.match(pair, /left: -7px;\s*width: 13px;/);
  // Split handles: hit area is 6px each side of the 1px handle, accent 3px centred (translateX(-50%) in the base rule).
  assert.match(rule('\\.pane-split-row > \\.pane-resize-handle::before'), /left: -6px;\s*right: -6px;/);
  assert.match(rule('\\.pane-split-row > \\.pane-resize-handle:is\\(:hover, \\.is-dragging\\)::after'), /width: 3px;/);
  assert.match(
    css,
    /\.pane-split-row > \.pane-resize-handle::after \{[^}]*left: 50%;\s*width: 1px;\s*transform: translateX\(-50%\);/
  );
});

test('a cancelled panel resize restores the preference snapshotted at gesture start, not the rendered width', async () => {
  const { readFile } = await import('node:fs/promises');
  const dock = await readFile(new URL('./pane-side-dock.tsx', import.meta.url), 'utf8');
  const handler = dock.slice(dock.indexOf('onWidthDrag={(next, phase)'), dock.indexOf('widthRange={'));
  // The snapshot is the stored pref (500 saved, 400 rendered => 500), taken on the first preview.
  assert.match(handler, /phase === 'preview' && !panelWidthSnapshot\.current/);
  assert.match(handler, /kind === 'terminal' \? terminalPref : kind === 'browser' \? browserPref : panelPref/);
  // Cancel restores it and never commits or applies the reported (constrained) width.
  const cancel = handler.slice(
    handler.indexOf("phase === 'cancel'"),
    handler.indexOf("if (phase === 'commit') panelWidthSnapshot")
  );
  assert.match(cancel, /setPanelPref\(snapshot\.pref\)/);
  assert.doesNotMatch(cancel, /commitWidthPref|\(next\)/);
  assert.match(cancel, /return;/);
  assert.match(handler, /phase === 'commit'\) commitWidthPref|if \(phase === 'commit'\) commitWidthPref/);
  assert.doesNotMatch(handler, /commit\) commitWidthPref/);
});
