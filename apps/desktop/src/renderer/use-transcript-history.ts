import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react';
import { noteHistoryPageRequest } from './tool-output-prefetch';
import {
  nextTranscriptHistoryLimit,
  nextTranscriptTailLimit,
  TRANSCRIPT_HISTORY_PAGE_ITEMS,
  TranscriptHistoryPager,
} from './transcript-history';
import { transcriptScrollExtent, transcriptScrollGeometryRegistered } from './use-transcript-follow';

/** The floor of the scroll lead (an unmeasured or tiny pane). */
export const TRANSCRIPT_HISTORY_TOP_PX = 320;

/** Viewport heights above the reader at which a scroll asks for older history.
 *  Asked for only 320px from the top, a fast fling crossed that band in a few
 *  frames and ended against the top edge before the page arrived: the
 *  momentum died, then the page landed (#104, Android: 위로 빠르게 넘기면
 *  버벅거림). Repeated flings are boosted past 15k px/s, so the lead has to
 *  cover a page's round trip at that speed. The landing's anchor restore keeps
 *  the reader in place wherever the page lands, so asking early costs nothing
 *  but the (bounded) pages themselves. */
export const TRANSCRIPT_HISTORY_LEAD_VIEWPORTS = 10;

/** Pages one entry may ask for to extend a scrollable first window toward the
 *  lead (see useTranscriptHistoryFill). */
export const TRANSCRIPT_HISTORY_FILL_LEAD_PAGES = 4;

/** Scroll offset at or below which older history is requested. */
export function transcriptHistoryLead(viewportHeight: number): number {
  return Math.max(TRANSCRIPT_HISTORY_TOP_PX, viewportHeight * TRANSCRIPT_HISTORY_LEAD_VIEWPORTS);
}

/** A first window may hold only a few rows (the daemon's byte budget cuts a
 *  window of huge rows to 8), and collapsed rows may not fill the pane: with
 *  nothing to scroll, no scroll ever reaches the top. A window shorter than
 *  the scroll lead puts the reader inside it from the first fling, so a page
 *  lands under nearly every early fling, and a fling can cross the whole
 *  window before the page's round trip. While the whole transcript sits
 *  within the lead, ask for older history — again after each page lands or
 *  the rows' measured height changes. A pane that already scrolls extends
 *  toward the lead by at most TRANSCRIPT_HISTORY_FILL_LEAD_PAGES pages per
 *  entry (pages of tiny rows would otherwise page in the whole history);
 *  past that the scroll lead asks. The request itself dedupes, waits for the
 *  previous page, and stops when the host says nothing older exists. */
