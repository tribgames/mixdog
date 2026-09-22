import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  type FolderPlus,
  Plus,
  Sparkles,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import React, { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { InitialSurface } from './InitialSurface';
import type { DesktopSessionSummary } from '../shared/contract';
import { sessionSummaryTitle } from '../shared/session-title.mjs';
import {
  clampDesktopPanelWidth,
  DESKTOP_SIDEBAR_DEFAULT_WIDTH,
  DESKTOP_SIDEBAR_MIN_WIDTH,
} from '../shared/window-layout';
import { ProgressSpinner } from './ProgressSpinner';
import { t, uiFormatLocale } from './i18n';

import { beginBootSurface, reportBootSurfaceReady, reportBootSurfaceStage } from './boot-metrics';
import type { NavigationSelection } from './nav-types';
import { beginPaneDrag, finishPaneDrag, type PaneDragSession } from './pane-drag-session';
import { RowOverflowMenu } from './RowOverflowMenu';
import { sessionListInsertedAtTop, sessionListKeepsExistingTopInsert } from './first-submit-stability';

const SESSION_PREFETCH_INTENT_DELAY_MS = 40;
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

export function sessionLabel(session: DesktopSessionSummary) {
  return sessionSummaryTitle(session, t('Untitled session'));
}

export function projectIdentity(path: string | null | undefined) {
  return String(path || '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase();
}

const DEFAULT_SIDEBAR_WIDTH = DESKTOP_SIDEBAR_DEFAULT_WIDTH;
const MIN_SIDEBAR_WIDTH = DESKTOP_SIDEBAR_MIN_WIDTH;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_KEY = 'mixdog:session-sidebar-width';

function clampSidebarWidth(value: number) {
  return clampDesktopPanelWidth(value, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

function storedSidebarWidth() {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));

    return Number.isFinite(value) && value > 0 ? clampSidebarWidth(value) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** Width persistence for the next window. Both the settled resize and the
 *  pagehide flush write through here: a storage failure only costs the next
 *  window its restored width, the live resize is already applied. */
function persistSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // The current window can still resize when persistent storage is unavailable.
  }
}

type SidebarResizeStart = {
  clientX: number;
  width: number;
  pendingWidth: number;
};

/** Automation runner sessions (schedule/webhook fires) live in their own
 *  Automations section and are excluded from Recent (user decision: fires
 *  must not flood the list). */
function isAutomationRow(session: DesktopSessionSummary) {
  return session.sourceType === 'schedule' || session.sourceType === 'webhook';
}

type AutomationGroup = { key: string; name: string; runs: DesktopSessionSummary[] };

/** One GROUP per automation name: the newest session is the visible row and
 *  older fires stay reachable behind a per-group "Past runs" toggle (user
 *  decision — fires are full sessions now, so history must not vanish).
 *  Expects activity-desc rows, which is the order the runs keep. */
function groupAutomationSessions(activityOrderedRows: DesktopSessionSummary[]): AutomationGroup[] {
  const groups = new Map<string, { name: string; runs: DesktopSessionSummary[] }>();
  for (const session of activityOrderedRows) {
    if (session.archived === true || !isAutomationRow(session)) continue;
    // Channel-only runs never surface in Automations (user decision): the
    // messaging channel is their surface; the session parks in Archived.
    if (session.sourceDelivery === 'channel') continue;
    const key = `${session.sourceType}:${
      String(session.sourceName || '')
        .trim()
        .toLowerCase() || session.id
    }`;
    let entry = groups.get(key);
    if (!entry) {
      entry = { name: String(session.sourceName || sessionLabel(session)), runs: [] };
      groups.set(key, entry);
    }
    // Runs keep activity order and show their fire time as the row label —
    // every run reads the same name.
    entry.runs.push({
      ...session,
      title: new Date(Number(session.activityAt) || session.updatedAt).toLocaleString(uiFormatLocale(), {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }),
    });
  }
  return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
}

/** Panel-header action slot. Rail destinations (Projects/Workflows/Schedules/
 *  Webhooks) hand their primary action to the panel title row instead of
 *  printing a second page header inside the list (user: 타이틀이 2번). */
const SidebarPanelHeaderSlot = React.createContext<HTMLElement | null>(null);

export function SidebarPanelAction({
  active = true,
  label,
  icon: Icon,
  className = '',
  disabled,
  onClick,
}: {
  /** Only the VISIBLE panel may own the shared header slot: every rail panel
   *  stays mounted behind [hidden] so its list keeps its scroll and data. */
  active?: boolean;
  label: string;
  icon: typeof FolderPlus;
  className?: string;
  disabled?: boolean;
  onClick(): void;
}) {
  const slot = useContext(SidebarPanelHeaderSlot);
  const button = (
    <button
      type="button"
      className={`session-panel-action ${className}`.trim()}
      aria-label={label}
      data-tooltip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
  // No slot means the pane renders outside the sidebar (standalone hosts and
  // unit tests): keep the action inline so the surface stays complete.
  if (!slot) return button;
  return active ? createPortal(button, slot) : null;
}

/** Automations section: one disclosure per automation name over its runs.
 *  Separate from Recent because a group header is a PURE disclosure (user
 *  decision) — it never renames and never opens a session itself. */
function automationsSection({
  groups,
  open,
  onToggleOpen,
  hasHeadingDot,
  archiveAllDisabled,
  onArchiveAll,
  collapsedGroups,
  onToggleGroup,
  workingSessionIds,
  unreadSessionIds,
  renderSessionRow,
}: {
  groups: AutomationGroup[];
  open: boolean;
  onToggleOpen(): void;
  hasHeadingDot: boolean;
  archiveAllDisabled: boolean;
  onArchiveAll(): void;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup(key: string): void;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  renderSessionRow(session: DesktopSessionSummary): React.ReactNode;
}) {
  return (
    <section className="sidebar-recent sidebar-automations" aria-label={t('Automations')}>
      <div className="sidebar-category-header">
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Automations')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {/* Collapsed sections still have to announce new activity. */}
          {hasHeadingDot && (
            <span className="sidebar-heading-dot" role="status" aria-label={t('Automations have new activity')} />
          )}
        </button>
        {!hasHeadingDot && (
          <RowOverflowMenu
            label="Actions"
            items={[
              {
                id: 'archive-all',
                label: 'Archive all',
                disabled: archiveAllDisabled,
                onSelect: onArchiveAll,
              },
            ]}
          />
        )}
      </div>
      {open && (
        <nav className="session-list automation-session-list" aria-label={t('Automations')}>
          {groups.map(({ key, name, runs }) => {
            const expanded = !collapsedGroups.has(key);
            const working = runs.some((run) => workingSessionIds?.has(run.id) === true);
            const unread = runs.some((run) => unreadSessionIds?.has(run.id) === true);
            const ExpandGlyph = expanded ? ChevronDown : ChevronRight;
            return (
              <div className="automation-group" key={key}>
                {/* The chevron LEADS in the fixed status cell (one aligned
                    column); the working spinner takes that cell over while a
                    run is live. */}
                <button
                  type="button"
                  className="session-row automation-group-header"
                  aria-expanded={expanded}
                  onClick={() => onToggleGroup(key)}
                >
                  <span className="session-row-status" data-working={working || undefined}>
                    {working ? (
                      <ProgressSpinner
                        size={12}
                        className="session-row-spinner"
                        role="status"
                        aria-label={t('{{name}} is working', { name })}
                      />
                    ) : (
                      <ExpandGlyph size={14} aria-hidden="true" />
                    )}
                  </span>
                  <span className="session-row-copy">
                    <b>{name}</b>
                  </span>
                  {unread && !working && (
                    <span
                      className="session-row-unread-dot"
                      role="status"
                      aria-label={t('{{name}} has new activity', { name })}
                    />
                  )}
                </button>
                {expanded && <div className="automation-group-past">{runs.map(renderSessionRow)}</div>}
              </div>
            );
          })}
        </nav>
      )}
    </section>
  );
}

/** Recent section: the primary session catalog. Owns the invisible end
 *  sentinel that reveals the next page — pagination has NO control of its own
 *  (user decision: no "Show more"). */
function recentSection({
  sessionsReady,
  rowCount,
  visibleRows,
  hasMoreRows,
  sentinelRef,
  open,
  onToggleOpen,
  hasHeadingDot,
  archiveAllDisabled,
  onArchiveAll,
  renderSessionRow,
}: {
  sessionsReady: boolean;
  rowCount: number;
  visibleRows: DesktopSessionSummary[];
  hasMoreRows: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggleOpen(): void;
  hasHeadingDot: boolean;
  archiveAllDisabled: boolean;
  onArchiveAll(): void;
  renderSessionRow(session: DesktopSessionSummary): React.ReactNode;
}) {
  return (
    <section className="sidebar-recent" aria-label={t('Recent sessions')}>
      <div className="sidebar-category-header">
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Recent')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {hasHeadingDot && (
            <span className="sidebar-heading-dot" role="status" aria-label={t('Recent has new activity')} />
          )}
        </button>
        {!hasHeadingDot && (
          <RowOverflowMenu
            label="Actions"
            items={[
              {
                id: 'archive-all',
                label: 'Archive all',
                disabled: archiveAllDisabled,
                onSelect: onArchiveAll,
              },
            ]}
          />
        )}
      </div>
      {open && (
        <nav id="recent-session-list" className="session-list recent-session-list" aria-label={t('Recent sessions')}>
          {!sessionsReady && rowCount === 0 ? (
            <InitialSurface />
          ) : (
            sessionsReady && rowCount === 0 && <p className="sidebar-section-empty">{t('No sessions')}</p>
          )}
          {visibleRows.map(renderSessionRow)}
          {hasMoreRows && (
            <div
              ref={sentinelRef}
              className="session-list-sentinel"
              aria-hidden="true"
              style={{ height: 1, pointerEvents: 'none' }}
            />
          )}
        </nav>
      )}
    </section>
  );
}

