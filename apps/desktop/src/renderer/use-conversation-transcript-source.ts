import { EMPTY_TRANSCRIPT_ITEMS, type Snapshot, type TranscriptItem } from './desktop-types';
import { useStreamingTail } from './use-conversation-rows';
import { useConversationTranscriptIdentity } from './use-conversation-transcript-identity';
import { positionedFactsOf, transcriptHistoryOf, useTranscriptWindow } from './use-transcript-history';

export type ConversationTranscriptSource = ReturnType<typeof useConversationTranscriptSource>;

/** The transcript this pane renders: settled items, the live streaming tail,
 *  older-history paging, and the timeline identity. */
export function useConversationTranscriptSource({
  snapshot,
  historySessionId,
  transcriptSessionKey,
  transcriptPending,
  timelineMounted,
  suppressDraftSubmitPaintHandoff,
  following,
}: {
  snapshot: Snapshot;
  /** The reader follows the live tail (the history window ends there). */
  following: boolean;
  /** Empty for a draft: it has no older history to page. */
  historySessionId: string;
  transcriptSessionKey: string;
  transcriptPending: boolean;
  timelineMounted: { current: boolean };
  suppressDraftSubmitPaintHandoff: { current: boolean };
}) {
  const liveItems = Array.isArray(snapshot.items) ? snapshot.items : EMPTY_TRANSCRIPT_ITEMS;
  // What the host states of the window: an absent `transcriptHasOlder` is "says nothing" only when no history is stated.
  const stated = transcriptHistoryOf(snapshot);
  const history = useTranscriptWindow(
    historySessionId,
    liveItems,
    stated === 'unknown' ? undefined : stated === 'older',
    following,
    typeof snapshot.transcriptWindowStart === 'string' ? snapshot.transcriptWindowStart : undefined,
    typeof snapshot.transcriptGeneration === 'number' ? snapshot.transcriptGeneration : undefined,
    historySessionId ? positionedFactsOf<TranscriptItem>(snapshot as Record<string, unknown>) : undefined
  );
  // A history window shows past rows only: the live streaming line stays
  // with the live tail.
  const settledItems = history.items as TranscriptItem[];
  const { activeStreamingTail, liveItemCount, settledRowItems } = useStreamingTail(
    history.historyActive ? null : (snapshot.streamingTail as TranscriptItem | null | undefined),
    settledItems
  );
  const requestEarlierTranscript = history.requestEarlier;
  const requestLaterTranscript = history.requestLater;
  const transcriptReaderAt = history.readerAt;
  const resetTranscriptToLive = history.resetToLive;
  const transcriptHistoryActive = history.historyActive;
  const identity = useConversationTranscriptIdentity({
    transcriptSessionKey,
    transcriptPending,
    timelineMounted,
    suppressDraftSubmitPaintHandoff,
  });
  return {
    settledItems,
    /** The live tail's rows (submission, the running turn, links), whatever
     *  window the reader scrolled into. */
    liveSettledItems: liveItems,
    activeStreamingTail,
    liveItemCount,
    settledRowItems,
    requestEarlierTranscript,
    requestLaterTranscript,
    /** A positioned transcript's paging: told the first and last items in the reader's view; null for a window paged by
     *  scroll offsets (`requestEarlierTranscript`, `requestLaterTranscript`). */
    transcriptReaderAt,
    resetTranscriptToLive,
    transcriptHistoryActive,
    /** A read of older rows is out: its page lands above the rows shown. */
    transcriptOlderReading: history.olderReading,
    transcriptHistoryRevision: history.revision,
    ...identity,
  };
}
