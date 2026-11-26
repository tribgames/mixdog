import { DESKTOP_WORKSPACE_MIN_WIDTH } from '../shared/window-layout';
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
  /** Who the file tabs, Files tree and diff in the entry belong to: the
   *  session (`paneDockOwnerOf`), or the New Task draft, that brought them
   *  up; they show beside that tab only. Absent when the pane showed neither
   *  (a main file tab). */
  owner?: string;
  /** The other tabs' file tabs, Files tree and diff, by owner, while the
   *  owner's are in front: each kept as it stood, front included, and back in
   *  front when its tab is shown or opens something (`withPaneLocalOwner`). */
  held?: Readonly<Record<string, PaneDockHeld>>;
  /** The front (open, surface) the tabs that are not in front keep while
   *  the other side is: with the owner's file tabs, Files tree or diff in
   *  front, what every other tab sees (a pane-level view, open or folded);
   *  with another tab's pick in front, the owner's front, given back when
   *  the owner is shown again. Absent when nothing is parked. */
  parked?: { open: boolean; surface: string };
};

/** One owner's file tabs, Files tree and diff held behind another's, with
 *  the front the entry had for it then. */
export type PaneDockHeld = Pick<
  PaneSideDockEntry,
  'open' | 'surface' | 'diff' | 'files' | 'activeFile' | 'folder' | 'parked'
>;

/** The owner key of a pane's tab: a session's id, or the New Task draft's
 *  scope (`draft:<id>`, as composer-draft records its promotion); '' for
 *  any other tab. */
export function paneDockOwnerOf(selection: WorkspaceSelection | null | undefined): string {
  if (selection?.kind === 'session') return selection.id;
  if (selection?.kind === 'new') return `draft:${selection.draftId || 'default'}`;
  return '';
}

export const PANE_SIDE_DOCK_KEY = 'mixdog.desktop.pane-side-dock.v1';
/** The session panel's one width for every pane. */
export const SESSION_RAIL_WIDTH_KEY = 'mixdog.desktop.session-rail-width.v1';
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
/** Agent session side panel holds a full conversation, so it shares the main
 *  workspace pane's minimum horizontal width. */
export const PANE_SIDE_DOCK_AGENT_SESSION_MIN_WIDTH = DESKTOP_WORKSPACE_MIN_WIDTH;
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
/** A sheet floating over the conversation leaves it this much on its left. */
export const PANE_SIDE_OVERLAY_INSET = 48;
/** Where a sheet at a pane's right edge stands: beside the conversation,
 *  over it, or over the whole pane. */
export type PaneSidePresentation = 'beside' | 'overlay' | 'full';

/** The most a sheet floating over a pane cell `cellWidth` wide may take
 *  (unbounded before the cell is measured). */
export function paneOverlayRoom(cellWidth: number): number {
  return cellWidth > 0 ? cellWidth - PANE_SIDE_OVERLAY_INSET : Number.POSITIVE_INFINITY;
}

/** What the conversation, at its floor, leaves a sheet with a `sheetFrame`
 *  frame beside it in a pane cell `cellWidth` wide (unbounded before the cell
 *  is measured): the `room` of every surface's ladder at the pane's side. */
export function paneSideRoom(cellWidth: number, sheetFrame: number): number {
  return cellWidth > 0 ? cellWidth - DESKTOP_WORKSPACE_MIN_WIDTH - sheetFrame : Number.POSITIVE_INFINITY;
}

/** The side dock's ladder for a sheet at the right edge of a pane cell
 *  `cellWidth` wide: beside the conversation while `room`, what the
 *  conversation leaves it there, holds `inlineFloor`; over the conversation
 *  when not; the whole pane once floating over it would leave the sheet less
 *  than `columnMin`. `avail` is the most width the sheet may take there. */
