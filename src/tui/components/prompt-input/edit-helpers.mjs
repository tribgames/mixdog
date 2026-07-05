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
// treat Ctrl+Enter AND Shift+Enter (the two common "insert newline" chords) as a
// newline, so we match when the shift OR ctrl bit is set. Ctrl+J is handled
// separately as the protocol-independent fallback.
const MODIFIED_ENTER_SHIFT_OR_CTRL = 1 | 4;

export function isModifiedEnterSequence(input) {
  const text = String(input ?? '');
  const body = text.startsWith('\x1b[') ? text.slice(2) : text.startsWith('[') ? text.slice(1) : '';
  if (!body) return false;
  const kitty = /^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$/.exec(body);
  if (kitty) return ((Number(kitty[1]) - 1) & MODIFIED_ENTER_SHIFT_OR_CTRL) !== 0;
  const modifyOtherKeys = /^27;(\d+);13~$/.exec(body);
  return Boolean(modifyOtherKeys && (((Number(modifyOtherKeys[1]) - 1) & MODIFIED_ENTER_SHIFT_OR_CTRL) !== 0));
}

// Recognize ANY modified Enter (any modifier bitmask, e.g. Alt+Enter \x1b[13;3u
// / \x1b[27;3;13~). Used to CONSUME modified-Enter sequences we don't map to a
// newline (Alt-only, etc.) so they aren't typed into the prompt as raw CSI text
// under modifyOtherKeys. Plain Enter (mod param = 1, bitmask 0) is intentionally
// NOT matched, so it still submits.
export function isAnyModifiedEnterSequence(input) {
  const text = String(input ?? '');
  const body = text.startsWith('\x1b[') ? text.slice(2) : text.startsWith('[') ? text.slice(1) : '';
  if (!body) return false;
  const kitty = /^13;(\d+)(?::\d+)?(?:;[\d:]+)?u$/.exec(body);
  if (kitty) return (Number(kitty[1]) - 1) !== 0;
  const modifyOtherKeys = /^27;(\d+);13~$/.exec(body);
  return Boolean(modifyOtherKeys && ((Number(modifyOtherKeys[1]) - 1) !== 0));
}
