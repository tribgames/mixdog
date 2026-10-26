// Per-pane right dock: ONE side-tab unit per pane. The horizontal
// header selects every child — classic panel views, the pane's browser, and
// file diff surfaces opened from project tools — and each child shows STANDALONE under
// the header, without a second tab row. The whole unit folds and overlays as
// one body; its children and open diff tabs survive folds and persist per
// pane id across restarts.
import {
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { FolderTree } from 'lucide-react';
import type { SideFileChrome } from './side-surface-strip';
import { DockHeaderRow, PaneDockExpandContext } from './pane-dock-chrome';
import { useDockPanelActions } from './dock-panel-actions';
import { PaneDockDiffColumn } from './pane-dock-diff-column';
import { PaneDockFileSurface } from './PaneDockFileSurface';
import { SESSION_BOUND_VIEWS } from './pane-dock-toggles';
import { useVisualizeAvailable } from './visualize-store';
import { publishPhoneDockSwitch, type PhoneDockSwitchItem } from './phone-dock-switch';
import {
  clampPaneDockHeight,
  commitWidthPref,
  PANE_SIDE_DOCK_DEFAULT_HEIGHT,
  PANE_SIDE_DOCK_HEIGHT_KEY,
  PANE_SIDE_DOCK_MIN_HEIGHT,
  paneDockResizeAxis,
  useDiffColumnResize,
  useDockCellWidth,
  useDockCloseRequest,
  useDockExpansion,
  useDockHeightDrag,
  useDockMounting,
  useDockRoomHeight,
  useInlineDockFlag,
  usePanelWidthDrag,
  useSheetExit,
  useSidePanelPlacement,
  useSideFileProblems,
} from './pane-side-dock-hooks';
import { PaneDockSurfaceSlot } from './pane-side-dock-surface-slot';
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
import { syncTranscriptWidths } from './transcript-list-resize-patch';
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
  /** The single open file diff — a project-tool click REPLACES it. */
  diff: PaneSideDockDiff | null;
  /** The session the pane showed when its file tabs, Files tree or diff were
   *  last brought up: they show beside that session only. Absent when the
   *  pane showed no session (a draft or a main file tab). */
  owner?: string;
  /** The front (open, surface) the tabs that are not in front keep while
   *  the other side is: with the owner's file tabs, Files tree or diff in
   *  front, what every other tab sees (a pane-level view, open or folded);
   *  with another tab's pick in front, the owner's front, given back when
   *  the owner is shown again. Absent when nothing is parked. */
  parked?: { open: boolean; surface: string };
};

const PANE_SIDE_DOCK_KEY = 'mixdog.desktop.pane-side-dock.v1';
/** One shared width preference for every pane dock: resizing any pane's panel
 *  sets the width the next opened panel starts from. */
const PANE_SIDE_DOCK_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-width.v1';
/** Diff pair column: floors at the classic panel size but OPENS readable,
 *  expanding by drag to 800;
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
 *  phone-frame preview for mobile web-app work. */
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
function paneFileShowing(entry: Pick<PaneSideDockEntry, 'open' | 'surface' | 'files'>): boolean {
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
// while a diff showed, which read as the Goal UI leaking into Source Control.
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

function isDockFile(value: unknown, live = false): value is StoredDockFile {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.project === 'string' &&
    record.project.length > 0 &&
    typeof record.rel === 'string' &&
    record.rel.length > 0 &&
    typeof record.nonce === 'number' &&
    // A file-scoped access token does not outlive its session (storage), but
    // a live entry keeps it across layout changes.
    (record.accessToken === undefined || (live && typeof record.accessToken === 'string')) &&
    (record.preview === undefined || typeof record.preview === 'boolean') &&
    (record.sidePreview === undefined || typeof record.sidePreview === 'boolean') &&
    (record.openedAt === undefined || typeof record.openedAt === 'number') &&
    (record.line === undefined || typeof record.line === 'number') &&
    (record.column === undefined || typeof record.column === 'number')
  );
}

/** A stored file tab list; a legacy single `file` becomes a one-tab list.
 *  Malformed and duplicate tabs drop, and only the first preview tab stays one. */
