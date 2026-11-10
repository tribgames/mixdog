/**
 * components/prompt-input/edit-helpers.mjs — pure prompt-editor helpers (no
 * React): hint styling, insert/draft-compare, pasted-text normalization, and
 * modified-Enter (kitty / modifyOtherKeys) sequence recognition.
 */
import { theme } from '../../theme.mjs';
import {
  deleteSelectedText,
  nextOffset,
  nextWordOffset,
  previousOffset,
  previousWordOffset,
  replaceSelection,
  selectionRange,
} from '../../input-editing.mjs';

export function hintStyle(tone) {
  if (tone === 'error') return { textColor: theme.error };
  if (tone === 'warn' || tone === 'cancel') return { textColor: theme.warning };
  if (tone === 'plain') return { textColor: theme.subtle };
  return { textColor: theme.inactive };
}

export function insertText(draft, input) {
  if (!input) return draft;
  return replaceSelection(draft, input);
}

export function normalizePastedText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export function singleTrailingLineBreakPrefix(text) {
  const normalized = normalizePastedText(text);
  if (!normalized.endsWith('\n')) return null;
  const prefix = normalized.slice(0, -1);
  return prefix.includes('\n') ? null : prefix;
}

export function draftStateEqual(a, b) {
  return a.value === b.value && a.cursor === b.cursor && a.selectionAnchor === b.selectionAnchor;
}

// Caret target for a Left/Right arrow press. A plain press collapses a live
// selection to its near edge; otherwise the caret steps one word (`word`, the
// Ctrl/Meta chord) or one character. `extend` (Shift) keeps growing the
// selection instead of collapsing it.
export function leftArrowOffset(draft, { word, extend }) {
  const range = word || extend ? null : selectionRange(draft);
  if (range) return range.start;
  return word ? previousWordOffset(draft.value, draft.cursor) : previousOffset(draft.value, draft.cursor);
}

export function rightArrowOffset(draft, { word, extend }) {
  const range = word || extend ? null : selectionRange(draft);
  if (range) return range.end;
  return word ? nextWordOffset(draft.value, draft.cursor) : nextOffset(draft.value, draft.cursor);
}

// Backspace: delete a live selection, else the grapheme before the caret.
export function deleteBackwardChar(draft) {
  if (selectionRange(draft)) return deleteSelectedText(draft);
  if (draft.cursor <= 0) return draft;
  const start = previousOffset(draft.value, draft.cursor);
  return { value: draft.value.slice(0, start) + draft.value.slice(draft.cursor), cursor: start, selectionAnchor: null };
}

// Delete: delete a live selection, else the grapheme after the caret.
export function deleteForwardChar(draft) {
  if (selectionRange(draft)) return deleteSelectedText(draft);
  if (draft.cursor >= draft.value.length) return draft;
  const end = nextOffset(draft.value, draft.cursor);
  return {
    value: draft.value.slice(0, draft.cursor) + draft.value.slice(end),
    cursor: draft.cursor,
    selectionAnchor: null,
  };
}

// Recognize a MODIFIED Enter delivered via the kitty keyboard protocol
// (\x1b[13;<mod>u) or modifyOtherKeys (\x1b[27;<mod>;13~). The xterm modifier
// param is (1 + bitmask) where the bitmask bits are shift=1, alt=2, ctrl=4. We
// treat Shift+Enter, Alt/Meta+Enter, and Ctrl+Enter as newline chords. Some
// Code maps Shift/Meta+Enter to newline; Ctrl+Enter remains a compatible Mixdog
// extension. Ctrl+J is handled separately as the protocol-independent fallback.
const MODIFIED_ENTER_NEWLINE = 1 | 2 | 4;

/** The CSI parameter body of an Enter sequence, with or without its ESC prefix; '' for anything else. */
export function csiBody(text) {
  if (text.startsWith('\x1b[')) return text.slice(2);
  return text.startsWith('[') ? text.slice(1) : '';
}

const KITTY_ENTER_RE = /^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$/;
const MODIFY_OTHER_KEYS_ENTER_RE = /^27;(\d+);13~$/;

/** The modifier bitmask (xterm param - 1) of an Enter sequence; null for anything else. */
function enterModifierBits(input) {
  const body = csiBody(String(input ?? ''));
  if (!body) return null;
  const match = KITTY_ENTER_RE.exec(body) || MODIFY_OTHER_KEYS_ENTER_RE.exec(body);
  return match ? Number(match[1]) - 1 : null;
}

export function isModifiedEnterSequence(input) {
  const bits = enterModifierBits(input);
  return bits !== null && (bits & MODIFIED_ENTER_NEWLINE) !== 0;
}

// Recognize ANY modified Enter. Used to consume uncommon modifier combinations
// outside the Shift/Alt/Ctrl newline set so raw CSI bytes never reach the draft.
// Plain Enter (mod param = 1, bitmask 0) intentionally remains a submit.
export function isAnyModifiedEnterSequence(input) {
  const bits = enterModifierBits(input);
  return bits !== null && bits !== 0;
}
