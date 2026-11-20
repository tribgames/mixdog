import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';
import { SessionDiffStack } from './session-diff-section.tsx';
import { requestSessionDiffFile } from './session-diff-focus.ts';
import { prefetchSessionChanges, setSessionChangesSource, useSessionChanges } from './session-changes-store.ts';
import { TurnReviewFilesMenu } from './turn-review-files-menu.tsx';

const h = React.createElement;
const patchFor = (path) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-a\n+b\n`;
// Landed file patches are announced in one batch per 100ms.
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 150)));
const dom = (t) =>
  installTestDom(t, {
    expose: ['navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'],
    rootId: 'root',
  });
const spacerHeight = (scope) =>
  [...scope.querySelectorAll('[data-scm-spacer]')].reduce(
    (sum, spacer) => sum + Number.parseFloat(spacer.style.height),
    0
  );
const FILES = 9000;
const paths = (count, prefix = 'src/f') => Array.from({ length: count }, (_, index) => `${prefix}${index}.ts`);

/** Counts every read of a row's fields from now on: a pass over the list
 *  reads at least one field of every row. */
function instrument(rows) {
  const reads = { count: 0 };
  for (const row of rows) {
    for (const field of ['id', 'path', 'status', 'additions', 'deletions', 'parts', 'oldPath', 'reason']) {
      const value = row[field];
      Object.defineProperty(row, field, {
        configurable: true,
        enumerable: true,
        get() {
          reads.count += 1;
          return value;
        },
      });
    }
  }
  return reads;
}

/** A Git root listing `list()` (re-read on Refresh), its patches read in one batch. */
function gitDesktop(view, cwd, list) {
  view.window.mixdogDesktop = {
    gitReview: async () => ({
      repository: true,
      root: cwd,
      base: 'HEAD',
      files: list().map((file) => ({ additions: 1, deletions: 1, untracked: false, status: 'M', ...file })),
    }),
    gitReviewDiffs: async (_cwd, files) => ({
      patches: files.map((file) => ({ path: file.path, patch: patchFor(file.path) })),
      omitted: [],
    }),
    invokeCapability: async () => ({ value: null }),
  };
  setSessionChangesSource('uncommitted');
}

/** The chip's reader (holds the list) plus `panes` docks on the session. */
async function showDocks(t, sessionId, list, panes = 1, extra = {}) {
  const view = dom(t);
  const cwd = `C:/${sessionId}`;
  gitDesktop(view, cwd, list);
  const out = {};
  function Chip() {
    out.rows = useSessionChanges({ cwd, sessionId, active: true }).rows;
    return null;
  }
  const render = (count, props = extra) =>
    act(async () =>
      view.root.render(
        h(
          React.Fragment,
          null,
          h(Chip),
          ...Array.from({ length: count }, (_, index) =>
            h(SessionDiffPane, {
              key: `pane-${index}`,
              paneKey: `pane-${index}`,
              sessionId,
              cwd,
              active: true,
              onClose() {},
              ...props,
            })
          )
        )
      )
    );
  await render(0);
  await settle();
  if (panes) {
    await render(panes);
    await settle();
  }
  const paneNode = (index = 0) => view.document.querySelectorAll('.session-diff-pane')[index];
  const stack = (index = 0) => paneNode(index).querySelector('.session-diff-stack');
  const sections = (index = 0) => [...paneNode(index).querySelectorAll('.session-diff-section')];
  const scrollTo = (top, index = 0) =>
    act(() => {
      stack(index).scrollTop = top;
      stack(index).dispatchEvent(new view.window.Event('scroll'));
    });
  return { view, out, render, paneNode, stack, sections, scrollTo };
}

const keydown = (view, key) =>
  act(async () =>
    view.document.activeElement.dispatchEvent(new view.window.KeyboardEvent('keydown', { key, bubbles: true }))
  );

// ── 1. The dock's mount path reads no per-file data ─────────────────────

test('1: a dock, a second dock and a new pick on an unchanged list read only the mounted files', async (t) => {
  const docks = await showDocks(t, 'f1-open', () => paths(FILES).map((path) => ({ path })), 0);
  const reads = instrument(docks.out.rows);
  await docks.render(1);
  assert.ok(docks.sections().length > 0);
  assert.ok(reads.count < FILES / 2, `the first dock read ${reads.count} row fields`);
  reads.count = 0;
  await docks.render(2);
  assert.ok(docks.sections(1).length > 0);
  assert.ok(reads.count < FILES / 2, `a second dock read ${reads.count} row fields`);
  reads.count = 0;
  await act(async () => docks.sections()[3].querySelector('.session-diff-section-title').click());
  assert.equal(docks.sections()[3].dataset.collapsed, undefined, 'the picked file unfolds');
  assert.ok(reads.count < FILES / 2, `a new pick read ${reads.count} row fields`);
});

test('1: a dock on a list of only deleted files folds them without a pass over the list', async (t) => {
  const docks = await showDocks(t, 'f1-deleted', () => paths(FILES).map((path) => ({ path, status: 'D' })), 0);
  const reads = instrument(docks.out.rows);
  await docks.render(1);
  assert.ok(
    docks.sections().every((section) => section.dataset.collapsed === 'true'),
    'deleted files start folded'
  );
  assert.ok(reads.count < FILES / 2, `the dock read ${reads.count} row fields`);
});

// ── 2. Picking or revealing a late file looks it up ─────────────────────

test('2: pressing a late file in the menu and revealing it in the dock never scan the list', async (t) => {
  const docks = await showDocks(t, 'f2-reveal', () => paths(FILES).map((path) => ({ path })));
  const reads = instrument(docks.out.rows);
  const last = `src/f${FILES - 1}.ts`;
  // The menu row's press: the intent prefetch for that file.
  act(() => prefetchSessionChanges('f2-reveal', { paneKey: 'pane-0', focusPath: last }));
  assert.ok(reads.count < FILES / 2, `the press read ${reads.count} row fields`);
  reads.count = 0;
  // The reveal opens the file's tab in the same commit.
  act(() => requestSessionDiffFile('f2-reveal', last));
  assert.deepEqual(
    docks.sections().map((section) => section.dataset.sessionDiffPath),
    [last]
  );
  assert.ok(reads.count < FILES / 2, `the reveal read ${reads.count} row fields`);
  await settle();
});

// ── 3. A refresh keeps the focused file mounted ─────────────────────────

test('3: a refresh that moves the focused file keeps it mounted and focused in the dock', async (t) => {
  let list = paths(FILES).map((path) => ({ path }));
  const docks = await showDocks(t, 'f3-dock', () => list);
  const header = docks.sections()[5].querySelector('.session-diff-section-title');
  act(() => header.focus());
  list = [{ path: 'src/new.ts' }, ...list];
  await act(async () => docks.paneNode().querySelector('.session-diff-refresh').click());
  await settle();
  docks.scrollTo(8000 * 34);
  await settle();
  assert.ok(header.isConnected, 'the focused header stays mounted');
  assert.equal(docks.view.document.activeElement, header);
});

test('3: new files arriving keep the focused files-menu row mounted and focused', async (t) => {
  const view = dom(t);
  const filesOf = (list) => new Map(list.map((path) => [path, { additions: 1, deletions: 1, lineStats: true }]));
  const menu = (files) =>
    h(
      TurnReviewFilesMenu,
      {
        sessionId: 'f3-menu',
        historyTurns: 1,
        label: 'Uncommitted',
        title: 'Files',
        files,
        onViewChanges() {},
        onOpenFile() {},
      },
      'Files'
    );
  await act(async () => view.root.render(menu(filesOf(paths(FILES)))));
  await act(async () => view.document.querySelector('.turn-review-segment').click());
  await keydown(view, 'End');
  await keydown(view, 'ArrowUp');
  await keydown(view, 'ArrowUp');
  const row = view.document.activeElement;
  assert.equal(row.title, `src/f${FILES - 1}.ts`);
  await act(async () => view.root.render(menu(filesOf(['src/new.ts', ...paths(FILES)]))));
  assert.ok(row.isConnected, 'the focused row stays mounted');
  assert.equal(view.document.activeElement, row);
});

// ── 4. A measured height belongs to what was measured ───────────────────

/** Section boxes: a folded one is its 34px header; an open one 100px at the
 *  stack's 600px width, 200px (wrapped) at 300px. The viewport is 600px tall. */
function mockSectionBoxes(t, view) {
  const proto = view.window.HTMLElement.prototype;
  const box = { width: 600, sections: true };
  const heightOf = (element) => {
    if (element.classList.contains('session-diff-stack')) return 600;
    if (!element.classList.contains('session-diff-section') || !box.sections) return 0;
    if (element.dataset.collapsed === 'true') return 34;
    return box.width <= 300 ? 200 : 100;
  };
  const rect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function getBoundingClientRect() {
    const height = heightOf(this);
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height };
  };
  // Every test builds its own window, so these stay on this one.
  for (const field of ['clientHeight', 'offsetHeight']) {
    Object.defineProperty(proto, field, {
      configurable: true,
      get() {
        return heightOf(this);
      },
    });
  }
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('session-diff-stack') ? box.width : 0;
    },
  });
  t.after(() => {
    proto.getBoundingClientRect = rect;
  });
  return box;
}
const ESTIMATE = 34 + 2 * 19;
/** The distance from the viewport's top to a file's section, from the stack's
 *  drawn children (spacers at their heights, sections at their boxes). */
function offsetInViewport(stack, path) {
  let top = 0;
  for (const node of stack.children) {
    if (node.dataset.sessionDiffPath === path) return top - stack.scrollTop;
    top += node.matches('[data-scm-spacer]')
      ? Number.parseFloat(node.style.height)
      : node.getBoundingClientRect().height;
  }
  return Number.NaN;
}

test('4: a height measured at one width is not reused at another', async (t) => {
  const count = 60;
  const docks = await showDocks(t, 'f4-width', () => paths(count).map((path) => ({ path })), 0);
  const box = mockSectionBoxes(t, docks.view);
  // The first files are drawn (and measured, 100px) at the top, at 600px.
  await docks.render(1);
  await settle();
  const measuredAtTop = docks.sections().length;
  assert.ok(measuredAtTop < count / 2);
  // Scrolled to the end, then the dock narrows.
  docks.scrollTo(count * 100);
  await settle();
  box.width = 300;
  await act(async () => docks.view.window.dispatchEvent(new docks.view.window.Event('resize')));
  await settle();
  const first = Number(docks.sections()[0].dataset.index);
  assert.ok(first > measuredAtTop, 'the files measured at 600px are off screen');
  const leading = Number.parseFloat(docks.stack().querySelector('[data-scm-spacer="leading"]').style.height);
  // Never measured at 300px: each holds its estimate, never its 600px height.
  assert.equal(leading, first * ESTIMATE);
});

async function foldedStack(t) {
  const view = dom(t);
  const box = mockSectionBoxes(t, view);
  const ref = React.createRef();
  const rows = paths(100).map((path) => ({ id: path, path, status: 'M', parts: [], additions: 1, deletions: 1 }));
  const render = (list = rows) =>
    act(() =>
      view.root.render(
        h(SessionDiffStack, {
          stackRef: ref,
          rows: list,
          withPatch: (row) => row,
          focusRow: null,
          mode: 'unified',
          selectedRow: rows[0],
          isFolded: () => false,
          onToggle() {},
          canRevertPath: () => false,
          onRevert() {},
        })
      )
    );
  await render();
  const stack = ref.current;
  const scroll = (top) =>
    act(() => {
      stack.scrollTop = top;
      stack.dispatchEvent(new view.window.Event('scroll'));
    });
  return { view, box, rows, render, stack, scroll };
}

test('4: resizing among folded headers updates the offscreen spacer and keeps the top file', async (t) => {
  const { view, box, rows, stack, scroll } = await foldedStack(t);
  await scroll(100 + 49 * 34 + 7);
  box.width = 300;
  await act(() => view.window.dispatchEvent(new view.window.Event('resize')));
  assert.equal(stack.scrollTop, ESTIMATE + 49 * 34 + 7);
  assert.equal(offsetInViewport(stack, rows[50].path), -7);
});

test('4: a browser clamp after removal above the viewport applies the shrink only once', async (t) => {
  const { rows, stack, render, scroll } = await foldedStack(t);
  let requested = 0;
  Object.defineProperties(stack, {
    scrollHeight: {
      get: () =>
        spacerHeight(stack) +
        [...stack.querySelectorAll('.session-diff-section')].reduce((sum, section) => sum + section.offsetHeight, 0),
    },
    scrollTop: {
      get: () => Math.min(requested, stack.scrollHeight - stack.clientHeight),
      set: (value) => {
        requested = value;
      },
    },
  });
  await scroll(stack.scrollHeight - stack.clientHeight);
  const before = offsetInViewport(stack, rows[90].path);
  assert.ok(before >= 0 && before < stack.clientHeight);
  await render(rows.filter((_, index) => index !== 10));
  assert.equal(offsetInViewport(stack, rows[90].path), before);
});

test('4: a pending scroll across an insertion anchors the file from the old row order', async (t) => {
  const { rows, stack, render, scroll } = await foldedStack(t);
  await scroll(100 + 49 * 34);
  stack.scrollTop += 34 + 7; // Into f51, before its scroll event.
  await render([{ ...rows[0], id: 'inserted', path: 'inserted' }, ...rows]);
  assert.equal(offsetInViewport(stack, rows[51].path), -7);
});

test('4: a measurement replacing an estimate above the viewport keeps what is shown in place', async (t) => {
  const count = 60;
  const docks = await showDocks(t, 'f4-anchor', () => paths(count).map((path) => ({ path })), 0);
  const box = mockSectionBoxes(t, docks.view);
  // Drawn while its sections have no box: every file holds its estimate.
  box.sections = false;
  await docks.render(1);
  await settle();
  box.sections = true;
  // Estimated 72px each, f20 is at the viewport's top; the overscan above it
  // is drawn, and measured at 100px, by this scroll.
  docks.scrollTo(20 * ESTIMATE);
  await settle();
  assert.ok(docks.sections().some((section) => section.dataset.sessionDiffPath === 'src/f19.ts'));
  assert.equal(offsetInViewport(docks.stack(), 'src/f20.ts'), 0, 'f20 is still at the top');
});

// ── 5. The menu learns its row height whenever rows exist ───────────────

test('5: a menu opened empty learns the touch row height once its rows arrive', async (t) => {
  const view = dom(t);
  const proto = view.window.HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function getBoundingClientRect() {
    if (!this.classList.contains('turn-review-files-row')) return rect.call(this);
    return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 44, width: 300, height: 44 };
  };
  t.after(() => {
    proto.getBoundingClientRect = rect;
  });
  const menu = (files, ready) =>
    h(
      TurnReviewFilesMenu,
      {
        sessionId: 'f5-menu',
        historyTurns: 1,
        label: 'Uncommitted',
        title: 'Files',
        files,
        ready,
        onViewChanges() {},
        onOpenFile() {},
      },
      'Files'
    );
  await act(async () => view.root.render(menu(new Map(), false)));
  await act(async () => view.document.querySelector('.turn-review-segment').click());
  const files = new Map(paths(300).map((path) => [path, { additions: 1, deletions: 1, lineStats: true }]));
  await act(async () => view.root.render(menu(files, true)));
  const list = view.document.querySelector('.turn-review-files-list');
  const rows = list.querySelectorAll('.turn-review-files-row').length;
  assert.equal(spacerHeight(list) + rows * 44, 300 * 44);
});

// ── 6. Arrow keys move between the dock's files ─────────────────────────

test('6: arrow keys, Home and End move focus between file headers, mounting the destination', async (t) => {
  const docks = await showDocks(t, 'f6-nav', () => paths(FILES).map((path) => ({ path })));
  const title = (path) =>
    docks.paneNode().querySelector(`[data-session-diff-path="${path}"] .session-diff-section-title`);
  act(() => title('src/f0.ts').focus());
  await keydown(docks.view, 'ArrowDown');
  assert.equal(docks.view.document.activeElement, title('src/f1.ts'));
  await keydown(docks.view, 'End');
  assert.equal(docks.view.document.activeElement, title(`src/f${FILES - 1}.ts`), 'the last file, mounted for the key');
  await keydown(docks.view, 'ArrowUp');
  assert.equal(docks.view.document.activeElement, title(`src/f${FILES - 2}.ts`));
  await keydown(docks.view, 'Home');
  assert.equal(docks.view.document.activeElement, title('src/f0.ts'));
  await settle();
});

// ── The whole-session diff parse yields to input ────────────────────────

/** A file's patch of `lines` changed lines (about 20 characters each). */
const bigPatchFor = (path, lines = 100) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lines} +1,${lines} @@\n${Array.from(
    { length: lines },
    (_, index) => `-old line ${index}\n+new line ${index}`
  ).join('\n')}\n`;