function storedDockFiles(entry: Record<string, unknown> | null, live = false): PaneSideDockFile[] {
  if (!entry) return [];
  let list: unknown[] = [];
  if (Array.isArray(entry.files)) list = entry.files;
  else if (entry.file) list = [entry.file];
  const seen = new Set<string>();
  let previewTaken = false;
  const files: PaneSideDockFile[] = [];
  for (const raw of list) {
    if (!isDockFile(raw, live)) continue;
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

/** The dock map as written to storage: file tabs opened with a file-scoped
 *  access token (and an active-file key naming one) never reach storage. The
 *  live map is not touched; a load drops such tabs anyway. */
export function storablePaneSideDocks(docks: Record<string, PaneSideDockEntry>): Record<string, PaneSideDockEntry> {
  let out = docks;
  for (const [leafId, entry] of Object.entries(docks)) {
    if (!entry.files?.some((file) => file.accessToken !== undefined)) continue;
    const { files: _files, activeFile: _activeFile, ...rest } = entry;
    const files = entry.files.filter((file) => file.accessToken === undefined);
    const activeFile = files.some((file) => sideFileKey(file) === entry.activeFile) ? entry.activeFile : undefined;
    const surface = files.length === 0 && entry.surface === PANE_DOCK_FILE_SURFACE ? '' : entry.surface;
    out = {
      ...out,
      [leafId]: { ...rest, surface, ...(files.length > 0 ? { files, ...(activeFile ? { activeFile } : {}) } : {}) },
    };
  }
  return out;
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
 * `live` marks the in-memory map (not storage): its access-token file tabs stay.
 */
export function normalizePaneSideDocks(
  value: unknown,
  leafIds: readonly string[],
  groups: readonly WorkbenchSideViewGroup[],
  defaultOpen: boolean,
  live = false
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
    const files = storedDockFiles(entry, live);
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
    let activeFile: string | undefined;
    if (entry && typeof entry.activeFile === 'string' && files.some((file) => sideFileKey(file) === entry.activeFile)) {
      activeFile = entry.activeFile;
    } else if (files.length > 0) {
      activeFile = sideFileKey(files[files.length - 1]);
    }
    const owner = entry && typeof entry.owner === 'string' ? entry.owner : '';
    const storedParked =
      entry?.parked && typeof entry.parked === 'object' ? (entry.parked as Record<string, unknown>) : null;
    const parkedSurface = typeof storedParked?.surface === 'string' ? storedParked.surface : null;
    const parkedValid =
      owner !== '' &&
      parkedSurface !== null &&
      (parkedSurface === '' ||
        sessionSurfaces.has(parkedSurface) ||
        (parkedSurface === PANE_DOCK_DIFF_SURFACE && diff !== null) ||
        (parkedSurface === PANE_DOCK_FILE_SURFACE && files.length > 0) ||
        (parkedSurface === PANE_DOCK_FILES_SURFACE && folder !== null));
    next[leafId] = {
      open,
      view,
      surface,
      diff,
      ...(files.length > 0 && activeFile ? { files: entryFiles(entry, files), activeFile } : {}),
      ...(folder ? { folder } : {}),
      ...(owner ? { owner } : {}),
      ...(parkedValid ? { parked: { open: storedParked?.open === true, surface: parkedSurface ?? '' } } : {}),
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
      (a.folder ?? null) === (b.folder ?? null) &&
      (a.owner ?? '') === (b.owner ?? '') &&
      sameParked(a.parked, b.parked)
    );
  });
}

function sameParked(a: PaneSideDockEntry['parked'], b: PaneSideDockEntry['parked']): boolean {
  return a === b || (Boolean(a) && Boolean(b) && a?.open === b?.open && a?.surface === b?.surface);
}

/** `entry` as its owner `session` sees it: the owner's parked front back in
 *  front, and what other tabs had in front parked for them. `entry` itself
 *  when `session` is not the owner or nothing of the owner's is parked. */
export function paneDockRestored(entry: PaneSideDockEntry, session: string): PaneSideDockEntry {
  const parked = entry.parked;
  if (!session || entry.owner !== session || !parked || !paneLocalSurface(parked.surface)) return entry;
  if (paneLocalSurface(entry.surface)) return entry;
  return { ...entry, open: parked.open, surface: parked.surface, parked: { open: entry.open, surface: entry.surface } };
}

/** A non-owner tab opening or folding the pane: only the front other tabs see changes. */
function withParkedOpen(
  entry: PaneSideDockEntry,
  open: boolean,
  firstRoot: WorkbenchSideViewId | null
): PaneSideDockEntry {
  const view = entry.view ?? firstRoot;
  const surface = entry.parked && !paneLocalSurface(entry.parked.surface) ? entry.parked.surface : '';
  return { ...entry, view, parked: { open: open && (view !== null || surface !== ''), surface } };
}

/** File tabs, the Files tree or a git diff: what a pane's dock holds of its own. */
export const paneLocalSurface = (surface: string) =>
  surface === PANE_DOCK_DIFF_SURFACE || surface === PANE_DOCK_FILE_SURFACE || surface === PANE_DOCK_FILES_SURFACE;

/** Another session's file tabs, Files tree or diff are in front of `entry`
 *  for a pane showing `session` ('' for none). */
export function paneDockForeign(entry: PaneSideDockEntry, session: string): boolean {
  return paneLocalSurface(entry.surface) && Boolean(entry.owner) && entry.owner !== session;
}

/** `entry` without its file tabs, Files tree, diff and owner; folded when one
 *  of them was in front. */
function withoutPaneLocal(entry: PaneSideDockEntry): PaneSideDockEntry {
  const { files: _files, activeFile: _activeFile, folder: _folder, owner: _owner, parked, ...rest } = entry;
  if (!paneLocalSurface(entry.surface)) return { ...rest, diff: null };
  // The owner's front leaves; what the other tabs had in front comes back.
  const front = parked && !paneLocalSurface(parked.surface) ? parked : { open: false, surface: '' };
  return { ...rest, diff: null, open: front.open, surface: front.surface };
}

/**
 * Session ownership follows the tabs (`paneSessions`: the session ids of each
 * pane's tabs). Owned file tabs, Files tree and diff move with their session's
 * tab to the pane now holding it (unless that pane already has its own), and
 * are released from a pane that no longer holds the tab; with the session's
 * last tab gone (closed, archived, deleted) they are released for good, so the
 * pane is never left hidden behind a session it cannot show.
 *
 * An entry with unsaved file tabs (`isDirty(leafId, fileKey)`) is left exactly
 * where it is: its editors are never remounted elsewhere or merged into
 * another pane's tabs (the editor backup is written asynchronously on
 * unmount, so a remount could load the file before the edits land). When its
 * pane closes it goes the way every pane's dock entry always went.
 */
export function reconcilePaneDockOwners(
  docks: Readonly<Record<string, PaneSideDockEntry>>,
  paneSessions: Readonly<Record<string, readonly string[]>>,
  isDirty: (leafId: string, fileKey: string) => boolean = () => false
): Record<string, PaneSideDockEntry> {
  let next = docks as Record<string, PaneSideDockEntry>;
  const put = (leafId: string, entry: PaneSideDockEntry) => {
    if (next === docks) next = { ...docks };
    next[leafId] = entry;
  };
  for (const [leafId, entry] of Object.entries(docks)) {
    const owner = entry.owner;
    if (!owner || paneSessions[leafId]?.includes(owner)) continue;
    if (entry.files?.some((file) => isDirty(leafId, sideFileKey(file)))) continue;
    put(leafId, withoutPaneLocal(entry));
    const holder = Object.keys(paneSessions).find((id) => id !== leafId && paneSessions[id].includes(owner));
    if (!holder) continue;
    const dest = next[holder] ?? CLOSED_ENTRY;
    if (dest.files?.length || dest.folder || dest.diff) continue;
    put(holder, movedInto(dest, entry, owner));
  }
  return next;
}

/** `dest` taking over `entry`'s file tabs, Files tree and diff (and its front
 *  place when one of them was in front), owned by `owner`. */
function movedInto(dest: PaneSideDockEntry, entry: PaneSideDockEntry, owner: string): PaneSideDockEntry {
  const moved = ownedBy(
    {
      ...dest,
      diff: entry.diff,
      ...(entry.files?.length ? { files: entry.files, activeFile: entry.activeFile } : {}),
      ...(entry.folder ? { folder: entry.folder } : {}),
    },
    owner
  );
  // The owner's front, in front or parked behind another tab's pick, goes
  // along; the destination's own front is parked for its other tabs.
  const front = paneLocalSurface(entry.surface)
    ? { open: entry.open, surface: entry.surface }
    : entry.parked && paneLocalSurface(entry.parked.surface)
      ? entry.parked
      : null;
  if (!front) return moved;
  return {
    ...moved,
    open: front.open,
    surface: front.surface,
    ...(owner ? { parked: { open: dest.open, surface: dest.surface } } : {}),
  };
}

/** `entry` with its file tabs, Files tree and diff owned by `owner` ('' for none). */
function ownedBy(entry: PaneSideDockEntry, owner: string): PaneSideDockEntry {
  if ((entry.owner ?? '') === owner) return entry;
  // A parked front belongs to the previous owner's arrangement.
  const { owner: _owner, parked: _parked, ...rest } = entry;
  return owner ? { ...rest, owner } : rest;
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
function withPaneDockFileActivated(entry: PaneSideDockEntry, fileKey: string): PaneSideDockEntry {
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

/** True when closing `fileKey` removes the dock's last tab: the last file tab
 *  with no other surface tab (the session's Changes) left in the strip. The
 *  dock then closes instead of falling back to its panel view.
 *  `sessionBound`: a session's Changes strip still shows a tab. */
export function paneDockFileCloseEndsDock(entry: PaneSideDockEntry, fileKey: string, sessionBound: boolean): boolean {
  const files = entry.files ?? [];
  if (files.length !== 1 || sideFileKey(files[0]) !== fileKey) return false;
  return !(sessionBound && entry.view === 'session-diff');
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
 *  file simply re-activates. */
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
  sessionsKey,
  leafIdsRef,
  groupsRef,
  paneSessionsRef,
  isDirty,
  ownerOf,
  setDocks,
}: {
  leafKey: string;
  groupsKey: string;
  /** Changes with the session ids of each pane's tabs and the one it shows. */
  sessionsKey: string;
  leafIdsRef: { current: readonly string[] };
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  paneSessionsRef: { current: Readonly<Record<string, readonly string[]>> | undefined };
  isDirty: (leafId: string, fileKey: string) => boolean;
  ownerOf: PaneDockOwnerOf;
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
}): void {
  // Splits, closes, and view moves re-shape the map declaratively: entries
  // follow the live pane list and the CURRENT right-side layout, so a view
  // dragged to the left sidebar can never linger as a pane's active view.
  // Owned entries follow their session's tab first, so a pane that closes
  // while its session moves hands the owned state over before it drops; an
  // owner shown again then takes its parked front back.
  const followOwners = (current: Record<string, PaneSideDockEntry>) => {
    const paneSessions = paneSessionsRef.current;
    const owned = paneSessions ? reconcilePaneDockOwners(current, paneSessions, isDirty) : current;
    let restored = owned;
    for (const [leafId, entry] of Object.entries(owned)) {
      const back = paneDockRestored(entry, ownerOf(leafId));
      if (back !== entry) restored = { ...restored, [leafId]: back };
    }
    return restored;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: leafKey/groupsKey are the change triggers for the ref-held leaf ids and groups
  useEffect(() => {
    setDocks((current) => {
      const next = normalizePaneSideDocks(
        followOwners(current),
        leafIdsRef.current,
        groupsRef.current,
        modeDefaultOpen(),
        true
      );
      return samePaneSideDocks(current, next) ? current : next;
    });
  }, [leafKey, groupsKey]);
  // A tab switch or a tab moving between live panes only re-homes owned
  // state: the live entries are not re-read as if from storage (that drops
  // file tabs opened with a file-scoped access token, which never survive a
  // restart but must survive a tab switch).
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionsKey is the change trigger for the ref-held pane sessions and shown sessions
  useEffect(() => {
    setDocks(followOwners);
  }, [sessionsKey]);
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
      window.localStorage.setItem(PANE_SIDE_DOCK_KEY, JSON.stringify(storablePaneSideDocks(docks)));
    } catch {
      // Dock state remains active for this renderer session.
    }
  }, [docks]);
}

