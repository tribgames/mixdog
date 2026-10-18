import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionListInsertedAtTop, sessionListKeepsExistingTopInsert } from './first-submit-stability';
import type { NavigationSelection } from './nav-types';
import type { ProjectSessionGroup } from './session-sidebar-sections';
import type { OpenMap } from './sidebar-open-state';

export const RECENT_SESSION_INITIAL_ROWS = 24;
export const RECENT_SESSION_PAGE_ROWS = 32;
/** How close a session list's end sentinel has to come to the scroller viewport
 *  before the next page is revealed. */
const RECENT_SENTINEL_REVEAL_MARGIN_PX = 240;

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
    if (
      sentinel.getBoundingClientRect().top - scroller.getBoundingClientRect().bottom >
      RECENT_SENTINEL_REVEAL_MARGIN_PX
    )
      return;
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
  const recentScrollerRef = useRef<HTMLDivElement | null>(null);
  const recentSentinelRef = useRef<HTMLDivElement | null>(null);
  const recentScrollAnchorRef = useRef<{ sessionId: string; offset: number } | null>(null);
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
    const scrollerRect = scroller.getBoundingClientRect();
    const visible = [...scroller.querySelectorAll<HTMLElement>('.session-row[data-session-id]')].find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
    });
    const sessionId = String(visible?.dataset.sessionId || '');
    if (!visible || !sessionId) {
      recentScrollAnchorRef.current = null;
      return;
    }
    recentScrollAnchorRef.current = {
      sessionId,
      offset: visible.getBoundingClientRect().top - scrollerRect.top,
    };
  }, []);
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
      const row = [...scroller.querySelectorAll<HTMLElement>('.session-row[data-session-id]')].find(
        (candidate) => candidate.dataset.sessionId === anchor.sessionId
      );
      if (row) {
        const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
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
