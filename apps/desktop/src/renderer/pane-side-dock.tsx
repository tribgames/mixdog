// Per-pane right dock: ONE side-tab unit per pane (user: PANE 하위 → 사이드탭
// 헤더 → 소스제어·브라우저·DIFF가 그 헤더의 하위로). The horizontal header
// selects every child — classic panel views, the pane's browser, and diff
// surfaces opened from Source Control — and each child shows STANDALONE under
// the header, without a second tab row. The whole unit folds and overlays as
// one body; its children and open diff tabs survive folds and persist per
// pane id across restarts.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, X } from "lucide-react";
import {
  DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
  DESKTOP_UTILITY_DOCK_MIN_WIDTH,
  DESKTOP_WORKSPACE_MIN_WIDTH,
} from "../shared/window-layout";
import type { WorkspaceSelection } from "./nav-types";
import { navigationKey } from "./text-format";
import { DeferredPersistentSurface } from "./PaneSurfaceGate";
import {
  DIFF_STARTUP_DELAY_MS,
  ReadyGitDiffPane,
} from "./app-shell-components";
import { DesktopLoadingSurface } from "./RendererRecovery";
import { SessionGoalHost } from "./SessionGoalIsland";
import { isMobileRemoteSurface } from "./mobile-surface";
import {
  isWorkbenchSideLauncher,
  WorkbenchSideIconBar,
  WorkbenchSidePanel,
  type WorkbenchSideTitleDragProps,
  type WorkbenchSideViewDescriptor,
  type WorkbenchSideViewGroup,
  type WorkbenchSideViewId,
  type WorkbenchSideViewPlacement,
} from "./workbench-side-view-layout";
import {
  getSidePanelMode,
  sidePanelLayout,
  subscribeSidePanelMode,
} from "./side-panel-preferences";
import { t } from "./i18n";

export type PaneSideDockDiff = Extract<WorkspaceSelection, { kind: "diff" }>;
export type PaneSideDiffRequest = {
  source: "staged" | "unstaged" | "commit";
  hash?: string;
  untracked?: boolean;
};
export type PaneSideDockEntry = {
  open: boolean;
  /** Active classic panel view; the browser and diffs live in `surface`. */
  view: WorkbenchSideViewId | null;
  /** "" shows the panel view; "browser" or "diff" otherwise. */
  surface: string;
  /** The single open diff — a Source Control click REPLACES it (user: 헤더
   *  한 줄, DIFF 탭 없이 교체 방식). */
  diff: PaneSideDockDiff | null;
};

export const PANE_SIDE_DOCK_KEY = "mixdog.desktop.pane-side-dock.v1";
/** One shared width preference for every pane dock: resizing any pane's panel
 *  sets the width the next opened panel starts from. */
export const PANE_SIDE_DOCK_WIDTH_KEY = "mixdog.desktop.pane-side-dock-width.v1";
/** Diff pair column: floors at the classic panel size but OPENS readable
 *  (user: 디프 보기에 너무 작지 않냐 — 기본 480), expanding by drag to 800;
 *  its width is a preference separate from the browser's. */
export const PANE_SIDE_DOCK_DIFF_WIDTH_KEY =
  "mixdog.desktop.pane-side-dock-diff-width.v1";
export const PANE_SIDE_DOCK_DIFF_MIN_WIDTH = 320;
export const PANE_SIDE_DOCK_DIFF_MAX_WIDTH = 800;
export const PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH = 480;
/** Standalone browser: below 580px BrowserPane renders pages at 100% so
 *  responsive sites reflow like a phone, and the floor drops to 320 — a
 *  phone-frame preview for mobile web-app work (user: 모바일 웹앱 개발이면
 *  브라우저는 더 작아져도). */
export const PANE_SIDE_DOCK_BROWSER_WIDTH_KEY =
  "mixdog.desktop.pane-side-dock-browser-width.v1";
