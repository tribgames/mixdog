// markdown/table-layout/column-widths.mjs
// The column fit: ideal widths when they fit, proportional shrink toward the
// per-column minimum when they do not, and a hard-wrapping scale-down when even
// the minimums overflow. Plus the wrapped height that decides the vertical
// fallback.
import { wrapText } from '../ansi-line-wrap.mjs';
import { MIN_COLUMN_WIDTH, cellIdealWidth, cellMinWidth, formatCell } from './cells.mjs';

export const SAFETY_MARGIN = 4;
export const MAX_ROW_LINES = 4;

export function computeColumnWidths(token, width) {
  // Step 1: min (longest word) and ideal (full content) widths per column.
  const minWidths = token.header.map((header, colIndex) => {
    let maxMinWidth = cellMinWidth(header.tokens);
    for (const row of token.rows) maxMinWidth = Math.max(maxMinWidth, cellMinWidth(row[colIndex]?.tokens));
    return maxMinWidth;
  });
  const idealWidths = token.header.map((header, colIndex) => {
    let maxIdeal = cellIdealWidth(header.tokens);
    for (const row of token.rows) maxIdeal = Math.max(maxIdeal, cellIdealWidth(row[colIndex]?.tokens));
    return maxIdeal;
  });

  // Step 2: available space.
  const numCols = token.header.length;
  const borderOverhead = 1 + numCols * 3;
  const availableWidth = Math.max(width - borderOverhead - SAFETY_MARGIN, numCols * MIN_COLUMN_WIDTH);

  // Step 3: fit column widths into available space.
  const totalMin = minWidths.reduce((s, w) => s + w, 0);
  const totalIdeal = idealWidths.reduce((s, w) => s + w, 0);
  if (totalIdeal <= availableWidth) return { columnWidths: idealWidths, needsHardWrap: false };
  if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - minWidths[i]);
    const totalOverflow = overflows.reduce((s, o) => s + o, 0);
    const columnWidths = minWidths.map((min, i) => {
      if (totalOverflow === 0) return min;
      return min + Math.floor((overflows[i] / totalOverflow) * extraSpace);
    });
    return { columnWidths, needsHardWrap: false };
  }
  const scaleFactor = availableWidth / totalMin;
  return {
    columnWidths: minWidths.map((w) => Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH)),
    needsHardWrap: true,
  };
}

/** Tallest wrapped cell in the table, in lines. */
export function calculateMaxRowLines(token, columnWidths, needsHardWrap) {
  let maxLines = 1;
  for (let i = 0; i < token.header.length; i++) {
    const wrapped = wrapText(formatCell(token.header[i].tokens), columnWidths[i], { hard: needsHardWrap });
    maxLines = Math.max(maxLines, wrapped.length);
  }
  for (const row of token.rows) {
    for (let i = 0; i < row.length; i++) {
      const wrapped = wrapText(formatCell(row[i]?.tokens), columnWidths[i], { hard: needsHardWrap });
      maxLines = Math.max(maxLines, wrapped.length);
    }
  }
  return maxLines;
}
