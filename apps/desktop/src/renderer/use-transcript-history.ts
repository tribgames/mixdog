import { useCallback, useRef } from 'react';
import { nextTranscriptHistoryLimit, nextTranscriptTailLimit, TRANSCRIPT_HISTORY_PAGE_ITEMS } from './transcript-history';

/** Read completion and transcript publication are separate transport events.
 * Track the requested window, not the count one animation frame after an ACK.
 * A cold mount with no rows must also remain eligible once its page arrives.
 *
 * `hasOlder` is the snapshot's `transcriptHasOlder`: a host that serves tail
 * windows says whether older history exists, and each page asks for the
 * current count plus one page. Without it (an older host) the count-based
 * 512-item paging applies. */
export function useTranscriptHistory(sessionId: string, itemCount: number, hasOlder?: boolean): () => void {
  const countRef = useRef(itemCount);
  countRef.current = itemCount;
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const pagingRef = useRef({
    sessionId,
    limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
    requested: 0,
    pending: false,
  });
  if (pagingRef.current.sessionId !== sessionId) {
    pagingRef.current = {
      sessionId,
      limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
      requested: 0,
      pending: false,
    };
  }
  return useCallback(() => {
    const prefetch = window.mixdogDesktop?.prefetchSession;
    const paging = pagingRef.current;
    if (!sessionId || !prefetch || paging.pending) return;
    const older = hasOlderRef.current;
    const tail = typeof older === 'boolean';
    const nextLimit = tail
      ? nextTranscriptTailLimit(countRef.current, paging.requested, older)
      : nextTranscriptHistoryLimit(countRef.current, paging.limit);
    if (nextLimit === null) return;
    paging.pending = true;
    void Promise.resolve()
      .then(() => prefetch(sessionId, nextLimit))
      .then((accepted) => {
        if (pagingRef.current !== paging || accepted !== true) return;
        if (tail) paging.requested = nextLimit;
        else paging.limit = nextLimit;
      })
      .catch(() => {
        // Read-only failures remain retryable on the next boundary gesture.
      })
      .finally(() => {
        if (pagingRef.current === paging) paging.pending = false;
      });
  }, [sessionId]);
}
