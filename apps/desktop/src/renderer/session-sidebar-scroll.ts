import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionListInsertedAtTop, sessionListKeepsExistingTopInsert } from './first-submit-stability';
import type { NavigationSelection } from './nav-types';
import type { ProjectSessionGroup } from './session-sidebar-sections';
import type { OpenMap } from './sidebar-open-state';

export const RECENT_SESSION_INITIAL_ROWS = 24;
export const RECENT_SESSION_PAGE_ROWS = 32;
/** Scroller viewport heights below the viewport at which a session list's end
 *  sentinel reveals the next page. Revealed only 240px ahead, a fast phone
 *  fling crossed that band in a few frames and ran into the end of the
 *  revealed rows before the page committed: the momentum died there and the
 *  rows appeared under a list at rest (phone: 빠르게 스크롤하고 놓으니 중간에
 *  멈추고 덜덜). Each revealed page re-checks (useSessionListPaging), so pages
 *  chain until the end is this far ahead again; rows outside the viewport
 *  are spacers (session-sidebar-virtual-rows), so the lead costs little. */
const RECENT_SENTINEL_REVEAL_LEAD_VIEWPORTS = 4;
/** The lead's floor, for a scroller without a box yet. */
const RECENT_SENTINEL_REVEAL_MIN_PX = 240;

/** How close a session list's end sentinel has to come to the bottom of a
 *  scroller viewport this tall before the next page is revealed. */
function sessionListRevealLead(viewportHeight: number): number {
  return Math.max(RECENT_SENTINEL_REVEAL_MIN_PX, viewportHeight * RECENT_SENTINEL_REVEAL_LEAD_VIEWPORTS);
}
/** A reader's scroll (a finger on the list and the fling after it, or a wheel
 *  burst) is over once this long passes with no finger down and no scroll
 *  event. */
const USER_SCROLL_IDLE_MS = 200;

/** `value` as it stood when the reader started scrolling the list, until that
 *  scroll is over; the newest value then lands in one commit.
 *
 *  A live catalog update re-sorts the lists by activity. Landing under a
 *  moving finger, it moved rows the reader was about to tap, and its anchor
 *  compensation wrote scrollTop mid-fling: iOS WebKit stops a momentum scroll
 *  on that write and resolves it against a scroll position its web process
 *  has not caught up with yet, so the list jumped back (phone: 세션 사이드패널
 *  리스트 스크롤할 때도 모바일에서 엄청 튐). Held until the scroll ends, the
 *  update re-sorts a list at rest, where one compensation write is exact. */
export function useHeldDuringUserScroll<T>(scrollerRef: React.RefObject<HTMLDivElement | null>, value: T): T {
  const held = useRef({ active: false, value });
  const latest = useRef(value);
  latest.current = value;
  if (!held.current.active) held.current.value = value;
  const [, landLatest] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    let touching = false;
    let timer = 0;
    const settle = () => {
      timer = 0;
      if (touching) return;
      held.current.active = false;
      if (held.current.value !== latest.current) landLatest();
    };
    const arm = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(settle, USER_SCROLL_IDLE_MS);
    };
    const inList = (event: Event) => {
      const scroller = scrollerRef.current;
      const target = event.target as Node | null;
      return Boolean(scroller && target && scroller.contains(target));
    };
    const onTouchStart = (event: Event) => {
      if (!inList(event)) return;
      touching = true;
      held.current.active = true;
      arm();
    };
    const onTouchEnd = (event: Event) => {
      if (!touching || (event as TouchEvent).touches.length > 0) return;
      touching = false;
      arm();
    };
    const onWheel = (event: Event) => {
      if (!inList(event)) return;
      held.current.active = true;
      arm();
    };
    const onScroll = (event: Event) => {
      if (held.current.active && event.target === scrollerRef.current) arm();
    };
    const options = { capture: true, passive: true };
    document.addEventListener('touchstart', onTouchStart, options);
    document.addEventListener('touchend', onTouchEnd, options);
    document.addEventListener('touchcancel', onTouchEnd, options);
    document.addEventListener('wheel', onWheel, options);
    document.addEventListener('scroll', onScroll, options);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('touchstart', onTouchStart, options);
      document.removeEventListener('touchend', onTouchEnd, options);
      document.removeEventListener('touchcancel', onTouchEnd, options);
      document.removeEventListener('wheel', onWheel, options);
      document.removeEventListener('scroll', onScroll, options);
    };
  }, [scrollerRef]);
  return held.current.active ? held.current.value : value;
}