/** Archived section: restore and permanent-delete of parked sessions, kept
 *  apart from Recent because those are the only bulk actions that leave or
 *  destroy the catalog. */
function archivedSection({
  visibleRows,
  hasMoreRows,
  sentinelRef,
  open,
  onToggleOpen,
  actionsDisabled,
  onRestoreAll,
  onDeleteAll,
  renderSessionRow,
}: {
  visibleRows: DesktopSessionSummary[];
  hasMoreRows: boolean;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  onToggleOpen(): void;
  actionsDisabled: boolean;
  onRestoreAll(): void;
  onDeleteAll(): void;
  renderSessionRow(session: DesktopSessionSummary): React.ReactNode;
}) {
  return (
    <section className="sidebar-recent sidebar-archived" aria-label={t('Archived sessions')}>
      <div className="sidebar-category-header">
        <button
          type="button"
          className="sidebar-recent-heading sidebar-heading-toggle sidebar-archived-toggle"
          aria-expanded={open}
          onClick={onToggleOpen}
        >
          <span>{t('Archived')}</span>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <RowOverflowMenu
          label="Actions"
          items={[
            {
              id: 'restore-all',
              label: 'Restore all',
              disabled: actionsDisabled,
              onSelect: onRestoreAll,
            },
            {
              id: 'delete-all-archived',
              label: 'Delete all archived sessions',
              danger: true,
              separatorBefore: true,
              disabled: actionsDisabled,
              children: [
                {
                  id: 'confirm-delete-all-archived',
                  label: 'Confirm delete',
                  danger: true,
                  onSelect: onDeleteAll,
                },
              ],
            },
          ]}
        />
      </div>
      {open && (
        <nav className="session-list archived-session-list" aria-label={t('Archived sessions')}>
          {visibleRows.map(renderSessionRow)}
          {hasMoreRows && (
            <div
              ref={sentinelRef}
              className="session-list-sentinel"
              aria-hidden="true"
              style={{ height: 1, pointerEvents: 'none' }}
            />
          )}
        </nav>
      )}
    </section>
  );
}

