import test from 'node:test';
import assert from 'node:assert/strict';

import {
  windowPlainStreamingText,
} from '../src/tui/markdown/streaming-markdown.mjs';
import {
  findOpenFenceStart,
  resetOpenFenceScan,
} from '../src/tui/markdown/stream-fence.mjs';
import {
  measureStreamingMarkdownRenderedRows,
  measureStreamingMarkdownRenderedRowsUncached,
} from '../src/tui/markdown/measure-rendered-rows.mjs';
import {
  buildTranscriptRowIndex,
  streamingRowEstimateStateForId,
  streamingEstimateRows,
  transcriptRenderWindow,
} from '../src/tui/app/transcript-window.mjs';

function assertCachedEqualsDirect(text, columns, key) {
  const cached = measureStreamingMarkdownRenderedRows(text, columns, key);
  const direct = measureStreamingMarkdownRenderedRowsUncached(text, columns, key);
  assert.equal(cached, direct);
  return cached;
}

test('bottom-pinned plain streaming text keeps only the visible suffix', () => {
  const lines = Array.from({ length: 100 }, (_, index) => `plain line ${index}`);
  const full = lines.join('\n');
  const windowed = windowPlainStreamingText(full, 80, 12);

  assert.equal(windowed, lines.slice(-12).join('\n'));
  assert.ok(measureStreamingMarkdownRenderedRows(full, 83, 'plain-window-full') > 12);
});

test('markdown streaming text is never internally windowed', () => {
  const markdown = `${'plain history\n'.repeat(100)}**live markdown**`;
  assert.equal(windowPlainStreamingText(markdown, 80, 12), markdown.trim());
});

test('wrapped plain lines consume the streaming row budget', () => {
  const lines = ['old', 'x'.repeat(160), 'new'];
  assert.equal(windowPlainStreamingText(lines.join('\n'), 80, 2), lines.slice(-1).join('\n'));
  assert.equal(windowPlainStreamingText(lines.join('\n'), 80, 3), lines.slice(-2).join('\n'));
});

test('plain streaming window preserves suffix output across incremental appends', () => {
  const key = 'plain-window-incremental';
  const before = Array.from({ length: 500 }, (_, index) => `plain line ${index}`).join('\n');
  const after = `${before}\nplain line 500`;
  assert.equal(
    windowPlainStreamingText(before, 80, 8, key),
    before.split('\n').slice(-8).join('\n'),
  );
  assert.equal(
    windowPlainStreamingText(after, 80, 8, key),
    after.split('\n').slice(-8).join('\n'),
  );
});

test('open fence scan preserves results across append, close, and regression', () => {
  const key = 'incremental-open-fence';
  assert.equal(findOpenFenceStart('intro', key), null);
  assert.deepEqual(findOpenFenceStart('intro\n\n```js\nconst a = 1;', key), {
    index: 7,
    lang: 'js',
  });
  assert.deepEqual(findOpenFenceStart('intro\n\n```js\nconst a = 1;\nconst b = 2;', key), {
    index: 7,
    lang: 'js',
  });
  assert.equal(findOpenFenceStart('intro\n\n```js\nconst a = 1;\n```', key), null);
  assert.deepEqual(findOpenFenceStart('```powershell\nGet-ChildItem', key), {
    index: 0,
    lang: 'powershell',
  });
  resetOpenFenceScan(key);
});

test('streaming row memo preserves plain append and resize measurements', () => {
  const key = 'plain-row-memo';
  const before = 'alpha\nbeta '.concat('x'.repeat(80));
  const after = `${before}\ngamma ${'y'.repeat(120)}`;

  assertCachedEqualsDirect(before, 40, key);
  assertCachedEqualsDirect(after, 40, key);
  assertCachedEqualsDirect(after, 24, key);
});

test('streaming row memo preserves markdown stable-prefix measurements', () => {
  const key = 'markdown-row-memo';
  const before = '# Heading\n\nSettled paragraph.\n\n**live';
  const after = `${before} suffix**`;

  assertCachedEqualsDirect(before, 48, key);
  assertCachedEqualsDirect(after, 48, key);
  assert.equal(
    measureStreamingMarkdownRenderedRows(after, 48, key),
    measureStreamingMarkdownRenderedRowsUncached(after, 48, key),
  );
});

