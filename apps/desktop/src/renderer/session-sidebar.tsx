import { Plus, Search, Sparkles, SquarePen } from 'lucide-react';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DesktopProjectSummary, DesktopSessionSummary } from '../shared/contract';
import { t } from './i18n';
import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import type { NavigationSelection } from './nav-types';
import { sessionListInsertedAtTop, sessionListKeepsExistingTopInsert } from './first-submit-stability';
import { openSessionSearch } from './session-search';
import { sessionLabel, SessionSidebarRow } from './session-sidebar-rows';
import {
  MIN_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  clampSidebarWidth,
  storedSidebarWidth,
  persistSidebarWidth,
  isAutomationRow,
  groupAutomationSessions,
  SidebarPanelHeaderSlot,
  automationsSection,
  recentSection,
  archivedSection,
  favoritesSection,
  sidebarResizeHandle,
  type SidebarResizeStart,
  PROJECT_SESSION_PAGE_ROWS,
  groupProjectSessions,
  persistExpandedProjects,
  projectsSection,
  readStoredExpandedProjects,
} from './session-sidebar-sections';
import { usePersistedListOrder } from './use-persisted-list-order';
import { ScmContextMenu, type ScmContextMenuItem, type ScmContextMenuState } from './ScmContextMenu';
import { copyTextToClipboard } from './text-format';
import type { ProjectSessionGroup } from './session-sidebar-sections';

const NO_PROJECTS: readonly DesktopProjectSummary[] = [];
/** Default top-to-bottom order of the session categories; the user can drag
 *  any heading to reorder them. */
const SIDEBAR_SECTIONS = ['favorites', 'projects', 'automations', 'recent', 'archived'] as const;
const RECENT_SESSION_INITIAL_ROWS = 24;
const RECENT_SESSION_PAGE_ROWS = 32;
/** How close a session list's end sentinel has to come to the scroller viewport
 *  before the next page is revealed — shared by the IntersectionObserver
 *  rootMargin and the onScroll fallback so both page at the same moment. */
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleCount re-arms the observer after a page is revealed
  useEffect(() => {
    if (!enabled) return;
    const scroller = scrollerRef.current;
    const sentinel = sentinelRef.current;
    const ObserverCtor = typeof window === 'undefined' ? undefined : window.IntersectionObserver;
    if (!scroller || !sentinel || typeof ObserverCtor !== 'function') return;
    // Ignore deliveries queued before collapse, panel switch, or unmount.
    let active = true;
    const observer = new ObserverCtor(
      (entries) => {
        if (active && entries.some((entry) => entry.isIntersecting)) revealMore();
      },
      { root: scroller, rootMargin: `${RECENT_SENTINEL_REVEAL_MARGIN_PX}px 0px` }
    );
    observer.observe(sentinel);
    return () => {
      active = false;
      observer.takeRecords?.();
      observer.disconnect();
    };
    // Re-arm after each page to fill a viewport that still contains the sentinel.
  }, [enabled, scrollerRef, sentinelRef, revealMore, visibleCount]);
  return revealWhenNear;
}

interface SessionSidebarProps {
  open: boolean;
  /** Rail destination hosted in the panel area (Projects/Workflows/
   *  Schedules/Webhooks): while active it swaps in for the session list —
   *  the list stays mounted behind a hidden flag (user decision). */
  panelActive?: boolean;
  panelTitle?: string;
  panelTitleDragProps?: React.HTMLAttributes<HTMLSpanElement>;
  children?: React.ReactNode;
  sessions: DesktopSessionSummary[];
  sessionsReady: boolean;
  /** Registered projects: listed as folders in a Projects section above
   *  Recent; with none, the section is absent. */
  projects?: readonly DesktopProjectSummary[];
  /** + on a project section: a new task staged in that project ('' = none). */
  onNewProjectTask?(projectPath: string): void;
  /** Session menu: open beside the focused pane (the drag-to-split result). */
  onOpenSessionInSplit?(sessionId: string, title: string): void;
  /** Session menu: open the session, then its /inherit surface. */
  onInheritSession?(sessionId: string): void;
  /** Project folder menu actions. */
  onRenameProject?(projectPath: string, alias: string): void;
  onRevealProject?(projectPath: string): void;
  onOpenProjectSettings?(projectPath: string): void;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  selection: NavigationSelection;
  onNewTask(): void;
  /** Second fixed launcher row: opens a Studio workspace tab. */
  onNewStudio(): void;
  onPrefetchSession?(sessionId: string): Promise<boolean>;
  onResumeSession(sessionId: string): void;
  onRenameSession(sessionId: string, title: string): Promise<void>;
  /** Archive: the row leaves Recent but the session file stays. */
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  /** Favorite: the row is pinned to the Favorites section above Recent. */
  onFavoriteSession(sessionId: string, favorite: boolean): Promise<void>;
  onDeleteSession(sessionId: string): Promise<void>;
}

