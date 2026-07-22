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
  X,
} from "lucide-react";
import { OcIcon } from "./OcIcon";
import type {
  DesktopProjectSummary,
  DesktopSessionSummary,
  DesktopUpdaterState,
} from "../shared/contract";
import { sessionSummaryTitle } from "../shared/session-title.mjs";

import type { NavigationSelection, WorkspaceTab } from "./nav-types";
import { avatarVariantFor, avatarInitials, sessionLabel, projectIdentity } from "./session-sidebar";

export interface ProjectSwitcherProps {
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

export function displayProject(path: string) {
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

export function cycleMenuFocus(event: KeyboardEvent<HTMLDivElement>) {
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

export function RenameProject({ initialValue, onCommit, onCancel }: {
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
