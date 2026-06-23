/**
 * components/MarkdownTable.jsx — GFM table → ink Box layout.
 *
 * Ported from Claude Code (refs/claude-code/src/components/MarkdownTable.tsx),
 * adapted for this CLI:
 *   - <Ansi> → <Text> (ink 7 has no <Ansi>; <Text> passes ANSI escapes through).
 *   - useTerminalSize() → ink useStdout().stdout.columns.
 *   - stringWidth / wrapAnsi from the npm packages (same libs CC vendors).
 *   - formatCell uses our format-token.formatToken (no highlight arg).
 *
 * The width-fitting algorithm (ideal vs min widths, proportional shrink, hard
 * wrap, vertical fallback for narrow terminals) is preserved verbatim.
 */
import React from 'react';
import { Text, useStdout } from 'ink';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { formatToken, padAligned } from '../markdown/format-token.mjs';

const SAFETY_MARGIN = 4;
const MIN_COLUMN_WIDTH = 3;
const MAX_ROW_LINES = 4;
const ANSI_BOLD_START = '\x1b[1m';
const ANSI_BOLD_END = '\x1b[22m';

/** Wrap text to width, ANSI-aware, returning lines (CC wrapText). */
function wrapText(text, width, options) {
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

export function MarkdownTable({ token, forceWidth }) {
  // App owns resize reflow and there is no <Static> transcript anymore, so table
  // width can follow the current terminal width without duplicating scrollback.
  const actualTerminalWidth = useStdout()?.stdout?.columns ?? 80;
  const terminalWidth = forceWidth ?? actualTerminalWidth;

  const formatCell = (tokens) => tokens?.map((t) => formatToken(t)).join('') ?? '';
  const getPlainText = (tokens) => stripAnsi(formatCell(tokens));

  const getMinWidth = (tokens) => {
    const text = getPlainText(tokens);
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) return MIN_COLUMN_WIDTH;
    return Math.max(...words.map((w) => stringWidth(w)), MIN_COLUMN_WIDTH);
  };
  const getIdealWidth = (tokens) =>
    Math.max(stringWidth(getPlainText(tokens)), MIN_COLUMN_WIDTH);

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
  const availableWidth = Math.max(terminalWidth - borderOverhead - SAFETY_MARGIN, numCols * MIN_COLUMN_WIDTH);

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
        const width = columnWidths[colIndex];
        const align = isHeader ? 'center' : token.align?.[colIndex] ?? 'left';
        line += ' ' + padAligned(lineText, stringWidth(lineText), width, align) + ' │';
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
    columnWidths.forEach((width, colIndex) => {
      line += mid.repeat(width + 2);
      line += colIndex < columnWidths.length - 1 ? cross : right;
    });
    return line;
  };

  const renderVerticalFormat = () => {
    const lines = [];
    const headers = token.header.map((h) => getPlainText(h.tokens));
    const separatorWidth = Math.min(terminalWidth - 1, 40);
    const separator = '─'.repeat(separatorWidth);
    const wrapIndent = '  ';
    token.rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) lines.push(separator);
      row.forEach((cell, colIndex) => {
        const label = headers[colIndex] || `Column ${colIndex + 1}`;
        const rawValue = formatCell(cell.tokens).trimEnd();
        const value = rawValue.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
        const firstLineWidth = terminalWidth - stringWidth(label) - 3;
        const subsequentLineWidth = terminalWidth - wrapIndent.length - 1;
        const firstPassLines = wrapText(value, Math.max(firstLineWidth, 10));
        const firstLine = firstPassLines[0] || '';
        let wrappedValue;
        if (firstPassLines.length <= 1 || subsequentLineWidth <= firstLineWidth) {
          wrappedValue = firstPassLines;
        } else {
          const remainingText = firstPassLines.slice(1).map((l) => l.trim()).join(' ');
          wrappedValue = [firstLine, ...wrapText(remainingText, subsequentLineWidth)];
        }
        lines.push(`${ANSI_BOLD_START}${label}:${ANSI_BOLD_END} ${wrappedValue[0] || ''}`);
        for (let i = 1; i < wrappedValue.length; i++) {
          if (!wrappedValue[i].trim()) continue;
          lines.push(`${wrapIndent}${wrappedValue[i]}`);
        }
      });
    });
    return lines.join('\n');
  };

  if (useVerticalFormat) {
    return <Text>{renderVerticalFormat()}</Text>;
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
  const maxLineWidth = Math.max(...tableLines.map((l) => stringWidth(stripAnsi(l))));
  if (maxLineWidth > terminalWidth - SAFETY_MARGIN) {
    return <Text>{renderVerticalFormat()}</Text>;
  }

  return <Text>{tableLines.join('\n')}</Text>;
}
