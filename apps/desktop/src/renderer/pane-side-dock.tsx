// Per-pane right dock: ONE side-tab unit per pane (user: PANE 하위 → 사이드탭
// 헤더 → 세션 DIFF·브라우저·파일 DIFF가 그 헤더의 하위로). The horizontal
// header selects every child — classic panel views, the pane's browser, and
// file diff surfaces opened from project tools — and each child shows STANDALONE under
// the header, without a second tab row. The whole unit folds and overlays as
// one body; its children and open diff tabs survive folds and persist per
// pane id across restarts.
import {
  startTransition,
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { X } from 'lucide-react';
import { SideFileStatusRow, sideFileHasFooter } from './side-file-status-row';
import { SideFileStrip, type SideFileChrome } from './side-surface-strip';
import { DockHeaderRow, PaneDockExpandContext } from './pane-dock-chrome';
import { PaneDockDiffColumn } from './pane-dock-diff-column';
import {
  useDiffColumnResize,
  useDockCellWidth,
  useDockCloseRequest,
  useDockExpansion,
  useDockMounting,
  useMobileOutsideFold,
  useSideFileProblems,
} from './pane-side-dock-hooks';
import { PaneDockSurfaceSlot } from './pane-side-dock-surface-slot';
import { SideFileProblems } from './side-file-problems';
import { DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH, DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout';
import type { WorkspaceSelection } from './nav-types';
import { navigationKey } from './text-format';
import { DeferredPersistentSurface } from './PaneSurfaceGate';
import { DIFF_STARTUP_DELAY_MS, ReadyGitDiffPane } from './app-shell-components';
import { FileText as FileIcon } from 'lucide-react';
import { DiffHeaderControls, diffScopeLabel, useDiffViewState } from './diff-header-controls';
import { DesktopLoadingSurface } from './RendererRecovery';
import { useMobileRemoteSurface } from './mobile-surface';
import {
  WorkbenchSidePanel,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewDescriptor,
  type WorkbenchSideViewGroup,
  type WorkbenchSideViewId,
  type WorkbenchSideViewPlacement,
} from './workbench-side-view-layout';
import { getSidePanelMode, sidePanelLayout, subscribeSidePanelMode } from './side-panel-preferences';
import { t } from './i18n';
import { getLinkPreview, subscribeLinkPreview } from './link-preview-preference';
import {
  closeSideFileTab,
  keepSideFileTabs,
  planSideFileOpen,
  sameSideFiles,
  sideFileKey,
  sideFileTabDirtyKey,
  type PaneSideDockFile,
  type SideFileOpenOptions,
} from './side-file-tabs';

export type PaneSideDockDiff = Extract<WorkspaceSelection, { kind: 'diff' }>;
type PaneSideDiffRequest = {
  source: 'staged' | 'unstaged' | 'commit' | 'session';
  hash?: string;
  untracked?: boolean;
};
export type { PaneSideDockFile };
/** A project folder a transcript link opened as the dock's Files tree. `rel`
 *  is project-relative ('' = the project root). `nonce` re-reveals the folder
 *  when the same link is clicked again. */
export type PaneSideDockFolder = {
  project: string;
  rel: string;
  nonce: number;
};
export type PaneSideDockEntry = {
  open: boolean;
  /** Active classic panel view; the browser and diffs live in `surface`. */
  view: WorkbenchSideViewId | null;
  /** "" shows the panel view; "browser", "diff" or "file" otherwise. */
  surface: string;
  /** The side-panel file tabs, in order (at most one is a preview tab).
   *  Absent when none. */
  files?: readonly PaneSideDockFile[];
  /** Key (`sideFileKey`) of the active file tab. */
  activeFile?: string;
  /** The Files tree a transcript folder link opened. Absent when none. */
  folder?: PaneSideDockFolder | null;
  /** The single open file diff — a project-tool click REPLACES it (user: 헤더
   *  한 줄, DIFF 탭 없이 교체 방식). */
  diff: PaneSideDockDiff | null;
};

const PANE_SIDE_DOCK_KEY = 'mixdog.desktop.pane-side-dock.v1';
/** One shared width preference for every pane dock: resizing any pane's panel
 *  sets the width the next opened panel starts from. */
const PANE_SIDE_DOCK_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-width.v1';
/** Diff pair column: floors at the classic panel size but OPENS readable
 *  (user: 디프 보기에 너무 작지 않냐 — 기본 480), expanding by drag to 800;
 *  its width is a preference separate from the browser's. */
const PANE_SIDE_DOCK_DIFF_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-diff-width.v1';
/** Every side-dock surface floors at the same width (Claude stops at ~282px);
 *  anything narrower is the overlay/takeover ladder's job. */
export const PANE_SIDE_DOCK_MIN_WIDTH = 280;
export const PANE_SIDE_DOCK_DIFF_MIN_WIDTH = PANE_SIDE_DOCK_MIN_WIDTH;
export const PANE_SIDE_DOCK_DIFF_MAX_WIDTH = 800;
export const PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH = 500;
/** Standalone browser: below 580px BrowserPane renders pages at 100% so
 *  responsive sites reflow like a phone, and the floor drops to 320 — a
 *  phone-frame preview for mobile web-app work (user: 모바일 웹앱 개발이면
 *  브라우저는 더 작아져도). */
const PANE_SIDE_DOCK_BROWSER_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-browser-width.v1';
export const PANE_SIDE_DOCK_BROWSER_MIN_WIDTH = PANE_SIDE_DOCK_MIN_WIDTH;
const PANE_SIDE_DOCK_BROWSER_MAX_WIDTH = 1160;
/** File and browser share this width preference (user-resized width wins). */
export const PANE_SIDE_DOCK_BROWSER_DEFAULT_WIDTH = 500;
/** Terminal opens narrow so it does not cover the conversation; its width is
 *  its own preference. */
const PANE_SIDE_DOCK_TERMINAL_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-terminal-width.v1';
export const PANE_SIDE_DOCK_TERMINAL_MIN_WIDTH = PANE_SIDE_DOCK_MIN_WIDTH;
const PANE_SIDE_DOCK_TERMINAL_MAX_WIDTH = 1160;
export const PANE_SIDE_DOCK_TERMINAL_DEFAULT_WIDTH = 280;
/** The dock is its own floating sheet: its left gap plus the two 1px borders
 *  come on top of the measured column width on desktop. Keep in step with
 *  --mx-sheet-gap in pane-layout.css. */
export const PANE_SIDE_DOCK_SHEET_FRAME_WIDTH = 2 + 2;
/** Classic panel column ceiling (window-level right panel grammar). */
const PANE_SIDE_DOCK_PANEL_MAX_WIDTH = 560;
export const PANE_DOCK_BROWSER_SURFACE = 'browser';
export const PANE_DOCK_TERMINAL_SURFACE = 'terminal';
export const PANE_DOCK_DIFF_SURFACE = 'diff';
export const PANE_DOCK_FILE_SURFACE = 'file';
export const PANE_DOCK_FILES_SURFACE = 'files';
/** The Files tree child is the showing surface of an open unit. */
export function paneFilesShowing(entry: Pick<PaneSideDockEntry, 'open' | 'surface' | 'folder'>): boolean {
  return entry.open && entry.surface === PANE_DOCK_FILES_SURFACE && Boolean(entry.folder);
}
/** The file child is the showing surface of an open unit. */
export function paneFileShowing(entry: Pick<PaneSideDockEntry, 'open' | 'surface' | 'files'>): boolean {
  return entry.open && entry.surface === PANE_DOCK_FILE_SURFACE && (entry.files?.length ?? 0) > 0;
}
/** The active file tab (the last one when the stored key is stale). */
export function paneDockActiveFile(entry: Pick<PaneSideDockEntry, 'files' | 'activeFile'>): PaneSideDockFile | null {
  const files = entry.files ?? [];
  return files.find((file) => sideFileKey(file) === entry.activeFile) ?? files.at(-1) ?? null;
}
/** The diff child is the showing surface of an open unit. */
export function paneDiffShowing(entry: Pick<PaneSideDockEntry, 'open' | 'surface' | 'diff'>): boolean {
  return entry.open && entry.surface === PANE_DOCK_DIFF_SURFACE && entry.diff !== null;
}
// The Goal capsule stays on the composer. It used to ride the diff column
// while a diff showed, which read as the Goal UI leaking into Source Control
// (user: 소스컨트롤에 GOAL UI 딸려 들어가는 버그).
/** A closed diff column waits at least this long, and for a typing pause of
 *  the same length, before its tree is dropped: the unmount commit of a
 *  large diff is one uninterruptible task, so it must not land between two
 *  keystrokes. */
const PANE_DOCK_DIFF_RETAIN_MS = 1_500;
export function useRetainedDiff(diff: PaneSideDockDiff | null): PaneSideDockDiff | null {
  const [retained, setRetained] = useState<PaneSideDockDiff | null>(diff);
  useEffect(() => {
    if (diff) {
      setRetained(diff);
      return undefined;
    }
    let lastInputAt = performance.now();
    const noteInput = () => {
      lastInputAt = performance.now();
    };
    document.addEventListener('keydown', noteInput, true);
    document.addEventListener('input', noteInput, true);
    let timer = 0;
    const stopListening = () => {
      document.removeEventListener('keydown', noteInput, true);
      document.removeEventListener('input', noteInput, true);
    };
    const attempt = () => {
      const quietFor = performance.now() - lastInputAt;
      if (quietFor < PANE_DOCK_DIFF_RETAIN_MS) {
        timer = window.setTimeout(attempt, PANE_DOCK_DIFF_RETAIN_MS - quietFor);
        return;
      }
      timer = 0;
      // The tree is dropped: nothing is left to protect from a keystroke, so
      // the document-level capture listeners must not outlive this decision.
      stopListening();
      startTransition(() => setRetained(null));
    };
    timer = window.setTimeout(attempt, PANE_DOCK_DIFF_RETAIN_MS);
    return () => {
      stopListening();
      window.clearTimeout(timer);
    };
  }, [diff]);
  return retained;
}
/** The dock child a pane is showing — the session surface when one is up,
 *  otherwise the classic panel view — or null while the unit is folded. The
 *  strip toggles and the dock header read the same answer. */
export function paneDockActiveRoot(
  entry: Pick<PaneSideDockEntry, 'open' | 'view' | 'surface'>
): WorkbenchSideViewId | null {
  if (!entry.open) return null;
  if (entry.surface === PANE_DOCK_BROWSER_SURFACE) return 'browser';
  if (entry.surface === PANE_DOCK_TERMINAL_SURFACE) return 'terminal';
  if (entry.surface === PANE_DOCK_FILE_SURFACE || entry.surface === PANE_DOCK_FILES_SURFACE) return null;
  return entry.view;
}
export function paneDiffStacks(
  diffShowing: boolean,
  sheetAvailable: number,
  pairMinimum: number,
  mobile: boolean
): boolean {
  return diffShowing && (mobile || sheetAvailable < pairMinimum);
}
/** Retired stores: the split beside-the-panel surface region, and the short-
 *  lived width pref the browser and diff briefly shared. */
const LEGACY_SIDE_SURFACE_KEYS = [
  'mixdog.desktop.pane-side-surfaces.v1',
  'mixdog.desktop.pane-side-surface-width.v1',
  'mixdog.desktop.pane-side-dock-surface-width.v1',
] as const;

const CLOSED_ENTRY: PaneSideDockEntry = {
  open: false,
  view: null,
  surface: '',
  diff: null,
};

/** The browser's and terminal's bodies are stacked surfaces, so neither can
 *  be a dock's active panel view or its default. */
function isPanelView(id: WorkbenchSideViewId): boolean {
  return id !== PANE_DOCK_BROWSER_SURFACE && id !== PANE_DOCK_TERMINAL_SURFACE;
}

function firstPanelRoot(groups: readonly WorkbenchSideViewGroup[]): WorkbenchSideViewId | null {
  return groups.find((group) => group[0] !== undefined && isPanelView(group[0]))?.[0] ?? null;
}

function isDockDiff(value: unknown): value is PaneSideDockDiff {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === 'diff' &&
    typeof record.project === 'string' &&
    record.project.length > 0 &&
    typeof record.rel === 'string' &&
    record.rel.length > 0 &&
    (record.source === 'staged' ||
      record.source === 'unstaged' ||
      ((record.source === 'commit' || record.source === 'session') &&
        typeof record.hash === 'string' &&
        record.hash.length > 0))
  );
}

type StoredDockFile = Omit<PaneSideDockFile, 'openedAt'> & { openedAt?: number };

function isDockFile(value: unknown): value is StoredDockFile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.project === 'string' &&
    record.project.length > 0 &&
    typeof record.rel === 'string' &&
    record.rel.length > 0 &&
    typeof record.nonce === 'number' &&
    // A file-scoped access token does not outlive its session.
    record.accessToken === undefined &&
    (record.preview === undefined || typeof record.preview === 'boolean') &&
    (record.openedAt === undefined || typeof record.openedAt === 'number') &&
    (record.line === undefined || typeof record.line === 'number') &&
    (record.column === undefined || typeof record.column === 'number')
  );
}

