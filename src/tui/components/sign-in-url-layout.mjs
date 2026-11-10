// components/sign-in-url-layout.mjs — row budget for a borderless sign-in URL block.
//
// `maxRows` is the height the panel can actually give the block. The block
// degrades until it fits, and ONLY the visible text shrinks: the OSC 8 link
// target and the clipboard copy always use the full URL.
//   1. full URL wrapped over its rows + a copy-hint row
//   2. one row with the URL's start and `…` + the hint row
//   3. that one row alone (hint dropped)
//   4. nothing (0 rows); the panel's own description/hint row carries the copy note
import { wrappedDetailRows } from '../app/text-layout.mjs';
import { truncatePanelText } from './panel-cell-text.mjs';

export function signInUrlLayout(url, columns, maxRows) {
  const text = String(url || '').trim();
  if (!text) return { compact: false, rows: 0, hint: false, label: '' };
  const width = Math.max(1, Math.floor(Number(columns) || 1));
  const max = Math.max(0, Math.floor(Number(maxRows)));
  const fullRows = wrappedDetailRows(text, width) + 1;
  if (fullRows <= max) return { compact: false, rows: fullRows, hint: true, label: text };
  const label = truncatePanelText(text, width);
  if (max >= 2) return { compact: true, rows: 2, hint: true, label };
  if (max >= 1) return { compact: true, rows: 1, hint: false, label };
  return { compact: true, rows: 0, hint: false, label: '' };
}
