import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';
import {
  PaneSideDock,
  normalizePaneSideDocks,
  paneDiffStacks,
  paneDockActiveRoot,
  paneDiffShowing,
  samePaneSideDocks,
  withPaneDockDiffClosed,
  withPaneDockDiffOpened,
  withPaneDockFileClosed,
  withPaneDockFileOpened,
} from './pane-side-dock.tsx';
import { sessionSideDockEntryForSession } from './session-side-surface-policy.ts';

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

test('a transcript file link opens the file surface and the next link replaces it', () => {
  let entry = closed();
  entry = withPaneDockFileOpened(entry, fileLink, 1);
  assert.equal(entry.open, true);
  assert.equal(entry.surface, 'file');
  assert.deepEqual(entry.file, { ...fileLink, nonce: 1 });
  assert.equal(paneDockActiveRoot(entry), null);
  entry = withPaneDockFileOpened(entry, { project: 'C:/p', rel: 'src/b.ts' }, 2);
  assert.equal(entry.file.rel, 'src/b.ts');
  assert.equal(entry.surface, 'file');
  entry = withPaneDockFileClosed(entry);
  assert.equal(entry.file, undefined);
  assert.equal(entry.surface, '');
  assert.equal(entry.open, true);
});

test('the side file persists, restores, and stays in front of a session surface', () => {
  const stored = JSON.parse(
    JSON.stringify({ 'pane-1': withPaneDockFileOpened(closed(), fileLink, 5) })
  );
  const restored = normalizePaneSideDocks(stored, ['pane-1'], RIGHT, false);
  assert.deepEqual(restored['pane-1'].file, { ...fileLink, nonce: 5 });
  assert.equal(restored['pane-1'].surface, 'file');
  assert.equal(restored['pane-1'].open, true);
  assert.ok(samePaneSideDocks(restored, restored));
  assert.ok(!samePaneSideDocks(restored, { 'pane-1': { ...restored['pane-1'], file: undefined } }));
  // A file-scoped access token never survives a restart.
  const tokened = { 'pane-1': { ...stored['pane-1'], file: { ...stored['pane-1'].file, accessToken: 't' } } };
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
    React.createElement('button', { 'data-testid': 'status-problems', onClick: side.onShowProblems })
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
          entry: withPaneDockFileOpened(closed(), { ...fileLink, accessToken: 'tok' }, 1),
        })
      )
    );
    assert.equal(document.querySelector('[data-testid="side-file"]')?.textContent, 'src/a.ts');
    // One header (view title + X only) and one shared strip.
    assert.equal(document.querySelectorAll('.pane-side-dock-header').length, 1);
    assert.equal(document.querySelector('.pane-side-dock-title')?.textContent, 'File');
    assert.deepEqual(
      [...document.querySelectorAll('.pane-side-dock-header button')].map((b) => b.getAttribute('aria-label')),
      ['Close panel']
    );
    assert.equal(document.querySelectorAll('.browser-tab-toolbar').length, 1);
    // The live strip's tab list must not be a visible scroller: apply the real
    // tab-strip.css to the rendered DOM and read the computed style.
    const { readFileSync } = await import('node:fs');
    const style = document.createElement('style');
    style.textContent = readFileSync(new URL('./tab-strip.css', import.meta.url), 'utf8');
    document.head.append(style);
    const list = document.querySelector('.browser-tab-toolbar[data-side-dock-strip] .browser-tab-list');
    assert.equal(window.getComputedStyle(list).overflowX, 'hidden');
    assert.equal(list.querySelectorAll('.browser-tab').length, 1);
    const strip = document.querySelector('.browser-tab-toolbar[data-side-dock-strip]');
    const chip = strip.querySelector('.browser-tab.is-active .browser-tab-select');
    assert.equal(chip.textContent, 'a.ts');
    assert.equal(chip.getAttribute('title'), 'src/a.ts');
    assert.deepEqual(
      [...strip.querySelectorAll('.browser-pane-nav-button')].map((b) => b.getAttribute('aria-label')),
      ['Save', 'Reveal in Explorer', 'Open in main tab']
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
    const button = document.querySelector('button[aria-label="Open in main tab"]');
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

test('every side-dock surface shows one dock header and one shared strip, no inner header row', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');
  const count = (source, pattern) => source.match(pattern)?.length ?? 0;
  const surfaces = {
    // [source that owns the strip, strip markers, inner header rows that must not exist]
    file: ['./side-surface-strip.tsx', /<SideChipStrip/g, /<header|editor-breadcrumbs/g],
    diff: ['./GitDiffPane.tsx', /<SideChipStrip/g, null],
    browser: ['./BrowserTabStrip.tsx', /className="browser-tab-toolbar"/g, /<header/g],
    terminal: ['./SessionTerminalTabs.tsx', /className="browser-tab-toolbar"/g, /<header/g],
  };
  for (const [name, [file, strip, inner]] of Object.entries(surfaces)) {
    const source = await read(file);
    assert.ok(count(source, strip) >= 1, `${name}: renders the shared strip`);
    if (name !== 'file' && name !== 'diff') assert.equal(count(source, strip), 1, `${name}: exactly one strip`);
    if (inner) assert.equal(count(source, inner), 0, `${name}: no second header row`);
  }
  // Diff in side chrome returns before its own <header>, and the dock passes it.
  const diff = await read('./GitDiffPane.tsx');
  assert.ok(diff.indexOf("chrome === 'side'") < diff.indexOf('<header>\n        <div>'));
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
  assert.match(await read('./desktop/03-titlebar.css'), /\.workbench-side-panel,[^{]*\{[^}]*--mx-workspace-sheet: transparent/);
  const layout = await read('./workbench-side-view-layout.tsx');
  assert.match(layout, /style=\{selected && surfacesActive \? \{ visibility: 'hidden' \} : undefined\}/);
  assert.match(layout, /inert=\{!selected \|\| surfacesActive \? true : undefined\}/);
});

test('Open in main tab and Open in default app use different icons and tooltips', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { SideFileStrip } = await import('./side-surface-strip.tsx');
  const html = renderToStaticMarkup(
    React.createElement(SideFileStrip, {
      rel: 'docs/a.pdf',
      chrome: { editable: false, dirty: false, saving: false, save() {}, reveal() {}, openDefault() {} },
      onOpenInMain() {},
    })
  );
  const icon = (label) => html.match(new RegExp(`aria-label="${label}"[^>]*>\\s*<svg[^>]*class="([^"]*)"`))?.[1];
  assert.ok(icon('Open in default app'));
  assert.ok(icon('Open in main tab'));
  assert.notEqual(icon('Open in default app'), icon('Open in main tab'));
  assert.match(html, /lucide-panel-top/);
});

test('a :line:column link keeps its column through the dock and reveal', async () => {
  const { readFile } = await import('node:fs/promises');
  const stored = JSON.parse(JSON.stringify({ 'pane-1': withPaneDockFileOpened(closed(), { ...fileLink, column: 3 }, 9) }));
  const restored = normalizePaneSideDocks(stored, ['pane-1'], RIGHT, false);
  assert.equal(restored['pane-1'].file.column, 3);
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
