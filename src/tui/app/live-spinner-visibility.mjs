export function isCompletedTranscriptTail(latestTranscriptItem) {
  return latestTranscriptItem?.kind === 'turndone'
    || latestTranscriptItem?.kind === 'statusdone';
}

export function isCompletedTranscriptTailAppendedThisCommit(latestTranscriptItem, previousTailId) {
  return isCompletedTranscriptTail(latestTranscriptItem)
    && (latestTranscriptItem?.id ?? null) !== previousTailId;
}

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
