import { EMPTY_TRANSCRIPT_ITEMS, type Snapshot, type TranscriptItem } from './desktop-types';
import { useStreamingTail } from './use-conversation-rows';
import { useConversationTranscriptIdentity } from './use-conversation-transcript-identity';
import { useTranscriptHistory } from './use-transcript-history';

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
}: {
  snapshot: Snapshot;
  /** Empty for a draft: it has no older history to page. */
  historySessionId: string;
  transcriptSessionKey: string;
  transcriptPending: boolean;
  timelineMounted: { current: boolean };
  suppressDraftSubmitPaintHandoff: { current: boolean };
}) {
  const settledItems = Array.isArray(snapshot.items) ? snapshot.items : EMPTY_TRANSCRIPT_ITEMS;
  const { activeStreamingTail, liveItemCount, settledRowItems } = useStreamingTail(
    snapshot.streamingTail as TranscriptItem | null | undefined,
    settledItems
  );
  const requestEarlierTranscript = useTranscriptHistory(
    historySessionId,
    settledItems.length,
    typeof snapshot.transcriptHasOlder === 'boolean' ? snapshot.transcriptHasOlder : undefined
  );
  const identity = useConversationTranscriptIdentity({
    transcriptSessionKey,
    transcriptPending,
    timelineMounted,
    suppressDraftSubmitPaintHandoff,
  });
  return { settledItems, activeStreamingTail, liveItemCount, settledRowItems, requestEarlierTranscript, ...identity };
}