export const PANE_SIDE_DOCK_BROWSER_MIN_WIDTH = 320;
export const PANE_SIDE_DOCK_BROWSER_MAX_WIDTH = 1160;
export const PANE_SIDE_DOCK_BROWSER_DEFAULT_WIDTH = 720;
/** Classic panel column ceiling (window-level right panel grammar). */
export const PANE_SIDE_DOCK_PANEL_MAX_WIDTH = 560;
export const PANE_DOCK_BROWSER_SURFACE = "browser";
export const PANE_DOCK_DIFF_SURFACE = "diff";
export function paneGoalPlacement(
  entry: Pick<PaneSideDockEntry, "open" | "surface" | "diff">,
): "composer" | "diff" {
  return entry.open && entry.surface === PANE_DOCK_DIFF_SURFACE && entry.diff !== null
    ? "diff"
    : "composer";
}
export function paneDiffStacks(
  diffShowing: boolean,
  sheetAvailable: number,
  pairMinimum: number,
  mobile: boolean,
): boolean {
  return diffShowing && (mobile || sheetAvailable < pairMinimum);
}
/** Retired stores: the split beside-the-panel surface region, and the short-
 *  lived width pref the browser and diff briefly shared. */
const LEGACY_SIDE_SURFACE_KEYS = [
  "mixdog.desktop.pane-side-surfaces.v1",
  "mixdog.desktop.pane-side-surface-width.v1",
  "mixdog.desktop.pane-side-dock-surface-width.v1",
] as const;

const CLOSED_ENTRY: PaneSideDockEntry = {
  open: false,
  view: null,
  surface: "",
  diff: null,
};

/** Launchers own no body at all, and the browser's body is a stacked surface,
 *  so neither can be a dock's active panel view or its default. */
function isPanelView(id: WorkbenchSideViewId): boolean {
  return !isWorkbenchSideLauncher(id) && id !== PANE_DOCK_BROWSER_SURFACE;
}

function firstPanelRoot(
  groups: readonly WorkbenchSideViewGroup[],
): WorkbenchSideViewId | null {
  return groups.find((group) =>
    group[0] !== undefined && isPanelView(group[0]))?.[0] ?? null;
}

function isDockDiff(value: unknown): value is PaneSideDockDiff {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.kind === "diff"
    && typeof record.project === "string" && record.project.length > 0
    && typeof record.rel === "string" && record.rel.length > 0
    && (record.source === "staged" || record.source === "unstaged"
      || record.source === "commit");
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
  defaultOpen: boolean,
): Record<string, PaneSideDockEntry> {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const members = new Set<WorkbenchSideViewId>(groups.flat().filter(isPanelView));
  const hasBrowser = groups.flat().includes(PANE_DOCK_BROWSER_SURFACE);
  const firstRoot = firstPanelRoot(groups);
  const next: Record<string, PaneSideDockEntry> = {};
  for (const leafId of leafIds) {
    const raw = record[leafId];
    const entry = raw && typeof raw === "object"
      ? raw as Record<string, unknown>
      : null;
    const storedSurface = entry && typeof entry.surface === "string"
      ? entry.surface
      : "";
    // Single diff; a legacy store may still carry a diffs ARRAY — keep the
    // one its surface pointed at, else the most recent.
    const legacy = entry && Array.isArray(entry.diffs)
      ? entry.diffs.filter(isDockDiff)
      : [];
    const diff = entry && isDockDiff(entry.diff)
      ? entry.diff
      : legacy.find((item) => navigationKey(item) === storedSurface)
        ?? legacy.at(-1)
        ?? null;
    const storedView = entry && typeof entry.view === "string"
      && members.has(entry.view as WorkbenchSideViewId)
      ? entry.view as WorkbenchSideViewId
      : null;
    const view = storedView ?? firstRoot;
    const surface = storedSurface === PANE_DOCK_BROWSER_SURFACE
      ? hasBrowser ? PANE_DOCK_BROWSER_SURFACE : ""
      : diff && (storedSurface === PANE_DOCK_DIFF_SURFACE
          || storedSurface === navigationKey(diff))
        ? PANE_DOCK_DIFF_SURFACE
        : "";
    const open = (entry ? entry.open === true : defaultOpen)
      && (view !== null || surface !== "");
    next[leafId] = { open, view, surface, diff };
  }
  return next;
}

export function samePaneSideDocks(
  left: Readonly<Record<string, PaneSideDockEntry>>,
  right: Readonly<Record<string, PaneSideDockEntry>>,
): boolean {
  const leftIds = Object.keys(left);
  if (leftIds.length !== Object.keys(right).length) return false;
  return leftIds.every((id) => {
    const a = left[id];
    const b = right[id];
    return Boolean(b) && a.open === b.open && a.view === b.view
      && a.surface === b.surface && a.diff === b.diff;
  });
}