test('streaming row memo preserves fences, lists, and tables', () => {
  const cases = [
    ['fence', ['# Intro\n\n```js\nconst value = 1;', '# Intro\n\n```js\nconst value = 1;\nconsole.log(value);']],
    ['list', ['- first item\n- second', '- first item\n- second item with wrapped detail '.repeat(3)]],
    ['table', ['| A | B |\n| - | - |\n| one | two |', '| A | B |\n| - | - |\n| one | two |\n| three | four |']],
  ];
  for (const [name, values] of cases) {
    for (const value of values) assertCachedEqualsDirect(value, 36, `shape-${name}`);
  }
});

test('render-mode changes reset the streaming estimate high-water', () => {
  const id = 'render-mode-flip';
  streamingEstimateRows({
    id,
    kind: 'assistant',
    streaming: false,
    text: 'large settled markdown paragraph '.repeat(80),
  }, 24, false);
  const flipped = streamingEstimateRows({
    id,
    kind: 'assistant',
    streaming: true,
    text: 'short',
  }, 24, false);
  const fresh = streamingEstimateRows({
    id: 'render-mode-fresh',
    kind: 'assistant',
    streaming: true,
    text: 'short',
  }, 24, false);
  assert.equal(flipped, fresh);
});

test('stream estimate LRU evicts tail and high-water state in lockstep', () => {
  const id = 'lru-evicted-stream';
  streamingEstimateRows({
    id,
    kind: 'assistant',
    streaming: true,
    text: 'long streaming response '.repeat(80),
  }, 24, false);
  assert.deepEqual(streamingRowEstimateStateForId(id), {
    tailEstimate: true,
    highWater: true,
  });

  // Production cleanup when no measured-height layout effect runs: admitting
  // eight newer stream ids evicts this oldest id from the bounded estimate LRU.
  for (let index = 0; index < 8; index++) {
    streamingEstimateRows({
      id: `lru-newer-${index}`,
      kind: 'assistant',
      streaming: true,
      text: `newer ${index}`,
    }, 24, false);
  }
  assert.deepEqual(streamingRowEstimateStateForId(id), {
    tailEstimate: false,
    highWater: false,
  });

  // Reusing the evicted id must start from its new response, not retain the
  // much taller high-water geometry from the aborted stream above.
  const reused = streamingEstimateRows({
    id,
    kind: 'assistant',
    streaming: true,
    text: 'short',
  }, 24, false);
  const fresh = streamingEstimateRows({
    id: 'lru-evicted-stream-fresh',
    kind: 'assistant',
    streaming: true,
    text: 'short',
  }, 24, false);
  assert.equal(reused, fresh);
});

test('cached tail rows preserve rendered-window bytes', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({
    id: `notice-${index}`,
    kind: 'notice',
    text: `notice ${index}`,
  }));
  const tail = {
    id: 'window-byte-tail',
    kind: 'assistant',
    streaming: true,
    text: '# Result\n\n- first\n- second\n\n| A | B |\n| - | - |\n| one | two |',
  };
  const allItems = [...items, tail];
  const cachedIndex = buildTranscriptRowIndex(allItems, { columns: 36 });
  const directTailRows = 1 + measureStreamingMarkdownRenderedRowsUncached(tail.text, 36, tail.id);
  const directRows = [...cachedIndex.rows.slice(0, -1), directTailRows];
  const directPrefix = [0];
  for (const rows of directRows) directPrefix.push(directPrefix.at(-1) + rows);
  const directIndex = {
    rows: directRows,
    prefixRows: directPrefix,
    totalRows: directPrefix.at(-1),
  };
  const options = { scrollOffset: 4, viewportHeight: 8, columns: 36 };
  assert.equal(
    JSON.stringify(transcriptRenderWindow(allItems, { ...options, rowIndex: cachedIndex })),
    JSON.stringify(transcriptRenderWindow(allItems, { ...options, rowIndex: directIndex })),
  );
});