/** The single writer for a pane's dock entry: it applies the caller's update
 *  and keeps the previous entry object when nothing actually changed. */
function usePaneSideDockPatch({
  groupsRef,
  setDocks,
}: {
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
}) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: groupsRef is a ref read at call time; setDocks is a useState setter owned by usePaneSideDocks
  return useCallback(
    (
      leafId: string,
      updater: (entry: PaneSideDockEntry, firstRoot: WorkbenchSideViewId | null) => PaneSideDockEntry
    ) => {
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
          (next.folder ?? null) === (entry.folder ?? null) &&
          (next.owner ?? '') === (entry.owner ?? '') &&
          sameParked(next.parked, entry.parked);
        return same && current[leafId] ? current : { ...current, [leafId]: next };
      });
    },
    []
  );
}

type PaneSideDockPatch = ReturnType<typeof usePaneSideDockPatch>;

/** A diff or file target from a project tool or transcript link: a trimmed
 *  project and a forward-slash, project-relative path. */
function cleanDockTarget(project: string, rel: string): { project: string; rel: string } {
  return {
    project: String(project || '').trim(),
    rel: String(rel || '')
      .replace(/\\/g, '/')
      .replace(/^\/+/, ''),
  };
}

/** Header-tab, open, and fold commands for the unit as a whole. */
function usePaneDockViewCommands(patch: PaneSideDockPatch, ownerOf: PaneDockOwnerOf) {
  /** Header-tab click contract: a panel view lands in the body, the browser lands as its stacked
   *  surface; folding stays with the dock's own toggle/close controls.
   *  One rule for every caller (header buttons, reveals, dock-tab events):
   *  while another session's file tabs, Files tree or diff are in front, a
   *  tab that does not own them opens what it picked, and the owner's front
   *  (which child, open or folded) is parked in `parked`. The file tabs,
   *  Files tree and diff themselves stay in the entry, mounted (unsaved
   *  edits intact); the owner gets its front back when it is shown again
   *  (paneDockRestored). The owner's own pick drops a parked front. */
  const select = useCallback(
    (leafId: string, id: WorkbenchSideViewId) => {
      const owner = ownerOf(leafId);
      patch(leafId, (entry) => {
        const { parked: previous, ...base } = entry;
        const picked =
          id === PANE_DOCK_BROWSER_SURFACE || id === PANE_DOCK_TERMINAL_SURFACE
            ? { ...base, open: true, surface: id }
            : { ...base, open: true, view: id, surface: '' };
        // The owner's front: parked now, or kept parked across another non-owner pick.
        let parked: PaneSideDockEntry['parked'];
        if (paneDockForeign(entry, owner)) parked = { open: entry.open, surface: entry.surface };
        else if (entry.owner && entry.owner !== owner && previous && paneLocalSurface(previous.surface))
          parked = previous;
        return parked ? { ...picked, parked } : picked;
      });
    },
    [patch, ownerOf]
  );
  /** Ensure the dock is open, optionally landing on a specific child. */
  const open = useCallback(
    (leafId: string, id?: WorkbenchSideViewId) => {
      if (id) {
        select(leafId, id);
        return;
      }
      const owner = ownerOf(leafId);
      patch(leafId, (entry, firstRoot) =>
        paneDockForeign(entry, owner) ? withParkedOpen(entry, true, firstRoot) : openedPaneDockEntry(entry, firstRoot)
      );
    },
    [patch, select, ownerOf]
  );
  const setOpen = useCallback(
    (leafId: string, nextOpen: boolean) => {
      const owner = ownerOf(leafId);
      patch(leafId, (entry, firstRoot) => {
        if (paneDockForeign(entry, owner)) return withParkedOpen(entry, nextOpen, firstRoot);
        return nextOpen ? openedPaneDockEntry(entry, firstRoot) : { ...entry, open: false };
      });
    },
    [patch, ownerOf]
  );
  /** Fold/unfold the WHOLE unit — header, panel view, browser,
   *  and diff surfaces together. Children survive the fold. */
  const toggle = useCallback(
    (leafId: string) => {
      const owner = ownerOf(leafId);
      patch(leafId, (entry, firstRoot) => {
        if (paneDockForeign(entry, owner)) return withParkedOpen(entry, !entry.parked?.open, firstRoot);
        return entry.open ? { ...entry, open: false } : openedPaneDockEntry(entry, firstRoot);
      });
    },
    [patch, ownerOf]
  );
  return { select, open, setOpen, toggle };
}

/** The session a pane shows right now ('' for none): it owns what opens in its dock. */
type PaneDockOwnerOf = (leafId: string) => string;

