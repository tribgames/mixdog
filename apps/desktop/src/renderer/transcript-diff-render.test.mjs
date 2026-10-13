import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';

test('a call diff draws the changes pane rows; a re-render keeps rows and selection while copy and changed patches stay current', async (t) => {
  const { root, document, window } = installTestDom(t, {
    rootId: 'root',
    jsdom: { pretendToBeVisual: true },
    expose: ['navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver'],
  });
  const copied = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      async writeText(text) {
        copied.push(text);
      },
    },
  });
  const { CodeDiff } = await import('./transcript-diff');
  const patchFor = (prefix) =>
    'diff --git a/sample.ts b/sample.ts\n--- a/sample.ts\n+++ b/sample.ts\n@@ -1,20 +1,20 @@\n' +
    Array.from({ length: 20 }, (_, index) => `-const before${index} = ${index};`).join('\n') +
    '\n' +
    Array.from({ length: 20 }, (_, index) => `+const ${prefix}${index} = ${index + 1};`).join('\n') +
    '\n';
  const patch = patchFor('after');
  await act(async () => root.render(React.createElement(CodeDiff, { patch })));
  // The same renderer as the session changes pane: one number column, a sign
  // column, then code.
  const diff = document.querySelector('.code-diff .inline-diff');
  assert.ok(diff);
  assert.match(diff.textContent, /before19/);
  assert.match(diff.textContent, /after19/);
  const rows = [...diff.querySelectorAll('.inline-diff-row')];
  assert.equal(rows.length, 40);
  assert.deepEqual(
    [
      rows[0].dataset.kind,
      rows[0].querySelector('.inline-diff-ln').textContent,
      rows[0].querySelector('.inline-diff-mk').textContent,
    ],
    ['del', '1', '\u2212']
  );
  assert.deepEqual([rows[20].dataset.kind, rows[20].querySelector('.inline-diff-mk').textContent], ['add', '+']);
  const text = diff.textContent;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(rows[0]);
  selection.removeAllRanges();
  selection.addRange(range);
  const selectedText = selection.toString();
  assert.ok(selectedText);
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => root.render(React.createElement(CodeDiff, { patch: `${patch}` })));
    assert.equal(document.querySelector('.code-diff .inline-diff'), diff);
    assert.equal(diff.textContent, text);
    assert.equal(selection.toString(), selectedText);
  }
  await act(async () => document.querySelector('.diff-copy').click());
  assert.equal(copied.at(-1).trim(), patch.trim());
  const updated = patchFor('revised');
  await act(async () => root.render(React.createElement(CodeDiff, { patch: updated })));
  assert.match(document.querySelector('.code-diff .inline-diff').textContent, /revised19/);
  assert.doesNotMatch(document.querySelector('.code-diff .inline-diff').textContent, /after19/);
  await act(async () => document.querySelector('.diff-copy').click());
  assert.equal(copied.at(-1).trim(), updated.trim());
});

test('a rangeless V4A @@ header draws no bogus context row and keeps changed-line numbers', async (t) => {
  const { root, document } = installTestDom(t, {
    rootId: 'root',
    jsdom: { pretendToBeVisual: true },
    expose: ['navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver'],
  });
  const { CodeDiff } = await import('./transcript-diff');
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@\n keep\n-old\n+new\n';
  await act(async () => root.render(React.createElement(CodeDiff, { patch })));
  const rows = [...document.querySelectorAll('.code-diff .inline-diff-row')];
  assert.deepEqual(
    rows.map((row) => [row.dataset.kind, row.querySelector('.inline-diff-ln').textContent]),
    [
      ['ctx', '1'],
      ['del', '2'],
      ['add', '2'],
    ]
  );
  assert.doesNotMatch(document.querySelector('.code-diff .inline-diff').textContent, /@/);
});

test('capPatchLines keeps a cut patch parseable and drops hunk-less trailing files', async () => {
  const { capPatchLines, parseUnifiedDiff } = await import('./renderer-logic.mjs');
  const outside =
    'diff --git a/C:/Users/t/Temp/outside-note.txt b/C:/Users/t/Temp/outside-note.txt\nnew file mode 100644\n--- /dev/null\n+++ b/C:/Users/t/Temp/outside-note.txt\n@@ -0,0 +1,1 @@\n+Single line of text\n\\ No newline at end of file';
  const note =
    'diff --git a/note.txt b/note.txt\nnew file mode 100644\n--- /dev/null\n+++ b/note.txt\n@@ -0,0 +1,3 @@\n+First line\n+Second line\n+Third line';
  const parsed = parseUnifiedDiff(outside);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].renderable, true);
  assert.equal(parsed[0].status, 'A');
  const both = `${outside}\n${note}`;
  // Markers are not drawn rows: 6 rows of the first file, then the second's
  // 4 header rows and its hunk header would leave that hunk bodiless.
  assert.equal(capPatchLines(both, 11).text, outside);
  const partial = capPatchLines(both, 12);
  assert.equal(partial.cut, true);
  assert.match(partial.text, /@@ -0,0 \+1,1 @@\n\+First line$/);
  // A cut at the next file's header never counts that header as hunk rows:
  // the first file stays whole, the second file's partial header goes.
  const fileA = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n-x\n+y\n z';
  const fileB = 'diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-p\n+q';
  for (const max of [7, 8, 9, 10]) {
    assert.deepEqual(capPatchLines(`${fileA}\n${fileB}`, max), { text: fileA, cut: true }, `cap ${max}`);
  }
  assert.equal(
    capPatchLines(`${fileA}\n${fileB}`, 12).text,
    `${fileA}\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,1 +1,0 @@\n-p`
  );
  // A plain patch without git headers is cut the same way.
  const plain = '--- a/c\n+++ b/c\n@@ -1 +1 @@\n-1\n+2\n--- a/d\n+++ b/d\n@@ -1 +1 @@\n-3\n+4';
  assert.equal(capPatchLines(plain, 6).text, '--- a/c\n+++ b/c\n@@ -1 +1 @@\n-1\n+2');
  for (const { patch } of [{ patch: partial.text }]) assert.equal(parseUnifiedDiff(patch).length, 2);
  assert.deepEqual(capPatchLines(note, 40), { text: note, cut: false });
  // A "\ No newline" marker is not a drawn row: 14 drawn rows fit a cap of 14.
  assert.deepEqual(capPatchLines(both, 14), { text: both, cut: false });
});
