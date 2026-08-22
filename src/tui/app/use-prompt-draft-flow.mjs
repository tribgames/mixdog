// Prompt draft + slash palette flow, extracted from App.jsx: keystroke-time
// draft sync (slash-token lift, history-nav reset, argument hints), the four
// text-entry prompt cancel paths, and accept/complete/cancel for the slash
// palette.
import { useCallback } from 'react';
import { slashQuery, slashArgumentHint, slashCommandTokenForPaletteAccept } from './slash-commands.mjs';
import { supersedePanelEpoch } from './panel-epoch.mjs';

export function usePromptDraftFlow({
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
  providerPrompt,
  settingsPrompt,
  setProviderPrompt,
  setSettingsPrompt,
  oauthSubmitRef,
  openProjectPicker,
  openMemoryCorePicker,
  openAutoClearPicker,
  slashCommands,
  slashIndex,
  pickerOpenedFromEnterRef,
  pickerOpenedFromEnterTimerRef,
  runSlashCommand,
}) {
  const onPromptDraftChange = useCallback((value) => {
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
  }, [clearPromptHint, dismissWelcomePromptHint, resetPromptHistoryNav, showPromptHint, slashDismissedFor, syncPromptLayoutRows]);

  const cancelProviderPrompt = useCallback(() => {
    // Esc takes the surface back: an in-flight save that acks later must not
    // reopen/replace whatever the user does next.
    supersedePanelEpoch();
    try { providerPrompt?.login?.cancel?.(); } catch {}
    oauthSubmitRef.current = false;
    const onCancel = providerPrompt?.cancelReturn || providerPrompt?.onCancel;
    const afterSave = providerPrompt?.afterSave;
    setProviderPrompt(null);
    if (onCancel) onCancel();
    else if (afterSave) afterSave();
  }, [providerPrompt, showPromptHint]);

  const cancelSettingsPrompt = useCallback(() => {
    // Esc supersedes every in-flight settings write for this surface.
    supersedePanelEpoch();
    // The project entry prompts are reached from the project picker; backing out
    // (Esc) should return to that picker rather than dropping to a bare prompt.
    const kind = settingsPrompt?.kind;
    setSettingsPrompt(null);
    if (kind === 'project-new' || kind === 'project-create-confirm' || kind === 'project-rename') {
      openProjectPicker();
    } else if (kind === 'core-add' || kind === 'core-edit' || kind === 'core-delete-confirm') {
      openMemoryCorePicker();
    } else if (kind === 'autoclear-provider') {
      openAutoClearPicker({ advanced: true, returnTo: settingsPrompt?.returnTo });
    }
  }, [settingsPrompt, showPromptHint]);

  const acceptSlashPalette = useCallback((draftValue = '') => {
    const command = slashCommands[slashIndex];
    if (!command) return false;
    pickerOpenedFromEnterRef.current = true;
    if (pickerOpenedFromEnterTimerRef.current) {
      clearTimeout(pickerOpenedFromEnterTimerRef.current);
      pickerOpenedFromEnterTimerRef.current = null;
    }
    try {
      return runSlashCommand(slashCommandTokenForPaletteAccept(command, draftValue), '');
    } finally {
      pickerOpenedFromEnterTimerRef.current = setTimeout(() => {
        pickerOpenedFromEnterRef.current = false;
        pickerOpenedFromEnterTimerRef.current = null;
      }, 3000);
    }
  }, [slashCommands, slashIndex]);

  const completeSlashPalette = useCallback((draftValue = '') => {
    const command = slashCommands[slashIndex];
    if (!command) return undefined;
    const token = slashCommandTokenForPaletteAccept(command, draftValue);
    return token ? `/${token} ` : undefined;
  }, [slashCommands, slashIndex]);

  const cancelSlashPalette = useCallback((value = '') => {
    // autocomplete:dismiss closes suggestions without changing
    // the draft. Remember this exact value so the palette does not immediately
    // reopen; the next edit clears the marker in onPromptDraftChange.
    setSlashDismissedFor(String(value ?? ''));
  }, [setSlashDismissedFor]);

  return {
    onPromptDraftChange,
    cancelProviderPrompt,
    cancelSettingsPrompt,
    acceptSlashPalette,
    completeSlashPalette,
    cancelSlashPalette,
  };
}