const bigResult = (count, lines) => ({
  supported: true,
  authoritative: true,
  complete: true,
  files: paths(count).map((path) => ({ path, status: 'M', additions: lines, deletions: lines })),
  patch: paths(count)
    .map((path) => bigPatchFor(path, lines))
    .join(''),
});

test('parse: a whole-session diff is parsed in steps that let other tasks run between files', async () => {
  const model = await import('./session-diff-model.ts');
  assert.equal(typeof model.parseSessionDiff, 'function', 'an incremental parse exists');
  const count = 400;
  const result = bigResult(count, 50);
  let turns = 0;
  let parsing = true;
  const tick = () => {
    if (!parsing) return;
    turns += 1;
    setImmediate(tick);
  };
  setImmediate(tick);
  const parsed = await model.parseSessionDiff(result);
  parsing = false;
  assert.equal(parsed.rows.length, count);
  assert.equal(parsed.rows[count - 1].parts.length, 1);
  // About 1 MB of patch, in tasks of 64K characters of work.
  assert.ok(turns >= 10, `the event loop turned ${turns} times during the parse`);
});

test('parse: a session diff read is parsed off the input path before it is delivered', async (t) => {
  const view = dom(t);
  const count = 400;
  const reply = bigResult(count, 50);
  let turns = 0;
  let counting = false;
  const tick = () => {
    if (!counting) return;
    turns += 1;
    setImmediate(tick);
  };
  view.window.mixdogDesktop = {
    invokeCapability: async (request) => {
      if (request.capability !== 'getSessionReviewDiff') return { value: null };
      counting = true;
      setImmediate(tick);
      return { value: reply };
    },
  };
  const { fetchSessionDiff } = await import('./session-diff-cache.ts');
  const { sessionDiffRowsOf } = await import('./session-diff-model.ts');
  const result = await fetchSessionDiff('parse-read', { force: true });
  counting = false;
  assert.ok(turns >= 10, `the event loop turned ${turns} times before the read was delivered`);
  assert.equal(sessionDiffRowsOf(result).length, count);
  assert.equal(sessionDiffRowsOf(result), sessionDiffRowsOf(result), 'parsed once, then looked up');
});

