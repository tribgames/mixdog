/**
 * text-layout.mjs — prompt-box row-reservation helpers extracted verbatim from
 * App.jsx. Pure grapheme wrap math (string-width only); no React, no App state.
 */
import stringWidth from 'string-width';

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

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
    const segmentWidth = stringWidth(segment);
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
  return wrappedTextRows(`${String(value ?? '')} `, contentColumns);
}