/** A stored file tab list; a legacy single `file` becomes a one-tab list.
 *  Malformed and duplicate tabs drop, and only the first preview tab stays one. */
function storedDockFiles(entry: Record<string, unknown> | null): PaneSideDockFile[] {
  if (!entry) return [];
  let list: unknown[] = [];
  if (Array.isArray(entry.files)) list = entry.files;
  else if (entry.file) list = [entry.file];
  const seen = new Set<string>();
  let previewTaken = false;
  const files: PaneSideDockFile[] = [];
  for (const raw of list) {
    if (!isDockFile(raw)) continue;
    const key = sideFileKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const preview = raw.preview === true && !previewTaken;
    if (preview) previewTaken = true;
    if (typeof raw.openedAt === 'number' && (raw.preview === undefined || preview)) {
      files.push(raw as PaneSideDockFile);
      continue;
    }
    const { preview: _preview, ...rest } = raw;
    files.push({ ...rest, openedAt: raw.openedAt ?? raw.nonce, ...(preview ? { preview: true } : {}) });
  }
  return files;
}

/** Keeps the live array when normalization changed nothing, so the dock map
 *  compares equal. */
function entryFiles(entry: Record<string, unknown> | null, files: PaneSideDockFile[]): readonly PaneSideDockFile[] {
  const live = entry?.files;
  return Array.isArray(live) && sameSideFiles(live as PaneSideDockFile[], files) ? (live as PaneSideDockFile[]) : files;
}

function isDockFolder(value: unknown): value is PaneSideDockFolder {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.project === 'string' &&
    record.project.length > 0 &&
    typeof record.rel === 'string' &&
    typeof record.nonce === 'number'
  );
}

/**
 * Reconcile stored/live dock entries against the current pane list and the
 * right-side view groups. Dead panes drop out, a view that left the right
 * side remaps to the first remaining panel view, malformed diffs and a stale
 * active surface degrade instead of throwing, and a pane seen for the first
 * time follows the side-panel mode policy (open-both keeps it expanded).
 */
