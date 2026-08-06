// Windows-Explorer-style folder pane. Behavioral grammar:
// - Today/Yesterday/Earlier this week/Last week/… date-group labels with
//   their fixed sort indexes.
// - Group-key selection per option (name initial, size buckets, type, date)
//   and "file sections below folders" ordering.
// - Discrete details-row heights and grid tile sizes.
// - Fixed context-menu composition order.
// Navigation (back/forward/up/breadcrumb+path box), toolbar (New/clipboard/
// sort/group/view), places+drives rail, virtualized grouped grid/details
// views, drag-and-drop move (Ctrl copies), and real shell icons/thumbnails
// from the main process.
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpZA,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  File,
  FilePlus,
  FileText,
  Film,
  FolderPlus,
  HardDrive,
  Home,
  Image as ImageIcon,
  LayoutGrid,
  List,
  Monitor,
  Music,
  PanelRight,
  PanelLeft,
  PenLine,
  Plus,
  RotateCw,
  Scissors,
  Search,
  Trash2,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DesktopFolderEntry, DesktopFolderPlace } from "../shared/contract";

interface FolderPaneProps {
  paneId: string;
  root: string;
  active?: boolean;
  /** Reports the current folder name so the pane TAB can follow navigation. */
  onTitleChange?(title: string): void;
}

// Discrete size ladder: details-row heights and grid tile/icon steps stay
// fixed sizes, never free-form zoom.
const DETAILS_SIZES = { compact: 24, small: 28, medium: 36 } as const;
const GRID_SIZES = {
  small: { tile: 84, height: 100, icon: 40 },
  medium: { tile: 108, height: 124, icon: 56 },
  large: { tile: 152, height: 172, icon: 96 },
} as const;
type DetailsSizeKind = keyof typeof DETAILS_SIZES;
type GridSizeKind = keyof typeof GRID_SIZES;
const GROUP_HEADER_HEIGHT = 34;

function pathSepOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