export function paneSidePresentation({
  cellWidth,
  room,
  columnMin,
  inlineFloor,
}: {
  cellWidth: number;
  room: number;
  columnMin: number;
  inlineFloor: number;
}): { presentation: PaneSidePresentation; avail: number } {
  const overlayRoom = paneOverlayRoom(cellWidth);
  if (overlayRoom < columnMin) return { presentation: 'full', avail: cellWidth };
  if (room < inlineFloor) return { presentation: 'overlay', avail: Math.max(columnMin, overlayRoom) };
  return { presentation: 'beside', avail: room };
}
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
/** The unit is open on a child (a folded unit, or one with nothing to show, is not). */
export function paneDockOpenNow(entry: Pick<PaneSideDockEntry, 'open' | 'view' | 'surface'>): boolean {
  return entry.open && (entry.view !== null || entry.surface !== '');
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
    const heldTokens = Object.values(entry.held ?? {}).some(hasTokenFile);
    if (!hasTokenFile(entry) && !heldTokens) continue;
    const front = withoutTokenFiles(entry);
    const held = heldTokens
      ? Object.fromEntries(Object.entries(entry.held ?? {}).map(([owner, part]) => [owner, withoutTokenFiles(part)]))
      : entry.held;
    out = { ...out, [leafId]: held ? { ...front, held } : front };
  }
  return out;
}

function hasTokenFile(part: Pick<PaneSideDockEntry, 'files'>): boolean {
  return Boolean(part.files?.some((file) => file.accessToken !== undefined));
}

