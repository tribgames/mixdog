/**
 * panel-signature.mjs — the grammar of the panel layout signature.
 *
 * computeShellLayout encodes the bottom area into one `|`-joined signature
 * string; this module is the only reader of that encoding: which panel owns
 * the area, and whether a transition between two signatures is a close the
 * terminal must repaint instantly instead of gliding.
 */

// panelLayoutSignature token order: [tool, picker, context, usage, slash, text,
// inputBoxHidden, floatingPanelRows, promptBoxRows, promptMetaRows, queuedRows,
// WELCOME_ROWS].
export const PANEL_LAYOUT_SIG = {
  PICKER: 1,
  SLASH: 4,
  TEXT: 5,
  // Prompt-wrap/meta row counts (trailing churn tokens, see token order note
  // below). PROMPT_META is the 2-row live-spinner band slot.
  PROMPT_META: 9,
  // Queued steering band rows (full wrapped height, see queuedBandRows).
  QUEUED: 10,
};
export const PROJECT_TEXT_ENTRY_KINDS = new Set(['project-new', 'project-create-confirm', 'project-rename']);
export const CORE_MULTILINE_TEXT_ENTRY_KINDS = new Set(['core-add', 'core-edit']);

export function panelSignatureFlags(signature) {
  if (!signature) return { slash: false, pickerKind: '', textKind: '' };
  const parts = String(signature).split('|');
  const pickerToken = parts[PANEL_LAYOUT_SIG.PICKER] || '';
  const textToken = parts[PANEL_LAYOUT_SIG.TEXT] || '';
  return {
    slash: parts[PANEL_LAYOUT_SIG.SLASH] === 'slash',
    pickerKind: pickerToken.startsWith('picker:') ? pickerToken.slice('picker:'.length).split(':')[0] : '',
    textKind: textToken.startsWith('text:') ? textToken.slice('text:'.length) : '',
  };
}

// The first 8 tokens identify which panel (if any) owns the bottom area; the
// trailing 3 are prompt-wrap/queue row counts that can churn every keystroke
// without any panel opening/closing/changing kind. Comparing only this prefix
// lets the transition logic tell "prompt textarea grew/shrank a wrapped row"
// apart from "a panel actually opened or closed".
const PANEL_KIND_TOKEN_COUNT = 8;
export function panelKindSignature(signature) {
  if (!signature) return '';
  return String(signature).split('|').slice(0, PANEL_KIND_TOKEN_COUNT).join('|');
}

export function isInstantPanelCloseTransition(prevSignature, nextSignature, initialProjectEntryClose) {
  const prev = panelSignatureFlags(prevSignature);
  const next = panelSignatureFlags(nextSignature);
  if (prev.slash && !next.slash) return true;
  if (prev.pickerKind === 'project' && next.pickerKind !== 'project') return initialProjectEntryClose;
  if (PROJECT_TEXT_ENTRY_KINDS.has(prev.textKind) && !PROJECT_TEXT_ENTRY_KINDS.has(next.textKind)) {
    return initialProjectEntryClose;
  }
  return false;
}
