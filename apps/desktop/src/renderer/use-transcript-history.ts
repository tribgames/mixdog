import { useCallback, useEffect, useReducer, useRef, type RefObject } from 'react';
import { noteHistoryPageRequest } from './tool-output-prefetch';
import {
  nextTranscriptHistoryLimit,
  nextTranscriptTailLimit,
  TRANSCRIPT_HISTORY_PAGE_ITEMS,
  TranscriptHistoryPager,
  type TranscriptPagingOutcome,
} from './transcript-history';
import { transcriptScrollExtent, transcriptScrollGeometryRegistered } from './use-transcript-follow';

/** The floor of the scroll lead (an unmeasured or tiny pane). */
export const TRANSCRIPT_HISTORY_TOP_PX = 320;

/** Viewport heights above the reader at which a scroll asks for older history:
 *  covers a page's round trip at the 15k px/s a repeated fling is boosted to (#104, Android). */
const TRANSCRIPT_HISTORY_LEAD_VIEWPORTS = 10;

/** Pages one entry may ask for to extend a scrollable first window toward the
 *  lead (see useTranscriptHistoryFill). */
const TRANSCRIPT_HISTORY_FILL_LEAD_PAGES = 4;

/** Scroll offset at or below which older history is requested. */
export function transcriptHistoryLead(viewportHeight: number): number {
  return Math.max(TRANSCRIPT_HISTORY_TOP_PX, viewportHeight * TRANSCRIPT_HISTORY_LEAD_VIEWPORTS);
}

/** While the whole transcript sits within the scroll lead, asks for older
 *  history, again whenever what the paging holds changes (`revision`:
 *  useTranscriptWindow's) or the rows' measured height changes. Each time it
 *  only asks: whether a page is already on its way, or none can come, is
 *  `requestEarlier`'s to answer from the window held then, so no order of a
 *  page's publication and its acknowledgement leaves the pane unasked. A pane
 *  that already scrolls extends toward the lead by at most
 *  TRANSCRIPT_HISTORY_FILL_LEAD_PAGES pages per entry; past that the scroll
 *  lead asks. */
