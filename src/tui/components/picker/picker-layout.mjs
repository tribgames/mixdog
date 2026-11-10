/*
 * components/picker/picker-layout.mjs — pure sizing/footer helpers for Picker.
 */
import { theme } from '../../theme.mjs';
import { truncatePanelText as truncateText } from '../panel-cell-text.mjs';

/** Max items visible at once before scrolling kicks in. */
export const MAX_VISIBLE = 8;
export const DEFAULT_LABEL_WIDTH = 28;
export const SELECT_HELP = '↑/↓ Select · Enter Choose · Esc Back';
export const ADJUST_HELP = '↑/↓ Select · ←/→ Adjust · Enter Choose · Esc Back';
export const CONFIRM_HELP = '↑/↓ Select · ←/→ Back/Next · Enter Choose · Esc Skip';

export function clampLabelWidth(value, columns) {
  const maxWidth = Math.max(12, Math.floor(columns * 0.45));
  return Math.max(1, Math.min(Number(value) || DEFAULT_LABEL_WIDTH, maxWidth));
}

/** A requested row index clamped into the item list (0 for an empty list). */
export function clampItemIndex(index, itemCount) {
  return Math.max(0, Math.min(Number(index) || 0, Math.max(0, itemCount - 1)));
}

export function clampMetaWidth(value, columns, labelWidth) {
  const available = Math.max(0, columns - labelWidth - 16);
  const requested = Number(value) || 24;
  return Math.max(0, Math.min(requested, available));
}

export function normalizeFooterLines(activeFooter, columns) {
  let rawLines = activeFooter;
  if (!Array.isArray(rawLines)) rawLines = activeFooter ? [activeFooter] : [];
  return rawLines
    .map((line) => {
      const isObject = line && typeof line === 'object';
      const glyph = isObject ? String(line.glyph || '') : '';
      const color = isObject ? line.color || theme.panelTitle : theme.text;
      const text = isObject ? String(line.text || '') : String(line || '');
      return {
        glyph,
        color,
        text: truncateText(text, Math.max(0, columns - (glyph ? 7 : 4))),
      };
    })
    .filter((line) => line.glyph || line.text);
}