/** Open-or-replace: a Source Control click swaps the diff in place; the same
 *  file simply re-activates (user: 탭 없이 교체 방식). */
export function withPaneDockDiffOpened(
  entry: PaneSideDockEntry,
  selection: PaneSideDockDiff,
): PaneSideDockEntry {
  const unchanged = entry.open
    && entry.surface === PANE_DOCK_DIFF_SURFACE
    && entry.diff !== null
    && navigationKey(entry.diff) === navigationKey(selection);
  return unchanged ? entry : {
    ...entry,
    open: true,
    surface: PANE_DOCK_DIFF_SURFACE,
    diff: selection,
  };
}

/** Closing the diff hands the body back to the panel view. */
export function withPaneDockDiffClosed(
  entry: PaneSideDockEntry,
): PaneSideDockEntry {
  if (!entry.diff) return entry;
  return {
    ...entry,
    diff: null,
    surface: entry.surface === PANE_DOCK_DIFF_SURFACE ? "" : entry.surface,
  };
}

function readStoredWidth(
  key: string,
  min: number,
  max: number,
  initial: number,
): number {
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0
      ? Math.max(min, Math.min(max, stored))
      : initial;
  } catch {
    return initial;
  }
}

function readStoredPaneSideDocks(): unknown {
  try {
    return JSON.parse(window.localStorage.getItem(PANE_SIDE_DOCK_KEY) || "null");
  } catch {
    return null;
  }
}

function modeDefaultOpen(): boolean {
  return sidePanelLayout(getSidePanelMode()).dockOpen;
}

export function usePaneSideDocks({
  leafIds,
  groups,
}: {
  leafIds: readonly string[];
  groups: readonly WorkbenchSideViewGroup[];
}) {
  const leafKey = leafIds.join("\0");
  const groupsKey = groups.map((group) => group.join(",")).join("|");
  const [docks, setDocks] = useState<Record<string, PaneSideDockEntry>>(() =>
    normalizePaneSideDocks(readStoredPaneSideDocks(), leafIds, groups, modeDefaultOpen()));
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const leafIdsRef = useRef(leafIds);
  leafIdsRef.current = leafIds;
  // Splits, closes, and view moves re-shape the map declaratively: entries
  // follow the live pane list and the CURRENT right-side layout, so a view
  // dragged to the left sidebar can never linger as a pane's active view.
  useEffect(() => {
    setDocks((current) => {
      const next = normalizePaneSideDocks(
        current,
        leafIdsRef.current,
        groupsRef.current,
        modeDefaultOpen(),
      );
      return samePaneSideDocks(current, next) ? current : next;
    });
  }, [leafKey, groupsKey]);
  // The side-panel mode policy still owns the dock half of its contract:
  // switching to open-both expands every pane dock, close-* folds them.
  useEffect(() => subscribeSidePanelMode(() => {
    const open = modeDefaultOpen();
    setDocks((current) => {
      const next: Record<string, PaneSideDockEntry> = {};
      for (const [leafId, entry] of Object.entries(current)) {
        next[leafId] = {
          ...entry,
          open: open && (entry.view !== null || entry.surface !== ""),
        };
      }
      return samePaneSideDocks(current, next) ? current : next;
    });
  }), []);
  // The retired beside-the-panel surface store is merged into this dock.
  useEffect(() => {
    for (const key of LEGACY_SIDE_SURFACE_KEYS) {
      try { window.localStorage.removeItem(key); } catch { /* cosmetic */ }
    }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(PANE_SIDE_DOCK_KEY, JSON.stringify(docks));
    } catch {
      // Dock state remains active for this renderer session.
    }
  }, [docks]);
  const entryFor = useCallback((leafId: string): PaneSideDockEntry =>
    docks[leafId] ?? CLOSED_ENTRY, [docks]);
  const patch = useCallback((
    leafId: string,
    updater: (entry: PaneSideDockEntry, firstRoot: WorkbenchSideViewId | null) => PaneSideDockEntry,
  ) => {
    setDocks((current) => {
      const firstRoot = firstPanelRoot(groupsRef.current);
      const entry = current[leafId] ?? { ...CLOSED_ENTRY, view: firstRoot };
      const next = updater(entry, firstRoot);
      const same = next.open === entry.open && next.view === entry.view
        && next.surface === entry.surface && next.diff === entry.diff;
      return same && current[leafId] ? current : { ...current, [leafId]: next };
    });
  }, []);
  /** Header-tab click contract (user: 소스컨트롤·브라우저 각각 선택해서
   *  여는): a panel view lands in the body, the browser lands as its stacked
   *  surface; folding stays with the dock's own toggle/close controls. */
  const select = useCallback((leafId: string, id: WorkbenchSideViewId) => {
    if (isWorkbenchSideLauncher(id)) return;
    patch(leafId, (entry) => id === PANE_DOCK_BROWSER_SURFACE
      ? { ...entry, open: true, surface: PANE_DOCK_BROWSER_SURFACE }
      : { ...entry, open: true, view: id, surface: "" });
  }, [patch]);
  /** Ensure the dock is open, optionally landing on a specific child. */
  const open = useCallback((leafId: string, id?: WorkbenchSideViewId) => {
    if (id && isWorkbenchSideLauncher(id)) return;
    if (id) {
      select(leafId, id);
      return;
    }
    patch(leafId, (entry, firstRoot) => {
      const view = entry.view ?? firstRoot;
      return { ...entry, open: view !== null || entry.surface !== "", view };
    });
  }, [patch, select]);
  const setOpen = useCallback((leafId: string, nextOpen: boolean) => {
    patch(leafId, (entry, firstRoot) => {
      if (!nextOpen) return { ...entry, open: false };
      const view = entry.view ?? firstRoot;
      return { ...entry, open: view !== null || entry.surface !== "", view };
    });
  }, [patch]);
  /** Fold/unfold the WHOLE unit (user: 한몸) — header, panel view, browser,
   *  and diff surfaces together. Children survive the fold. */
  const toggle = useCallback((leafId: string) => {
    patch(leafId, (entry, firstRoot) => {
      if (entry.open) return { ...entry, open: false };
      const view = entry.view ?? firstRoot;
      return { ...entry, open: view !== null || entry.surface !== "", view };
    });
  }, [patch]);
  const openDiff = useCallback((
    leafId: string,
    project: string,
    rel: string,
    request: PaneSideDiffRequest,
  ) => {
    const cleanProject = String(project || "").trim();
    const cleanRel = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!cleanProject || !cleanRel) return;
    patch(leafId, (entry) => withPaneDockDiffOpened(entry, {
      kind: "diff",
      project: cleanProject,
      rel: cleanRel,
      ...request,
    }));
  }, [patch]);
  const closeDiff = useCallback((leafId: string) => {
    patch(leafId, (entry) => withPaneDockDiffClosed(entry));
  }, [patch]);
  return {
    docks,
    entryFor,
    select,
    open,
    setOpen,
    toggle,
    openDiff,
    closeDiff,
  };
}

