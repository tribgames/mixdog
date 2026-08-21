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
  streamingTail,
  transcriptViewActive = false,
}) {
  const visibleStreamingAssistant = !transcriptViewActive
    && streamingTail?.kind === 'assistant'
    && streamingTail.streaming === true
    && String(streamingTail.text || '').trim().length > 0;
  return !inputBoxHidden && !slashPaletteOpen && !!liveSpinner
    && (liveSpinnerIsCommand || latestTranscriptItem?.kind !== 'turndone')
    && (liveSpinnerIsCommand || !visibleStreamingAssistant);
}