export function useTranscriptHistoryFill(
  viewport: RefObject<HTMLElement | null>,
  requestEarlier: () => void,
  revision: unknown,
  ready: boolean
): void {
  const requestRef = useRef(requestEarlier);
  requestRef.current = requestEarlier;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const checkRef = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the trigger that re-checks after a page lands
  useEffect(() => {
    checkRef.current?.();
  }, [revision]);
  useEffect(() => {
    const root = viewport.current;
    if (!ready || !root) return undefined;
    let overflowing = false;
    let space: Element | null = null;
    // Revisions a lead page was asked at, this entry.
    const leadPages = new Set<unknown>();
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
        const revision = revisionRef.current;
        if (!leadPages.has(revision) && leadPages.size >= TRANSCRIPT_HISTORY_FILL_LEAD_PAGES) return;
        leadPages.add(revision);
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

/** The one page asked of the host. It belongs to the window it was asked of, named by where that window began and by its
 *  generation: everything else about it (whether it is still on its way, whether another may be asked) is read from the window
 *  held at the moment of the question (`standing`). */
interface PageRequest {
  /** Where the window began when the page was asked. */
  at: unknown;
  /** The window's generation then: a rewind makes another window of it, though it begins at the same item. */
  generation: unknown;
  /** The rows the page asked the window to hold. */
  limit: number;
  /** 'none': the host answered that nothing older could join the window where it begins (the core's view ends there). */
  outcome: 'open' | 'none';
  /** Ends the background-read hold (tool-output-prefetch.ts) the page keeps while it is on its way (once). */
  release: () => void;
}

interface HistoryPaging {
  sessionId: string;
  /** The largest window a host that predates `transcriptHasOlder` has taken. */
  limit: number;
  request: PageRequest | null;
}

/** What the host states of the thread's live tail window (`transcriptHistoryOf`), and the rows the pane holds of it. */
interface WindowFacts {
  start: unknown;
  generation: unknown;
  count: number;
  /** 'unknown': the host states neither; it is asked by row counts (`nextTranscriptHistoryLimit`). */
  history: 'held' | 'older' | 'unknown';
}

/** What the core holds above the window a state shows, as the state says it: `transcriptHistory` when the host states it, the
 *  older `transcriptHasOlder` when it is a boolean, and 'unknown' only for a host that says neither. An absent
 *  `transcriptHasOlder` beside a stated history is never read. */
export function transcriptHistoryOf(state: {
  transcriptHistory?: unknown;
  transcriptHasOlder?: unknown;
}): WindowFacts['history'] {
  if (state.transcriptHistory === 'held' || state.transcriptHistory === 'older') return state.transcriptHistory;
  if (typeof state.transcriptHasOlder === 'boolean') return state.transcriptHasOlder ? 'older' : 'held';
  return 'unknown';
}

const newPaging = (sessionId: string): HistoryPaging => ({
  sessionId,
  limit: TRANSCRIPT_HISTORY_PAGE_ITEMS,
  request: null,
});

function endRequest(paging: HistoryPaging, request: PageRequest): void {
  request.release();
  if (paging.request === request) paging.request = null;
}

/** The request as it stands against the window held now, or null once it is over: the window is another one (it begins
 *  elsewhere, or a reset made a new generation of it), the thread's start is held, or newer rows already make up the rows it
 *  asked for (it would bring nothing: the next question asks anew). Until then an open request is a page on its way, whether
 *  or not the host has acknowledged it, and one answered 'none' says the window grows no further here. */
function standing(paging: HistoryPaging, facts: WindowFacts): PageRequest | null {
  const request = paging.request;
  if (!request) return null;
  const here =
    Object.is(request.at, facts.start) && Object.is(request.generation, facts.generation) && facts.history !== 'held';
  const wanted = request.outcome === 'none' || facts.history === 'unknown' || facts.count < request.limit;
  if (here && wanted) return request;
  endRequest(paging, request);
  return null;
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
  following: boolean,
  /** Where the live tail's window begins (`transcriptWindowStart`). */
  liveWindowStart?: string,
  /** Its generation (`transcriptGeneration`). */
  liveGeneration?: number
) {
  const liveRef = useRef({ items: liveItems, hasOlder: liveHasOlder === true });
  liveRef.current = { items: liveItems, hasOlder: liveHasOlder === true };
  const [paged, changed] = useReducer((count: number) => count + 1, 0);
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
  const exhaustedRef = useRef<() => void>(() => undefined);
  const growWindow = useTranscriptHistory(
    sessionId,
    liveItems.length,
    liveHasOlder,
    liveWindowStart,
    () => exhaustedRef.current(),
    liveGeneration
  );
  // A reset made another window of the live tail: rows read by position above the old one are not above this one.
  const generationRef = useRef(liveGeneration);
  if (generationRef.current !== liveGeneration) {
    generationRef.current = liveGeneration;
    pager.forget();
  }
  // A window that holds no row while older history exists (a rewind above it took all it held) has no pane to measure and
  // no row to scroll: it asks for its page as it is.
  const empty = liveItems.length === 0 && liveHasOlder === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the generation names the window that is empty
  useEffect(() => {
    if (empty) growWindow();
  }, [empty, growWindow, liveGeneration]);
  const followingRef = useRef(following);
  followingRef.current = following;
  useEffect(() => {
    if (following) void pager.atBottom();
  }, [following, pager]);
  const requestEarlier = useCallback(() => {
    if (!sessionId) return;
    // A host that predates `transcriptHasOlder` or cannot read by position
    // grows the session's window.
    if (liveHasOlder === undefined || pager.unsupported) {
      growWindow();
      return;
    }
    const settle = (outcome: TranscriptPagingOutcome): void => {
      if (pager.window) return;
      if (outcome === 'unsupported') growWindow();
      // The window the page was asked for, not the rows held now.
      else if (outcome === 'moved') growWindow(pager.movedFrom);
    };
    // A reader still following the tail (a short first window filling the
    // pane) grows the session's window; past the core's view, rows are read
    // by position above the live tail.
    if (followingRef.current && !pager.window) {
      if (growWindow() === 'exhausted') void pager.earlier(true).then(settle);
      return;
    }
    void pager.earlier().then(settle);
  }, [growWindow, liveHasOlder, pager, sessionId]);
  exhaustedRef.current = requestEarlier;
  const requestLater = useCallback(() => {
    void pager.later();
  }, [pager]);
  const resetToLive = useCallback(() => {
    pager.toLive();
  }, [pager]);
  const held = pager.window;
  const tail = pager.tail();
  const items = held ? held.items : tail.items;
  const hasOlder = held ? held.hasOlder : tail.items === liveItems ? liveHasOlder : tail.hasOlder;
  return {
    items,
    hasOlder,
    /** Changes whenever what a paging decision reads does: the rows shown, where the live window begins, whether older rows
     *  exist, a positional page (useTranscriptHistoryFill decides again at each). */
    revision: `${paged}:${items.length}:${liveItems.length}:${liveWindowStart ?? ''}:${liveGeneration ?? ''}:${String(hasOlder)}`,
    historyActive: held !== null,
    requestEarlier,
    requestLater,
    resetToLive,
  };
}

/** Grows the window by a page from the rows held now, or (a number) from that many rows. 'exhausted': the host had nothing older
 *  to add where the window begins now, and `onExhausted` is told when a page finds that. `windowStart` is where the window begins
 *  (`transcriptWindowStart`); a host that names none is measured by the rows it holds.
 *
 *  One request is out per window start (`PageRequest`). Whether it still stands is decided from the window held each time the
 *  question is asked: here, and whenever the window published changes. */
export function useTranscriptHistory(
  sessionId: string,
  itemCount: number,
  hasOlder?: boolean,
  windowStart?: string,
  onExhausted?: () => void,
  /** The window's generation (`transcriptGeneration`). */
  generation?: number
): (heldRows?: unknown) => 'exhausted' | undefined {
  const facts: WindowFacts = {
    start: windowStart ?? itemCount,
    generation,
    count: itemCount,
    history: transcriptHistoryOf({ transcriptHasOlder: hasOlder }),
  };
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const exhaustedRef = useRef(onExhausted);
  exhaustedRef.current = onExhausted;
  const pagingRef = useRef(newPaging(sessionId));
  if (pagingRef.current.sessionId !== sessionId) pagingRef.current = newPaging(sessionId);
  // The page's window may be published before or after its read is acknowledged: the request, and the background-read hold
  // with it, end on the window held, in either order.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the window's facts are the trigger; they are read through the ref
  useEffect(() => {
    standing(pagingRef.current, factsRef.current);
  }, [facts.start, facts.generation, facts.count, facts.history]);
  // Leaving the session (or unmounting) ends the request.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionId is the trigger; the paging it owns is read at setup
  useEffect(() => {
    const paging = pagingRef.current;
    return () => {
      if (paging.request) endRequest(paging, paging.request);
    };
  }, [sessionId]);
  return useCallback(
    (heldRows?: unknown) => {
      const prefetch = window.mixdogDesktop?.prefetchSession;
      const paging = pagingRef.current;
      if (!sessionId || !prefetch) return undefined;
      const held = factsRef.current;
      const out = standing(paging, held);
      if (out) return out.outcome === 'none' ? 'exhausted' : undefined;
      const tail = held.history !== 'unknown';
      // A click handler hands its event here: only a number names the rows a window is grown from.
      const count = typeof heldRows === 'number' ? heldRows : held.count;
      const limit = tail
        ? nextTranscriptTailLimit(count, held.history === 'older')
        : nextTranscriptHistoryLimit(count, paging.limit);
      if (limit === null) return undefined;
      // Background tool-output reads hold off while the page is on its way.
      const request: PageRequest = {
        at: held.start,
        generation: held.generation,
        limit,
        outcome: 'open',
        release: noteHistoryPageRequest(),
      };
      paging.request = request;
      void Promise.resolve()
        .then(() => prefetch(sessionId, limit))
        .then(
          (accepted) => {
            if (pagingRef.current !== paging) return;
            if (accepted === true) {
              // The page is on its way, or here already: the window held says which (`standing`).
              if (!tail) paging.limit = limit;
              return;
            }
            // The request ended with its window meanwhile: its answer is about a window no longer held.
            if (paging.request !== request) return;
            if (!tail || accepted !== false) return endRequest(paging, request);
            // `false` from a tail host: nothing older could join the window where it begins.
            request.release();
            request.outcome = 'none';
            exhaustedRef.current?.();
          },
          // Read-only failures remain retryable on the next boundary gesture.
          () => endRequest(paging, request)
        );
      return undefined;
    },
    [sessionId]
  );
}