/** Drag separator for the sidebar width. The live pointer width is written
 *  straight to the element and the ref so a drag never re-renders the session
 *  lists; only the settled width reaches state and storage. */
function sidebarResizeHandle({
  width,
  sidebarWidth,
  resizeStart,
  updateSidebarWidth,
  onFinishResize,
}: {
  width: number;
  sidebarWidth: number;
  resizeStart: { current: SidebarResizeStart | null };
  updateSidebarWidth(value: number): void;
  onFinishResize(): void;
}) {
  return (
    <div
      className="session-sidebar-resize"
      role="separator"
      tabIndex={0}
      aria-label={t('Resize session sidebar')}
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') updateSidebarWidth(sidebarWidth - 16);
        else if (event.key === 'ArrowRight') updateSidebarWidth(sidebarWidth + 16);
        else if (event.key === 'Home') updateSidebarWidth(MIN_SIDEBAR_WIDTH);
        else if (event.key === 'End') updateSidebarWidth(MAX_SIDEBAR_WIDTH);
        else return;
        event.preventDefault();
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        resizeStart.current = {
          clientX: event.clientX,
          width: sidebarWidth,
          pendingWidth: sidebarWidth,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        document.body.classList.add('session-sidebar-resizing');
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        const start = resizeStart.current;
        if (!start) return;
        const next = clampSidebarWidth(start.width + event.clientX - start.clientX);
        start.pendingWidth = next;
        const sidebar = event.currentTarget.closest<HTMLElement>('.session-sidebar');
        sidebar?.style.setProperty('--session-sidebar-width', `${next}px`);
        event.currentTarget.setAttribute('aria-valuenow', String(next));
        event.currentTarget.setAttribute('aria-valuetext', `${next} pixels`);
      }}
      onPointerUp={onFinishResize}
      onPointerCancel={onFinishResize}
    />
  );
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
  workingSessionIds,
  unreadSessionIds,
  selection,
  onNewTask,
  onNewStudio,
  onPrefetchSession,
  onResumeSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: SessionSidebarProps) {
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
      sessions
        .filter((session) => session.classification === 'task' || session.classification === 'project')
        .sort((left, right) => {
          const leftActivityAt = Number(left.activityAt) || left.updatedAt;
          const rightActivityAt = Number(right.activityAt) || right.updatedAt;
          return rightActivityAt - leftActivityAt || left.id.localeCompare(right.id);
        }),
    [sessions]
  );
  const rows = useMemo(
    () => allRows.filter((session) => session.archived !== true && !isAutomationRow(session)),
    [allRows]
  );
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
  const archivedRows = useMemo(
    () =>
      allRows.filter(
        (session) => session.archived === true || (isAutomationRow(session) && session.sourceDelivery === 'channel')
      ),
    [allRows]
  );
  const automationRows = useMemo(() => automationGroups.flatMap(({ runs }) => runs), [automationGroups]);
  const deletableArchivedRows = useMemo(
    () => archivedRows.filter((session) => session.archived === true),
    [archivedRows]
  );
  const [recentOpen, setRecentOpen] = useState(true);
  const [recentRowLimit, setRecentRowLimit] = useState(RECENT_SESSION_INITIAL_ROWS);
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
  useLayoutEffect(() => {
    if (!open || panelActive) return;
    const scroller = recentScrollerRef.current;
    const previousIds = recentRowIdsRef.current;
    const nextIds = rows.map((session) => session.id);
    recentRowIdsRef.current = nextIds;
    if (scroller && scroller.scrollTop <= 1 && sessionListInsertedAtTop(previousIds, nextIds)) {
      recentScrollAnchorRef.current = null;
      return;
    }
    if (scroller && scroller.scrollTop <= 1 && sessionListKeepsExistingTopInsert(previousIds, nextIds)) {
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
            <button
              type="button"
              className="session-panel-action session-new-task"
              aria-label={t('New task')}
              data-tooltip={t('New task')}
              onClick={onNewTask}
            >
              <Plus size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      {/* Sessions surface: a fixed launcher block over the scrolling list.
          The launchers live OUTSIDE the scroller on purpose — as a sticky
          block inside it they clamped to the scroller's content box, so the
          12px top inset showed scrolled rows through (user: 고정이냐? 뭔가
          이상한데). The surface flags (active/inert/hidden) move up to this
          wrapper so both parts hide together while a rail panel is shown. */}
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
          {automationGroups.length > 0 &&
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
              renderSessionRow,
            })}
          {recentSection({
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
            renderSessionRow,
          })}
          {archivedRows.length > 0 &&
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
              renderSessionRow,
            })}
        </div>
      </div>
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
      {sidebarResizeHandle({
        width: displayedSidebarWidth,
        sidebarWidth,
        resizeStart,
        updateSidebarWidth,
        onFinishResize: finishSidebarResize,
      })}
    </aside>
  );
});