// ── Recheck ─────────────────────────────────────────────────────────────

test('recheck 1: an offscreen file whose measured height becomes an estimate keeps the top file in place', async (t) => {
  const count = 40;
  let list = paths(count).map((path) => ({ path }));
  const docks = await showDocks(t, 'r1-anchor', () => list, 0);
  mockSectionBoxes(t, docks.view);
  await docks.render(1);
  await settle();
  // Every file is drawn, and measured at 100px, once.
  for (let top = 0; top <= count * 100; top += 300) {
    docks.scrollTo(top);
    await settle();
  }
  docks.scrollTo(20 * 100);
  await settle();
  assert.equal(offsetInViewport(docks.stack(), 'src/f20.ts'), 0, 'f20 at the top');
  assert.ok(!docks.sections().some((section) => section.dataset.sessionDiffPath === 'src/f5.ts'), 'f5 is off screen');
  // A refresh moves f5's counts: a new row, its measured height gone.
  list = list.map((file) => (file.path === 'src/f5.ts' ? { ...file, additions: 3 } : file));
  await act(async () => docks.paneNode().querySelector('.session-diff-refresh').click());
  await settle();
  await settle();
  assert.equal(offsetInViewport(docks.stack(), 'src/f20.ts'), 0, 'f20 is still at the top');
});

