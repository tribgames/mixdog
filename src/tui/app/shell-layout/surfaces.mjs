/**
 * src/tui/app/shell-layout/surfaces.mjs - which surfaces own the bottom area
 * this render (floating panels, text-entry prompts, boot settling) and the
 * live spinner / transient hint the prompt cluster shows.
 */
export function deriveSurfaces({
  providerPrompt,
  settingsPrompt,
  toolApproval,
  picker,
  contextPanel,
  usagePanel,
  slashPaletteOpen,
  tuiReady,
  state,
  panelTransitionRef,
  projectBootInputLatchRef,
}) {
  const textEntryPrompt = providerPrompt || settingsPrompt;
  const hasTextEntryPrompt = !!textEntryPrompt;
  const hasFloatingPanel = !!(
    toolApproval ||
    picker ||
    contextPanel ||
    usagePanel ||
    slashPaletteOpen ||
    hasTextEntryPrompt
  );
  const expandedOptionPanel = !!(toolApproval || picker || contextPanel || usagePanel || hasTextEntryPrompt);
  if (panelTransitionRef.current.signature.includes('picker:project') && !picker) {
    projectBootInputLatchRef.current = true;
  }
  const bootSettling = !tuiReady && state.items.length === 0 && !hasFloatingPanel && !projectBootInputLatchRef.current;
  // Project selection (initial-entry experience) keeps the welcome banner
  // visible above the picker / path-entry prompt, unlike other floating panels.
  const projectSelectionActive =
    picker?.kind === 'project' ||
    settingsPrompt?.kind === 'project-new' ||
    settingsPrompt?.kind === 'project-create-confirm' ||
    settingsPrompt?.kind === 'project-rename';
  // Slash search floats above the normal prompt. Actual option panels own the
  // prompt/status area, so they hide those rows and expand into that space.
  const inputBoxHidden = expandedOptionPanel || bootSettling;
  return {
    textEntryPrompt,
    hasTextEntryPrompt,
    hasFloatingPanel,
    expandedOptionPanel,
    bootSettling,
    projectSelectionActive,
    inputBoxHidden,
  };
}

export function deriveLiveHints({ state, promptHint, promptHintTone }) {
  let liveSpinner = null;
  if (state.spinner?.active) liveSpinner = state.spinner;
  else if (state.commandStatus?.active) liveSpinner = state.commandStatus;
  // Command-status spinner (auto-clear/compact/etc.) is NOT part of the
  // spinner → TurnDone handoff: it typically starts while the transcript tail
  // is already a done row (idle session), so the done-at-tail suppression
  // must never hide it — that read as a frozen UI during auto-clear.
  const liveSpinnerIsCommand = !state.spinner?.active && !!state.commandStatus?.active;
  const latestToast = state.toasts?.length ? state.toasts[state.toasts.length - 1] : null;
  const toastHint = latestToast ? latestToast.text : '';
  const progressHint = state.progressHint || null;
  const inputHint = promptHint || toastHint || progressHint?.text || '';
  const inputHintTone = promptHint ? promptHintTone : latestToast?.tone || progressHint?.tone || 'info';
  const latestTranscriptItem = state.items[state.items.length - 1] || null;
  return {
    liveSpinner,
    liveSpinnerIsCommand,
    latestToast,
    toastHint,
    progressHint,
    inputHint,
    inputHintTone,
    latestTranscriptItem,
  };
}
