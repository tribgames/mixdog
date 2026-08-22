// Windows-Explorer-style folder pane. Behavioral grammar:
// - Today/Yesterday/Earlier this week/Last week/… date-group labels with
//   their fixed sort indexes.
// - Group-key selection per option (name initial, size buckets, type, date)
//   and "file sections below folders" ordering.
// - Discrete details-row heights and grid tile sizes.
// - Fixed context-menu composition order.
// Navigation (back/forward/up/breadcrumb+path box), toolbar (New/sort/group/
// view), places+drives rail, virtualized grouped grid/details
// views, drag-and-drop move (Ctrl copies), and real shell icons/thumbnails
// from the main process.
//
// The pane's stylesheet ships with THIS chunk rather than the first-paint
// bundle (~21KB every phone downloaded before it could show a message). No
// other surface uses those rules, and the cascade position is unchanged: the
// chunk's CSS still lands after every layer in desktop.css.
import "./desktop/29-folder-pane.css";
import {
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpZA,
  Check,
  ChevronDown,
  ChevronRight,
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
  Plus,
  RotateCw,
  Search,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { DesktopFolderEntry, DesktopFolderPlace } from "../shared/contract";
import { isLocalTextFilePath } from "../shared/local-files";
import { validateExplorerName, wellFormedExplorerName } from "./explorer-logic";
import { useMobileBack } from "./mobile-back";
import {
  MIXDOG_ABSOLUTE_PATHS_MIME,
  MIXDOG_PROJECT_PATHS_MIME,
  dataTransferHasLocalFiles,
  droppedLocalPaths,
} from "./file-drag";
import {
  breadcrumbSegments,
  buildGroups,
  DETAILS_SIZES,
  entryTypeLabel,
  errorText,
  folderBaseName,
  folderListingErrorText,
  formatByteSize,
  formatFolderDate,
  formatFolderSize,
  GRID_SIZES,
  GROUP_HEADER_HEIGHT,
  joinFolderPath,
  parentFolderPath,
  pathSepOf,
  type DetailsSizeKind,
  type FolderGroupKey,
  type FolderSortKey,
  type FolderUndoAction,
  type FolderViewMode,
  type GridSizeKind,
  type RenderRow,
} from "./folder-pane-model";
export { folderListingErrorText } from "./folder-pane-model";
import {
  EntryIcon,
  FolderGlyph,
  PreviewVisual,
} from "./folder-entry-visuals";
export {
  FOLDER_ICON_CONCURRENCY,
  folderIconRequest,
  loadFolderEntryIcon,
} from "./folder-entry-visuals";

interface FolderPaneProps {
  paneId: string;
  root: string;
  active?: boolean;
  /** Reports the current folder name so the pane TAB can follow navigation. */
  onTitleChange?(title: string): void;
  /** Opens an editable local text/code file in the focused Mixdog pane. */
  onOpenTextFile?(path: string): Promise<void> | void;
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
    case "home": return <Home size={16} />;
    case "desktop": return <Monitor size={16} />;
    case "downloads": return <Download size={16} />;
    case "documents": return <FileText size={16} />;
    case "pictures": return <ImageIcon size={16} />;
    case "music": return <Music size={16} />;
    case "videos": return <Film size={16} />;
    default: return <HardDrive size={16} />;
  }
}

// The cut/copy clipboard is module-level ON PURPOSE: two folder panes side by
// side (Q-Dir split) must paste and drag-drop across panes.
let folderClipboard: { op: "copy" | "cut"; paths: string[] } | null = null;
/** Paths being dragged right now (module-level so cross-pane drops can refuse
 *  dropping a folder onto itself or its own descendants). */
let activeDragPaths: string[] | null = null;
let placesCache: DesktopFolderPlace[] | null = null;
/** When the places were last read from disk. Drives come and go (USB sticks,
 *  network mounts) and free space moves, so the cache only paints the FIRST
 *  frame — a fresh read follows it, throttled so per-operation refreshes never
 *  rescan every drive letter. */
let placesReadAt = 0;
const PLACES_MAX_AGE_MS = 5_000;

/** Recoverable trash, open-with and reveal are Electron APIs the relay-served
 *  web surface cannot reach. Knowing that up front lets the menu disable them
 *  instead of failing after the click. */
