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
// This file owns selection, keyboard, drag and menu behaviour. Folder listing,
// expansion and refresh live in explorer-dir-state; the file operations behind
// delete/paste/drop live in explorer-mutations; the tree shape and its path
// grammar in explorer-tree-model; the inline input row in explorer-edit-row.
import { ChevronDown, FilePlus, FolderPlus, ListCollapse, RefreshCw } from 'lucide-react';
import React, { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DesktopGitStatus } from '../shared/contract';
import { explorerTypeAheadIndex, validateExplorerName, wellFormedExplorerName } from './explorer-logic';
import { useExplorerDirs } from './explorer-dir-state';
import { ExplorerEditRow, type ExplorerEdit } from './explorer-edit-row';
import {
  explorerCreatedEntry,
  explorerErrorText,
  explorerTransferRels,
  transferExplorerEntries,
  trashExplorerEntries,
} from './explorer-mutations';
import { explorerAbsolutePath, explorerParentRel, explorerRevealStep, type ExplorerRow } from './explorer-tree-model';
import { COMPOSER_PROJECT_PATHS_MIME } from './composer-support';
import { t } from './i18n';
import { ErrorNotice } from './ErrorNotice';
import { useMobileBack } from './mobile-back';
import { scheduleEditorPanePrefetch } from './lazy-widgets';
import { SetiFileIcon } from './SetiFileIcon';
import { useSurfaceActive } from './surface-activity';
import { copyTextToClipboard } from './text-format';

interface ExplorerMenu {
  x: number;
  y: number;
  rel: string;
  parent: string;
  name: string;
  isDir: boolean;
  background?: boolean;
}

const TYPE_AHEAD_RESET_MS = 700;
const DRAG_EXPAND_DELAY_MS = 500;

