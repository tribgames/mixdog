import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import stripAnsi from 'strip-ansi';
import { formatToken, looksLikeUnifiedDiff } from './format-token.mjs';
import { buildTableRender, measureMarkdownTableRows } from './table-layout.mjs';
import {
  resetAllStreamingMarkdownStablePrefixes,
  resetStreamingMarkdownStablePrefix,
  resolveStreamingMarkdownParts,
} from './streaming-markdown.mjs';

beforeEach(() => resetAllStreamingMarkdownStablePrefixes());

test('diff detection accepts hunk prefixes but still requires signed body lines', () => {
  const cases = [
    ['@@ -1 +1 @@\n-old\n+new', true],
    ['@@ incomplete\n+new', true],
    ['@@\n+new', false],
    ['@@ -1 +1 @@\n context', false],
    ['+++ b/file\n+new', true],
    ['-old\n+new', false],
    [' file.mjs | 2 +-', true],
    [' image.png | Bin 0 -> 10 bytes', true],
    [' 1 file changed, 1 insertion(+)', true],
  ];
  for (const [text, expected] of cases) {
    assert.equal(looksLikeUnifiedDiff(text), expected, text);
  }
});

test('list items keep first-line markers, continuation indentation and empty items', () => {
  for (const [text, expected] of [
    ['first\nsecond', '- first\n  second\n'],
    ['\nnext', '- \n  next\n'],
    ['', '-\n'],
  ]) {
    const token = { type: 'list_item', tokens: [{ type: 'text', text }] };
    assert.equal(stripAnsi(formatToken(token)), expected);
  }
});

test('narrow vertical tables preserve empty cells and exact row counts', () => {
  const cell = (text) => ({ tokens: [{ type: 'text', text }] });
  const token = {
    header: [cell('A'), cell('B')],
    rows: [
      [cell(''), cell('ok')],
      [cell('x'), cell('')],
    ],
    align: [],
  };
  const rendered = buildTableRender(token, 10);
  assert.equal(rendered.useVerticalFormat, true);
  assert.deepEqual(
    rendered.lines.map((line) => stripAnsi(line)),
    ['A:', 'B: ok', '─────────', 'A: x', 'B:']
  );
  assert.equal(measureMarkdownTableRows(token, 10), 5);
});

test('stream snapshots reuse normalized input and invalidate on regression and resets', () => {
  const key = 'snapshot';
  const source = 'Settled paragraph.\n\n```js\nconst value = 1;';
  const initial = resolveStreamingMarkdownParts(source, key);
  assert.deepEqual(initial, {
    plain: false,
    openFence: true,
    stablePrefix: 'Settled paragraph.\n\n',
    stableChunks: ['Settled paragraph.\n\n'],
    unstableSuffix: '```js\nconst value = 1;',
    unstableForRender: '```js\nconst value = 1;',
  });
  assert.strictEqual(resolveStreamingMarkdownParts(`\n${source}\n\n`, key), initial);

  const regressed = resolveStreamingMarkdownParts('plain text', key);
  assert.deepEqual(regressed, {
    plain: true,
    stablePrefix: '',
    stableChunks: [],
    unstableSuffix: 'plain text',
    unstableForRender: 'plain text',
  });
  const recomputed = resolveStreamingMarkdownParts(source, key);
  assert.notStrictEqual(recomputed, initial);
  assert.deepEqual(recomputed, initial);

  resetStreamingMarkdownStablePrefix(key);
  const reset = resolveStreamingMarkdownParts(source, key);
  assert.notStrictEqual(reset, recomputed);
  assert.deepEqual(reset, initial);
  resetAllStreamingMarkdownStablePrefixes();
  const resetAll = resolveStreamingMarkdownParts(source, key);
  assert.notStrictEqual(resetAll, reset);
  assert.deepEqual(resetAll, initial);
});

test('stream snapshots evict the oldest write, not a recently read snapshot', () => {
  const snapshots = [];
  for (let index = 0; index < 32; index += 1) {
    snapshots.push(resolveStreamingMarkdownParts(`plain ${index}`, `stream-${index}`));
  }
  const updated = resolveStreamingMarkdownParts('changed', 'stream-1');
  assert.strictEqual(resolveStreamingMarkdownParts('plain 0', 'stream-0'), snapshots[0]);
  resolveStreamingMarkdownParts('overflow', 'stream-32');
  assert.strictEqual(resolveStreamingMarkdownParts('changed', 'stream-1'), updated);
  assert.strictEqual(resolveStreamingMarkdownParts('plain 2', 'stream-2'), snapshots[2]);

  const evicted = resolveStreamingMarkdownParts('plain 0', 'stream-0');
  assert.notStrictEqual(evicted, snapshots[0]);
  assert.deepEqual(evicted, snapshots[0]);
  const nextEvicted = resolveStreamingMarkdownParts('plain 2', 'stream-2');
  assert.notStrictEqual(nextEvicted, snapshots[2]);
  assert.deepEqual(nextEvicted, snapshots[2]);
});

test('empty and unkeyed snapshots retain their value without sharing unkeyed identity', () => {
  const empty = resolveStreamingMarkdownParts('', 0);
  assert.deepEqual(empty, {
    plain: true,
    stablePrefix: '',
    stableChunks: [],
    unstableSuffix: '',
    unstableForRender: '',
  });
  assert.strictEqual(resolveStreamingMarkdownParts('\n', '0'), empty);

  for (const key of [undefined, null, '']) {
    const first = resolveStreamingMarkdownParts('plain text', key);
    const second = resolveStreamingMarkdownParts('plain text', key);
    assert.notStrictEqual(second, first);
    assert.deepEqual(second, {
      plain: true,
      stablePrefix: '',
      stableChunks: [],
      unstableSuffix: 'plain text',
      unstableForRender: 'plain text',
    });
  }
});
