// use-prompt-draft-flow/draft-change.mjs
// What one prompt keystroke does outside PromptInput: layout rows, history-nav
// reset, the slash-token lift into App state, and the argument hint.
import { slashQuery, slashArgumentHint } from '../slash-commands.mjs';

export function applyPromptDraftChange(value, deps) {
  const {
    dismissWelcomePromptHint,
    syncPromptLayoutRows,
    promptHistoryDraftChangeRef,
    promptHistoryNavRef,
    resetPromptHistoryNav,
    setPromptDraft,
    setPromptDraftOverride,
    showPromptHint,
    clearPromptHint,
    promptHintActiveRef,
    promptHintTimerRef,
    slashDismissedFor,
    setSlashDismissedFor,
  } = deps;
  if (String(value ?? '').length > 0) dismissWelcomePromptHint();
  syncPromptLayoutRows(value);
  // NOTE: do NOT prune pasted-text entries on edit. A partially-edited token
  // can be undone back to its intact form, which must still expand on submit;
  // entries are kept until an accepted submit or an explicit clear. (Memory
  // cost is bounded and acceptable.)
  const suppressPromptHint = promptHistoryDraftChangeRef.current;
  promptHistoryDraftChangeRef.current = false;
  const historyNav = promptHistoryNavRef.current;
  if (!value || (historyNav.active && value !== historyNav.lastValue && value !== historyNav.seed)) {
    resetPromptHistoryNav();
  }
  // Only lift the draft into App state when it can affect the slash palette
  // (a single "/token"). Prose typing renders entirely inside PromptInput's
  // own state, so App need not re-render — and relayout the full fullscreen
  // frame — on every keystroke (input lag fix). Entering slash mode and
  // leaving it both still sync because either prev or next is a slash token.
  // Clearing/submitting must also sync so a consumed slash command does not
  // remount later as stale initialValue after a picker/panel closes.
  const nextSlash = slashQuery(value);
  setPromptDraft((prev) => {
    const previousWasSlashFlow = String(prev || '').startsWith('/');
    if (value === '') return '';
    return nextSlash !== null || previousWasSlashFlow ? value : prev;
  });
  setPromptDraftOverride((prev) => (prev === null ? prev : null));
  const argumentHint = slashArgumentHint(value);
  if (argumentHint && !suppressPromptHint) {
    showPromptHint(argumentHint, 'info');
  } else if (suppressPromptHint || promptHintActiveRef.current || promptHintTimerRef.current) {
    // Only clear when a hint is actually live (shown or pending its timer).
    // clearPromptHint() already early-returns when neither ref is set, but
    // gating the call here avoids invoking it on EVERY keystroke once a hint
    // has appeared — that call path otherwise drives a setState → full App
    // re-render per key, which is costly on long transcripts. Hint-while-
    // typing still vanishes immediately because the guard includes the active
    // state; the argumentHint branch above is untouched. The guard no longer
    // requires a non-empty value: clearing/submitting to '' must also dismiss
    // a live hint instead of leaving it until its timer expires.
    clearPromptHint();
  }
  if (slashDismissedFor) {
    setSlashDismissedFor((dismissed) => (dismissed && dismissed !== value ? '' : dismissed));
  }
}