export { SetiFileIcon };

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
  onOpenFile?(project: string, rel: string, mode?: 'preview' | 'pinned'): void;
  showRootHeader?: boolean;
  rootLabel?: string;
  headerSlot?: HTMLElement | null;
}) {
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
      const rel = String(file.path || '').replace(/\\/g, '/');
      if (!rel) continue;
      const badge = file.untracked ? 'U' : String(file.index || '').trim() || String(file.worktree || '').trim() || 'M';
      files.set(rel, badge);
      let parent = rel;
      while (parent.includes('/')) {
        parent = parent.slice(0, parent.lastIndexOf('/'));
        parents.add(parent);
      }
    }
    return { gitFiles: files, gitDirs: parents };
  }, [gitStatus]);
  const gitClassOf = (badge?: string) => {
    if (!badge) return '';
    if (badge === 'U' || badge === 'A' || badge === '?') return ' git-added';
    return badge === 'D' ? ' git-deleted' : ' git-modified';
  };
  // Selection, focus, and clipboard state for the multi-select list.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedRel, setFocusedRel] = useState('');
  const anchorRel = useRef('');
  const [editing, setEditing] = useState<ExplorerEdit | null>(null);
  const editingRef = useRef<ExplorerEdit | null>(null);
  editingRef.current = editing;
  const [editValue, setEditValue] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [clipboard, setClipboard] = useState<{ rels: string[]; cut: boolean } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rowEls = useRef(new Map<string, HTMLButtonElement>());
  const dragRels = useRef<string[]>([]);
  const hoverExpandTimer = useRef(0);
  const typeAhead = useRef({ buffer: '', at: 0 });
  // Folder listing, expansion and refresh live in their own state module; the
  // pane drives them and adds the selection/mutation grammar on top.
  const {
    dirs,
    rows,
    navRows,
    refreshing,
    canCollapseAll,
    patch,
    load,
    toggle,
    expandDir,
    refreshDir,
    refreshTree,
    collapseAll,
  } = useExplorerDirs({
    api,
    projectPath,
    active,
    readinessKey,
    onReadyChange,
    onProjectReset: () => {
      setSelected(new Set());
      setFocusedRel('');
      setEditing(null);
      setClipboard(null);
      setMutationError('');
    },
  });
  /** Single-row selection: range anchor, selection and focus land together. */
  const selectOnly = (rel: string) => {
    anchorRel.current = rel;
    setSelected(new Set([rel]));
    setFocusedRel(rel);
  };
  /** What an action addresses: the selection, or the focused row alone. */
  const selectionRels = () => {
    if (selected.size > 0) return [...selected];
    return focusedRel ? [focusedRel] : [];
  };
  // Explorer-style right-click menu state. Declared BEFORE the empty-project
  // early return below: with hooks after that return, a projectPath flip
  // (pane focus swaps between draft/EMPTY and session snapshots) changed the
  // hook count mid-lifecycle and crashed the renderer into the recovery
  // screen (user report: "could not draw this view" kept appearing).
  const [menu, setMenu] = useState<ExplorerMenu | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // The menu escapes the clipping Dock through a body portal. Retained tabs
  // stay mounted, so their active signal must hide and clear that portal when
  // the user switches views.
  const surfaceActive = useSurfaceActive();
  const visibleMenu = surfaceActive ? menu : null;
  useEffect(() => {
    if (!surfaceActive && menu) setMenu(null);
  }, [menu, surfaceActive]);
  useEffect(() => {
    if (!visibleMenu) return undefined;
    // Keyboard users land ON the menu; closing hands focus back to the row
    // (same grammar as ScmContextMenu).
    const previous = document.activeElement as HTMLElement | null;
    queueMicrotask(() =>
      menuRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']:not(:disabled)")?.focus()
    );
    const close = () => setMenu(null);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // The tree's own Escape handler (clear selection) must not fire on the
      // keystroke that only closed this menu.
      event.stopPropagation();
      close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    document.addEventListener('keydown', keydown, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('keydown', keydown, true);
      if (previous?.isConnected) previous.focus?.();
    };
  }, [visibleMenu]);
  // ABB: hardware back closes the menu instead of leaving the PWA.
  useMobileBack(Boolean(visibleMenu), () => setMenu(null));
  // Auto-reveal: expand ancestors of the
  // active editor file step by step; each load/expand re-runs this effect
  // until the row exists, then select + scroll without stealing focus.
  const revealTarget = useRef('');
  useEffect(() => {
    if (!active || !projectPath) return;
    const prefix = `file:${projectPath}:`;
    if (!activeFileKey.startsWith(prefix)) return;
    const rel = activeFileKey.slice(prefix.length).replace(/\\/g, '/');
    if (rel) revealTarget.current = rel;
  }, [active, activeFileKey, projectPath]);
  useEffect(() => {
    const rel = revealTarget.current;
    if (!rel || !active || editingRef.current) return;
    const step = explorerRevealStep(dirs, rel);
    if (step.kind === 'load') {
      load(step.rel);
      return;
    }
    if (step.kind === 'expand') {
      patch(step.rel, { expanded: true });
      return;
    }
    if (step.kind === 'pending') return;
    // Ready or abandoned: either way this target is done steering the tree.
    revealTarget.current = '';
    if (step.kind === 'blocked') return;
    selectOnly(rel);
    window.requestAnimationFrame(() => {
      rowEls.current.get(rel)?.scrollIntoView?.({ block: 'nearest' });
    });
  }, [active, activeFileKey, dirs, load, patch]);
  if (!projectPath) return <p className="utility-dock-empty">{t('Open a project to browse its files.')}</p>;
  const openFile = (rel: string, mode: 'preview' | 'pinned' = 'preview') =>
    onOpenFile ? onOpenFile(projectPath, rel, mode) : void api?.openFilePath?.(projectPath, rel);
  const absOf = (rel: string) => explorerAbsolutePath(projectPath, rel);
  const menuAction = (action: () => void) => () => {
    setMenu(null);
    action();
  };
  const focusRow = (rel: string, options?: { extend?: boolean; keepSelection?: boolean }) => {
    if (options?.extend) {
      setFocusedRel(rel);
      const anchor = anchorRel.current || rel;
      const from = navRows.findIndex((row) => row.rel === anchor);
      const to = navRows.findIndex((row) => row.rel === rel);
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelected(new Set(navRows.slice(lo, hi + 1).map((row) => row.rel)));
      }
    } else if (options?.keepSelection) setFocusedRel(rel);
    else selectOnly(rel);
    const element = rowEls.current.get(rel);
    element?.focus?.({ preventScroll: true });
    element?.scrollIntoView?.({ block: 'nearest' });
  };
  const beginRename = (rel: string, name: string, dir: boolean) => {
    setEditValue(name);
    setEditing({ mode: 'rename', parentRel: explorerParentRel(rel), rel, initial: name, dir });
  };
  /** Directory a row addresses: itself for folders, its parent for files. */
  const rowDirRel = (row: (typeof navRows)[number] | undefined) => {
    if (!row) return '';
    return row.dir ? row.rel : row.parentRel;
  };
  const beginCreate = (dir: boolean, explicitParent?: string) => {
    const focusedRow = navRows.find((row) => row.rel === focusedRel);
    const parentRel = explicitParent !== undefined ? explicitParent : rowDirRel(focusedRow);
    expandDir(parentRel);
    if (!parentRel && showRootHeader) {
      const root = dirs.get('');
      if (root && !root.expanded) patch('', { expanded: true });
    }
    setEditValue('');
    setEditing({ mode: dir ? 'new-folder' : 'new-file', parentRel, rel: '', initial: '', dir });
  };
  const editOriginalName = editing?.mode === 'rename' ? editing.initial : '';
  const editProblem = editing
    ? validateExplorerName({
        name: editValue,
        originalName: editOriginalName,
        siblings: (dirs.get(editing.parentRel)?.entries || []).map((entry) => entry.name),
        allowSegments: editing.mode !== 'rename',
      })
    : null;
  const cancelEdit = () => {
    if (!editingRef.current) return;
    editingRef.current = null;
    setEditing(null);
  };
  /** Re-list the folders a mutation touched: its target and every source parent. */
  const refreshParentsOf = (rels: readonly string[]) => {
    for (const parent of new Set(rels.map(explorerParentRel))) refreshDir(parent);
  };
  const commitEdit = () => {
    const edit = editingRef.current;
    if (!edit) return;
    const value = wellFormedExplorerName(editValue).trim();
    editingRef.current = null;
    setEditing(null);
    if (!value) return;
    setMutationError('');
    if (edit.mode === 'rename') {
      if (value === edit.initial) return;
      void api
        ?.renameProjectEntry?.(projectPath, edit.rel, value)
        .then(() => selectOnly(edit.parentRel ? `${edit.parentRel}/${value}` : value))
        .catch((reason) => setMutationError(explorerErrorText(reason)))
        .finally(() => refreshDir(edit.parentRel));
      return;
    }
    const dir = edit.mode === 'new-folder';
    void api
      ?.createProjectEntry?.(projectPath, edit.parentRel, value, dir)
      .then(() => {
        const created = explorerCreatedEntry(edit.parentRel, value, dir);
        refreshDir(edit.parentRel);
        // Expand every folder a nested name created (the new entry reveals).
        for (const folderRel of created.expandRels) load(folderRel);
        selectOnly(created.finalRel);
        if (!dir) openFile(created.finalRel, 'preview');
      })
      .catch((reason) => {
        setMutationError(explorerErrorText(reason));
        refreshDir(edit.parentRel);
      });
  };
  const deleteSelection = () => {
    const rels = selectionRels();
    if (rels.length === 0) return;
    const label =
      rels.length === 1 ? rels[0].split('/').at(-1) || rels[0] : t('{{count}} items', { count: rels.length });
    if (!window.confirm(t('Move {{name}} to the Recycle Bin?', { name: label }))) return;
    setMutationError('');
    void trashExplorerEntries({ api, projectPath, rels }).then(({ failed, firstError }) => {
      // Only what survived the delete stays selected, ready for a retry.
      setSelected(new Set(failed));
      setFocusedRel(failed[0] || '');
      if (firstError !== undefined) setMutationError(explorerErrorText(firstError));
      refreshParentsOf(rels);
    });
  };
  const stashClipboard = (cut: boolean) => {
    const rels = selectionRels();
    if (rels.length) setClipboard({ rels, cut });
  };
  const pasteTargetRel = () => rowDirRel(navRows.find((candidate) => candidate.rel === focusedRel));
  /** After a copy/move: reveal the destination and re-list both sides. */
  const settleTransfer = (targetDirRel: string, rels: readonly string[]) => {
    expandDir(targetDirRel);
    refreshDir(targetDirRel);
    refreshParentsOf(rels);
  };
  const pasteClipboard = async (targetDirRel: string) => {
    if (!clipboard) return;
    setMutationError('');
    const copy = !clipboard.cut;
    const ops = explorerTransferRels(clipboard.rels, targetDirRel, copy);
    const { failed, firstError } = await transferExplorerEntries({
      api,
      projectPath,
      rels: ops,
      targetDirRel,
      copy,
    });
    // A cut is consumed by its paste; entries that could not move stay cut so
    // the next paste retries exactly them.
    if (clipboard.cut) setClipboard(failed.length ? { rels: failed, cut: true } : null);
    if (firstError !== undefined) setMutationError(explorerErrorText(firstError));
    settleTransfer(targetDirRel, ops);
  };
  const clearHoverExpand = () => {
    if (hoverExpandTimer.current) {
      window.clearTimeout(hoverExpandTimer.current);
      hoverExpandTimer.current = 0;
    }
  };
  const performDrop = async (targetDirRel: string, copy: boolean) => {
    const rels = explorerTransferRels(dragRels.current, targetDirRel, copy);
    dragRels.current = [];
    clearHoverExpand();
    setDropTarget(null);
    if (rels.length === 0) return;
    setMutationError('');
    if (!copy) {
      // explorer.confirmDragAndDrop default: every DnD move asks once.
      const label =
        rels.length === 1
          ? `'${rels[0].split('/').at(-1)}'`
          : t('the following {{count}} items', { count: rels.length });
      if (!window.confirm(t('Are you sure you want to move {{name}}?', { name: label }))) return;
    }
    const { failed, firstError } = await transferExplorerEntries({
      api,
      projectPath,
      rels,
      targetDirRel,
      copy,
    });
    settleTransfer(targetDirRel, rels);
    // Whatever failed to land stays selected where it still is.
    setSelected(new Set(failed));
    setFocusedRel(failed[0] || '');
    if (firstError !== undefined) setMutationError(explorerErrorText(firstError));
  };
  const dragTargetDir = (row: ExplorerRow) => (row.dir ? row.rel : row.parentRel);
  const onTreeKeyDown = (event: React.KeyboardEvent) => {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    if (navRows.length === 0) return;
    const index = navRows.findIndex((row) => row.rel === focusedRel);
    const row = index >= 0 ? navRows[index] : undefined;
    const focusAt = (nextIndex: number, extend: boolean) => {
      const next = navRows[Math.max(0, Math.min(navRows.length - 1, nextIndex))];
      if (next) focusRow(next.rel, { extend });
    };
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusAt(index + 1, event.shiftKey);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusAt(index < 0 ? 0 : index - 1, event.shiftKey);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAt(0, event.shiftKey);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAt(navRows.length - 1, event.shiftKey);
    } else if (event.key === 'ArrowRight' && row) {
      event.preventDefault();
      if (row.dir && !row.expanded) toggle(row.rel);
      else if (row.dir && row.expanded) focusAt(index + 1, false);
    } else if (event.key === 'ArrowLeft' && row) {
      event.preventDefault();
      if (row.dir && row.expanded) patch(row.rel, { expanded: false });
      else if (row.parentRel) focusRow(row.parentRel);
    } else if ((event.key === 'Enter' || event.key === ' ') && row) {
      event.preventDefault();
      if (row.dir) toggle(row.rel);
      else openFile(row.rel, 'preview');
    } else if (event.key === 'F2' && row) {
      event.preventDefault();
      beginRename(row.rel, row.name, row.dir);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      deleteSelection();
    } else if (event.key === 'Escape') {
      // list.clear: Escape empties the selection without moving focus.
      event.preventDefault();
      setSelected(new Set());
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      stashClipboard(false);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x') {
      event.preventDefault();
      stashClipboard(true);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      void pasteClipboard(pasteTargetRel());
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      setSelected(new Set(navRows.map((candidate) => candidate.rel)));
    } else if (event.key.toLowerCase() === 'c' && event.shiftKey && event.altKey && !event.ctrlKey && !event.metaKey) {
      // Copy file path (Shift+Alt+C): absolute paths of the selection.
      event.preventDefault();
      const rels = selectionRels();
      if (rels.length) void copyTextToClipboard(rels.map(absOf).join('\n'));
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && /\S/.test(event.key)) {
      const now = performance.now();
      const state = typeAhead.current;
      state.buffer = now - state.at > TYPE_AHEAD_RESET_MS ? event.key : state.buffer + event.key;
      state.at = now;
      const next = explorerTypeAheadIndex(
        navRows.map((candidate) => candidate.name),
        Math.max(0, index),
        state.buffer
      );
      if (next >= 0) focusRow(navRows[next].rel);
    }
  };
  const rootName =
    projectPath
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || projectPath;
  const rootExpanded = dirs.get('')?.expanded === true;
  const rootVisible = !showRootHeader || rootExpanded;
  const headerPortal =
    headerSlot &&
    createPortal(
      <>
        <button
          type="button"
          aria-label={t('New file')}
          data-tooltip={t('New File…')}
          onClick={() => beginCreate(false)}
        >
          <FilePlus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t('New folder')}
          data-tooltip={t('New Folder…')}
          onClick={() => beginCreate(true)}
        >
          <FolderPlus size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t('Refresh files')}
          data-tooltip={t('Refresh Explorer')}
          disabled={refreshing}
          onClick={() => void refreshTree()}
        >
          <RefreshCw size={16} className={refreshing ? 'spin' : undefined} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={t('Collapse all folders')}
          data-tooltip={t('Collapse All')}
          disabled={!canCollapseAll}
          onClick={collapseAll}
        >
          <ListCollapse size={16} aria-hidden="true" />
        </button>
      </>,
      headerSlot
    );
  const editRowNode = (level: number): ReactNode =>
    editing ? (
      <ExplorerEditRow
        key="explorer-edit"
        edit={editing}
        value={editValue}
        problem={editProblem}
        level={level}
        onChange={setEditValue}
        onCommit={commitEdit}
        onCancel={cancelEdit}
      />
    ) : null;
  const firstFocusableRel = focusedRel || navRows[0]?.rel || '';
  const rowNode = (row: ExplorerRow): ReactNode => {
    if (row.error) return <ErrorNotice key={row.rel} error={row.error} role="status" />;
    const badge = row.dir ? undefined : gitFiles.get(row.rel);
    const isSelected = selected.has(row.rel);
    const isCut = Boolean(clipboard?.cut && clipboard.rels.includes(row.rel));
    let className = 'dock-file-row';
    if (!row.dir) className += ` is-file${gitClassOf(badge)}`;
    if (row.dir && gitDirs.has(row.rel)) className += ' git-dir-changed';
    if (isSelected) className += ' explorer-selected';
    if (focusedRel === row.rel) className += ' explorer-focused';
    if (isCut) className += ' explorer-cut';
    if (dropTarget !== null && row.dir && row.rel === dropTarget) className += ' explorer-drop-target';
    // Indent guides: the CSS rule paints one hairline per ancestor level and
    // only needs the covered width (guides render on hover).
    const guides = row.level > 0 ? ({ '--guide-size': `${row.level * 8}px 100%` } as React.CSSProperties) : undefined;
    return (
      <button
        type="button"
        key={row.rel}
        role="treeitem"
        data-i18n-skip
        aria-level={row.level + 1}
        aria-expanded={row.dir ? row.expanded : undefined}
        aria-selected={isSelected}
        title={row.dir ? undefined : row.rel}
        tabIndex={firstFocusableRel === row.rel ? 0 : -1}
        data-guides={row.level > 0 ? 'true' : undefined}
        ref={(element) => {
          if (element) rowEls.current.set(row.rel, element);
          else rowEls.current.delete(row.rel);
        }}
        className={className}
        style={{ paddingLeft: `calc(var(--mx-explorer-inset, 12px) + ${row.level * 8}px)`, ...guides }}
        draggable
        onDragStart={(event) => {
          // Dragging outside the selection re-selects the dragged row alone.
          const withinSelection = selected.has(row.rel);
          const rels = withinSelection ? [...selected] : [row.rel];
          if (!withinSelection) selectOnly(row.rel);
          dragRels.current = rels;
          event.dataTransfer.effectAllowed = 'copyMove';
          event.dataTransfer.setData('text/plain', rels.join('\n'));
          event.dataTransfer.setData(
            COMPOSER_PROJECT_PATHS_MIME,
            JSON.stringify({
              projectPath,
              paths: rels,
            })
          );
          if (rels.length > 1) {
            // Multi-drag feedback: an "N items" badge replaces the
            // default row snapshot as the drag image.
            const ghost = document.createElement('div');
            ghost.className = 'explorer-drag-badge';
            ghost.textContent = `${rels.length} items`;
            document.body.appendChild(ghost);
            try {
              event.dataTransfer.setDragImage(ghost, 0, 0);
            } catch {
              /* jsdom */
            }
            window.setTimeout(() => ghost.remove(), 0);
          }
        }}
        onDragOver={(event) => {
          if (dragRels.current.length === 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? 'copy' : 'move';
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
          selectOnly(row.rel);
          if (row.dir) toggle(row.rel);
          else openFile(row.rel, 'preview');
        }}
        onDoubleClick={row.dir ? undefined : () => openFile(row.rel, 'pinned')}
        onContextMenu={(event) => {
          event.preventDefault();
          // A right-click inside the selection keeps it (multi-item actions).
          if (selected.has(row.rel)) setFocusedRel(row.rel);
          else selectOnly(row.rel);
          setMenu({
            x: event.clientX,
            y: event.clientY,
            rel: row.rel,
            parent: row.parentRel,
            name: row.name,
            isDir: row.dir,
          });
        }}
      >
        {/* 16px twistie column on EVERY row (monaco-tl-twistie): files reserve
          the space too, so labels align per depth; the chevron rotates. */}
        <span className={`explorer-twistie${row.dir && !row.expanded ? ' collapsed' : ''}`} aria-hidden="true">
          {row.dir && <ChevronDown size={14} />}
        </span>
        {/* Seti grammar: folders carry only the twistie, files a themed glyph. */}
        {!row.dir && <SetiFileIcon name={row.name} className="dock-file-icon" />}
        <span>{row.name}</span>
        {row.dir && gitDirs.has(row.rel) && <i className="dock-file-changed" aria-hidden="true" />}
        {!row.dir && badge && (
          <em className="dock-file-badge" aria-label={t('Git status {{badge}}', { badge })}>
            {badge}
          </em>
        )}
        {!row.dir && !badge && changed.has(row.rel) && <i className="dock-file-changed" aria-hidden="true" />}
      </button>
    );
  };
  const treeItems: ReactNode[] = [];
  if (editing && editing.mode !== 'rename' && editing.parentRel === '' && rootVisible) {
    treeItems.push(editRowNode(0));
  }
  for (const row of rows) {
    if (editing?.mode === 'rename' && row.rel === editing.rel) {
      treeItems.push(editRowNode(row.level));
      continue;
    }
    treeItems.push(rowNode(row));
    if (editing && editing.mode !== 'rename' && row.dir && row.expanded && row.rel === editing.parentRel) {
      treeItems.push(editRowNode(row.level + 1));
    }
  }
  const rootEntriesEmpty = (dirs.get('')?.entries?.length ?? -1) === 0 && !dirs.get('')?.error;
  return (
    <>
      {headerPortal}
      <div className="dock-files">
        {showRootHeader && (
          <div className="workbench-explorer-root-row">
            <button
              type="button"
              className="workbench-explorer-root"
              aria-expanded={rootExpanded}
              onClick={() => toggle('')}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  rel: '',
                  parent: '',
                  name: '',
                  isDir: true,
                  background: true,
                });
              }}
            >
              {/* Same rotating twistie as the rows (monaco tree chevron). */}
              <span className={`explorer-twistie${rootExpanded ? '' : ' collapsed'}`} aria-hidden="true">
                <ChevronDown size={14} />
              </span>
              <span title={projectPath} data-i18n-skip>
                {rootLabel || rootName}
              </span>
            </button>
          </div>
        )}
        <div
          className={`dock-files-tree${dropTarget === '' ? ' explorer-drop-root' : ''}`}
          role="tree"
          tabIndex={-1}
          onKeyDown={onTreeKeyDown}
          onDoubleClick={(event) => {
            if (event.target === event.currentTarget && !editingRef.current) beginCreate(false);
          }}
          onContextMenu={(event) => {
            // Background right-click (New File / New Folder / Paste on
            // empty space). Rows preventDefault first, so they are excluded here.
            if (event.defaultPrevented) return;
            if ((event.target as HTMLElement).closest?.('.explorer-edit-box')) return;
            event.preventDefault();
            setMenu({
              x: event.clientX,
              y: event.clientY,
              rel: '',
              parent: '',
              name: '',
              isDir: true,
              background: true,
            });
          }}
          onDragOver={(event) => {
            if (dragRels.current.length === 0) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? 'copy' : 'move';
            if (dropTarget !== '') {
              clearHoverExpand();
              setDropTarget('');
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            void performDrop('', event.ctrlKey || event.altKey);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setDropTarget(null);
          }}
        >
          {rootVisible && treeItems}
          {rootVisible && rows.length === 0 && !editing && rootEntriesEmpty && (
            <p className="utility-dock-empty">{t('Empty folder.')}</p>
          )}
          {mutationError && <ErrorNotice error={mutationError} />}
        </div>
        {visibleMenu &&
          (() => {
            const menu = visibleMenu;
            const multi = !menu.background && selected.size > 1 && selected.has(menu.rel);
            let pasteTarget = '';
            if (!menu.background) pasteTarget = menu.isDir ? menu.rel : menu.parent;
            const copyRels = multi ? [...selected] : [menu.rel];
            const deleteLabel = multi ? `Delete ${selected.size} items` : 'Delete';
            const item = (
              label: string,
              onClick: () => void,
              options?: { hint?: string; danger?: boolean; disabled?: boolean }
            ) => (
              <button
                type="button"
                role="menuitem"
                key={label}
                className={options?.danger ? 'danger' : undefined}
                disabled={options?.disabled}
                onClick={menuAction(onClick)}
              >
                <span>{t(label)}</span>
                {options?.hint && <span className="dock-file-menu-key">{options.hint}</span>}
              </button>
            );
            const sep = (id: string) => <hr key={id} className="dock-file-menu-sep" aria-hidden="true" />;
            return createPortal(
              <div
                className="dock-file-menu"
                role="menu"
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
                  const entries = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)"),
                  ];
                  if (!entries.length) return;
                  const current = Math.max(0, entries.indexOf(document.activeElement as HTMLButtonElement));
                  let next = -1;
                  if (event.key === 'ArrowDown') next = (current + 1) % entries.length;
                  else if (event.key === 'ArrowUp') next = (current - 1 + entries.length) % entries.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = entries.length - 1;
                  else if (event.key === 'Tab') {
                    setMenu(null);
                    return;
                  } else return;
                  event.preventDefault();
                  entries[next]?.focus();
                }}
              >
                {menu.background ? (
                  <>
                    {item('New file…', () => beginCreate(false, ''))}
                    {item('New folder…', () => beginCreate(true, ''))}
                    {sep('bg-clipboard')}
                    {item('Paste', () => void pasteClipboard(''), { hint: 'Ctrl+V', disabled: !clipboard })}
                    {sep('bg-path')}
                    {item('Reveal in Explorer', () => void api?.revealFile?.(projectPath, ''))}
                    {item('Copy path', () => void copyTextToClipboard(projectPath))}
                  </>
                ) : (
                  <>
                    {!multi && !menu.isDir && item('Open', () => openFile(menu.rel))}
                    {!multi &&
                      !menu.isDir &&
                      item('Open in default app', () => void api?.openFilePath?.(projectPath, menu.rel))}
                    {!multi && menu.isDir && item('New file…', () => beginCreate(false, menu.rel))}
                    {!multi && menu.isDir && item('New folder…', () => beginCreate(true, menu.rel))}
                    {!multi && sep('row-open')}
                    {item('Cut', () => stashClipboard(true), { hint: 'Ctrl+X' })}
                    {item('Copy', () => stashClipboard(false), { hint: 'Ctrl+C' })}
                    {!multi &&
                      item('Paste', () => void pasteClipboard(pasteTarget), { hint: 'Ctrl+V', disabled: !clipboard })}
                    {sep('row-clipboard')}
                    {!multi && item('Reveal in Explorer', () => void api?.revealFile?.(projectPath, menu.rel))}
                    {item('Copy path', () => void copyTextToClipboard(copyRels.map(absOf).join('\n')), {
                      hint: 'Shift+Alt+C',
                    })}
                    {item('Copy relative path', () => void copyTextToClipboard(copyRels.join('\n')))}
                    {sep('row-path')}
                    {!multi && item('Rename…', () => beginRename(menu.rel, menu.name, menu.isDir), { hint: 'F2' })}
                    {item(deleteLabel, deleteSelection, {
                      hint: 'Del',
                      danger: true,
                    })}
                  </>
                )}
              </div>,
              document.body
            );
          })()}
      </div>
    </>
  );
});