export const SessionSidebar = React.memo(function SessionSidebar({
  open,
  panelActive = false,
  panelTitle = '',
  panelTitleDragProps,
  children,
  sessions,
  sessionsReady,
  projects = NO_PROJECTS,
  onNewProjectTask,
  onOpenSessionInSplit,
  onInheritSession,
  onRenameProject,
  onRevealProject,
  onOpenProjectSettings,
  workingSessionIds,
  unreadSessionIds,
  selection,
  onNewTask,
  onNewStudio,
  onPrefetchSession,
  onResumeSession,
  onRenameSession,
  onArchiveSession,
  onFavoriteSession,
  onDeleteSession,
}: SessionSidebarProps) {
  // Each rail destination owns its own sidebar shell. Auxiliary destinations
  // must not build duplicate session lists; once a shell has actually shown
  // Sessions, however, retain that list through panel switches and collapse.
  const sessionsMounted = useRef(!panelActive);
  if (!panelActive) sessionsMounted.current = true;
  const hasSessionSurface = sessionsMounted.current;
  const [editingSessionId, setEditingSessionId] = useState('');
  const [sessionTitleDraft, setSessionTitleDraft] = useState('');
  const [sessionTitleInvalid, setSessionTitleInvalid] = useState(false);
  const [confirmingSessionId, setConfirmingSessionId] = useState('');
  const [deletingSessionId, setDeletingSessionId] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [panelActionSlot, setPanelActionSlot] = useState<HTMLDivElement | null>(null);
  const resizeStart = useRef<SidebarResizeStart | null>(null);
  const updateSidebarWidth = useCallback((value: number) => {
    const next = clampSidebarWidth(value);
    setSidebarWidth(next);
    persistSidebarWidth(next);
  }, []);
  useEffect(() => {
    const flushPendingWidth = () => {
      const pendingWidth = resizeStart.current?.pendingWidth;
      if (pendingWidth === undefined) return;
      persistSidebarWidth(clampSidebarWidth(pendingWidth));
    };
    window.addEventListener('pagehide', flushPendingWidth);
    return () => window.removeEventListener('pagehide', flushPendingWidth);
  }, []);
  const finishSidebarResize = useCallback(() => {
    const pendingWidth = resizeStart.current?.pendingWidth;
    resizeStart.current = null;
    document.body.classList.remove('session-sidebar-resizing');
    if (pendingWidth !== undefined && pendingWidth !== sidebarWidth) {
      updateSidebarWidth(pendingWidth);
    }
  }, [sidebarWidth, updateSidebarWidth]);
  useEffect(() => () => document.body.classList.remove('session-sidebar-resizing'), []);
  const allRows = useMemo(
    () =>
      !hasSessionSurface
        ? []
        : sessions
            .filter((session) => session.classification === 'task' || session.classification === 'project')
            .sort((left, right) => {
              const leftActivityAt = Number(left.activityAt) || left.updatedAt;
              const rightActivityAt = Number(right.activityAt) || right.updatedAt;
              return rightActivityAt - leftActivityAt || left.id.localeCompare(right.id);
            }),
    [hasSessionSurface, sessions]
  );
  const favoriteRows = useMemo(
    () =>
      allRows.filter((session) => session.favorite === true && session.archived !== true && !isAutomationRow(session)),
    [allRows]
  );
  const rows = useMemo(
    () =>
      allRows.filter((session) => session.archived !== true && session.favorite !== true && !isAutomationRow(session)),
    [allRows]
  );
  const [favoritesOpen, setFavoritesOpen] = useState(true);
  // allRows is activity-desc, which is the order the grouped runs keep.
  const automationGroups = useMemo(() => groupAutomationSessions(allRows), [allRows]);
  // Tracks the COLLAPSED groups, so every automation group — including one that
  // appears after a fresh fire — renders expanded by default (user decision:
  // opening the app on a collapsed list buried the runs behind an extra click).
  const [collapsedAutomations, setCollapsedAutomations] = useState<ReadonlySet<string>>(new Set());
  const toggleAutomationGroup = useCallback((key: string) => {
    setCollapsedAutomations((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const archivedRows = useMemo(() => allRows.filter((session) => session.archived === true), [allRows]);
  const automationRows = useMemo(() => automationGroups.flatMap(({ runs }) => runs), [automationGroups]);
  const deletableArchivedRows = useMemo(
    () => archivedRows.filter((session) => session.archived === true),
    [archivedRows]
  );
  const [recentOpen, setRecentOpen] = useState(true);
  const [recentRowLimit, setRecentRowLimit] = useState(RECENT_SESSION_INITIAL_ROWS);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const sectionOrder = usePersistedListOrder('mixdog:session-sidebar-section-order', SIDEBAR_SECTIONS, {
    dropAnchor: ':scope > .sidebar-category-header',
  });
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(
    () => new Set(readStoredExpandedProjects())
  );
  const [projectRowLimits, setProjectRowLimits] = useState<ReadonlyMap<string, number>>(new Map());
  const toggleProject = useCallback((key: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persistExpandedProjects([...next]);
      return next;
    });
  }, []);
  const showMoreProjectRows = useCallback((key: string) => {
    setProjectRowLimits((current) =>
      new Map(current).set(key, (current.get(key) ?? PROJECT_SESSION_PAGE_ROWS) + RECENT_SESSION_PAGE_ROWS)
    );
  }, []);
  // Favorites stay in their project folder: the folder is a classification,
  // not a second Recent.
  const activityProjectGroups = useMemo(
    () =>
      projects.length === 0
        ? []
        : groupProjectSessions(
            projects,
            allRows.filter((session) => session.archived !== true && !isAutomationRow(session))
          ),
    [allRows, projects]
  );
  const activityProjectKeys = useMemo(() => activityProjectGroups.map((group) => group.key), [activityProjectGroups]);
  const projectOrder = usePersistedListOrder('mixdog:session-sidebar-project-order', activityProjectKeys, {
    dropAnchor: ':scope > .project-folder',
  });
  const projectGroups = useMemo(() => {
    const byKey = new Map(activityProjectGroups.map((group) => [group.key, group]));
    return projectOrder.orderedIds.flatMap((key) => byKey.get(key) ?? []);
  }, [activityProjectGroups, projectOrder.orderedIds]);
  const [automationsOpen, setAutomationsOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedRowLimit, setArchivedRowLimit] = useState(RECENT_SESSION_INITIAL_ROWS);
  const [bulkAction, setBulkAction] = useState<'' | 'archive-automations' | 'archive-recent' | 'restore' | 'delete'>(
    ''
  );
  const updateSessionArchives = useCallback(
    async (
      action: 'archive-automations' | 'archive-recent' | 'restore',
      targets: readonly DesktopSessionSummary[],
      archived: boolean
    ) => {
      if (bulkAction || targets.length === 0) return;
      setBulkAction(action);
      try {
        /* Start every row mutation before awaiting any of them. Each row action
         applies its optimistic state synchronously, so React paints one bulk
         transition instead of visibly walking the list item by item. A failed
         row still owns its existing rollback while the rest continue. */
        await Promise.all(
          targets.map(async (session) => {
            try {
              await onArchiveSession(session.id, archived);
            } catch {
              // The row-level action restores failures; continue with the rest.
            }
          })
        );
      } finally {
        setBulkAction('');
      }
    },
    [bulkAction, onArchiveSession]
  );
  const deleteAllArchived = useCallback(async () => {
    if (bulkAction || deletableArchivedRows.length === 0) return;
    setBulkAction('delete');
    try {
      for (const session of deletableArchivedRows) {
        try {
          await onDeleteSession(session.id);
        } catch {
          // Failed rows stay archived; continue deleting the remaining rows.
        }
      }
    } finally {
      setBulkAction('');
    }
  }, [bulkAction, deletableArchivedRows, onDeleteSession]);
  const automationsHaveHeadingDot =
    !automationsOpen && automationRows.some((session) => unreadSessionIds?.has(session.id) === true);
  const recentHasHeadingDot = !recentOpen && rows.some((session) => unreadSessionIds?.has(session.id) === true);
  useEffect(() => {
    if (selection.kind !== 'session') return;
    const selectedIndex = rows.findIndex((session) => session.id === selection.id);
    if (selectedIndex < recentRowLimit) return;
    setRecentRowLimit(selectedIndex + 1);
  }, [recentRowLimit, rows, selection]);
  const revealMoreRecentRows = useCallback(() => {
    setRecentRowLimit((current) => Math.min(rows.length, current + RECENT_SESSION_PAGE_ROWS));
  }, [rows.length]);
  const visibleRecentRows = rows.slice(0, recentRowLimit);
  // Pagination has NO control of its own (user decision: no "Show more"):
  // an invisible end sentinel inside the Recent list reveals the next page as
  // the reader approaches it. The full list is still never rendered up front —
  // that is what keeps tab switches cheap on large session catalogs.
  const recentScrollerRef = useRef<HTMLDivElement | null>(null);
  const recentSentinelRef = useRef<HTMLDivElement | null>(null);
  const recentScrollAnchorRef = useRef<{ sessionId: string; offset: number } | null>(null);
  const recentRowIdsRef = useRef<string[]>([]);
  const hasMoreRecentRows = visibleRecentRows.length < rows.length;
  const visibleRecentRowCount = visibleRecentRows.length;
  const archivedSentinelRef = useRef<HTMLDivElement | null>(null);
  const visibleArchivedRows = archivedRows.slice(0, archivedRowLimit);
  const hasMoreArchivedRows = visibleArchivedRows.length < archivedRows.length;
  const revealMoreArchivedRows = useCallback(() => {
    setArchivedRowLimit((current) => Math.min(archivedRows.length, current + RECENT_SESSION_PAGE_ROWS));
  }, [archivedRows.length]);
  useEffect(() => {
    if (!archivedOpen || selection.kind !== 'session') return;
    const selectedIndex = archivedRows.findIndex((session) => session.id === selection.id);
    if (selectedIndex >= archivedRowLimit) setArchivedRowLimit(selectedIndex + 1);
  }, [archivedOpen, archivedRows, archivedRowLimit, selection]);
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
    expandedProjects,
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
  useLayoutEffect(() => {
    if (!open) return;
    beginBootSurface('session-sidebar', 'recent');
    reportBootSurfaceStage('session-sidebar', 'recent', 'module');
    // Cached rows and the explicit loading/empty shell are already usable.
    // Holding the global boot cover for the authoritative catalog round trip
    // made a restored Task pane delay the whole desktop despite having a
    // complete first frame to show.
    reportBootSurfaceReady('session-sidebar', 'recent', 'shell');
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !sessionsReady) return;
    reportBootSurfaceStage('session-sidebar', 'recent', 'data');
  }, [open, sessionsReady]);
  const prefetchedSessionIds = useRef(new Set<string>());
  const requestPrefetch = useCallback(
    (sessionId: string) => {
      if (!onPrefetchSession || prefetchedSessionIds.current.has(sessionId)) return;
      prefetchedSessionIds.current.add(sessionId);
      void onPrefetchSession(sessionId)
        .then((ready) => {
          if (ready !== true) prefetchedSessionIds.current.delete(sessionId);
        })
        .catch(() => {
          prefetchedSessionIds.current.delete(sessionId);
        });
    },
    [onPrefetchSession]
  );
  useEffect(() => {
    if (!open || !sessionsReady || !onPrefetchSession) return undefined;
    // Touch has no hover-intent window. Warm only the first two recent rows
    // during browser idle so the common mobile tap avoids a full relay RTT
    // without flooding the lane cache with large transcripts.
    const sessionIds = visibleRecentRows.slice(0, 2).map((session) => session.id);
    if (sessionIds.length === 0) return undefined;
    const host = window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const warm = () => sessionIds.forEach(requestPrefetch);
    const idle = host.requestIdleCallback?.(warm, { timeout: 800 });
    const timer = idle === undefined ? window.setTimeout(warm, 160) : 0;
    return () => {
      if (idle !== undefined) host.cancelIdleCallback?.(idle);
      if (timer) window.clearTimeout(timer);
    };
  }, [onPrefetchSession, open, requestPrefetch, sessionsReady, visibleRecentRows]);
  const openSessionEditor = useCallback((session: DesktopSessionSummary) => {
    setConfirmingSessionId('');
    setEditingSessionId(session.id);
    setSessionTitleDraft(sessionLabel(session));
    setSessionTitleInvalid(false);
  }, []);
  const closeSessionEditor = useCallback(() => {
    setEditingSessionId('');
    setSessionTitleDraft('');
    setSessionTitleInvalid(false);
  }, []);
  const commitSessionEditor = useCallback(
    (session: DesktopSessionSummary, fromBlur = false) => {
      const title = sessionTitleDraft.trim();
      if (!title) {
        setSessionTitleInvalid(true);
        if (fromBlur) closeSessionEditor();
        return;
      }
      closeSessionEditor();
      if (title === sessionLabel(session)) return;
      void onRenameSession(session.id, title);
    },
    [closeSessionEditor, onRenameSession, sessionTitleDraft]
  );
  useEffect(() => {
    if (confirmingSessionId && !sessions.some((session) => session.id === confirmingSessionId)) {
      setConfirmingSessionId('');
    }
  }, [confirmingSessionId, sessions]);
  // Right-click menus: one shared menu surface, items per target. A menu item
  // runs after the menu has closed and handed focus back to the row, so an
  // item that opens an inline editor starts it on the next tick — otherwise
  // that returning focus would blur (and commit) the new editor at once.
  const [contextMenu, setContextMenu] = useState<ScmContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const afterMenu = (action: () => void) => () => window.setTimeout(action, 0);
  const openSessionMenu = (session: DesktopSessionSummary, point: { x: number; y: number }) => {
    const label = sessionLabel(session);
    const archived = session.archived === true;
    const items: ScmContextMenuItem[] = [{ id: 'open', label: t('Open'), onSelect: () => onResumeSession(session.id) }];
    if (onOpenSessionInSplit) {
      items.push({
        id: 'open-split',
        label: t('Open in split pane'),
        onSelect: () => onOpenSessionInSplit(session.id, label),
      });
    }
    items.push({
      id: 'rename',
      label: t('Rename'),
      separatorBefore: true,
      onSelect: afterMenu(() => openSessionEditor(session)),
    });
    if (onInheritSession && !archived) {
      items.push({ id: 'inherit', label: t('Inherit session'), onSelect: () => onInheritSession(session.id) });
    }
    if (archived) {
      items.push({
        id: 'restore',
        label: t('Restore'),
        separatorBefore: true,
        onSelect: () => void onArchiveSession(session.id, false).catch(() => {}),
      });
    } else {
      items.push(
        {
          id: 'favorite',
          label: session.favorite === true ? t('Remove from favorites') : t('Add to favorites'),
          separatorBefore: true,
          onSelect: () => void onFavoriteSession(session.id, session.favorite !== true).catch(() => {}),
        },
        { id: 'archive', label: t('Archive'), onSelect: () => void onArchiveSession(session.id, true).catch(() => {}) }
      );
    }
    // Delete never runs from the menu itself: it arms the row's inline
    // cancel/confirm pair, the same confirmation archived rows use.
    items.push({
      id: 'delete',
      label: t('Delete'),
      danger: true,
      separatorBefore: true,
      onSelect: afterMenu(() => {
        closeSessionEditor();
        setConfirmingSessionId(session.id);
      }),
    });
    setContextMenu({ label, ...point, items });
  };
  const [projectRename, setProjectRename] = useState<{ key: string; draft: string; original: string } | null>(null);
  const projectRenameRef = useRef(projectRename);
  projectRenameRef.current = projectRename;
  // Enter commits and the input's removal may still blur it: the ref makes the
  // second call a no-op.
  const commitProjectRename = (group: ProjectSessionGroup) => {
    const current = projectRenameRef.current;
    if (!current || current.key !== group.key) return;
    projectRenameRef.current = null;
    setProjectRename(null);
    const alias = current.draft.trim();
    if (alias && alias !== current.original) onRenameProject?.(group.path, alias);
  };
  const openProjectMenu = (group: ProjectSessionGroup, point: { x: number; y: number }) => {
    const expanded = expandedProjects.has(group.key);
    const items: ScmContextMenuItem[] = [
      {
        id: 'new-task',
        label: t('New task'),
        onSelect: () => (onNewProjectTask ? onNewProjectTask(group.path) : onNewTask()),
      },
      {
        id: 'toggle',
        label: expanded ? t('Collapse {{label}}', { label: group.name }) : t('Expand {{label}}', { label: group.name }),
        onSelect: () => toggleProject(group.key),
      },
    ];
    if (onRevealProject) {
      items.push({
        id: 'reveal',
        label: t('Reveal in Explorer'),
        separatorBefore: true,
        onSelect: () => onRevealProject(group.path),
      });
    }
    items.push({
      id: 'copy-path',
      label: t('Copy path'),
      separatorBefore: !onRevealProject,
      onSelect: () => void copyTextToClipboard(group.path).catch(() => {}),
    });
    if (onRenameProject) {
      items.push({
        id: 'rename',
        label: t('Rename'),
        separatorBefore: true,
        onSelect: afterMenu(() => setProjectRename({ key: group.key, draft: group.name, original: group.name })),
      });
    }
    if (onOpenProjectSettings) {
      items.push({
        id: 'settings',
        label: t('Project settings'),
        separatorBefore: !onRenameProject,
        onSelect: () => onOpenProjectSettings(group.path),
      });
    }
    setContextMenu({ label: group.name, ...point, items });
  };
  // Recent, Automations and Archived all render the same row with the same
  // rename/confirm wiring; only the session differs.
  const renderSessionRow = (session: DesktopSessionSummary) => (
    <SessionSidebarRow
      key={session.id}
      session={session}
      active={selection.kind === 'session' && selection.id === session.id}
      working={workingSessionIds?.has(session.id) === true}
      unread={unreadSessionIds?.has(session.id) === true}
      editingSessionId={editingSessionId}
      sessionTitleDraft={sessionTitleDraft}
      sessionTitleInvalid={sessionTitleInvalid}
      confirmingSessionId={confirmingSessionId}
      deletingSessionId={deletingSessionId}
      onTitleDraftChange={setSessionTitleDraft}
      onStartRename={openSessionEditor}
      onCancelRename={closeSessionEditor}
      onCommitRename={commitSessionEditor}
      onPrefetchSession={requestPrefetch}
      onResumeSession={onResumeSession}
      onCloseEditor={closeSessionEditor}
      onSetConfirming={setConfirmingSessionId}
      onSetDeleting={setDeletingSessionId}
      onDeleteSession={onDeleteSession}
      onArchiveSession={onArchiveSession}
      onFavoriteSession={onFavoriteSession}
      onOpenMenu={openSessionMenu}
    />
  );
  const displayedSidebarWidth = resizeStart.current?.pendingWidth ?? sidebarWidth;
  return (
    <aside
      id="session-sidebar"
      className={`sidebar session-sidebar ${open ? 'open' : ''}`}
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      aria-hidden={!open}
      aria-label={t('Session manager')}
      style={
        {
          '--session-sidebar-width': `${displayedSidebarWidth}px`,
          '--session-sidebar-min-width': `${MIN_SIDEBAR_WIDTH}px`,
          '--session-sidebar-max-width': `${MAX_SIDEBAR_WIDTH}px`,
          maxWidth: open ? MAX_SIDEBAR_WIDTH : 0,
          /* Full-responsive shell: the open rail yields between its preferred
           width and the 252px floor before the workbench ever scrolls. */
          flexShrink: open ? 1 : 0,
        } as React.CSSProperties
      }
    >
      {/* The panel titles itself; every primary
          navigation control lives on the Activity Rail to the left. */}
      <header className="session-panel-header">
        <span {...panelTitleDragProps} className="session-panel-title">
          {panelActive ? t(panelTitle) : t('Sessions')}
        </span>
        {/* Creation belongs to Sessions rather than the Activity Rail: this
            button creates an ordinary task tab and never owns a selected
            navigation state. + IS New Task; Studio has its own launcher and
            Terminal lives in the session-owned right side. Other panels
            portal their own primary action into the same title-row slot. */}
        <div className="session-panel-header-actions" ref={setPanelActionSlot}>
          {!panelActive && (
            <>
              <button
                type="button"
                className="session-panel-action session-search-open"
                aria-label={t('Search sessions')}
                data-tooltip={t('Search sessions')}
                onClick={openSessionSearch}
              >
                <Search size={16} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="session-panel-action session-new-task"
                aria-label={t('New task')}
                data-tooltip={t('New task')}
                onClick={onNewTask}
              >
                <Plus size={16} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </header>
      {/* Sessions surface: a fixed launcher block over the scrolling list.
          The launchers live OUTSIDE the scroller on purpose — as a sticky
          block inside it they clamped to the scroller's content box, so the
          12px top inset showed scrolled rows through (user: 고정이냐? 뭔가
          이상한데). The surface flags (active/inert/hidden) move up to this
          wrapper so both parts hide together while a rail panel is shown. */}
      {hasSessionSurface && (
        <div
          className="session-sidebar-surface session-sidebar-sessions"
          data-surface-active={panelActive ? 'false' : 'true'}
          inert={panelActive ? true : undefined}
          aria-hidden={panelActive ? true : undefined}
        >
          {/* Fixed creation rows share the category type tier with leading
            icons. Both open tabs and stay outside the scrolling lists. */}
          <nav className="session-sidebar-launchers" aria-label={t('New')}>
            <button type="button" className="task-link session-launcher-row" onClick={onNewTask}>
              <SquarePen className="session-launcher-icon" size={16} aria-hidden="true" />
              <span className="session-launcher-label">{t('New task')}</span>
            </button>
            <button type="button" className="task-link session-launcher-row" onClick={onNewStudio}>
              <Sparkles className="session-launcher-icon" size={16} aria-hidden="true" />
              <span className="session-launcher-label">{t('New Studio')}</span>
            </button>
          </nav>
          <div className="session-sidebar-scroll" ref={recentScrollerRef} onScroll={handleRecentScroll}>
            {sectionOrder.orderedIds.map((section) => (
              <React.Fragment key={section}>{renderSection(section)}</React.Fragment>
            ))}
          </div>
        </div>
      )}
      {/* Rail destinations render here as compact visible lists; their
          editors open as popup dialogs portaled above the workspace. */}
      <div
        className="session-sidebar-scroll session-sidebar-panels session-sidebar-surface"
        data-surface-active={panelActive ? 'true' : 'false'}
        inert={panelActive ? undefined : true}
        aria-hidden={panelActive ? undefined : true}
      >
        <SidebarPanelHeaderSlot.Provider value={panelActionSlot}>{children}</SidebarPanelHeaderSlot.Provider>
      </div>
      <ScmContextMenu state={contextMenu} onClose={closeContextMenu} />
      {sidebarResizeHandle({
        width: displayedSidebarWidth,
        sidebarWidth,
        resizeStart,
        updateSidebarWidth,
        onFinishResize: finishSidebarResize,
      })}
    </aside>
  );
  // Each category renders through its section builder; the heading row is its
  // drag handle for the persisted category order.
  function renderSection(section: string): React.ReactNode {
    const headerProps = sectionOrder.getReorderProps(section);
    switch (section) {
      case 'favorites':
        return (
          favoriteRows.length > 0 &&
          favoritesSection({
            rows: favoriteRows,
            open: favoritesOpen,
            onToggleOpen: () => setFavoritesOpen((open) => !open),
            headerProps,
            renderSessionRow,
          })
        );
      case 'projects':
        return (
          projectGroups.length > 0 &&
          projectsSection({
            groups: projectGroups,
            open: projectsOpen,
            onToggleOpen: () => setProjectsOpen((open) => !open),
            expandedProjects,
            onToggleProject: toggleProject,
            rowLimits: projectRowLimits,
            onShowMore: showMoreProjectRows,
            onNewTask: (projectPath) => (onNewProjectTask ? onNewProjectTask(projectPath) : onNewTask()),
            folderReorderProps: projectOrder.getReorderProps,
            headerProps,
            unreadSessionIds,
            renderSessionRow,
            onFolderMenu: openProjectMenu,
            rename: projectRename && {
              key: projectRename.key,
              draft: projectRename.draft,
              onDraft: (draft) => setProjectRename((current) => current && { ...current, draft }),
              onCommit: commitProjectRename,
              onCancel: () => {
                projectRenameRef.current = null;
                setProjectRename(null);
              },
            },
          })
        );
      case 'automations':
        return (
          automationGroups.length > 0 &&
          automationsSection({
            groups: automationGroups,
            open: automationsOpen,
            onToggleOpen: () => setAutomationsOpen((open) => !open),
            hasHeadingDot: automationsHaveHeadingDot,
            archiveAllDisabled: Boolean(bulkAction) || automationRows.length === 0,
            onArchiveAll: () => {
              void updateSessionArchives('archive-automations', automationRows, true);
            },
            collapsedGroups: collapsedAutomations,
            onToggleGroup: toggleAutomationGroup,
            workingSessionIds,
            unreadSessionIds,
            headerProps,
            renderSessionRow,
          })
        );
      case 'recent':
        return recentSection({
          sessionsReady,
          rowCount: rows.length,
          visibleRows: visibleRecentRows,
          hasMoreRows: hasMoreRecentRows,
          sentinelRef: recentSentinelRef,
          open: recentOpen,
          onToggleOpen: () => setRecentOpen((open) => !open),
          hasHeadingDot: recentHasHeadingDot,
          archiveAllDisabled: Boolean(bulkAction) || rows.length === 0,
          onArchiveAll: () => {
            void updateSessionArchives('archive-recent', rows, true);
          },
          headerProps,
          renderSessionRow,
        });
      case 'archived':
        return (
          archivedRows.length > 0 &&
          archivedSection({
            visibleRows: visibleArchivedRows,
            hasMoreRows: hasMoreArchivedRows,
            sentinelRef: archivedSentinelRef,
            open: archivedOpen,
            onToggleOpen: () => {
              setArchivedRowLimit(RECENT_SESSION_INITIAL_ROWS);
              setArchivedOpen((open) => !open);
            },
            actionsDisabled: Boolean(bulkAction) || deletableArchivedRows.length === 0,
            onRestoreAll: () => {
              void updateSessionArchives('restore', deletableArchivedRows, false);
            },
            onDeleteAll: () => {
              void deleteAllArchived();
            },
            headerProps,
            renderSessionRow,
          })
        );
    }
  }
});
