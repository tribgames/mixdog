/*
 * components/text-entry-value.jsx — the visible (windowed, selection-highlighted)
 * value of a TextEntryPanel draft, plus the content height it occupies.
 */
import { selectionRange, caretPosition } from '../input-editing.mjs';
import { sliceVisualRowWindow, wrappedTextRows } from '../app/text-layout.mjs';
import { flattenForSingleLine, windowSingleLine } from './text-entry-layout.mjs';
import { renderSelectedText } from './prompt-input/selected-text.jsx';

export function renderTextEntryValue({ draft, mask, multiline, contentCells, maxContentRows }) {
  const visibleValue = mask ? draft.value.replace(/[^\n]/g, '*') : draft.value;
  let renderedValue;
  let contentHeight = 1;
  if (multiline) {
    const trailingCaret = draft.cursor === draft.value.length;
    const layoutText = `${visibleValue}${trailingCaret ? ' ' : ''}`;
    const totalRows = wrappedTextRows(layoutText, contentCells);
    const visibleRows = Math.min(totalRows, Math.max(1, maxContentRows));
    contentHeight = visibleRows;
    const caret = caretPosition(visibleValue, draft.cursor, contentCells, trailingCaret ? true : undefined);
    const scrollRow =
      totalRows > visibleRows ? Math.min(Math.max(0, caret.row - visibleRows + 1), totalRows - visibleRows) : 0;
    const window = sliceVisualRowWindow(visibleValue, contentCells, scrollRow, visibleRows);
    const windowSelection = (() => {
      const range = selectionRange(draft);
      if (!range) return null;
      const start = Math.max(window.sliceStart, Math.min(window.sliceEnd, range.start)) - window.sliceStart;
      const end = Math.max(window.sliceStart, Math.min(window.sliceEnd, range.end)) - window.sliceStart;
      return end > start ? { start, end } : null;
    })();
    const sliceTrailing = trailingCaret && draft.cursor >= window.sliceEnd;
    renderedValue = renderSelectedText(window.slice, windowSelection, sliceTrailing);
  } else {
    const flatValue = flattenForSingleLine(visibleValue);
    const win = windowSingleLine(flatValue, draft.cursor, contentCells);
    const windowSelection = (() => {
      const range = selectionRange(draft);
      if (!range) return null;
      const start = Math.max(win.cuStart, Math.min(win.cuEnd, range.start)) - win.cuStart;
      const end = Math.max(win.cuStart, Math.min(win.cuEnd, range.end)) - win.cuStart;
      return end > start ? { start, end } : null;
    })();
    const trailingCaret = draft.cursor === draft.value.length && win.cuEnd >= flatValue.length;
    renderedValue = renderSelectedText(win.text, windowSelection, trailingCaret);
  }
  return { renderedValue, contentHeight };
}
