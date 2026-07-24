import React, {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ArrowDown,
  Clock,
  Folder,
  FolderPlus,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  Plus,
  Settings,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { MxIcon } from "./MxIcon";
import type {
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopUpdaterState,
} from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";

import type { NavigationSelection, WorkspaceTab } from "./nav-types";

export function sessionLabel(session: DesktopSessionSummary) {
  return sessionSummaryTitle(session);
}

export function projectIdentity(path: string | null | undefined) {
  return String(path || "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();
}


const DEFAULT_SIDEBAR_WIDTH = 260;
// Project-avatar palette: deterministic per-project colour chips.
const AVATAR_VARIANTS = ["orange", "yellow", "cyan", "green", "red", "pink", "blue", "purple"] as const;
export function avatarVariantFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = ((hash * 31) + seed.charCodeAt(index)) | 0;
  return AVATAR_VARIANTS[Math.abs(hash) % AVATAR_VARIANTS.length];
}
export function avatarInitials(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  const initials = words.length >= 2 ? `${words[0][0]}${words[1][0]}` : label.trim().slice(0, 2);
  return initials.toUpperCase();
}
const MIN_SIDEBAR_WIDTH = 232;
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

interface SessionSidebarProps {
  open: boolean;
  sessions: DesktopSessionSummary[];
  workingSessionIds?: ReadonlySet<string>;
  unreadSessionIds?: ReadonlySet<string>;
  /** Session-scoped channel relay owner: shown as its own single-row Remote
   *  section between Automations and Recent (user decision). */
  remoteSessionId?: string;
  selection: NavigationSelection;
  /** Which primary-nav surface currently owns the main pane/dialog. New task
   *  is an action (fresh draft each press), so it never renders selected
   *  (user decision). */
  activeSurface?: "projects" | "schedules" | "webhooks" | "settings" | null;
  onNewTask(): void;
  onOpenProjects(): void;
  onOpenSchedules(): void;
  onOpenWebhooks(): void;
  onOpenSettings(): void;
  onPrefetchSession?(sessionId: string): Promise<boolean>;
  onResumeSession(sessionId: string): void;
  onRenameSession(sessionId: string, title: string): Promise<void>;
  /** Archive: the row leaves Recent but the session file stays. */
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
  onDeleteSession(sessionId: string): Promise<void>;
}

export const SessionSidebar = React.memo(function SessionSidebar({
  open,
  sessions,
  workingSessionIds,
  unreadSessionIds,
  remoteSessionId = "",
  selection,
  activeSurface = null,
  onNewTask,
  onOpenProjects,
  onOpenSchedules,
  onOpenWebhooks,
  onOpenSettings,
  onPrefetchSession,
  onResumeSession,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
}: SessionSidebarProps) {
  const [editingSessionId, setEditingSessionId] = useState("");
  const [sessionTitleDraft, setSessionTitleDraft] = useState("");
  const [sessionTitleInvalid, setSessionTitleInvalid] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState("");
  const [confirmingSessionId, setConfirmingSessionId] = useState("");
  const [deletingSessionId, setDeletingSessionId] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const resizeStart = useRef<{ clientX: number; width: number } | null>(null);
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
    resizeStart.current = null;
    document.body.classList.remove("session-sidebar-resizing");
  }, []);
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
  const [expandedAutomations, setExpandedAutomations] = useState<ReadonlySet<string>>(new Set());
  const toggleAutomationGroup = useCallback((key: string) => {
    setExpandedAutomations((current) => {
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
  const [automationsOpen, setAutomationsOpen] = useState(true);
  const [remoteOpen, setRemoteOpen] = useState(true);
  const [archivedOpen, setArchivedOpen] = useState(false);
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
  useEffect(() => {
    if (!open || !onPrefetchSession) return undefined;
    const candidates = rows
      .filter((session) => !(selection.kind === "session" && selection.id === session.id))
      .slice(0, 2);
    const timers = candidates.map((session, index) => window.setTimeout(
      () => requestPrefetch(session.id),
      350 + index * 250,
    ));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [onPrefetchSession, open, requestPrefetch, rows, selection]);
  const openSessionEditor = useCallback((session: DesktopSessionSummary) => {
    setMenuSessionId("");
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
    if (menuSessionId && !sessions.some((session) => session.id === menuSessionId)) {
      setMenuSessionId("");
    }
    if (confirmingSessionId && !sessions.some((session) => session.id === confirmingSessionId)) {
      setConfirmingSessionId("");
    }
  }, [confirmingSessionId, menuSessionId, sessions]);

  return (
    <aside
      id="session-sidebar"
      className={`sidebar session-sidebar ${open ? "open" : ""}`}
      data-state={open ? "open" : "closed"}
      inert={!open}
      aria-hidden={!open}
      aria-label="Session manager"
      style={{ "--session-sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
      onPointerDownCapture={(event) => {
        if (!menuSessionId || !(event.target instanceof Element)) return;
        if (event.target.closest(".session-row-menu, .session-row-more")) return;
        setMenuSessionId("");
      }}
    >
      {/* Sidebar glyphs use the rounded lucide set: the ported
          square-cap glyphs read flat/washed at list sizes. */}
      <nav className="sidebar-primary-nav" aria-label="Workspace">
        <button type="button" className="task-link" onClick={onNewTask}>
          <span className="sidebar-nav-icon sidebar-nav-icon--new"><Plus size={18} /></span>
          <span>New task</span>
        </button>
        <button type="button"
          className={`projects-link ${activeSurface === "projects" ? "selected" : ""}`}
          aria-current={activeSurface === "projects" ? "page" : undefined}
          onClick={onOpenProjects}
          aria-label="Open projects">
          <span className="sidebar-nav-icon"><Folder size={18} /></span>
          <span>Project</span>
        </button>
        {/* Scheduled tasks joins the primary nav (Claude-style 예약됨 page). */}
        <button type="button"
          className={`projects-link ${activeSurface === "schedules" ? "selected" : ""}`}
          aria-current={activeSurface === "schedules" ? "page" : undefined}
          onClick={onOpenSchedules}
          aria-label="Open schedules">
          <span className="sidebar-nav-icon"><Clock size={18} /></span>
          <span>Schedules</span>
        </button>
        {/* Inbound webhooks: same main-pane takeover concept as Schedules. */}
        <button type="button"
          className={`projects-link ${activeSurface === "webhooks" ? "selected" : ""}`}
          aria-current={activeSurface === "webhooks" ? "page" : undefined}
          onClick={onOpenWebhooks}
          aria-label="Open webhooks">
          <span className="sidebar-nav-icon"><Webhook size={18} /></span>
          <span>Webhooks</span>
        </button>
        {/* Settings joins the primary nav (user: no bottom footer label). */}
        <button type="button"
          className={`projects-link sidebar-settings-button ${activeSurface === "settings" ? "selected" : ""}`}
          aria-current={activeSurface === "settings" ? "page" : undefined}
          onClick={onOpenSettings}
          aria-label="Open settings" data-tooltip="Settings">
          <span className="sidebar-nav-icon"><Settings size={18} /></span>
          <span>Settings</span>
        </button>
      </nav>

      <div className="session-sidebar-scroll">
        {automationGroups.length > 0 && (
          <section className="sidebar-recent sidebar-automations" aria-label="Automations">
            <button type="button" className="sidebar-recent-heading sidebar-heading-toggle"
              aria-expanded={automationsOpen}
              onClick={() => setAutomationsOpen((open) => !open)}>
              <span>Automations</span>
              {automationsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {automationsOpen && (
              <nav className="session-list automation-session-list" aria-label="Automations">
                {automationGroups.map(({ key, name, runs }) => {
                  const expanded = expandedAutomations.has(key);
                  const working = runs.some((run) => workingSessionIds?.has(run.id) === true);
                  const unread = runs.some((run) => unreadSessionIds?.has(run.id) === true);
                  return <div className="automation-group" key={key}>
                    {/* The group header is a PURE disclosure (user decision):
                        clicking toggles the run list — it never renames and
                        never opens a session itself. */}
                    <button type="button" className="session-row automation-group-header"
                      aria-expanded={expanded}
                      onClick={() => toggleAutomationGroup(key)}>
                      <span className="session-row-status" data-working={working || undefined}>
                        {working && <LoaderCircle size={12} className="session-row-spinner" role="status"
                          aria-label={`${name} is working`} />}
                      </span>
                      <span className="session-row-copy">
                        <b>{name}</b>
                        <span className="session-row-expand" aria-hidden="true">
                          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </span>
                      </span>
                      {unread && !working && <span className="session-row-unread-dot" role="status"
                        aria-label={`${name} has new activity`} />}
                    </button>
                    {expanded && <div className="automation-group-past">
                      {runs.map((session) => <SessionSidebarRow key={session.id}
                        session={session} active={selection.kind === "session" && selection.id === session.id}
                        working={workingSessionIds?.has(session.id) === true}
                        unread={unreadSessionIds?.has(session.id) === true}
                        editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
                        sessionTitleInvalid={sessionTitleInvalid} menuSessionId={menuSessionId}
                        confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
                        onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
                        onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
                        onPrefetchSession={requestPrefetch}
                        onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
                        onSetMenu={setMenuSessionId} onSetConfirming={setConfirmingSessionId}
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
          <section className="sidebar-recent sidebar-remote" aria-label="Remote">
            <button type="button" className="sidebar-recent-heading sidebar-heading-toggle"
              aria-expanded={remoteOpen}
              onClick={() => setRemoteOpen((open) => !open)}>
              <span>Remote</span>
              {remoteOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {remoteOpen && (
              <nav className="session-list remote-session-list" aria-label="Remote">
                <SessionSidebarRow key={remoteRow.id}
                  session={remoteRow} active={selection.kind === "session" && selection.id === remoteRow.id}
                  working={workingSessionIds?.has(remoteRow.id) === true}
                  unread={unreadSessionIds?.has(remoteRow.id) === true}
                  editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
                  sessionTitleInvalid={sessionTitleInvalid} menuSessionId={menuSessionId}
                  confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
                  onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
                  onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
                  onPrefetchSession={requestPrefetch}
                  onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
                  onSetMenu={setMenuSessionId} onSetConfirming={setConfirmingSessionId}
                  onSetDeleting={setDeletingSessionId} onDeleteSession={onDeleteSession}
                  onArchiveSession={onArchiveSession} />
              </nav>
            )}
          </section>
        )}
        <section className="sidebar-recent" aria-label="Recent sessions">
          <button type="button" className="sidebar-recent-heading sidebar-heading-toggle"
            aria-expanded={recentOpen}
            onClick={() => setRecentOpen((open) => !open)}>
            <span>Recent</span>
            {recentOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {recentOpen && (
          <nav id="recent-session-list" className="session-list recent-session-list" aria-label="Recent sessions">
            {rows.length === 0 && <p className="sidebar-section-empty">No sessions</p>}
            {rows.map((session) => <SessionSidebarRow key={session.id}
              session={session} active={selection.kind === "session" && selection.id === session.id}
              working={workingSessionIds?.has(session.id) === true}
              unread={unreadSessionIds?.has(session.id) === true}
              editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
              sessionTitleInvalid={sessionTitleInvalid} menuSessionId={menuSessionId}
              confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
              onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
              onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
              onPrefetchSession={requestPrefetch}
              onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
              onSetMenu={setMenuSessionId} onSetConfirming={setConfirmingSessionId}
              onSetDeleting={setDeletingSessionId} onDeleteSession={onDeleteSession}
              onArchiveSession={onArchiveSession} />)}
          </nav>
          )}
        </section>
        {archivedRows.length > 0 && (
          <section className="sidebar-recent sidebar-archived" aria-label="Archived sessions">
            <button type="button" className="sidebar-recent-heading sidebar-heading-toggle sidebar-archived-toggle"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((open) => !open)}>
              <span>Archived</span>
              {archivedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {archivedOpen && (
              <nav className="session-list archived-session-list" aria-label="Archived sessions">
                {archivedRows.map((session) => <SessionSidebarRow key={session.id}
                  session={session} active={selection.kind === "session" && selection.id === session.id}
                working={workingSessionIds?.has(session.id) === true}
                  unread={unreadSessionIds?.has(session.id) === true}
                  editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
                  sessionTitleInvalid={sessionTitleInvalid} menuSessionId={menuSessionId}
                  confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
                  onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
                  onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
                  onPrefetchSession={requestPrefetch}
                  onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
                  onSetMenu={setMenuSessionId} onSetConfirming={setConfirmingSessionId}
                  onSetDeleting={setDeletingSessionId} onDeleteSession={onDeleteSession}
                  onArchiveSession={onArchiveSession} />)}
              </nav>
            )}
          </section>
        )}
      </div>
      <div className="session-sidebar-resize" role="separator" tabIndex={0}
        aria-label="Resize session sidebar" aria-orientation="vertical"
        aria-valuemin={MIN_SIDEBAR_WIDTH} aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth} aria-valuetext={`${sidebarWidth} pixels`}
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
          resizeStart.current = { clientX: event.clientX, width: sidebarWidth };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          document.body.classList.add("session-sidebar-resizing");
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!resizeStart.current) return;
          updateSidebarWidth(resizeStart.current.width + event.clientX - resizeStart.current.clientX);
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
  menuSessionId,
  confirmingSessionId,
  deletingSessionId,
  onTitleDraftChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onPrefetchSession,
  onResumeSession,
  onCloseEditor,
  onSetMenu,
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
  menuSessionId: string;
  confirmingSessionId: string;
  deletingSessionId: string;
  onTitleDraftChange(value: string): void;
  onStartRename(session: DesktopSessionSummary): void;
  onCancelRename(): void;
  onCommitRename(session: DesktopSessionSummary, fromBlur?: boolean): void;
  onPrefetchSession(sessionId: string): void;
  onResumeSession(sessionId: string): void;
  onCloseEditor(): void;
  onSetMenu: React.Dispatch<React.SetStateAction<string>>;
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
    menuOpen={menuSessionId === session.id}
    onToggleMenu={(target) => {
      onCloseEditor();
      onSetConfirming("");
      onSetMenu((current) => current === target.id ? "" : target.id);
    }}
    onCloseMenu={() => onSetMenu("")}
    confirmingDelete={confirmingSessionId === session.id}
    deleting={deletingSessionId === session.id}
    onStartDelete={(target) => {
      onCloseEditor();
      onSetMenu("");
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
  menuOpen,
  onToggleMenu,
  onCloseMenu,
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
  menuOpen: boolean;
  onToggleMenu(session: DesktopSessionSummary): void;
  onCloseMenu(): void;
  confirmingDelete: boolean;
  deleting: boolean;
  onStartDelete(session: DesktopSessionSummary): void;
  onCancelDelete(): void;
  onConfirmDelete(session: DesktopSessionSummary): void;
  onArchiveSession(sessionId: string, archived: boolean): Promise<void>;
}) {
  const resume = useCallback(() => onResumeSession(session.id), [onResumeSession, session.id]);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (menuOpen) {
      queueMicrotask(() => menuTrigger.current?.closest(".session-row")
        ?.querySelector<HTMLButtonElement>(".session-row-menu [role='menuitem']")?.focus());
    }
  }, [menuOpen]);
  const activateFromClick = useCallback(() => {
    if (editing || menuOpen || confirmingDelete || deleting) return;
    onCloseMenu();
    resume();
  }, [confirmingDelete, deleting, editing, menuOpen, onCloseMenu, resume]);
  return (
    <div
      className={`session-row ${active ? "selected" : ""} ${editing ? "editing" : ""} ${confirmingDelete ? "confirming-delete" : ""}`}
      data-session-id={session.id}
      aria-current={active ? "page" : undefined}
      onPointerEnter={() => onPrefetchSession(session.id)}
      onFocusCapture={() => onPrefetchSession(session.id)}
      onClick={activateFromClick}
    >
      {editing ? (
        <input
          className="session-title-input"
          value={titleDraft}
          maxLength={160}
          autoFocus
          aria-label={`Rename ${sessionLabel(session)}`}
          aria-invalid={titleInvalid || undefined}
          onFocus={(event) => event.currentTarget.select()}
          onInput={(event) => {
            onTitleDraftChange(event.currentTarget.value);
          }}
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
          onBlur={() => onCommitRename(session, true)}
        />
      ) : (
        <>
          <button type="button" className="session-row-main">
            {/* Grok-web recent list: plain titles — the ONLY glyph is the
                progress spinner while this session is working. */}
            <span className="session-row-status" data-working={working || undefined}>
              {working && <LoaderCircle size={12} className="session-row-spinner" role="status"
                aria-label={`${sessionLabel(session)} is working`} />}
            </span>
            <span className="session-row-copy"
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onStartRename(session);
              }}>
              <b>{sessionLabel(session)}</b>
            </span>
            {/* Claude-style unread dot: the session advanced while it was not
                the viewed conversation. The working spinner supersedes it. */}
            {unread && !working && <span className="session-row-unread-dot" role="status"
              aria-label={`${sessionLabel(session)} has new activity`} />}
          </button>
          <div className="session-row-actions">
            {confirmingDelete ? (
              <>
                <button type="button" className="session-row-action session-row-delete-cancel"
                  aria-label={`Cancel deleting ${sessionLabel(session)}`} data-tooltip="Cancel"
                  disabled={deleting}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onCancelDelete();
                  }}>
            <X size={13} />
                </button>
                <button type="button" className="session-row-action session-row-delete-confirm"
                  aria-label={`Confirm deleting ${sessionLabel(session)}`} data-tooltip="Delete"
                  disabled={deleting}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onConfirmDelete(session);
                  }}>
            <Trash2 size={12} />
                </button>
              </>
            ) : (
              // Split actions (user decision, no "..." menu): Recent rows
              // only ARCHIVE (instant, restorable — the file stays on disk);
              // destructive delete lives on ARCHIVED rows with the X/✓ confirm.
              session.archived === true ? (
                <>
                  <button type="button" className="session-row-action session-row-restore"
                    aria-label={`Restore ${sessionLabel(session)}`} data-tooltip="Restore"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void onArchiveSession(session.id, false).catch(() => {});
                    }}>
            <ArchiveRestore size={13} />
                  </button>
                  <button type="button" className="session-row-action session-row-delete danger"
                    aria-label={`Delete ${sessionLabel(session)}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onStartDelete(session);
                    }}>
            <Trash2 size={13} />
                  </button>
                </>
              ) : (
                <button type="button" className="session-row-action session-row-archive"
                  aria-label={`Archive ${sessionLabel(session)}`} data-tooltip="Archive"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void onArchiveSession(session.id, true).catch(() => {});
                  }}>
            <Archive size={13} />
                </button>
              )
            )}
          </div>
        </>
      )}
    </div>
  );
});
