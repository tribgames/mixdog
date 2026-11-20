import type { WorkspaceSelection } from './nav-types';
import {
  closeSideFileTab,
  keepSideFileTabs,
  planSideFileOpen,
  sameSideFiles,
  sideFileKey,
  type PaneSideDockFile,
  type SideFileOpenOptions,
} from './side-file-tabs';
import { navigationKey } from './text-format';
import type { WorkbenchSideViewGroup, WorkbenchSideViewId } from './workbench-side-view-layout';

export type PaneSideDockDiff = Extract<WorkspaceSelection, { kind: 'diff' }>;
export type PaneSideDiffRequest = {
  source: 'staged' | 'unstaged' | 'commit' | 'session';
  hash?: string;
  untracked?: boolean;
};
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

export const PANE_SIDE_DOCK_KEY = 'mixdog.desktop.pane-side-dock.v1';
/** One shared width preference for every side-dock surface (panel, browser/
 *  file, terminal): resizing any of them sets the width the next one opens at.
 *  v2 replaces the per-surface v1 keys, which are no longer read except the
 *  browser one below as the first-run seed. */
export const PANE_SIDE_DOCK_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-width.v2';
const PANE_SIDE_DOCK_LEGACY_BROWSER_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-browser-width.v1';
/** Every side-dock surface opens at this width. */
export const PANE_SIDE_DOCK_DEFAULT_WIDTH = 500;
/** Every side-dock surface floors at the same width (Claude stops at ~282px);
 *  anything narrower is the overlay/takeover ladder's job. */
export const PANE_SIDE_DOCK_MIN_WIDTH = 280;
/** Every side-dock surface (panel, diff, browser/file, terminal) caps at the
 *  same width; resolveDockLayout still reserves the conversation's floor. */
export const PANE_SIDE_DOCK_MAX_WIDTH = 1160;
/** Diff pair column OPENS readable; its width is a preference separate from
 *  the browser's. */
export const PANE_SIDE_DOCK_DIFF_WIDTH_KEY = 'mixdog.desktop.pane-side-dock-diff-width.v1';
export const PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH = PANE_SIDE_DOCK_DEFAULT_WIDTH;
/** The dock is its own floating sheet: its left gap plus the two 1px borders
 *  come on top of the measured column width on desktop. Keep in step with
 *  --mx-sheet-gap in pane-layout.css. */
export const PANE_SIDE_DOCK_SHEET_FRAME_WIDTH = 2 + 2;
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
export const LEGACY_SIDE_SURFACE_KEYS = [
  'mixdog.desktop.pane-side-surfaces.v1',
  'mixdog.desktop.pane-side-surface-width.v1',
  'mixdog.desktop.pane-side-dock-surface-width.v1',
] as const;

export const CLOSED_ENTRY: PaneSideDockEntry = {
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

export function firstPanelRoot(groups: readonly WorkbenchSideViewGroup[]): WorkbenchSideViewId | null {
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

export function sameParked(a: PaneSideDockEntry['parked'], b: PaneSideDockEntry['parked']): boolean {
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
export function withParkedOpen(
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
export function ownedBy(entry: PaneSideDockEntry, owner: string): PaneSideDockEntry {
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

/** The shared dock width: the v2 key wins whenever it holds anything (a
 *  corrupt value falls back to the default); only an absent or empty v2 seeds
 *  from the legacy browser key. */
export function readSharedDockWidth(): number {
  let hasCurrent = false;
  try {
    hasCurrent = Boolean(window.localStorage.getItem(PANE_SIDE_DOCK_WIDTH_KEY));
  } catch {
    /* unreadable storage: defaults */
  }
  return readStoredWidth(
    hasCurrent ? PANE_SIDE_DOCK_WIDTH_KEY : PANE_SIDE_DOCK_LEGACY_BROWSER_WIDTH_KEY,
    PANE_SIDE_DOCK_MIN_WIDTH,
    PANE_SIDE_DOCK_MAX_WIDTH,
    PANE_SIDE_DOCK_DEFAULT_WIDTH
  );
}
