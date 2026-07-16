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
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  X,
} from "lucide-react";
import type {
  DesktopProjectSummary,
  DesktopSessionSummary,
} from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";

export type NavigationSelection =
  | { kind: "new" }
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
  onToggleSidebar(): void;
  onSelectTab(tab: WorkspaceTab): void;
  onCloseTab(tab: WorkspaceTab): void;
  onNewTask(): void;
}

function SidebarToggleIcon({ open }: { open: boolean }) {
  return (
    <svg
      className="sidebar-toggle-icon"
      data-state={open ? "open" : "closed"}
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      {open ? (
        <path
          className="sidebar-toggle-icon-active"
          d="M2 2V18H5.2H7.86667V2H5.2H2Z"
          fill="currentColor"
          fillOpacity="0.1"
        />
      ) : null}
      <path
        d="M7.86667 2H5.2H2V18H5.2H7.86667M7.86667 2H18V18H7.86667M7.86667 2V18"
        stroke="currentColor"
      />
    </svg>
  );
}

export function DesktopTitlebar({
  sidebarOpen,
  tabs,
  activeKey,
  onToggleSidebar,
  onSelectTab,
  onCloseTab,
  onNewTask,
}: DesktopTitlebarProps) {
  const tabNodes = useRef(new Map<string, HTMLDivElement>());
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

  return (
    <header className="topbar" aria-label="Workspace tabs">
      <div className="titlebar-leading">
        <button
          type="button"
          className="icon-button toolbar-sidebar"
          onClick={onToggleSidebar}
          aria-label={`${sidebarOpen ? "Collapse" : "Expand"} session sidebar`}
          data-tooltip={`${sidebarOpen ? "Collapse" : "Expand"} sessions`}
          aria-expanded={sidebarOpen}
          aria-controls="session-sidebar"
        >
          <SidebarToggleIcon open={sidebarOpen} />
        </button>
      </div>

      <div className="workspace-tabs-shell" data-slot="workspace-tabs">
        <nav className="workspace-tabs" data-slot="workspace-tabs-scroll" aria-label="Open workspaces"
          onKeyDown={onTabKeyDown}>
          {tabs.map((tab, index) => {
            const active = tab.key === activeKey;
            return (
              <React.Fragment key={tab.key}>
                {index > 0 && <span className="workspace-tab-divider" aria-hidden="true" />}
                <div
                  ref={(node) => setTabNode(tab.key, node)}
                  className={`workspace-tab ${active ? "active" : ""}`}
                  onMouseDown={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    onCloseTab(tab);
                  }}
                >
                  <button
                    type="button"
                    className="workspace-tab-main"
                    onClick={() => onSelectTab(tab)}
                    aria-current={active ? "page" : undefined}
                    data-tooltip={tab.title}
                  >
                    {tab.selection.kind === "project"
                      ? <Folder size={14} />
                      : <MessageSquare size={14} />}
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
                    <X size={12} />
                  </button>
                </div>
              </React.Fragment>
            );
          })}
        </nav>
        <span className="workspace-tabs-fade workspace-tabs-fade-left" aria-hidden="true" />
        <span className="workspace-tabs-fade workspace-tabs-fade-right" aria-hidden="true" />
      </div>

      <button type="button" className="icon-button titlebar-new" onClick={onNewTask}
        aria-label="New task" data-tooltip="New task">
        <Plus size={16} />
      </button>
      <div className="titlebar-spacer" />
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

function projectLabel(
  path: string | null,
  projects: DesktopProjectSummary[],
) {
  if (!path) return "Standalone";
  const identity = projectIdentity(path);
  const project = projects.find((item) => projectIdentity(item.path) === identity);
  if (project?.alias?.trim()) return project.alias.trim();
  if (project?.name?.trim()) return project.name.trim();
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

interface SessionSidebarProps {
  open: boolean;
  sessions: DesktopSessionSummary[];
  projects: DesktopProjectSummary[];
  selection: NavigationSelection;
  onNewTask(): void;
  onChooseProject(): void;
  onOpenProjects(): void;
  onStartProjectTask(projectPath: string): void;
  onOpenSettings(): void;
  onResumeSession(sessionId: string): void;
}

export const SessionSidebar = React.memo(function SessionSidebar({
  open,
  sessions,
  projects,
  selection,
  onNewTask,
  onChooseProject,
  onOpenProjects,
  onStartProjectTask,
  onOpenSettings,
  onResumeSession,
}: SessionSidebarProps) {
  const [query, setQuery] = useState("");
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const rows = useMemo(() => sessions
    .filter((session) => {
      if (session.classification !== "task" && session.classification !== "project") return false;
      if (!normalizedQuery) return true;
      const haystack = [
        session.title,
        session.preview,
        session.cwd,
        projectLabel(session.projectPath, projects),
      ].join(" ").toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    })
    .sort((left, right) =>
      right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)),
  [normalizedQuery, projects, sessions]);

  const { projectGroups, standaloneSessions } = useMemo(() => {
    const grouped = new Map<string, {
      key: string;
      label: string;
      path: string;
      sessions: DesktopSessionSummary[];
      order: number;
    }>();
    projects.forEach((project, order) => {
      const identity = projectIdentity(project.path);
      if (!identity) return;
      grouped.set(identity, {
        key: `project:${identity}`,
        label: projectLabel(project.path, projects),
        path: project.path,
        sessions: [],
        order,
      });
    });
    const standalone: DesktopSessionSummary[] = [];
    for (const session of rows) {
      const projectPath = session.classification === "project" ? session.projectPath : null;
      const identity = projectIdentity(projectPath);
      if (!projectPath || !identity || !grouped.has(identity)) {
        standalone.push(session);
        continue;
      }
      const entry = grouped.get(identity)!;
      entry.sessions.push(session);
      grouped.set(identity, entry);
    }
    const ordered = [...grouped.values()]
      .filter((entry) => !normalizedQuery || entry.sessions.length > 0)
      .sort((left, right) => left.order - right.order);
    return { projectGroups: ordered, standaloneSessions: standalone };
  }, [normalizedQuery, projects, rows]);

  const onQueryChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(event.currentTarget.value);
  }, []);
  const clearQuery = useCallback(() => setQuery(""), []);
  const toggleProjects = useCallback(() => setProjectsCollapsed((value) => !value), []);
  const toggleProject = useCallback((key: string) => setCollapsedProjects((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }), []);

  return (
    <aside
      id="session-sidebar"
      className={`sidebar session-sidebar ${open ? "open" : ""}`}
      inert={!open}
      aria-hidden={!open}
      aria-label="Session manager"
    >
      <label className="session-search">
        <Search size={14} aria-hidden="true" />
        <span className="sr-only">Search sessions</span>
        <input
          type="search"
          value={query}
          onChange={onQueryChange}
          placeholder="Search sessions"
          aria-label="Search sessions"
        />
        {query && (
          <button type="button" onClick={clearQuery} aria-label="Clear session search"
            data-tooltip="Clear search">
            <X size={13} />
          </button>
        )}
      </label>

      <button
        type="button"
        className="task-link"
        onClick={onNewTask}
      >
        <Plus size={15} />
        <span>New task</span>
      </button>

      <div className="session-sidebar-scroll">
        <section className="sidebar-projects" aria-label="Projects">
          <div className="sidebar-section-heading">
            <button type="button" className="sidebar-section-toggle"
              aria-expanded={!projectsCollapsed} onClick={toggleProjects}>
              <span>Projects</span>
              {projectsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
            <button type="button" className="sidebar-section-action" onClick={onOpenProjects}
              aria-label="Manage projects" data-tooltip="Manage projects">
              <MoreHorizontal size={14} />
            </button>
            <button type="button" className="sidebar-section-action" onClick={onChooseProject}
              aria-label="Add project" data-tooltip="Add project">
              <Plus size={14} />
            </button>
          </div>
          {!projectsCollapsed && <div className="sidebar-project-list">
            {projectGroups.length === 0 && <p className="sidebar-section-empty">No projects yet</p>}
            {projectGroups.map(({ key, label, path, sessions: group }) => {
              const collapsed = !normalizedQuery && collapsedProjects.has(key);
              const active = selection.kind === "project"
                && projectIdentity(selection.path) === projectIdentity(path);
              return <section className="session-group project-group" key={key} aria-label={label}>
                <div className="project-group-heading">
                  <button type="button" className={`project-group-toggle ${active ? "selected" : ""}`}
                    aria-current={active ? "page" : undefined} aria-expanded={!collapsed}
                    onClick={() => toggleProject(key)}>
                    {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    <Folder size={14} />
                    <span>{label}</span>
                  </button>
                  <button type="button" className="project-task-add"
                    onClick={() => onStartProjectTask(path)} aria-label={`New task in ${label}`}
                    data-tooltip="New task here">
                    <Plus size={13} />
                  </button>
                </div>
                {!collapsed && <nav className="session-list" aria-label={`${label} sessions`}>
                  {group.length === 0 && <p className="project-sessions-empty">No tasks</p>}
                  {group.map((session) => {
                    const active = selection.kind === "session" && selection.id === session.id;
                    return <SessionRow key={session.id} session={session} active={active}
                      onResumeSession={onResumeSession} />;
                  })}
                </nav>}
              </section>;
            })}
          </div>}
        </section>
        <section className="session-group standalone-group" aria-label="Tasks">
          <h2>Tasks</h2>
          <nav className="session-list standalone-session-list" aria-label="Standalone tasks">
            {standaloneSessions.length === 0 && (
              <p className="sidebar-section-empty">
                {normalizedQuery ? "No matching tasks" : "No tasks"}
              </p>
            )}
            {standaloneSessions.map((session) => {
                const active = selection.kind === "session" && selection.id === session.id;
                return <SessionRow key={session.id} session={session} active={active}
                  onResumeSession={onResumeSession} />;
            })}
          </nav>
        </section>
      </div>
      <footer className="session-sidebar-footer">
        <button type="button" onClick={onOpenSettings} aria-label="Open settings" data-tooltip="Settings">
          <Settings size={15} /><span>Settings</span>
        </button>
      </footer>
    </aside>
  );
});

const SessionRow = React.memo(function SessionRow({
  session,
  active,
  onResumeSession,
}: {
  session: DesktopSessionSummary;
  active: boolean;
  onResumeSession(sessionId: string): void;
}) {
  const resume = useCallback(() => onResumeSession(session.id), [onResumeSession, session.id]);
  return (
    <button
      type="button"
      className={`session-row ${active ? "selected" : ""}`}
      aria-current={active ? "page" : undefined}
      onClick={resume}
      data-tooltip={sessionLabel(session)}
    >
      <span className="session-row-copy">
        <b>{sessionLabel(session)}</b>
      </span>
    </button>
  );
});

interface ProjectSwitcherProps {
  open: boolean;
  projects: DesktopProjectSummary[];
  selection: NavigationSelection;
  onClose(): void;
  onChooseProject(): void;
  onStartProject(path: string): void;
  onStartProjectTask(path: string): void;
  onOpenExplorer(path: string): void;
  onRename(path: string, alias: string): void;
  onSetPinned(path: string, pinned: boolean): void;
  onRemove(path: string): Promise<void>;
}

function displayProject(path: string) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

export function ProjectSwitcher({
  open,
  projects,
  selection,
  onClose,
  onChooseProject,
  onStartProject,
  onStartProjectTask,
  onOpenExplorer,
  onRename,
  onSetPinned,
  onRemove,
}: ProjectSwitcherProps) {
  const panel = useRef<HTMLDivElement>(null);
  const triggerFocus = useRef<HTMLElement | null>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const menuState = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);

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
  const ordered = [...projects].sort((left, right) =>
    Number(right.pinned) - Number(left.pinned) ||
    (left.alias || displayProject(left.path)).localeCompare(right.alias || displayProject(right.path)));

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
          <span className="project-switcher-mark"><FolderOpen size={18} /></span>
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
            <FolderOpen size={15} /> Open project
          </button>
        </div>
        <div className="project-grid project-list" role="list">
          {ordered.length === 0 && (
            <div className="project-empty">
              <Folder size={22} />
              <p>No projects yet</p>
              <small>Open a folder to add it to MixDog.</small>
            </div>
          )}
          {ordered.map((project) => {
            const selected = selection.kind === "project" && selection.path === project.path;
            const title = project.alias?.trim() || project.name?.trim() || displayProject(project.path);
            return (
              <div className={`project-card ${selected ? "selected" : ""}`} key={project.path} role="listitem">
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
                      <span className="project-avatar">{title.slice(0, 1).toLocaleUpperCase()}</span>
                      <span>
                        <b>{title}</b>
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
                        }}>New task here</button>
                        <button role="menuitem" onClick={() => {
                          setMenu(null);
                          onOpenExplorer(project.path);
                          queueMicrotask(() => menuTrigger.current?.focus());
                        }}>Open in Explorer</button>
                        <button role="menuitem" onClick={() => {
                          setMenu(null);
                          setRenaming(project.path);
                        }}>Rename</button>
                        <button role="menuitem" onClick={() => {
                          setMenu(null);
                          onSetPinned(project.path, !project.pinned);
                          queueMicrotask(() => menuTrigger.current?.focus());
                        }}>{project.pinned ? "Unpin" : "Pin"}</button>
                        <button role="menuitem" className="danger" onClick={() => {
                          setMenu(null);
                          void onRemove(project.path).finally(() => queueMicrotask(() => panel.current
                            ?.querySelector<HTMLButtonElement>(".project-row")?.focus()));
                        }}>Remove from list</button>
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
