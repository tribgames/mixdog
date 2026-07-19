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
  ArrowDown,
  Folder,
  FolderPlus,
  MessageCircle,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  Pencil,
  Pin,
  Plus,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import { OcIcon } from "./OcIcon";
import type {
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopUpdaterState,
} from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";

export type NavigationSelection =
  | { kind: "new"; draftId?: string }
  | { kind: "project"; path: string }
  | { kind: "session"; id: string };

export interface WorkspaceTab {
  key: string;
  title: string;
  selection: NavigationSelection;
}

interface DesktopTitlebarProps {
  sidebarOpen: boolean;
  tabs: WorkspaceTab[];
  activeKey: string;
  activeBusy?: boolean;
  updaterState?: DesktopUpdaterState;
  dockOpen?: boolean;
  onToggleSidebar(): void;
  onSelectTab(tab: WorkspaceTab): void;
  onCloseTab(tab: WorkspaceTab): void;
  onReorderTab(sourceKey: string, targetKey: string): void;
  onNewTask(): void;
  onOpenUpdate?(): void;
  onToggleDock?(): void;
}

function SidebarToggleIcon({ open }: { open: boolean }) {
  // Outline-only glyph (user: no filled state) from the rounded lucide set,
  // matching the New task / Project icons.
  return <PanelLeft className="sidebar-toggle-icon" size={18}
    data-state={open ? "open" : "closed"} aria-hidden="true" />;
}