export function normalizePaneSideDocks(
  value: unknown,
  leafIds: readonly string[],
  groups: readonly WorkbenchSideViewGroup[],
  defaultOpen: boolean
): Record<string, PaneSideDockEntry> {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const members = new Set<WorkbenchSideViewId>(groups.flat().filter(isPanelView));
  const sessionSurfaces = new Set<string>(
    groups.flat().filter((id) => id === PANE_DOCK_BROWSER_SURFACE || id === PANE_DOCK_TERMINAL_SURFACE)
  );
  const firstRoot = firstPanelRoot(groups);
  const next: Record<string, PaneSideDockEntry> = {};
  for (const leafId of leafIds) {
    const raw = record[leafId];
    const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const storedSurface = entry && typeof entry.surface === 'string' ? entry.surface : '';
    // Single diff; a legacy store may still carry a diffs ARRAY — keep the
    // one its surface pointed at, else the most recent.
    const legacy = entry && Array.isArray(entry.diffs) ? entry.diffs.filter(isDockDiff) : [];
    const diff =
      entry && isDockDiff(entry.diff)
        ? entry.diff
        : (legacy.find((item) => navigationKey(item) === storedSurface) ?? legacy.at(-1) ?? null);
    const storedView =
      entry && typeof entry.view === 'string' && members.has(entry.view as WorkbenchSideViewId)
        ? (entry.view as WorkbenchSideViewId)
        : null;
    const view = storedView ?? firstRoot;
    let surface:
      | typeof PANE_DOCK_BROWSER_SURFACE
      | typeof PANE_DOCK_TERMINAL_SURFACE
      | typeof PANE_DOCK_DIFF_SURFACE
      | typeof PANE_DOCK_FILE_SURFACE
      | typeof PANE_DOCK_FILES_SURFACE
      | '' = '';
    const files = storedDockFiles(entry);
    const folder = entry && isDockFolder(entry.folder) ? entry.folder : null;
    if (storedSurface === PANE_DOCK_BROWSER_SURFACE || storedSurface === PANE_DOCK_TERMINAL_SURFACE) {
      if (sessionSurfaces.has(storedSurface)) surface = storedSurface;
    } else if (diff && (storedSurface === PANE_DOCK_DIFF_SURFACE || storedSurface === navigationKey(diff))) {
      surface = PANE_DOCK_DIFF_SURFACE;
    } else if (files.length > 0 && storedSurface === PANE_DOCK_FILE_SURFACE) {
      surface = PANE_DOCK_FILE_SURFACE;
    } else if (folder && storedSurface === PANE_DOCK_FILES_SURFACE) {
      surface = PANE_DOCK_FILES_SURFACE;
    }
    const open = (entry ? entry.open === true : defaultOpen) && (view !== null || surface !== '');
    const activeFile =
      entry && typeof entry.activeFile === 'string' && files.some((file) => sideFileKey(file) === entry.activeFile)
        ? entry.activeFile
        : files.length > 0
          ? sideFileKey(files[files.length - 1])
          : undefined;
    next[leafId] = {
      open,
      view,
      surface,
      diff,
      ...(files.length > 0 && activeFile ? { files: entryFiles(entry, files), activeFile } : {}),
      ...(folder ? { folder } : {}),
    };
  }
  return next;
}

export function samePaneSideDocks(
  left: Readonly<Record<string, PaneSideDockEntry>>,
  right: Readonly<Record<string, PaneSideDockEntry>>
): boolean {
  const leftIds = Object.keys(left);
  if (leftIds.length !== Object.keys(right).length) return false;
  return leftIds.every((id) => {
    const a = left[id];
    const b = right[id];
    return (
      Boolean(b) &&
      a.open === b.open &&
      a.view === b.view &&
      a.surface === b.surface &&
      a.diff === b.diff &&
      sameSideFiles(a.files, b.files) &&
      (a.activeFile ?? null) === (b.activeFile ?? null) &&
      (a.folder ?? null) === (b.folder ?? null)
    );
  });
}

function activeFileKey(entry: Pick<PaneSideDockEntry, 'files' | 'activeFile'>): string | null {
  const active = paneDockActiveFile(entry);
  return active ? sideFileKey(active) : null;
}

/** Open: a transcript file link or Files-tree open adds a tab (the preview
 *  tab under Link preview), or activates and re-reveals the file's own tab.
 *  See `planSideFileOpen` for the replace, pin and eviction rules. */
export function withPaneDockFileOpened(
  entry: PaneSideDockEntry,
  file: Omit<PaneSideDockFile, 'nonce' | 'openedAt' | 'preview'>,
  nonce: number,
  options?: SideFileOpenOptions
): PaneSideDockEntry {
  const plan = planSideFileOpen({ files: entry.files ?? [], active: activeFileKey(entry) }, file, nonce, options);
  return { ...entry, open: true, surface: PANE_DOCK_FILE_SURFACE, files: plan.files, activeFile: plan.active };
}

/** Activates an existing file tab. */
export function withPaneDockFileActivated(entry: PaneSideDockEntry, fileKey: string): PaneSideDockEntry {
  if (!entry.files?.some((file) => sideFileKey(file) === fileKey)) return entry;
  return { ...entry, open: true, surface: PANE_DOCK_FILE_SURFACE, activeFile: fileKey };
}

/** Turns the preview tab (or every preview tab) into a normal tab. */
export function withPaneDockFileKept(entry: PaneSideDockEntry, fileKey?: string): PaneSideDockEntry {
  if (!entry.files) return entry;
  const files = keepSideFileTabs(entry.files, fileKey);
  return files === entry.files ? entry : { ...entry, files };
}

/** Closes a file tab (the active one by default). Closing the last tab hands
 *  the body back to the panel view. */
export function withPaneDockFileClosed(entry: PaneSideDockEntry, fileKey?: string): PaneSideDockEntry {
  if (!entry.files?.length) return entry;
  const target = fileKey ?? activeFileKey(entry);
  if (!target || !entry.files.some((file) => sideFileKey(file) === target)) return entry;
  const rest = closeSideFileTab({ files: entry.files, active: activeFileKey(entry) }, target);
  if (rest.files.length > 0 && rest.active) return { ...entry, files: rest.files, activeFile: rest.active };
  const { files: _files, activeFile: _activeFile, ...bare } = entry;
  return { ...bare, surface: entry.surface === PANE_DOCK_FILE_SURFACE ? '' : entry.surface };
}

/** Open-or-replace: a transcript folder link shows the project's Files tree
 *  in the dock with the folder revealed; the side file stays mounted. */
export function withPaneDockFolderOpened(
  entry: PaneSideDockEntry,
  folder: Omit<PaneSideDockFolder, 'nonce'>,
  nonce: number
): PaneSideDockEntry {
  return { ...entry, open: true, surface: PANE_DOCK_FILES_SURFACE, folder: { ...folder, nonce } };
}

/** Closing the Files tree hands the body back to the panel view. */
export function withPaneDockFolderClosed(entry: PaneSideDockEntry): PaneSideDockEntry {
  if (!entry.folder) return entry;
  const { folder: _folder, ...rest } = entry;
  return { ...rest, surface: entry.surface === PANE_DOCK_FILES_SURFACE ? '' : entry.surface };
}

/** Open-or-replace: a Source Control click swaps the diff in place; the same
 *  file simply re-activates (user: 탭 없이 교체 방식). */
export function withPaneDockDiffOpened(entry: PaneSideDockEntry, selection: PaneSideDockDiff): PaneSideDockEntry {
  const unchanged =
    entry.open &&
    entry.surface === PANE_DOCK_DIFF_SURFACE &&
    entry.diff !== null &&
    navigationKey(entry.diff) === navigationKey(selection);
  return unchanged
    ? entry
    : {
        ...entry,
        open: true,
        surface: PANE_DOCK_DIFF_SURFACE,
        diff: selection,
      };
}

/** Closing the diff hands the body back to the panel view. */
export function withPaneDockDiffClosed(entry: PaneSideDockEntry): PaneSideDockEntry {
  if (!entry.diff) return entry;
  return {
    ...entry,
    diff: null,
    surface: entry.surface === PANE_DOCK_DIFF_SURFACE ? '' : entry.surface,
  };
}

export function readStoredWidth(key: string, min: number, max: number, initial: number): number {
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? Math.max(min, Math.min(max, stored)) : initial;
  } catch {
    return initial;
  }
}