function withoutTokenFiles<T extends Pick<PaneSideDockEntry, 'files' | 'activeFile' | 'surface'>>(part: T): T {
  if (!hasTokenFile(part)) return part;
  const { files: _files, activeFile: _activeFile, ...rest } = part;
  const files = (part.files ?? []).filter((file) => file.accessToken === undefined);
  const activeFile = files.some((file) => sideFileKey(file) === part.activeFile) ? part.activeFile : undefined;
  const surface = files.length === 0 && part.surface === PANE_DOCK_FILE_SURFACE ? '' : part.surface;
  return { ...rest, surface, ...(files.length > 0 ? { files, ...(activeFile ? { activeFile } : {}) } : {}) } as T;
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

type DockNormalizeContext = {
  members: ReadonlySet<WorkbenchSideViewId>;
  sessionSurfaces: ReadonlySet<string>;
  firstRoot: WorkbenchSideViewId | null;
  defaultOpen: boolean;
  live: boolean;
};

function storedDockDiff(entry: Record<string, unknown> | null, storedSurface: string): PaneSideDockDiff | null {
  if (entry && isDockDiff(entry.diff)) return entry.diff;
  const legacy = entry && Array.isArray(entry.diffs) ? entry.diffs.filter(isDockDiff) : [];
  return legacy.find((item) => navigationKey(item) === storedSurface) ?? legacy.at(-1) ?? null;
}

function storedDockParked(
  entry: Record<string, unknown> | null,
  owner: string,
  sessionSurfaces: ReadonlySet<string>,
  held: { diff: PaneSideDockDiff | null; files: readonly PaneSideDockFile[]; folder: PaneSideDockFolder | null }
): PaneSideDockEntry['parked'] {
  const stored = entry?.parked && typeof entry.parked === 'object' ? (entry.parked as Record<string, unknown>) : null;
  const surface = typeof stored?.surface === 'string' ? stored.surface : null;
  const valid =
    owner !== '' &&
    surface !== null &&
    (surface === '' ||
      sessionSurfaces.has(surface) ||
      (surface === PANE_DOCK_DIFF_SURFACE && held.diff !== null) ||
      (surface === PANE_DOCK_FILE_SURFACE && held.files.length > 0) ||
      (surface === PANE_DOCK_FILES_SURFACE && held.folder !== null));
  return valid ? { open: stored?.open === true, surface: surface ?? '' } : undefined;
}

function normalizePaneSideDockEntry(raw: unknown, context: DockNormalizeContext): PaneSideDockEntry {
  const { members, sessionSurfaces, firstRoot, defaultOpen, live } = context;
  const entry = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const storedSurface = entry && typeof entry.surface === 'string' ? entry.surface : '';
  const diff = storedDockDiff(entry, storedSurface);
  const storedView =
    entry && typeof entry.view === 'string' && members.has(entry.view as WorkbenchSideViewId)
      ? (entry.view as WorkbenchSideViewId)
      : null;
  const view = storedView ?? firstRoot;
  let surface = '';
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
  const parked = storedDockParked(entry, owner, sessionSurfaces, { diff, files, folder });
  const held = storedDockHeld(entry, owner, live);
  return {
    open,
    view,
    surface,
    diff,
    ...(files.length > 0 && activeFile ? { files: entryFiles(entry, files), activeFile } : {}),
    ...(folder ? { folder } : {}),
    ...(owner ? { owner } : {}),
    ...(parked ? { parked } : {}),
    ...(held ? { held } : {}),
  };
}

/** The other owners' held file tabs, Files tree and diff; a part holding
 *  nothing, or the front owner's own, drops. Keeps the live map when nothing changed. */
function storedDockHeld(
  entry: Record<string, unknown> | null,
  owner: string,
  live: boolean
): Readonly<Record<string, PaneDockHeld>> | undefined {
  const raw = entry?.held && typeof entry.held === 'object' ? (entry.held as Record<string, unknown>) : null;
  if (!raw) return undefined;
  const held: Record<string, PaneDockHeld> = {};
  for (const [key, value] of Object.entries(raw)) {
    const part = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
    if (!part || key === owner) continue;
    const files = storedDockFiles(part, live);
    const folder = isDockFolder(part.folder) ? part.folder : null;
    const diff = isDockDiff(part.diff) ? part.diff : null;
    if (files.length === 0 && !folder && !diff) continue;
    const surface = typeof part.surface === 'string' && paneLocalSurface(part.surface) ? part.surface : '';
    const last = files.at(-1);
    const activeFile =
      typeof part.activeFile === 'string' && files.some((file) => sideFileKey(file) === part.activeFile)
        ? part.activeFile
        : last && sideFileKey(last);
    const stored = part.parked && typeof part.parked === 'object' ? (part.parked as Record<string, unknown>) : null;
    held[key] = {
      open: part.open === true && surface !== '',
      surface,
      diff,
      ...(files.length > 0 ? { files: entryFiles(part, files), activeFile } : {}),
      ...(folder ? { folder } : {}),
      ...(stored && typeof stored.surface === 'string'
        ? { parked: { open: stored.open === true, surface: stored.surface } }
        : {}),
    };
  }
  if (Object.keys(held).length === 0) return undefined;
  const liveHeld = entry?.held as Readonly<Record<string, PaneDockHeld>>;
  return sameHeld(liveHeld, held) ? liveHeld : held;
}

export function sameHeld(a: PaneSideDockEntry['held'], b: PaneSideDockEntry['held']): boolean {
  if (a === b) return true;
  const keys = Object.keys(a ?? {});
  if (keys.length !== Object.keys(b ?? {}).length) return false;
  return keys.every((key) => {
    const left = a?.[key];
    const right = b?.[key];
    return (
      Boolean(left && right) &&
      left?.open === right?.open &&
      left?.surface === right?.surface &&
      left?.diff === right?.diff &&
      sameSideFiles(left?.files, right?.files) &&
      (left?.activeFile ?? null) === (right?.activeFile ?? null) &&
      (left?.folder ?? null) === (right?.folder ?? null) &&
      sameParked(left?.parked, right?.parked)
    );
  });
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
  const context: DockNormalizeContext = {
    members: new Set<WorkbenchSideViewId>(groups.flat().filter(isPanelView)),
    sessionSurfaces: new Set<string>(
      groups.flat().filter((id) => id === PANE_DOCK_BROWSER_SURFACE || id === PANE_DOCK_TERMINAL_SURFACE)
    ),
    firstRoot: firstPanelRoot(groups),
    defaultOpen,
    live,
  };
  const next: Record<string, PaneSideDockEntry> = {};
  for (const leafId of leafIds) next[leafId] = normalizePaneSideDockEntry(record[leafId], context);
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
      sameParked(a.parked, b.parked) &&
      sameHeld(a.held, b.held)
    );
  });
}