export function DesktopTitlebar({
  sidebarOpen,
  tabs,
  activeKey,
  activeBusy = false,
  updaterState,
  dockOpen = false,
  onToggleSidebar,
  onSelectTab,
  onCloseTab,
  onReorderTab,
  onNewTask,
  onOpenUpdate,
  onToggleDock,
}: DesktopTitlebarProps) {
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
  const tabStrip = useRef<HTMLElement>(null);
  const pointerDrag = useRef<{
    pointerId: number;
    sourceKey: string;
    startX: number;
    started: boolean;
    lastTargetKey: string;
  } | null>(null);
  const suppressTabClick = useRef("");
  const [draggingKey, setDraggingKey] = useState("");
  const windowsCaptionControls = typeof navigator !== "undefined" &&
    /Windows/i.test(navigator.userAgent);
  const setTabNode = useCallback((key: string, node: HTMLDivElement | null) => {
    if (node) tabNodes.current.set(key, node);
    else tabNodes.current.delete(key);
  }, []);
  const onTabKeyDown = useWorkspaceTabCommands({
    tabs,
    activeKey,
    onSelectTab,
    onCloseTab,
    onNewTask,
  });

  useEffect(() => {
    tabNodes.current.get(activeKey)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  const finishPointerDrag = useCallback((pointerId: number) => {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (drag.started) suppressTabClick.current = drag.sourceKey;
    const source = tabNodes.current.get(drag.sourceKey);
    try {
      if (source?.hasPointerCapture?.(pointerId)) source.releasePointerCapture(pointerId);
    } catch {
      // The browser can release capture before React delivers pointercancel.
    }
    pointerDrag.current = null;
    setDraggingKey("");
  }, []);

  const movePointerDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const drag = pointerDrag.current;
    const pointerId = event.pointerId || 1;
    if (!drag || drag.pointerId !== pointerId) return;
    if (!drag.started) {
      if (Math.abs(event.clientX - drag.startX) < 4) return;
      drag.started = true;
      const source = tabNodes.current.get(drag.sourceKey);
      try { source?.setPointerCapture?.(pointerId); } catch {}
      setDraggingKey(drag.sourceKey);
      const sourceTab = tabs.find((tab) => tab.key === drag.sourceKey);
      if (sourceTab && sourceTab.key !== activeKey) onSelectTab(sourceTab);
    }
    event.preventDefault();

    const strip = tabStrip.current;
    if (!strip) return;
    const stripRect = strip.getBoundingClientRect();
    const edge = Math.max(24, stripRect.width * 0.05);
    const scrollDistance = Math.max(8, Math.min(24, edge * 0.5));
    if (event.clientX < stripRect.left + edge) {
      strip.scrollBy?.({ left: -scrollDistance, behavior: "auto" });
    } else if (event.clientX > stripRect.right - edge) {
      strip.scrollBy?.({ left: scrollDistance, behavior: "auto" });
    }

    const pointed = document.elementFromPoint?.(event.clientX, event.clientY);
    let targetNode = pointed?.closest<HTMLElement>(".workspace-tab") ||
      (event.target as Element | null)?.closest?.<HTMLElement>(".workspace-tab") || null;
    if (targetNode && !strip.contains(targetNode)) targetNode = null;
    if (!targetNode) {
      let closestDistance = Number.POSITIVE_INFINITY;
      for (const node of tabNodes.current.values()) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0) continue;
        const distance = Math.abs(event.clientX - (rect.left + rect.width / 2));
        if (distance < closestDistance) {
          closestDistance = distance;
          targetNode = node;
        }
      }
    }
    const targetKey = targetNode?.dataset.tabKey || "";
    if (!targetKey || targetKey === drag.sourceKey || targetKey === drag.lastTargetKey) return;
    drag.lastTargetKey = targetKey;
    onReorderTab(drag.sourceKey, targetKey);
  }, [activeKey, onReorderTab, onSelectTab, tabs]);

  const updateVisible = updaterState?.status === "ready" || updaterState?.status === "installing";
  const updateInstalling = updaterState?.status === "installing";

  return (
    <header className="topbar" aria-label="Workspace tabs">
      <div className="titlebar-leading">
        <button
          type="button"
          className="icon-button toolbar-sidebar"
          onClick={onToggleSidebar}
          aria-label={`${sidebarOpen ? "Collapse" : "Expand"} session sidebar`}
          aria-expanded={sidebarOpen}
          aria-controls="session-sidebar"
        >
          <SidebarToggleIcon open={sidebarOpen} />
        </button>
      </div>

      <div className="workspace-tabs-shell" data-slot="workspace-tabs" data-count={tabs.length}>
        <nav ref={tabStrip} className="workspace-tabs" data-slot="workspace-tabs-scroll"
          aria-label="Open workspaces" onKeyDown={onTabKeyDown}
          onPointerMove={movePointerDrag}
          onPointerUp={(event) => finishPointerDrag(event.pointerId || 1)}
          onPointerCancel={(event) => finishPointerDrag(event.pointerId || 1)}>
          {tabs.map((tab) => {
            const active = tab.key === activeKey;
            const working = active && activeBusy;
            return (
                <div key={tab.key}
                  ref={(node) => setTabNode(tab.key, node)}
                  className={`workspace-tab ${active ? "active" : ""} ${draggingKey === tab.key ? "dragging" : ""}`}
                  data-tab-key={tab.key}
                  data-active={active}
                  data-working={working || undefined}
                  aria-grabbed={draggingKey === tab.key}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || event.pointerType === "touch" ||
                      (event.target as Element | null)?.closest?.(".workspace-tab-close")) return;
                    const pointerId = event.pointerId || 1;
                    pointerDrag.current = {
                      pointerId,
                      sourceKey: tab.key,
                      startX: event.clientX,
                      started: false,
                      lastTargetKey: "",
                    };
                  }}
                  onLostPointerCapture={(event) => {
                    if (pointerDrag.current?.started) finishPointerDrag(event.pointerId || 1);
                  }}
                  onMouseDown={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    onCloseTab(tab);
                  }}
                >
                  <button
                    type="button"
                    className="workspace-tab-main"
                    onClick={() => {
                      if (suppressTabClick.current === tab.key) {
                        suppressTabClick.current = "";
                        return;
                      }
                      onSelectTab(tab);
                    }}
                    aria-current={active ? "page" : undefined}
                    data-tooltip={tab.title}
                  >
                    {tab.selection.kind === "project"
                      ? <Folder size={14} />
                      : <MessageCircle size={14} />}
                    {working && <span className="workspace-tab-status" role="status"
                      aria-label={`${tab.title} is working`} />}
                    <span>{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    className="workspace-tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab);
                    }}
                    aria-label={`Close ${tab.title}`}
                    data-tooltip="Close tab"
                  >
                    <X size={16} />
                  </button>
                </div>
            );
          })}
        </nav>
        <span className="workspace-tabs-fade workspace-tabs-fade-left" aria-hidden="true" />
        <span className="workspace-tabs-fade workspace-tabs-fade-right" aria-hidden="true" />
        {/* OpenCode parity (titlebar.tsx `Show when={!(creating() && params.dir)}`):
            while a draft tab is active the draft IS the new-session surface, so
            the + affordance hides; it returns once a real tab is active. */}
        {!tabs.some((tab) => tab.key === activeKey && tab.selection.kind === "new") && (
          <button type="button" className="icon-button titlebar-new" onClick={onNewTask}
            aria-label="New task" data-tooltip="New task">
            <OcIcon name="plus" size={16} />
          </button>
        )}
      </div>

      {updateVisible && <div className="titlebar-update-shell">
        <button type="button" className="titlebar-update" onClick={onOpenUpdate}
          disabled={updateInstalling} aria-busy={updateInstalling}
          aria-label={updateInstalling ? "Installing update" : `Install Mixdog ${updaterState.version}`}>
          <span className="titlebar-update-label">
            {updateInstalling ? "Installing" : "Update"}
          </span>
          <span className="titlebar-update-icon" aria-hidden="true">
            {updateInstalling
              ? <span className="titlebar-update-loader" />
              : <ArrowDown size={12} />}
          </span>
        </button>
      </div>}
      {windowsCaptionControls && <div className="titlebar-caption-space" aria-hidden="true" />}
    </header>
  );
}

