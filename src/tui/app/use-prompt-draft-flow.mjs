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
import { withPickerEnterLatch } from './picker-enter-latch.mjs';
import { completeSkillMention } from './skill-mention-palette.mjs';
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
      promptHistoryDraftChangeRef,
      promptHistoryNavRef,
      setPromptDraft,
      setPromptDraftOverride,
      promptHintActiveRef,
      promptHintTimerRef,
      setSlashDismissedFor,
    ]
  );

  const cancelProviderPrompt = useCallback(
    () => cancelProviderPromptFlow({ providerPrompt, oauthSubmitRef, setProviderPrompt }),
    [providerPrompt, oauthSubmitRef, setProviderPrompt]
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
    [settingsPrompt, setSettingsPrompt, openProjectPicker, openMemoryCorePicker, openAutoClearPicker]
  );

  const acceptSlashPalette = useCallback(
    (draftValue = '', caret) => {
      const command = slashCommands[slashIndex];
      if (!command) return false;
      // A skill row completes the `$name` mention at the caret (the returned
      // { value, cursor } replaces the draft) instead of running anything.
      if (command.kind === 'skill') return completeSkillMention(draftValue, command.name, caret) ?? false;
      return withPickerEnterLatch(pickerOpenedFromEnterRef, pickerOpenedFromEnterTimerRef, () =>
        runSlashCommand(slashCommandTokenForPaletteAccept(command, draftValue), '')
      );
    },
    [slashCommands, slashIndex, pickerOpenedFromEnterRef, pickerOpenedFromEnterTimerRef, runSlashCommand]
  );

  const completeSlashPalette = useCallback(
    (draftValue = '', caret) => {
      const command = slashCommands[slashIndex];
      if (!command) return undefined;
      if (command.kind === 'skill') return completeSkillMention(draftValue, command.name, caret);
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
