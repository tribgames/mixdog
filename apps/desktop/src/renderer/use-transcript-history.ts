import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { nextTranscriptHistoryLimit, nextTranscriptTailLimit, TRANSCRIPT_HISTORY_PAGE_ITEMS } from './transcript-history';
import { transcriptScrollExtent, transcriptScrollGeometryRegistered } from './use-transcript-follow';

/** Read completion and transcript publication are separate transport events.
 * Track the requested window, not the count one animation frame after an ACK.
 * A cold mount with no rows must also remain eligible once its page arrives.
 *
 * `hasOlder` is the snapshot's `transcriptHasOlder`: a host that serves tail
 * windows says whether older history exists, and each page asks for the
 * current count plus one page. Without it (an older host) the count-based
 * 512-item paging applies. */
/** Distance from the top of the transcript at which older history loads. */
export const TRANSCRIPT_HISTORY_TOP_PX = 320;

/** A first window may hold only a few rows (the daemon's byte budget cuts a
 *  window of huge rows to 8), and collapsed rows may not fill the pane: with
 *  nothing to scroll, no scroll ever reaches the top. While the whole
 *  transcript sits within the top threshold, ask for older history — again
 *  after each page lands or the rows' measured height changes. The request
 *  itself dedupes, waits for the previous page, and stops when the host says
 *  nothing older exists. */
export function useTranscriptHistoryFill(
  viewport: RefObject<HTMLElement | null>,
  requestEarlier: () => void,
  itemCount: number,
  ready: boolean
): void {
  const requestRef = useRef(requestEarlier);
  requestRef.current = requestEarlier;
  const checkRef = useRef<(() => void) | null>(null);
  // A landed page re-checks through the long-lived observer below. Recreating
  // that observer per item count re-delivered (and re-measured) the whole
  // transcript on every page: 1.3 s on a phone growing to 500 items.
  useEffect(() => {
    checkRef.current?.();
  }, [itemCount]);
  useEffect(() => {
    const root = viewport.current;
    if (!ready || !root) return undefined;
    let overflowing = false;
    let space: Element | null = null;
    // The virtual list writes its total height to this spacer directly.
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            // Once the rows overflow, scrolling takes over: only a viewport
            // resize can make the pane unfilled again.
            if (overflowing && !entries.some((entry) => entry.target === root)) return;
            check();
          })
        : null;
    const check = (): void => {
      // No timeline yet, no rows to fill: the extent would come from a forced
      // layout of an empty pane. The row count that mounts it checks again.
      if (!transcriptScrollGeometryRegistered(root)) return;
      const next = root.querySelector('.transcript-virtual-space');
      if (observer && next !== space) {
        if (space) observer.unobserve(space);
        space = next;
        if (space) observer.observe(space);
      }
      overflowing = transcriptScrollExtent(root).maxScrollTop > TRANSCRIPT_HISTORY_TOP_PX;
      if (!overflowing) requestRef.current();
    };
    observer?.observe(root);
    checkRef.current = check;
    check();
    return () => {
      observer?.disconnect();
      if (checkRef.current === check) checkRef.current = null;
    };
  }, [viewport, ready]);
}

export function useTranscriptHistory(sessionId: string, itemCount: number, hasOlder?: boolean): () => void {
  const countRef = useRef(itemCount);
  countRef.current = itemCount;
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const pagingRef = useRef({
    sessionId,
    limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
    pagedFrom: -1,
    pending: false,
  });
  if (pagingRef.current.sessionId !== sessionId) {
    pagingRef.current = {
      sessionId,
      limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
      pagedFrom: -1,
      pending: false,
    };
  }
  return useCallback(() => {
    const prefetch = window.mixdogDesktop?.prefetchSession;
    const paging = pagingRef.current;
    if (!sessionId || !prefetch || paging.pending) return;
    const older = hasOlderRef.current;
    const tail = typeof older === 'boolean';
    const count = countRef.current;
    const nextLimit = tail
      ? nextTranscriptTailLimit(count, paging.pagedFrom, older)
      : nextTranscriptHistoryLimit(count, paging.limit);
    if (nextLimit === null) return;
    paging.pending = true;
    void Promise.resolve()
      .then(() => prefetch(sessionId, nextLimit))
      .then((accepted) => {
        if (pagingRef.current !== paging || accepted !== true) return;
        if (tail) paging.pagedFrom = count;
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
