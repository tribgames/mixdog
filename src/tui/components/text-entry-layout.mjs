/*
 * components/text-entry-layout.mjs — pure single-line layout helpers for TextEntryPanel.
 */
import stringWidth from 'string-width';
import { caretPosition } from '../input-editing.mjs';
import { wrappedTextRows } from '../app/text-layout.mjs';

// Collapse newlines to a single visible glyph so multiline pasted input stays a
// single visual row (the draft itself is unchanged for editing/submit).
const NEWLINE_GLYPH = '⏎';
export function flattenForSingleLine(text) {
  return String(text ?? '').replace(/\n/g, NEWLINE_GLYPH);
}

// Horizontal viewport over a single (flattened) line. Keeps the caret visible
// inside `width` cells and returns the visible slice plus the caret column so
// the content box can be hard-bounded to ONE row: long/multiline pasted input
// scrolls horizontally instead of wrapping and growing the panel. Offsets are
// code-unit offsets, which map 1:1 to the flattened string (newline → 1 glyph,
// mask → 1 char), so selection/cursor offsets carry over unchanged.
export function windowSingleLine(flat, cursor, width) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const chars = Array.from(flat);
  const cells = chars.map((ch) => stringWidth(ch));
  // Map the code-unit cursor to a char index.
  let cuIndex = 0;
  let cursorCharIdx = chars.length;
  for (let i = 0; i < chars.length; i += 1) {
    if (cuIndex >= cursor) {
      cursorCharIdx = i;
      break;
    }
    cuIndex += chars[i].length;
  }
  let cursorCell = 0;
  for (let i = 0; i < cursorCharIdx; i += 1) cursorCell += cells[i];
  const totalCell = cells.reduce((a, b) => a + b, 0);
  let startCell = cursorCell > w - 1 ? cursorCell - (w - 1) : 0;
  startCell = Math.min(startCell, Math.max(0, totalCell - w));
  startCell = Math.max(0, startCell);
  let acc = 0;
  let a = 0;
  while (a < chars.length && acc + cells[a] <= startCell) {
    acc += cells[a];
    a += 1;
  }
  const alignedStart = acc;
  let b = a;
  let bAcc = 0;
  while (b < chars.length && bAcc + cells[b] <= w) {
    bAcc += cells[b];
    b += 1;
  }
  let cuStart = 0;
  for (let i = 0; i < a; i += 1) cuStart += chars[i].length;
  let cuEnd = cuStart;
  for (let i = a; i < b; i += 1) cuEnd += chars[i].length;
  return {
    text: chars.slice(a, b).join(''),
    cuStart,
    cuEnd,
    caretCol: Math.max(0, cursorCell - alignedStart),
  };
}

// Collapse any whitespace/newlines so a hint is always a single visual line.
export function singleLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Cursor-anchor callback for the text box node: patched Ink calls it during
// render to park the hardware cursor at the caret's (row, col) in the box.
export function createTextEntryCursorAnchor({
  cursorEnabledRef,
  draftRef,
  contentWidthRef,
  contentCells,
  mask,
  multiline,
  maxContentRows,
  promptLabel,
}) {
  return (yogaNode) => {
    if (!cursorEnabledRef.current) return null;
    const d = draftRef.current;
    const w = Math.max(1, yogaNode?.getComputedWidth?.() ?? contentCells);
    contentWidthRef.current = w;
    const visible = mask ? d.value.replace(/[^\n]/g, '*') : d.value;
    if (multiline) {
      const trailing = d.cursor >= d.value.length;
      const totalRows = wrappedTextRows(`${visible}${trailing ? ' ' : ''}`, w);
      const visibleRows = Math.min(totalRows, Math.max(1, maxContentRows));
      const caret = caretPosition(visible, d.cursor, w, trailing ? true : undefined);
      const scrollRow =
        totalRows > visibleRows ? Math.min(Math.max(0, caret.row - visibleRows + 1), totalRows - visibleRows) : 0;
      return { row: Math.max(0, caret.row - scrollRow), col: caret.col };
    }
    const flat = flattenForSingleLine(visible);
    const win = windowSingleLine(flat, d.cursor, w);
    return { row: 0, col: stringWidth(String(promptLabel || '')) + win.caretCol };
  };
}