function useWorkspaceTabCommands({
  tabs,
  activeKey,
  onSelectTab,
  onCloseTab,
  onNewTask,
}: Pick<DesktopTitlebarProps, "tabs" | "activeKey" | "onSelectTab" | "onCloseTab" | "onNewTask">) {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    if ((!event.metaKey && !event.ctrlKey) || event.shiftKey) return;
    const activeIndex = tabs.findIndex((tab) => tab.key === activeKey);
    const select = (index: number) => {
      const tab = tabs[index];
      if (!tab) return false;
      onSelectTab(tab);
      return true;
    };
    let handled = false;

    if (!event.altKey && event.key.toLocaleLowerCase() === "t") {
      onNewTask();
      handled = true;
    } else if (!event.altKey && event.key.toLocaleLowerCase() === "w") {
      const tab = tabs[activeIndex];
      if (tab) {
        onCloseTab(tab);
        handled = true;
      }
    } else if (event.altKey && tabs.length > 0 && event.key === "ArrowLeft") {
      handled = select((activeIndex - 1 + tabs.length) % tabs.length);
    } else if (event.altKey && tabs.length > 0 && event.key === "ArrowRight") {
      handled = select((activeIndex + 1) % tabs.length);
    } else if (!event.altKey && /^[1-9]$/.test(event.key)) {
      handled = select(Number(event.key) - 1);
    }

    if (handled) event.preventDefault();
  }, [activeKey, onCloseTab, onNewTask, onSelectTab, tabs]);
}

function sessionLabel(session: DesktopSessionSummary) {
  return sessionSummaryTitle(session);
}

