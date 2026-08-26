import { Check, ChevronRight, FilePlus, FolderPlus } from "lucide-react";
import { createPortal } from "react-dom";
import type { DesktopFolderEntry } from "../shared/contract";
import { isLocalTextFilePath } from "../shared/local-files";
import { FolderGlyph } from "./folder-entry-visuals";
import {
  DETAILS_SIZES,
  GRID_SIZES,
  joinFolderPath,
  type DetailsSizeKind,
  type FolderGroupKey,
  type FolderSortKey,
  type FolderViewMode,
  type GridSizeKind,
} from "./folder-pane-model";

export interface FolderMenuState {
  x: number;
  y: number;
  name: string;
  expanded: string;
}

export interface ToolMenuState {
  kind: "new" | "sort" | "view";
  x: number;
  y: number;
}

export interface CrumbMenuState {
  x: number;
  y: number;
  path: string;
  entries: DesktopFolderEntry[] | null;
}

export function FolderPaneMenus({
  menu,
  setMenu,
  toolMenu,
  setToolMenu,
  crumbMenu,
  setCrumbMenu,
  visible,
  onOpenTextFile,
  shellActions,
  currentPath,
  selectedSize,
  pasteEnabled,
  sortKey,
  sortAsc,
  groupBy,
  viewMode,
  gridSize,
  detailsSize,
  openEntry,
  openInDefaultApp,
  revealInShell,
  cutOrCopy,
  startRename,
  deleteSelected,
  setPropsEntry,
  setSort,
  setSortAsc,
  setGroupBy,
  refresh,
  createNew,
  paste,
  applyGridSize,
  applyDetailsSize,
  navigate,
}: {
  menu: FolderMenuState | null;
  setMenu(menu: FolderMenuState | null): void;
  toolMenu: ToolMenuState | null;
  setToolMenu(menu: ToolMenuState | null): void;
  crumbMenu: CrumbMenuState | null;
  setCrumbMenu(menu: CrumbMenuState | null): void;
  visible: DesktopFolderEntry[];
  onOpenTextFile?: (path: string) => Promise<void> | void;
  shellActions: boolean;
  currentPath: string;
  selectedSize: number;
  pasteEnabled: boolean;
  sortKey: FolderSortKey;
  sortAsc: boolean;
  groupBy: FolderGroupKey;
  viewMode: FolderViewMode;
  gridSize: GridSizeKind;
  detailsSize: DetailsSizeKind;
  openEntry(entry: DesktopFolderEntry): void;
  openInDefaultApp(path: string): void;
  revealInShell(path: string): void;
  cutOrCopy(operation: "copy" | "cut"): void;
  startRename(): void;
  deleteSelected(): void;
  setPropsEntry(entry: DesktopFolderEntry | null): void;
  setSort(key: FolderSortKey): void;
  setSortAsc(ascending: boolean): void;
  setGroupBy(group: FolderGroupKey): void;
  refresh(): void;
  createNew(directory: boolean): void;
  paste(): void;
  applyGridSize(kind: GridSizeKind): void;
  applyDetailsSize(kind: DetailsSizeKind): void;
  navigate(path: string): void;
}) {
  const checkGlyph = <Check size={14} className="folder-menu-check" aria-hidden="true" />;
  const sortOptions: Array<[FolderSortKey, string]> = [
    ["name", "Name"], ["date", "Date modified"], ["type", "Type"], ["size", "Size"],
  ];
  const groupOptions: Array<[FolderGroupKey, string]> = [
    ["none", "None"], ["name", "Name"], ["date", "Date modified"],
    ["type", "Type"], ["size", "Size"],
  ];

  return <>
    {menu && (() => {
      const contextEntry = menu.name
        ? visible.find((entry) => entry.name === menu.name)
        : undefined;
      const opensInMixdog = Boolean(
        contextEntry && !contextEntry.dir && onOpenTextFile
        && isLocalTextFilePath(contextEntry.name),
      );
      return createPortal(
        <div className="folder-pane-menu" role="menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 210),
            top: Math.min(menu.y, window.innerHeight - 320),
          }}>
          {menu.name ? <>
            <button type="button" role="menuitem"
              disabled={!contextEntry?.dir && !opensInMixdog && !shellActions}
              onClick={() => {
                setMenu(null);
                if (contextEntry) openEntry(contextEntry);
              }}>{contextEntry?.dir
                ? "Open"
                : opensInMixdog ? "Open in Mixdog" : "Open in default app"}</button>
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
            <button type="button" role="menuitem"
              onClick={() => { setMenu(null); cutOrCopy("cut"); }}>Cut</button>
            <button type="button" role="menuitem"
              onClick={() => { setMenu(null); cutOrCopy("copy"); }}>Copy</button>
            <button type="button" role="menuitem" onClick={() => {
              setMenu(null);
              void navigator.clipboard?.writeText(
                joinFolderPath(currentPath, menu.name),
              ).catch(() => {});
            }}>Copy path</button>
            <i className="folder-menu-divider" aria-hidden="true" />
            <button type="button" role="menuitem" disabled={selectedSize !== 1}
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
              onClick={() => setMenu({
                ...menu,
                expanded: menu.expanded === "sort" ? "" : "sort",
              })}>
              Sort by<ChevronRight size={14} className="folder-menu-caret" aria-hidden="true" />
            </button>
            {menu.expanded === "sort" && sortOptions.map(([key, label]) =>
              <button type="button" role="menuitem" key={key} className="folder-menu-sub"
                onClick={() => { setMenu(null); setSort(key); }}>
                {sortKey === key ? checkGlyph : <i className="folder-menu-checkpad" />}{label}
              </button>)}
            <button type="button" role="menuitem" aria-expanded={menu.expanded === "group"}
              onClick={() => setMenu({
                ...menu,
                expanded: menu.expanded === "group" ? "" : "group",
              })}>
              Group by<ChevronRight size={14} className="folder-menu-caret" aria-hidden="true" />
            </button>
            {menu.expanded === "group" && groupOptions.map(([key, label]) =>
              <button type="button" role="menuitem" key={key} className="folder-menu-sub"
                onClick={() => { setMenu(null); setGroupBy(key); }}>
                {groupBy === key ? checkGlyph : <i className="folder-menu-checkpad" />}{label}
              </button>)}
            <button type="button" role="menuitem"
              onClick={() => { setMenu(null); refresh(); }}>Refresh</button>
            <i className="folder-menu-divider" aria-hidden="true" />
            <button type="button" role="menuitem"
              onClick={() => { setMenu(null); createNew(true); }}>New folder</button>
            <button type="button" role="menuitem"
              onClick={() => { setMenu(null); createNew(false); }}>New file</button>
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
              {kind === "small" ? "Small icons"
                : kind === "medium" ? "Medium icons" : "Large icons"}
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
  </>;
}
