import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { SessionDiffPane } from './SessionDiffPane.tsx';
import { requestSessionDiffFile } from './session-diff-focus.ts';
import { setSessionChangesSource } from './session-changes-store.ts';
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
  [...scope.querySelectorAll('[data-scm-spacer]')].reduce((sum, spacer) => sum + Number.parseFloat(spacer.style.height), 0);

// ── The composer chip's files menu ──────────────────────────────────────

async function openMenu(t, count, onOpenFile = () => {}) {
  const view = dom(t);
  const files = new Map(
    Array.from({ length: count }, (_, index) => [`src/f${index}.ts`, { additions: 1, deletions: 1, lineStats: true }])
  );
  await act(async () =>
    view.root.render(
      h(
        TurnReviewFilesMenu,
        {
          sessionId: `menu-${count}`,
          historyTurns: 1,
          label: 'Uncommitted',
          title: `Files ${count}`,
          files,
          onViewChanges() {},
          onOpenFile,
        },
        'Files'
      )
    )
  );
  await act(async () => view.document.querySelector('.turn-review-segment').click());
  const list = view.document.querySelector('.turn-review-files-list');
  const rows = () => [...list.querySelectorAll('.turn-review-files-row')];
  return { view, list, rows };
}

test('the files menu mounts only the rows near its viewport, whatever the file count', async (t) => {
  const mounted = [];
  for (const count of [200, 9000]) {
    await t.test(`${count} files`, async (st) => {
      const { list, rows } = await openMenu(st, count);
      mounted.push(rows().length);
      assert.ok(rows().length < 200, `${count} files mount a window, not every row`);
      assert.equal(rows()[0].getAttribute('aria-setsize'), String(count + 2), 'every file and the two actions');
      // The spacers stand in for every unmounted row at its height.
      assert.equal(spacerHeight(list) + rows().length * 26, count * 26);
    });
  }
  assert.equal(mounted[0], mounted[1], 'the mounted rows do not grow with the file count');
});

test('a key press reaches a files-menu row outside the window, and that row opens its file', async (t) => {
  const opened = [];
  const { view, list, rows } = await openMenu(t, 9000, (path) => opened.push(path));
  const press = (key) =>
    act(async () =>
      view.document.activeElement.dispatchEvent(new view.window.KeyboardEvent('keydown', { key, bubbles: true }))
    );
  assert.equal(view.document.activeElement, rows()[0], 'the first row takes focus on open');
  await press('End');
  assert.equal(view.document.activeElement.textContent, 'View changes');
  await press('ArrowUp');
  await press('ArrowUp');
  const last = view.document.activeElement;
  assert.equal(last.dataset.index, '8999', 'the last file row, mounted for the key press');
  assert.equal(last.title, 'src/f8999.ts');
  assert.equal(last.getAttribute('aria-posinset'), '9000');
  assert.ok(list.scrollTop >= 8999 * 26 - 26, 'the list scrolled to it');
  await press('Home');
  assert.equal(view.document.activeElement.dataset.index, '0');
  await press('ArrowUp');
  assert.equal(view.document.activeElement.textContent, 'View changes', 'Up from the first row wraps to the end');
  await press('ArrowUp');
  await press('ArrowUp');
  await act(async () => view.document.activeElement.click());
  assert.deepEqual(opened, ['src/f8999.ts']);
});

// ── The Changes dock ────────────────────────────────────────────────────

async function mountPane(t, count, sessionId) {
  const view = dom(t);
  const cwd = `C:/${sessionId}`;
  const paths = Array.from({ length: count }, (_, index) => `src/f${index}.ts`);
  const batches = [];
  view.window.mixdogDesktop = {
    gitReview: async () => ({
      repository: true,
      root: cwd,
      base: 'HEAD',
      files: paths.map((path) => ({ path, status: 'M', additions: 1, deletions: 1, untracked: false })),
    }),
    gitReviewDiffs: async (_cwd, files) => {
      batches.push(files.map((file) => file.path));
      return { patches: files.map((file) => ({ path: file.path, patch: patchFor(file.path) })), omitted: [] };
    },
    invokeCapability: async () => ({ value: null }),
  };
  setSessionChangesSource('uncommitted');
  await act(async () => view.root.render(h(SessionDiffPane, { sessionId, cwd, active: true, onClose() {} })));
  await settle();
  const stack = () => view.document.querySelector('.session-diff-stack');
  const sections = () => [...view.document.querySelectorAll('.session-diff-section')];
  const scrollTo = (top) =>
    act(() => {
      stack().scrollTop = top;
      stack().dispatchEvent(new view.window.Event('scroll'));
    });
  return { view, paths, batches, stack, sections, scrollTo };
}

test('the Changes stack mounts only the sections near its viewport, whatever the file count', async (t) => {
  const mounted = [];
  for (const count of [300, 9000]) {
    await t.test(`${count} files`, async (st) => {
      const { stack, sections } = await mountPane(st, count, `stack-${count}`);
      mounted.push(sections().length);
      assert.ok(sections().length < 100, `${count} files mount a window, not every section`);
      assert.equal(stack().getAttribute('role'), 'list');
      assert.equal(sections()[0].getAttribute('aria-setsize'), String(count));
      // The unmounted files keep their height: the scroll extent covers the list.
      assert.ok(spacerHeight(stack()) >= (count - sections().length) * 34);
    });
  }
  assert.equal(mounted[0], mounted[1], 'the mounted sections do not grow with the file count');
});

test('scrolling the stack mounts the files there, and the focused header stays mounted', async (t) => {
  const { view, sections, scrollTo } = await mountPane(t, 9000, 'stack-scroll');
  const header = sections()[0].querySelector('.session-diff-section-title');
  act(() => header.focus());
  // The first (selected) file is unfolded; every other header is 34px.
  scrollTo(8000 * 34);
  // The scroll settles (the window's scrolling state resets).
  await settle();
  const paths = sections().map((section) => section.dataset.sessionDiffPath);
  assert.ok(paths.includes('src/f8000.ts'), 'the scrolled-to file is mounted');
  assert.equal(paths[0], 'src/f0.ts', 'the focused file stays mounted');
  assert.ok(sections().length < 100);
  assert.equal(view.document.activeElement, header, 'focus never falls to the document');
});

test('a file request for a file outside the window opens that file', async (t) => {
  const { view, batches, sections } = await mountPane(t, 9000, 'stack-reveal');
  await act(async () => requestSessionDiffFile('stack-reveal', 'src/f8999.ts'));
  await settle();
  assert.deepEqual(
    sections().map((section) => section.dataset.sessionDiffPath),
    ['src/f8999.ts']
  );
  assert.ok(batches.flat().includes('src/f8999.ts'), 'its patch is read');
  assert.ok(view.document.querySelector('.session-diff-section .inline-diff'), 'and drawn');
});
