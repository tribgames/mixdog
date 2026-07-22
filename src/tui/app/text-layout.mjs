/**
 * text-layout.mjs — prompt-box row-reservation helpers extracted verbatim from
 * App.jsx. Pure grapheme wrap math (displayWidth policy); no React, no App state.
 */
import { displayWidth } from '../display-width.mjs';
import wrapAnsi from 'wrap-ansi';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
let promptRowsCache = null;

export function wrappedTextRows(value, width) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  let row = 0;
  let col = 0;
  const segments = [...graphemeSegmenter.segment(String(value ?? ''))];
  for (let i = 0; i < segments.length; i += 1) {
    const { segment } = segments[i];
    if (segment === '\n') {
      row += 1;
      col = 0;
      continue;
    }
    const segmentWidth = displayWidth(segment);
    if (segmentWidth === 0) continue;
    // Same wrap-ansi hard/wordWrap:false wrapping as caretPosition — keep the
    // reserved row count in lock-step with the caret math so the prompt box
    // height matches ink's actual wrap for wide-char lines.
    if (col > 0 && col + segmentWidth > w) {
      row += 1;
      col = 0;
    }
    col += segmentWidth;
    if (col === w && i < segments.length - 1) {
      row += 1;
      col = 0;
    }
  }
  return row + 1;
}

export function promptContentRows(value, contentColumns) {
  // PromptInput appends a blank trailing cell when the caret is at end-of-input
  // so the native cursor always has a rendered cell. App does not own the cursor
  // offset, so reserve for the worst common case: caret at the end. This can
  // over-reserve by one row at exact wrap boundaries, but never under-reserves
  // and therefore prevents transcript rows from bleeding into the prompt box.
  const text = String(value ?? '');
  const width = Math.max(1, Math.floor(Number(contentColumns) || 1));
  if (promptRowsCache?.text === text && promptRowsCache.width === width) {
    return promptRowsCache.rows;
  }
  const rows = wrappedTextRows(`${text} `, width);
  promptRowsCache = { text, width, rows };
  return rows;
}

// Rows an ink <Text wrap="wrap"> block occupies at `width`. Uses the SAME
// wrap-ansi call ink applies for wrap="wrap" (trim:false, hard:true) so the
// floating-panel height reservation for optional detail blocks (e.g. the
// manual OAuth URL in TextEntryPanel) matches the rendered row count exactly.
export function wrappedDetailRows(text, width) {
  const value = String(text ?? '').trim();
  if (!value) return 0;
  const w = Math.max(1, Math.floor(Number(width) || 1));
  return wrapAnsi(value, w, { trim: false, hard: true }).split('\n').length;
}

// Rows one queued steering band (QueuedCommands expanded mode) occupies when
// its full text renders with ink's wrap="wrap" at `width` content columns.
// Same wrap-ansi call ink uses, so the queuedRows reservation in App.jsx stays
// in lock-step with the rendered height — a mismatch pushes the input box.
export function queuedBandRows(text, width) {
  const value = String(text ?? '');
  if (!value) return 1;
  const w = Math.max(1, Math.floor(Number(width) || 1));
  return Math.max(1, wrapAnsi(value, w, { trim: false, hard: true }).split('\n').length);
}

// Character offsets where each visual row starts (hard wrap + explicit newlines).
function visualRowStartOffsets(text, width) {
  const value = String(text ?? '');
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const starts = [0];
  let col = 0;
  const segments = [...graphemeSegmenter.segment(value)];
  for (let i = 0; i < segments.length; i += 1) {
    const { segment, index } = segments[i];
    if (segment === '\n') {
      col = 0;
      const next = index + segment.length;
      if (next < value.length) starts.push(next);
      continue;
    }
    const segmentWidth = displayWidth(segment);
    if (segmentWidth === 0) continue;
    if (col > 0 && col + segmentWidth > w) {
      col = 0;
      starts.push(index);
    }
    col += segmentWidth;
    if (col === w && i < segments.length - 1) {
      col = 0;
      starts.push(segments[i + 1].index);
    }
  }
  return starts;
}

export function sliceVisualRowWindow(text, width, scrollRow, visibleRows) {
  const value = String(text ?? '');
  const starts = visualRowStartOffsets(value, width);
  const start = starts[Math.max(0, Math.min(scrollRow, starts.length - 1))] ?? 0;
  const endRow = scrollRow + Math.max(1, visibleRows);
  const end = starts[endRow] ?? value.length;
  return { slice: value.slice(start, end), sliceStart: start, sliceEnd: end, totalRows: starts.length };
}

export function textEntryReservedRows(value, width, maxRows) {
  const w = Math.max(1, Math.floor(Number(width) || 1));
  const cap = Math.max(1, Math.floor(Number(maxRows) || 1));
  return Math.min(wrappedTextRows(`${String(value ?? '')} `, w), cap);
}