/** Opens and closes the unit's single file diff. */
function usePaneDockDiffCommands(patch: PaneSideDockPatch, ownerOf: PaneDockOwnerOf) {
  const openDiff = useCallback(
    (leafId: string, project: string, rel: string, request: PaneSideDiffRequest) => {
      const { project: cleanProject, rel: cleanRel } = cleanDockTarget(project, rel);
      if (!cleanProject || !cleanRel) return;
      const owner = ownerOf(leafId);
      patch(leafId, (entry) =>
        ownedBy(
          withPaneDockDiffOpened(entry, {
            kind: 'diff',
            project: cleanProject,
            rel: cleanRel,
            ...request,
          }),
          owner
        )
      );
    },
    [patch, ownerOf]
  );
  const closeDiff = useCallback(
    (leafId: string) => {
      patch(leafId, (entry) => withPaneDockDiffClosed(entry));
    },
    [patch]
  );
  return { openDiff, closeDiff };
}

/** The side file tabs: open, close, activate, and keep. */
function usePaneDockFileCommands(
  patch: PaneSideDockPatch,
  /** Dirty keys of the open file tabs; dirty tabs are never evicted. */
  dirtyKeysRef: { current: ReadonlySet<string> },
  ownerOf: PaneDockOwnerOf
) {
  const openFile = useCallback(
    (
      leafId: string,
      project: string,
      rel: string,
      line?: number,
      accessToken?: string,
      column?: number,
      request?: { preview?: boolean; from?: string; sidePreview?: boolean }
    ) => {
      const { project: cleanProject, rel: cleanRel } = cleanDockTarget(project, rel);
      if (!cleanProject || !cleanRel) return;
      const nonce = Date.now();
      const owner = ownerOf(leafId);
      patch(leafId, (entry) =>
        ownedBy(
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
              sidePreview: request?.sidePreview,
              now: nonce,
              isDirty: (fileKey) => dirtyKeysRef.current.has(sideFileTabDirtyKey(leafId, fileKey)),
            }
          ),
          owner
        )
      );
    },
    [patch, dirtyKeysRef, ownerOf]
  );
  const closeFile = useCallback(
    (leafId: string, fileKey?: string) => {
      patch(leafId, (entry) => withPaneDockFileClosed(entry, fileKey));
    },
    [patch]
  );
  const activateFile = useCallback(
    (leafId: string, fileKey: string) => {
      const owner = ownerOf(leafId);
      patch(leafId, (entry) => {
        const activated = withPaneDockFileActivated(entry, fileKey);
        return activated === entry ? entry : ownedBy(activated, owner);
      });
    },
    [patch, ownerOf]
  );
  const keepFile = useCallback(
    (leafId: string, fileKey: string) => {
      patch(leafId, (entry) => withPaneDockFileKept(entry, fileKey));
    },
    [patch]
  );
  return { openFile, closeFile, activateFile, keepFile };
}

/** The Files tree a transcript folder link opens. */
function usePaneDockFolderCommands(patch: PaneSideDockPatch, ownerOf: PaneDockOwnerOf) {
  const openFolder = useCallback(
    (leafId: string, project: string, rel: string) => {
      const cleanProject = String(project || '').trim();
      const trimmedRel = String(rel || '')
        .replace(/\\/g, '/')
        .replace(/^\/+|\/+$/g, '');
      const cleanRel = trimmedRel === '.' ? '' : trimmedRel;
      if (!cleanProject) return;
      const nonce = Date.now();
      const owner = ownerOf(leafId);
      patch(leafId, (entry) =>
        ownedBy(withPaneDockFolderOpened(entry, { project: cleanProject, rel: cleanRel }, nonce), owner)
      );
    },
    [patch, ownerOf]
  );
  const closeFolder = useCallback(
    (leafId: string) => {
      patch(leafId, (entry) => withPaneDockFolderClosed(entry));
    },
    [patch]
  );
  return { openFolder, closeFolder };
}

/** Every command a dock header, tab, or project tool can issue. */
function usePaneSideDockCommands({
  groupsRef,
  dirtyKeysRef,
  ownerOf,
  setDocks,
}: {
  groupsRef: { current: readonly WorkbenchSideViewGroup[] };
  /** Dirty keys of the open file tabs; dirty tabs are never evicted. */
  dirtyKeysRef: { current: ReadonlySet<string> };
  ownerOf: PaneDockOwnerOf;
  setDocks: Dispatch<SetStateAction<Record<string, PaneSideDockEntry>>>;
}) {
  const patch = usePaneSideDockPatch({ groupsRef, setDocks });
  return {
    ...usePaneDockViewCommands(patch, ownerOf),
    ...usePaneDockDiffCommands(patch, ownerOf),
    ...usePaneDockFileCommands(patch, dirtyKeysRef, ownerOf),
    ...usePaneDockFolderCommands(patch, ownerOf),
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
  sessionOf,
  paneSessions,
}: {
  leafIds: readonly string[];
  groups: readonly WorkbenchSideViewGroup[];
  /** The session each pane shows ('' for none), read when something opens in its dock. */
  sessionOf?: (leafId: string) => string;
  /** The session ids of each pane's tabs: owned dock state follows them
   *  (reconcilePaneDockOwners). Absent: ownership is not reconciled. */
  paneSessions?: Readonly<Record<string, readonly string[]>>;
}) {
  const leafKey = leafIds.join('\0');
  const groupsKey = groups.map((group) => group.join(',')).join('|');
  const [docks, setDocks] = useState<Record<string, PaneSideDockEntry>>(() =>
    normalizePaneSideDocks(readStoredPaneSideDocks(), leafIds, groups, modeDefaultOpen())
  );
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const leafIdsRef = useRef(leafIds);
  leafIdsRef.current = leafIds;
  const paneSessionsRef = useRef(paneSessions);
  paneSessionsRef.current = paneSessions;
  const sessionsKey = paneSessions
    ? Object.entries(paneSessions)
        .map(([leafId, ids]) => `${leafId}:${ids.join(',')}`)
        .join('|')
    : '';
  const dirtyKeysRef = useRef<ReadonlySet<string>>(new Set());
  const isDirty = useCallback(
    (leafId: string, fileKey: string) => dirtyKeysRef.current.has(sideFileTabDirtyKey(leafId, fileKey)),
    []
  );
  const sessionOfRef = useRef(sessionOf);
  sessionOfRef.current = sessionOf;
  const ownerOf = useCallback((leafId: string) => sessionOfRef.current?.(leafId) ?? '', []);
  // What each pane shows: an owner shown again gets its parked front back.
  const shownKey = sessionOf ? leafIds.map((leafId) => `${leafId}:${sessionOf(leafId)}`).join('|') : '';
  usePaneSideDockShape({
    leafKey,
    groupsKey,
    sessionsKey: `${sessionsKey}\n${shownKey}`,
    leafIdsRef,
    groupsRef,
    paneSessionsRef,
    isDirty,
    ownerOf,
    setDocks,
  });
  usePaneSideDockStorage(docks);
  useLinkPreviewKeep(setDocks);
  const entryFor = useCallback((leafId: string): PaneSideDockEntry => docks[leafId] ?? CLOSED_ENTRY, [docks]);
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
    ownerOf,
    setDocks,
  });
  return {
    docks,
    dirtyKeysRef,
    entryFor,
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
 * Unified width: inline, the whole unit — diff
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
  // Narrow ladder:
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
  // Overlay decision: the diff PAIR never shrinks inline — the moment panel+diff no longer fit beside the
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
  titleHidden,
  leafId,
  renderDiffHeaderControls,
  onClose,
}: {
  diffShowing: boolean;
  diff: PaneSideDockDiff | null;
  diffView: ReturnType<typeof useDiffViewState>;
  panelTitle: string;
  /** The panel body names itself (the agent panel's own tabs): the row keeps
   *  its controls (⋯ switch, ×) and drops the repeated title. */
  titleHidden: boolean;
  leafId: string;
  renderDiffHeaderControls?: () => ReactNode;
  onClose(): void;
}) {
  const panelActions = useDockPanelActions(leafId);
  return (
    <DockHeaderRow
      className="pane-side-dock-chrome"
      actions={diffShowing ? undefined : panelActions}
      ariaLabel={diffShowing ? t('Changes') : titleHidden ? panelTitle : undefined}
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
        ) : titleHidden ? null : (
          <span className="dock-header-title">{panelTitle}</span>
        )
      }
      onClose={onClose}
    />
  );
}

