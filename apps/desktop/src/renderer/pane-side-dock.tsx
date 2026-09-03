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
import { isMobileRemoteSurface } from "./mobile-surface";
import {
  isWorkbenchSideLauncher,
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
  source: "staged" | "unstaged" | "commit" | "session";
  hash?: string;
  untracked?: boolean;
};
export type PaneSideDockEntry = {
  open: boolean;
  /** Active classic panel view; the browser and diffs live in `surface`. */
  view: WorkbenchSideViewId | null;
  /** "" shows the panel view; "browser" or "diff" otherwise. */
  surface: string;
  /** The single open file diff — a project-tool click REPLACES it (user: 헤더
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
export const PANE_DOCK_TERMINAL_SURFACE = "terminal";
export const PANE_DOCK_DIFF_SURFACE = "diff";
/** The diff child is the showing surface of an open unit. */
export function paneDiffShowing(
  entry: Pick<PaneSideDockEntry, "open" | "surface" | "diff">,
): boolean {
  return entry.open && entry.surface === PANE_DOCK_DIFF_SURFACE && entry.diff !== null;
}
// The Goal capsule stays on the composer. It used to ride the diff column
// while a diff showed, which read as the Goal UI leaking into Source Control
// (user: 소스컨트롤에 GOAL UI 딸려 들어가는 버그).
/** A closed diff column waits at least this long, and for a typing pause of
 *  the same length, before its tree is dropped: the unmount commit of a
 *  large diff is one uninterruptible task, so it must not land between two
 *  keystrokes. */
export const PANE_DOCK_DIFF_RETAIN_MS = 1_500;
function useRetainedDiff(diff: PaneSideDockDiff | null): PaneSideDockDiff | null {
  const [retained, setRetained] = useState<PaneSideDockDiff | null>(diff);
  useEffect(() => {
    if (diff) {
      setRetained(diff);
      return undefined;
    }
    let lastInputAt = performance.now();
    const noteInput = () => { lastInputAt = performance.now(); };
    document.addEventListener("keydown", noteInput, true);
    document.addEventListener("input", noteInput, true);
    let timer = 0;
    const attempt = () => {
      const quietFor = performance.now() - lastInputAt;
      if (quietFor < PANE_DOCK_DIFF_RETAIN_MS) {
        timer = window.setTimeout(attempt, PANE_DOCK_DIFF_RETAIN_MS - quietFor);
        return;
      }
      timer = 0;
      startTransition(() => setRetained(null));
    };
    timer = window.setTimeout(attempt, PANE_DOCK_DIFF_RETAIN_MS);
    return () => {
      document.removeEventListener("keydown", noteInput, true);
      document.removeEventListener("input", noteInput, true);
      window.clearTimeout(timer);
    };
  }, [diff]);
  return retained;
}
/** The dock child a pane is showing — the session surface when one is up,
 *  otherwise the classic panel view — or null while the unit is folded. The
 *  strip toggles and the dock header read the same answer. */
export function paneDockActiveRoot(
  entry: Pick<PaneSideDockEntry, "open" | "view" | "surface">,
): WorkbenchSideViewId | null {
  if (!entry.open) return null;
  if (entry.surface === PANE_DOCK_BROWSER_SURFACE) return "browser";
  if (entry.surface === PANE_DOCK_TERMINAL_SURFACE) return "terminal";
  return entry.view;
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
  return !isWorkbenchSideLauncher(id)
    && id !== PANE_DOCK_BROWSER_SURFACE
    && id !== PANE_DOCK_TERMINAL_SURFACE;
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
      || ((record.source === "commit" || record.source === "session")
        && typeof record.hash === "string" && record.hash.length > 0));
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
  const sessionSurfaces = new Set<string>(groups.flat().filter((id) =>
    id === PANE_DOCK_BROWSER_SURFACE || id === PANE_DOCK_TERMINAL_SURFACE));
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
      || storedSurface === PANE_DOCK_TERMINAL_SURFACE
      ? sessionSurfaces.has(storedSurface) ? storedSurface : ""
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
      || id === PANE_DOCK_TERMINAL_SURFACE
      ? { ...entry, open: true, surface: id }
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
  prewarm = false,
  onSelect,
  onClose,
  onCloseDiff,
  onMoveGroup,
  onMoveView,
  onFocusPane,
  openFileTab,
  renderBrowserSurface,
  renderTerminalSurface,
  renderView,
}: {
  leafId: string;
  entry: PaneSideDockEntry;
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
  renderTerminalSurface?(active: boolean): ReactNode;
  renderView(
    id: WorkbenchSideViewId,
    active: boolean,
    titleDragProps: WorkbenchSideTitleDragProps,
  ): ReactNode;
}) {
  const openNow = entry.open && (entry.view !== null || entry.surface !== "");
  // The focused pane may hidden-mount its shell after boot; every other pane
  // stays lazy until first expand. Once opened, a panel remains mounted so
  // tree expansions and scroll survive fold/unfold.
  const everOpened = useRef(openNow);
  if (openNow) everOpened.current = true;
  const panelMounted = openNow || everOpened.current || prewarm;
  // A cold dock used to mount Session Diff/Pull Requests/the browser slot in the
  // SAME click commit that expanded the panel. That heavy tree held back the
  // first visible frame, so the tab felt delayed even though the state update
  // itself was synchronous. Commit the correctly sized shell first, then
  // attach the body on the next frame. Warmed and previously visited docks
  // keep their live body and reopen without this hand-off.
  const [dockBodyMounted, setDockBodyMounted] = useState(openNow);
  useEffect(() => {
    if (dockBodyMounted || (!openNow && !prewarm)) return undefined;
    const frame = window.requestAnimationFrame(() => setDockBodyMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, [dockBodyMounted, openNow, prewarm]);
  const surfaceShowing = openNow && entry.surface !== "";
  const browserShowing = surfaceShowing
    && entry.surface === PANE_DOCK_BROWSER_SURFACE;
  const terminalShowing = surfaceShowing
    && entry.surface === PANE_DOCK_TERMINAL_SURFACE;
  const sessionSurfaceShowing = browserShowing || terminalShowing;
  const diffShowing = surfaceShowing && paneDiffShowing(entry);
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
  // Phone sheet: a press OUTSIDE the unit folds it (user: 모바일 프레임 외
  // 영역 터치 시 접힘). This is a document-level hit test, not a backdrop
  // element: a fixed backdrop inside the sliding (transformed) root covered
  // only the sheet's own box, and one portaled to body stacked OVER the
  // sheet and ate its taps (user: 소스컨트롤창 클릭과 드래그가 안 됨). The
  // session surfaces and the strip's own toggles count as inside — the
  // toggle decides the fold itself. The Browser Use and Terminal surfaces are
  // FIXED containers positioned over their slot, not children of the unit,
  // so they are named explicitly (user: 브라우저창 누르면 나가짐).
  useEffect(() => {
    if (!openNow || !isMobileRemoteSurface()) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (hostRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(
        ".pane-dock-toggles, .session-terminal-surface-container, .session-browser-surface-container",
      )) return;
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [openNow, onClose]);
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
  const columnMin = sessionSurfaceShowing
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
    : sessionSurfaceShowing
      ? room < PANE_SIDE_DOCK_BROWSER_MIN_WIDTH
      : room < columnMin));
  const avail = fullTakeover
    ? cellWidth
    : overlay ? Math.max(columnMin, sheetAvail) : room;
  const asideWidth = Math.round(fullTakeover
    ? cellWidth
    : sessionSurfaceShowing
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
  const twoDepthDiff = dockBodyMounted && twoDepth && entry.diff
    ? <div className="workbench-side-surface-slot"
        data-surface-active={diffShowing ? "true" : "false"}>
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
  const browserSurface = dockBodyMounted
    ? renderBrowserSurface?.(browserShowing) ?? null
    : null;
  const terminalSurface = dockBodyMounted
    ? renderTerminalSurface?.(terminalShowing) ?? null
    : null;
  const surfaces = browserSurface || terminalSurface || twoDepthDiff
    ? <>
      {browserSurface && <div className="workbench-side-surface-slot"
        data-surface-active={browserShowing ? "true" : "false"}
        inert={browserShowing ? undefined : true}
        aria-hidden={browserShowing ? undefined : true}>
        {browserSurface}
      </div>}
      {terminalSurface && <div className="workbench-side-surface-slot"
        data-surface-active={terminalShowing ? "true" : "false"}
        inert={terminalShowing ? undefined : true}
        aria-hidden={terminalShowing ? undefined : true}>
        {terminalSurface}
      </div>}
      {twoDepthDiff}
    </>
    : undefined;
  // File Diff: PAIRED to the LEFT of the panel view under the same header
  // selection; a project-tool click replaces the file in place. The narrow
  // 2뎁스 stage retires the pair column — the diff stacks over the panel.
  const columnDiff = entry.diff ?? retainedDiff;
  if (pairShowing && diffWidth > 0) shownDiffWidth.current = diffWidth;
  const columnWidth = pairShowing ? diffWidth : shownDiffWidth.current || diffDesired;
  const diffColumn = dockBodyMounted && columnDiff && !twoDepth
    ? <div className="pane-dock-diff-column"
        hidden={!diffShowing}
        inert={diffShowing ? undefined : true}
        style={{ "--pane-dock-diff-width": `${columnWidth}px` } as React.CSSProperties}>
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
        <div className="pane-dock-diff-body">
          <div className="workbench-side-surface-slot"
            data-surface-active={diffShowing ? "true" : "false"}>
            <DeferredPersistentSurface active
              startupDelayMs={DIFF_STARTUP_DELAY_MS}
              fallback={<DesktopLoadingSurface label={t("Loading diff…")} />}>
              <ReadyGitDiffPane selection={columnDiff} active={diffShowing}
                onOpenFile={openFileTab}
                onClose={onCloseDiff} />
            </DeferredPersistentSurface>
          </div>
        </div>
      </div>
    : null;
  // ONE header line for the whole unit (user: 헤더 한 줄), spanning
  // [diff | panel] at the PANE strip's height. The child icons moved to the
  // pane strip's right end (PaneDockToggles), so the header names only the
  // showing child and carries the fold X — the Claude Desktop card grammar.
  // The title is text-only: the strip icon already identifies the view
  // (user: 사이드탭 타이틀 옆 아이콘 제거).
  const activeRoot = paneDockActiveRoot(entry);
  // The phone sheet slides out as ONE piece, header included, so the header
  // stays mounted through the exit and names the last shown child.
  const mobileSheet = isMobileRemoteSurface();
  const headerShowing = openNow || mobileSheet;
  const titleRoot = activeRoot ?? (mobileSheet ? entry.view : null);
  const activeDescriptor = titleRoot ? descriptors.get(titleRoot) : undefined;
  return <div className="pane-side-dock"
    ref={hostRef}
    data-pane-id={leafId}
    data-open={openNow ? "true" : "false"}
    data-overlay={overlay ? "true" : "false"}
    onPointerDownCapture={focused ? undefined : (event) => {
      if (event.button === 0) onFocusPane();
    }}>
    {headerShowing && <header className="pane-side-dock-header">
      {activeDescriptor && <div className="pane-side-dock-title">
        <span>{t(activeDescriptor.title ?? activeDescriptor.label)}</span>
      </div>}
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
    {panelMounted && <div className="pane-side-dock-main">
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
      onWidthDrag={(next, commit) => {
        if (sessionSurfaceShowing) {
          setBrowserPref(next);
          if (commit) commitWidthPref(PANE_SIDE_DOCK_BROWSER_WIDTH_KEY, next);
        } else {
          setPanelPref(next);
          if (commit) commitWidthPref(PANE_SIDE_DOCK_WIDTH_KEY, next);
        }
      }}
      widthRange={sessionSurfaceShowing
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
      renderView={(id, active, titleDragProps) =>
        dockBodyMounted ? renderView(id, active, titleDragProps) : null}
    />
    </div>}
  </div>;
}
