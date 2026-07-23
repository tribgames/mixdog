/**
 * Row-height measurement lockstep with Markdown.jsx / StreamingMarkdown.jsx.
 */
import stripAnsi from 'strip-ansi';
import { displayWidth } from '../display-width.mjs';
import { assistantBodyWidth, measureMarkdownTableRows } from './table-layout.mjs';
import { renderTokenAnsiSegments } from './render-ansi.mjs';
import { resolveStreamingMarkdownParts } from './streaming-markdown.mjs';

// One latest measurement per live stream. The small LRU bound mirrors the
// streaming-markdown split caches: completed/abandoned stream ids cannot make
// this module retain an unbounded response history.
const streamingRowsByKey = new Map();
const STREAMING_ROWS_LRU_MAX = 32;

function cacheStreamingRows(key, entry) {
  if (!key) return;
  if (streamingRowsByKey.has(key)) streamingRowsByKey.delete(key);
  streamingRowsByKey.set(key, entry);
  while (streamingRowsByKey.size > STREAMING_ROWS_LRU_MAX) {
    const oldest = streamingRowsByKey.keys().next().value;
    if (oldest === undefined) break;
    streamingRowsByKey.delete(oldest);
  }
}

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

function measureStreamingPartsUncached(parts, columns) {
  if (parts.plain) {
    return estimateWrappedRowsFallback(parts.unstableForRender, columns, 3);
  }
  let rows = 0;
  let childCount = 0;
  const stableChunks = parts.stableChunks?.length
    ? parts.stableChunks
    : parts.stablePrefix ? [parts.stablePrefix] : [];
  for (const chunk of stableChunks) {
    if (childCount > 0) rows += 1;
    rows += measureMarkdownRenderedRows(chunk, columns, { trimPartialFences: false });
    childCount += 1;
  }
  if (parts.unstableSuffix) {
    if (childCount > 0) rows += 1;
    rows += measureMarkdownRenderedRows(parts.unstableForRender, columns, { trimPartialFences: true });
    childCount += 1;
  }
  return childCount === 0 ? 1 : Math.max(1, rows);
}

// Test/reference path: resolve the same renderer split, but deliberately bypass
// streamingRowsByKey and remeasure every rendered child from scratch.
export function measureStreamingMarkdownRenderedRowsUncached(text, columns, streamKey) {
  const value = String(text ?? '');
  if (!value) return 1;
  return measureStreamingPartsUncached(resolveStreamingMarkdownParts(value, streamKey), columns);
}

export function measureStreamingMarkdownRenderedRows(text, columns, streamKey) {
  const value = String(text ?? '');
  const key = streamKey == null || streamKey === '' ? null : String(streamKey);
  const cached = key ? streamingRowsByKey.get(key) : null;
  // Check the exact render inputs before even resolving markdown parts. App
  // renders caused by typing or overlays therefore do no wrapping/token work
  // when the live tail itself did not change.
  if (cached && cached.text === value && cached.columns === columns) {
    cacheStreamingRows(key, cached);
    return cached.rows;
  }
  if (!value) {
    cacheStreamingRows(key, {
      text: value,
      columns,
      mode: 'empty',
      rows: 1,
    });
    return 1;
  }
  const parts = resolveStreamingMarkdownParts(value, streamKey);
  if (parts.plain) {
    const plain = parts.unstableForRender;
    const width = Math.max(8, Number(columns || 80) - 3);
    const lastBreak = plain.lastIndexOf('\n');
    const stablePrefix = lastBreak >= 0 ? plain.substring(0, lastBreak + 1) : '';
    let stableRows = 0;
    if (cached
      && cached.mode === 'plain'
      && cached.columns === columns
      && stablePrefix.startsWith(cached.stablePrefix)) {
      // Lines preceding the currently-growing final line wrap independently.
      // Measure only complete lines added since the previous split.
      const addedComplete = plain.substring(cached.stablePrefix.length, Math.max(cached.stablePrefix.length, lastBreak));
      stableRows = cached.stableRows;
      if (addedComplete) {
        stableRows += addedComplete
          .split('\n')
          .reduce((sum, line) => sum + wrappedLineRows(line, width), 0);
      }
    } else if (lastBreak >= 0) {
      stableRows = plain
        .substring(0, lastBreak)
        .split('\n')
        .reduce((sum, line) => sum + wrappedLineRows(line, width), 0);
    }
    const finalLine = lastBreak >= 0 ? plain.substring(lastBreak + 1) : plain;
    const rows = Math.max(1, stableRows + wrappedLineRows(finalLine, width));
    cacheStreamingRows(key, {
      text: value,
      columns,
      mode: 'plain',
      stablePrefix,
      stableRows,
      rows,
    });
    return rows;
  }
  let rows = 0;
  let childCount = 0;
  let stableRows = 0;
  const stableChunks = parts.stableChunks?.length
    ? parts.stableChunks
    : parts.stablePrefix ? [parts.stablePrefix] : [];
  const reusableChunks = cached
    && cached.mode === 'markdown'
    && cached.columns === columns
    && Array.isArray(cached.stableChunks)
    && cached.stableChunks.length <= stableChunks.length
    && cached.stableChunks.every((chunk, index) => chunk === stableChunks[index]);
  let measuredStableChunks = 0;
  if (reusableChunks) {
    stableRows = cached.stableRows;
    measuredStableChunks = cached.stableChunks.length;
  }
  for (let index = measuredStableChunks; index < stableChunks.length; index += 1) {
    if (index > 0) stableRows += 1;
    stableRows += measureMarkdownRenderedRows(stableChunks[index], columns, { trimPartialFences: false });
  }
  rows += stableRows;
  childCount = stableChunks.length;
  if (parts.unstableSuffix) {
    if (childCount > 0) rows += 1;
    rows += measureMarkdownRenderedRows(parts.unstableForRender, columns, { trimPartialFences: true });
    childCount += 1;
  }
  const measuredRows = childCount === 0 ? 1 : Math.max(1, rows);
  cacheStreamingRows(key, {
    text: value,
    columns,
    mode: 'markdown',
    stablePrefix: parts.stablePrefix,
    stableChunks: stableChunks.slice(),
    stableRows,
    rows: measuredRows,
  });
  return measuredRows;
}
