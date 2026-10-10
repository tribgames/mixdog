// The side dock's file tab list: pure rules shared by the dock reducer and the
// unsaved-edit guard. A pane holds ordered file tabs, one active, at most one
// of them a preview tab that the next newly opened file replaces.
import { navigationKey } from './text-format';

/** A code/text file a transcript link opened beside the conversation. `nonce`
 *  re-triggers the line reveal when the same file is linked again. */
export type PaneSideDockFile = {
  project: string;
  rel: string;
  line?: number;
  /** 1-based column of a `:line:column` link. */
  column?: number;
  accessToken?: string;
  nonce: number;
  /** The tab the next newly opened file replaces. */
  preview?: boolean;
  /** When the tab was opened (ms); orders eviction and times the origin pin. */
  openedAt: number;
};

export type SideFileRef = Pick<PaneSideDockFile, 'project' | 'rel' | 'accessToken'>;
export type SideFileLink = SideFileRef & Pick<PaneSideDockFile, 'line' | 'column'>;

/** Most file tabs a dock keeps before the oldest idle one is evicted. */
export const SIDE_FILE_TAB_LIMIT = 8;
/** A link followed from the preview tab this soon after it opened keeps that tab. */
export const SIDE_FILE_PIN_ORIGIN_MS = 10_000;

export function sideFileKey(target: SideFileRef): string {
  return navigationKey({ kind: 'file', project: target.project, rel: target.rel, accessToken: target.accessToken });
}

/** Dirty/save-handle key of one tab in one pane. */
export function sideFileTabDirtyKey(leafId: string, fileKey: string): string {
  return `side-file:${leafId}:${fileKey}`;
}

export function sideFileDirtyKey(leafId: string, target: SideFileRef): string {
  return sideFileTabDirtyKey(leafId, sideFileKey(target));
}

export interface SideFileTabs {
  files: readonly PaneSideDockFile[];
  /** Key of the active tab. */
  active: string | null;
}

export interface SideFileOpenOptions {
  /** Link preview ON: a new file becomes (or replaces) the preview tab. */
  preview?: boolean;
  now?: number;
  /** Key of the tab the link was followed from. */
  from?: string;
  /** Dirty tabs are never evicted. */
  isDirty?(fileKey: string): boolean;
}

export interface SideFileOpenPlan {
  files: PaneSideDockFile[];
  active: string;
  /** Tabs the open drops: a replaced preview and evicted tabs. */
  removed: PaneSideDockFile[];
}

function withoutPreview(file: PaneSideDockFile): PaneSideDockFile {
  const { preview: _preview, ...kept } = file;
  return kept;
}

export function sameSideFiles(left?: readonly PaneSideDockFile[], right?: readonly PaneSideDockFile[]): boolean {
  if (left === right) return true;
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((file, index) => file === b[index]);
}

/** Opens a file in the tab list. A file with a tab is activated (its line
 *  revealed); otherwise it joins as the preview tab (replacing the current
 *  one, unless the link was followed from that tab within the pin window) or
 *  as a normal tab, then the least recently opened idle tab beyond the limit
 *  is evicted. */
export function planSideFileOpen(
  tabs: SideFileTabs,
  file: SideFileLink,
  nonce: number,
  options: SideFileOpenOptions = {}
): SideFileOpenPlan {
  const key = sideFileKey(file);
  const existing = tabs.files.find((tab) => sideFileKey(tab) === key);
  if (existing) {
    const { line: _line, column: _column, ...base } = existing;
    const refreshed: PaneSideDockFile = {
      ...base,
      nonce,
      ...(file.line ? { line: file.line } : {}),
      ...(file.line && file.column ? { column: file.column } : {}),
    };
    return { files: tabs.files.map((tab) => (tab === existing ? refreshed : tab)), active: key, removed: [] };
  }
  const now = options.now ?? Date.now();
  const preview = options.preview === true;
  const created: PaneSideDockFile = {
    project: file.project,
    rel: file.rel,
    ...(file.line ? { line: file.line } : {}),
    ...(file.line && file.column ? { column: file.column } : {}),
    ...(file.accessToken ? { accessToken: file.accessToken } : {}),
    nonce,
    openedAt: now,
    ...(preview ? { preview: true } : {}),
  };
  let files = [...tabs.files];
  const removed: PaneSideDockFile[] = [];
  const current = preview ? files.find((tab) => tab.preview) : undefined;
  const pinsOrigin =
    current !== undefined &&
    options.from === sideFileKey(current) &&
    now - current.openedAt <= SIDE_FILE_PIN_ORIGIN_MS;
  if (current && !pinsOrigin) {
    files = files.map((tab) => (tab === current ? created : tab));
    removed.push(current);
  } else {
    if (current) files = files.map((tab) => (tab === current ? withoutPreview(tab) : tab));
    files.push(created);
  }
  const protectedKeys = new Set<string | null>([key, tabs.active]);
  while (files.length > SIDE_FILE_TAB_LIMIT) {
    let victim: PaneSideDockFile | undefined;
    for (const tab of files) {
      const tabKey = sideFileKey(tab);
      if (protectedKeys.has(tabKey) || options.isDirty?.(tabKey)) continue;
      if (!victim || tab.openedAt < victim.openedAt) victim = tab;
    }
    if (!victim) break;
    files = files.filter((tab) => tab !== victim);
    removed.push(victim);
  }
  return { files, active: key, removed };
}

/** Closes one tab; a closed active tab hands focus to its right neighbour,
 *  else the left one. */
export function closeSideFileTab(
  tabs: SideFileTabs,
  fileKey: string
): { files: PaneSideDockFile[]; active: string | null } {
  const index = tabs.files.findIndex((tab) => sideFileKey(tab) === fileKey);
  if (index < 0) return { files: [...tabs.files], active: tabs.active };
  const files = tabs.files.filter((_, at) => at !== index);
  if (tabs.active !== fileKey) return { files, active: tabs.active };
  const next = files[index] ?? files[index - 1];
  return { files, active: next ? sideFileKey(next) : null };
}

/** Turns a preview tab into a normal one: "Keep open", a double-click, an
 *  edit, or Link preview turned off. Without a key, every preview tab. */
export function keepSideFileTabs(files: readonly PaneSideDockFile[], fileKey?: string): readonly PaneSideDockFile[] {
  if (!files.some((tab) => tab.preview && (fileKey === undefined || sideFileKey(tab) === fileKey))) return files;
  return files.map((tab) =>
    tab.preview && (fileKey === undefined || sideFileKey(tab) === fileKey) ? withoutPreview(tab) : tab
  );
}
