// markdown/table-layout/vertical-lines.mjs
// The vertical fallback: one "Header: value" line per cell, hard-wrapped to the
// terminal width with an indented continuation, and a rule between rows. Used
// when a cell would need more than MAX_ROW_LINES, or when the built box still
// overflows.
import stripAnsi from 'strip-ansi';
import { hardWrapAnsiLines as hardWrapLines } from '../ansi-line-wrap.mjs';
import { displayWidth } from '../../display-width.mjs';
import { formatCell, plainCellText } from './cells.mjs';

const ANSI_BOLD_START = '\x1b[1m';
const ANSI_BOLD_END = '\x1b[22m';

export function renderVerticalLines(token, width) {
  const lines = [];
  const headers = token.header.map((h) => plainCellText(h.tokens));
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
}
