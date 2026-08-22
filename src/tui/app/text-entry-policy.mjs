// Text-entry prompt submit policy.
//
// Several settings prompts document "empty = reset/clear": System shell falls
// back to automatic selection, an auto-clear provider default falls back to the
// built-in window, and Profile title clears. TextEntryPanel used to refuse
// EVERY blank submit, which made all three documented paths unreachable — the
// hint told the user to submit an empty value and nothing happened. The kinds
// that accept a blank submit live here so the panel (submit gate) and the view
// (prop) can never drift apart.
export const CLEAR_BY_EMPTY_TEXT_ENTRY_KINDS = Object.freeze([
  'system-shell',
  'autoclear-provider',
  'profile-title',
]);

const CLEAR_BY_EMPTY_KIND_SET = new Set(CLEAR_BY_EMPTY_TEXT_ENTRY_KINDS);

export function textEntryClearsByEmpty(kind) {
  return CLEAR_BY_EMPTY_KIND_SET.has(String(kind || ''));
}

export function canSubmitTextEntry(value, allowEmpty = false) {
  if (allowEmpty === true) return true;
  return String(value ?? '').trim().length > 0;
}