/** Phone sheet: no title/icon bar of its own — each pane's PC header row is the
 *  top row, and the pane switch (Changes / Browser / Terminal / …, plus the
 *  project Files tree) rides in that row's ⋯ menu through phone-dock-switch. */
function PhoneDockSwitchPublisher({
  groups,
  descriptors,
  activeRoot,
  sessionBound,
  files,
  keepVisualize,
  onSelect,
}: {
  groups: readonly WorkbenchSideViewGroup[];
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  activeRoot: WorkbenchSideViewId | null;
  sessionBound: boolean;
  keepVisualize: boolean;
  files?: { active: boolean; onOpen(): void };
  onSelect(id: WorkbenchSideViewId): void;
}) {
  // Coding panes list Visualize once the agent has shown something; an agent
  // chat's own switch (`keepVisualize`) always does, as its header does.
  const visualizeAvailable = useVisualizeAvailable();
  const items: PhoneDockSwitchItem[] = [];
  if (files) items.push({ id: 'files', label: t('Files'), icon: FolderTree, active: files.active, disabled: false });
  for (const group of groups) {
    const root = group[0];
    const descriptor = root === undefined ? undefined : descriptors.get(root);
    if (!root || !descriptor) continue;
    if (root === 'visualize' && !keepVisualize && !visualizeAvailable) continue;
    items.push({
      id: root,
      label: descriptor.tooltip || descriptor.label,
      icon: descriptor.icon,
      active: activeRoot !== null && group.includes(activeRoot),
      disabled: !sessionBound && SESSION_BOUND_VIEWS.includes(root),
    });
  }
  useEffect(() => {
    publishPhoneDockSwitch(items, (id) => {
      if (id === 'files') files?.onOpen();
      else onSelect(id as WorkbenchSideViewId);
    });
  });
  useEffect(() => () => publishPhoneDockSwitch([], () => {}), []);
  return null;
}
type PaneSideDockProps = {
  leafId: string;
  entry: PaneSideDockEntry;
  /** A session stands behind the pane (its session-owned toggles are live). */
  sessionBound?: boolean;
  /** Phone sheet header: shows the pane project's Files tree. Absent without
   *  a project, so no Files toggle is drawn. */
  onOpenFiles?(): void;
  /** Optional controls rendered in the diff header's left slot after the
   *  file chip (the unified/split menu by default). */
  renderDiffHeaderControls?: () => ReactNode;
  groups: readonly WorkbenchSideViewGroup[];
  /** The phone ⋯ pane switch's children when they differ from `groups` (an
   *  agent-mode chat leaves Changes out; its changes card opens the diff). */
  switchGroups?: readonly WorkbenchSideViewGroup[];
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  focused: boolean;
  /** The session this pane shows; its browser/terminal X closes this dock. */
  sessionId?: string;
  /** Hidden-mount only the focused pane's panel shell after boot. */
  prewarm?: boolean;
  onSelect(id: WorkbenchSideViewId): void;
  /** Folds the unit — the header X, and a re-click on the active icon. */
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
  /** `exiting`: the dock closed, but its sheet's exit slide still carries the
   *  surface (useSheetExit) — it keeps its pixels and nothing else: inert,
   *  aria-hidden, unfocused and not foreground from the close commit. */
  renderBrowserSurface?(active: boolean, exiting: boolean): ReactNode;
  renderTerminalSurface?(active: boolean, exiting: boolean): ReactNode;
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
};

/** Which child of an open unit is showing; every flag is false while folded. */
function paneDockShowing(entry: PaneSideDockEntry, openNow: boolean) {
  const surfaceShowing = openNow && entry.surface !== '';
  const browserShowing = surfaceShowing && entry.surface === PANE_DOCK_BROWSER_SURFACE;
  const terminalShowing = surfaceShowing && entry.surface === PANE_DOCK_TERMINAL_SURFACE;
  const fileShowing = surfaceShowing && paneFileShowing(entry);
  const filesShowing = surfaceShowing && paneFilesShowing(entry);
  const sessionSurfaceShowing = browserShowing || terminalShowing || fileShowing || filesShowing;
  const diffShowing = surfaceShowing && paneDiffShowing(entry);
  // The Changes panel view draws its own DockHeaderRow (SessionDiffPane).
  const sessionDiffPanelShowing =
    openNow && entry.surface === '' && (entry.view === 'session-diff' || entry.view === 'visualize');
  // Width only: the visualize view is a page viewer, so it takes the browser's
  // wide range and shared width instead of the classic 560px panel column.
  const widthSurfaceShowing = sessionSurfaceShowing || (openNow && entry.surface === '' && entry.view === 'visualize');
  return {
    browserShowing,
    terminalShowing,
    fileShowing,
    filesShowing,
    sessionSurfaceShowing,
    widthSurfaceShowing,
    diffShowing,
    sessionDiffPanelShowing,
  };
}

/** Width bounds and preference of the session surface column (terminal or browser). */
function dockSessionWidths(terminalShowing: boolean, terminalPref: number, browserPref: number) {
  return {
    min: terminalShowing ? PANE_SIDE_DOCK_TERMINAL_MIN_WIDTH : PANE_SIDE_DOCK_BROWSER_MIN_WIDTH,
    max: terminalShowing ? PANE_SIDE_DOCK_TERMINAL_MAX_WIDTH : PANE_SIDE_DOCK_BROWSER_MAX_WIDTH,
    pref: terminalShowing ? terminalPref : browserPref,
    initial: terminalShowing ? PANE_SIDE_DOCK_TERMINAL_DEFAULT_WIDTH : PANE_SIDE_DOCK_BROWSER_DEFAULT_WIDTH,
  };
}

/** The panel column's drag range: the session surface's own, else the classic panel's. */
function dockWidthRange(sessionSurfaceShowing: boolean, session: ReturnType<typeof dockSessionWidths>) {
  if (sessionSurfaceShowing) return { min: session.min, max: session.max, initial: session.initial };
  return {
    min: PANE_SIDE_DOCK_MIN_WIDTH,
    max: PANE_SIDE_DOCK_PANEL_MAX_WIDTH,
    initial: DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
  };
}

