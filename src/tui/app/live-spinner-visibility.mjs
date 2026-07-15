export function isLiveSpinnerMetaVisible({
  inputBoxHidden,
  slashPaletteOpen,
  liveSpinner,
  liveSpinnerIsCommand,
  latestTranscriptItem,
}) {
  return !inputBoxHidden && !slashPaletteOpen && !!liveSpinner
    && (liveSpinnerIsCommand || latestTranscriptItem?.kind !== 'turndone');
}
