// markdown/table-layout/box-lines.mjs
// The bordered horizontal table: one row's wrapped, vertically centred and
// aligned cell lines, and the three border rules.
import { wrapText } from '../ansi-line-wrap.mjs';
import { padAligned } from '../format-token.mjs';
import { displayWidth } from '../../display-width.mjs';
import { formatCell } from './cells.mjs';

const BORDER_GLYPHS = {
  top: ['┌', '─', '┬', '┐'],
  middle: ['├', '─', '┼', '┤'],
  bottom: ['└', '─', '┴', '┘'],
};

export function renderRowLines(cells, isHeader, { token, columnWidths, needsHardWrap }) {
  const cellLines = cells.map((cell, colIndex) =>
    wrapText(formatCell(cell.tokens), columnWidths[colIndex], { hard: needsHardWrap })
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
      const align = isHeader ? 'center' : (token.align?.[colIndex] ?? 'left');
      line += ` ${padAligned(lineText, displayWidth(lineText), colWidth, align)} │`;
    }
    result.push(line);
  }
  return result;
}

export function renderBorderLine(type, columnWidths) {
  const [left, mid, cross, right] = BORDER_GLYPHS[type];
  let line = left;
  columnWidths.forEach((colWidth, colIndex) => {
    line += mid.repeat(colWidth + 2);
    line += colIndex < columnWidths.length - 1 ? cross : right;
  });
  return line;
}
