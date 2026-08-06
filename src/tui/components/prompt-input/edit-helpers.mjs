/**
 * components/prompt-input/edit-helpers.mjs — pure prompt-editor helpers (no
 * React): hint styling, insert/draft-compare, pasted-text normalization, and
 * modified-Enter (kitty / modifyOtherKeys) sequence recognition. Extracted
 * verbatim from PromptInput.jsx — behavior unchanged.
 */
import { theme } from '../../theme.mjs';
import { replaceSelection } from '../../input-editing.mjs';

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
  return (
    a.value === b.value
    && a.cursor === b.cursor
    && a.selectionAnchor === b.selectionAnchor
  );
}

// Recognize a MODIFIED Enter delivered via the kitty keyboard protocol
// (\x1b[13;<mod>u) or modifyOtherKeys (\x1b[27;<mod>;13~). The xterm modifier
// param is (1 + bitmask) where the bitmask bits are shift=1, alt=2, ctrl=4. We
// treat Shift+Enter, Alt/Meta+Enter, and Ctrl+Enter as newline chords. Claude
// Code maps Shift/Meta+Enter to newline; Ctrl+Enter remains a compatible Mixdog
// extension. Ctrl+J is handled separately as the protocol-independent fallback.
const MODIFIED_ENTER_NEWLINE = 1 | 2 | 4;

export function isModifiedEnterSequence(input) {
  const text = String(input ?? '');
  const body = text.startsWith('\x1b[') ? text.slice(2) : text.startsWith('[') ? text.slice(1) : '';
  if (!body) return false;
  const kitty = /^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$/.exec(body);
  if (kitty) return ((Number(kitty[1]) - 1) & MODIFIED_ENTER_NEWLINE) !== 0;
  const modifyOtherKeys = /^27;(\d+);13~$/.exec(body);
  return Boolean(modifyOtherKeys && (((Number(modifyOtherKeys[1]) - 1) & MODIFIED_ENTER_NEWLINE) !== 0));
}

// Recognize ANY modified Enter. Used to consume uncommon modifier combinations
// outside the Shift/Alt/Ctrl newline set so raw CSI bytes never reach the draft.
// Plain Enter (mod param = 1, bitmask 0) intentionally remains a submit.
export function isAnyModifiedEnterSequence(input) {
  const text = String(input ?? '');
  const body = text.startsWith('\x1b[') ? text.slice(2) : text.startsWith('[') ? text.slice(1) : '';
  if (!body) return false;
  const kitty = /^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$/.exec(body);
  if (kitty) return (Number(kitty[1]) - 1) !== 0;
  const modifyOtherKeys = /^27;(\d+);13~$/.exec(body);
  return Boolean(modifyOtherKeys && ((Number(modifyOtherKeys[1]) - 1) !== 0));
}