export function useTranscriptHistoryFill(
  viewport: RefObject<HTMLElement | null>,
  requestEarlier: () => void,
  itemCount: number,
  ready: boolean
): void {
  const requestRef = useRef(requestEarlier);
  requestRef.current = requestEarlier;
  const countRef = useRef(itemCount);
  countRef.current = itemCount;
  const checkRef = useRef<(() => void) | null>(null);
  // A landed page re-checks through the long-lived observer below. Recreating
  // that observer per item count re-delivered (and re-measured) the whole
  // transcript on every page: 1.3 s on a phone growing to 500 items.
  // biome-ignore lint/correctness/useExhaustiveDependencies: itemCount is the trigger that re-checks after a page lands
  useEffect(() => {
    checkRef.current?.();
  }, [itemCount]);
  useEffect(() => {
    const root = viewport.current;
    if (!ready || !root) return undefined;
    let overflowing = false;
    let space: Element | null = null;
    // Item counts a lead page was asked at, this entry.
    const leadPages = new Set<number>();
    // The virtual list writes its total height to this spacer directly.
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            // Once the rows overflow the lead, scrolling takes over: only a viewport
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
      const extent = transcriptScrollExtent(root);
      overflowing = extent.maxScrollTop > transcriptHistoryLead(extent.viewportHeight);
      if (overflowing) return;
      if (extent.maxScrollTop > TRANSCRIPT_HISTORY_TOP_PX) {
        const count = countRef.current;
        if (!leadPages.has(count) && leadPages.size >= TRANSCRIPT_HISTORY_FILL_LEAD_PAGES) return;
        leadPages.add(count);
      }
      requestRef.current();
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

/** Read completion and transcript publication are separate transport events.
 * Track the requested window, not the count one animation frame after an ACK.
 * A cold mount with no rows must also remain eligible once its page arrives.
 *
 * `hasOlder` is the snapshot's `transcriptHasOlder`: a host that serves tail
 * windows says whether older history exists, and each page asks for the
 * current count plus one page. Without it (an older host) the count-based
 * 512-item paging applies. */
interface HistoryPaging {
  sessionId: string;
  limit: number;
  pagedFrom: number;
  pending: boolean;
  /** The page on its way: the count it was asked at, and the release of the
   *  background-read hold (tool-output-prefetch.ts) it keeps until it lands. */
  page: { from: number; release: () => void } | null;
}

const newPaging = (sessionId: string): HistoryPaging => ({
  sessionId,
  limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
  pagedFrom: -1,
  pending: false,
  page: null,
});

/** The page's background-read hold ends (once). */
function endPage(paging: HistoryPaging, page = paging.page): void {
  if (!page || paging.page !== page) return;
  paging.page = null;
  page.release();
}

/**
 * The rows a pane renders and how it pages. On the live tail (following, or a
 * host that cannot read history by position) older history grows the
 * session's window as before. A reader who scrolled up pages through a
 * history window of its own (TranscriptHistoryPager): at most
 * TRANSCRIPT_WINDOW_MAX_ITEMS items within their character bound, read by
 * position from the daemon, never patched by live frames; at the bottom it
 * returns to a fresh live tail.
 */
export function useTranscriptWindow<T extends { readonly id?: unknown }>(
  sessionId: string,
  liveItems: readonly T[],
  liveHasOlder: boolean | undefined,
  following: boolean
) {
  const liveRef = useRef({ items: liveItems, hasOlder: liveHasOlder === true });
  liveRef.current = { items: liveItems, hasOlder: liveHasOlder === true };
  const [, changed] = useReducer((count: number) => count + 1, 0);
  const pagerRef = useRef<TranscriptHistoryPager<T> | null>(null);
  if (!pagerRef.current || pagerRef.current.sessionId !== sessionId) {
    pagerRef.current?.dispose();
    pagerRef.current = new TranscriptHistoryPager<T>(
      sessionId,
      () => window.mixdogDesktop?.readTranscriptHistory,
      () => liveRef.current,
      changed
    );
  }
  const pager = pagerRef.current;
  useEffect(() => () => pager.dispose(), [pager]);
  const growWindow = useTranscriptHistory(sessionId, liveItems.length, liveHasOlder);
  const followingRef = useRef(following);
  followingRef.current = following;
  useEffect(() => {
    if (following) void pager.atBottom();
  }, [following, pager]);
  const requestEarlier = useCallback(() => {
    if (!sessionId) return;
    // A host that predates `transcriptHasOlder` or reads by position, and a
    // reader still following the tail (a short first window filling the
    // pane), grow the session's window.
    if (liveHasOlder === undefined || pager.unsupported || (followingRef.current && !pager.window)) {
      growWindow();
      return;
    }
    void pager.earlier().then((outcome) => {
      if (outcome === 'unsupported' && !pager.window) growWindow();
    });
  }, [growWindow, liveHasOlder, pager, sessionId]);
  const requestLater = useCallback(() => {
    void pager.later();
  }, [pager]);
  const resetToLive = useCallback(() => {
    pager.toLive();
  }, [pager]);
  const held = pager.window;
  return {
    items: held ? held.items : liveItems,
    hasOlder: held ? held.hasOlder : liveHasOlder,
    historyActive: held !== null,
    requestEarlier,
    requestLater,
    resetToLive,
  };
}

export function useTranscriptHistory(sessionId: string, itemCount: number, hasOlder?: boolean): () => void {
  const countRef = useRef(itemCount);
  countRef.current = itemCount;
  const hasOlderRef = useRef(hasOlder);
  hasOlderRef.current = hasOlder;
  const pagingRef = useRef(newPaging(sessionId));
  if (pagingRef.current.sessionId !== sessionId) pagingRef.current = newPaging(sessionId);
  // The ACK of a page read comes apart from the page itself (its transcript
  // frame may land before or after it): background reads resume once the
  // published window holds more rows than the page was asked at, or says
  // nothing older exists — after the rows are applied, not on the ACK.
  useEffect(() => {
    const paging = pagingRef.current;
    const page = paging.page;
    if (page && (itemCount > page.from || hasOlder === false)) endPage(paging, page);
    // The window restarted from a shorter tail (the host answered it whole):
    // older rows page in again from there.
    if (itemCount < paging.pagedFrom) paging.pagedFrom = -1;
  }, [itemCount, hasOlder]);
  // Leaving the session (or unmounting) cancels the wait.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; the paging it owns is read at setup
  useEffect(() => {
    const paging = pagingRef.current;
    return () => endPage(paging);
  }, [sessionId]);
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
    // Background tool-output reads hold off while the page is on its way.
    endPage(paging);
    const page = { from: count, release: noteHistoryPageRequest() };
    paging.page = page;
    void Promise.resolve()
      .then(() => prefetch(sessionId, nextLimit))
      .then((accepted) => {
        // A refused read brings no page.
        if (accepted !== true) endPage(paging, page);
        if (pagingRef.current !== paging || accepted !== true) return;
        // A window that restarted shorter meanwhile pages again from its tail.
        if (tail) paging.pagedFrom = countRef.current < count ? -1 : count;
        else paging.limit = nextLimit;
      })
      .catch(() => {
        // Read-only failures remain retryable on the next boundary gesture.
        endPage(paging, page);
      })
      .finally(() => {
        if (pagingRef.current === paging) paging.pending = false;
      });
  }, [sessionId]);
}