export function PaneSideDock({
  leafId,
  entry,
  groups,
  descriptors,
  focused,
  onSelect,
  onClose,
  onCloseDiff,
  onMoveGroup,
  onMoveView,
  onFocusPane,
  openFileTab,
  renderBrowserSurface,
  goalIsland,
  renderView,
}: {
  leafId: string;
  entry: PaneSideDockEntry;
  groups: readonly WorkbenchSideViewGroup[];
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  focused: boolean;
  onSelect(id: WorkbenchSideViewId): void;
  /** Folds the unit — the header X, and a re-click on the active icon
   *  (user: 오버레이까지 되는 판에 닫히는 거나 X가 있어야). */
  onClose(): void;
  onCloseDiff(): void;
  onMoveGroup(
    sourceRoot: WorkbenchSideViewId,
    targetSide: "left" | "right",
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement,
  ): void;
  onMoveView(
    sourceId: WorkbenchSideViewId,
    targetSide: "left" | "right",
    targetRoot: WorkbenchSideViewId | null,
    placement: WorkbenchSideViewPlacement,
  ): void;
  onFocusPane(): void;
  openFileTab(project: string, rel: string, line?: number): void;
  renderBrowserSurface?(active: boolean): ReactNode;
  goalIsland?: ReactNode;
  renderView(
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps,
  ): ReactNode;
}) {
  const openNow = entry.open && (entry.view !== null || entry.surface !== "");
  // Panels mount lazily on the pane's FIRST expand and stay mounted after,
  // so tree expansions and scroll survive fold/unfold without paying a
  // hidden mount in every pane that never opened its dock.
  const everOpened = useRef(openNow);
  if (openNow) everOpened.current = true;
  const surfaceShowing = openNow && entry.surface !== "";
  const browserShowing = surfaceShowing
    && entry.surface === PANE_DOCK_BROWSER_SURFACE;
  const diffShowing = surfaceShowing && paneGoalPlacement(entry) === "diff";
  // ── Unified width (user: 두개를 통합 넓이계산) ──
  // The dock measures its own pane cell: inline, the whole unit — diff pair
  // included — always leaves the conversation its workspace floor, and when
  // the unit cannot fit, the WHOLE unit floats over the pane (한몸 오버레이).
  const [panelPref, setPanelPref] = useState(() => readStoredWidth(
    PANE_SIDE_DOCK_WIDTH_KEY,
    DESKTOP_UTILITY_DOCK_MIN_WIDTH,
    PANE_SIDE_DOCK_PANEL_MAX_WIDTH,
    DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
  ));
  const [diffPref, setDiffPref] = useState(() => readStoredWidth(
    PANE_SIDE_DOCK_DIFF_WIDTH_KEY,
    PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
    PANE_SIDE_DOCK_DIFF_MAX_WIDTH,
    PANE_SIDE_DOCK_DIFF_DEFAULT_WIDTH,
  ));
  const [browserPref, setBrowserPref] = useState(() => readStoredWidth(
    PANE_SIDE_DOCK_BROWSER_WIDTH_KEY,
    PANE_SIDE_DOCK_BROWSER_MIN_WIDTH,
    PANE_SIDE_DOCK_BROWSER_MAX_WIDTH,
    PANE_SIDE_DOCK_BROWSER_DEFAULT_WIDTH,
  ));
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [cellWidth, setCellWidth] = useState(0);
  useEffect(() => {
    if (!openNow) return undefined;
    const cell = hostRef.current?.parentElement;
    if (!cell) return undefined;
    const measure = () => setCellWidth((current) =>
      current === cell.clientWidth ? current : cell.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [openNow]);
  const diffResizeStart = useRef<{ x: number; width: number } | null>(null);
  const diffDragPending = useRef<number | null>(null);
  if (groups.length === 0) return null;
  const room = cellWidth > 0
    ? cellWidth - DESKTOP_WORKSPACE_MIN_WIDTH
    : Number.POSITIVE_INFINITY;
  const panelDesired = Math.max(
    DESKTOP_UTILITY_DOCK_MIN_WIDTH,
    Math.min(panelPref, PANE_SIDE_DOCK_PANEL_MAX_WIDTH),
  );
  const diffDesired = Math.max(
    PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
    Math.min(diffPref, PANE_SIDE_DOCK_DIFF_MAX_WIDTH),
  );
  // Narrow ladder (user: 특정 폭 이하일 때):
  //   1단계 — the diff pair can no longer stand side by side even as a
  //   sheet, so the diff STACKS over the panel with a back step (2뎁스).
  //   2단계 — even one column cannot fit beside the rail, so the unit takes
  //   the WHOLE pane (browser included: 브라우저는 전체).
  const sheetAvail = cellWidth > 0 ? cellWidth - 48 : Number.POSITIVE_INFINITY;
  const pairMin =
    DESKTOP_UTILITY_DOCK_MIN_WIDTH + PANE_SIDE_DOCK_DIFF_MIN_WIDTH;
  const twoDepth = paneDiffStacks(
    diffShowing,
    sheetAvail,
    pairMin,
    isMobileRemoteSurface(),
  );
  const pairShowing = diffShowing && !twoDepth;
  const columnMin = browserShowing
    ? PANE_SIDE_DOCK_BROWSER_MIN_WIDTH
    : pairShowing
      ? pairMin
      : DESKTOP_UTILITY_DOCK_MIN_WIDTH;
  const fullTakeover = openNow && cellWidth > 0 && sheetAvail < columnMin;
  // Overlay decision: the diff PAIR never shrinks inline (user: 두개 합산이
  // 더 커지면 오버레이) — the moment panel+diff no longer fit beside the
  // conversation floor, the whole unit floats over the pane. View/browser
  // modes shrink toward their own minimum first.
  const overlay = fullTakeover || (openNow && (pairShowing
    ? room < panelDesired + diffDesired
    : browserShowing
      ? room < PANE_SIDE_DOCK_BROWSER_MIN_WIDTH
      : room < columnMin));
  const avail = fullTakeover
    ? cellWidth
    : overlay ? Math.max(columnMin, sheetAvail) : room;
  const asideWidth = Math.round(fullTakeover
    ? cellWidth
    : browserShowing
      ? Math.max(PANE_SIDE_DOCK_BROWSER_MIN_WIDTH, Math.min(browserPref, avail))
      : pairShowing
        ? Math.max(
            DESKTOP_UTILITY_DOCK_MIN_WIDTH,
            Math.min(panelDesired, avail - PANE_SIDE_DOCK_DIFF_MIN_WIDTH),
          )
        : Math.max(DESKTOP_UTILITY_DOCK_MIN_WIDTH, Math.min(panelPref, avail)));
  const diffWidth = pairShowing
    ? Math.round(Math.max(
        PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
        Math.min(diffDesired, avail - asideWidth),
      ))
    : 0;
  const commitWidthPref = (key: string, value: number) => {
    try { window.localStorage.setItem(key, String(value)); } catch { /* session-only */ }
  };
  // Browser: standalone under the header (user: 브라우저는 단독 맞고) — a
  // persistent layer stacked over the panel body. In the narrow 2뎁스 stage
  // the diff rides the same layer, with a back step to the list (user:
  // 디프소스를 사이드탭 패널에 올리고 뒤로가기).
  const twoDepthDiff = twoDepth && entry.diff
    ? <div className="workbench-side-surface-slot"
        data-surface-active={diffShowing ? "true" : "false"}>
        <SessionGoalHost placement="diff">{goalIsland}</SessionGoalHost>
        <div className="pane-dock-diff-back">
          <button type="button" onClick={onCloseDiff}>
            <ArrowLeft size={14} aria-hidden="true" />
            <span>{t("Back")}</span>
          </button>
        </div>
        <DeferredPersistentSurface active
          startupDelayMs={DIFF_STARTUP_DELAY_MS}
          fallback={<DesktopLoadingSurface label={t("Loading diff…")} />}>
          <ReadyGitDiffPane selection={entry.diff} active={diffShowing}
            onOpenFile={openFileTab}
            onClose={onCloseDiff} />
        </DeferredPersistentSurface>
      </div>
    : null;
  const browserSurface = renderBrowserSurface?.(browserShowing) ?? null;
  const surfaces = browserSurface || twoDepthDiff
    ? <>
      {browserSurface && <div className="workbench-side-surface-slot"
        data-surface-active={browserShowing ? "true" : "false"}
        inert={browserShowing ? undefined : true}
        aria-hidden={browserShowing ? undefined : true}>
        {browserSurface}
      </div>}
      {twoDepthDiff}
    </>
    : undefined;
  // Diff: PAIRED to the LEFT of the panel view (user: 디프는 하단 소스제어
  // 패널 왼쪽에 쌍으로), under the same header selection; a Source Control
  // click replaces the file in place. The narrow 2뎁스 stage retires the
  // pair column — the diff stacks over the panel instead.
  const diffColumn = entry.diff && !twoDepth
    ? <div className="pane-dock-diff-column"
        hidden={!diffShowing}
        style={{ "--pane-dock-diff-width": `${diffWidth}px` } as React.CSSProperties}>
        <div className="pane-dock-diff-resize" role="separator"
          aria-orientation="vertical"
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (event.button !== 0) return;
            diffResizeStart.current = { x: event.clientX, width: diffWidth };
            diffDragPending.current = null;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const start = diffResizeStart.current;
            if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const next = Math.max(
              PANE_SIDE_DOCK_DIFF_MIN_WIDTH,
              Math.min(PANE_SIDE_DOCK_DIFF_MAX_WIDTH,
                Math.round(start.width + (start.x - event.clientX))),
            );
            diffDragPending.current = next;
            setDiffPref(next);
          }}
          onPointerUp={(event) => {
            if (!diffResizeStart.current) return;
            diffResizeStart.current = null;
            try { event.currentTarget.releasePointerCapture(event.pointerId); } catch {}
            commitWidthPref(
              PANE_SIDE_DOCK_DIFF_WIDTH_KEY,
              diffDragPending.current ?? diffWidth,
            );
            diffDragPending.current = null;
          }} />
        <SessionGoalHost placement="diff">{goalIsland}</SessionGoalHost>
        <div className="pane-dock-diff-body">
          <div className="workbench-side-surface-slot"
            data-surface-active={diffShowing ? "true" : "false"}>
            <DeferredPersistentSurface active
              startupDelayMs={DIFF_STARTUP_DELAY_MS}
              fallback={<DesktopLoadingSurface label={t("Loading diff…")} />}>
              <ReadyGitDiffPane selection={entry.diff} active={diffShowing}
                onOpenFile={openFileTab}
                onClose={onCloseDiff} />
            </DeferredPersistentSurface>
          </div>
        </div>
      </div>
    : null;
  // ONE header line for the whole unit (user: 헤더 한 줄, 타이틀 줄 제거) —
  // just the child icons, spanning [diff | panel]; heights match the PANE
  // strip. While the diff pair shows, its panel view stays highlighted.
  return <div className="pane-side-dock"
    ref={hostRef}
    data-pane-id={leafId}
    data-open={openNow ? "true" : "false"}
    data-overlay={overlay ? "true" : "false"}
    onPointerDownCapture={focused ? undefined : (event) => {
      if (event.button === 0) onFocusPane();
    }}>
    {/* Phone sheet: tapping OUTSIDE the frame folds the unit (user: 모바일
        프레임 외 영역 터치 시 접힘). Only the narrow-band CSS displays this
        catcher; it dims nothing, matching the other sheets. */}
    <button type="button" className="dock-backdrop"
      data-state={openNow ? "open" : "closed"}
      aria-hidden={!openNow}
      tabIndex={openNow ? 0 : -1}
      onClick={onClose}
      aria-label={t("Close panel")} />
    {openNow && <header className="pane-side-dock-header">
      <WorkbenchSideIconBar side="right" groups={groups}
        activeRoot={browserShowing ? PANE_DOCK_BROWSER_SURFACE : entry.view}
        descriptors={descriptors} orientation="horizontal"
        onSelect={(id) => {
          // Re-clicking the ACTIVE child folds the unit — essential once it
          // floats over the pane as an overlay.
          const activeChild = browserShowing
            ? PANE_DOCK_BROWSER_SURFACE
            : entry.view;
          if (id === activeChild && !isWorkbenchSideLauncher(id)) onClose();
          else onSelect(id);
        }}
        onMoveGroup={onMoveGroup} onMoveView={onMoveView} />
      <button type="button" className="pane-side-dock-close"
        aria-label={t("Close panel")} data-tooltip={t("Close panel")}
        onClick={onClose}>
        {/* Same voice as the island buttons: lucide line work at 20px — the
            codicon font glyph read thinner and off-size beside them (user:
            사이드탭 X가 정렬이나 크기가 다른 것 같다). A bare two-stroke X
            at the pictograms' weight reads HEAVIER than they do, so it takes
            one step less stroke to sit at the same optical weight (user: X가
            뭔가 달라보이는데). */}
        <X size={20} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </header>}
    {(openNow || everOpened.current) && <div className="pane-side-dock-main">
    {diffColumn}
    <WorkbenchSidePanel
      side="right"
      embedded
      hideTabs
      open={openNow}
      groups={groups}
      activeRoot={entry.view}
      surfaces={surfaces}
      surfacesActive={browserShowing || twoDepth}
      descriptors={descriptors}
      onSelect={onSelect}
      onMoveGroup={onMoveGroup}
      onMoveView={onMoveView}
      widthOverride={asideWidth}
      onWidthDrag={(next, commit) => {
        if (browserShowing) {
          setBrowserPref(next);
          if (commit) commitWidthPref(PANE_SIDE_DOCK_BROWSER_WIDTH_KEY, next);
        } else {
          setPanelPref(next);
          if (commit) commitWidthPref(PANE_SIDE_DOCK_WIDTH_KEY, next);
        }
      }}
      widthRange={browserShowing
        ? {
            min: PANE_SIDE_DOCK_BROWSER_MIN_WIDTH,
            max: PANE_SIDE_DOCK_BROWSER_MAX_WIDTH,
            initial: PANE_SIDE_DOCK_BROWSER_DEFAULT_WIDTH,
          }
        : {
            min: DESKTOP_UTILITY_DOCK_MIN_WIDTH,
            max: PANE_SIDE_DOCK_PANEL_MAX_WIDTH,
            initial: DESKTOP_UTILITY_DOCK_DEFAULT_WIDTH,
          }}
      renderView={renderView}
    />
    </div>}
  </div>;
}
