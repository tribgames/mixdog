import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Plus,
  Trash2,
  X
} from "lucide-react";
import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import type {
  DesktopSessionSummary
} from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";
import { DESKTOP_SIDEBAR_MIN_WIDTH } from "../shared/window-layout";
import { ProgressSpinner } from "./ProgressSpinner";
import { t } from "./i18n";

import {
  beginBootSurface,
  reportBootSurfaceReady,
  reportBootSurfaceStage,
} from "./boot-metrics";
import type { NavigationSelection } from "./nav-types";
import { publishTabDrag } from "./tab-drag-bus";

const SESSION_PREFETCH_INTENT_DELAY_MS = 40;
const RECENT_SESSION_INITIAL_ROWS = 24;
const RECENT_SESSION_PAGE_ROWS = 32;
/** How close the Recent end sentinel has to come to the scroller viewport
 *  before the next page is revealed — shared by the IntersectionObserver
 *  rootMargin and the onScroll fallback so both page at the same moment. */
const RECENT_SENTINEL_REVEAL_MARGIN_PX = 240;

export function sessionLabel(session: DesktopSessionSummary) {
  return sessionSummaryTitle(session);
}

export function projectIdentity(path: string | null | undefined) {
  return String(path || "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();
}


// Wider default rail (user: 사이드탭이 너무 좁다): the project/session cards
// need room for a two-line row plus the 12px gutters.
const DEFAULT_SIDEBAR_WIDTH = 300;
const MIN_SIDEBAR_WIDTH = DESKTOP_SIDEBAR_MIN_WIDTH;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_KEY = "mixdog:session-sidebar-width";

function clampSidebarWidth(value: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

function storedSidebarWidth() {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));

    return Number.isFinite(value) && value > 0 ? clampSidebarWidth(value) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

/** Panel-header action slot. Rail destinations (Projects/Workflows/Schedules/
 *  Webhooks) hand their primary action to the panel title row instead of
 *  printing a second page header inside the list (user: 타이틀이 2번). */
const SidebarPanelHeaderSlot = React.createContext<HTMLElement | null>(null);

export function SidebarPanelAction({
  active = true,
  label,
  icon: Icon,
  className = "",
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
  const button = <button type="button"
    className={`session-panel-action ${className}`.trim()}
    aria-label={label} data-tooltip={label} disabled={disabled}
    onClick={onClick}>
    <Icon size={16} aria-hidden="true" />
  </button>;
  // No slot means the pane renders outside the sidebar (standalone hosts and
  // unit tests): keep the action inline so the surface stays complete.
  if (!slot) return button;
  return active ? createPortal(button, slot) : null;
}

interface SessionSidebarProps {
  open: boolean;
  /** Rail destination hosted in the panel area (Projects/Workflows/
   *  Schedules/Webhooks): while active it swaps in for the session list —
   *  the list stays mounted behind a hidden flag (user decision). */
  panelActive?: boolean;
  panelTitle?: string;
  children?: React.ReactNode;
  sessions: DesktopSessionSummary[];
  sessionsReady: boolean;
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  /** Session-scoped channel relay owner: shown as its own single-row Remote
   *  section between Automations and Recent (user decision). */
  remoteSessionId?: string;
  selection: NavigationSelection;
  onNewTask(): void;
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
  panelTitle = "",
  children,
  sessions,
  sessionsReady,
  workingSessionIds,
  unreadSessionIds,
  remoteSessionId = "",
  selection,
  onNewTask,
  onPrefetchSession,
  onResumeSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: SessionSidebarProps) {
  const [editingSessionId, setEditingSessionId] = useState("");
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [sessionTitleInvalid, setSessionTitleInvalid] = useState(false);
  const [confirmingSessionId, setConfirmingSessionId] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const [panelActionSlot, setPanelActionSlot] = useState<HTMLDivElement | null>(null);
  const resizeStart = useRef<{
    clientX: number;
    width: number;
    pendingWidth: number;
  } | null>(null);
  const updateSidebarWidth = useCallback((value: number) => {
    const next = clampSidebarWidth(value);
    setSidebarWidth(next);
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    } catch {
      // The current window can still resize when persistent storage is unavailable.
    }
  }, []);
  const finishSidebarResize = useCallback(() => {
    const pendingWidth = resizeStart.current?.pendingWidth;
    resizeStart.current = null;
    document.body.classList.remove("session-sidebar-resizing");
    if (pendingWidth !== undefined && pendingWidth !== sidebarWidth) {
      updateSidebarWidth(pendingWidth);
    }
  }, [sidebarWidth, updateSidebarWidth]);
  useEffect(() => () => document.body.classList.remove("session-sidebar-resizing"), []);
  const allRows = useMemo(() => sessions
    .filter((session) => session.classification === "task" || session.classification === "project")
    .sort((left, right) => {
      const leftActivityAt = Number(left.activityAt) || left.updatedAt;
      const rightActivityAt = Number(right.activityAt) || right.updatedAt;
      return rightActivityAt - leftActivityAt || left.id.localeCompare(right.id);
    }),
  [sessions]);
  // Automation runner sessions (schedule/webhook fires) live in their own
  // Automations section — one row per name, newest session wins — and are
  // excluded from Recent (user decision: fires must not flood the list).
  const isAutomationRow = (session: DesktopSessionSummary) =>
    session.sourceType === "schedule" || session.sourceType === "webhook";
  // The relay-owning session lives in its own Remote section, not Recent.
  const remoteRow = useMemo(() => (remoteSessionId
    ? allRows.find((session) => session.id === remoteSessionId && session.archived !== true) || null
    : null), [allRows, remoteSessionId]);
  const rows = useMemo(() => allRows.filter((session) =>
    session.archived !== true && !isAutomationRow(session) && session.id !== remoteSessionId),
  [allRows, remoteSessionId]);
  // One GROUP per automation name: the newest session is the visible row and
  // older fires stay reachable behind a per-group "Past runs" toggle (user
  // decision — fires are full sessions now, so history must not vanish).
  const automationGroups = useMemo(() => {
    const groups = new Map<string, { name: string; runs: DesktopSessionSummary[] }>();
    for (const session of allRows) {
      if (session.archived === true || !isAutomationRow(session)) continue;
      // Channel-only runs never surface in Automations (user decision): the
      // messaging channel is their surface; the session parks in Archived.
      if (session.sourceDelivery === "channel") continue;
      const key = `${session.sourceType}:${String(session.sourceName || "").trim().toLowerCase() || session.id}`;
      let entry = groups.get(key);
      if (!entry) {
        entry = { name: String(session.sourceName || sessionLabel(session)), runs: [] };
        groups.set(key, entry);
      }
      // Runs keep activity order (allRows is activity-desc) and show their
      // fire time as the row label — every run reads the same name.
      entry.runs.push({
        ...session,
        title: new Date(Number(session.activityAt) || session.updatedAt).toLocaleString(undefined, {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        }),
      });
    }
    return [...groups.entries()].map(([key, group]) => ({ key, ...group }));
  }, [allRows]);
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
  const archivedRows = useMemo(() => allRows.filter((session) =>
    session.archived === true || (isAutomationRow(session) && session.sourceDelivery === "channel")),
  [allRows]);
  const [recentOpen, setRecentOpen] = useState(true);
  const [recentRowLimit, setRecentRowLimit] = useState(RECENT_SESSION_INITIAL_ROWS);
  const [automationsOpen, setAutomationsOpen] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
  useEffect(() => {
    if (selection.kind !== "session") return;
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
  const hasMoreRecentRows = visibleRecentRows.length < rows.length;
  const visibleRecentRowCount = visibleRecentRows.length;
  const captureRecentScrollAnchor = useCallback(() => {
    const scroller = recentScrollerRef.current;
    if (!scroller || scroller.scrollTop <= 1) {
      recentScrollAnchorRef.current = null;
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const visible = [...scroller.querySelectorAll<HTMLElement>(".session-row[data-session-id]")]
      .find((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
      });
    const sessionId = String(visible?.dataset.sessionId || "");
    if (!visible || !sessionId) {
      recentScrollAnchorRef.current = null;
      return;
    }
    recentScrollAnchorRef.current = {
      sessionId,
      offset: visible.getBoundingClientRect().top - scrollerRect.top,
    };
  }, []);
  // Fallback for hosts without IntersectionObserver. Proximity is measured
  // against the SENTINEL, not the scroller bottom: Archived (and any other
  // section rendered below Recent) would otherwise keep the scroller far from
  // its end and block Recent paging entirely.
  const revealWhenSentinelNear = useCallback(() => {
    if (!open || panelActive || !recentOpen || !hasMoreRecentRows) return;
    const scroller = recentScrollerRef.current;
    const sentinel = recentSentinelRef.current;
    if (!scroller || !sentinel) return;
    const scrollerBottom = scroller.getBoundingClientRect?.().bottom ?? 0;
    const sentinelTop = sentinel.getBoundingClientRect?.().top ?? 0;
    if (sentinelTop - scrollerBottom > RECENT_SENTINEL_REVEAL_MARGIN_PX) return;
    revealMoreRecentRows();
  }, [hasMoreRecentRows, open, panelActive, recentOpen, revealMoreRecentRows]);
  const handleRecentScroll = useCallback(() => {
    captureRecentScrollAnchor();
    revealWhenSentinelNear();
  }, [captureRecentScrollAnchor, revealWhenSentinelNear]);
  useEffect(() => {
    // Nothing to page towards, or the list is not on screen: no observer at
    // all, so a collapsed/hidden/closed sidebar can never spin pages.
    if (!open || panelActive || !recentOpen || !hasMoreRecentRows) return;
    const scroller = recentScrollerRef.current;
    const sentinel = recentSentinelRef.current;
    const ObserverCtor = typeof window === "undefined" ? undefined : window.IntersectionObserver;
    if (!scroller || !sentinel || typeof ObserverCtor !== "function") return;
    // Observer notifications are delivered asynchronously, so a batch queued
    // before teardown can still land after disconnect/close/panel switch/
    // collapse/unmount. The token makes every such late callback a no-op.
    let active = true;
    const observer = new ObserverCtor((entries) => {
      if (!active) return;
      if (entries.some((entry) => entry.isIntersecting)) revealMoreRecentRows();
    }, { root: scroller, rootMargin: `${RECENT_SENTINEL_REVEAL_MARGIN_PX}px 0px` });
    observer.observe(sentinel);
    return () => {
      active = false;
      // Drain first: pending records are dropped with the observer instead of
      // being handed to a callback that no longer owns this list state.
      observer.takeRecords?.();
      observer.disconnect();
    };
    // visibleRecentRowCount re-arms the observer after each page, so a sentinel
    // that is STILL in view keeps filling the viewport; the loop ends by
    // construction once every row is visible (the sentinel unmounts).
  }, [hasMoreRecentRows, open, panelActive, recentOpen, revealMoreRecentRows, visibleRecentRowCount]);
  useLayoutEffect(() => {
    if (!open || panelActive) return;
    const scroller = recentScrollerRef.current;
    const anchor = recentScrollAnchorRef.current;
    if (scroller && anchor && scroller.scrollTop > 1) {
      const row = [...scroller.querySelectorAll<HTMLElement>(".session-row[data-session-id]")]
        .find((candidate) => candidate.dataset.sessionId === anchor.sessionId);
      if (row) {
        const delta = row.getBoundingClientRect().top
          - scroller.getBoundingClientRect().top
          - anchor.offset;
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
    remoteOpen,
    visibleRecentRowCount,
  ]);
  useLayoutEffect(() => {
    if (!open) return;
    beginBootSurface("session-sidebar", "recent");
    reportBootSurfaceStage("session-sidebar", "recent", "module");
    if (!sessionsReady) return;
    reportBootSurfaceStage("session-sidebar", "recent", "data");
    reportBootSurfaceReady("session-sidebar", "recent");
  }, [open, sessionsReady]);
  const prefetchedSessionIds = useRef(new Set<string>());
  const requestPrefetch = useCallback((sessionId: string) => {
    if (!onPrefetchSession || prefetchedSessionIds.current.has(sessionId)) return;
    prefetchedSessionIds.current.add(sessionId);
    void onPrefetchSession(sessionId).then((ready) => {
      if (ready !== true) prefetchedSessionIds.current.delete(sessionId);
    }).catch(() => {
      prefetchedSessionIds.current.delete(sessionId);
    });
  }, [onPrefetchSession]);
  const openSessionEditor = useCallback((session: DesktopSessionSummary) => {
    setConfirmingSessionId("");
    setEditingSessionId(session.id);
    setSessionTitleDraft(sessionLabel(session));
    setSessionTitleInvalid(false);
  }, []);
  const closeSessionEditor = useCallback(() => {
    setEditingSessionId("");
    setSessionTitleDraft("");
    setSessionTitleInvalid(false);
  }, []);
  const commitSessionEditor = useCallback((session: DesktopSessionSummary, fromBlur = false) => {
    const title = sessionTitleDraft.trim();
    if (!title) {
      setSessionTitleInvalid(true);
      if (fromBlur) closeSessionEditor();
      return;
    }
    closeSessionEditor();
    if (title === sessionLabel(session)) return;
    void onRenameSession(session.id, title);
  }, [closeSessionEditor, onRenameSession, sessionTitleDraft]);
  useEffect(() => {
    if (confirmingSessionId && !sessions.some((session) => session.id === confirmingSessionId)) {
      setConfirmingSessionId("");
    }
  }, [confirmingSessionId, sessions]);
  const displayedSidebarWidth = resizeStart.current?.pendingWidth ?? sidebarWidth;
  return (
    <aside
      id="session-sidebar"
      className={`sidebar session-sidebar ${open ? "open" : ""}`}
      data-state={open ? "open" : "closed"}
      inert={!open}
      aria-hidden={!open}
      aria-label={t("Session manager")}
      style={{
        "--session-sidebar-width": `${displayedSidebarWidth}px`,
        "--session-sidebar-min-width": `${MIN_SIDEBAR_WIDTH}px`,
        "--session-sidebar-max-width": `${MAX_SIDEBAR_WIDTH}px`,
        maxWidth: open ? MAX_SIDEBAR_WIDTH : 0,
        /* Full-responsive shell: the open rail yields between its preferred
           width and the 232px floor before the workbench ever scrolls. */
        flexShrink: open ? 1 : 0,
      } as React.CSSProperties}
    >
      {/* VS Code side-bar grammar: the panel titles itself; every primary
          navigation control lives on the Activity Rail to the left. */}
      <header className="session-panel-header">
        <span className="session-panel-title">{panelActive ? t(panelTitle) : t("Sessions")}</span>
        {/* Creation belongs to Sessions rather than the Activity Rail: this
            button creates an ordinary task tab and never owns a selected
            navigation state. + IS New Task (user decision) — Studio/File/
            Terminal stay on the tab strip's create menu. Other panels portal
            their own primary action into the same title-row slot. */}
        <div className="session-panel-header-actions" ref={setPanelActionSlot}>
          {!panelActive && (
            <button type="button"
              className="session-panel-action session-new-task"
              aria-label={t("New task")}
              data-tooltip={t("New task")}
              onClick={onNewTask}>
              <Plus size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      </header>
      <div className="session-sidebar-scroll session-sidebar-surface"
        ref={recentScrollerRef}
        data-surface-active={panelActive ? "false" : "true"}
        inert={panelActive ? true : undefined}
        aria-hidden={panelActive ? true : undefined}
        onScroll={handleRecentScroll}>
        {automationGroups.length > 0 && (
          <section className="sidebar-recent sidebar-automations" aria-label={t("Automations")}>
            <button type="button" className="sidebar-recent-heading sidebar-heading-toggle"
              aria-expanded={automationsOpen}
              onClick={() => setAutomationsOpen((open) => !open)}>
              <span>{t("Automations")}</span>
              {automationsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {/* Collapsed sections still have to announce new activity. */}
              {!automationsOpen && automationGroups.some(({ runs }) =>
                runs.some((run) => unreadSessionIds?.has(run.id) === true))
                && <span className="sidebar-heading-dot" role="status" aria-label={t("Automations have new activity")} />}
            </button>
            {automationsOpen && (
              <nav className="session-list automation-session-list" aria-label={t("Automations")}>
                {automationGroups.map(({ key, name, runs }) => {
                  const expanded = !collapsedAutomations.has(key);
                  const working = runs.some((run) => workingSessionIds?.has(run.id) === true);
                  const unread = runs.some((run) => unreadSessionIds?.has(run.id) === true);
                  return <div className="automation-group" key={key}>
                    {/* The group header is a PURE disclosure (user decision):
                        clicking toggles the run list — it never renames and
                        never opens a session itself. The chevron LEADS in the
                        fixed status cell (one aligned column); the working
                        spinner takes that cell over while a run is live. */}
                    <button type="button" className="session-row automation-group-header"
                      aria-expanded={expanded}
                      onClick={() => toggleAutomationGroup(key)}>
                      <span className="session-row-status" data-working={working || undefined}>
                        {working
                          ? <ProgressSpinner size={12} className="session-row-spinner" role="status"
                            aria-label={t("{{name}} is working", { name })} />
                          : expanded
                            ? <ChevronDown size={14} aria-hidden="true" />
                            : <ChevronRight size={14} aria-hidden="true" />}
                      </span>
                      <span className="session-row-copy">
                        <b>{name}</b>
                      </span>
                      {unread && !working && <span className="session-row-unread-dot" role="status"
                        aria-label={t("{{name}} has new activity", { name })} />}
                    </button>
                    {expanded && <div className="automation-group-past">
                      {runs.map((session) => <SessionSidebarRow key={session.id}
                        session={session} active={selection.kind === "session" && selection.id === session.id}
                        working={workingSessionIds?.has(session.id) === true}
                        unread={unreadSessionIds?.has(session.id) === true}
                        editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
                        sessionTitleInvalid={sessionTitleInvalid}
                        confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
                        onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
                        onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
                        onPrefetchSession={requestPrefetch}
                        onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
                        onSetConfirming={setConfirmingSessionId}
                        onSetDeleting={setDeletingSessionId} onDeleteSession={onDeleteSession}
                        onArchiveSession={onArchiveSession} />)}
                    </div>}
                  </div>;
                })}
              </nav>
            )}
          </section>
        )}
        {remoteRow && (
          <section className="sidebar-recent sidebar-remote" aria-label={t("Remote")}>
            <button type="button" className="sidebar-recent-heading sidebar-heading-toggle"
              aria-expanded={remoteOpen}
              onClick={() => setRemoteOpen((open) => !open)}>
              <span>{t("Remote")}</span>
              {remoteOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {remoteOpen && (
              <nav className="session-list remote-session-list" aria-label={t("Remote")}>
                <SessionSidebarRow key={remoteRow.id}
                  session={remoteRow} active={selection.kind === "session" && selection.id === remoteRow.id}
                  working={workingSessionIds?.has(remoteRow.id) === true}
                  unread={unreadSessionIds?.has(remoteRow.id) === true}
                  editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
                  sessionTitleInvalid={sessionTitleInvalid}
                  confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
                  onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
                  onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
                  onPrefetchSession={requestPrefetch}
                  onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
                  onSetConfirming={setConfirmingSessionId}
                  onSetDeleting={setDeletingSessionId} onDeleteSession={onDeleteSession}
                  onArchiveSession={onArchiveSession} />
              </nav>
            )}
          </section>
        )}
        <section className="sidebar-recent" aria-label={t("Recent sessions")}>
          <button type="button" className="sidebar-recent-heading sidebar-heading-toggle"
            aria-expanded={recentOpen}
            onClick={() => setRecentOpen((open) => !open)}>
            <span>{t("Recent")}</span>
            {recentOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {!recentOpen && rows.some((session) => unreadSessionIds?.has(session.id) === true)
              && <span className="sidebar-heading-dot" role="status" aria-label={t("Recent has new activity")} />}
          </button>
          {recentOpen && (
          <nav id="recent-session-list" className="session-list recent-session-list" aria-label={t("Recent sessions")}>
            {!sessionsReady && rows.length === 0
              ? <p className="sidebar-section-empty sidebar-section-loading" role="status">{t("Loading sessions…")}</p>
              : sessionsReady && rows.length === 0 && <p className="sidebar-section-empty">{t("No sessions")}</p>}
            {visibleRecentRows.map((session) => <SessionSidebarRow key={session.id}
              session={session} active={selection.kind === "session" && selection.id === session.id}
              working={workingSessionIds?.has(session.id) === true}
              unread={unreadSessionIds?.has(session.id) === true}
              editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
              sessionTitleInvalid={sessionTitleInvalid}
              confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
              onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
              onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
              onPrefetchSession={requestPrefetch}
              onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
              onSetConfirming={setConfirmingSessionId}
              onSetDeleting={setDeletingSessionId} onDeleteSession={onDeleteSession}
              onArchiveSession={onArchiveSession} />)}
            {hasMoreRecentRows && <div ref={recentSentinelRef}
              className="session-list-sentinel" aria-hidden="true"
              style={{ height: 1, pointerEvents: "none" }} />}
          </nav>
          )}
        </section>
        {archivedRows.length > 0 && (
          <section className="sidebar-recent sidebar-archived" aria-label={t("Archived sessions")}>
            <button type="button" className="sidebar-recent-heading sidebar-heading-toggle sidebar-archived-toggle"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((open) => !open)}>
              <span>{t("Archived")}</span>
              {archivedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {archivedOpen && (
              <nav className="session-list archived-session-list" aria-label={t("Archived sessions")}>
                {archivedRows.map((session) => <SessionSidebarRow key={session.id}
                  session={session} active={selection.kind === "session" && selection.id === session.id}
                working={workingSessionIds?.has(session.id) === true}
                  unread={unreadSessionIds?.has(session.id) === true}
                  editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
                  sessionTitleInvalid={sessionTitleInvalid}
                  confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
                  onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
                  onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
                  onPrefetchSession={requestPrefetch}
                  onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
                  onSetConfirming={setConfirmingSessionId}
                  onSetDeleting={setDeletingSessionId} onDeleteSession={onDeleteSession}
                  onArchiveSession={onArchiveSession} />)}
              </nav>
            )}
          </section>
        )}
      </div>
      {/* Rail destinations render here as compact visible lists; their
          editors open as popup dialogs portaled above the workspace. */}
      <div
        className="session-sidebar-scroll session-sidebar-panels session-sidebar-surface"
        data-surface-active={panelActive ? "true" : "false"}
        inert={panelActive ? undefined : true}
        aria-hidden={panelActive ? undefined : true}>
        <SidebarPanelHeaderSlot.Provider value={panelActionSlot}>
          {children}
        </SidebarPanelHeaderSlot.Provider>
      </div>
      <div className="session-sidebar-resize" role="separator" tabIndex={0}
        aria-label={t("Resize session sidebar")} aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={displayedSidebarWidth} aria-valuetext={`${displayedSidebarWidth} pixels`}
        onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") updateSidebarWidth(sidebarWidth - 16);
          else if (event.key === "ArrowRight") updateSidebarWidth(sidebarWidth + 16);
          else if (event.key === "Home") updateSidebarWidth(MIN_SIDEBAR_WIDTH);
          else if (event.key === "End") updateSidebarWidth(MAX_SIDEBAR_WIDTH);
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
          document.body.classList.add("session-sidebar-resizing");
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          const start = resizeStart.current;
          if (!start) return;
          const next = clampSidebarWidth(start.width + event.clientX - start.clientX);
          start.pendingWidth = next;
          const sidebar = event.currentTarget.closest<HTMLElement>(".session-sidebar");
          sidebar?.style.setProperty("--session-sidebar-width", `${next}px`);
          event.currentTarget.setAttribute("aria-valuenow", String(next));
          event.currentTarget.setAttribute("aria-valuetext", `${next} pixels`);
        }}
        onPointerUp={finishSidebarResize}
        onPointerCancel={finishSidebarResize} />
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
  return <SessionRow session={session} active={active} working={working}
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
    onCancelDelete={() => onSetConfirming("")}
    onConfirmDelete={(target) => {
      onSetDeleting(target.id);
      void onDeleteSession(target.id)
        .then(() => onSetConfirming(""))
        .catch(() => {})
        .finally(() => onSetDeleting(""));
    }} />;
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
  const dragGhost = useRef<HTMLDivElement | null>(null);
  const pointerDrag = useRef<{
    pointerId: number;
    source: HTMLDivElement;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    started: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragging, setDragging] = useState(false);
  const dragSelection = useMemo(
    () => ({ kind: "session" as const, id: session.id }),
    [session.id],
  );
  const dragTitle = sessionLabel(session);
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
  const finishPointerDrag = useCallback((pointerId: number, cancelled = false) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== pointerId) return;
    pointerDrag.current = null;
    try {
      if (drag.source.hasPointerCapture?.(pointerId)) {
        drag.source.releasePointerCapture(pointerId);
      }
    } catch {
      // Pointer capture may already be gone when React delivers pointercancel.
    }
    if (drag.started) {
      publishTabDrag({
        kind: "session",
        phase: cancelled ? "cancel" : "drop",
        key: `session:${session.id}`,
        title: dragTitle,
        selection: dragSelection,
        x: drag.lastX,
        y: drag.lastY,
      });
      if (!cancelled) {
        suppressClick.current = true;
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      }
    }
    setDragging(false);
    delete document.body.dataset.tabDragging;
  }, [dragSelection, dragTitle, session.id]);
  const movePointerDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = pointerDrag.current;
    const pointerId = event.pointerId || 1;
    if (!drag || drag.pointerId !== pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (!drag.started) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
      drag.started = true;
      cancelPrefetch();
      setDragging(true);
      document.body.dataset.tabDragging = "1";
    }
    event.preventDefault();
    if (dragGhost.current) {
      dragGhost.current.style.transform = `translate(${drag.lastX}px, ${drag.lastY}px)`;
    }
    publishTabDrag({
      kind: "session",
      phase: "move",
      key: `session:${session.id}`,
      title: dragTitle,
      selection: dragSelection,
      x: drag.lastX,
      y: drag.lastY,
    });
  }, [cancelPrefetch, dragSelection, dragTitle, session.id]);
  useEffect(() => () => {
    const drag = pointerDrag.current;
    if (drag?.started) {
      publishTabDrag({
        kind: "session",
        phase: "cancel",
        key: `session:${session.id}`,
        title: dragTitle,
        selection: dragSelection,
        x: drag.lastX,
        y: drag.lastY,
      });
    }
    pointerDrag.current = null;
    delete document.body.dataset.tabDragging;
  }, [dragSelection, dragTitle, session.id]);
  return (
    <div
      className={`session-row ${active ? "selected" : ""} ${working ? "working" : ""} ${editing ? "editing" : ""} ${confirmingDelete ? "confirming-delete" : ""}`}
      data-session-id={session.id}
      data-dragging={dragging ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      aria-grabbed={dragging ? "true" : undefined}
      onPointerEnter={schedulePrefetch}
      onPointerLeave={cancelPrefetch}
      onFocusCapture={schedulePrefetch}
      onBlurCapture={cancelPrefetch}
      onPointerDown={(event) => {
        if (event.button !== 0 || event.pointerType === "touch"
          || editing || confirmingDelete || deleting
          || (event.target as Element | null)?.closest?.(
            ".session-row-actions, .session-title-input")) return;
        const pointerId = event.pointerId || 1;
        pointerDrag.current = {
          pointerId,
          source: event.currentTarget,
          startX: event.clientX,
          startY: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY,
          started: false,
        };
        try { event.currentTarget.setPointerCapture?.(pointerId); } catch {}
      }}
      onPointerMove={movePointerDrag}
      onPointerUp={(event) => finishPointerDrag(event.pointerId || 1)}
      onPointerCancel={(event) => finishPointerDrag(event.pointerId || 1, true)}
      onClick={activateFromClick}
    >
      <input ref={titleInput} className="session-title-input"
        value={titleDraft} maxLength={160} disabled={!editing}
        tabIndex={editing ? undefined : -1}
        aria-hidden={editing ? undefined : true}
        aria-label={t("Rename {{name}}", { name: sessionLabel(session) })}
        aria-invalid={titleInvalid || undefined}
        onInput={(event) => onTitleDraftChange(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            onCommitRename(session);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancelRename();
          }
        }}
        onBlur={() => {
          if (editing) onCommitRename(session, true);
        }} />
      <button type="button" className="session-row-main"
        inert={editing ? true : undefined} aria-hidden={editing ? true : undefined}>
        <span className="session-row-copy"
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onStartRename(session);
          }}>
          <b>{sessionLabel(session)}</b>
        </span>
        <span className="session-row-status" data-working={working || undefined}>
          {working && <ProgressSpinner size={12} className="session-row-spinner" role="status"
            aria-label={t("{{name}} is working", { name: sessionLabel(session) })} />}
        </span>
        {unread && !working && <span className="session-row-unread-dot" role="status"
          aria-label={t("{{name}} has new activity", { name: sessionLabel(session) })} />}
      </button>
      <div className="session-row-actions"
        inert={editing ? true : undefined} aria-hidden={editing ? true : undefined}>
        {session.archived === true ? <>
          <button type="button" className={`session-row-action ${confirmingDelete
            ? "session-row-delete-cancel" : "session-row-restore"}`}
            aria-label={confirmingDelete
              ? t("Cancel deleting {{name}}", { name: sessionLabel(session) })
              : t("Restore {{name}}", { name: sessionLabel(session) })}
            data-tooltip={confirmingDelete ? t("Cancel") : t("Restore")}
            disabled={confirmingDelete && deleting}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (confirmingDelete) onCancelDelete();
              else void onArchiveSession(session.id, false).catch(() => {});
            }}>
            {confirmingDelete ? <X size={14} /> : <ArchiveRestore size={14} />}
          </button>
          <button type="button" className={`session-row-action ${confirmingDelete
            ? "session-row-delete-confirm" : "session-row-delete danger"}`}
            aria-label={confirmingDelete
              ? t("Confirm deleting {{name}}", { name: sessionLabel(session) })
              : t("Delete {{name}}", { name: sessionLabel(session) })}
            data-tooltip={confirmingDelete ? t("Delete") : undefined}
            disabled={confirmingDelete && deleting}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (confirmingDelete) onConfirmDelete(session);
              else onStartDelete(session);
            }}>
            <Trash2 size={confirmingDelete ? 12 : 13} />
          </button>
        </> : <button type="button" className="session-row-action session-row-archive"
          aria-label={t("Archive {{name}}", { name: sessionLabel(session) })} data-tooltip={t("Archive")}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void onArchiveSession(session.id, true).catch(() => {});
          }}>
          <Archive size={14} />
        </button>}
      </div>
      {dragging ? createPortal(
        <div className="workspace-tab-ghost session-row-drag-ghost" aria-hidden="true"
          ref={(node) => {
            dragGhost.current = node;
            const drag = pointerDrag.current;
            if (node && drag) {
              node.style.transform = `translate(${drag.lastX}px, ${drag.lastY}px)`;
            }
          }}>
          <span>{dragTitle}</span>
        </div>,
        document.body,
      ) : null}
    </div>
  );
});