/** The nearest session row before (-1) or after (1) `row` in its list. */
function sessionRowNeighbour(row: Element, direction: -1 | 1): Element | null {
  let sibling = direction < 0 ? row.previousElementSibling : row.nextElementSibling;
  while (sibling && !sibling.matches('.session-row[data-session-id]'))
    sibling = direction < 0 ? sibling.previousElementSibling : sibling.nextElementSibling;
  return sibling;
}

interface AnchorRow {
  row: HTMLElement;
  offset: number;
  previous: Element | null;
  next: Element | null;
}

function useSessionListPaging(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  sentinelRef: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  visibleCount: number,
  revealMore: () => void
) {
  const revealWhenNear = useCallback(() => {
    if (!enabled) return;
    const scroller = scrollerRef.current;
    const sentinel = sentinelRef.current;
    if (!scroller || !sentinel) return;
    const viewport = scroller.getBoundingClientRect();
    if (sentinel.getBoundingClientRect().top - viewport.bottom > sessionListRevealLead(viewport.height)) return;
    revealMore();
  }, [enabled, scrollerRef, sentinelRef, revealMore]);
  // Scrolling pages through the scroller's own scroll handler. No
  // IntersectionObserver: while one exists, Chromium runs a main-thread frame
  // on every vsync for as long as any compositor animation (a running
  // session's spinner, a shimmer) plays anywhere in the window. A
  // ResizeObserver reports once per observe and on every resize, so each
  // revealed page (visibleCount) and a taller sidebar re-check whether the
  // viewport still shows the sentinel, after layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount re-checks after each revealed page
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!enabled || !scroller || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(revealWhenNear);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [enabled, scrollerRef, revealWhenNear, visibleCount]);
  return revealWhenNear;
}

interface SidebarListScrollInput {
  /** The Sessions scroller (also the one useHeldDuringUserScroll watches). */
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  panelActive: boolean;
  selection: NavigationSelection;
  rows: readonly DesktopSessionSummary[];
  visibleRecentRowCount: number;
  revealMoreRecentRows: () => void;
  recentOpen: boolean;
  archivedOpen: boolean;
  archivedRows: readonly DesktopSessionSummary[];
  archivedRowLimit: number;
  setArchivedRowLimit: React.Dispatch<React.SetStateAction<number>>;
  allRows: readonly DesktopSessionSummary[];
  automationsOpen: boolean;
  collapsedAutomations: ReadonlySet<string>;
  projectOpen: OpenMap;
  projectGroups: readonly ProjectSessionGroup[];
  projectRowLimits: ReadonlyMap<string, number>;
  projectsOpen: boolean;
  sectionOrder: { orderedIds: readonly string[] };
}

/** The Sessions scroller: sentinel paging of Recent and Archived, and the
 *  scroll anchor that keeps the reader's row in place across list changes.
 *  The layout-input values only feed the anchor compensation's dependencies. */
