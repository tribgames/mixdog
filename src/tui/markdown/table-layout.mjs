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
import wrapAnsi from 'wrap-ansi';
import { formatToken, padAligned } from './format-token.mjs';
import { displayWidth } from '../display-width.mjs';

export const SAFETY_MARGIN = 4;
export const MIN_COLUMN_WIDTH = 3;
export const MAX_ROW_LINES = 4;
const ANSI_BOLD_START = '\x1b[1m';
const ANSI_BOLD_END = '\x1b[22m';

/** Assistant markdown body width — lockstep with Message.jsx / forceWidth. */
export function assistantBodyWidth(columns) {
  return Math.max(8, Number(columns || 80) - 3);
}

/** Wrap text to width, ANSI-aware, returning lines. */
export function wrapText(text, width, options) {
  if (width <= 0) return [text];
  const trimmedText = String(text).trimEnd();
  const wrapped = wrapAnsi(trimmedText, width, {
    hard: options?.hard ?? false,
    trim: false,
    wordWrap: true,
  });
  const lines = wrapped.split('\n').filter((line) => line.length > 0);
  return lines.length > 0 ? lines : [''];
}

/** Hard-wrap so every line satisfies stringWidth(line) <= width (vertical tables). */
export function hardWrapLines(text, width) {
  const max = Math.max(1, Math.floor(Number(width) || 1));
  const input = String(text ?? '');
  if (!input) return [''];
  const out = [];
  for (const softLine of wrapText(input, max, { hard: true })) {
    let rest = softLine;
    while (rest.length > 0 && displayWidth(rest) > max) {
      let take = 1;
      for (let i = 1; i <= rest.length; i++) {
        if (displayWidth(rest.slice(0, i)) <= max) take = i;
        else break;
      }
      out.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    if (rest.length > 0) out.push(rest);
  }
  return out.length > 0 ? out : [''];
}

/**
 * Compute the full table render as an ordered array of terminal lines plus the
 * vertical-fallback flag. The logic mirrors the original MarkdownTable render
 * exactly: column fit (ideal / proportional shrink / hard wrap), vertical
 * fallback when a cell needs more than MAX_ROW_LINES, the bordered horizontal
 * box, and the post-build overflow re-fallback to vertical.
 */
export function buildTableRender(token, terminalWidth) {
  const width = Number(terminalWidth) || 80;
  const formatCell = (tokens) => tokens?.map((t) => formatToken(t)).join('') ?? '';
  const getPlainText = (tokens) => stripAnsi(formatCell(tokens));

  const getMinWidth = (tokens) => {
    const text = getPlainText(tokens);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return MIN_COLUMN_WIDTH;
    return Math.max(...words.map((w) => displayWidth(w)), MIN_COLUMN_WIDTH);
  };
  const getIdealWidth = (tokens) =>
    Math.max(displayWidth(getPlainText(tokens)), MIN_COLUMN_WIDTH);

  // Step 1: min (longest word) and ideal (full content) widths per column.
  const minWidths = token.header.map((header, colIndex) => {
    let maxMinWidth = getMinWidth(header.tokens);
    for (const row of token.rows) maxMinWidth = Math.max(maxMinWidth, getMinWidth(row[colIndex]?.tokens));
    return maxMinWidth;
  });
  const idealWidths = token.header.map((header, colIndex) => {
    let maxIdeal = getIdealWidth(header.tokens);
    for (const row of token.rows) maxIdeal = Math.max(maxIdeal, getIdealWidth(row[colIndex]?.tokens));
    return maxIdeal;
  });

  // Step 2: available space.
  const numCols = token.header.length;
  const borderOverhead = 1 + numCols * 3;
  const availableWidth = Math.max(width - borderOverhead - SAFETY_MARGIN, numCols * MIN_COLUMN_WIDTH);

  // Step 3: fit column widths into available space.
  const totalMin = minWidths.reduce((s, w) => s + w, 0);
  const totalIdeal = idealWidths.reduce((s, w) => s + w, 0);
  let needsHardWrap = false;
  let columnWidths;
  if (totalIdeal <= availableWidth) {
    columnWidths = idealWidths;
  } else if (totalMin <= availableWidth) {
    const extraSpace = availableWidth - totalMin;
    const overflows = idealWidths.map((ideal, i) => ideal - minWidths[i]);
    const totalOverflow = overflows.reduce((s, o) => s + o, 0);
    columnWidths = minWidths.map((min, i) => {
      if (totalOverflow === 0) return min;
      return min + Math.floor((overflows[i] / totalOverflow) * extraSpace);
    });
  } else {
    needsHardWrap = true;
    const scaleFactor = availableWidth / totalMin;
    columnWidths = minWidths.map((w) => Math.max(Math.floor(w * scaleFactor), MIN_COLUMN_WIDTH));
  }

  // Step 4: max row lines → decide vertical fallback.
  const calculateMaxRowLines = () => {
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
  };
  const useVerticalFormat = calculateMaxRowLines() > MAX_ROW_LINES;

  const renderRowLines = (cells, isHeader) => {
    const cellLines = cells.map((cell, colIndex) =>
      wrapText(formatCell(cell.tokens), columnWidths[colIndex], { hard: needsHardWrap }),
    );
    const maxLines = Math.max(...cellLines.map((l) => l.length), 1);
    const verticalOffsets = cellLines.map((l) => Math.floor((maxLines - l.length) / 2));
    const result = [];
    for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
      let line = '│';
      for (let colIndex = 0; colIndex < cells.length; colIndex++) {
        const lines = cellLines[colIndex];
        const offset = verticalOffsets[colIndex];
        const contentLineIdx = lineIdx - offset;
        const lineText = contentLineIdx >= 0 && contentLineIdx < lines.length ? lines[contentLineIdx] : '';
        const colWidth = columnWidths[colIndex];
        const align = isHeader ? 'center' : token.align?.[colIndex] ?? 'left';
        line += ' ' + padAligned(lineText, displayWidth(lineText), colWidth, align) + ' │';
      }
      result.push(line);
    }
    return result;
  };

  const renderBorderLine = (type) => {
    const [left, mid, cross, right] = {
      top: ['┌', '─', '┬', '┐'],
      middle: ['├', '─', '┼', '┤'],
      bottom: ['└', '─', '┴', '┘'],
    }[type];
    let line = left;
    columnWidths.forEach((colWidth, colIndex) => {
      line += mid.repeat(colWidth + 2);
      line += colIndex < columnWidths.length - 1 ? cross : right;
    });
    return line;
  };

  const renderVerticalLines = () => {
    const lines = [];
    const headers = token.header.map((h) => getPlainText(h.tokens));
    const separatorWidth = Math.min(Math.max(0, width - 1), 40);
    const separator = '─'.repeat(separatorWidth);
    const wrapIndent = '  ';
    const indentWidth = displayWidth(wrapIndent);
    const pushFitted = (rawLine) => {
      for (const part of hardWrapLines(rawLine, width)) lines.push(part);
    };
    token.rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) lines.push(separator);
      row.forEach((cell, colIndex) => {
        const label = headers[colIndex] || `Column ${colIndex + 1}`;
        const rawValue = formatCell(cell.tokens).trimEnd();
        const value = rawValue.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
        const prefix = `${ANSI_BOLD_START}${label}:${ANSI_BOLD_END} `;
        const prefixWidth = displayWidth(stripAnsi(prefix));
        const firstValueWidth = Math.max(1, width - prefixWidth);
        const contValueWidth = Math.max(1, width - indentWidth);
        const firstValueLines = hardWrapLines(value, firstValueWidth);
        if (firstValueLines.length === 0) {
          pushFitted(prefix.trimEnd());
          return;
        }
        pushFitted(prefix + firstValueLines[0]);
        const tail = firstValueLines.slice(1).join(' ').trim();
        if (tail) {
          for (const cont of hardWrapLines(tail, contValueWidth)) {
            if (!cont.trim()) continue;
            pushFitted(wrapIndent + cont);
          }
        }
      });
    });
    return lines;
  };

  if (useVerticalFormat) {
    return { lines: renderVerticalLines(), useVerticalFormat: true };
  }

  const tableLines = [];
  tableLines.push(renderBorderLine('top'));
  tableLines.push(...renderRowLines(token.header, true));
  tableLines.push(renderBorderLine('middle'));
  token.rows.forEach((row, rowIndex) => {
    tableLines.push(...renderRowLines(row, false));
    if (rowIndex < token.rows.length - 1) tableLines.push(renderBorderLine('middle'));
  });
  tableLines.push(renderBorderLine('bottom'));

  // Safety: if any line would overflow (resize race), fall back to vertical.
  const maxLineWidth = Math.max(...tableLines.map((l) => displayWidth(stripAnsi(l))));
  if (maxLineWidth > width - SAFETY_MARGIN) {
    return { lines: renderVerticalLines(), useVerticalFormat: true };
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