function readStoredPaneSideDocks(): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(PANE_SIDE_DOCK_KEY) || 'null');
  } catch {
    return null;
  }
}

function modeDefaultOpen(): boolean {
  return sidePanelLayout(getSidePanelMode()).dockOpen;
}

/** Opening keeps whatever child the dock already had and falls back to the
 *  first panel root; a dock with no child at all stays closed. */
function openedPaneDockEntry(entry: PaneSideDockEntry, firstRoot: WorkbenchSideViewId | null): PaneSideDockEntry {
  const view = entry.view ?? firstRoot;
  return { ...entry, open: view !== null || entry.surface !== '', view };
}

/** The dock map follows the live pane list and the current right-side layout:
 *  splits, closes, and view moves re-shape it declaratively, and the
 *  side-panel mode policy owns the open/folded half of its contract. */
function usePaneSideDockShape({
  leafKey,
  groupsKey,
  leafIdsRef,
  groupsRef,
  setDocks,
}: {
  leafKey: string;
  groupsKey: string;
  leafIdsRef: { current: readonly string[] };
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
}): void {
  // Splits, closes, and view moves re-shape the map declaratively: entries
  // follow the live pane list and the CURRENT right-side layout, so a view
  // dragged to the left sidebar can never linger as a pane's active view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: leafKey/groupsKey are the change triggers for the ref-held leaf ids and groups
  useEffect(() => {
    setDocks((current) => {
      const next = normalizePaneSideDocks(current, leafIdsRef.current, groupsRef.current, modeDefaultOpen());
      return samePaneSideDocks(current, next) ? current : next;
    });
  }, [leafKey, groupsKey]);
  // The side-panel mode policy still owns the dock half of its contract:
  // switching to open-both expands every pane dock, close-* folds them.
  useEffect(
    () =>
      subscribeSidePanelMode(() => {
        const open = modeDefaultOpen();
        setDocks((current) => {
          const next: Record<string, PaneSideDockEntry> = {};
          for (const [leafId, entry] of Object.entries(current)) {
            next[leafId] = {
              ...entry,
              open: open && (entry.view !== null || entry.surface !== ''),
            };
          }
          return samePaneSideDocks(current, next) ? current : next;
        });
      }),
    [setDocks]
  );
}

function usePaneSideDockStorage(docks: Record<string, PaneSideDockEntry>): void {
  // The retired beside-the-panel surface store is merged into this dock.
  useEffect(() => {
    for (const key of LEGACY_SIDE_SURFACE_KEYS) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* cosmetic */
      }
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(PANE_SIDE_DOCK_KEY, JSON.stringify(docks));
    } catch {
      // Dock state remains active for this renderer session.
    }
  }, [docks]);
}

/** The single writer for a pane's dock entry: it drops the pane's automation
 *  overlay first, then applies the caller's update, and keeps the previous
 *  entry object when nothing actually changed. */
