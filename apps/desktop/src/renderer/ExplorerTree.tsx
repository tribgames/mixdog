// ── Explorer tree ────────────────────────────────────────────────────────
// Behavioral grammar:
// - Inline create/rename input replacing the row label — Enter commits when
//   valid, Escape cancels, blur commits a valid value, live validation
//   bubble (error blocks, warning informs), rename pre-selects the basename
//   without its extension.
// - Name rules (empty/leading slash/duplicate/invalid chars/reserved device
//   names/trailing dot-space/255) with nested "a/b/c" creation segments.
// - Sort: directories first, numeric-aware compare; drop moves (Ctrl copies)
//   with the confirm dialog and a hover-expand on collapsed folders.
// - The active editor auto-reveals: its ancestors expand, the row scrolls
//   into view and becomes the selection without stealing keyboard focus.
import {
  ChevronDown,
  FilePlus,
  FolderPlus,
  ListCollapse,
  RefreshCw,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DesktopGitStatus } from "../shared/contract";
import {
  explorerTypeAheadIndex,
  sortExplorerEntries,
  validateExplorerName,
  wellFormedExplorerName,
} from "./explorer-logic";
import { t } from "./i18n";
import { scheduleEditorPanePrefetch } from "./lazy-widgets";
import { setiIconFor } from "./seti-icons";
import { copyTextToClipboard } from "./text-format";

interface DockDirEntry { name: string; dir: boolean }
interface DockDirState { entries?: DockDirEntry[]; expanded: boolean; error?: string }
interface ExplorerMenu { x: number; y: number; rel: string; parent: string; name: string; isDir: boolean; background?: boolean }
interface ExplorerRow {
  rel: string;
  name: string;
  dir: boolean;
  level: number;
  parentRel: string;
  expanded: boolean;
  error?: string;
}
interface ExplorerEdit {
  mode: "new-file" | "new-folder" | "rename";
  parentRel: string;
  rel: string;
  initial: string;
  dir: boolean;
}

const TYPE_AHEAD_RESET_MS = 700;
const DRAG_EXPAND_DELAY_MS = 500;

/** Seti file glyph (VS Code file icon theme; folders stay icon-less). */
export function SetiFileIcon({ name, className = "" }: { name: string; className?: string }) {
  const icon = setiIconFor(name);
  return <span className={className ? `seti-icon ${className}` : "seti-icon"}
    style={icon.color ? { color: icon.color } : undefined}
    aria-hidden="true">{icon.glyph}</span>;
}