export function sameParked(a: PaneSideDockEntry['parked'], b: PaneSideDockEntry['parked']): boolean {
  return a === b || (Boolean(a) && Boolean(b) && a?.open === b?.open && a?.surface === b?.surface);
}

/** `entry` as its owner `session` sees it: its held file tabs, Files tree and
 *  diff back in front (`withPaneLocalOwner`), the owner's parked front back
 *  in front, and what other tabs had in front parked for them. `entry`
 *  itself when nothing of `session`'s is held or parked. */
export function paneDockRestored(entry: PaneSideDockEntry, session: string): PaneSideDockEntry {
  const own = entry.held?.[session] ? withPaneLocalOwner(entry, session) : entry;
  const parked = own.parked;
  if (!session || own.owner !== session || !parked || !paneLocalSurface(parked.surface)) return own;
  if (paneLocalSurface(own.surface)) return own;
  return { ...own, open: parked.open, surface: parked.surface, parked: { open: own.open, surface: own.surface } };
}

function hasPaneLocal(part: Pick<PaneSideDockEntry, 'files' | 'folder' | 'diff'>): boolean {
  return Boolean(part.files?.length || part.folder || part.diff);
}

/** The front owner's file tabs, Files tree and diff as they stand, front included. */
function heldOf(entry: PaneSideDockEntry): PaneDockHeld {
  const { open, surface, diff, files, activeFile, folder, parked } = entry;
  return {
    open,
    surface,
    diff,
    ...(files?.length ? { files, activeFile } : {}),
    ...(folder ? { folder } : {}),
    ...(parked ? { parked } : {}),
  };
}

function withHeld(entry: PaneSideDockEntry, held: Readonly<Record<string, PaneDockHeld>>): PaneSideDockEntry {
  const { held: _held, ...rest } = entry;
  return Object.keys(held).length > 0 ? { ...rest, held } : rest;
}

/** `entry` with `owner`'s file tabs, Files tree and diff in front: the front
 *  owner's are held for it, front included, and `owner`'s held ones come
 *  back as they stood. `entry` itself when `owner` already owns the front,
 *  or neither has anything of its own. Nothing is merged: one tab's file tabs
 *  never show beside another's. */
