import { useCallback, useRef } from "react";
import { nextTranscriptHistoryLimit, TRANSCRIPT_HISTORY_PAGE_ITEMS } from "./transcript-history";

/** Read completion and transcript publication are separate transport events.
 * Track the requested window, not the count one animation frame after an ACK.
 * A cold mount with no rows must also remain eligible once its page arrives. */
export function useTranscriptHistory(sessionId: string, itemCount: number): () => void {
  const countRef = useRef(itemCount);
  countRef.current = itemCount;
  const pagingRef = useRef({
    sessionId,
    limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
    pending: false,
  });
  if (pagingRef.current.sessionId !== sessionId) {
    pagingRef.current = {
      sessionId,
      limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
      pending: false,
    };
  }
  return useCallback(() => {
    const prefetch = window.mixdogDesktop?.prefetchSession;
    const paging = pagingRef.current;
    if (!sessionId || !prefetch || paging.pending) return;
    const nextLimit = nextTranscriptHistoryLimit(countRef.current, paging.limit);
    if (nextLimit === null) return;
    paging.pending = true;
    void Promise.resolve().then(() => prefetch(sessionId, nextLimit)).then((accepted) => {
      if (pagingRef.current !== paging) return;
      if (accepted === true) paging.limit = nextLimit;
    }).catch(() => {
      // Read-only failures remain retryable on the next boundary gesture.
    }).finally(() => {
      if (pagingRef.current === paging) paging.pending = false;
    });
  }, [sessionId]);
}