/** Expanded, the panel fills the sheet (minus its borders and the diff pair column). */
function expandedAsideWidth(
  baseAsideWidth: number,
  expandedRect: { width: number } | null | undefined,
  pairColumnWidth: number
): number {
  if (!expandedRect) return baseAsideWidth;
  return Math.max(baseAsideWidth, Math.round(expandedRect.width) - 2 - pairColumnWidth);
}

type DockDiffSurfaceContext = {
  diffShowing: boolean;
  diffView: ReturnType<typeof useDiffViewState>;
  openFileTab: PaneSideDockProps['openFileTab'];
  onCloseDiff(): void;
};

/** The same deferred diff body serves the stacked 2뎁스 layer and the pair column. */
function renderDockDiffSurface(selection: PaneSideDockDiff, context: DockDiffSurfaceContext, stacked = false) {
  return (
    <DeferredPersistentSurface
      active
      startupDelayMs={DIFF_STARTUP_DELAY_MS}
      fallback={<DesktopLoadingSurface label={t('Loading diff…')} />}
    >
      <ReadyGitDiffPane
        selection={selection}
        active={context.diffShowing}
        onOpenFile={context.openFileTab}
        chrome="side"
        onBack={stacked ? context.onCloseDiff : undefined}
        // The shared chrome row (chip, controls, ⋯ switch, ×) serves the phone too.
        headerControlsExternal
        viewState={context.diffView}
      />
    </DeferredPersistentSurface>
  );
}

/** The stacked children over the panel body — Files tree, file card, browser,
 *  terminal, and the 2뎁스 diff; falsy when none is mounted. */