test('recheck 2: the first task of a parse does not grow with the patch', async () => {
  const model = await import('./session-diff-model.ts');
  /** The synchronous first task of parsing a fresh result: the fastest of three. */
  const firstTask = async (count) => {
    let fastest = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run += 1) {
      const result = bigResult(count, 60);
      const started = performance.now();
      const parse = model.parseSessionDiff(result);
      fastest = Math.min(fastest, performance.now() - started);
      await parse;
    }
    return fastest;
  };
  await firstTask(200);
  const small = await firstTask(500);
  const large = await firstTask(8000);
  // Sixteen times the patch: the first task stays the same size.
  assert.ok(large < small * 4 + 2, `first task: ${small.toFixed(2)} ms at 500 files, ${large.toFixed(2)} ms at 8000`);
});

test('recheck 3: selecting a late file listed without its patch never scans the listed files', async (t) => {
  dom(t);
  const count = FILES;
  const listed = paths(count).map((path) => ({
    path,
    status: 'M',
    additions: 1,
    deletions: 1,
    patchOmitted: true,
    reason: 'too_large',
  }));
  const reads = { count: 0 };
  const files = new Proxy(listed, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads.count += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const last = `src/f${count - 1}.ts`;
  window.mixdogDesktop = {
    invokeCapability: async () => ({ value: { patch: patchFor(last) } }),
  };
  const { primeSessionDiff, fetchSessionDiffFilePatchResult } = await import('./session-diff-cache.ts');
  const { parsedSessionDiff } = await import('./session-diff-model.ts');
  const result = { supported: true, authoritative: true, complete: true, files, patch: '' };
  primeSessionDiff('r3-omitted', result);
  parsedSessionDiff(result);
  reads.count = 0;
  const read = await fetchSessionDiffFilePatchResult('r3-omitted', { id: last, path: last });
  assert.match(read.patch, /\+b/);
  assert.ok(reads.count < count / 2, `the selection read ${reads.count} listed files`);
});

/** The fold hook over `rows`, driven from outside. */
async function foldHook(t, rows) {
  const view = dom(t);
  const { useSessionDiffCollapse } = await import('./use-session-diff-collapse.ts');
  const out = {};
  let rerender;
  function Probe() {
    const [, set] = React.useState(0);
    rerender = () => set((value) => value + 1);
    out.fold = useSessionDiffCollapse(rows);
    return null;
  }
  await act(async () => view.root.render(h(Probe)));
  return { out, rerender: () => act(() => rerender()) };
}

test('recheck 4: toggles and renders cost nothing per file or per past toggle', async (t) => {
  const rows = paths(FILES).map((path) => ({ id: path, path, status: 'M', additions: 1, deletions: 1, parts: [] }));
  const { out, rerender } = await foldHook(t, rows);
  // Many toggles, half of them back to the base state.
  for (let index = 0; index < 3000; index += 1) {
    act(() => out.fold.toggleCollapsed(rows[index].id));
    if (index % 2) act(() => out.fold.toggleCollapsed(rows[index].id));
  }
  const reads = instrument(rows);
  act(() => out.fold.toggleCollapsed(rows[FILES - 1].id));
  await rerender();
  assert.ok(reads.count < 100, `a toggle and a render read ${reads.count} row fields`);
  assert.equal(out.fold.isFolded(rows[FILES - 1]), true);
  assert.equal(out.fold.isFolded(rows[1]), false, 'toggled back');
  assert.equal(out.fold.isFolded(rows[2]), true);
});

test('recheck 4: one relative path under two roots folds each file on its own and counts both', async (t) => {
  const rows = [
    { id: 'C:/a/src/x.ts', path: 'src/x.ts', status: 'M', additions: 1, deletions: 1, parts: [] },
    { id: 'C:/b/src/x.ts', path: 'src/x.ts', status: 'M', additions: 1, deletions: 1, parts: [] },
  ];
  const { out } = await foldHook(t, rows);
  const collapseAll = () => out.fold.collapseActions.find((action) => action.id === 'collapse-all');
  act(() => out.fold.toggleCollapsed(rows[0].id));
  assert.equal(out.fold.isFolded(rows[0]), true);
  assert.equal(out.fold.isFolded(rows[1]), false, 'the other root’s file stays open');
  assert.equal(collapseAll().disabled, false);
  act(() => out.fold.toggleCollapsed(rows[1].id));
  assert.equal(collapseAll().disabled, true, 'both are folded');
});

test('recheck 5: a pane render reads no file for the patch byte sum', async (t) => {
  const view = dom(t);
  const { useSessionChangePatches } = await import('./session-changes-store.ts');
  const rows = paths(100).map((path) => ({
    id: path,
    path,
    status: 'M',
    additions: 1,
    deletions: 1,
    parts: [{ patch: patchFor(path) }],
    reason: '',
  }));
  let rerender;
  const state = {};
  function Pane() {
    const [, set] = React.useState(0);
    rerender = () => set((value) => value + 1);
    state.patches = useSessionChangePatches({ cwd: undefined, sessionId: 'r5-bytes', rows, selectedId: '' });
    return null;
  }
  await act(async () => view.root.render(h(Pane)));
  assert.equal(state.patches.capped, false);
  const reads = instrument(rows);
  await act(async () => rerender());
  assert.ok(reads.count < 20, `a render read ${reads.count} row fields`);
});
