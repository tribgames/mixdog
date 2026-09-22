// markdown/table-layout/cells.mjs
// Cell text of a GFM table token: the formatted (ANSI) text the terminal
// draws, its plain form, and the two widths the column fit is decided from.
import stripAnsi from 'strip-ansi';
import { formatToken } from '../format-token.mjs';
import { displayWidth } from '../../display-width.mjs';

export const MIN_COLUMN_WIDTH = 3;

export const formatCell = (tokens) => tokens?.map((t) => formatToken(t)).join('') ?? '';

export const plainCellText = (tokens) => stripAnsi(formatCell(tokens));

/** Narrowest width that never splits a word. */
export const cellMinWidth = (tokens) => {
  const text = plainCellText(tokens);
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return MIN_COLUMN_WIDTH;
  return Math.max(...words.map((w) => displayWidth(w)), MIN_COLUMN_WIDTH);
};

/** Width that fits the whole cell on one line. */
export const cellIdealWidth = (tokens) => Math.max(displayWidth(plainCellText(tokens)), MIN_COLUMN_WIDTH);