export function useSidebarListScroll({
  scrollerRef: recentScrollerRef,
  open,
  panelActive,
  selection,
  rows,
  visibleRecentRowCount,
  revealMoreRecentRows,
  recentOpen,
  archivedOpen,
  archivedRows,
  archivedRowLimit,
  setArchivedRowLimit,
  allRows,
  automationsOpen,
  collapsedAutomations,
  projectOpen,
  projectGroups,
  projectRowLimits,
  projectsOpen,
  sectionOrder,
}: SidebarListScrollInput) {
  // Pagination has NO control of its own (user decision: no "Show more"):
  // an invisible end sentinel inside the Recent list reveals the next page as
  // the reader approaches it. The full list is still never rendered up front —
  // that is what keeps tab switches cheap on large session catalogs.
  const recentSentinelRef = useRef<HTMLDivElement | null>(null);
  const recentScrollAnchorRef = useRef<{ rows: AnchorRow[]; scrollTop: number } | null>(null);
  const recentRowIdsRef = useRef<string[]>([]);
  const hasMoreRecentRows = visibleRecentRowCount < rows.length;
  const archivedSentinelRef = useRef<HTMLDivElement | null>(null);
  const visibleArchivedRows = archivedRows.slice(0, archivedRowLimit);
  const hasMoreArchivedRows = visibleArchivedRows.length < archivedRows.length;
  const revealMoreArchivedRows = useCallback(() => {
    setArchivedRowLimit((current) => Math.min(archivedRows.length, current + RECENT_SESSION_PAGE_ROWS));
  }, [archivedRows.length, setArchivedRowLimit]);
  useEffect(() => {
    if (!archivedOpen || selection.kind !== 'session') return;
    const selectedIndex = archivedRows.findIndex((session) => session.id === selection.id);
    if (selectedIndex >= archivedRowLimit) setArchivedRowLimit(selectedIndex + 1);
  }, [archivedOpen, archivedRows, archivedRowLimit, selection, setArchivedRowLimit]);
  const captureRecentScrollAnchor = useCallback(() => {
    const scroller = recentScrollerRef.current;
    if (!scroller || scroller.scrollTop <= 1) {
      recentScrollAnchorRef.current = null;
      return;
    }
    // Every visible row, by element: one session can list twice (a favorite
    // inside its project folder), so its id does not name the reader's row.
    const scrollerRect = scroller.getBoundingClientRect();
    const rows: AnchorRow[] = [];
    for (const row of scroller.querySelectorAll<HTMLElement>('.session-row[data-session-id]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) continue;
      rows.push({
        row,
        offset: rect.top - scrollerRect.top,
        previous: sessionRowNeighbour(row, -1),
        next: sessionRowNeighbour(row, 1),
      });
    }
    recentScrollAnchorRef.current = rows.length ? { rows, scrollTop: scroller.scrollTop } : null;
  }, [recentScrollerRef]);
  const revealWhenSentinelNear = useSessionListPaging(
    recentScrollerRef,
    recentSentinelRef,
    open && !panelActive && recentOpen && hasMoreRecentRows,
    visibleRecentRowCount,
    revealMoreRecentRows
  );
  const revealWhenArchivedSentinelNear = useSessionListPaging(
    recentScrollerRef,
    archivedSentinelRef,
    open && !panelActive && archivedOpen && hasMoreArchivedRows,
    visibleArchivedRows.length,
    revealMoreArchivedRows
  );
  const handleRecentScroll = useCallback(() => {
    captureRecentScrollAnchor();
    revealWhenSentinelNear();
    revealWhenArchivedSentinelNear();
  }, [captureRecentScrollAnchor, revealWhenSentinelNear, revealWhenArchivedSentinelNear]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: list layout inputs (sections, counts, rows) trigger scroll-anchor compensation
  useLayoutEffect(() => {
    if (!open || panelActive) return;
    const scroller = recentScrollerRef.current;
    const previousIds = recentRowIdsRef.current;
    const nextIds = rows.map((session) => session.id);
    recentRowIdsRef.current = nextIds;
    if (
      scroller &&
      scroller.scrollTop <= 1 &&
      (sessionListInsertedAtTop(previousIds, nextIds) || sessionListKeepsExistingTopInsert(previousIds, nextIds))
    ) {
      recentScrollAnchorRef.current = null;
      return;
    }
    const anchor = recentScrollAnchorRef.current;
    if (scroller && anchor && scroller.scrollTop > 1) {
      // The reader's row is the first visible one still beside a neighbour it
      // had: a row the update re-sorted (a session that just got activity)
      // left both, and following it threw the list to the row's new place.
      const inList = anchor.rows.filter(({ row }) => row.isConnected && scroller.contains(row));
      const kept = inList.find(
        ({ row, previous, next }) =>
          (previous && sessionRowNeighbour(row, -1) === previous) || (next && sessionRowNeighbour(row, 1) === next)
      );
      const reader = kept ?? inList[0];
      if (reader) {
        const { row } = reader;
        // The anchor dates from the last scroll event, and a commit can land
        // after the reader's scroll moved the list but before that move's
        // scroll event (WebKit applies an async/momentum scroll position, then
        // reports it at its next rendering update). That move is the reader's
        // own: the row stays where it carried it, or the list snapped back to
        // the previous event's position on every live catalog update. Only a
        // clamp (content shrank under a list at its end) lowers scrollTop
        // without the reader; that keeps the captured position.
        const moved = scroller.scrollTop - anchor.scrollTop;
        const clamped = moved < 0 && scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
        const expectedOffset = reader.offset - (clamped ? 0 : moved);
        const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - expectedOffset;
        if (Number.isFinite(delta) && Math.abs(delta) > 0.5) {
          scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
        }
      }
    }
    // Store the settled geometry for the next catalog insertion/reorder. The
    // browser's native anchor is disabled on this scroller, so this is the only
    // compensation and the same row stays at the same screen coordinate.
    captureRecentScrollAnchor();
  }, [
    allRows,
    archivedOpen,
    automationsOpen,
    captureRecentScrollAnchor,
    collapsedAutomations,
    projectOpen,
    projectGroups,
    projectRowLimits,
    projectsOpen,
    sectionOrder.orderedIds,
    open,
    panelActive,
    recentOpen,
    rows,
    visibleRecentRowCount,
  ]);
  return {
    recentScrollerRef,
    recentSentinelRef,
    hasMoreRecentRows,
    archivedSentinelRef,
    visibleArchivedRows,
    hasMoreArchivedRows,
    handleRecentScroll,
  };
}