function projectIdentity(path: string | null | undefined) {
  return String(path || "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();
}

const LEGACY_DEFAULT_SIDEBAR_WIDTH = 286;
const DEFAULT_SIDEBAR_WIDTH = 260;
// OpenCode project-avatar palette: deterministic per-project colour chips.
const AVATAR_VARIANTS = ["orange", "yellow", "cyan", "green", "red", "pink", "blue", "purple"] as const;
function avatarVariantFor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) hash = ((hash * 31) + seed.charCodeAt(index)) | 0;
  return AVATAR_VARIANTS[Math.abs(hash) % AVATAR_VARIANTS.length];
}
function avatarInitials(label: string): string {
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
    if (value === LEGACY_DEFAULT_SIDEBAR_WIDTH) return DEFAULT_SIDEBAR_WIDTH;
    return Number.isFinite(value) && value > 0 ? clampSidebarWidth(value) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

interface SessionSidebarProps {
  open: boolean;
  sessions: DesktopSessionSummary[];
  selection: NavigationSelection;
  onNewTask(): void;
  onOpenProjects(): void;
  onOpenSettings(): void;
  onResumeSession(sessionId: string): void;
  onRenameSession(sessionId: string, title: string): Promise<void>;
  onDeleteSession(sessionId: string): Promise<void>;
}

export const SessionSidebar = React.memo(function SessionSidebar({
  open,
  sessions,
  selection,
  onNewTask,
  onOpenProjects,
  onOpenSettings,
  onResumeSession,
  onRenameSession,
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
    .sort((left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)),
  [sessions]);
  const rows = allRows;
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
      {/* Sidebar glyphs use the rounded lucide set (Claude-style): the ported
          OpenCode square-cap glyphs read flat/washed at list sizes. */}
      <nav className="sidebar-primary-nav" aria-label="Workspace">
        <button type="button" className="task-link" onClick={onNewTask}>
          <span className="sidebar-nav-icon sidebar-nav-icon--new"><Plus size={18} /></span>
          <span>New task</span>
        </button>
        <button type="button" className="projects-link" onClick={onOpenProjects}
          aria-label="Open projects">
          <span className="sidebar-nav-icon"><Folder size={18} /></span>
          <span>Project</span>
        </button>
      </nav>

      <div className="session-sidebar-scroll">
        <section className="sidebar-recent" aria-label="Recent sessions">
          <div className="sidebar-recent-heading">
            <span>Recent</span>
          </div>
          <nav id="recent-session-list" className="session-list recent-session-list" aria-label="Recent sessions">
            {rows.length === 0 && <p className="sidebar-section-empty">No sessions</p>}
            {rows.map((session) => <SessionSidebarRow key={session.id}
              session={session} active={selection.kind === "session" && selection.id === session.id}
              editingSessionId={editingSessionId} sessionTitleDraft={sessionTitleDraft}
              sessionTitleInvalid={sessionTitleInvalid} menuSessionId={menuSessionId}
              confirmingSessionId={confirmingSessionId} deletingSessionId={deletingSessionId}
              onTitleDraftChange={setSessionTitleDraft} onStartRename={openSessionEditor}
              onCancelRename={closeSessionEditor} onCommitRename={commitSessionEditor}
              onResumeSession={onResumeSession} onCloseEditor={closeSessionEditor}
              onSetMenu={setMenuSessionId} onSetConfirming={setConfirmingSessionId}
              onSetDeleting={setDeletingSessionId} onDeleteSession={onDeleteSession} />)}
          </nav>
        </section>
      </div>
      <footer className="session-sidebar-footer">
        <button type="button" className="sidebar-settings-button" onClick={onOpenSettings}
          aria-label="Open settings" data-tooltip="Settings">
          <Settings size={18} /><span>Settings</span>
        </button>
      </footer>
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
  onResumeSession,
  onCloseEditor,
  onSetMenu,
  onSetConfirming,
  onSetDeleting,
  onDeleteSession,
}: {
  session: DesktopSessionSummary;
  active: boolean;
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
  onResumeSession(sessionId: string): void;
  onCloseEditor(): void;
  onSetMenu: React.Dispatch<React.SetStateAction<string>>;
  onSetConfirming: React.Dispatch<React.SetStateAction<string>>;
  onSetDeleting: React.Dispatch<React.SetStateAction<string>>;
  onDeleteSession(sessionId: string): Promise<void>;
}) {
  return <SessionRow session={session} active={active}
    editing={editingSessionId === session.id}
    titleDraft={sessionTitleDraft}
    titleInvalid={sessionTitleInvalid}
    onTitleDraftChange={onTitleDraftChange}
    onStartRename={onStartRename}
    onCancelRename={onCancelRename}
    onCommitRename={onCommitRename}
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
  editing,
  titleDraft,
  titleInvalid,
  onTitleDraftChange,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onResumeSession,
  menuOpen,
  onToggleMenu,
  onCloseMenu,
  confirmingDelete,
  deleting,
  onStartDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  session: DesktopSessionSummary;
  active: boolean;
  editing: boolean;
  titleDraft: string;
  titleInvalid: boolean;
  onTitleDraftChange(value: string): void;
  onStartRename(session: DesktopSessionSummary): void;
  onCancelRename(): void;
  onCommitRename(session: DesktopSessionSummary, fromBlur?: boolean): void;
  onResumeSession(sessionId: string): void;
  menuOpen: boolean;
  onToggleMenu(session: DesktopSessionSummary): void;
  onCloseMenu(): void;
  confirmingDelete: boolean;
  deleting: boolean;
  onStartDelete(session: DesktopSessionSummary): void;
  onCancelDelete(): void;
  onConfirmDelete(session: DesktopSessionSummary): void;
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
            {/* Grok-web recent list: plain titles, no per-row glyph. */}
            <span className="session-row-copy"
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onStartRename(session);
              }}>
              <b>{sessionLabel(session)}</b>
            </span>
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
              <div className="session-row-menu-wrap">
                <button type="button" className="session-row-action session-row-more"
                  ref={menuTrigger}
                  aria-label={`More actions for ${sessionLabel(session)}`}
                  aria-expanded={menuOpen}
                  aria-haspopup="menu"
                  data-tooltip="More"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onToggleMenu(session);
                  }}>
            <MoreHorizontal size={15} />
                </button>
                {menuOpen && <div className="session-row-menu" role="menu"
                  data-session-menu-for={session.id}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      onCloseMenu();
                      queueMicrotask(() => menuTrigger.current?.focus());
                      return;
                    }
                    cycleMenuFocus(event);
                  }}>
                  <button type="button" role="menuitem" className="session-row-menu-rename"
                    onClick={() => {
                      onCloseMenu();
                      onStartRename(session);
          }}><Pencil size={13} />Rename</button>
                  <button type="button" role="menuitem" className="session-row-menu-delete danger"
                    onClick={() => {
                      onCloseMenu();
                      onStartDelete(session);
          }}><Trash2 size={13} />Delete</button>
                </div>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
});