function isDesktopShell(): boolean {
  return !(window as unknown as { mixdogRemoteServer?: string }).mixdogRemoteServer;
}

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

export default function FolderPane({
  paneId,
  root,
  active,
  onTitleChange,
  onOpenTextFile,
}: FolderPaneProps) {
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
  const [newFileDraft, setNewFileDraft] = useState(false);
  const newFileDraftRef = useRef(false);
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
  /** Collapsed-filter expansion (narrow panes show a lone filter icon). */
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [propsEntry, setPropsEntry] = useState<DesktopFolderEntry | null>(null);
  /** Move-conflict dialog (Explorer Replace/Keep both/Skip). */
  const [conflictAsk, setConflictAsk] = useState<{
    paths: string[]; targetDir: string; conflicts: string[]; onSuccess?: () => void;
  } | null>(null);
  // ABB: every transient layer this pane portals to the body closes on
  // hardware back instead of letting the phone leave the PWA.
  useMobileBack(Boolean(menu), () => setMenu(null));
  useMobileBack(Boolean(toolMenu), () => setToolMenu(null));
  useMobileBack(Boolean(crumbMenu), () => setCrumbMenu(null));
  useMobileBack(Boolean(propsEntry), () => setPropsEntry(null));
  useMobileBack(Boolean(conflictAsk), () => setConflictAsk(null));
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
  const pendingNavigationErrorRef = useRef<{ path: string; message: string } | null>(null);

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
  const restoreLoadedPath = useCallback((path: string) => {
    setNav((state) => {
      let nearest = -1;
      let distance = Number.POSITIVE_INFINITY;
      state.stack.forEach((candidate, index) => {
        if (candidate.toLowerCase() !== path.toLowerCase()) return;
        const candidateDistance = Math.abs(index - state.index);
        if (candidateDistance < distance) {
          nearest = index;
          distance = candidateDistance;
        }
      });
      if (nearest >= 0) return { ...state, index: nearest };
      const stack = [...state.stack.slice(0, state.index + 1), path];
      return { stack, index: stack.length - 1 };
    });
  }, []);
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
    newFileDraftRef.current = false;
    setNewFileDraft(false);
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
        const pending = pendingNavigationErrorRef.current;
        pendingNavigationErrorRef.current = null;
        setError(pending?.path.toLowerCase() === target.toLowerCase() ? pending.message : "");
        if (loadedPathRef.current !== target) {
          loadedPathRef.current = target;
          scrollRef.current?.scrollTo({ top: 0 });
        }
      })
      .catch((cause) => {
        if (live) {
          const message = errorText(cause);
          const loadedPath = loadedPathRef.current;
          if (/ENOTDIR/i.test(message)) {
            // The address box landed on a FILE: open it like Explorer and
            // fall back to the previous folder instead of an error state.
            void Promise.resolve(window.mixdogDesktop?.openFolderEntry?.(target))
              .catch(() => {});
            if (loadedPath) restoreLoadedPath(loadedPath);
            else goBack();
          } else if (loadedPath && loadedPath.toLowerCase() !== target.toLowerCase()) {
            pendingNavigationErrorRef.current = {
              path: loadedPath,
              message: folderListingErrorText(cause),
            };
            restoreLoadedPath(loadedPath);
          } else {
            // Refresh failures keep the last valid listing. An invalid initial
            // path has no prior listing, so it receives a normal empty state.
            if (!loadedPath) setEntries([]);
            setError(folderListingErrorText(cause));
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
    const hasOverlay = Boolean(
      menu || toolMenu || crumbMenu || propsEntry || renaming || newFileDraft || conflictAsk,
    );
    if (hadOverlayRef.current && !hasOverlay && activeStateRef.current) focusSurface();
    hadOverlayRef.current = hasOverlay;
  }, [menu, toolMenu, crumbMenu, propsEntry, renaming, newFileDraft, conflictAsk, focusSurface]);

  useEffect(() => {
    if (placesCache && Date.now() - placesReadAt < PLACES_MAX_AGE_MS) return;
    placesReadAt = Date.now();
    void Promise.resolve(window.mixdogDesktop?.folderPlaces?.() ?? [])
      .then((rows) => {
        // An empty answer means the bridge is not up yet; keep what is shown.
        if (!rows.length && placesCache?.length) return;
        placesCache = rows;
        setPlaces(rows);
      })
      .catch(() => {});
  }, [reloadTick]);

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

  const openInDefaultApp = useCallback((path: string) => {
    void Promise.resolve(window.mixdogDesktop?.openFolderEntry?.(path))
      .catch((cause) => setError(errorText(cause)));
  }, []);
  // Shell reveal is an OS integration: on a relay-served surface it reports
  // that it is desktop-only, and swallowing that left the menu item mute.
  const revealInShell = useCallback((path: string) => {
    void Promise.resolve(window.mixdogDesktop?.revealFolderEntry?.(path))
      .catch((cause) => setError(errorText(cause)));
  }, []);
  const openEntry = useCallback((entry: DesktopFolderEntry) => {
    const path = joinFolderPath(currentPath, entry.name);
    if (entry.dir) navigate(path);
    else if (onOpenTextFile && isLocalTextFilePath(path)) {
      void Promise.resolve(onOpenTextFile(path))
        .catch((cause) => setError(errorText(cause)));
    } else {
      openInDefaultApp(path);
    }
  }, [currentPath, navigate, onOpenTextFile, openInDefaultApp]);

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
  /** Explorer keeps deleting after an item fails and reports the ones that
   *  stayed, rather than stopping the whole batch at the first error. */
  const trashAll = useCallback(async (paths: string[]) => {
    const failures: string[] = [];
    for (const path of paths) {
      try {
        await window.mixdogDesktop?.trashFolderEntry?.(path);
      } catch (cause) {
        failures.push(`${folderBaseName(path)}: ${errorText(cause)}`);
      }
    }
    if (!failures.length) return;
    throw new Error(failures.length > 2
      ? `${failures.slice(0, 2).join(" · ")} · ${failures.length - 2} more`
      : failures.join(" · "));
  }, []);
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
    runOp(trashAll(paths));
    setSelected(new Set());
  }, [selectedPaths, selected, orderedEntries, runOp, trashAll]);
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
      runOp(trashAll(action.paths));
    } else {
      // Undo restores the ORIGINAL name: "keep both" quietly turned a failed
      // restore into "name (2)". A blocked slot now says so instead.
      runOp((async () => {
        for (const { from, to } of action.moved) {
          const targetDir = parentFolderPath(from);
          const originalName = folderBaseName(from);
          let current = to;
          if (parentFolderPath(to).toLowerCase() !== targetDir.toLowerCase()) {
            const result = await window.mixdogDesktop
              ?.moveFolderEntry?.([to], targetDir, "ask");
            if (result?.conflicts?.length) {
              throw new Error(`${originalName} already exists at this location.`);
            }
            current = result?.moved?.[0]?.to
              ?? joinFolderPath(targetDir, folderBaseName(to));
          }
          if (folderBaseName(current) !== originalName) {
            await window.mixdogDesktop?.renameFolderEntry?.(current, originalName);
          }
        }
      })());
    }
  }, [runOp, trashAll]);
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

  /** Folders retain Explorer's immediate unique-name creation. Files follow
   *  suit: show an empty inline input and touch disk only after Enter. */
  const createNew = useCallback((dir: boolean) => {
    if (!dir) {
      newFileDraftRef.current = true;
      setNewFileDraft(true);
      setSelected(new Set());
      setError("");
      return;
    }
    const requested = "New folder";
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
  const cancelNewFile = useCallback(() => {
    newFileDraftRef.current = false;
    setNewFileDraft(false);
    window.setTimeout(focusSurface, 0);
  }, [focusSurface]);
  const commitNewFile = useCallback((value: string): boolean => {
    if (!newFileDraftRef.current) return false;
    const name = wellFormedExplorerName(value).trim();
    const problem = validateExplorerName({
      name,
      siblings: (entries ?? []).map((entry) => entry.name),
    });
    if (problem?.severity === "error") {
      setError(problem.content);
      return false;
    }
    newFileDraftRef.current = false;
    setNewFileDraft(false);
    pendingSelectRef.current = name;
    setSelected(new Set([name]));
    runOp(Promise.resolve(
      window.mixdogDesktop?.createFolderEntry?.(currentPath, name, false),
    ).then((result) => {
      const created = result?.name || name;
      pendingSelectRef.current = created;
      undoStackRef.current.push({
        kind: "remove",
        paths: [joinFolderPath(currentPath, created)],
      });
    }));
    return true;
  }, [currentPath, entries, runOp]);
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
          if (!entry.dir) openEntry(entry);
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
    event.dataTransfer.setData(MIXDOG_ABSOLUTE_PATHS_MIME, JSON.stringify(paths));
    event.dataTransfer.setData("text/plain", paths.join("\n"));
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
      if (!dataTransferHasLocalFiles(event.dataTransfer)) return;
      const internal = event.dataTransfer.types.includes(MIXDOG_ABSOLUTE_PATHS_MIME);
      const external = !internal && (
        event.dataTransfer.types.includes("Files")
        || event.dataTransfer.types.includes(MIXDOG_PROJECT_PATHS_MIME)
      );
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
      event.preventDefault();
      event.stopPropagation();
      const paths = droppedLocalPaths(event.dataTransfer);
      if (!paths.length) return;
      const internal = event.dataTransfer.types.includes(MIXDOG_ABSOLUTE_PATHS_MIME);
      transferInto(paths, targetDir, internal ? event.ctrlKey : !event.shiftKey);
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
  const newFileInput = <input autoFocus defaultValue="" spellCheck={false}
    aria-label="New file name"
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onBlur={() => {
      if (newFileDraftRef.current) cancelNewFile();
    }}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        commitNewFile(event.currentTarget.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelNewFile();
      }
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
  const compactToolbar = paneWidth < 380;
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
        <RotateCw size={16} />
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
                  <ChevronRight size={14} aria-hidden="true" />
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
        ? <button type="button" className="folder-nav-button" data-tooltip="Filter"
            aria-label="Filter" onClick={() => setSearchExpanded(true)}>
            <Search size={16} />
          </button>
        : <div className="folder-filter" data-compact={searchCollapsed ? "true" : undefined}>
            <Search size={14} aria-hidden="true" />
            <input value={filter} placeholder={`Filter ${folderLabel}`} spellCheck={false}
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
        <Plus size={16} />{!compactToolbar && <span>New</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <span className="folder-toolbar-spring" />
      <button type="button" className="folder-tool-button folder-tool-labeled"
        aria-haspopup="menu" aria-expanded={toolMenu?.kind === "sort"}
        onClick={(event) => openToolMenu(event, "sort")}>
        {sortAsc ? <ArrowDownAZ size={16} /> : <ArrowUpZA size={16} />}
        {!compactToolbar && <span>Sort</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" className="folder-tool-button folder-tool-labeled"
        aria-haspopup="menu" aria-expanded={toolMenu?.kind === "view"}
        onClick={(event) => openToolMenu(event, "view")}>
        {viewMode === "grid" ? <LayoutGrid size={16} /> : <List size={16} />}
        {!compactToolbar && <span>View</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button type="button" className="folder-tool-button" data-tooltip="Navigation pane"
        data-active={sidebarOpen ? "true" : undefined}
        onClick={toggleSidebar} aria-label="Navigation pane">
        <PanelLeft size={16} />
      </button>
      <button type="button" className="folder-tool-button" data-tooltip="Preview pane"
        data-active={previewOpen ? "true" : undefined}
        onClick={togglePreview} aria-label="Preview pane">
        <PanelRight size={16} />
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
                    ? <HardDrive size={14} aria-hidden="true" />
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
          {entries !== null && visible.length === 0 && !newFileDraft &&
            <div className="folder-pane-empty">{filter ? "No matches." : "This folder is empty."}</div>}
          {newFileDraft && (viewMode === "details"
            ? <div role="row" className="folder-details-row folder-new-file-row"
                style={{
                  position: "relative",
                  transform: "none",
                  height: detailsRowHeight,
                  minWidth: detailsMinWidth,
                }}>
                <span className="folder-cell-name">
                  <File size={16} className="folder-entry-glyph" aria-hidden="true" />
                  {newFileInput}
                </span>
              </div>
            : <div className="folder-grid-row folder-new-file-row"
                style={{ position: "relative", transform: "none", minHeight: gridMetrics.height }}>
                <div role="button" className="folder-grid-tile"
                  style={{
                    width: gridMetrics.tile,
                    flex: `0 0 ${gridMetrics.tile}px`,
                    minHeight: gridMetrics.height - 4,
                  }}>
                  <span className="folder-tile-icon"
                    style={{ width: gridMetrics.icon + 8, height: gridMetrics.icon + 4 }}>
                    <File size={Math.round(gridMetrics.icon * 0.7)}
                      className="folder-entry-glyph" aria-hidden="true" />
                  </span>
                  {newFileInput}
                </div>
              </div>)}
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
    {menu && (() => {
      const contextEntry = menu.name
        ? visible.find((entry) => entry.name === menu.name)
        : undefined;
      const opensInMixdog = Boolean(
        contextEntry && !contextEntry.dir && onOpenTextFile
        && isLocalTextFilePath(contextEntry.name),
      );
      const shellActions = isDesktopShell();
      return createPortal(
      <div className="folder-pane-menu" role="menu"
        style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 320) }}>
        {menu.name ? <>
          {/* Open choices lead, followed by shell reveal, clipboard/path
              commands, rename/delete, then the local details dialog. */}
          <button type="button" role="menuitem"
            disabled={!contextEntry?.dir && !opensInMixdog && !shellActions}
            onClick={() => {
              setMenu(null);
              if (contextEntry) openEntry(contextEntry);
            }}>{contextEntry?.dir ? "Open" : opensInMixdog ? "Open in Mixdog" : "Open in default app"}</button>
          {opensInMixdog && <button type="button" role="menuitem" disabled={!shellActions}
            onClick={() => {
              setMenu(null);
              openInDefaultApp(joinFolderPath(currentPath, menu.name));
            }}>Open in default app</button>}
          <button type="button" role="menuitem" disabled={!shellActions} onClick={() => {
            setMenu(null);
            revealInShell(joinFolderPath(currentPath, menu.name));
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
          <button type="button" role="menuitem" disabled={!shellActions}
            onClick={() => { setMenu(null); deleteSelected(); }}>Delete</button>
          <i className="folder-menu-divider" aria-hidden="true" />
          <button type="button" role="menuitem" onClick={() => {
            setMenu(null);
            const entry = visible.find((row) => row.name === menu.name);
            if (entry) setPropsEntry(entry);
          }}>Properties</button>
        </> : <>
          <button type="button" role="menuitem" aria-expanded={menu.expanded === "sort"}
            onClick={() => setMenu({ ...menu, expanded: menu.expanded === "sort" ? "" : "sort" })}>
            Sort by<ChevronRight size={14} className="folder-menu-caret" aria-hidden="true" />
          </button>
          {menu.expanded === "sort" && sortOptions.map(([key, label]) =>
            <button type="button" role="menuitem" key={key} className="folder-menu-sub"
              onClick={() => { setMenu(null); setSort(key); }}>
              {sortKey === key ? checkGlyph : <i className="folder-menu-checkpad" />}{label}
            </button>)}
          <button type="button" role="menuitem" aria-expanded={menu.expanded === "group"}
            onClick={() => setMenu({ ...menu, expanded: menu.expanded === "group" ? "" : "group" })}>
            Group by<ChevronRight size={14} className="folder-menu-caret" aria-hidden="true" />
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
          <button type="button" role="menuitem" disabled={!shellActions} onClick={() => {
            setMenu(null);
            revealInShell(currentPath);
          }}>Show in Explorer</button>
        </>}
      </div>,
      document.body,
      );
    })()}
    {toolMenu && createPortal(
      <div className="folder-pane-menu" role="menu"
        style={{ left: Math.min(toolMenu.x, window.innerWidth - 230), top: toolMenu.y }}>
        {toolMenu.kind === "new" && <>
          <button type="button" role="menuitem"
            onClick={() => { setToolMenu(null); createNew(true); }}>
            <FolderPlus size={16} />New folder
          </button>
          <button type="button" role="menuitem"
            onClick={() => { setToolMenu(null); createNew(false); }}>
            <FilePlus size={16} />New file
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
                <FolderGlyph size={16} />{entry.name}
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
            <button type="button" disabled={!isDesktopShell()} onClick={() => {
              revealInShell(joinFolderPath(currentPath, propsEntry.name));
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
            {/* Replace trashes the displaced entry first, and the recoverable
                OS trash is an Electron integration the relay-served surface
                cannot reach (remote-methods.ts rejects the strategy). Offering
                it there closed the dialog straight into a guaranteed error, so
                the phone gets the choices that can actually run. */}
            {isDesktopShell() &&
              <button type="button" onClick={() => resolveConflict("replace")}>Replace</button>}
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