const SessionSidebarRow = React.memo(function SessionSidebarRow({
  session,
  active,
  working,
  unread,
  editingSessionId,
  sessionTitleDraft,
  sessionTitleInvalid,
  confirmingSessionId,
  deletingSessionId,
  onTitleDraftChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onPrefetchSession,
  onResumeSession,
  onCloseEditor,
  onSetConfirming,
  onSetDeleting,
  onArchiveSession,
  onDeleteSession,
}: {
  session: DesktopSessionSummary;
  active: boolean;
  working?: boolean;
  unread?: boolean;
  editingSessionId: string;
  sessionTitleDraft: string;
  sessionTitleInvalid: boolean;
  confirmingSessionId: string;
  deletingSessionId: string;
  onTitleDraftChange(value: string): void;
  onStartRename(session: DesktopSessionSummary): void;
  onCancelRename(): void;
  onCommitRename(session: DesktopSessionSummary, fromBlur?: boolean): void;
  onPrefetchSession(sessionId: string): void;
  onResumeSession(sessionId: string): void;
  onCloseEditor(): void;
  onSetConfirming: React.Dispatch<React.SetStateAction<string>>;
  onSetDeleting: React.Dispatch<React.SetStateAction<string>>;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  onDeleteSession(sessionId: string): Promise<void>;
}) {
  return (
    <SessionRow
      session={session}
      active={active}
      working={working}
      unread={unread}
      editing={editingSessionId === session.id}
      titleDraft={sessionTitleDraft}
      titleInvalid={sessionTitleInvalid}
      onArchiveSession={onArchiveSession}
      onTitleDraftChange={onTitleDraftChange}
      onStartRename={onStartRename}
      onCancelRename={onCancelRename}
      onCommitRename={onCommitRename}
      onPrefetchSession={onPrefetchSession}
      onResumeSession={onResumeSession}
      confirmingDelete={confirmingSessionId === session.id}
      deleting={deletingSessionId === session.id}
      onStartDelete={(target) => {
        onCloseEditor();
        onSetConfirming(target.id);
      }}
      onCancelDelete={() => onSetConfirming('')}
      onConfirmDelete={(target) => {
        onSetDeleting(target.id);
        void onDeleteSession(target.id)
          .then(() => onSetConfirming(''))
          .catch(() => {})
          .finally(() => onSetDeleting(''));
      }}
    />
  );
});