interface ProjectSwitcherProps {
  open: boolean;
  projects: DesktopProjectSummary[];
  selectedProjectPath: string;
  onClose(): void;
  onChooseProject(): void;
  onStartProject(path: string): void;
  onStartProjectTask(path: string): void;
  onOpenExplorer(path: string): void;
  onSetPinned(path: string, pinned: boolean): Promise<void>;
  onRename(path: string, alias: string): void;
  onRemove(path: string): Promise<void>;
}

function displayProject(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

export function ProjectSwitcher({
  open,
  projects,
  selectedProjectPath,
  onClose,
  onChooseProject,
  onStartProject,
  onStartProjectTask,
  onOpenExplorer,
  onSetPinned,
  onRename,
  onRemove,
}: ProjectSwitcherProps) {
  const panel = useRef<HTMLDivElement>(null);
  const triggerFocus = useRef<HTMLElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const menuState = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

  useEffect(() => {
    setMenu(null);
    setRenaming(null);
  }, [open]);

  useEffect(() => {
    menuState.current = menu;
    if (menu) queueMicrotask(() => panel.current
      ?.querySelector<HTMLButtonElement>('.project-card-menu [role="menuitem"]')?.focus());
  }, [menu]);

  useEffect(() => {
    if (!open) return;
    triggerFocus.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const background = document.querySelector<HTMLElement>(".app-shell");
    background?.setAttribute("inert", "");
    background?.setAttribute("aria-hidden", "true");
    queueMicrotask(() => panel.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (menuState.current) {
          setMenu(null);
          queueMicrotask(() => menuTrigger.current?.focus());
          return;
        }
        onClose();
        queueMicrotask(() => triggerFocus.current?.focus());
      } else if (event.key === "Tab") {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || []);
        if (controls.length === 0) return;
        const current = controls.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? (current <= 0 ? controls.length - 1 : current - 1)
          : (current >= controls.length - 1 ? 0 : current + 1);
        event.preventDefault();
        controls[next]?.focus();
      }
    };
    window.addEventListener("keydown", dismiss);
    return () => {
      window.removeEventListener("keydown", dismiss);
      background?.removeAttribute("inert");
      background?.removeAttribute("aria-hidden");
      queueMicrotask(() => triggerFocus.current?.focus());
    };
  }, [onClose, open]);

  if (!open) return null;
  const ordered = [...projects].sort((left, right) => Number(right.pinned) - Number(left.pinned));

  return createPortal(
    <div className="project-switcher-layer" onPointerDown={(event) => {
      if (event.target !== event.currentTarget) return;
      onClose();
      queueMicrotask(() => triggerFocus.current?.focus());
    }}>
      <div ref={panel} className="project-switcher" role="dialog" aria-modal="true"
        aria-labelledby="project-switcher-title" onPointerDownCapture={(event) => {
          if (!menu || !(event.target instanceof Element)) return;
          if (event.target.closest(".project-card-menu, .project-more")) return;
          setMenu(null);
        }}>
        <header>
        <span className="project-switcher-mark"><Folder size={18} /></span>
          <div>
            <h1 id="project-switcher-title">Projects</h1>
            <p>Choose the workspace for your next task.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close projects">
          <X size={16} />
          </button>
        </header>
        <div className="project-switcher-toolbar">
          <button className="primary-button new-project projects-add" onClick={() => {
            onClose();
            onChooseProject();
          }}>
          <FolderPlus size={15} /> Add project
          </button>
        </div>
        <div className="project-grid project-list" role="list">
          {ordered.length === 0 && (
            <div className="project-empty">
            <Folder size={22} />
              <p>No projects yet</p>
              <small>Add a folder to make it available in Mixdog.</small>
            </div>
          )}
          {ordered.map((project) => {
            const selected = projectIdentity(selectedProjectPath) === projectIdentity(project.path);
            const title = project.alias?.trim() || project.name?.trim() || displayProject(project.path);
            return (
              <div className={`project-card ${selected ? "selected" : ""} ${project.pinned ? "pinned" : ""}`}
                key={project.path} role="listitem">
                {renaming === project.path ? (
                  <RenameProject
                    initialValue={title}
                    onCancel={() => setRenaming(null)}
                    onCommit={(alias) => {
                      setRenaming(null);
                      onRename(project.path, alias);
                    }}
                  />
                ) : (
                  <>
                    <button className="project-row" onClick={() => {
                      onStartProject(project.path);
                      onClose();
                    }} aria-current={selected ? "page" : undefined}>
                      {/* Grok-clean rows: a quiet folder glyph instead of the
                          coloured initials chip (user-flagged as noisy). */}
                      <span className="project-avatar project-avatar--icon" aria-hidden="true">
                        <Folder size={16} />
                      </span>
                      <span>
                        <span className="project-title-line">
                          <b>{title}</b>
                          {project.pinned && <Pin className="project-pin-mark" size={11}
                            aria-label="Pinned project" />}
                        </span>
                        <small>{project.path}</small>
                      </span>
                    </button>
                    <button className="project-more" aria-label={`More actions for ${title}`}
                      aria-expanded={menu === project.path} aria-haspopup="menu"
                      onClick={(event) => {
                        menuTrigger.current = event.currentTarget;
                        setMenu((value) => value === project.path ? null : project.path);
                      }}>
                      <MoreHorizontal size={16} />
                    </button>
                    {menu === project.path && (
                      <div className="project-card-menu" role="menu"
                        onKeyDown={(event) => cycleMenuFocus(event)}>
                        <button role="menuitem" onClick={() => {
                          setMenu(null);
                          onStartProjectTask(project.path);
                          onClose();
                        }}>New task</button>
                        <button role="menuitem" onClick={() => {
                          setMenu(null);
                          onOpenExplorer(project.path);
                          queueMicrotask(() => menuTrigger.current?.focus());
                        }}>Open in Explorer</button>
                        <button role="menuitem" onClick={() => {
                          setMenu(null);
                          void onSetPinned(project.path, !project.pinned)
                            .finally(() => queueMicrotask(() => menuTrigger.current?.focus()));
                        }}><Pin size={13} />{project.pinned ? "Unpin project" : "Pin project"}</button>
                        <button role="menuitem" onClick={() => {
                          setMenu(null);
                          setRenaming(project.path);
                        }}>Rename</button>
                        <button role="menuitem" className="danger" onClick={() => {
                          setMenu(null);
                          void onRemove(project.path).finally(() => queueMicrotask(() => panel.current
                            ?.querySelector<HTMLButtonElement>(".project-row")?.focus()));
                        }}>Remove project</button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function cycleMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
  if (items.length === 0) return;
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(index + delta + items.length) % items.length]?.focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
  }
}

function RenameProject({ initialValue, onCommit, onCancel }: {
  initialValue: string;
  onCommit(value: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initialValue);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return (
    <form className="project-rename" onSubmit={(event) => {
      event.preventDefault();
      if (value.trim()) onCommit(value.trim());
    }}>
      <input ref={input} value={value} maxLength={120} aria-label="Project display name"
        onChange={(event) => setValue(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          onCancel();
        }} />
    </form>
  );
}
