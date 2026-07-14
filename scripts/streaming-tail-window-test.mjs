import test from 'node:test';
import assert from 'node:assert/strict';

import {
  windowPlainStreamingText,
} from '../src/tui/markdown/streaming-markdown.mjs';
import {
  measureStreamingMarkdownRenderedRows,
} from '../src/tui/markdown/measure-rendered-rows.mjs';

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