export function withPaneLocalOwner(entry: PaneSideDockEntry, owner: string): PaneSideDockEntry {
  const current = entry.owner ?? '';
  const incoming = entry.held?.[owner];
  if (current === owner || (!incoming && !hasPaneLocal(entry))) return entry;
  const { [owner]: _incoming, ...others } = entry.held ?? {};
  const outgoing = hasPaneLocal(entry);
  const held = outgoing ? { ...others, [current]: heldOf(entry) } : others;
  const next = outgoing ? withoutPaneLocal(withHeld(entry, {})) : withHeld(entry, {});
  return withHeld(incoming ? movedInto(next, incoming, owner) : next, held);
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

/** The pane now holding `owner`'s tab ('' for none), unless it already has
 *  `owner`'s own dock: the only pane `owner`'s dock parts can move to. */
export function paneDockHandoverTarget(
  docks: Readonly<Record<string, PaneSideDockEntry>>,
  paneSessions: Readonly<Record<string, readonly string[]>>,
  owner: string,
  from: string
): string {
  const holder = Object.keys(paneSessions).find((id) => id !== from && (paneSessions[id]?.includes(owner) ?? false));
  const dest = holder ? (docks[holder] ?? CLOSED_ENTRY) : null;
  return holder && dest && (dest.owner ?? '') !== owner && !dest.held?.[owner] ? holder : '';
}

/**
 * Session ownership follows the tabs (`paneSessions`: the session ids of each
 * pane's tabs). Owned file tabs, Files tree and diff move with their session's
 * tab to the pane now holding it (unless that pane already has its own), and
 * are released from a pane that no longer holds the tab; with the session's
 * last tab gone (closed, archived, deleted) they are released for good, so the
 * pane is never left hidden behind a session it cannot show.
 *
 * A side file's editor follows its file, not its pane or owner
 * (side-file-editor-portals), so a rename or a move never remounts it. Only a
 * release would drop unsaved file tabs (`isDirty(fileKey)`), and that is
 * left undone: they stay exactly where they are, as does a move into a pane
 * that already holds that owner's own. When its pane closes it goes the way
 * every pane's dock entry always went.
 */
export function reconcilePaneDockOwners(
  docks: Readonly<Record<string, PaneSideDockEntry>>,
  paneSessions: Readonly<Record<string, readonly string[]>>,
  isDirty: (fileKey: string) => boolean = () => false,
  /** The session a New Task draft's owner key became ('' for none). */
  successorOf: (owner: string) => string = () => ''
): Record<string, PaneSideDockEntry> {
  let next = docks as Record<string, PaneSideDockEntry>;
  const put = (leafId: string, entry: PaneSideDockEntry) => {
    if (next === docks) next = { ...docks };
    next[leafId] = entry;
  };
  const tabbed = (leafId: string, owner: string) => paneSessions[leafId]?.includes(owner) ?? false;
  const dirty = (part: Pick<PaneSideDockEntry, 'files'>) =>
    part.files?.some((file) => isDirty(sideFileKey(file))) ?? false;
  const destinationOf = (owner: string, from: string) => paneDockHandoverTarget(next, paneSessions, owner, from);
  /** `part` of `owner` joins `holder`: in front when that pane has nothing of
   *  its own there, else held behind what it has. */
  const moveTo = (owner: string, part: PaneDockHeld, holder: string) => {
    const dest = next[holder] ?? CLOSED_ENTRY;
    put(holder, hasPaneLocal(dest) ? withHeld(dest, { ...dest.held, [owner]: part }) : movedInto(dest, part, owner));
  };
  for (const leafId of Object.keys(docks)) {
    const entry = next[leafId];
    const owner = entry.owner;
    if (owner && !tabbed(leafId, owner)) {
      // A draft became a session in this pane: its file tabs are that session's.
      const successor = successorOf(owner);
      if (successor && tabbed(leafId, successor) && !entry.held?.[successor])
        put(leafId, { ...entry, owner: successor });
      else {
        const holder = destinationOf(owner, leafId);
        if (holder || !dirty(entry)) {
          put(leafId, withoutPaneLocal(entry));
          if (holder) moveTo(owner, heldOf(entry), holder);
        }
      }
    }
    for (const [heldOwner, part] of Object.entries(next[leafId].held ?? {})) {
      if (!heldOwner || tabbed(leafId, heldOwner)) continue;
      const current = next[leafId];
      const { [heldOwner]: _part, ...rest } = current.held ?? {};
      const successor = successorOf(heldOwner);
      if (successor && tabbed(leafId, successor) && current.owner !== successor && !rest[successor]) {
        put(leafId, withHeld(current, { ...rest, [successor]: part }));
        continue;
      }
      const holder = destinationOf(heldOwner, leafId);
      if (!holder && dirty(part)) continue;
      put(leafId, withHeld(current, rest));
      if (holder) moveTo(heldOwner, part, holder);
    }
  }
  return next;
}

/** The dirty side files of a pane's dock entry that closing a tab with owner
 *  key `owner` leaves with no editor: every part when the pane closes with
 *  the tab (its entry drops out), else what `owner` holds there (nothing else
 *  can show it; reconcilePaneDockOwners keeps it in place). A part whose
 *  owner keeps a tab in another pane follows that tab instead, when
 *  `tabbedElsewhere` (paneDockHandoverTarget) names a pane to take it. */
export function dirtySideFilesClosedWith(
  entry: PaneSideDockEntry | undefined,
  owner: string,
  paneCloses: boolean,
  tabbedElsewhere: (owner: string) => boolean,
  isDirty: (fileKey: string) => boolean
): PaneSideDockFile[] {
  if (!entry) return [];
  const parts: Array<[string, Pick<PaneSideDockEntry, 'files'>]> = [
    [entry.owner ?? '', entry],
    ...Object.entries(entry.held ?? {}),
  ];
  return parts
    .filter(([partOwner]) =>
      paneCloses ? !(partOwner && tabbedElsewhere(partOwner)) : Boolean(owner) && partOwner === owner
    )
    .flatMap(([, part]) => (part.files ?? []).filter((file) => isDirty(sideFileKey(file))));
}

/** `dest` taking over `entry`'s file tabs, Files tree and diff (and its front
 *  place when one of them was in front), owned by `owner`. */
function movedInto(dest: PaneSideDockEntry, entry: PaneDockHeld, owner: string): PaneSideDockEntry {
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
 *  the body back to the panel view. A held tab (another tab's, behind the
 *  front: a main tab taking its file over) closes where it is held. */
export function withPaneDockFileClosed(entry: PaneSideDockEntry, fileKey?: string): PaneSideDockEntry {
  const target = fileKey ?? activeFileKey(entry);
  if (!target) return entry;
  if (entry.files?.some((file) => sideFileKey(file) === target)) return withFileClosed(entry, target);
  const holder = Object.entries(entry.held ?? {}).find(([, part]) =>
    part.files?.some((file) => sideFileKey(file) === target)
  );
  if (!holder) return entry;
  const [owner, part] = holder;
  const { [owner]: _part, ...held } = entry.held ?? {};
  const left = withFileClosed(part, target);
  return withHeld(entry, hasPaneLocal(left) ? { ...held, [owner]: left } : held);
}

function withFileClosed<T extends Pick<PaneSideDockEntry, 'files' | 'activeFile' | 'surface'>>(
  part: T,
  target: string
): T {
  const rest = closeSideFileTab({ files: part.files ?? [], active: activeFileKey(part) }, target);
  if (rest.files.length > 0 && rest.active) return { ...part, files: rest.files, activeFile: rest.active };
  const { files: _files, activeFile: _activeFile, ...bare } = part;
  return { ...bare, surface: part.surface === PANE_DOCK_FILE_SURFACE ? '' : part.surface } as T;
}

/** `entry` with every file tab, held ones included, that `retarget` gives a new
 *  path (an Explorer rename moved it) on that path; an active tab stays active. */
export function withPaneDockFilesRetargeted(
  entry: PaneSideDockEntry,
  retarget: (file: PaneSideDockFile) => string | null
): PaneSideDockEntry {
  const front = withFilesRetargeted(entry, retarget);
  let heldMoved = false;
  const held = Object.fromEntries(
    Object.entries(entry.held ?? {}).map(([owner, part]) => {
      const moved = withFilesRetargeted(part, retarget);
      if (moved !== part) heldMoved = true;
      return [owner, moved];
    })
  );
  return heldMoved ? { ...front, held } : front;
}

function withFilesRetargeted<T extends Pick<PaneSideDockEntry, 'files' | 'activeFile'>>(
  part: T,
  retarget: (file: PaneSideDockFile) => string | null
): T {
  let moved = false;
  let activeFile = part.activeFile;
  const files = (part.files ?? []).map((file) => {
    const rel = retarget(file);
    if (rel === null || rel === file.rel) return file;
    moved = true;
    const next = { ...file, rel };
    if (sideFileKey(file) === part.activeFile) activeFile = sideFileKey(next);
    return next;
  });
  if (!moved) return part;
  return { ...part, files, ...(activeFile === undefined ? {} : { activeFile }) };
}

/** True when closing `fileKey` removes the dock's last tab: the last file tab
 *  with no other surface tab left in the strip. The dock then closes instead
 *  of falling back to its panel view.
 *  `changesTab`: the tab's session has its Changes in the strip. */
export function paneDockFileCloseEndsDock(entry: PaneSideDockEntry, fileKey: string, changesTab: boolean): boolean {
  const files = entry.files ?? [];
  if (files.length !== 1 || sideFileKey(files[0]) !== fileKey) return false;
  return !changesTab;
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
