// use-prompt-draft-flow/prompt-cancels.mjs
// Esc out of a text-entry prompt. Both paths supersede the panel epoch first —
// the keypress takes the surface back, so an in-flight save that acks later
// cannot reopen or replace whatever the user does next — and then return to
// the panel the prompt was reached from.
import { supersedePanelEpoch } from '../panel-epoch.mjs';

export function cancelProviderPromptFlow({ providerPrompt, oauthSubmitRef, setProviderPrompt }) {
  supersedePanelEpoch();
  try {
    providerPrompt?.login?.cancel?.();
  } catch {}
  oauthSubmitRef.current = false;
  const onCancel = providerPrompt?.cancelReturn || providerPrompt?.onCancel;
  const afterSave = providerPrompt?.afterSave;
  setProviderPrompt(null);
  if (onCancel) onCancel();
  else if (afterSave) afterSave();
}

export function cancelSettingsPromptFlow({
  settingsPrompt,
  setSettingsPrompt,
  openProjectPicker,
  openMemoryCorePicker,
  openAutoClearPicker,
}) {
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
}