function renderPaneDockSurfaces(
  props: Pick<
    PaneSideDockProps,
    | 'entry'
    | 'sessionBound'
    | 'onSelect'
    | 'onClose'
    | 'onCloseFile'
    | 'onCloseFileTab'
    | 'onActivateFile'
    | 'onKeepFile'
    | 'onCloseFolder'
    | 'openFileTab'
    | 'renderBrowserSurface'
    | 'renderTerminalSurface'
    | 'renderFilesSurface'
    | 'renderFileSurface'
    | 'renderFileProblems'
  >,
  {
    showing,
    exiting,
    dockBodyMounted,
    twoDepth,
    fileProblems,
    diffContext,
  }: {
    showing: ReturnType<typeof paneDockShowing>;
    exiting: boolean;
    dockBodyMounted: boolean;
    twoDepth: boolean;
    fileProblems: ReturnType<typeof useSideFileProblems>;
    diffContext: DockDiffSurfaceContext;
  }
) {
  const {
    entry,
    sessionBound,
    onSelect,
    onClose,
    onCloseFile,
    onCloseFileTab,
    onActivateFile,
    onKeepFile,
    onCloseFolder,
    openFileTab,
    renderBrowserSurface,
    renderTerminalSurface,
    renderFilesSurface,
    renderFileSurface,
    renderFileProblems,
  } = props;
  const { browserShowing, terminalShowing, fileShowing, filesShowing, diffShowing } = showing;
  const activeFile = paneDockActiveFile(entry);
  // Browser: standalone under the header — a
  // persistent layer stacked over the panel body. In the narrow 2뎁스 stage
  // the diff rides the same layer, with a back step to the list.
  const twoDepthDiff = dockBodyMounted && twoDepth && entry.diff && (
    <div className="workbench-side-surface-slot" data-surface-active={diffShowing ? 'true' : 'false'}>
      {renderDockDiffSurface(entry.diff, diffContext, true)}
    </div>
  );
  const browserSurface = dockBodyMounted ? (renderBrowserSurface?.(browserShowing, exiting) ?? null) : null;
  const terminalSurface = dockBodyMounted ? (renderTerminalSurface?.(terminalShowing, exiting) ?? null) : null;
  const leadingTab =
    sessionBound && entry.view === 'session-diff'
      ? { label: t('Changes'), onSelect: () => onSelect('session-diff') }
      : undefined;
  const fileSurface =
    dockBodyMounted && entry.files?.length ? (
      <PaneDockFileSurface
        files={entry.files}
        activeFile={activeFile}
        active={fileShowing}
        problems={fileProblems}
        renderFileSurface={renderFileSurface}
        renderFileProblems={renderFileProblems}
        onActivateFile={onActivateFile}
        onCloseFileTab={onCloseFileTab}
        onKeepFile={onKeepFile}
        onCloseFile={onCloseFile}
        onClose={onClose}
        openFileTab={openFileTab}
        leadingTab={leadingTab}
      />
    ) : null;
  const filesSurface =
    dockBodyMounted && entry.folder
      ? (renderFilesSurface?.(entry.folder, filesShowing, { onClose: onCloseFolder ?? onClose }) ?? null)
      : null;
  const surfaces = (browserSurface || terminalSurface || fileSurface || filesSurface || twoDepthDiff) && (
    <>
      {filesSurface && <PaneDockSurfaceSlot active={filesShowing}>{filesSurface}</PaneDockSurfaceSlot>}
      {fileSurface}
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
  return surfaces;
}

/** The [diff | panel] row under the header: the paired diff column and the
 *  embedded right-side panel that hosts the views and the stacked surfaces. */
function renderPaneDockMain(
  props: Pick<
    PaneSideDockProps,
    'entry' | 'groups' | 'descriptors' | 'onSelect' | 'onMoveGroup' | 'onMoveView' | 'renderView'
  >,
  {
    openNow,
    closing,
    dockBodyMounted,
    diffColumn,
    surfaces,
    surfacesActive,
    asideWidth,
    panelWidthDrag,
    widthRange,
    widthResizable,
  }: {
    openNow: boolean;
    closing: boolean;
    dockBodyMounted: boolean;
    diffColumn: ReactNode;
    surfaces: ReactNode;
    surfacesActive: boolean;
    asideWidth: number;
    panelWidthDrag: ReturnType<typeof usePanelWidthDrag>;
    widthRange: ReturnType<typeof dockWidthRange>;
    widthResizable: boolean;
  }
) {
  const { entry, groups, descriptors, onSelect, onMoveGroup, onMoveView, renderView } = props;
  return (
    <div className="pane-side-dock-main">
      {diffColumn}
      <WorkbenchSidePanel
        side="right"
        embedded
        hideTabs
        open={openNow}
        exiting={closing}
        groups={groups}
        activeRoot={entry.view}
        surfaces={surfaces}
        surfacesActive={surfacesActive}
        descriptors={descriptors}
        onSelect={onSelect}
        onMoveGroup={onMoveGroup}
        onMoveView={onMoveView}
        widthOverride={asideWidth}
        onWidthDrag={panelWidthDrag}
        widthRange={widthRange}
        resizable={widthResizable}
        renderView={(id, active, titleDragProps) => (dockBodyMounted ? renderView(id, active, titleDragProps) : null)}
        hiddenKey={dockBodyMounted ? 'body' : ''}
      />
    </div>
  );
}

/** The two header pieces of the unit: the desktop chrome row and, on the
 *  focused phone sheet, the pane switch publisher. */
function renderPaneDockHeader(
  props: Pick<
    PaneSideDockProps,
    | 'leafId'
    | 'entry'
    | 'groups'
    | 'switchGroups'
    | 'descriptors'
    | 'focused'
    | 'sessionBound'
    | 'onOpenFiles'
    | 'onSelect'
    | 'onClose'
    | 'renderDiffHeaderControls'
  >,
  {
    openNow,
    mobileSheet,
    showing,
    diffView,
  }: {
    openNow: boolean;
    mobileSheet: boolean;
    showing: ReturnType<typeof paneDockShowing>;
    diffView: ReturnType<typeof useDiffViewState>;
  }
) {
  const {
    leafId,
    entry,
    groups,
    switchGroups,
    descriptors,
    focused,
    sessionBound = false,
    onOpenFiles,
    onSelect,
    onClose,
    renderDiffHeaderControls,
  } = props;
  const { sessionSurfaceShowing, sessionDiffPanelShowing, diffShowing, filesShowing } = showing;
  // ONE header line for the whole unit, spanning
  // [diff | panel] at the PANE strip's height. The child icons moved to the
  // pane strip's right end (PaneDockToggles), so the header names only the
  // showing child and carries the fold X — the Claude Desktop card grammar.
  // The title is text-only: the strip icon already identifies the view.
  const activeRoot = paneDockActiveRoot(entry);
  // The phone sheet names the last shown child through its exit.
  const titleRoot = activeRoot ?? (mobileSheet ? entry.view : null);
  const activeDescriptor = titleRoot ? descriptors.get(titleRoot) : undefined;
  // Desktop: ONE header row per side surface. File, browser and terminal
  // draw their own DockHeaderRow in their slot; the dock draws the row
  // only for the diff and the panel views.
  const chromeRow = openNow && !sessionSurfaceShowing && !sessionDiffPanelShowing && (
    <PaneDockChromeRow
      diffShowing={diffShowing}
      diff={entry.diff}
      diffView={diffView}
      panelTitle={activeDescriptor?.title ?? activeDescriptor?.label ?? ''}
      titleHidden={mobileSheet && titleRoot === 'routines' && !diffShowing}
      leafId={leafId}
      renderDiffHeaderControls={renderDiffHeaderControls}
      onClose={onClose}
    />
  );
  // A session diff is the Changes view whatever panel it was opened over (the
  // desktop pair keeps that panel pressed; the phone shows the diff alone), so
  // the panel behind it (Profile …) is not the pane the switch marks as showing.
  const switchActiveRoot = diffShowing && entry.diff?.source === 'session' ? 'session-diff' : activeRoot;
  const phoneSwitch = mobileSheet && focused && (
    <PhoneDockSwitchPublisher
      groups={switchGroups ?? groups}
      keepVisualize={Boolean(switchGroups)}
      descriptors={descriptors}
      activeRoot={switchActiveRoot}
      sessionBound={sessionBound}
      files={onOpenFiles ? { active: filesShowing, onOpen: onOpenFiles } : undefined}
      onSelect={onSelect}
    />
  );
  return { chromeRow, phoneSwitch };
}

/** Expanded, the dock sheet is pinned to the measured expansion rect. */
function expandedHostStyle(
  dockExpanded: boolean,
  expandedRect: { left: number; top: number; width: number; height: number } | null | undefined
): CSSProperties | undefined {
  if (!dockExpanded || !expandedRect) return undefined;
  return {
    position: 'fixed',
    left: expandedRect.left,
    top: expandedRect.top,
    width: expandedRect.width,
    height: expandedRect.height,
  };
}

export function PaneSideDock(props: PaneSideDockProps) {
  const {
    leafId,
    entry,
    groups,
    focused,
    sessionId = '',
    prewarm = false,
    onClose,
    onCloseDiff,
    onFocusPane,
    openFileTab,
  } = props;
  const openNow = entry.open && (entry.view !== null || entry.surface !== '');
  // The body shows in the commit that opens the sheet, with the sheet.
  const { panelMounted, dockBodyMounted } = useDockMounting(openNow, prewarm);
  const mobileSheet = useMobileRemoteSurface();
  const fileProblems = useSideFileProblems((entry.files?.length ?? 0) > 0);
  // Geometry and semantics follow `openNow`.
  const showing = paneDockShowing(entry, openNow);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { browserShowing, terminalShowing, widthSurfaceShowing, diffShowing, sessionDiffPanelShowing } = showing;
  // The dock measures its own pane cell (see resolveDockLayout).
  const { panelPref, setPanelPref, diffPref, setDiffPref, browserPref, setBrowserPref, terminalPref, setTerminalPref } =
    useDockWidthPrefs();
  // The dock header mounts the diff controls; the pane body shares this state.
  const diffView = useDiffViewState('pane-side-dock');
  // The workspace column's inline-dock flag (useInlineDockFlag): rewritten by
  // every render, false until the layout below resolves an inline dock. Called
  // before every measuring hook: on the commit that creates the host its
  // layout effect is the one that claims, and it must run before theirs.
  const inlineDock = useRef(false);
  inlineDock.current = false;
  useInlineDockFlag(hostRef, inlineDock);
  // The phone sheet slides closed with its last open body on it
  // (useSheetExit); what the body's children treat as showing follows that.
  const closing = useSheetExit(hostRef, openNow, mobileSheet);
  const lastOpenEntry = useRef(entry);
  if (openNow) lastOpenEntry.current = entry;
  const bodyProps = closing ? { ...props, entry: lastOpenEntry.current } : props;
  const bodyOpen = openNow || closing;
  const bodyShowing = paneDockShowing(bodyProps.entry, bodyOpen);
  const cellWidth = useDockCellWidth(hostRef, openNow);
  // Desktop placement (Settings → Side panel position); the phone sheet keeps
  // its overlay grammar, so it always resolves to the right-hand layout.
  const desktopPlacement = useSidePanelPlacement();
  const placement = mobileSheet ? 'right' : desktopPlacement;
  const bottom = paneDockResizeAxis(placement) === 'height';
  const [heightPref, setHeightPref] = useState(() =>
    readStoredWidth(PANE_SIDE_DOCK_HEIGHT_KEY, PANE_SIDE_DOCK_MIN_HEIGHT, 4_000, PANE_SIDE_DOCK_DEFAULT_HEIGHT)
  );
  // The chat floor is held against the room the strip, Problems panel and
  // footer leave, re-measured as they open, close or resize.
  const dockRoom = useDockRoomHeight(hostRef, openNow && bottom);
  const dockHeight = clampPaneDockHeight(heightPref, dockRoom);
  const heightDrag = useDockHeightDrag({
    heightPref,
    setHeightPref,
    renderedHeight: dockHeight,
    room: dockRoom,
    storageKey: PANE_SIDE_DOCK_HEIGHT_KEY,
  });
  // The pane cell switches to its one-column grid (dock row under the chat)
  // through this flag rather than a :has() over the whole cell.
  const hostMounted = groups.length > 0;
  useLayoutEffect(() => {
    const cell = hostRef.current?.parentElement;
    if (!cell || !bottom || !hostMounted) return undefined;
    cell.dataset.dockPlacement = 'bottom';
    return () => {
      delete cell.dataset.dockPlacement;
    };
  }, [bottom, hostMounted]);
  const { expanded, expandedRect, restWidth, restHeight, toggleExpanded } = useDockExpansion(
    hostRef,
    entry.surface,
    entry.view,
    openNow
  );
  const panelWidthDrag = usePanelWidthDrag({
    terminalShowing,
    sessionSurfaceShowing: widthSurfaceShowing,
    terminalPref,
    setTerminalPref,
    browserPref,
    setBrowserPref,
    panelPref,
    setPanelPref,
    storageKeys: {
      terminal: PANE_SIDE_DOCK_TERMINAL_WIDTH_KEY,
      browser: PANE_SIDE_DOCK_BROWSER_WIDTH_KEY,
      panel: PANE_SIDE_DOCK_WIDTH_KEY,
    },
  });
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
  // task waited 30–70ms for it. The
  // column now only HIDES on close; the retained tree is dropped later, in
  // idle time and as a transition, so typing keeps its own frames. A reopen
  // of the same file inside that window reuses the live tree.
  const retainedDiff = useRetainedDiff(entry.diff);
  // The hidden column keeps its last shown width: the diff library observes
  // its wrapper's size and re-lays out every row on any change, so a width
  // going to zero on close would cost as much as the unmount did.
  const shownDiffWidth = useRef(0);
  useDockCloseRequest(
    browserShowing || terminalShowing || sessionDiffPanelShowing,
    sessionDiffPanelShowing ? (entry.view ?? '') : entry.surface,
    focused,
    onClose,
    sessionId
  );
  // The pane edge this render commits (recorded below); its layout effect
  // re-measures the transcripts it narrowed or widened in the same frame.
  const committedEdge = useRef('');
  const syncedEdge = useRef('');
  useLayoutEffect(() => {
    if (committedEdge.current === syncedEdge.current) return;
    syncedEdge.current = committedEdge.current;
    syncTranscriptWidths();
  });
  if (groups.length === 0) return null;
  const sheetFrame = mobileSheet ? 0 : PANE_SIDE_DOCK_SHEET_FRAME_WIDTH;
  const session = dockSessionWidths(terminalShowing, terminalPref, browserPref);
  // Below the chat the unit owns the cell's whole width (its two borders
  // aside): no conversation floor to leave beside it, so it never overlays.
  let room = Number.POSITIVE_INFINITY;
  if (cellWidth > 0) room = bottom ? cellWidth - 2 : cellWidth - DESKTOP_WORKSPACE_MIN_WIDTH - sheetFrame;
  const {
    diffDesired,
    twoDepth,
    pairShowing,
    overlay: sideOverlay,
    baseAsideWidth,
    diffWidth,
  } = resolveDockLayout({
    cellWidth,
    room,
    openNow,
    mobileSheet,
    diffShowing,
    sessionSurfaceShowing: widthSurfaceShowing,
    sessionMin: session.min,
    sessionPref: session.pref,
    panelPref,
    diffPref,
  });
  const overlay = sideOverlay && !bottom;
  const dockExpanded = expanded && openNow && !mobileSheet;
  // Exactly the host's data-open="true", data-overlay≠"true", data-expanded≠"true" below.
  inlineDock.current = openNow && !overlay && !dockExpanded;
  const dockExpandValue = mobileSheet ? null : { expanded: dockExpanded, toggle: toggleExpanded };
  const asideWidth = expandedAsideWidth(baseAsideWidth, expandedRect, pairShowing ? diffWidth : 0);
  committedEdge.current = `${placement}|${openNow}|${overlay}|${dockExpanded}|${asideWidth}|${pairShowing ? diffWidth : 0}|${bottom ? dockHeight : 0}`;
  const diffContext: DockDiffSurfaceContext = {
    diffShowing: bodyShowing.diffShowing,
    diffView,
    openFileTab,
    onCloseDiff,
  };
  const surfaces = renderPaneDockSurfaces(bodyProps, {
    showing: bodyShowing,
    exiting: closing,
    dockBodyMounted,
    twoDepth,
    fileProblems,
    diffContext,
  });
  // File Diff: PAIRED to the LEFT of the panel view under the same header
  // selection; a project-tool click replaces the file in place. The narrow
  // 2뎁스 stage retires the pair column — the diff stacks over the panel.
  const columnDiff = entry.diff ?? retainedDiff;
  if (pairShowing && diffWidth > 0) shownDiffWidth.current = diffWidth;
  const columnWidth = pairShowing ? diffWidth : shownDiffWidth.current || diffDesired;
  const diffColumn = dockBodyMounted && columnDiff && !twoDepth && (
    <PaneDockDiffColumn showing={diffShowing} width={columnWidth} resizeProps={diffResizeProps}>
      {renderDockDiffSurface(columnDiff, diffContext)}
    </PaneDockDiffColumn>
  );
  const { chromeRow, phoneSwitch } = renderPaneDockHeader(bodyProps, {
    openNow: bodyOpen,
    mobileSheet,
    showing: bodyShowing,
    diffView,
  });
  // The spacer holds the dock's row (below) or column (beside) while expanded.
  const spacerStyle = bottom ? { height: restHeight.current } : { width: restWidth.current };
  return (
    <PaneDockExpandContext.Provider value={dockExpandValue}>
      {dockExpanded && expandedRect && <div className="pane-side-dock-spacer" style={spacerStyle} aria-hidden="true" />}
      <div
        className="pane-side-dock"
        ref={hostRef}
        data-pane-id={leafId}
        data-placement={placement}
        data-open={openNow ? 'true' : 'false'}
        data-overlay={overlay ? 'true' : 'false'}
        data-expanded={dockExpanded ? 'true' : 'false'}
        data-closing={closing ? 'true' : undefined}
        // The sliding-out sheet is already closed: nothing on it is reachable.
        inert={closing || undefined}
        aria-hidden={closing || undefined}
        style={
          expandedHostStyle(dockExpanded, expandedRect) ?? (bottom && openNow ? { height: dockHeight } : undefined)
        }
        onPointerDownCapture={
          focused
            ? undefined
            : (event) => {
                if (event.button === 0) onFocusPane();
              }
        }
      >
        {bottom && openNow && !dockExpanded && (
          // biome-ignore lint/a11y/useSemanticElements: a draggable resize handle, not a thematic break; <hr> brings its own border and margins.
          <div
            className="pane-side-dock-height-resize"
            role="separator"
            aria-orientation="horizontal"
            {...heightDrag}
          />
        )}
        {chromeRow}
        {phoneSwitch}
        {panelMounted &&
          renderPaneDockMain(bodyProps, {
            openNow,
            closing,
            dockBodyMounted,
            diffColumn,
            surfaces,
            surfacesActive: bodyShowing.sessionSurfaceShowing || twoDepth,
            asideWidth,
            panelWidthDrag,
            widthRange: dockWidthRange(widthSurfaceShowing, session),
            // Below the chat the panel fills the width; only the diff pair
            // keeps its width edge (between the diff and the panel).
            widthResizable: !bottom || pairShowing,
          })}
      </div>
    </PaneDockExpandContext.Provider>
  );
}
