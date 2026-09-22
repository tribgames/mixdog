// Prompt draft + slash palette flow: keystroke-time
// draft sync (slash-token lift, history-nav reset, argument hints), the four
// text-entry prompt cancel paths, and accept/complete/cancel for the slash
// palette.
//
// The keystroke work lives in use-prompt-draft-flow/draft-change.mjs and the
// two Esc paths in use-prompt-draft-flow/prompt-cancels.mjs; this file owns the
// hooks and their dependencies.
import { useCallback } from 'react';
import { slashCommandTokenForPaletteAccept } from './slash-commands.mjs';
import { applyPromptDraftChange } from './use-prompt-draft-flow/draft-change.mjs';
import { cancelProviderPromptFlow, cancelSettingsPromptFlow } from './use-prompt-draft-flow/prompt-cancels.mjs';

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
  const onPromptDraftChange = useCallback(
    (value) =>
      applyPromptDraftChange(value, {
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
      }),
    [
      clearPromptHint,
      dismissWelcomePromptHint,
      resetPromptHistoryNav,
      showPromptHint,
      slashDismissedFor,
      syncPromptLayoutRows,
    ]
  );

  const cancelProviderPrompt = useCallback(
    () => cancelProviderPromptFlow({ providerPrompt, oauthSubmitRef, setProviderPrompt }),
    [providerPrompt, showPromptHint]
  );

  const cancelSettingsPrompt = useCallback(
    () =>
      cancelSettingsPromptFlow({
        settingsPrompt,
        setSettingsPrompt,
        openProjectPicker,
        openMemoryCorePicker,
        openAutoClearPicker,
      }),
    [settingsPrompt, showPromptHint]
  );

  const acceptSlashPalette = useCallback(
    (draftValue = '') => {
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
    },
    [slashCommands, slashIndex]
  );

  const completeSlashPalette = useCallback(
    (draftValue = '') => {
      const command = slashCommands[slashIndex];
      if (!command) return undefined;
      const token = slashCommandTokenForPaletteAccept(command, draftValue);
      return token ? `/${token} ` : undefined;
    },
    [slashCommands, slashIndex]
  );

  const cancelSlashPalette = useCallback(
    (value = '') => {
      // autocomplete:dismiss closes suggestions without changing
      // the draft. Remember this exact value so the palette does not immediately
      // reopen; the next edit clears the marker in onPromptDraftChange.
      setSlashDismissedFor(String(value ?? ''));
    },
    [setSlashDismissedFor]
  );

  return {
    onPromptDraftChange,
    cancelProviderPrompt,
    cancelSettingsPrompt,
    acceptSlashPalette,
    completeSlashPalette,
    cancelSlashPalette,
  };
}