const SessionRow = React.memo(function SessionRow({
  session,
  active,
  working,
  unread,
  editing,
  titleDraft,
  titleInvalid,
  onTitleDraftChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onPrefetchSession,
  onResumeSession,
  confirmingDelete,
  deleting,
  onStartDelete,
  onCancelDelete,
  onConfirmDelete,
  onArchiveSession,
}: {
  session: DesktopSessionSummary;
  active: boolean;
  working?: boolean;
  unread?: boolean;
  editing: boolean;
  titleDraft: string;
  titleInvalid: boolean;
  onTitleDraftChange(value: string): void;
  onStartRename(session: DesktopSessionSummary): void;
  onCancelRename(): void;
  onCommitRename(session: DesktopSessionSummary, fromBlur?: boolean): void;
  onPrefetchSession(sessionId: string): void;
  onResumeSession(sessionId: string): void;
  confirmingDelete: boolean;
  deleting: boolean;
  onStartDelete(session: DesktopSessionSummary): void;
  onCancelDelete(): void;
  onConfirmDelete(session: DesktopSessionSummary): void;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
}) {
  const resume = useCallback(() => onResumeSession(session.id), [onResumeSession, session.id]);
  const titleInput = useRef<HTMLInputElement>(null);
  const nativeDrag = useRef<PaneDragSession | null>(null);
  const dragSourceMounted = useRef(true);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const dragTitle = sessionLabel(session);
  const dragSelection = useMemo(
    () => ({ kind: 'session' as const, id: session.id, title: dragTitle }),
    [dragTitle, session.id]
  );
  useLayoutEffect(() => {
    if (!editing) return;
    titleInput.current?.focus({ preventScroll: true });
    titleInput.current?.select();
  }, [editing]);
  const prefetchTimer = useRef<number | null>(null);
  const cancelPrefetch = useCallback(() => {
    if (prefetchTimer.current === null) return;
    window.clearTimeout(prefetchTimer.current);
    prefetchTimer.current = null;
  }, []);
  const schedulePrefetch = useCallback(() => {
    cancelPrefetch();
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = null;
      onPrefetchSession(session.id);
    }, SESSION_PREFETCH_INTENT_DELAY_MS);
  }, [cancelPrefetch, onPrefetchSession, session.id]);
  useEffect(() => cancelPrefetch, [cancelPrefetch]);
  const activateFromClick = useCallback(() => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (editing || confirmingDelete || deleting) return;
    cancelPrefetch();
    resume();
  }, [cancelPrefetch, confirmingDelete, deleting, editing, resume]);
  const clearNativeDrag = useCallback(() => {
    const drag = nativeDrag.current;
    nativeDrag.current = null;
    delete document.body.dataset.tabDragging;
    if (!dragSourceMounted.current) return;
    setDragging(false);
    if (!drag) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }, []);
  useEffect(() => {
    dragSourceMounted.current = true;
    return () => {
      dragSourceMounted.current = false;
      if (nativeDrag.current) finishPaneDrag();
      nativeDrag.current = null;
      delete document.body.dataset.tabDragging;
    };
  }, []);
  return (
    <div
      className={`session-row ${active ? 'selected' : ''} ${working ? 'working' : ''} ${editing ? 'editing' : ''} ${confirmingDelete ? 'confirming-delete' : ''}`}
      data-session-id={session.id}
      data-dragging={dragging ? 'true' : undefined}
      aria-current={active ? 'page' : undefined}
      aria-grabbed={dragging ? 'true' : undefined}
      draggable={!editing && !confirmingDelete && !deleting}
      onPointerEnter={schedulePrefetch}
      onPointerLeave={cancelPrefetch}
      onFocusCapture={schedulePrefetch}
      onBlurCapture={cancelPrefetch}
      onDragStart={(event) => {
        if ((event.target as Element | null)?.closest?.('.session-row-actions, .session-title-input')) {
          event.preventDefault();
          return;
        }
        const drag: PaneDragSession = {
          kind: 'session',
          key: `session:${session.id}`,
          title: dragTitle,
          selection: dragSelection,
        };
        beginPaneDrag(event.nativeEvent, drag, event.currentTarget, clearNativeDrag);
        nativeDrag.current = drag;
        cancelPrefetch();
        setDragging(true);
        document.body.dataset.tabDragging = '1';
      }}
      onDragEnd={() => {
        finishPaneDrag();
      }}
      onClick={activateFromClick}
      onDoubleClick={(event) => {
        if (
          editing ||
          confirmingDelete ||
          deleting ||
          (event.target as Element | null)?.closest?.('.session-row-actions, .session-title-input')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        onStartRename(session);
      }}
    >
      <input
        ref={titleInput}
        className="session-title-input"
        value={titleDraft}
        maxLength={160}
        disabled={!editing}
        tabIndex={editing ? undefined : -1}
        aria-hidden={editing ? undefined : true}
        aria-label={t('Rename {{name}}', { name: sessionLabel(session) })}
        aria-invalid={titleInvalid || undefined}
        onInput={(event) => onTitleDraftChange(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            onCommitRename(session);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancelRename();
          }
        }}
        onBlur={() => {
          if (editing) onCommitRename(session, true);
        }}
      />
      <button
        type="button"
        className="session-row-main"
        inert={editing ? true : undefined}
        aria-hidden={editing ? true : undefined}
      >
        <span className="session-row-copy" data-i18n-skip>
          <b>{sessionLabel(session)}</b>
        </span>
        <span className="session-row-status" data-working={working || undefined}>
          {working && (
            <ProgressSpinner
              size={12}
              className="session-row-spinner"
              role="status"
              aria-label={t('{{name}} is working', { name: sessionLabel(session) })}
            />
          )}
        </span>
        {unread && !working && (
          <span
            className="session-row-unread-dot"
            role="status"
            aria-label={t('{{name}} has new activity', { name: sessionLabel(session) })}
          />
        )}
      </button>
      <div className="session-row-actions" inert={editing ? true : undefined} aria-hidden={editing ? true : undefined}>
        {session.archived === true && (
          <>
            <button
              type="button"
              className={`session-row-action ${confirmingDelete ? 'session-row-delete-cancel' : 'session-row-restore'}`}
              aria-label={
                confirmingDelete
                  ? t('Cancel deleting {{name}}', { name: sessionLabel(session) })
                  : t('Restore {{name}}', { name: sessionLabel(session) })
              }
              data-tooltip={confirmingDelete ? t('Cancel') : t('Restore')}
              disabled={confirmingDelete && deleting}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (confirmingDelete) onCancelDelete();
                else void onArchiveSession(session.id, false).catch(() => {});
              }}
            >
              {confirmingDelete ? <X size={14} /> : <ArchiveRestore size={14} />}
            </button>
            <button
              type="button"
              className={`session-row-action ${
                confirmingDelete ? 'session-row-delete-confirm' : 'session-row-delete danger'
              }`}
              aria-label={
                confirmingDelete
                  ? t('Confirm deleting {{name}}', { name: sessionLabel(session) })
                  : t('Delete {{name}}', { name: sessionLabel(session) })
              }
              data-tooltip={confirmingDelete ? t('Delete') : undefined}
              disabled={confirmingDelete && deleting}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (confirmingDelete) onConfirmDelete(session);
                else onStartDelete(session);
              }}
            >
              <Trash2 size={confirmingDelete ? 12 : 13} />
            </button>
          </>
        )}
        {session.archived !== true && (
          <button
            type="button"
            className="session-row-action session-row-archive"
            aria-label={t('Archive {{name}}', { name: sessionLabel(session) })}
            data-tooltip={t('Archive')}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void onArchiveSession(session.id, true).catch(() => {});
            }}
          >
            <Archive size={14} />
          </button>
        )}
      </div>
    </div>
  );
});