export const FilesRootPane = memo(function FilesRootPane({
  projectPath,
  gitStatus,
  changed,
  activeFileKey,
  active,
  readinessKey,
  onReadyChange,
  onOpenFile,
  showRootHeader = false,
  rootLabel,
  headerSlot,
}: {
  projectPath: string;
  gitStatus: DesktopGitStatus | null;
  changed: Set<string>;
  activeFileKey: string;
  active: boolean;
  readinessKey: string;
  onReadyChange(key: string, ready: boolean): void;
  onOpenFile?(project: string, rel: string, mode?: "preview" | "pinned"): void;
  showRootHeader?: boolean;
  rootLabel?: string;
  headerSlot?: HTMLElement | null;
}) {
  const [dirs, setDirs] = useState<Map<string, DockDirState>>(() => new Map());
  const api = window.mixdogDesktop;
  // Files and Source Control consume the same project-scoped Git snapshot so
  // their decorations cannot drift after an SCM action.
  const { gitFiles, gitDirs } = useMemo(() => {
    const files = new Map<string, string>();
    const parents = new Set<string>();
    const status = gitStatus;
    if (!status?.repository) {
      return { gitFiles: files, gitDirs: parents };
    }
    for (const file of status.files || []) {
      const rel = String(file.path || "").replace(/\\/g, "/");
      if (!rel) continue;
      const badge = file.untracked ? "U"
        : (String(file.index || "").trim() || String(file.worktree || "").trim() || "M");
      files.set(rel, badge);
      let parent = rel;
      while (parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        parents.add(parent);
      }
    }
    return { gitFiles: files, gitDirs: parents };
  }, [gitStatus]);
  const gitClassOf = (badge?: string) => !badge ? ""
    : badge === "U" || badge === "A" || badge === "?" ? " git-added"
      : badge === "D" ? " git-deleted"
        : " git-modified";
  const patch = useCallback((rel: string, next: Partial<DockDirState>) => {
    setDirs((current) => {
      const map = new Map(current);
      map.set(rel, { expanded: false, ...map.get(rel), ...next });
      return map;
    });
  }, []);
  const load = useCallback((rel: string) => {
    patch(rel, { expanded: true, error: undefined });
    void api?.listProjectDir?.(projectPath, rel)
      .then((entries) => patch(rel, { entries: entries ?? [] }))
      .catch((reason) => patch(rel, { entries: [], error: reason instanceof Error ? reason.message : String(reason) }));
  }, [api, projectPath, patch]);
  // Selection / focus / clipboard state (VS Code multi-select list grammar).
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedRel, setFocusedRel] = useState("");
  const anchorRel = useRef("");
  const [editing, setEditing] = useState<ExplorerEdit | null>(null);
  const editingRef = useRef<ExplorerEdit | null>(null);
  editingRef.current = editing;
  const [editValue, setEditValue] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const editSelectionState = useRef<"prefix" | "all" | "suffix">("prefix");
  const [clipboard, setClipboard] = useState<{ rels: string[]; cut: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const dragRels = useRef<string[]>([]);
  const hoverExpandTimer = useRef(0);
  const typeAhead = useRef({ buffer: "", at: 0 });
  const parentOf = (rel: string) => rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  // The Dock retains every visited tab, so this effect must never rebuild the
  // tree for a surface the user is not looking at: an inactive Files pane keeps
  // its expansion and issues no listProjectDir. The signature defers the reset
  // + root listing to the moment the pane becomes active again, which is also
  // the moment a stale project would otherwise be visible.
  const loadedTreeSignature = useRef("");
  useEffect(() => {
    const signature = `${readinessKey}\u0000${projectPath}`;
    if (!active || loadedTreeSignature.current === signature) return undefined;
    loadedTreeSignature.current = signature;
    let live = true;
    onReadyChange(readinessKey, false);
    setDirs(new Map());
    setSelected(new Set());
    setFocusedRel("");
    setEditing(null);
    setClipboard(null);
    if (!projectPath) {
      onReadyChange(readinessKey, true);
      return () => { live = false; };
    }
    const rootRequest = api?.listProjectDir?.(projectPath, "");
    void Promise.resolve(rootRequest ?? [])
      .then((entries) => {
        if (live) setDirs(new Map([["", { expanded: true, entries: entries ?? [] }]]));
      })
      .catch((reason) => {
        if (live) setDirs(new Map([["", {
          expanded: true, entries: [],
          error: reason instanceof Error ? reason.message : String(reason),
        }]]));
      })
      .finally(() => {
        if (live) onReadyChange(readinessKey, true);
      });
    return () => { live = false; };
  }, [active, api, onReadyChange, projectPath, readinessKey]);
  // Refresh-button replacement: while the tree is visible, silently re-list
  // every expanded directory on a slow poll so agent/external edits appear
  // without manual action. Entries are swapped only when they actually differ.
  useEffect(() => {
    if (!active || !projectPath) return undefined;
    const timer = window.setInterval(() => {
      setDirs((current) => {
        for (const [rel, state] of current) {
          if (!state.expanded || !state.entries) continue;
          void api?.listProjectDir?.(projectPath, rel).then((entries) => {
            if (!entries) return;
            setDirs((latest) => {
              const existing = latest.get(rel);
              if (!existing?.entries || JSON.stringify(existing.entries) === JSON.stringify(entries)) return latest;
              const map = new Map(latest);
              map.set(rel, { ...existing, entries });
              return map;
            });
          }).catch(() => { /* dir removed — next expand reloads */ });
        }
        return current;
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [active, api, projectPath]);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTree = useCallback(async () => {
    if (!projectPath || refreshing) return;
    setRefreshing(true);
    const targets = [...dirs.entries()]
      .filter(([rel, state]) => rel === "" || state.expanded)
      .map(([rel]) => rel);
    try {
      const refreshed = await Promise.all(targets.map(async (rel) => {
        try {
          return { rel, entries: await Promise.resolve(api?.listProjectDir?.(projectPath, rel) ?? []) };
        } catch {
          return null;
        }
      }));
      setDirs((current) => {
        const next = new Map(current);
        for (const result of refreshed) {
          if (!result) continue;
          const existing = next.get(result.rel);
          if (existing) next.set(result.rel, { ...existing, entries: result.entries });
        }
        return next;
      });
    } finally {
      setRefreshing(false);
    }
  }, [api, dirs, projectPath, refreshing]);
  const canCollapseAll = [...dirs.entries()]
    .some(([rel, state]) => rel !== "" && state.expanded);
  const collapseAll = useCallback(() => {
    setDirs((current) => {
      let changedAny = false;
      const next = new Map(current);
      for (const [rel, state] of next) {
        if (rel === "" || !state.expanded) continue;
        next.set(rel, { ...state, expanded: false });
        changedAny = true;
      }
      return changedAny ? next : current;
    });
  }, []);
  const toggle = (rel: string) => {
    const state = dirs.get(rel);
    if (state?.expanded) patch(rel, { expanded: false });
    else if (state?.entries) patch(rel, { expanded: true });
    else load(rel);
  };
  const expandDir = (rel: string) => {
    if (!rel) return;
    const state = dirs.get(rel);
    if (state?.expanded) return;
    if (state?.entries) patch(rel, { expanded: true });
    else load(rel);
  };
  // Explorer-style right-click menu state. Declared BEFORE the empty-project
  // early return below: with hooks after that return, a projectPath flip
  // (pane focus swaps between draft/EMPTY and session snapshots) changed the
  // hook count mid-lifecycle and crashed the renderer into the recovery
  // screen (user report: "could not draw this view" kept appearing).
  const [menu, setMenu] = useState<ExplorerMenu | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menu) return undefined;
    // Keyboard users land ON the menu; closing hands focus back to the row
    // (same grammar as ScmContextMenu).
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() => menuRef.current
      ?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus());
    const close = () => setMenu(null);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The tree's own Escape handler (clear selection) must not fire on the
      // keystroke that only closed this menu.
      event.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    document.addEventListener("keydown", keydown, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      document.removeEventListener("keydown", keydown, true);
      if (previous?.isConnected) previous.focus?.();
    };
  }, [menu]);
  // renderInputBox: focus the inline editor and pre-select the basename
  // without its extension (rename of a file); create starts empty.
  useEffect(() => {
    if (!editing) return;
    const input = editInputRef.current;
    if (!input) return;
    editSelectionState.current = "prefix";
    input.focus();
    const value = editing.initial;
    const lastDot = value.lastIndexOf(".");
    const end = editing.mode === "rename" && !editing.dir && lastDot > 0 ? lastDot : value.length;
    try { input.setSelectionRange(0, end); } catch { /* jsdom */ }
  }, [editing]);
  // Flattened visible rows: the shared coordinate space for keyboard
  // navigation, shift ranges, type-ahead, and indent guides.
  const rows = useMemo(() => {
    const out: ExplorerRow[] = [];
    const walk = (rel: string, level: number) => {
      const state = dirs.get(rel);
      if (!state?.expanded) return;
      if (state.error) {
        out.push({ rel: `${rel}\u0000error`, name: state.error, dir: false, level, parentRel: rel, expanded: false, error: state.error });
        return;
      }
      if (!state.entries) return;
      for (const entry of sortExplorerEntries(state.entries)) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const expanded = entry.dir && dirs.get(childRel)?.expanded === true;
        out.push({ rel: childRel, name: entry.name, dir: entry.dir, level, parentRel: rel, expanded });
        if (entry.dir && expanded) walk(childRel, level + 1);
      }
    };
    walk("", 0);
    return out;
  }, [dirs]);
  const navRows = useMemo(() => rows.filter((row) => !row.error), [rows]);
  // Auto-reveal (explorerView.ts selectActiveFile): expand ancestors of the
  // active editor file step by step; each load/expand re-runs this effect
  // until the row exists, then select + scroll without stealing focus.
  const revealTarget = useRef("");
  useEffect(() => {
    if (!active || !projectPath) return;
    const prefix = `file:${projectPath}:`;
    if (!activeFileKey.startsWith(prefix)) return;
    const rel = activeFileKey.slice(prefix.length).replace(/\\/g, "/");
    if (rel) revealTarget.current = rel;
  }, [active, activeFileKey, projectPath]);
  useEffect(() => {
    const rel = revealTarget.current;
    if (!rel || !active || editingRef.current) return;
    const segments = rel.split("/");
    let cursor = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      cursor = cursor ? `${cursor}/${segments[index]}` : segments[index];
      const state = dirs.get(cursor);
      if (!state?.entries) {
        if (!state?.expanded) load(cursor);
        return;
      }
      if (state.error) { revealTarget.current = ""; return; }
      if (!state.expanded) { patch(cursor, { expanded: true }); return; }
    }
    revealTarget.current = "";
    anchorRel.current = rel;
    setSelected(new Set([rel]));
    setFocusedRel(rel);
    window.requestAnimationFrame(() => {
      rowEls.current.get(rel)?.scrollIntoView?.({ block: "nearest" });
    });
  }, [active, activeFileKey, dirs, load, patch]);
  if (!projectPath) return <p className="utility-dock-empty">{t("Open a project to browse its files.")}</p>;
  const openFile = (rel: string, mode: "preview" | "pinned" = "preview") => onOpenFile
    ? onOpenFile(projectPath, rel, mode)
    : void api?.openFilePath?.(projectPath, rel);
  const refreshDir = (rel: string) => {
    void api?.listProjectDir?.(projectPath, rel)
      .then((entries) => patch(rel, { entries: entries ?? [] }))
      .catch(() => { /* gone — collapsed on next interaction */ });
  };
  const absOf = (rel: string) => `${projectPath.replace(/[\\/]+$/, "")}/${rel}`;
  const menuAction = (action: () => void) => () => { setMenu(null); action(); };
  const focusRow = (rel: string, options?: { extend?: boolean; keepSelection?: boolean }) => {
    setFocusedRel(rel);
    if (options?.extend) {
      const anchor = anchorRel.current || rel;
      const from = navRows.findIndex((row) => row.rel === anchor);
      const to = navRows.findIndex((row) => row.rel === rel);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(new Set(navRows.slice(lo, hi + 1).map((row) => row.rel)));
      }
    } else if (!options?.keepSelection) {
      anchorRel.current = rel;
      setSelected(new Set([rel]));
    }
    const element = rowEls.current.get(rel);
    element?.focus?.({ preventScroll: true });
    element?.scrollIntoView?.({ block: "nearest" });
  };
  const beginRename = (rel: string, name: string, dir: boolean) => {
    setEditValue(name);
    setEditing({ mode: "rename", parentRel: parentOf(rel), rel, initial: name, dir });
  };
  const beginCreate = (dir: boolean, explicitParent?: string) => {
    const focusedRow = navRows.find((row) => row.rel === focusedRel);
    const parentRel = explicitParent !== undefined
      ? explicitParent
      : focusedRow ? (focusedRow.dir ? focusedRow.rel : focusedRow.parentRel) : "";
    expandDir(parentRel);
    if (!parentRel && showRootHeader) {
      const root = dirs.get("");
      if (root && !root.expanded) patch("", { expanded: true });
    }
    setEditValue("");
    setEditing({ mode: dir ? "new-folder" : "new-file", parentRel, rel: "", initial: "", dir });
  };
  const editProblem = editing ? validateExplorerName({
    name: editValue,
    originalName: editing.mode === "rename" ? editing.initial : "",
    siblings: (dirs.get(editing.parentRel)?.entries || []).map((entry) => entry.name),
    allowSegments: editing.mode !== "rename",
  }) : null;
  const cancelEdit = () => {
    editingRef.current = null;
    setEditing(null);
  };
  const commitEdit = () => {
    const edit = editingRef.current;
    if (!edit) return;
    const value = wellFormedExplorerName(editValue).trim();
    editingRef.current = null;
    setEditing(null);
    if (!value) return;
    if (edit.mode === "rename") {
      if (value === edit.initial) return;
      void api?.renameProjectEntry?.(projectPath, edit.rel, value)
        .then(() => {
          const nextRel = edit.parentRel ? `${edit.parentRel}/${value}` : value;
          anchorRel.current = nextRel;
          setSelected(new Set([nextRel]));
          setFocusedRel(nextRel);
        })
        .finally(() => refreshDir(edit.parentRel));
      return;
    }
    const dir = edit.mode === "new-folder";
    void api?.createProjectEntry?.(projectPath, edit.parentRel, value, dir)
      .then(() => {
        const segments = value.split(/[\\/]/).filter(Boolean);
        refreshDir(edit.parentRel);
        // Expand every folder a nested name created (the new entry reveals).
        let cursor = edit.parentRel;
        for (const segment of (dir ? segments : segments.slice(0, -1))) {
          cursor = cursor ? `${cursor}/${segment}` : segment;
          load(cursor);
        }
        const finalRel = [edit.parentRel, ...segments].filter(Boolean).join("/");
        anchorRel.current = finalRel;
        setSelected(new Set([finalRel]));
        setFocusedRel(finalRel);
        if (!dir) openFile(finalRel, "preview");
      })
      .catch(() => refreshDir(edit.parentRel));
  };
  const deleteSelection = () => {
    const rels = selected.size > 0 ? [...selected] : focusedRel ? [focusedRel] : [];
    if (rels.length === 0) return;
    const label = rels.length === 1 ? (rels[0].split("/").at(-1) || rels[0]) : `${rels.length} items`;
    if (!window.confirm(`Move ${label} to the Recycle Bin?`)) return;
    void Promise.allSettled(rels.map((rel) => Promise.resolve(api?.trashProjectEntry?.(projectPath, rel))))
      .then(() => {
        setSelected(new Set());
        setFocusedRel("");
        for (const parent of new Set(rels.map(parentOf))) refreshDir(parent);
      });
  };
  const stashClipboard = (cut: boolean) => {
    const rels = selected.size > 0 ? [...selected] : focusedRel ? [focusedRel] : [];
    if (rels.length) setClipboard({ rels, cut });
  };
  const pasteTargetRel = () => {
    const row = navRows.find((candidate) => candidate.rel === focusedRel);
    return row ? (row.dir ? row.rel : row.parentRel) : "";
  };
  const pasteClipboard = async (targetDirRel: string) => {
    if (!clipboard) return;
    const ops = clipboard.rels.filter((rel) =>
      targetDirRel !== rel && !targetDirRel.startsWith(`${rel}/`)
      && !(clipboard.cut && parentOf(rel) === targetDirRel));
    for (const rel of ops) {
      try {
        if (clipboard.cut) await api?.moveProjectEntry?.(projectPath, rel, targetDirRel);
        else await api?.copyProjectEntry?.(projectPath, rel, targetDirRel);
      } catch { /* collision/permission — the refresh below shows reality */ }
    }
    if (clipboard.cut) setClipboard(null);
    expandDir(targetDirRel);
    refreshDir(targetDirRel);
    for (const parent of new Set(ops.map(parentOf))) refreshDir(parent);
  };
  const clearHoverExpand = () => {
    if (hoverExpandTimer.current) {
      window.clearTimeout(hoverExpandTimer.current);
      hoverExpandTimer.current = 0;
    }
  };
  const performDrop = async (targetDirRel: string, copy: boolean) => {
    const rels = dragRels.current.filter((rel) =>
      targetDirRel !== rel && !targetDirRel.startsWith(`${rel}/`)
      && (copy || parentOf(rel) !== targetDirRel));
    dragRels.current = [];
    clearHoverExpand();
    setDropTarget(null);
    if (rels.length === 0) return;
    if (!copy) {
      // explorer.confirmDragAndDrop default: every DnD move asks once.
      const label = rels.length === 1
        ? `'${rels[0].split("/").at(-1)}'`
        : `the following ${rels.length} items`;
      if (!window.confirm(`Are you sure you want to move ${label}?`)) return;
    }
    for (const rel of rels) {
      try {
        if (copy) await api?.copyProjectEntry?.(projectPath, rel, targetDirRel);
        else await api?.moveProjectEntry?.(projectPath, rel, targetDirRel);
      } catch { /* name collision — surfaced by the refresh */ }
    }
    expandDir(targetDirRel);
    refreshDir(targetDirRel);
    for (const parent of new Set(rels.map(parentOf))) refreshDir(parent);
    setSelected(new Set());
  };
  const dragTargetDir = (row: ExplorerRow) => row.dir ? row.rel : row.parentRel;
  const onTreeKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).tagName === "INPUT") return;
    if (navRows.length === 0) return;
    const index = navRows.findIndex((row) => row.rel === focusedRel);
    const row = index >= 0 ? navRows[index] : undefined;
    const focusAt = (nextIndex: number, extend: boolean) => {
      const next = navRows[Math.max(0, Math.min(navRows.length - 1, nextIndex))];
      if (next) focusRow(next.rel, { extend });
    };
    if (event.key === "ArrowDown") { event.preventDefault(); focusAt(index + 1, event.shiftKey); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusAt(index < 0 ? 0 : index - 1, event.shiftKey); }
    else if (event.key === "Home") { event.preventDefault(); focusAt(0, event.shiftKey); }
    else if (event.key === "End") { event.preventDefault(); focusAt(navRows.length - 1, event.shiftKey); }
    else if (event.key === "ArrowRight" && row) {
      event.preventDefault();
      if (row.dir && !row.expanded) toggle(row.rel);
      else if (row.dir && row.expanded) focusAt(index + 1, false);
    } else if (event.key === "ArrowLeft" && row) {
      event.preventDefault();
      if (row.dir && row.expanded) patch(row.rel, { expanded: false });
      else if (row.parentRel) focusRow(row.parentRel);
    } else if ((event.key === "Enter" || event.key === " ") && row) {
      event.preventDefault();
      if (row.dir) toggle(row.rel);
      else openFile(row.rel, "preview");
    } else if (event.key === "F2" && row) {
      event.preventDefault();
      beginRename(row.rel, row.name, row.dir);
    } else if (event.key === "Delete") {
      event.preventDefault();
      deleteSelection();
    } else if (event.key === "Escape") {
      // list.clear: Escape empties the selection without moving focus.
      event.preventDefault();
      setSelected(new Set());
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      stashClipboard(false);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
      event.preventDefault();
      stashClipboard(true);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      event.preventDefault();
      void pasteClipboard(pasteTargetRel());
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelected(new Set(navRows.map((candidate) => candidate.rel)));
    } else if (event.key.toLowerCase() === "c" && event.shiftKey && event.altKey
      && !event.ctrlKey && !event.metaKey) {
      // VS Code copyFilePath (Shift+Alt+C): absolute paths of the selection.
      event.preventDefault();
      const rels = selected.size > 0 ? [...selected] : focusedRel ? [focusedRel] : [];
      if (rels.length) void copyTextToClipboard(rels.map(absOf).join("\n"));
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && /\S/.test(event.key)) {
      const now = performance.now();
      const state = typeAhead.current;
      state.buffer = now - state.at > TYPE_AHEAD_RESET_MS ? event.key : state.buffer + event.key;
      state.at = now;
      const next = explorerTypeAheadIndex(navRows.map((candidate) => candidate.name), Math.max(0, index), state.buffer);
      if (next >= 0) focusRow(navRows[next].rel);
    }
  };
  const rootName = projectPath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || projectPath;
  const rootExpanded = dirs.get("")?.expanded === true;
  const rootVisible = !showRootHeader || rootExpanded;
  const headerPortal = headerSlot ? createPortal(<>
    <button type="button" aria-label={t("New file")} data-tooltip={t("New File…")}
      onClick={() => beginCreate(false)}>
      <FilePlus size={16} aria-hidden="true" />
    </button>
    <button type="button" aria-label={t("New folder")} data-tooltip={t("New Folder…")}
      onClick={() => beginCreate(true)}>
      <FolderPlus size={16} aria-hidden="true" />
    </button>
    <button type="button" aria-label={t("Refresh files")} data-tooltip={t("Refresh Explorer")}
      disabled={refreshing} onClick={() => void refreshTree()}>
      <RefreshCw size={16} className={refreshing ? "spin" : undefined} aria-hidden="true" />
    </button>
    <button type="button" aria-label={t("Collapse all folders")} data-tooltip={t("Collapse All")}
      disabled={!canCollapseAll} onClick={collapseAll}>
      <ListCollapse size={16} aria-hidden="true" />
    </button>
  </>, headerSlot) : null;
  const editRowNode = (level: number): ReactNode => {
    if (!editing) return null;
    const editDir = editing.mode === "new-folder" || (editing.mode === "rename" && editing.dir);
    return <div key="explorer-edit" className="dock-file-row explorer-edit-row"
      style={{ paddingLeft: `calc(var(--mx-explorer-inset, 12px) + ${level * 8}px)` }}>
      <span className="explorer-twistie" aria-hidden="true" />
      {/* renderInputBox updates the icon live while the user types. */}
      {!editDir && <SetiFileIcon name={editValue || "file"} className="dock-file-icon" />}
      <span className="explorer-edit-box" data-problem={editProblem?.severity || undefined}>
        <input ref={editInputRef} value={editValue} spellCheck={false}
          aria-label={t("Type file name. Press Enter to confirm or Escape to cancel.")}
          onChange={(event) => setEditValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "F2" && editing.mode === "rename" && !editing.dir) {
              const input = event.currentTarget;
              const dotIndex = input.value.lastIndexOf(".");
              if (dotIndex === -1) return;
              event.preventDefault();
              if (editSelectionState.current === "prefix") {
                editSelectionState.current = "all";
                input.setSelectionRange(0, input.value.length);
              } else if (editSelectionState.current === "all") {
                editSelectionState.current = "suffix";
                input.setSelectionRange(dotIndex + 1, input.value.length);
              } else {
                editSelectionState.current = "prefix";
                input.setSelectionRange(0, dotIndex);
              }
            } else if (event.key === "Enter") {
              if (editProblem?.severity === "error") return;
              commitEdit();
            } else if (event.key === "Escape") {
              cancelEdit();
            }
          }}
          onBlur={() => {
            if (!editingRef.current) return;
            if (editProblem?.severity === "error") cancelEdit();
            else commitEdit();
          }} />
        {editProblem && <span className={`explorer-edit-message ${editProblem.severity}`} role="alert">
          {editProblem.content}
        </span>}
      </span>
    </div>;
  };
  const firstFocusableRel = focusedRel || navRows[0]?.rel || "";
  const rowNode = (row: ExplorerRow): ReactNode => {
    if (row.error) return <p key={row.rel} className="utility-dock-empty">{row.error}</p>;
    const badge = row.dir ? undefined : gitFiles.get(row.rel);
    const isSelected = selected.has(row.rel);
    const isCut = Boolean(clipboard?.cut && clipboard.rels.includes(row.rel));
    let className = "dock-file-row";
    if (!row.dir) className += ` is-file${gitClassOf(badge)}`;
    if (row.dir && gitDirs.has(row.rel)) className += " git-dir-changed";
    if (isSelected) className += " explorer-selected";
    if (focusedRel === row.rel) className += " explorer-focused";
    if (isCut) className += " explorer-cut";
    if (dropTarget !== null && row.dir && row.rel === dropTarget) className += " explorer-drop-target";
    // Indent guides: the CSS rule paints one hairline per ancestor level and
    // only needs the covered width (VS Code renderIndentGuides "onHover").
    const guides = row.level > 0
      ? { "--guide-size": `${row.level * 8}px 100%` } as React.CSSProperties
      : undefined;
    return <button type="button" key={row.rel} role="treeitem"
      aria-level={row.level + 1}
      aria-expanded={row.dir ? row.expanded : undefined}
      aria-selected={isSelected}
      title={row.dir ? undefined : row.rel}
      tabIndex={firstFocusableRel === row.rel ? 0 : -1}
      data-guides={row.level > 0 ? "true" : undefined}
      ref={(element) => {
        if (element) rowEls.current.set(row.rel, element);
        else rowEls.current.delete(row.rel);
      }}
      className={className}
      style={{ paddingLeft: `calc(var(--mx-explorer-inset, 12px) + ${row.level * 8}px)`, ...guides }}
      draggable
      onDragStart={(event) => {
        const rels = selected.has(row.rel) ? [...selected] : [row.rel];
        if (!selected.has(row.rel)) {
          anchorRel.current = row.rel;
          setSelected(new Set([row.rel]));
          setFocusedRel(row.rel);
        }
        dragRels.current = rels;
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData("text/plain", rels.join("\n"));
        if (rels.length > 1) {
          // VS Code multi-drag feedback: an "N items" badge replaces the
          // default row snapshot as the drag image.
          const ghost = document.createElement("div");
          ghost.className = "explorer-drag-badge";
          ghost.textContent = `${rels.length} items`;
          document.body.appendChild(ghost);
          try { event.dataTransfer.setDragImage(ghost, 0, 0); } catch { /* jsdom */ }
          window.setTimeout(() => ghost.remove(), 0);
        }
      }}
      onDragOver={(event) => {
        if (dragRels.current.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = (event.ctrlKey || event.altKey) ? "copy" : "move";
        const target = dragTargetDir(row);
        if (dropTarget !== target) {
          clearHoverExpand();
          setDropTarget(target);
          if (row.dir && !row.expanded) {
            hoverExpandTimer.current = window.setTimeout(() => expandDir(row.rel), DRAG_EXPAND_DELAY_MS);
          }
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void performDrop(dragTargetDir(row), event.ctrlKey || event.altKey);
      }}
      onDragEnd={() => {
        dragRels.current = [];
        clearHoverExpand();
        setDropTarget(null);
      }}
      onPointerEnter={row.dir ? undefined : scheduleEditorPanePrefetch}
      onFocus={row.dir ? undefined : scheduleEditorPanePrefetch}
      onClick={(event) => {
        if (event.ctrlKey || event.metaKey) {
          anchorRel.current = row.rel;
          setFocusedRel(row.rel);
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(row.rel)) next.delete(row.rel);
            else next.add(row.rel);
            return next;
          });
          return;
        }
        if (event.shiftKey) {
          focusRow(row.rel, { extend: true });
          return;
        }
        anchorRel.current = row.rel;
        setSelected(new Set([row.rel]));
        setFocusedRel(row.rel);
        if (row.dir) toggle(row.rel);
        else openFile(row.rel, "preview");
      }}
      onDoubleClick={row.dir ? undefined : () => openFile(row.rel, "pinned")}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!selected.has(row.rel)) {
          anchorRel.current = row.rel;
          setSelected(new Set([row.rel]));
        }
        setFocusedRel(row.rel);
        setMenu({ x: event.clientX, y: event.clientY, rel: row.rel, parent: row.parentRel, name: row.name, isDir: row.dir });
      }}>
      {/* 16px twistie column on EVERY row (monaco-tl-twistie): files reserve
          the space too, so labels align per depth; the chevron rotates. */}
      <span className={`explorer-twistie${row.dir && !row.expanded ? " collapsed" : ""}`} aria-hidden="true">
        {row.dir && <ChevronDown size={14} />}
      </span>
      {/* Seti grammar: folders carry only the twistie, files a themed glyph. */}
      {!row.dir && <SetiFileIcon name={row.name} className="dock-file-icon" />}
      <span>{row.name}</span>
      {row.dir
        ? (gitDirs.has(row.rel) && <i className="dock-file-changed" aria-hidden="true" />)
        : (badge
          ? <em className="dock-file-badge" aria-label={t("Git status {{badge}}", { badge })}>{badge}</em>
          : changed.has(row.rel) && <i className="dock-file-changed" aria-hidden="true" />)}
    </button>;
  };
  const treeItems: ReactNode[] = [];
  if (editing && editing.mode !== "rename" && editing.parentRel === "" && rootVisible) {
    treeItems.push(editRowNode(0));
  }
  for (const row of rows) {
    if (editing?.mode === "rename" && row.rel === editing.rel) {
      treeItems.push(editRowNode(row.level));
      continue;
    }
    treeItems.push(rowNode(row));
    if (editing && editing.mode !== "rename" && row.dir && row.expanded && row.rel === editing.parentRel) {
      treeItems.push(editRowNode(row.level + 1));
    }
  }
  const rootEntriesEmpty = (dirs.get("")?.entries?.length ?? -1) === 0 && !dirs.get("")?.error;
  return <>{headerPortal}<div className="dock-files">
    {showRootHeader && <div className="workbench-explorer-root-row">
      <button type="button" className="workbench-explorer-root"
        aria-expanded={rootExpanded} onClick={() => toggle("")}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, rel: "", parent: "", name: "", isDir: true, background: true });
        }}>
        {/* Same rotating twistie as the rows (monaco tree chevron). */}
        <span className={`explorer-twistie${rootExpanded ? "" : " collapsed"}`} aria-hidden="true">
          <ChevronDown size={14} />
        </span>
        <span title={projectPath}>{rootLabel || rootName}</span>
      </button>
      {/* "Remove from workspace" dropped with the multi-root concept. */}
    </div>}
    <div className={`dock-files-tree${dropTarget === "" ? " explorer-drop-root" : ""}`}
      role="tree" tabIndex={-1}
      onKeyDown={onTreeKeyDown}
      onDoubleClick={(event) => {
        if (event.target === event.currentTarget && !editingRef.current) beginCreate(false);
      }}
      onContextMenu={(event) => {
        // Background right-click (VS Code: New File / New Folder / Paste on
        // empty space). Rows preventDefault first, so they are excluded here.
        if (event.defaultPrevented) return;
        if ((event.target as HTMLElement).closest?.(".explorer-edit-box")) return;
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY, rel: "", parent: "", name: "", isDir: true, background: true });
      }}
      onDragOver={(event) => {
        if (dragRels.current.length === 0) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = (event.ctrlKey || event.altKey) ? "copy" : "move";
        if (dropTarget !== "") {
          clearHoverExpand();
          setDropTarget("");
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        void performDrop("", event.ctrlKey || event.altKey);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDropTarget(null);
      }}>
      {rootVisible && treeItems}
      {rootVisible && rows.length === 0 && !editing && rootEntriesEmpty
        && <p className="utility-dock-empty">{t("Empty folder.")}</p>}
    </div>
    {menu && (() => {
      const multi = !menu.background && selected.size > 1 && selected.has(menu.rel);
      const pasteTarget = menu.background ? "" : menu.isDir ? menu.rel : menu.parent;
      const copyRels = multi ? [...selected] : [menu.rel];
      const item = (label: string, onClick: () => void,
        options?: { hint?: string; danger?: boolean; disabled?: boolean }) =>
        <button type="button" role="menuitem" key={label}
          className={options?.danger ? "danger" : undefined}
          disabled={options?.disabled}
          onClick={menuAction(onClick)}>
          <span>{t(label)}</span>
          {options?.hint && <span className="dock-file-menu-key">{options.hint}</span>}
        </button>;
      const sep = (id: string) => <hr key={id} className="dock-file-menu-sep" aria-hidden="true" />;
      return <div className="dock-file-menu" role="menu"
        style={{ left: menu.x, top: menu.y }}
        ref={(element) => {
          menuRef.current = element;
          // Clamp into the viewport: near the bottom/right edge the menu
          // flips inward instead of clipping off-screen.
          if (!element) return;
          const rect = element.getBoundingClientRect();
          element.style.left = `${Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4))}px`;
          element.style.top = `${Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4))}px`;
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          const entries = [...event.currentTarget
            .querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)")];
          if (!entries.length) return;
          const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
          let next = -1;
          if (event.key === "ArrowDown") next = (current + 1) % entries.length;
          else if (event.key === "ArrowUp") next = (current - 1 + entries.length) % entries.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = entries.length - 1;
          else if (event.key === "Tab") { setMenu(null); return; }
          else return;
          event.preventDefault();
          entries[next]?.focus();
        }}>
        {menu.background ? <>
          {item("New file…", () => beginCreate(false, ""))}
          {item("New folder…", () => beginCreate(true, ""))}
          {sep("bg-clipboard")}
          {item("Paste", () => void pasteClipboard(""), { hint: "Ctrl+V", disabled: !clipboard })}
          {sep("bg-path")}
          {item("Reveal in Explorer", () => void api?.revealFile?.(projectPath, ""))}
          {item("Copy path", () => void copyTextToClipboard(projectPath))}
        </> : <>
          {!multi && !menu.isDir && item("Open", () => openFile(menu.rel))}
          {!multi && !menu.isDir && item("Open in default app", () => void api?.openFilePath?.(projectPath, menu.rel))}
          {!multi && menu.isDir && item("New file…", () => beginCreate(false, menu.rel))}
          {!multi && menu.isDir && item("New folder…", () => beginCreate(true, menu.rel))}
          {!multi && sep("row-open")}
          {item("Cut", () => stashClipboard(true), { hint: "Ctrl+X" })}
          {item("Copy", () => stashClipboard(false), { hint: "Ctrl+C" })}
          {!multi && item("Paste", () => void pasteClipboard(pasteTarget), { hint: "Ctrl+V", disabled: !clipboard })}
          {sep("row-clipboard")}
          {!multi && item("Reveal in Explorer", () => void api?.revealFile?.(projectPath, menu.rel))}
          {item("Copy path", () => void copyTextToClipboard(copyRels.map(absOf).join("\n")), { hint: "Shift+Alt+C" })}
          {item("Copy relative path", () => void copyTextToClipboard(copyRels.join("\n")))}
          {sep("row-path")}
          {!multi && item("Rename…", () => beginRename(menu.rel, menu.name, menu.isDir), { hint: "F2" })}
          {item(multi ? `Delete ${selected.size} items` : "Delete", deleteSelection, { hint: "Del", danger: true })}
        </>}
      </div>;
    })()}
  </div></>;
});