function joinFolderPath(dir: string, name: string): string {
  const sep = pathSepOf(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Parent directory; a drive root ("C:\") is its own parent. */
function parentFolderPath(path: string): string {
  const sep = pathSepOf(path);
  const trimmed = path.length > 3 && path.endsWith(sep) ? path.slice(0, -1) : path;
  const cut = trimmed.lastIndexOf(sep);
  if (cut <= 0) return trimmed;
  const parent = trimmed.slice(0, cut);
  return /^[A-Za-z]:$/.test(parent) ? parent + sep : parent;
}

function breadcrumbSegments(path: string): Array<{ label: string; path: string }> {
  const sep = pathSepOf(path);
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const rows: Array<{ label: string; path: string }> = [];
  let accumulated = "";
  for (const part of parts) {
    if (!accumulated) {
      accumulated = /^[A-Za-z]:$/.test(part)
        ? part + sep
        : path.startsWith(sep) ? sep + part : part;
    } else {
      accumulated = accumulated.endsWith(sep) ? accumulated + part : accumulated + sep + part;
    }
    rows.push({ label: part, path: accumulated });
  }
  return rows;
}

function entryExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Friendly Type-column names (Explorer registry descriptions, static map). */
const TYPE_NAMES: Record<string, string> = {
  txt: "Text Document", md: "Markdown Document", pdf: "PDF Document",
  doc: "Microsoft Word Document", docx: "Microsoft Word Document",
  xls: "Microsoft Excel Worksheet", xlsx: "Microsoft Excel Worksheet",
  ppt: "Microsoft PowerPoint Presentation", pptx: "Microsoft PowerPoint Presentation",
  hwp: "HWP Document", png: "PNG Image", jpg: "JPEG Image", jpeg: "JPEG Image",
  gif: "GIF Image", webp: "WebP Image", bmp: "BMP Image", svg: "SVG Image",
  ico: "Icon", mp3: "MP3 Audio", wav: "WAV Audio", flac: "FLAC Audio",
  mp4: "MP4 Video", mkv: "MKV Video", mov: "QuickTime Video", avi: "AVI Video",
  zip: "Compressed (zipped) Folder", "7z": "7-Zip Archive", rar: "RAR Archive",
  exe: "Application", msi: "Windows Installer Package", dll: "Application Extension",
  lnk: "Shortcut", url: "Internet Shortcut", bat: "Windows Batch File",
  ps1: "PowerShell Script", sh: "Shell Script", json: "JSON File",
  js: "JavaScript File", ts: "TypeScript File", tsx: "TypeScript JSX File",
  jsx: "JavaScript JSX File", html: "HTML Document", css: "CSS Document",
  ini: "Configuration Settings", log: "Log File", sys: "System File",
  tmp: "Temporary File", xml: "XML Document", yml: "YAML File",
  yaml: "YAML File", csv: "CSV File",
};

function entryTypeLabel(entry: DesktopFolderEntry): string {
  if (entry.dir) return "File folder";
  const ext = entryExt(entry.name);
  return TYPE_NAMES[ext] ?? (ext ? `${ext.toUpperCase()} File` : "File");
}

function folderBaseName(path: string): string {
  const sep = pathSepOf(path);
  const trimmed = path.endsWith(sep) ? path.slice(0, -1) : path;
  return trimmed.slice(trimmed.lastIndexOf(sep) + 1);
}

/** Ctrl+Z journal (rename back / move back / trash copies+creations).
 *  Delete cannot be undone — the recycle bin owns restoration. */
type FolderUndoAction =
  | { kind: "rename"; from: string; to: string }
  | { kind: "move"; moved: Array<{ from: string; to: string }> }
  | { kind: "remove"; paths: string[] };

function formatByteSize(value: number): string {
  const size = Math.max(0, value);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatFolderSize(entry: DesktopFolderEntry): string {
  return entry.dir ? "" : formatByteSize(entry.size);
}

function formatFolderDate(mtimeMs: number): string {
  if (!mtimeMs) return "";
  const date = new Date(mtimeMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause || "Operation failed.");
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

// ── Date-span labels ─────────────────────────────────────────────────────
// Same buckets and fixed indexes; week boundaries use locale-free
// start-of-week (Sunday) instead of culture week-of-year.
function timeSpanLabel(mtimeMs: number): { text: string; index: number } {
  if (!mtimeMs) return { text: "A long time ago", index: 0 };
  const now = new Date();
  const time = new Date(mtimeMs);
  const dayMs = 86_400_000;
  const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const weekOf = (d: Date) => {
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    start.setDate(start.getDate() - start.getDay());
    return start.getTime();
  };
  const nowDay = dayOf(now);
  const timeDay = dayOf(time);
  if (timeDay > nowDay) return { text: "Future", index: 1_000_000_006 };
  if (timeDay === nowDay) return { text: "Today", index: 1_000_000_005 };
  if (nowDay - timeDay === dayMs) return { text: "Yesterday", index: 1_000_000_004 };
  const diffDays = Math.floor((nowDay - timeDay) / dayMs);
  if (diffDays <= 7 && weekOf(time) === weekOf(now)) {
    return { text: "Earlier this week", index: 1_000_000_003 };
  }
  if (diffDays <= 14 && weekOf(time) === weekOf(now) - 7 * dayMs) {
    return { text: "Last week", index: 1_000_000_002 };
  }
  if (now.getFullYear() === time.getFullYear() && now.getMonth() === time.getMonth()) {
    return { text: "Earlier this month", index: 1_000_000_001 };
  }
  const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  if (lastMonth.getFullYear() === time.getFullYear() && lastMonth.getMonth() === time.getMonth()) {
    return { text: "Last month", index: 1_000_000_000 };
  }
  if (now.getFullYear() === time.getFullYear()) {
    return { text: "Earlier this year", index: 10_000_001 };
  }
  if (now.getFullYear() - 1 === time.getFullYear()) {
    return { text: "Last year", index: 10_000_000 };
  }
  return { text: String(time.getFullYear()), index: time.getFullYear() };
}

// ── Size buckets ─────────────────────────────────────────────────────────
const SIZE_GROUPS: Array<{ size: number; text: string }> = [
  { size: 5_000_000_000, text: "Huge (5 GB +)" },
  { size: 1_000_000_000, text: "Very large (1 - 5 GB)" },
  { size: 128_000_000, text: "Large (128 MB - 1 GB)" },
  { size: 1_000_000, text: "Medium (1 - 128 MB)" },
  { size: 16_000, text: "Small (16 KB - 1 MB)" },
];
function sizeGroupLabel(entry: DesktopFolderEntry): { text: string; index: number } {
  if (entry.dir) return { text: "Folders", index: 1_000_000_010 };
  for (let i = 0; i < SIZE_GROUPS.length; i++) {
    if (entry.size > SIZE_GROUPS[i].size) {
      return { text: SIZE_GROUPS[i].text, index: SIZE_GROUPS.length - i };
    }
  }
  return { text: "Tiny (0 - 16 KB)", index: 0 };
}

type FolderSortKey = "name" | "date" | "type" | "size";
type FolderGroupKey = "none" | FolderSortKey;
type FolderViewMode = "grid" | "details";

/** Group-key selector for the supported grouping options. */
function groupLabelFor(entry: DesktopFolderEntry, option: FolderGroupKey): {
  text: string;
  index: number;
} {
  switch (option) {
    case "name": {
      const initial = entry.name.trim().charAt(0).toUpperCase() || "#";
      return { text: /[0-9]/.test(initial) ? "0-9" : initial, index: 0 };
    }
    case "date": return timeSpanLabel(entry.mtimeMs);
    case "size": return sizeGroupLabel(entry);
    // Folder sections always sort above file sections.
    case "type": return { text: entryTypeLabel(entry), index: entry.dir ? 1 : 0 };
    default: return { text: "", index: 0 };
  }
}

interface FolderGroup {
  key: string;
  text: string;
  index: number;
  items: DesktopFolderEntry[];
}

/** Group the sorted list; date/size sections order by their fixed index
 *  (Today/Huge first), name/type alphabetically with folders first. */
function buildGroups(
  sorted: DesktopFolderEntry[],
  option: FolderGroupKey,
): FolderGroup[] {
  if (option === "none") {
    return [{ key: "", text: "", index: 0, items: sorted }];
  }
  const byKey = new Map<string, FolderGroup>();
  for (const entry of sorted) {
    const label = groupLabelFor(entry, option);
    let group = byKey.get(label.text);
    if (!group) {
      group = { key: label.text, text: label.text, index: label.index, items: [] };
      byKey.set(label.text, group);
    }
    group.items.push(entry);
  }
  const groups = [...byKey.values()];
  if (option === "date" || option === "size") {
    groups.sort((a, b) => b.index - a.index);
  } else {
    groups.sort((a, b) => (b.index - a.index)
      || a.text.localeCompare(b.text, undefined, { numeric: true }));
  }
  return groups;
}

type RenderRow =
  | { kind: "header"; group: FolderGroup; collapsed: boolean }
  | { kind: "entry"; entry: DesktopFolderEntry }
  | { kind: "entries"; entries: DesktopFolderEntry[] };

// ── Shell icon / thumbnail cache ─────────────────────────────────────────
// One icon per file extension; per-path only where Windows differentiates
// (exe/lnk) or for image thumbnails (keyed by mtime and icon size step).
const IMAGE_THUMB_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const UNIQUE_ICON_EXTS = new Set(["exe", "lnk", "ico", "url", "appref-ms"]);
const folderIconCache = new Map<string, string>();
const folderIconPending = new Map<string, Promise<string>>();

function iconCacheKey(path: string, entry: DesktopFolderEntry, edge = 32): string {
  const ext = entryExt(entry.name);
  if (IMAGE_THUMB_EXTS.has(ext)) {
    // Two thumbnail buckets: crisp small icons and crisp LARGE tiles.
    const bucket = edge > 56 ? 384 : 96;
    return `thumb${bucket}:${path}:${entry.mtimeMs}`;
  }
  if (!ext || UNIQUE_ICON_EXTS.has(ext)) return `path:${path}`;
  return `ext:${ext}`;
}

function loadEntryIcon(path: string, entry: DesktopFolderEntry, edge = 32): Promise<string> {
  const key = iconCacheKey(path, entry, edge);
  const cached = folderIconCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let pending = folderIconPending.get(key);
  if (!pending) {
    const thumbnail = key.startsWith("thumb");
    const bucket = key.startsWith("thumb384") ? 384 : 96;
    pending = Promise.resolve(
      window.mixdogDesktop?.folderEntryIcon?.(path, thumbnail, bucket) ?? "",
    )
      .catch(() => "")
      .then((data) => {
        folderIconCache.set(key, data || "");
        folderIconPending.delete(key);
        return data || "";
      });
    folderIconPending.set(key, pending);
  }
  return pending;
}

/** Explorer-style folder glyph — Windows' getFileIcon returns a generic
 *  drive-like icon for directories, so folders draw their own. */
function FolderGlyph({ size }: { size: number }) {
  return <svg className="folder-entry-icon" width={size} height={size} viewBox="0 0 32 32"
    aria-hidden="true">
    <path d="M3 7.5C3 6.1 4.1 5 5.5 5h7.2l3 3H26.5C27.9 8 29 9.1 29 10.5v2H3v-5Z"
      fill="#e8b64c" />
    <path d="M3 11.5h26v12.9c0 1.4-1.1 2.6-2.5 2.6h-21A2.55 2.55 0 0 1 3 24.4V11.5Z"
      fill="#f7d372" />
  </svg>;
}

/** Crisp large-tile document card (Files/Explorer grammar): the native shell
 *  icon only exists at ≤32px, so big tiles draw a vector sheet with the
 *  extension label and ride the real icon as a small badge. */
function DocGlyph({ size }: { size: number }) {
  return <svg className="folder-doc-paper" width={Math.round(size * 0.78)} height={size}
    viewBox="0 0 25 32" aria-hidden="true">
    <path d="M2 2.5C2 1.7 2.7 1 3.5 1H16l7 7v21.5c0 .8-.7 1.5-1.5 1.5h-18C2.7 31 2 30.3 2 29.5v-27Z"
      fill="#eef0f4" stroke="#c3c8d2" strokeWidth="1" />
    <path d="M16 1l7 7h-6.2c-.44 0-.8-.36-.8-.8V1Z" fill="#d3d7e0" />
  </svg>;
}

function EntryIcon({ path, entry, size }: {
  path: string;
  entry: DesktopFolderEntry;
  size: number;
}) {
  if (entry.dir) return <FolderGlyph size={size} />;
  return <FileEntryIcon path={path} entry={entry} size={size} />;
}

function FileEntryIcon({ path, entry, size }: {
  path: string;
  entry: DesktopFolderEntry;
  size: number;
}) {
  const key = iconCacheKey(path, entry, size);
  const [icon, setIcon] = useState(() => folderIconCache.get(key) ?? "");
  useEffect(() => {
    const cached = folderIconCache.get(key);
    if (cached !== undefined) {
      setIcon(cached);
      return undefined;
    }
    let live = true;
    setIcon("");
    void loadEntryIcon(path, entry, size).then((data) => {
      if (live) setIcon(data);
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const isImage = IMAGE_THUMB_EXTS.has(entryExt(entry.name));
  if (icon && (isImage || size <= 36)) {
    return <img className="folder-entry-icon" src={icon} alt="" draggable={false}
      style={{ width: size, height: size }} />;
  }
  if (size <= 36) {
    return <File size={Math.round(size * 0.7)} className="folder-entry-glyph" aria-hidden="true" />;
  }
  // Large non-image tile: never upscale the 32px shell icon (it pixelates).
  // Identity icons (exe/lnk) sit CENTERED at their native size; everything
  // else is a clean sheet with the extension label — no stuck-on badges.
  const extension = entryExt(entry.name);
  const identityIcon = icon && (UNIQUE_ICON_EXTS.has(extension) || !extension);
  return <span className="folder-doc-card" style={{ width: Math.round(size * 0.78), height: size }}>
    <DocGlyph size={size} />
    {identityIcon
      ? <img className="folder-doc-center" src={icon} alt="" draggable={false} />
      : extension
        ? <span className="folder-doc-ext"
            style={{ fontSize: Math.max(8, Math.round(size * 0.13)) }}>
            {extension.toUpperCase().slice(0, 4)}
          </span>
        : null}
  </span>;
}

/** Preview-pane visual: large image thumbnail for pictures, shell icon
 *  otherwise (Explorer preview pane). */
function PreviewVisual({ path, entry }: { path: string; entry: DesktopFolderEntry }) {
  const [image, setImage] = useState("");
  const key = `${path}:${entry.mtimeMs}`;
  useEffect(() => {
    let live = true;
    setImage("");
    // Folders keep the drawn Explorer glyph — the native icon for
    // directories is the generic drive-like glyph.
    if (entry.dir) return undefined;
    const wantThumb = !entry.dir && IMAGE_THUMB_EXTS.has(entryExt(entry.name));
    void Promise.resolve(
      window.mixdogDesktop?.folderEntryIcon?.(path, wantThumb, wantThumb ? 384 : 96) ?? "",
    )
      .then((data) => { if (live) setImage(data || ""); })
      .catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (entry.dir) return <FolderGlyph size={96} />;
  if (!image) return <File size={72} className="folder-entry-glyph" aria-hidden="true" />;
  return <img className="folder-preview-image" src={image} alt="" draggable={false} />;
}

/** Ctrl+wheel view ladder (Explorer zoom): details sizes then icon sizes. */
const VIEW_LADDER: Array<
  { view: "details"; size: DetailsSizeKind } | { view: "grid"; size: GridSizeKind }
> = [
  { view: "details", size: "compact" },
  { view: "details", size: "small" },
  { view: "details", size: "medium" },
  { view: "grid", size: "small" },
  { view: "grid", size: "medium" },
  { view: "grid", size: "large" },
];

function placeGlyph(place: DesktopFolderPlace): React.ReactNode {
  switch (place.kind) {
    case "home": return <Home size={15} />;
    case "desktop": return <Monitor size={15} />;
    case "downloads": return <Download size={15} />;
    case "documents": return <FileText size={15} />;
    case "pictures": return <ImageIcon size={15} />;
    case "music": return <Music size={15} />;
    case "videos": return <Film size={15} />;
    default: return <HardDrive size={15} />;
  }
}

// The cut/copy clipboard is module-level ON PURPOSE: two folder panes side by
// side (Q-Dir split) must paste and drag-drop across panes.
let folderClipboard: { op: "copy" | "cut"; paths: string[] } | null = null;
/** Paths being dragged right now (module-level so cross-pane drops can refuse
 *  dropping a folder onto itself or its own descendants). */
let activeDragPaths: string[] | null = null;
let placesCache: DesktopFolderPlace[] | null = null;
const FOLDER_DRAG_MIME = "application/x-mixdog-folder-paths";

interface FolderMenuState {
  x: number;
  y: number;
  /** Entry the menu targets; empty = background menu. */
  name: string;
  /** Inline expanded submenu ("sort" | "group" | ""). */
  expanded: string;
}

interface ToolMenuState {
  kind: "new" | "sort" | "view";
  x: number;
  y: number;
}

interface CrumbMenuState {
  x: number;
  y: number;
  path: string;
  entries: DesktopFolderEntry[] | null;
}

export default function FolderPane({ paneId, root, active, onTitleChange }: FolderPaneProps) {
  const storageKey = `mixdog.folder-pane.path.${paneId}`;
  const [nav, setNav] = useState(() => {
    let initial = root;
    try { initial = window.localStorage.getItem(storageKey) || root; } catch { /* root */ }
    return { stack: [initial], index: 0 };
  });
  const currentPath = nav.stack[nav.index] ?? root;
  const [entries, setEntries] = useState<DesktopFolderEntry[] | null>(null);
  const [error, setError] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<FolderSortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [groupBy, setGroupBy] = useState<FolderGroupKey>("none");
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const [viewMode, setViewMode] = useState<FolderViewMode>(() => {
    try {
      return window.localStorage.getItem("mixdog.folder-pane.view") === "details"
        ? "details" : "grid";
    } catch { return "grid"; }
  });
  const [gridSize, setGridSize] = useState<GridSizeKind>(() => {
    try {
      const stored = window.localStorage.getItem("mixdog.folder-pane.grid-size");
      return stored === "small" || stored === "large" ? stored : "medium";
    } catch { return "medium"; }
  });
  const [detailsSize, setDetailsSize] = useState<DetailsSizeKind>(() => {
    try {
      const stored = window.localStorage.getItem("mixdog.folder-pane.details-size");
      return stored === "compact" || stored === "medium" ? stored : "small";
    } catch { return "small"; }
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [anchorName, setAnchorName] = useState("");
  /** Keyboard caret (Explorer focus item): arrows move it, Shift extends
   *  from the anchor. */
  const [caretName, setCaretName] = useState("");
  const [renaming, setRenaming] = useState("");
  const [pathEdit, setPathEdit] = useState<string | null>(null);
  const [menu, setMenu] = useState<FolderMenuState | null>(null);
  const [toolMenu, setToolMenu] = useState<ToolMenuState | null>(null);
  const [crumbMenu, setCrumbMenu] = useState<CrumbMenuState | null>(null);
  const [places, setPlaces] = useState<DesktopFolderPlace[]>(placesCache ?? []);
  /** Sidebar folder tree: lazily loaded child folders + expansion set. */
  const [treeChildren, setTreeChildren] = useState<ReadonlyMap<string, DesktopFolderEntry[]>>(new Map());
  const [treeOpen, setTreeOpen] = useState<ReadonlySet<string>>(new Set());
  const [previewOpen, setPreviewOpen] = useState(() => {
    try { return window.localStorage.getItem("mixdog.folder-pane.preview") === "1"; }
    catch { return false; }
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    try { return window.localStorage.getItem("mixdog.folder-pane.sidebar") !== "0"; }
    catch { return true; }
  });
  const [paneWidth, setPaneWidth] = useState(0);
  /** Collapsed-search expansion (narrow panes show a lone Search icon). */
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [propsEntry, setPropsEntry] = useState<DesktopFolderEntry | null>(null);
  /** Move-conflict dialog (Explorer Replace/Keep both/Skip). */
  const [conflictAsk, setConflictAsk] = useState<{
    paths: string[]; targetDir: string; conflicts: string[]; onSuccess?: () => void;
  } | null>(null);
  /** Explorer nav-pane rule: exactly ONE sidebar row highlights — the row
   *  the user last clicked ("place:…" or "tree:…"); plain navigation from
   *  the main area moves the highlight to the tree node. */
  const [sidebarSel, setSidebarSel] = useState("");
  const [clipboardTick, setClipboardTick] = useState(0);
  const [dropTarget, setDropTarget] = useState("");
  const [marquee, setMarquee] = useState<{
    x1: number; y1: number; x2: number; y2: number;
  } | null>(null);
  const [listWidth, setListWidth] = useState(0);
  /** Details-view column widths (name takes the remainder); resizable via
   *  the header dividers, double-click auto-fits (Files AutoFitColumns). */
  const [columnWidths, setColumnWidths] = useState<{
    date: number; type: number; size: number;
  }>(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("mixdog.folder-pane.columns") || "");
      if (stored && typeof stored === "object") {
        return {
          date: Math.max(48, Number(stored.date) || 128),
          type: Math.max(48, Number(stored.type) || 96),
          size: Math.max(48, Number(stored.size) || 76),
        };
      }
    } catch { /* defaults */ }
    return { date: 128, type: 96, size: 76 };
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const headRunRef = useRef<HTMLDivElement | null>(null);
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  const activeStateRef = useRef(active);
  activeStateRef.current = active;
  /** Keyboard home: the pane surface owns arrows/type-ahead/shortcuts, so
   *  every closed overlay or navigation returns focus to it. */
  const focusSurface = useCallback(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const spaceRef = useRef<HTMLDivElement | null>(null);
  const marqueeRef = useRef<{
    startX: number; startY: number; base: ReadonlySet<string>; active: boolean;
  } | null>(null);
  const typeAheadRef = useRef({ buffer: "", at: 0 });
  /** Entry to select+reveal once the next listing lands (create/rename). */
  const pendingSelectRef = useRef("");
  /** Entry to put into inline rename once it appears (Explorer's immediate
   *  "New folder" creation). */
  const pendingRenameRef = useRef("");
  /** Ctrl+Z journal, newest last (per pane instance). */
  const undoStackRef = useRef<FolderUndoAction[]>([]);
  const columnResizeRef = useRef<{
    key: "date" | "type" | "size"; startX: number; startWidth: number;
  } | null>(null);
  /** Spring-loaded folders: hovering a drag over a folder briefly opens it. */
  const springRef = useRef<{ path: string; timer: number }>({ path: "", timer: 0 });
  /** Path whose listing is currently RENDERED — the swap to a new folder is
   *  atomic (data + scroll reset land in one commit), so entering a folder
   *  never paints an intermediate empty/staggered frame. */
  const loadedPathRef = useRef("");

  const navigate = useCallback((path: string) => {
    const target = path.trim();
    if (!target) return;
    setNav(({ stack, index }) => {
      if (stack[index] === target) return { stack, index };
      const next = stack.slice(0, index + 1);
      next.push(target);
      return { stack: next, index: next.length - 1 };
    });
    // Keep focus where the user is driving from: sidebar navigation must not
    // yank the caret back to the list (arrow keys keep working in the tree).
    if (activeStateRef.current
      && !(document.activeElement instanceof HTMLElement
        && document.activeElement.closest(".folder-pane-places"))) {
      focusSurface();
    }
  }, [focusSurface]);
  const goBack = () => setNav((state) =>
    state.index > 0 ? { ...state, index: state.index - 1 } : state);
  const goForward = () => setNav((state) =>
    state.index < state.stack.length - 1 ? { ...state, index: state.index + 1 } : state);
  const goUp = () => {
    const parent = parentFolderPath(currentPath);
    if (parent !== currentPath) navigate(parent);
  };
  const refresh = () => setReloadTick((tick) => tick + 1);

  useEffect(() => {
    try { window.localStorage.setItem(storageKey, currentPath); } catch { /* session-only */ }
    setSelected(new Set());
    setAnchorName("");
    setCaretName("");
    setFilter("");
    setRenaming("");
    setPathEdit(null);
    setMenu(null);
    setCrumbMenu(null);
    setCollapsedGroups(new Set());
    setMarquee(null);
    marqueeRef.current = null;
    setSearchExpanded(false);
    window.clearTimeout(springRef.current.timer);
    springRef.current = { path: "", timer: 0 };
  }, [currentPath, storageKey]);

  useEffect(() => {
    setSidebarSel((current) => {
      const path = current.replace(/^(?:place|tree):/, "");
      return path.toLowerCase() === currentPath.toLowerCase()
        ? current
        : `tree:${currentPath}`;
    });
  }, [currentPath]);

  // The pane tab title follows the folder being viewed (Explorer grammar).
  useEffect(() => {
    const label = breadcrumbSegments(currentPath).at(-1)?.label || currentPath;
    onTitleChangeRef.current?.(label);
  }, [currentPath]);

  // Live refresh: fs.watch pings for the folder on screen (covers external
  // changes AND other panes mutating the same directory).
  useEffect(() => {
    const desktop = window.mixdogDesktop;
    if (!desktop?.folderWatch || !desktop.subscribeFolderChanges) return undefined;
    const dir = currentPath;
    void Promise.resolve(desktop.folderWatch(dir)).catch(() => {});
    const unsubscribe = desktop.subscribeFolderChanges((changed) => {
      if (changed.toLowerCase() === dir.toLowerCase()) {
        setReloadTick((tick) => tick + 1);
      }
    });
    return () => {
      unsubscribe();
      void Promise.resolve(desktop.folderUnwatch?.(dir)).catch(() => {});
    };
  }, [currentPath]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => setPaneWidth(node.clientWidth));
    observer.observe(node);
    setPaneWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem("mixdog.folder-pane.columns", JSON.stringify(columnWidths));
    } catch { /* session-only */ }
  }, [columnWidths]);

  useEffect(() => {
    let live = true;
    setError("");
    const target = currentPath;
    void Promise.resolve(window.mixdogDesktop?.listFolderDir?.(currentPath) ?? [])
      .then((rows) => {
        if (!live) return;
        setEntries(rows);
        if (loadedPathRef.current !== target) {
          loadedPathRef.current = target;
          scrollRef.current?.scrollTo({ top: 0 });
        }
      })
      .catch((cause) => {
        if (live) {
          const message = errorText(cause);
          if (/ENOTDIR/i.test(message)) {
            // The address box landed on a FILE: open it like Explorer and
            // fall back to the previous folder instead of an error state.
            void Promise.resolve(window.mixdogDesktop?.openFolderEntry?.(target))
              .catch(() => {});
            goBack();
          } else {
            setEntries([]);
            setError(message);
            loadedPathRef.current = target;
          }
        }
      });
    return () => { live = false; };
  }, [currentPath, reloadTick]);

  const loadTreeChildren = useCallback((path: string) => {
    if (treeChildren.has(path)) return;
    void Promise.resolve(window.mixdogDesktop?.listFolderDir?.(path) ?? [])
      .then((rows) => setTreeChildren((current) => {
        const next = new Map(current);
        next.set(path, rows.filter((row) => row.dir).slice(0, 300));
        return next;
      }))
      .catch(() => setTreeChildren((current) => {
        const next = new Map(current);
        next.set(path, []);
        return next;
      }));
  }, [treeChildren]);
  const toggleTree = useCallback((path: string) => {
    setTreeOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    loadTreeChildren(path);
  }, [loadTreeChildren]);
  /** Sidebar rows in DISPLAY order (quick access, then the expanded tree) —
   *  the model for Explorer-style nav-pane keyboard movement. */
  const sidebarRows = useMemo(() => {
    const rows: Array<{
      key: string; path: string; kind: "place" | "tree";
      open?: boolean; parentPath?: string;
    }> = [];
    for (const place of places) {
      if (place.kind !== "drive") {
        rows.push({ key: `place:${place.path}`, path: place.path, kind: "place" });
      }
    }
    const walk = (path: string, parentPath?: string) => {
      const open = treeOpen.has(path);
      rows.push({ key: `tree:${path}`, path, kind: "tree", open, ...(parentPath ? { parentPath } : {}) });
      if (!open) return;
      for (const child of treeChildren.get(path) ?? []) {
        walk(joinFolderPath(path, child.name), path);
      }
    };
    for (const place of places) {
      if (place.kind === "drive") walk(place.path);
    }
    return rows;
  }, [places, treeOpen, treeChildren]);
  // Reveal the current folder in the tree (Explorer expands the ancestors).
  useEffect(() => {
    const roots = placesCache ?? places;
    const drive = roots.find((place) => place.kind === "drive"
      && currentPath.toLowerCase().startsWith(place.path.toLowerCase()));
    if (!drive) return;
    const ancestors = breadcrumbSegments(currentPath).map((crumb) => crumb.path).slice(0, -1);
    if (!ancestors.length) return;
    setTreeOpen((current) => {
      const next = new Set(current);
      for (const path of ancestors) next.add(path);
      return next;
    });
    for (const path of ancestors) loadTreeChildren(path);
  }, [currentPath, places, loadTreeChildren]);
  const togglePreview = () => {
    setPreviewOpen((open) => {
      try { window.localStorage.setItem("mixdog.folder-pane.preview", open ? "0" : "1"); }
      catch { /* session */ }
      return !open;
    });
  };
  const toggleSidebar = () => {
    setSidebarOpen((open) => {
      try { window.localStorage.setItem("mixdog.folder-pane.sidebar", open ? "0" : "1"); }
      catch { /* session */ }
      return !open;
    });
  };
  // Focus recovery: closing any overlay (menus, rename, properties) used to
  // strand focus on a detached node and kill the keyboard (user-flagged).
  const hadOverlayRef = useRef(false);
  useEffect(() => {
    const hasOverlay = Boolean(menu || toolMenu || crumbMenu || propsEntry || renaming || conflictAsk);
    if (hadOverlayRef.current && !hasOverlay && activeStateRef.current) focusSurface();
    hadOverlayRef.current = hasOverlay;
  }, [menu, toolMenu, crumbMenu, propsEntry, renaming, conflictAsk, focusSurface]);

  useEffect(() => {
    if (placesCache) return;
    void Promise.resolve(window.mixdogDesktop?.folderPlaces?.() ?? [])
      .then((rows) => {
        placesCache = rows;
        setPlaces(rows);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;
    const observer = new ResizeObserver(() => setListWidth(node.clientWidth));
    observer.observe(node);
    setListWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const rows = (entries ?? []).filter((entry) =>
      !needle || entry.name.toLowerCase().includes(needle));
    rows.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      let compared = 0;
      if (sortKey === "size") compared = a.size - b.size;
      else if (sortKey === "date") compared = a.mtimeMs - b.mtimeMs;
      else if (sortKey === "type") compared = entryTypeLabel(a).localeCompare(entryTypeLabel(b));
      if (!compared) {
        compared = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      }
      return sortAsc ? compared : -compared;
    });
    return rows;
  }, [entries, filter, sortKey, sortAsc]);

  const groups = useMemo(() => buildGroups(visible, groupBy), [visible, groupBy]);

  const gridMetrics = GRID_SIZES[gridSize];
  const detailsRowHeight = DETAILS_SIZES[detailsSize];
  const columns = viewMode === "grid"
    ? Math.max(1, Math.floor(Math.max(0, listWidth - 12) / gridMetrics.tile))
    : 1;

  // Flat virtualized row model: group headers interleave with entry rows
  // (details) or tile lines (grid); collapsed groups keep only their header.
  const renderRows = useMemo<RenderRow[]>(() => {
    const rows: RenderRow[] = [];
    for (const group of groups) {
      const collapsed = collapsedGroups.has(group.key);
      if (groupBy !== "none") rows.push({ kind: "header", group, collapsed });
      if (groupBy !== "none" && collapsed) continue;
      if (viewMode === "details") {
        for (const entry of group.items) rows.push({ kind: "entry", entry });
      } else {
        for (let start = 0; start < group.items.length; start += columns) {
          rows.push({ kind: "entries", entries: group.items.slice(start, start + columns) });
        }
      }
    }
    return rows;
  }, [groups, groupBy, collapsedGroups, viewMode, columns]);

  const virtualizer = useVirtualizer({
    count: renderRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const row = renderRows[index];
      if (!row || row.kind === "header") return GROUP_HEADER_HEIGHT;
      return row.kind === "entry" ? detailsRowHeight : gridMetrics.height;
    },
    overscan: 8,
  });
  useEffect(() => {
    virtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, columns, detailsRowHeight, gridMetrics.height, renderRows.length]);

  /** Entries in on-screen order (collapsed groups excluded) — the model for
   *  arrow-key movement, Shift ranges, marquee hits, and type-ahead. */
  const orderedEntries = useMemo(() => {
    const rows: DesktopFolderEntry[] = [];
    for (const row of renderRows) {
      if (row.kind === "entry") rows.push(row.entry);
      else if (row.kind === "entries") rows.push(...row.entries);
    }
    return rows;
  }, [renderRows]);
  const rowHeightOf = useCallback((row: RenderRow) =>
    row.kind === "header" ? GROUP_HEADER_HEIGHT
      : row.kind === "entry" ? detailsRowHeight : gridMetrics.height,
  [detailsRowHeight, gridMetrics.height]);
  const rowOffsets = useMemo(() => {
    const offsets: number[] = new Array(renderRows.length);
    let y = 0;
    for (let i = 0; i < renderRows.length; i++) {
      offsets[i] = y;
      y += rowHeightOf(renderRows[i]);
    }
    return offsets;
  }, [renderRows, rowHeightOf]);

  const scrollEntryIntoView = useCallback((name: string) => {
    const index = renderRows.findIndex((row) =>
      (row.kind === "entry" && row.entry.name === name)
      || (row.kind === "entries" && row.entries.some((entry) => entry.name === name)));
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [renderRows, virtualizer]);

  /** Place the caret (click/arrow/type-ahead landing): plain selection. */
  const focusEntry = useCallback((name: string) => {
    setSelected(new Set([name]));
    setAnchorName(name);
    setCaretName(name);
    scrollEntryIntoView(name);
  }, [scrollEntryIntoView]);

  // Create/rename select their result once the fresh listing arrives
  // (Explorer keeps the just-made item focused and in view).
  useEffect(() => {
    const name = pendingSelectRef.current;
    if (!name || entries === null) return;
    if (entries.some((entry) => entry.name === name)) {
      pendingSelectRef.current = "";
      focusEntry(name);
      if (pendingRenameRef.current === name) {
        pendingRenameRef.current = "";
        setRenaming(name);
      }
    }
  }, [entries, focusEntry]);

  const moveSelection = useCallback((
    delta: number,
    extend: boolean,
    absolute?: "home" | "end",
  ) => {
    if (!orderedEntries.length) return;
    const caretIndex = orderedEntries.findIndex((entry) =>
      entry.name === (caretName || anchorName));
    let next = absolute === "home"
      ? 0
      : absolute === "end"
        ? orderedEntries.length - 1
        : caretIndex < 0 ? 0 : caretIndex + delta;
    next = Math.max(0, Math.min(orderedEntries.length - 1, next));
    const entry = orderedEntries[next];
    if (!entry) return;
    if (extend && anchorName) {
      const from = orderedEntries.findIndex((row) => row.name === anchorName);
      if (from >= 0) {
        const [start, end] = from < next ? [from, next] : [next, from];
        setSelected(new Set(orderedEntries.slice(start, end + 1).map((row) => row.name)));
        setCaretName(entry.name);
        scrollEntryIntoView(entry.name);
        return;
      }
    }
    focusEntry(entry.name);
  }, [orderedEntries, caretName, anchorName, focusEntry, scrollEntryIntoView]);

  // ── Marquee (rubber-band) selection over the virtualized list ──────────
  const marqueePoint = (event: React.PointerEvent) => {
    const space = spaceRef.current;
    if (!space) return null;
    const rect = space.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const marqueeSelect = useCallback((box: {
    x1: number; y1: number; x2: number; y2: number;
  }, base: ReadonlySet<string>) => {
    const left = Math.min(box.x1, box.x2);
    const right = Math.max(box.x1, box.x2);
    const top = Math.min(box.y1, box.y2);
    const bottom = Math.max(box.y1, box.y2);
    const next = new Set(base);
    for (let i = 0; i < renderRows.length; i++) {
      const row = renderRows[i];
      const rowTop = rowOffsets[i];
      if (rowTop > bottom) break;
      if (rowTop + rowHeightOf(row) < top) continue;
      if (row.kind === "entry") next.add(row.entry.name);
      else if (row.kind === "entries") {
        for (let column = 0; column < row.entries.length; column++) {
          const tileLeft = column * gridMetrics.tile;
          if (tileLeft + gridMetrics.tile >= left && tileLeft <= right) {
            next.add(row.entries[column].name);
          }
        }
      }
    }
    setSelected(next);
  }, [renderRows, rowOffsets, rowHeightOf, gridMetrics.tile]);

  const onListPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest(
      ".folder-details-row, .folder-grid-tile, .folder-group-header, input",
    )) return;
    const point = marqueePoint(event);
    if (!point) return;
    const additive = event.ctrlKey || event.metaKey;
    // Explorer clears on empty-space mousedown (unless Ctrl adds to it).
    if (!additive) setSelected(new Set());
    marqueeRef.current = {
      startX: point.x,
      startY: point.y,
      base: additive ? selected : new Set(),
      active: false,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onListPointerMove = (event: React.PointerEvent) => {
    const state = marqueeRef.current;
    if (!state) return;
    const point = marqueePoint(event);
    if (!point) return;
    if (!state.active) {
      if (Math.abs(point.x - state.startX) < 4 && Math.abs(point.y - state.startY) < 4) return;
      state.active = true;
    }
    const box = { x1: state.startX, y1: state.startY, x2: point.x, y2: point.y };
    setMarquee(box);
    marqueeSelect(box, state.base);
    // Edge auto-scroll keeps the marquee usable across long folders.
    const node = scrollRef.current;
    if (node) {
      const rect = node.getBoundingClientRect();
      if (event.clientY > rect.bottom - 28) node.scrollTop += 14;
      else if (event.clientY < rect.top + 28) node.scrollTop -= 14;
    }
  };
  const onListPointerEnd = (event: React.PointerEvent) => {
    if (!marqueeRef.current) return;
    marqueeRef.current = null;
    setMarquee(null);
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch { /* capture already released */ }
  };

  const selectedPaths = useMemo(
    () => [...selected].map((name) => joinFolderPath(currentPath, name)),
    [selected, currentPath],
  );
  const selectedBytes = useMemo(() => visible.reduce((sum, entry) =>
    selected.has(entry.name) && !entry.dir ? sum + entry.size : sum, 0),
  [visible, selected]);

  const runOp = useCallback((task: Promise<unknown> | undefined) => {
    void Promise.resolve(task)
      .then(() => setError(""))
      .catch((cause) => setError(errorText(cause)))
      .then(() => setReloadTick((tick) => tick + 1));
  }, []);

  const openEntry = useCallback((entry: DesktopFolderEntry) => {
    const path = joinFolderPath(currentPath, entry.name);
    if (entry.dir) navigate(path);
    else void Promise.resolve(window.mixdogDesktop?.openFolderEntry?.(path)).catch(() => {});
  }, [currentPath, navigate]);

  const selectEntry = (entry: DesktopFolderEntry, event: React.MouseEvent) => {
    const name = entry.name;
    if (event.shiftKey && anchorName) {
      // Ranges follow the DISPLAYED grouped order, not the flat sort order.
      const from = orderedEntries.findIndex((row) => row.name === anchorName);
      const to = orderedEntries.findIndex((row) => row.name === name);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelected(new Set(orderedEntries.slice(start, end + 1).map((row) => row.name)));
        setCaretName(name);
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
      });
    } else {
      setSelected(new Set([name]));
    }
    setAnchorName(name);
    setCaretName(name);
  };

  const startRename = () => {
    if (selected.size === 1) setRenaming([...selected][0]);
  };
  const deleteSelected = useCallback(() => {
    const paths = selectedPaths;
    if (!paths.length) return;
    // Files grammar: after a delete the caret lands on the nearest SURVIVING
    // row instead of dropping the selection entirely.
    const survivor = (() => {
      let lastIndex = -1;
      orderedEntries.forEach((entry, index) => {
        if (selected.has(entry.name)) lastIndex = index;
      });
      for (let i = lastIndex + 1; i < orderedEntries.length; i++) {
        if (!selected.has(orderedEntries[i].name)) return orderedEntries[i].name;
      }
      for (let i = lastIndex - 1; i >= 0; i--) {
        if (!selected.has(orderedEntries[i].name)) return orderedEntries[i].name;
      }
      return "";
    })();
    if (survivor) pendingSelectRef.current = survivor;
    runOp((async () => {
      for (const path of paths) {
        await window.mixdogDesktop?.trashFolderEntry?.(path);
      }
    })());
    setSelected(new Set());
  }, [selectedPaths, selected, orderedEntries, runOp]);
  const cutOrCopy = useCallback((op: "copy" | "cut") => {
    if (!selectedPaths.length) return;
    folderClipboard = { op, paths: selectedPaths };
    setClipboardTick((tick) => tick + 1);
  }, [selectedPaths]);
  const transferInto = useCallback((
    paths: string[],
    targetDir: string,
    copy: boolean,
    onSuccess?: () => void,
  ) => {
    const sources = paths.filter((path) =>
      path !== targetDir && parentFolderPath(path) !== targetDir);
    if (!sources.length && !copy) return;
    if (copy) {
      runOp(Promise.resolve(window.mixdogDesktop?.copyFolderEntry?.(paths, targetDir))
        .then((result) => {
          if (result?.created?.length) {
            undoStackRef.current.push({ kind: "remove", paths: result.created });
          }
          onSuccess?.();
          return result;
        }));
      return;
    }
    runOp(Promise.resolve(window.mixdogDesktop?.moveFolderEntry?.(sources, targetDir))
      .then((result) => {
        if (result?.conflicts?.length) {
          // Explorer conflict grammar: nothing moved yet — ask the user.
          setConflictAsk({
            paths: sources,
            targetDir,
            conflicts: result.conflicts,
            ...(onSuccess ? { onSuccess } : {}),
          });
          return result;
        }
        if (result?.moved?.length) {
          undoStackRef.current.push({ kind: "move", moved: result.moved });
        }
        onSuccess?.();
        return result;
      }));
  }, [runOp]);
  const resolveConflict = (strategy: "replace" | "keepBoth" | "skip") => {
    const ask = conflictAsk;
    setConflictAsk(null);
    if (!ask) return;
    runOp(Promise.resolve(
      window.mixdogDesktop?.moveFolderEntry?.(ask.paths, ask.targetDir, strategy),
    ).then((result) => {
      // Replace is not undoable (the displaced entry went to the bin).
      if (strategy !== "replace" && result?.moved?.length) {
        undoStackRef.current.push({ kind: "move", moved: result.moved });
      }
      ask.onSuccess?.();
      return result;
    }));
  };
  const undoLast = useCallback(() => {
    const action = undoStackRef.current.pop();
    if (!action) return;
    if (action.kind === "rename") {
      runOp(window.mixdogDesktop?.renameFolderEntry?.(action.to, folderBaseName(action.from)));
    } else if (action.kind === "remove") {
      runOp((async () => {
        for (const path of action.paths) {
          await window.mixdogDesktop?.trashFolderEntry?.(path);
        }
      })());
    } else {
      runOp((async () => {
        for (const { from, to } of action.moved) {
          await window.mixdogDesktop?.moveFolderEntry?.([to], parentFolderPath(from), "keepBoth");
        }
      })());
    }
  }, [runOp]);
  const paste = useCallback(() => {
    const clipboard = folderClipboard;
    if (!clipboard?.paths.length) return;
    const copy = clipboard.op === "copy";
    // A cut clipboard survives a FAILED paste (Files/Explorer grammar):
    // clear it only after the move really landed.
    transferInto(clipboard.paths, currentPath, copy, copy ? undefined : () => {
      folderClipboard = null;
      setClipboardTick((tick) => tick + 1);
    });
  }, [currentPath, transferInto]);

  /** Explorer grammar: New folder/file creates IMMEDIATELY with a unique
   *  default name, then opens inline rename on the fresh entry. */
  const createNew = useCallback((dir: boolean) => {
    const requested = dir ? "New folder" : "New Text Document.txt";
    // The main process picks the collision-free FINAL name (the local listing
    // can be stale right after navigating, which used to swallow the create).
    runOp(Promise.resolve(
      window.mixdogDesktop?.createFolderEntry?.(currentPath, requested, dir),
    ).then((result) => {
      const name = result?.name || requested;
      pendingSelectRef.current = name;
      pendingRenameRef.current = name;
      undoStackRef.current.push({
        kind: "remove",
        paths: [joinFolderPath(currentPath, name)],
      });
    }));
  }, [currentPath, runOp]);
  const commitRename = (from: string, value: string) => {
    setRenaming("");
    const name = value.trim();
    if (!name || name === from) return;
    pendingSelectRef.current = name;
    const fromPath = joinFolderPath(currentPath, from);
    runOp(Promise.resolve(window.mixdogDesktop?.renameFolderEntry?.(fromPath, name))
      .then((value2) => {
        undoStackRef.current.push({
          kind: "rename",
          from: fromPath,
          to: joinFolderPath(currentPath, name),
        });
        return value2;
      }));
    setSelected(new Set([name]));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (target instanceof HTMLInputElement) return;
    if (target.closest?.(".folder-pane-places")) {
      // Nav-pane keys act on the SIDEBAR (Explorer): the folder list must
      // not move while the tree has focus.
      onSidebarKeyDown(event);
      return;
    }
    if (event.altKey && event.key === "Enter") {
      // Explorer Alt+Enter: Properties for the focused item.
      const entry = orderedEntries.find((row) => selected.has(row.name));
      if (entry) setPropsEntry(entry);
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp"
      || event.key === "ArrowLeft" || event.key === "ArrowRight"
      || event.key === "Home" || event.key === "End") {
      if (event.altKey && event.key === "ArrowUp") {
        goUp();
        event.preventDefault();
        return;
      }
      if (event.altKey && event.key === "ArrowLeft") {
        goBack();
        event.preventDefault();
        return;
      }
      if (event.altKey && event.key === "ArrowRight") {
        goForward();
        event.preventDefault();
        return;
      }
      const vertical = viewMode === "grid" ? columns : 1;
      const delta = event.key === "ArrowDown" ? vertical
        : event.key === "ArrowUp" ? -vertical
        : event.key === "ArrowRight" ? (viewMode === "grid" ? 1 : 0)
        : event.key === "ArrowLeft" ? (viewMode === "grid" ? -1 : 0)
        : 0;
      const absolute = event.key === "Home" ? "home" as const
        : event.key === "End" ? "end" as const : undefined;
      if (delta !== 0 || absolute) moveSelection(delta, event.shiftKey, absolute);
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && selected.size >= 1) {
      // Explorer: one folder navigates; otherwise every selected FILE opens.
      const chosen = orderedEntries.filter((row) => selected.has(row.name));
      if (chosen.length === 1) openEntry(chosen[0]);
      else {
        for (const entry of chosen) {
          if (!entry.dir) {
            void Promise.resolve(window.mixdogDesktop?.openFolderEntry?.(
              joinFolderPath(currentPath, entry.name),
            )).catch(() => {});
          }
        }
      }
      event.preventDefault();
    } else if (event.key === "F2") {
      startRename();
      event.preventDefault();
    } else if (event.key === "F5"
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r")) {
      refresh();
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.shiftKey
      && event.key.toLowerCase() === "n") {
      createNew(true);
      event.preventDefault();
    } else if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l")
      || (event.altKey && event.key.toLowerCase() === "d")) {
      setPathEdit(currentPath);
      event.preventDefault();
    } else if (event.key === "Delete") {
      deleteSelected();
      event.preventDefault();
    } else if (event.key === "Backspace") {
      // Modern Explorer: Backspace navigates BACK (Alt+Up goes up).
      goBack();
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      setSelected(new Set(visible.map((row) => row.name)));
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      cutOrCopy("copy");
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
      cutOrCopy("cut");
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
      paste();
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      undoLast();
      event.preventDefault();
    } else if (event.key === "Escape") {
      setMenu(null);
      setToolMenu(null);
      setCrumbMenu(null);
      setPropsEntry(null);
      setConflictAsk(null);
      setSelected(new Set());
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Explorer type-ahead: typed prefix jumps to the first matching entry.
      const now = Date.now();
      const state = typeAheadRef.current;
      state.buffer = (now - state.at > 700 ? "" : state.buffer) + event.key.toLowerCase();
      state.at = now;
      const hit = orderedEntries.find((entry) =>
        entry.name.toLowerCase().startsWith(state.buffer));
      if (hit) focusEntry(hit.name);
      event.preventDefault();
    }
  };

  const onSidebarKeyDown = (event: React.KeyboardEvent) => {
    const index = sidebarRows.findIndex((row) => row.key === sidebarSel);
    const focusRow = (row: (typeof sidebarRows)[number]) => {
      setSidebarSel(row.key);
      navigate(row.path);
      window.requestAnimationFrame(() => {
        rootRef.current
          ?.querySelector(`[data-sidebar-key="${CSS.escape(row.key)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      });
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const nextIndex = index < 0
        ? 0
        : Math.max(0, Math.min(sidebarRows.length - 1,
          index + (event.key === "ArrowDown" ? 1 : -1)));
      const row = sidebarRows[nextIndex];
      if (row) focusRow(row);
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      const row = sidebarRows[index];
      if (row?.kind === "tree") {
        if (!row.open) toggleTree(row.path);
        else {
          const child = sidebarRows[index + 1];
          if (child?.parentPath === row.path) focusRow(child);
        }
      }
      event.preventDefault();
    } else if (event.key === "ArrowLeft") {
      const row = sidebarRows[index];
      if (row?.kind === "tree") {
        if (row.open) toggleTree(row.path);
        else if (row.parentPath) {
          const parent = sidebarRows.find((candidate) =>
            candidate.kind === "tree" && candidate.path === row.parentPath);
          if (parent) focusRow(parent);
        }
      }
      event.preventDefault();
    } else if (event.key === "Enter") {
      const row = sidebarRows[index];
      if (row) navigate(row.path);
      event.preventDefault();
    }
  };

  useEffect(() => {
    if (!menu && !toolMenu && !crumbMenu) return undefined;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node) {
        for (const selector of [".folder-pane-menu", ".folder-crumb-menu"]) {
          const node = document.querySelector(selector);
          if (node?.contains(event.target)) return;
        }
      }
      setMenu(null);
      setToolMenu(null);
      setCrumbMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menu, toolMenu, crumbMenu]);

  const openMenuFor = (event: React.MouseEvent, name: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (name && !selected.has(name)) {
      setSelected(new Set([name]));
      setAnchorName(name);
    }
    setToolMenu(null);
    setMenu({ x: event.clientX, y: event.clientY, name, expanded: "" });
  };
  const openToolMenu = (event: React.MouseEvent, kind: ToolMenuState["kind"]) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu(null);
    setToolMenu((current) => current?.kind === kind
      ? null
      : { kind, x: rect.left, y: rect.bottom + 4 });
  };
  const openCrumbMenu = (event: React.MouseEvent, path: string) => {
    event.stopPropagation();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setCrumbMenu({ x: rect.left, y: rect.bottom + 4, path, entries: null });
    void Promise.resolve(window.mixdogDesktop?.listFolderDir?.(path) ?? [])
      .then((rows) => {
        setCrumbMenu((current) => current?.path === path
          ? { ...current, entries: rows.filter((row) => row.dir) }
          : current);
      })
      .catch(() => setCrumbMenu((current) => current?.path === path
        ? { ...current, entries: [] }
        : current));
  };

  const setSort = (key: FolderSortKey) => {
    if (sortKey === key) setSortAsc((asc) => !asc);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };
  const switchView = (mode: FolderViewMode) => {
    setViewMode(mode);
    try { window.localStorage.setItem("mixdog.folder-pane.view", mode); } catch { /* session */ }
  };
  const applyGridSize = (kind: GridSizeKind) => {
    setGridSize(kind);
    switchView("grid");
    try { window.localStorage.setItem("mixdog.folder-pane.grid-size", kind); } catch { /* session */ }
  };
  const applyDetailsSize = (kind: DetailsSizeKind) => {
    setDetailsSize(kind);
    switchView("details");
    try { window.localStorage.setItem("mixdog.folder-pane.details-size", kind); } catch { /* session */ }
  };
  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  // Ctrl+wheel zoom through the view ladder (native listener: React's root
  // wheel handler is passive, so preventDefault must bind here).
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      const index = viewMode === "details"
        ? (["compact", "small", "medium"] as DetailsSizeKind[]).indexOf(detailsSize)
        : 3 + (["small", "medium", "large"] as GridSizeKind[]).indexOf(gridSize);
      const step = VIEW_LADDER[Math.max(0, Math.min(VIEW_LADDER.length - 1, index + direction))];
      if (!step) return;
      if (step.view === "details") applyDetailsSize(step.size);
      else applyGridSize(step.size);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, detailsSize, gridSize]);

  // ── Drag and drop: drag selected entries; folders/places/crumbs accept
  // drops — move by default, Ctrl copies (Explorer grammar). ──────────────
  const onEntryDragStart = (entry: DesktopFolderEntry) => (event: React.DragEvent) => {
    const paths = selected.has(entry.name) && selectedPaths.length
      ? selectedPaths
      : [joinFolderPath(currentPath, entry.name)];
    if (!selected.has(entry.name)) {
      setSelected(new Set([entry.name]));
      setAnchorName(entry.name);
    }
    activeDragPaths = paths;
    event.dataTransfer.setData(FOLDER_DRAG_MIME, JSON.stringify(paths));
    event.dataTransfer.effectAllowed = "copyMove";
  };
  const onEntryDragEnd = () => {
    activeDragPaths = null;
    setDropTarget("");
    window.clearTimeout(springRef.current.timer);
    springRef.current = { path: "", timer: 0 };
  };
  const dropProps = (targetDir: string, accept: boolean) => accept ? {
    onDragOver: (event: React.DragEvent) => {
      const external = event.dataTransfer.types.includes("Files")
        && !event.dataTransfer.types.includes(FOLDER_DRAG_MIME);
      if (!external && !event.dataTransfer.types.includes(FOLDER_DRAG_MIME)) return;
      // Never target the dragged items themselves or their descendants.
      if (activeDragPaths?.some((path) => targetDir === path
        || targetDir.toLowerCase().startsWith(path.toLowerCase() + pathSepOf(path)))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Internal drags MOVE by default (Ctrl copies); drops from other apps
      // COPY by default (Shift moves) — Explorer grammar.
      event.dataTransfer.dropEffect = external
        ? (event.shiftKey ? "move" : "copy")
        : (event.ctrlKey ? "copy" : "move");
      setDropTarget(targetDir);
      // Spring-loaded folders: keep hovering ~900ms to open the target.
      if (springRef.current.path !== targetDir) {
        window.clearTimeout(springRef.current.timer);
        springRef.current = {
          path: targetDir,
          timer: targetDir === currentPath ? 0 : window.setTimeout(() => {
            navigate(targetDir);
          }, 900),
        };
      }
    },
    onDragLeave: () => {
      setDropTarget((current) => current === targetDir ? "" : current);
      if (springRef.current.path === targetDir) {
        window.clearTimeout(springRef.current.timer);
        springRef.current = { path: "", timer: 0 };
      }
    },
    onDrop: (event: React.DragEvent) => {
      setDropTarget("");
      window.clearTimeout(springRef.current.timer);
      springRef.current = { path: "", timer: 0 };
      const raw = event.dataTransfer.getData(FOLDER_DRAG_MIME);
      if (!raw) {
        // OS-native drop (files dragged in from Explorer itself).
        const files = [...event.dataTransfer.files];
        if (!files.length) return;
        event.preventDefault();
        event.stopPropagation();
        const dropped = files
          .map((file) => window.mixdogDesktop?.folderPathForFile?.(file) || "")
          .filter(Boolean);
        if (dropped.length) transferInto(dropped, targetDir, !event.shiftKey);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        const paths = JSON.parse(raw) as string[];
        if (Array.isArray(paths) && paths.length) {
          transferInto(paths.map(String), targetDir, event.ctrlKey);
        }
      } catch { /* foreign drag payload */ }
    },
  } : {};

  const startColumnResize = (
    event: React.PointerEvent,
    key: "date" | "type" | "size",
  ) => {
    event.preventDefault();
    event.stopPropagation();
    columnResizeRef.current = { key, startX: event.clientX, startWidth: columnWidths[key] };
    const move = (pointer: PointerEvent) => {
      const state = columnResizeRef.current;
      if (!state) return;
      const width = Math.max(48, Math.min(420, state.startWidth + (pointer.clientX - state.startX)));
      setColumnWidths((current) => ({ ...current, [state.key]: width }));
    };
    const up = () => {
      columnResizeRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** Files AutoFitColumns: double-clicking a divider sizes the column to its
   *  widest rendered value. */
  const autoFitColumn = (key: "date" | "type" | "size") => {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return;
    // Measure in the SAME face/size the cells render in — a hardcoded stack
    // drifts the moment the type tokens move and every column auto-fits to a
    // width the real text overflows.
    const rootStyle = getComputedStyle(document.documentElement);
    const cellSize = rootStyle.getPropertyValue("--mx-font-minor").trim() || "13px";
    const cellFamily = rootStyle.getPropertyValue("--mx-font-sans").trim() || "sans-serif";
    context.font = `${cellSize} ${cellFamily}`;
    let widest = 0;
    for (const entry of visible) {
      const text = key === "date" ? formatFolderDate(entry.mtimeMs)
        : key === "type" ? entryTypeLabel(entry)
        : formatFolderSize(entry);
      widest = Math.max(widest, context.measureText(text).width);
    }
    setColumnWidths((current) => ({
      ...current,
      [key]: Math.ceil(Math.max(48, Math.min(420, widest + 26))),
    }));
  };

  const renameInput = (entry: DesktopFolderEntry) =>
    <input autoFocus defaultValue={entry.name} spellCheck={false}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onFocus={(event) => {
        // Explorer pre-selects the stem so typing replaces the name but
        // keeps the extension.
        const dot = entry.dir ? -1 : entry.name.lastIndexOf(".");
        event.target.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
      }}
      onBlur={(event) => commitRename(entry.name, event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commitRename(entry.name, (event.target as HTMLInputElement).value);
        } else if (event.key === "Escape") setRenaming("");
      }} />;

  const pasteEnabled = Boolean(folderClipboard?.paths.length) || clipboardTick < 0;
  const crumbs = breadcrumbSegments(currentPath);
  const folderLabel = crumbs.at(-1)?.label || currentPath;
  const checkGlyph = <Check size={14} className="folder-menu-check" aria-hidden="true" />;
  const sortOptions: Array<[FolderSortKey, string]> = [
    ["name", "Name"], ["date", "Date modified"], ["type", "Type"], ["size", "Size"],
  ];
  const groupOptions: Array<[FolderGroupKey, string]> = [
    ["none", "None"], ["name", "Name"], ["date", "Date modified"],
    ["type", "Type"], ["size", "Size"],
  ];
  // Responsive collapse ladder (user spec): rails first SHRINK (data-folder-
  // narrow), then the LEFT rail folds before the RIGHT preview; content
  // survives down to the shared PANE minimum (320px, same floor as task
  // panes). Toolbar labels and the search box compress to icons on the way
  // down; the breadcrumb always survives. Hard gates stay as low as the
  // shrunken rails allow so the nav/preview toggles keep responding.
  const previewVisible = previewOpen && paneWidth >= 400;
  const sidebarVisible = sidebarOpen && paneWidth >= (previewVisible ? 560 : 480);
  const narrowRails = paneWidth < 640;
  const searchCollapsed = paneWidth < 620;
  const compactToolbar = paneWidth < 500;
  // Details view scrolls HORIZONTALLY when the columns outgrow the pane
  // (Explorer): rows, the virtual space and the header share one min-width,
  // and the header run translates with the list's scrollLeft.
  const detailsMinWidth = 150 + 28
    + columnWidths.date + columnWidths.type + columnWidths.size + 24;
  return <div ref={rootRef} className="folder-pane-surface" data-folder-active={active ? "true" : "false"}
    data-folder-narrow={narrowRails ? "true" : undefined}
    tabIndex={0} onKeyDown={onKeyDown}
    onPointerUp={(event) => {
      // Mouse X1/X2 buttons navigate back/forward (Explorer).
      if (event.button === 3) goBack();
      else if (event.button === 4) goForward();
    }}>
    <div className="folder-pane-navbar">
      <button type="button" className="folder-nav-button" data-tooltip="Back"
        disabled={nav.index === 0} onClick={goBack} aria-label="Back">
        <ArrowLeft size={16} />
      </button>
      <button type="button" className="folder-nav-button" data-tooltip="Forward"
        disabled={nav.index >= nav.stack.length - 1} onClick={goForward} aria-label="Forward">
        <ArrowRight size={16} />
      </button>
      <button type="button" className="folder-nav-button" data-tooltip="Up"
        disabled={parentFolderPath(currentPath) === currentPath} onClick={goUp} aria-label="Up">
        <ArrowUp size={16} />
      </button>
      <button type="button" className="folder-nav-button" data-tooltip="Refresh"
        onClick={refresh} aria-label="Refresh">
        <RotateCw size={15} />
      </button>
      {searchCollapsed && searchExpanded
        ? null
        : pathEdit === null
        ? <div className="folder-address" role="navigation" aria-label="Address"
            onClick={(event) => {
              if (event.target === event.currentTarget) setPathEdit(currentPath);
            }}>
            {/* Tail-preserving run: when crumbs overflow, the HEAD clips and
                the current folder stays visible (Explorer). */}
            <div className="folder-crumbs-run">
            {crumbs.map((crumb, index) => <React.Fragment key={crumb.path}>
              {index > 0 &&
                <button type="button" className="folder-crumb-chevron"
                  aria-label={`Folders in ${crumbs[index - 1].label}`}
                  onClick={(event) => openCrumbMenu(event, crumbs[index - 1].path)}>
                  <ChevronRight size={13} aria-hidden="true" />
                </button>}
              <button type="button" className="folder-crumb"
                data-drop={dropTarget === crumb.path ? "true" : undefined}
                {...dropProps(crumb.path, true)}
                onClick={() => navigate(crumb.path)}>{crumb.label}</button>
            </React.Fragment>)}
            </div>
          </div>
        : <input className="folder-address-input" autoFocus value={pathEdit} spellCheck={false}
            onChange={(event) => setPathEdit(event.target.value)}
            onBlur={() => setPathEdit(null)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const next = pathEdit.trim();
                setPathEdit(null);
                if (next) navigate(next);
              } else if (event.key === "Escape") setPathEdit(null);
            }} />}
      {searchCollapsed && !searchExpanded
        ? <button type="button" className="folder-nav-button" data-tooltip="Search"
            aria-label="Search" onClick={() => setSearchExpanded(true)}>
            <Search size={15} />
          </button>
        : <div className="folder-filter" data-compact={searchCollapsed ? "true" : undefined}>
            <Search size={13} aria-hidden="true" />
            <input value={filter} placeholder={`Search ${folderLabel}`} spellCheck={false}
              autoFocus={searchCollapsed && searchExpanded}
              onChange={(event) => setFilter(event.target.value)}
              onBlur={() => {
                if (!filter.trim()) setSearchExpanded(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFilter("");
                  setSearchExpanded(false);
                  event.stopPropagation();
                }
              }} />
          </div>}
    </div>
    <div className="folder-pane-toolbar">
      <button type="button" className="folder-tool-button folder-tool-labeled"
        aria-haspopup="menu" aria-expanded={toolMenu?.kind === "new"}
        onClick={(event) => openToolMenu(event, "new")}>
        <Plus size={15} />{!compactToolbar && <span>New</span>}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <i className="folder-tool-divider" aria-hidden="true" />
      <button type="button" className="folder-tool-button" data-tooltip="Cut"
        disabled={!selected.size} onClick={() => cutOrCopy("cut")} aria-label="Cut">
        <Scissors size={15} />
      </button>
      <button type="button" className="folder-tool-button" data-tooltip="Copy"
        disabled={!selected.size} onClick={() => cutOrCopy("copy")} aria-label="Copy">
        <Copy size={15} />
      </button>
      <button type="button" className="folder-tool-button" data-tooltip="Paste"
        disabled={!pasteEnabled} onClick={paste} aria-label="Paste">
        <ClipboardPaste size={15} />
      </button>
      <button type="button" className="folder-tool-button" data-tooltip="Rename"
        disabled={selected.size !== 1} onClick={startRename} aria-label="Rename">
        <PenLine size={15} />
      </button>
      <button type="button" className="folder-tool-button" data-tooltip="Delete"
        disabled={!selected.size} onClick={deleteSelected} aria-label="Delete">
        <Trash2 size={15} />
      </button>
      <span className="folder-toolbar-spring" />
      <button type="button" className="folder-tool-button folder-tool-labeled"
        aria-haspopup="menu" aria-expanded={toolMenu?.kind === "sort"}
        onClick={(event) => openToolMenu(event, "sort")}>
        {sortAsc ? <ArrowDownAZ size={15} /> : <ArrowUpZA size={15} />}
        {!compactToolbar && <span>Sort</span>}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <button type="button" className="folder-tool-button folder-tool-labeled"
        aria-haspopup="menu" aria-expanded={toolMenu?.kind === "view"}
        onClick={(event) => openToolMenu(event, "view")}>
        {viewMode === "grid" ? <LayoutGrid size={15} /> : <List size={15} />}
        {!compactToolbar && <span>View</span>}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      <button type="button" className="folder-tool-button" data-tooltip="Navigation pane"
        data-active={sidebarOpen ? "true" : undefined}
        onClick={toggleSidebar} aria-label="Navigation pane">
        <PanelLeft size={15} />
      </button>
      <button type="button" className="folder-tool-button" data-tooltip="Preview pane"
        data-active={previewOpen ? "true" : undefined}
        onClick={togglePreview} aria-label="Preview pane">
        <PanelRight size={15} />
      </button>
    </div>
    <div className="folder-pane-body">
      {sidebarVisible && <aside className="folder-pane-places">
        <div className="folder-places-heading">Quick access</div>
        {places.filter((place) => place.kind !== "drive").map((place) =>
          <button type="button" key={place.path} className="folder-place"
            data-active={sidebarSel === `place:${place.path}` ? "true" : undefined}
            data-drop={dropTarget === place.path ? "true" : undefined}
            data-sidebar-key={`place:${place.path}`}
            {...dropProps(place.path, true)}
            onClick={() => {
              setSidebarSel(`place:${place.path}`);
              navigate(place.path);
            }}>
            {placeGlyph(place)}<span>{place.name}</span>
          </button>)}
        {places.some((place) => place.kind === "drive") &&
          <div className="folder-places-heading">This PC</div>}
        {places.filter((place) => place.kind === "drive").map((place) => {
          // Drives ARE the tree roots (Explorer nav pane): the capacity row
          // and the expandable folder tree are one entry, not two sections.
          const renderTreeLevel = (path: string, label: string, depth: number): React.ReactNode => {
            const open = treeOpen.has(path);
            const children = treeChildren.get(path);
            return <React.Fragment key={path}>
              <div className="folder-tree-row"
                data-active={sidebarSel === `tree:${path}` ? "true" : undefined}
                data-drop={dropTarget === path ? "true" : undefined}
                data-sidebar-key={`tree:${path}`}
                style={{ paddingLeft: 4 + depth * 12 }}
                {...dropProps(path, true)}>
                <button type="button" className="folder-tree-toggle" aria-expanded={open}
                  onClick={() => toggleTree(path)}>
                  {open
                    ? <ChevronDown size={12} aria-hidden="true" />
                    : <ChevronRight size={12} aria-hidden="true" />}
                </button>
                <button type="button" className="folder-tree-label"
                  onClick={() => {
                    setSidebarSel(`tree:${path}`);
                    navigate(path);
                  }} onDoubleClick={() => toggleTree(path)}>
                  {depth === 0
                    ? <HardDrive size={13} aria-hidden="true" />
                    : <FolderGlyph size={14} />}
                  {depth === 0
                    ? <span className="folder-drive-info">
                        <span>{place.name === "/" ? "Root" : `Local Disk (${place.name})`}</span>
                        {typeof place.totalBytes === "number"
                          && typeof place.freeBytes === "number"
                          && place.totalBytes > 0 && <>
                          <i className="folder-drive-bar" aria-hidden="true">
                            <i style={{
                              width: `${Math.min(100, Math.max(2, Math.round(
                                (1 - place.freeBytes / place.totalBytes) * 100)))}%`,
                            }} />
                          </i>
                          <em>
                            {formatByteSize(place.freeBytes)} free of {formatByteSize(place.totalBytes)}
                          </em>
                        </>}
                      </span>
                    : <span>{label}</span>}
                </button>
              </div>
              {open && children === undefined &&
                <div className="folder-tree-loading" style={{ paddingLeft: 24 + depth * 12 }}>…</div>}
              {open && (children ?? []).map((child) =>
                renderTreeLevel(joinFolderPath(path, child.name), child.name, depth + 1))}
            </React.Fragment>;
          };
          return renderTreeLevel(place.path, place.name === "/" ? "/" : place.name, 0);
        })}
      </aside>}
      <div className="folder-pane-main">
        {viewMode === "details" && <div className="folder-details-head">
          <div ref={headRunRef} className="folder-details-head-run"
            style={{ minWidth: detailsMinWidth }}>
          {sortOptions.map(([key, label]) =>
            <button type="button" key={key} data-column={key}
              style={key === "name" ? undefined
                : { width: columnWidths[key], flex: "0 0 auto" }}
              onClick={() => setSort(key)}>
              {label}{sortKey === key ? (sortAsc ? " ▲" : " ▼") : ""}
              {key !== "name" && <span className="folder-col-resizer"
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  autoFitColumn(key);
                }}
                onPointerDown={(event) => startColumnResize(event, key)} />}
            </button>)}
          </div>
        </div>}
        <div ref={scrollRef} className="folder-pane-list" data-view={viewMode}
          onScroll={(event) => {
            if (headRunRef.current) {
              headRunRef.current.style.transform =
                `translateX(${-event.currentTarget.scrollLeft}px)`;
            }
          }}
          onContextMenu={(event) => openMenuFor(event, "")}
          {...dropProps(currentPath, true)}
          onPointerDown={onListPointerDown}
          onPointerMove={onListPointerMove}
          onPointerUp={onListPointerEnd}
          onPointerCancel={onListPointerEnd}>
          {entries === null && <div className="folder-pane-empty">Loading…</div>}
          {entries !== null && visible.length === 0 &&
            <div className="folder-pane-empty">{filter ? "No matches." : "This folder is empty."}</div>}
          <div ref={spaceRef} className="folder-virtual-space"
            style={{
              height: virtualizer.getTotalSize(),
              ...(viewMode === "details" ? { minWidth: detailsMinWidth } : {}),
            }}>
            {marquee && <div className="folder-marquee" aria-hidden="true" style={{
              left: Math.min(marquee.x1, marquee.x2),
              top: Math.min(marquee.y1, marquee.y2),
              width: Math.abs(marquee.x2 - marquee.x1),
              height: Math.abs(marquee.y2 - marquee.y1),
            }} />}
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = renderRows[virtualRow.index];
              if (!row) return null;
              if (row.kind === "header") {
                return <div key={`header:${row.group.key}`} className="folder-group-header"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                  onClick={() => toggleGroupCollapsed(row.group.key)}>
                  {row.collapsed
                    ? <ChevronRight size={14} aria-hidden="true" />
                    : <ChevronDown size={14} aria-hidden="true" />}
                  <b>{row.group.text}</b>
                  <span>({row.group.items.length})</span>
                </div>;
              }
              if (row.kind === "entry") {
                const entry = row.entry;
                const path = joinFolderPath(currentPath, entry.name);
                return <div key={entry.name} role="row"
                  className="folder-details-row" draggable
                  data-selected={selected.has(entry.name) ? "true" : undefined}
                  data-cut={folderClipboard?.op === "cut" && folderClipboard.paths.includes(path) ? "true" : undefined}
                  data-drop={dropTarget === path ? "true" : undefined}
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: detailsRowHeight,
                    minWidth: detailsMinWidth,
                  }}
                  onDragStart={onEntryDragStart(entry)}
                  onDragEnd={onEntryDragEnd}
                  {...dropProps(path, entry.dir)}
                  onClick={(event) => selectEntry(entry, event)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(event) => openMenuFor(event, entry.name)}>
                  <span className="folder-cell-name">
                    <EntryIcon path={path} entry={entry} size={16} />
                    {renaming === entry.name
                      ? renameInput(entry)
                      : <span className="folder-name-text">{entry.name}</span>}
                  </span>
                  <span className="folder-cell-date"
                    style={{ width: columnWidths.date, flex: "0 0 auto" }}>
                    {formatFolderDate(entry.mtimeMs)}
                  </span>
                  <span className="folder-cell-type"
                    style={{ width: columnWidths.type, flex: "0 0 auto" }}>
                    {entryTypeLabel(entry)}
                  </span>
                  <span className="folder-cell-size"
                    style={{ width: columnWidths.size, flex: "0 0 auto" }}>
                    {formatFolderSize(entry)}
                  </span>
                </div>;
              }
              return <div key={`grid:${virtualRow.index}:${row.entries[0]?.name ?? ""}`}
                className="folder-grid-row"
                style={{ transform: `translateY(${virtualRow.start}px)` }}>
                {row.entries.map((entry) => {
                  const path = joinFolderPath(currentPath, entry.name);
                  return <div key={entry.name} role="button" tabIndex={-1}
                    className="folder-grid-tile" draggable
                    data-selected={selected.has(entry.name) ? "true" : undefined}
                    data-cut={folderClipboard?.op === "cut" && folderClipboard.paths.includes(path) ? "true" : undefined}
                    data-drop={dropTarget === path ? "true" : undefined}
                    style={{
                      width: gridMetrics.tile,
                      // flex-basis outranks width on the flex main axis, so the
                      // size step must land on BOTH (the class carries a basis).
                      flex: `0 0 ${gridMetrics.tile}px`,
                      minHeight: gridMetrics.height - 4,
                    }}
                    onDragStart={onEntryDragStart(entry)}
                    onDragEnd={onEntryDragEnd}
                    {...dropProps(path, entry.dir)}
                    onClick={(event) => selectEntry(entry, event)}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(event) => openMenuFor(event, entry.name)}>
                    <span className="folder-tile-icon"
                      style={{ width: gridMetrics.icon + 8, height: gridMetrics.icon + 4 }}>
                      <EntryIcon path={path} entry={entry} size={gridMetrics.icon} />
                    </span>
                    {renaming === entry.name
                      ? renameInput(entry)
                      : <span className="folder-tile-label"
                          style={{ maxWidth: gridMetrics.tile - 8 }}>{entry.name}</span>}
                  </div>;
                })}
              </div>;
            })}
          </div>
        </div>
        <div className="folder-pane-status">
          <span>{visible.length} items</span>
          {selected.size > 0 && <span>
            {selected.size} selected{selectedBytes > 0 ? ` — ${formatByteSize(selectedBytes)}` : ""}
          </span>}
          {error && <span className="folder-pane-error" role="alert">{error}</span>}
        </div>
      </div>
      {previewVisible && (() => {
        const previewEntry = selected.size === 1
          ? orderedEntries.find((row) => selected.has(row.name)) ?? null
          : null;
        return <aside className="folder-preview">
          {selected.size > 1
            ? <div className="folder-preview-empty">
                {selected.size} items selected
                {selectedBytes > 0 ? ` — ${formatByteSize(selectedBytes)}` : ""}
              </div>
            : previewEntry
              ? <>
                <div className="folder-preview-visual">
                  <PreviewVisual path={joinFolderPath(currentPath, previewEntry.name)}
                    entry={previewEntry} />
                </div>
                <b className="folder-preview-name">{previewEntry.name}</b>
                <dl className="folder-preview-meta">
                  <dt>Type</dt><dd>{entryTypeLabel(previewEntry)}</dd>
                  {!previewEntry.dir && <><dt>Size</dt><dd>{formatFolderSize(previewEntry)}</dd></>}
                  <dt>Modified</dt><dd>{formatFolderDate(previewEntry.mtimeMs) || "—"}</dd>
                </dl>
              </>
              : <div className="folder-preview-empty">Select an item to preview</div>}
        </aside>;
      })()}
    </div>
    {menu && createPortal(
      <div className="folder-pane-menu" role="menu"
        style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 320) }}>
        {menu.name ? <>
          {/* ContentPageContextFlyoutFactory order: open, shell reveal,
              clipboard pair, copy path, rename, delete. */}
          <button type="button" role="menuitem" onClick={() => {
            setMenu(null);
            const entry = visible.find((row) => row.name === menu.name);
            if (entry) openEntry(entry);
          }}>Open</button>
          <button type="button" role="menuitem" onClick={() => {
            setMenu(null);
            void Promise.resolve(window.mixdogDesktop?.revealFolderEntry?.(
              joinFolderPath(currentPath, menu.name),
            )).catch(() => {});
          }}>Show in Explorer</button>
          <i className="folder-menu-divider" aria-hidden="true" />
          <button type="button" role="menuitem" onClick={() => { setMenu(null); cutOrCopy("cut"); }}>Cut</button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); cutOrCopy("copy"); }}>Copy</button>
          <button type="button" role="menuitem" onClick={() => {
            setMenu(null);
            void navigator.clipboard?.writeText(joinFolderPath(currentPath, menu.name)).catch(() => {});
          }}>Copy path</button>
          <i className="folder-menu-divider" aria-hidden="true" />
          <button type="button" role="menuitem" disabled={selected.size !== 1}
            onClick={() => { setMenu(null); startRename(); }}>Rename</button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); deleteSelected(); }}>Delete</button>
          <i className="folder-menu-divider" aria-hidden="true" />
          <button type="button" role="menuitem" onClick={() => {
            setMenu(null);
            const entry = visible.find((row) => row.name === menu.name);
            if (entry) setPropsEntry(entry);
          }}>Properties</button>
        </> : <>
          <button type="button" role="menuitem" aria-expanded={menu.expanded === "sort"}
            onClick={() => setMenu({ ...menu, expanded: menu.expanded === "sort" ? "" : "sort" })}>
            Sort by<ChevronRight size={13} className="folder-menu-caret" aria-hidden="true" />
          </button>
          {menu.expanded === "sort" && sortOptions.map(([key, label]) =>
            <button type="button" role="menuitem" key={key} className="folder-menu-sub"
              onClick={() => { setMenu(null); setSort(key); }}>
              {sortKey === key ? checkGlyph : <i className="folder-menu-checkpad" />}{label}
            </button>)}
          <button type="button" role="menuitem" aria-expanded={menu.expanded === "group"}
            onClick={() => setMenu({ ...menu, expanded: menu.expanded === "group" ? "" : "group" })}>
            Group by<ChevronRight size={13} className="folder-menu-caret" aria-hidden="true" />
          </button>
          {menu.expanded === "group" && groupOptions.map(([key, label]) =>
            <button type="button" role="menuitem" key={key} className="folder-menu-sub"
              onClick={() => { setMenu(null); setGroupBy(key); }}>
              {groupBy === key ? checkGlyph : <i className="folder-menu-checkpad" />}{label}
            </button>)}
          <button type="button" role="menuitem" onClick={() => { setMenu(null); refresh(); }}>Refresh</button>
          <i className="folder-menu-divider" aria-hidden="true" />
          <button type="button" role="menuitem" onClick={() => { setMenu(null); createNew(true); }}>New folder</button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); createNew(false); }}>New file</button>
          <button type="button" role="menuitem" disabled={!pasteEnabled}
            onClick={() => { setMenu(null); paste(); }}>Paste</button>
          <i className="folder-menu-divider" aria-hidden="true" />
          <button type="button" role="menuitem" onClick={() => {
            setMenu(null);
            void navigator.clipboard?.writeText(currentPath).catch(() => {});
          }}>Copy path</button>
          <button type="button" role="menuitem" onClick={() => {
            setMenu(null);
            void Promise.resolve(window.mixdogDesktop?.revealFolderEntry?.(currentPath)).catch(() => {});
          }}>Show in Explorer</button>
        </>}
      </div>,
      document.body,
    )}
    {toolMenu && createPortal(
      <div className="folder-pane-menu" role="menu"
        style={{ left: Math.min(toolMenu.x, window.innerWidth - 230), top: toolMenu.y }}>
        {toolMenu.kind === "new" && <>
          <button type="button" role="menuitem"
            onClick={() => { setToolMenu(null); createNew(true); }}>
            <FolderPlus size={15} />New folder
          </button>
          <button type="button" role="menuitem"
            onClick={() => { setToolMenu(null); createNew(false); }}>
            <FilePlus size={15} />New file
          </button>
        </>}
        {toolMenu.kind === "sort" && <>
          <div className="folder-menu-heading">Sort by</div>
          {sortOptions.map(([key, label]) =>
            <button type="button" role="menuitem" key={key}
              onClick={() => { setToolMenu(null); setSort(key); }}>
              {sortKey === key ? checkGlyph : <i className="folder-menu-checkpad" />}{label}
            </button>)}
          <i className="folder-menu-divider" aria-hidden="true" />
          <button type="button" role="menuitem"
            onClick={() => { setToolMenu(null); setSortAsc(true); }}>
            {sortAsc ? checkGlyph : <i className="folder-menu-checkpad" />}Ascending
          </button>
          <button type="button" role="menuitem"
            onClick={() => { setToolMenu(null); setSortAsc(false); }}>
            {!sortAsc ? checkGlyph : <i className="folder-menu-checkpad" />}Descending
          </button>
          <i className="folder-menu-divider" aria-hidden="true" />
          <div className="folder-menu-heading">Group by</div>
          {groupOptions.map(([key, label]) =>
            <button type="button" role="menuitem" key={key}
              onClick={() => { setToolMenu(null); setGroupBy(key); }}>
              {groupBy === key ? checkGlyph : <i className="folder-menu-checkpad" />}{label}
            </button>)}
        </>}
        {toolMenu.kind === "view" && <>
          <div className="folder-menu-heading">Icons</div>
          {(Object.keys(GRID_SIZES) as GridSizeKind[]).map((kind) =>
            <button type="button" role="menuitem" key={kind}
              onClick={() => { setToolMenu(null); applyGridSize(kind); }}>
              {viewMode === "grid" && gridSize === kind
                ? checkGlyph : <i className="folder-menu-checkpad" />}
              {kind === "small" ? "Small icons" : kind === "medium" ? "Medium icons" : "Large icons"}
            </button>)}
          <i className="folder-menu-divider" aria-hidden="true" />
          <div className="folder-menu-heading">Details</div>
          {(Object.keys(DETAILS_SIZES) as DetailsSizeKind[]).map((kind) =>
            <button type="button" role="menuitem" key={kind}
              onClick={() => { setToolMenu(null); applyDetailsSize(kind); }}>
              {viewMode === "details" && detailsSize === kind
                ? checkGlyph : <i className="folder-menu-checkpad" />}
              {kind === "compact" ? "Compact" : kind === "small" ? "Small" : "Medium"}
            </button>)}
        </>}
      </div>,
      document.body,
    )}
    {crumbMenu && createPortal(
      <div className="folder-pane-menu folder-crumb-menu" role="menu"
        style={{ left: Math.min(crumbMenu.x, window.innerWidth - 230), top: crumbMenu.y }}>
        {crumbMenu.entries === null
          ? <div className="folder-menu-heading">Loading…</div>
          : crumbMenu.entries.length === 0
            ? <div className="folder-menu-heading">No folders</div>
            : crumbMenu.entries.slice(0, 40).map((entry) =>
              <button type="button" role="menuitem" key={entry.name}
                onClick={() => {
                  const target = joinFolderPath(crumbMenu.path, entry.name);
                  setCrumbMenu(null);
                  navigate(target);
                }}>
                <FolderGlyph size={15} />{entry.name}
              </button>)}
      </div>,
      document.body,
    )}
    {propsEntry && createPortal(
      <div className="folder-props-overlay" role="presentation"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setPropsEntry(null);
        }}>
        <div className="folder-props-card" role="dialog" aria-modal="true"
          aria-label={`${propsEntry.name} properties`}>
          <header>
            <PreviewVisual path={joinFolderPath(currentPath, propsEntry.name)}
              entry={propsEntry} />
            <b>{propsEntry.name}</b>
          </header>
          <dl>
            <dt>Type</dt><dd>{entryTypeLabel(propsEntry)}</dd>
            <dt>Location</dt><dd>{currentPath}</dd>
            {!propsEntry.dir && <>
              <dt>Size</dt>
              <dd>{formatFolderSize(propsEntry)} ({propsEntry.size.toLocaleString()} bytes)</dd>
            </>}
            <dt>Modified</dt><dd>{formatFolderDate(propsEntry.mtimeMs) || "—"}</dd>
          </dl>
          <footer>
            <button type="button" onClick={() => {
              void Promise.resolve(window.mixdogDesktop?.revealFolderEntry?.(
                joinFolderPath(currentPath, propsEntry.name),
              )).catch(() => {});
            }}>Show in Explorer</button>
            <button type="button" onClick={() => setPropsEntry(null)}>Close</button>
          </footer>
        </div>
      </div>,
      document.body,
    )}
    {conflictAsk && createPortal(
      <div className="folder-props-overlay" role="presentation"
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setConflictAsk(null);
        }}>
        <div className="folder-props-card folder-conflict-card" role="dialog" aria-modal="true"
          aria-label="Name conflict">
          <header>
            <b>
              {conflictAsk.conflicts.length === 1
                ? "An item with this name already exists in this folder"
                : `${conflictAsk.conflicts.length} items already exist in this folder`}
            </b>
          </header>
          <div className="folder-conflict-list">
            {conflictAsk.conflicts.slice(0, 8).map((name) => <span key={name}>{name}</span>)}
            {conflictAsk.conflicts.length > 8 &&
              <span>… {conflictAsk.conflicts.length - 8} more</span>}
          </div>
          <footer>
            <button type="button" onClick={() => resolveConflict("replace")}>Replace</button>
            <button type="button" onClick={() => resolveConflict("keepBoth")}>Keep both</button>
            <button type="button" onClick={() => resolveConflict("skip")}>Skip</button>
            <button type="button" onClick={() => setConflictAsk(null)}>Cancel</button>
          </footer>
        </div>
      </div>,
      document.body,
    )}
  </div>;
}
