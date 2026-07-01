import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantBodyWidth } from './table-layout.mjs';
import {
  measureMarkdownRenderedRows,
  measureStreamingMarkdownRenderedRows,
} from './measure-rendered-rows.mjs';
import { resolveStreamingMarkdownParts, streamingLayoutText } from './streaming-markdown.mjs';
import { setThemeSetting } from '../theme.mjs';

setThemeSetting('basic', { persist: false });

function measureStreamingLayoutFromParts(text, columns, streamKey) {
  const parts = resolveStreamingMarkdownParts(text, streamKey);
  if (parts.plain) {
    return measureMarkdownRenderedRows(text, columns);
  }
  let rows = 0;
  let childCount = 0;
  if (parts.stablePrefix) {
    rows += measureMarkdownRenderedRows(parts.stablePrefix, columns);
    childCount += 1;
  }
  if (parts.unstableSuffix) {
    rows += measureMarkdownRenderedRows(parts.unstableForRender, columns, { trimPartialFences: true });
    childCount += 1;
  }
  if (childCount === 2) rows += 1;
  return Math.max(1, rows);
}

test('streaming row estimate matches shared layout parts at body width', () => {
  const columns = 40;
  const bodyWidth = assistantBodyWidth(columns);
  const cases = [
    { key: 'bold-wrap', text: `**${'m'.repeat(bodyWidth + 12)}` },
    { key: 'partial-fence', text: `\`\`\`js\n${'w'.repeat(bodyWidth + 6)}\n\`` },
  ];
  for (const { key, text } of cases) {
    const estimate = measureStreamingMarkdownRenderedRows(text, columns, key);
    const layout = measureStreamingLayoutFromParts(text, columns, key);
    assert.strictEqual(estimate, layout, `${key}: estimate must match render layout parts`);
  }
});

test('partial code fence streaming measure uses trimPartialFences on unstable suffix', () => {
  const columns = 48;
  const bodyWidth = assistantBodyWidth(columns);
  const streamKey = 'test-stream-fence';
  const text = `\`\`\`js\n${'n'.repeat(bodyWidth + 8)}\n\``;
  const estimate = measureStreamingMarkdownRenderedRows(text, columns, streamKey);
  const parts = resolveStreamingMarkdownParts(text, streamKey);
  const manual = measureMarkdownRenderedRows(parts.unstableForRender, columns, { trimPartialFences: true });
  assert.strictEqual(estimate, Math.max(1, manual));
});

test('leading blank lines do not create an empty stable child or extra gap row', () => {
  const columns = 40;
  const streamKey = 'test-leading-blank';
  const raw = '\n\n**streaming body**';
  const trimmed = streamingLayoutText(raw);
  const parts = resolveStreamingMarkdownParts(raw, streamKey);
  assert.strictEqual(parts.stablePrefix, '', 'leading newlines must not promote whitespace-only stable');
  assert.ok(parts.unstableSuffix.includes('streaming body'));
  const estimate = measureStreamingMarkdownRenderedRows(raw, columns, streamKey);
  const trimmedEstimate = measureStreamingMarkdownRenderedRows(trimmed, columns, streamKey);
  assert.strictEqual(estimate, trimmedEstimate, 'raw vs trimmed leading newlines must match');
  const layout = measureStreamingLayoutFromParts(raw, columns, streamKey);
  assert.strictEqual(estimate, layout);
});
