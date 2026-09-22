/**
 * markdown/table-layout.mjs — pure GFM table layout calculation (no JSX/ink).
 *
 * This is the SINGLE SOURCE OF TRUTH for how a marked `table` token is laid out
 * into terminal lines. Both the renderer (components/MarkdownTable.jsx) and the
 * row-height estimator (App.jsx) call `buildTableRender` so the visible line
 * count and the estimated line count can never drift (lockstep).
 *
 * `buildTableRender(token, terminalWidth)` returns the exact array of strings
 * the component draws (`<Text>{lines.join('\n')}</Text>`); the component renders
 * those verbatim (no visual change) and the estimator measures `lines.length`.
 *
 * Pure + deterministic: same (token, terminalWidth) → same output. No hooks,
 * no time/random/global state — `terminalWidth` is always passed in by the
 * caller (the component resolves it from useStdout()/forceWidth).
 */
import stripAnsi from 'strip-ansi';
import { wrapText } from './ansi-line-wrap.mjs';
import { displayWidth } from '../display-width.mjs';
import { renderBorderLine, renderRowLines } from './table-layout/box-lines.mjs';
import {
  MAX_ROW_LINES,
  SAFETY_MARGIN,
  calculateMaxRowLines,
  computeColumnWidths,
} from './table-layout/column-widths.mjs';
import { renderVerticalLines } from './table-layout/vertical-lines.mjs';

/** Assistant markdown body width — lockstep with Message.jsx / forceWidth. */
export function assistantBodyWidth(columns) {
  return Math.max(8, Number(columns || 80) - 3);
}

export { wrapText };

/**
 * Compute the full table render as an ordered array of terminal lines plus the
 * vertical-fallback flag. The logic mirrors the original MarkdownTable render
 * exactly: column fit (ideal / proportional shrink / hard wrap), vertical
 * fallback when a cell needs more than MAX_ROW_LINES, the bordered horizontal
 * box, and the post-build overflow re-fallback to vertical.
 */
export function buildTableRender(token, terminalWidth) {
  const width = Number(terminalWidth) || 80;
  // Steps 1-3 (min/ideal widths, available space, the fit): table-layout/column-widths.mjs.
  const { columnWidths, needsHardWrap } = computeColumnWidths(token, width);

  // Step 4: max row lines → decide vertical fallback.
  const useVerticalFormat = calculateMaxRowLines(token, columnWidths, needsHardWrap) > MAX_ROW_LINES;
  if (useVerticalFormat) {
    return { lines: renderVerticalLines(token, width), useVerticalFormat: true };
  }

  const box = { token, columnWidths, needsHardWrap };
  const tableLines = [];
  tableLines.push(renderBorderLine('top', columnWidths));
  tableLines.push(...renderRowLines(token.header, true, box));
  tableLines.push(renderBorderLine('middle', columnWidths));
  token.rows.forEach((row, rowIndex) => {
    tableLines.push(...renderRowLines(row, false, box));
    if (rowIndex < token.rows.length - 1) tableLines.push(renderBorderLine('middle', columnWidths));
  });
  tableLines.push(renderBorderLine('bottom', columnWidths));

  // Safety: if any line would overflow (resize race), fall back to vertical.
  const maxLineWidth = Math.max(...tableLines.map((l) => displayWidth(stripAnsi(l))));
  if (maxLineWidth > width - SAFETY_MARGIN) {
    return { lines: renderVerticalLines(token, width), useVerticalFormat: true };
  }

  return { lines: tableLines, useVerticalFormat: false };
}

/**
 * Exact number of terminal lines a table token occupies once rendered at
 * `terminalWidth`. This is what MarkdownTable actually draws, so the row
 * estimator can reserve precisely that many rows (no top-clip, no slack).
 */
export function measureMarkdownTableRows(token, terminalWidth) {
  if (!token || !Array.isArray(token.header) || token.header.length === 0) return 0;
  return buildTableRender(token, terminalWidth).lines.length;
}