function usePaneSideDockPatch({
  groupsRef,
  setDocks,
  setTemporary,
}: {
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
  setTemporary: Dispatch<SetStateAction<ReadonlyMap<string, symbol>>>;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: groupsRef is a ref read at call time; setDocks/setTemporary are useState setters owned by usePaneSideDocks
  return useCallback(
    (
      leafId: string,
      updater: (entry: PaneSideDockEntry, firstRoot: WorkbenchSideViewId | null) => PaneSideDockEntry
    ) => {
      setTemporary((current) => {
        if (!current.has(leafId)) return current;
        const next = new Map(current);
        next.delete(leafId);
        return next;
      });
      setDocks((current) => {
        const firstRoot = firstPanelRoot(groupsRef.current);
        const entry = current[leafId] ?? { ...CLOSED_ENTRY, view: firstRoot };
        const next = updater(entry, firstRoot);
        const same =
          next.open === entry.open &&
          next.view === entry.view &&
          next.surface === entry.surface &&
          next.diff === entry.diff &&
          sameSideFiles(next.files, entry.files) &&
          (next.activeFile ?? null) === (entry.activeFile ?? null) &&
          (next.folder ?? null) === (entry.folder ?? null);
        return same && current[leafId] ? current : { ...current, [leafId]: next };
      });
    },
    []
  );
}

/** Every command a dock header, tab, or project tool can issue. */
function usePaneSideDockCommands({
  groupsRef,
  dirtyKeysRef,
  setDocks,
  setTemporary,
}: {
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  /** Dirty keys of the open file tabs; dirty tabs are never evicted. */
  dirtyKeysRef: { current: ReadonlySet<string> };
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
  setTemporary: Dispatch<SetStateAction<ReadonlyMap<string, symbol>>>;
}) {
  const patch = usePaneSideDockPatch({ groupsRef, setDocks, setTemporary });
  /** Header-tab click contract (user: 소스컨트롤·브라우저 각각 선택해서
   *  여는): a panel view lands in the body, the browser lands as its stacked
   *  surface; folding stays with the dock's own toggle/close controls. */
  const select = useCallback(
    (leafId: string, id: WorkbenchSideViewId) => {
      patch(leafId, (entry) =>
        id === PANE_DOCK_BROWSER_SURFACE || id === PANE_DOCK_TERMINAL_SURFACE
          ? { ...entry, open: true, surface: id }
          : { ...entry, open: true, view: id, surface: '' }
      );
    },
    [patch]
  );
  /** Ensure the dock is open, optionally landing on a specific child. */
  const open = useCallback(
    (leafId: string, id?: WorkbenchSideViewId) => {
      if (id) {
        select(leafId, id);
        return;
      }
      patch(leafId, openedPaneDockEntry);
    },
    [patch, select]
  );
  const setOpen = useCallback(
    (leafId: string, nextOpen: boolean) => {
      patch(leafId, (entry, firstRoot) =>
        nextOpen ? openedPaneDockEntry(entry, firstRoot) : { ...entry, open: false }
      );
    },
    [patch]
  );
  /** Fold/unfold the WHOLE unit (user: 한몸) — header, panel view, browser,
   *  and diff surfaces together. Children survive the fold. */
  const toggle = useCallback(
    (leafId: string) => {
      patch(leafId, (entry, firstRoot) =>
        entry.open ? { ...entry, open: false } : openedPaneDockEntry(entry, firstRoot)
      );
    },
    [patch]
  );
  const openDiff = useCallback(
    (leafId: string, project: string, rel: string, request: PaneSideDiffRequest) => {
      const cleanProject = String(project || '').trim();
      const cleanRel = String(rel || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      if (!cleanProject || !cleanRel) return;
      patch(leafId, (entry) =>
        withPaneDockDiffOpened(entry, {
          kind: 'diff',
          project: cleanProject,
          rel: cleanRel,
          ...request,
        })
      );
    },
    [patch]
  );
  const closeDiff = useCallback(
    (leafId: string) => {
      patch(leafId, (entry) => withPaneDockDiffClosed(entry));
    },
    [patch]
  );
  const openFile = useCallback(
    (
      leafId: string,
      project: string,
      rel: string,
      line?: number,
      accessToken?: string,
      column?: number,
      request?: { preview?: boolean; from?: string }
    ) => {
      const cleanProject = String(project || '').trim();
      const cleanRel = String(rel || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
      if (!cleanProject || !cleanRel) return;
      const nonce = Date.now();
      patch(leafId, (entry) =>
        withPaneDockFileOpened(
          entry,
          {
            project: cleanProject,
            rel: cleanRel,
            ...(line ? { line } : {}),
            ...(line && column ? { column } : {}),
            ...(accessToken ? { accessToken } : {}),
          },
          nonce,
          {
            preview: request?.preview,
            from: request?.from,
            now: nonce,
            isDirty: (fileKey) => dirtyKeysRef.current.has(sideFileTabDirtyKey(leafId, fileKey)),
          }
        )
      );
    },
    [patch, dirtyKeysRef]
  );
  const closeFile = useCallback(
    (leafId: string, fileKey?: string) => {
      patch(leafId, (entry) => withPaneDockFileClosed(entry, fileKey));
    },
    [patch]
  );
  const activateFile = useCallback(
    (leafId: string, fileKey: string) => {
      patch(leafId, (entry) => withPaneDockFileActivated(entry, fileKey));
    },
    [patch]
  );
  const keepFile = useCallback(
    (leafId: string, fileKey: string) => {
      patch(leafId, (entry) => withPaneDockFileKept(entry, fileKey));
    },
    [patch]
  );
  const openFolder = useCallback(
    (leafId: string, project: string, rel: string) => {
      const cleanProject = String(project || '').trim();
      const trimmedRel = String(rel || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      const cleanRel = trimmedRel === '.' ? '' : trimmedRel;
      if (!cleanProject) return;
      const nonce = Date.now();
      patch(leafId, (entry) => withPaneDockFolderOpened(entry, { project: cleanProject, rel: cleanRel }, nonce));
    },
    [patch]
  );
  const closeFolder = useCallback(
    (leafId: string) => {
      patch(leafId, (entry) => withPaneDockFolderClosed(entry));
    },
    [patch]
  );
  return {
    select,
    open,
    setOpen,
    toggle,
    openDiff,
    closeDiff,
    openFile,
    closeFile,
    activateFile,
    keepFile,
    openFolder,
    closeFolder,
  };
}

/** Link preview turned off: a preview tab becomes a normal tab. */
function useLinkPreviewKeep(setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>): void {
  useEffect(() => {
    const apply = () => {
      if (getLinkPreview()) return;
      setDocks((current) => {
        let changed = false;
        const next: Record<string, PaneSideDockEntry> = {};
        for (const [leafId, entry] of Object.entries(current)) {
          const kept = withPaneDockFileKept(entry);
          if (kept !== entry) changed = true;
          next[leafId] = kept;
        }
        return changed ? next : current;
      });
    };
    apply();
    return subscribeLinkPreview(apply);
  }, [setDocks]);
}

export function usePaneSideDocks({
  leafIds,
  groups,
}: {
  leafIds: readonly string[];
  groups: readonly WorkbenchSideViewGroup[];
}) {
  const leafKey = leafIds.join('\0');
  const groupsKey = groups.map((group) => group.join(',')).join('|');
  const [docks, setDocks] = useState<Record<string, PaneSideDockEntry>>(() =>
    normalizePaneSideDocks(readStoredPaneSideDocks(), leafIds, groups, modeDefaultOpen())
  );
  // Automation overlays never enter persisted user layout.
  const [temporary, setTemporary] = useState<ReadonlyMap<string, symbol>>(() => new Map());
  const temporarySelect = useCallback((leafId: string, _surface: 'browser') => {
    const token = Symbol();
    setTemporary((current) => new Map(current).set(leafId, token));
    return () =>
      setTemporary((current) => {
        if (current.get(leafId) !== token) return current;
        const next = new Map(current);
        next.delete(leafId);
        return next;
      });
  }, []);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const leafIdsRef = useRef(leafIds);
  leafIdsRef.current = leafIds;
  usePaneSideDockShape({ leafKey, groupsKey, leafIdsRef, groupsRef, setDocks });
  usePaneSideDockStorage(docks);
  useLinkPreviewKeep(setDocks);
  const dirtyKeysRef = useRef<ReadonlySet<string>>(new Set());
  const entryFor = useCallback(
    (leafId: string): PaneSideDockEntry => {
      const base = docks[leafId] ?? CLOSED_ENTRY;
      return temporary.has(leafId) ? { ...base, open: true, surface: 'browser' } : base;
    },
    [docks, temporary]
  );
  const {
    select,
    open,
    setOpen,
    toggle,
    openDiff,
    closeDiff,
    openFile,
    closeFile,
    activateFile,
    keepFile,
    openFolder,
    closeFolder,
  } = usePaneSideDockCommands({
    groupsRef,
    dirtyKeysRef,
    setDocks,
    setTemporary,
  });
  return {
    docks,
    dirtyKeysRef,
    entryFor,
    temporarySelect,
    select,
    open,
    setOpen,
    toggle,
    openDiff,
    closeDiff,
    openFile,
    closeFile,
    activateFile,
    keepFile,
    openFolder,
    closeFolder,
  };
}

function useDockWidthPrefs() {
  const [panelPref, setPanelPref] = useState(() =>
    readStoredWidth(
      PANE_SIDE_DOCK_WIDTH_KEY,
      PANE_SIDE_DOCK_MIN_WIDTH,
      PANE_SIDE_DOCK_PANEL_MAX_WIDTH,
      DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH
    )
  );
  const [diffPref, setDiffPref] = useState(() =>
    readStoredWidth(
      PANE_SIDE_DOCK_DIFF_WIDTH_KEY,
      PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
      PANE_SIDE_DOCK_DIFF_MAX_WIDTH,
      PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH
    )
  );
  const [browserPref, setBrowserPref] = useState(() =>
    readStoredWidth(
      PANE_SIDE_DOCK_BROWSER_WIDTH_KEY,
      PANE_SIDE_DOCK_BROWSER_MIN_WIDTH,
      PANE_SIDE_DOCK_BROWSER_MAX_WIDTH,
      PANE_SIDE_DOCK_BROWSER_DEFAULT_WIDTH
    )
  );
  const [terminalPref, setTerminalPref] = useState(() =>
    readStoredWidth(
      PANE_SIDE_DOCK_TERMINAL_WIDTH_KEY,
      PANE_SIDE_DOCK_TERMINAL_MIN_WIDTH,
      PANE_SIDE_DOCK_TERMINAL_MAX_WIDTH,
      PANE_SIDE_DOCK_TERMINAL_DEFAULT_WIDTH
    )
  );
  return { panelPref, setPanelPref, diffPref, setDiffPref, browserPref, setBrowserPref, terminalPref, setTerminalPref };
}

/**
 * Unified width (user: 두개를 통합 넓이계산): inline, the whole unit — diff
 * pair included — always leaves the conversation its workspace floor, and when
 * the unit cannot fit, the WHOLE unit floats over the pane (한몸 오버레이).
 */
function resolveDockLayout({
  cellWidth,
  room,
  openNow,
  mobileSheet,
  diffShowing,
  sessionSurfaceShowing,
  sessionMin,
  sessionPref,
  panelPref,
  diffPref,
}: {
  cellWidth: number;
  room: number;
  openNow: boolean;
  mobileSheet: boolean;
  diffShowing: boolean;
  sessionSurfaceShowing: boolean;
  sessionMin: number;
  sessionPref: number;
  panelPref: number;
  diffPref: number;
}) {
  const panelDesired = Math.max(PANE_SIDE_DOCK_MIN_WIDTH, Math.min(panelPref, PANE_SIDE_DOCK_PANEL_MAX_WIDTH));
  const diffDesired = Math.max(PANE_SIDE_DOCK_DIFF_MIN_WIDTH, Math.min(diffPref, PANE_SIDE_DOCK_DIFF_MAX_WIDTH));
  // Narrow ladder (user: 특정 폭 이하일 때):
  //   1단계 — the diff pair can no longer stand side by side even as a
  //   sheet, so the diff STACKS over the panel with a back step (2뎁스).
  //   2단계 — even one column cannot fit beside the rail, so the unit takes
  //   the WHOLE pane (browser included: 브라우저는 전체).
  const sheetAvail = cellWidth > 0 ? cellWidth - 48 : Number.POSITIVE_INFINITY;
  const pairMin = PANE_SIDE_DOCK_MIN_WIDTH + PANE_SIDE_DOCK_DIFF_MIN_WIDTH;
  const twoDepth = paneDiffStacks(diffShowing, sheetAvail, pairMin, mobileSheet);
  const pairShowing = diffShowing && !twoDepth;
  let columnMin = PANE_SIDE_DOCK_MIN_WIDTH;
  if (sessionSurfaceShowing) columnMin = sessionMin;
  else if (pairShowing) columnMin = pairMin;
  const fullTakeover = openNow && cellWidth > 0 && sheetAvail < columnMin;
  // Overlay decision: the diff PAIR never shrinks inline (user: 두개 합산이
  // 더 커지면 오버레이) — the moment panel+diff no longer fit beside the
  // conversation floor, the whole unit floats over the pane. View/browser
  // modes shrink toward their own minimum first.
  let inlineFloor = columnMin;
  if (pairShowing) inlineFloor = panelDesired + diffDesired;
  else if (sessionSurfaceShowing) inlineFloor = sessionMin;
  const overlay = fullTakeover || (openNow && room < inlineFloor);
  let avail = room;
  if (fullTakeover) avail = cellWidth;
  else if (overlay) avail = Math.max(columnMin, sheetAvail);
  let asideTarget = Math.max(PANE_SIDE_DOCK_MIN_WIDTH, Math.min(panelPref, avail));
  if (fullTakeover) asideTarget = cellWidth;
  else if (sessionSurfaceShowing) {
    asideTarget = Math.max(sessionMin, Math.min(sessionPref, avail));
  } else if (pairShowing) {
    asideTarget = Math.max(PANE_SIDE_DOCK_MIN_WIDTH, Math.min(panelDesired, avail - PANE_SIDE_DOCK_DIFF_MIN_WIDTH));
  }
  const baseAsideWidth = Math.round(asideTarget);
  const diffWidth = pairShowing
    ? Math.round(Math.max(PANE_SIDE_DOCK_DIFF_MIN_WIDTH, Math.min(diffDesired, avail - baseAsideWidth)))
    : 0;
  return { diffDesired, twoDepth, pairShowing, overlay, baseAsideWidth, diffWidth };
}

/** The desktop header row for the diff and the panel views. */
function PaneDockChromeRow({
  diffShowing,
  diff,
  diffView,
  panelTitle,
  renderDiffHeaderControls,
  onClose,
}: {
  diffShowing: boolean;
  diff: PaneSideDockDiff | null;
  diffView: ReturnType<typeof useDiffViewState>;
  panelTitle: string;
  renderDiffHeaderControls?: () => ReactNode;
  onClose(): void;
}) {
  return (
    <DockHeaderRow
      className="pane-side-dock-chrome"
      ariaLabel={diffShowing ? t('Changes') : undefined}
      left={
        diffShowing && diff ? (
          <>
            <div className="browser-tab is-active dock-header-chip">
              <span className="browser-tab-select" title={`${diff.rel}\n${diffScopeLabel(diff.source)}`}>
                <FileIcon size={14} aria-hidden="true" />
                <span>{diff.rel.split('/').at(-1) ?? diff.rel}</span>
              </span>
            </div>
            {renderDiffHeaderControls?.() ?? <DiffHeaderControls {...diffView} />}
          </>
        ) : (
          <span className="dock-header-title">{panelTitle}</span>
        )
      }
      onClose={onClose}
    />
  );
}

/** The phone sheet's title row; it slides out with the unit. */
function MobileDockHeader({
  fileShowing,
  descriptor,
  onClose,
}: {
  fileShowing: boolean;
  descriptor: WorkbenchSideViewDescriptor | undefined;
  onClose(): void;
}) {
  return (
    <header className="pane-side-dock-header">
      {fileShowing ? (
        <div className="pane-side-dock-title">
          <span>{t('File')}</span>
        </div>
      ) : (
        descriptor && (
          <div className="pane-side-dock-title">
            <span>{descriptor.title ?? descriptor.label}</span>
          </div>
        )
      )}
      <button
        type="button"
        className="pane-side-dock-close"
        aria-label={t('Close panel')}
        data-tooltip={t('Close panel')}
        onClick={onClose}
      >
        {/* Same voice as the island buttons: lucide line work at 20px — the
            codicon font glyph read thinner and off-size beside them (user:
            사이드탭 X가 정렬이나 크기가 다른 것 같다). A bare two-stroke X
            at the pictograms' weight reads HEAVIER than they do, so it takes
            one step less stroke to sit at the same optical weight (user: X가
            뭔가 달라보이는데). */}
        <X size={20} aria-hidden="true" />
      </button>
    </header>
  );
}

const commitWidthPref = (key: string, value: number) => {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* session-only */
  }
};

export function PaneSideDock({
  leafId,
  entry,
  groups,
  descriptors,
  focused,
  prewarm = false,
  onSelect,
  onClose,
  onCloseDiff,
  onCloseFile,
  onCloseFileTab,
  onActivateFile,
  onKeepFile,
  onCloseFolder,
  onMoveGroup,
  onMoveView,
  onFocusPane,
  openFileTab,
  renderBrowserSurface,
  renderTerminalSurface,
  renderFilesSurface,
  renderFileSurface,
  renderFileProblems,
  renderView,
  renderDiffHeaderControls,
}: {
  leafId: string;
  entry: PaneSideDockEntry;
  /** Optional controls rendered in the diff header's left slot after the
   *  file chip (the unified/split menu by default). */
  renderDiffHeaderControls?: () => ReactNode;
  groups: readonly WorkbenchSideViewGroup[];
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  focused: boolean;
  /** Hidden-mount only the focused pane's panel shell after boot. */
  prewarm?: boolean;
  onSelect(id: WorkbenchSideViewId): void;
  /** Folds the unit — the header X, and a re-click on the active icon
   *  (user: 오버레이까지 되는 판에 닫히는 거나 X가 있어야). */
  onClose(): void;
  onCloseDiff(): void;
  /** The header X while a side file shows: closes the file (confirming unsaved
   *  edits) and folds the unit. Absent, the X just folds. */
  onCloseFile?(): void;
  /** A file tab's own close (confirming that tab's unsaved edits). */
  onCloseFileTab?(fileKey: string): void;
  onActivateFile?(fileKey: string): void;
  /** "Keep open": the preview tab becomes a normal tab. */
  onKeepFile?(fileKey: string): void;
  /** The header X while the Files tree shows: drops the folder and folds the unit. */
  onCloseFolder?(): void;
  /** The project Files tree a transcript folder link revealed; draws its own
   *  DockHeaderRow in its slot. */
  renderFilesSurface?(folder: PaneSideDockFolder, active: boolean, side: { onClose: () => void }): ReactNode;
  onMoveGroup(
    sourceRoot: WorkbenchSideViewId,
    targetSide: 'left' | 'right',
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement
  ): void;
  onMoveView(
    sourceId: WorkbenchSideViewId,
    targetSide: 'left' | 'right',
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement
  ): void;
  onFocusPane(): void;
  openFileTab(project: string, rel: string, line?: number, accessToken?: string): void;
  renderBrowserSurface?(active: boolean): ReactNode;
  renderTerminalSurface?(active: boolean): ReactNode;
  /** `onSideChrome` receives the editor's dirty/problem/action state for the
   *  dock's file strip; the editor draws no breadcrumb row of its own. */
  renderFileSurface?(
    file: PaneSideDockFile,
    active: boolean,
    side: { onChrome: (chrome: SideFileChrome | null) => void; onShowProblems: () => void }
  ): ReactNode;
  /** The Problems body scoped to the side file; shown in a split under the
   *  editor, never in the main pane's bottom panel. */
  renderFileProblems?(file: PaneSideDockFile): ReactNode;
  renderView(id: WorkbenchSideViewId, active: boolean, titleDragProps: WorkbenchSideTitleDragProps): ReactNode;
}) {
  const openNow = entry.open && (entry.view !== null || entry.surface !== '');
  const { panelMounted, dockBodyMounted } = useDockMounting(openNow, prewarm);
  const {
    fileChromes,
    chromeSetter,
    fileProblemsOpen,
    setFileProblemsOpen,
    fileProblemsHeight,
    setFileProblemsHeight,
    toggleFileProblems,
  } = useSideFileProblems((entry.files?.length ?? 0) > 0);
  const activeFile = paneDockActiveFile(entry);
  const activeFileId = activeFile ? sideFileKey(activeFile) : null;
  const fileChrome = activeFileId ? (fileChromes[activeFileId] ?? null) : null;
  const surfaceShowing = openNow && entry.surface !== '';
  const browserShowing = surfaceShowing && entry.surface === PANE_DOCK_BROWSER_SURFACE;
  const terminalShowing = surfaceShowing && entry.surface === PANE_DOCK_TERMINAL_SURFACE;
  const fileShowing = surfaceShowing && paneFileShowing(entry);
  const filesShowing = surfaceShowing && paneFilesShowing(entry);
  const sessionSurfaceShowing = browserShowing || terminalShowing || fileShowing || filesShowing;
  const diffShowing = surfaceShowing && paneDiffShowing(entry);
  // The Changes panel view draws its own DockHeaderRow (SessionDiffPane).
  const sessionDiffPanelShowing = openNow && entry.surface === '' && entry.view === 'session-diff';
  // The dock measures its own pane cell (see resolveDockLayout).
  const { panelPref, setPanelPref, diffPref, setDiffPref, browserPref, setBrowserPref, terminalPref, setTerminalPref } =
    useDockWidthPrefs();
  // The dock header mounts the diff controls; the pane body shares this state.
  const diffView = useDiffViewState('pane-side-dock');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cellWidth = useDockCellWidth(hostRef, openNow);
  const { expanded, expandedRect, restWidth, toggleExpanded } = useDockExpansion(
    hostRef,
    entry.surface,
    entry.view,
    openNow
  );
  // The stored preference as it stood when a panel resize gesture began: a
  // cancel restores it rather than the constrained rendered width.
  const panelWidthSnapshot = useRef<{ kind: 'terminal' | 'browser' | 'panel'; pref: number } | null>(null);
  const diffResizeProps = useDiffColumnResize({
    diffPref,
    setDiffPref,
    getDiffWidth: () => diffWidth,
    minWidth: PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
    maxWidth: PANE_SIDE_DOCK_DIFF_MAX_WIDTH,
    commitWidth: (width) => commitWidthPref(PANE_SIDE_DOCK_DIFF_WIDTH_KEY, width),
  });
  // Closing the diff used to unmount its whole column — thousands of diff
  // rows — inside the click commit, and a keystroke landing in that same
  // task waited 30–70ms for it (user: 디프창이 사라질 때 유독 덜컹). The
  // column now only HIDES on close; the retained tree is dropped later, in
  // idle time and as a transition, so typing keeps its own frames. A reopen
  // of the same file inside that window reuses the live tree.
  const retainedDiff = useRetainedDiff(entry.diff);
  // The hidden column keeps its last shown width: the diff library observes
  // its wrapper's size and re-lays out every row on any change, so a width
  // going to zero on close would cost as much as the unmount did.
  const shownDiffWidth = useRef(0);
  useMobileOutsideFold(hostRef, openNow, onClose);
  useDockCloseRequest(
    browserShowing || terminalShowing || sessionDiffPanelShowing,
    sessionDiffPanelShowing ? 'session-diff' : entry.surface,
    focused,
    onClose
  );
  if (groups.length === 0) return null;
  const mobileSheet = useMobileRemoteSurface();
  const sheetFrame = mobileSheet ? 0 : PANE_SIDE_DOCK_SHEET_FRAME_WIDTH;
  const sessionMin = terminalShowing ? PANE_SIDE_DOCK_TERMINAL_MIN_WIDTH : PANE_SIDE_DOCK_BROWSER_MIN_WIDTH;
  const sessionMax = terminalShowing ? PANE_SIDE_DOCK_TERMINAL_MAX_WIDTH : PANE_SIDE_DOCK_BROWSER_MAX_WIDTH;
  const sessionPref = terminalShowing ? terminalPref : browserPref;
  const room = cellWidth > 0 ? cellWidth - DESKTOP_WORKSPACE_MIN_WIDTH - sheetFrame : Number.POSITIVE_INFINITY;
  const { diffDesired, twoDepth, pairShowing, overlay, baseAsideWidth, diffWidth } = resolveDockLayout({
    cellWidth,
    room,
    openNow,
    mobileSheet,
    diffShowing,
    sessionSurfaceShowing,
    sessionMin,
    sessionPref,
    panelPref,
    diffPref,
  });
  const dockExpanded = expanded && openNow && !mobileSheet;
  const dockExpandValue = mobileSheet ? null : { expanded: dockExpanded, toggle: toggleExpanded };
  // Expanded, the panel fills the sheet (minus its borders and the diff pair column).
  const asideWidth = expandedRect
    ? Math.max(baseAsideWidth, Math.round(expandedRect.width) - 2 - (pairShowing ? diffWidth : 0))
    : baseAsideWidth;
  // The same deferred diff body serves the stacked 2뎁스 layer and the pair column.
  const diffSurface = (selection: PaneSideDockDiff, stacked = false) => (
    <DeferredPersistentSurface
      active
      startupDelayMs={DIFF_STARTUP_DELAY_MS}
      fallback={<DesktopLoadingSurface label={t('Loading diff…')} />}
    >
      <ReadyGitDiffPane
        selection={selection}
        active={diffShowing}
        onOpenFile={openFileTab}
        chrome="side"
        onBack={stacked ? onCloseDiff : undefined}
        headerControlsExternal
        viewState={diffView}
      />
    </DeferredPersistentSurface>
  );
  // Browser: standalone under the header (user: 브라우저는 단독 맞고) — a
  // persistent layer stacked over the panel body. In the narrow 2뎁스 stage
  // the diff rides the same layer, with a back step to the list (user:
  // 디프소스를 사이드탭 패널에 올리고 뒤로가기).
  const twoDepthDiff = dockBodyMounted && twoDepth && entry.diff && (
    <div className="workbench-side-surface-slot" data-surface-active={diffShowing ? 'true' : 'false'}>
      {diffSurface(entry.diff, true)}
    </div>
  );
  const browserSurface = dockBodyMounted ? (renderBrowserSurface?.(browserShowing) ?? null) : null;
  const terminalSurface = dockBodyMounted ? (renderTerminalSurface?.(terminalShowing) ?? null) : null;
  // One mounted editor per file tab, so unsaved edits survive a tab switch;
  // only the active tab's editor shows.
  const fileSurface =
    dockBodyMounted && entry.files?.length
      ? entry.files.map((file) => {
          const fileId = sideFileKey(file);
          const shown = fileId === activeFileId;
          return (
            <div key={fileId} className="pane-side-file-tab" hidden={!shown}>
              {renderFileSurface?.(file, fileShowing && shown, {
                onChrome: chromeSetter(fileId),
                onShowProblems: toggleFileProblems,
              }) ?? null}
            </div>
          );
        })
      : null;
  const fileProblems = fileProblemsOpen && activeFile ? (renderFileProblems?.(activeFile) ?? null) : null;
  const filesSurface =
    dockBodyMounted && entry.folder
      ? (renderFilesSurface?.(entry.folder, filesShowing, { onClose: onCloseFolder ?? onClose }) ?? null)
      : null;
  const surfaces = (browserSurface || terminalSurface || fileSurface || filesSurface || twoDepthDiff) && (
    <>
      {filesSurface && <PaneDockSurfaceSlot active={filesShowing}>{filesSurface}</PaneDockSurfaceSlot>}
      {fileSurface && (
        <div
          className="workbench-side-surface-slot"
          data-surface-active={fileShowing ? 'true' : 'false'}
          inert={fileShowing ? undefined : true}
          aria-hidden={fileShowing ? undefined : true}
        >
          <SideFileStrip
            files={entry.files ?? []}
            activeKey={activeFileId}
            chrome={fileChrome}
            onSelect={(fileKey) => onActivateFile?.(fileKey)}
            onCloseTab={(fileKey) => (onCloseFileTab ? onCloseFileTab(fileKey) : (onCloseFile ?? onClose)())}
            onKeep={(fileKey) => onKeepFile?.(fileKey)}
            onClose={onCloseFile ?? onClose}
            onOpenInMain={() => {
              // The host's main-tab open takes the file over from this dock
              // (confirming unsaved edits), so nothing else to close here.
              if (activeFile) openFileTab(activeFile.project, activeFile.rel, activeFile.line, activeFile.accessToken);
            }}
          />
          <div className="pane-side-file-body">
            <div className="pane-side-file-editor">{fileSurface}</div>
            {fileProblems && (
              <SideFileProblems
                height={fileProblemsHeight}
                onHeightChange={setFileProblemsHeight}
                onClose={() => setFileProblemsOpen(false)}
              >
                {fileProblems}
              </SideFileProblems>
            )}
          </div>
          {sideFileHasFooter(fileChrome) && <SideFileStatusRow chrome={fileChrome} />}
        </div>
      )}
      {browserSurface && (
        <div
          className="workbench-side-surface-slot"
          data-surface-active={browserShowing ? 'true' : 'false'}
          inert={browserShowing ? undefined : true}
          aria-hidden={browserShowing ? undefined : true}
        >
          {browserSurface}
        </div>
      )}
      {terminalSurface && <PaneDockSurfaceSlot active={terminalShowing}>{terminalSurface}</PaneDockSurfaceSlot>}
      {twoDepthDiff}
    </>
  );
  // File Diff: PAIRED to the LEFT of the panel view under the same header
  // selection; a project-tool click replaces the file in place. The narrow
  // 2뎁스 stage retires the pair column — the diff stacks over the panel.
  const columnDiff = entry.diff ?? retainedDiff;
  if (pairShowing && diffWidth > 0) shownDiffWidth.current = diffWidth;
  const columnWidth = pairShowing ? diffWidth : shownDiffWidth.current || diffDesired;
  const diffColumn = dockBodyMounted && columnDiff && !twoDepth && (
    <PaneDockDiffColumn showing={diffShowing} width={columnWidth} resizeProps={diffResizeProps}>
      {diffSurface(columnDiff)}
    </PaneDockDiffColumn>
  );
  // ONE header line for the whole unit (user: 헤더 한 줄), spanning
  // [diff | panel] at the PANE strip's height. The child icons moved to the
  // pane strip's right end (PaneDockToggles), so the header names only the
  // showing child and carries the fold X — the Claude Desktop card grammar.
  // The title is text-only: the strip icon already identifies the view
  // (user: 사이드탭 타이틀 옆 아이콘 제거).
  const activeRoot = paneDockActiveRoot(entry);
  // The phone sheet slides out as ONE piece, header included, so the header
  // stays mounted through the exit and names the last shown child.
  const headerShowing = openNow || mobileSheet;
  const titleRoot = activeRoot ?? (mobileSheet ? entry.view : null);
  const activeDescriptor = titleRoot ? descriptors.get(titleRoot) : undefined;
  const dockFile = fileShowing ? activeFile : null;
  return (
    <PaneDockExpandContext.Provider value={dockExpandValue}>
      {dockExpanded && expandedRect && (
        <div className="pane-side-dock-spacer" style={{ width: restWidth.current }} aria-hidden="true" />
      )}
      <div
        className="pane-side-dock"
        ref={hostRef}
        data-pane-id={leafId}
        data-open={openNow ? 'true' : 'false'}
        data-overlay={overlay ? 'true' : 'false'}
        data-expanded={dockExpanded ? 'true' : 'false'}
        style={
          dockExpanded && expandedRect
            ? {
                position: 'fixed',
                left: expandedRect.left,
                top: expandedRect.top,
                width: expandedRect.width,
                height: expandedRect.height,
              }
            : undefined
        }
        onPointerDownCapture={
          focused
            ? undefined
            : (event) => {
                if (event.button === 0) onFocusPane();
              }
        }
      >
        {/* Desktop: ONE header row per side surface. File, browser and terminal
          draw their own DockHeaderRow in their slot; the dock draws the row
          only for the diff and the panel views. */}
        {!mobileSheet && openNow && !sessionSurfaceShowing && !sessionDiffPanelShowing && (
          <PaneDockChromeRow
            diffShowing={diffShowing}
            diff={entry.diff}
            diffView={diffView}
            panelTitle={activeDescriptor?.title ?? activeDescriptor?.label ?? ''}
            renderDiffHeaderControls={renderDiffHeaderControls}
            onClose={onClose}
          />
        )}
        {headerShowing && mobileSheet && (
          <MobileDockHeader
            fileShowing={Boolean(dockFile)}
            descriptor={activeDescriptor}
            onClose={dockFile && onCloseFile ? onCloseFile : onClose}
          />
        )}
        {panelMounted && (
          <div className="pane-side-dock-main">
            {diffColumn}
            <WorkbenchSidePanel
              side="right"
              embedded
              hideTabs
              open={openNow}
              groups={groups}
              activeRoot={entry.view}
              surfaces={surfaces}
              surfacesActive={sessionSurfaceShowing || twoDepth}
              descriptors={descriptors}
              onSelect={onSelect}
              onMoveGroup={onMoveGroup}
              onMoveView={onMoveView}
              widthOverride={asideWidth}
              onWidthDrag={(next, phase) => {
                const kind = terminalShowing ? 'terminal' : sessionSurfaceShowing ? 'browser' : 'panel';
                if (phase === 'preview' && !panelWidthSnapshot.current) {
                  const pref = kind === 'terminal' ? terminalPref : kind === 'browser' ? browserPref : panelPref;
                  panelWidthSnapshot.current = { kind, pref };
                }
                if (phase === 'cancel') {
                  const snapshot = panelWidthSnapshot.current;
                  panelWidthSnapshot.current = null;
                  if (!snapshot) return;
                  if (snapshot.kind === 'terminal') setTerminalPref(snapshot.pref);
                  else if (snapshot.kind === 'browser') setBrowserPref(snapshot.pref);
                  else setPanelPref(snapshot.pref);
                  return;
                }
                if (phase === 'commit') panelWidthSnapshot.current = null;
                if (kind === 'terminal') {
                  setTerminalPref(next);
                  if (phase === 'commit') commitWidthPref(PANE_SIDE_DOCK_TERMINAL_WIDTH_KEY, next);
                } else if (kind === 'browser') {
                  setBrowserPref(next);
                  if (phase === 'commit') commitWidthPref(PANE_SIDE_DOCK_BROWSER_WIDTH_KEY, next);
                } else {
                  setPanelPref(next);
                  if (phase === 'commit') commitWidthPref(PANE_SIDE_DOCK_WIDTH_KEY, next);
                }
              }}
              widthRange={
                sessionSurfaceShowing
                  ? {
                      min: sessionMin,
                      max: sessionMax,
                      initial: terminalShowing
                        ? PANE_SIDE_DOCK_TERMINAL_DEFAULT_WIDTH
                        : PANE_SIDE_DOCK_BROWSER_DEFAULT_WIDTH,
                    }
                  : {
                      min: PANE_SIDE_DOCK_MIN_WIDTH,
                      max: PANE_SIDE_DOCK_PANEL_MAX_WIDTH,
                      initial: DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
                    }
              }
              renderView={(id, active, titleDragProps) =>
                dockBodyMounted ? renderView(id, active, titleDragProps) : null
              }
            />
          </div>
        )}
      </div>
    </PaneDockExpandContext.Provider>
  );
}
