/**
 * Row-height measurement lockstep with Markdown.jsx / StreamingMarkdown.jsx.
 */
import stripAnsi from 'strip-ansi';
import { displayWidth } from '../display-width.mjs';
import { assistantBodyWidth, measureMarkdownTableRows } from './table-layout.mjs';
import { renderTokenAnsiSegments } from './render-ansi.mjs';
import { resolveStreamingMarkdownParts } from './streaming-markdown.mjs';

function wrappedLineRows(line, width) {
  const text = String(line);
  const full = displayWidth(text);
  if (full === 0) return 1;
  if (full <= width) return 1;
  let rows = 1;
  let col = 0;
  for (const token of text.split(/(\s+)/)) {
    if (!token) continue;
    const tw = displayWidth(token);
    if (tw === 0) continue;
    if (tw > width) {
      if (col > 0) { rows++; col = 0; }
      rows += Math.ceil(tw / width) - 1;
      col = tw % width || width;
      continue;
    }
    if (col + tw > width) { rows++; col = tw; }
    else { col += tw; }
  }
  return Math.max(1, rows);
}

function estimateWrappedRowsFallback(text, columns, reserve = 3) {
  const width = Math.max(8, Number(columns || 80) - reserve);
  const lines = String(text ?? '').split('\n');
  return Math.max(1, lines.reduce((sum, line) => sum + wrappedLineRows(line, width), 0));
}

export function measureMarkdownRenderedRows(text, columns, { trimPartialFences = false } = {}) {
  const value = String(text ?? '');
  if (!value) return 1;
  const bodyWidth = assistantBodyWidth(columns);
  let segments;
  try {
    segments = renderTokenAnsiSegments(value, { width: bodyWidth, trimPartialFences });
  } catch {
    return Math.max(1, estimateWrappedRowsFallback(value, columns, 3));
  }
  if (!segments.length) return 1;
  let rows = 0;
  for (const seg of segments) {
    if (seg.type === 'table') {
      rows += Math.max(1, measureMarkdownTableRows(seg.token, bodyWidth));
      continue;
    }
    const plain = stripAnsi(String(seg.ansi ?? ''));
    for (const line of plain.split('\n')) {
      rows += wrappedLineRows(line, bodyWidth);
    }
  }
  rows += segments.length - 1;
  return Math.max(1, rows);
}

export function measureStreamingMarkdownRenderedRows(text, columns, streamKey) {
  const value = String(text ?? '');
  if (!value) return 1;
  const parts = resolveStreamingMarkdownParts(value, streamKey);
  if (parts.plain) {
    return estimateWrappedRowsFallback(parts.unstableForRender, columns, 3);
  }
  let rows = 0;
  let childCount = 0;
  if (parts.stablePrefix) {
    rows += measureMarkdownRenderedRows(parts.stablePrefix, columns, { trimPartialFences: false });
    childCount += 1;
  }
  if (parts.unstableSuffix) {
    rows += measureMarkdownRenderedRows(parts.unstableForRender, columns, { trimPartialFences: true });
    childCount += 1;
  }
  if (childCount === 2) rows += 1;
  if (childCount === 0) return 1;
  return Math.max(1, rows);
}
