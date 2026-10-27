// Effect hooks of the per-pane right dock (PaneSideDock): cell measuring,
// expanded sheet geometry and the surface close request. Each takes only the values it reads.
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { flushSync } from 'react-dom';
import { PANE_DOCK_CLOSE_EVENT } from './pane-dock-chrome';
import {
  getSidePanelPosition,
  resolveSidePanelPlacement,
  subscribeSidePanelPosition,
  type SidePanelPlacement,
} from './side-panel-preferences';
import { expandedDockRect } from './surface-slots';
import { useResizeGesture } from './resize-gesture';
import { SIDE_FILE_PROBLEMS_DEFAULT_HEIGHT } from './side-file-problems';
import type { SideFileChrome } from './side-surface-strip';

/**
 * Lazy panel mounting. The focused pane may hidden-mount its shell after
 * boot; every other pane stays lazy until first expand, and once opened a
 * panel remains mounted so tree expansions and scroll survive fold/unfold.
 * An open dock always carries its body: a cold dock mounts it in the opening
 * commit, so the sheet never paints empty. Only the closed prewarm attaches
 * the body a frame after its hidden shell.
 */
export function useDockMounting(openNow: boolean, prewarm: boolean) {
  const everOpened = useRef(openNow);
  if (openNow) everOpened.current = true;
  const panelMounted = openNow || everOpened.current || prewarm;
  const [warmed, setWarmed] = useState(false);
  const opened = everOpened.current;
  useEffect(() => {
    if (warmed || opened || !prewarm) return undefined;
    const frame = window.requestAnimationFrame(() => setWarmed(true));
    return () => window.cancelAnimationFrame(frame);
  }, [warmed, opened, prewarm]);
  return { panelMounted, dockBodyMounted: opened || warmed };
}

/**
 * The phone sheet's exit slide. A close keeps the sheet's last open body on
 * screen while the sheet's own transform transition carries it off: true from
 * the close commit until that transition ends or is cancelled (filtered to the
 * sheet and its transform), false at once on a reopen and whenever no such
 * transition runs (an instant close, reduced motion). The close itself stays
 * semantic and immediate; the caller keeps the closing body hidden, inert and
 * aria-hidden.
 */
export function useSheetExit(hostRef: RefObject<HTMLElement | null>, open: boolean, sheet: boolean): boolean {
  const [exit, setExit] = useState({ open, closing: false });
  let closing = exit.closing;
  if (exit.open !== open) {
    closing = sheet && !open;
    setExit({ open, closing });
  }
  useLayoutEffect(() => {
    if (!closing) return undefined;
    const host = hostRef.current;
    const end = () => setExit((current) => (current.closing ? { ...current, closing: false } : current));
    const sliding = host
      ?.getAnimations()
      .some((a) => a instanceof CSSTransition && a.transitionProperty === 'transform' && a.playState === 'running');
    if (!host || !sliding) {
      end();
      return undefined;
    }
    const settle = (event: TransitionEvent) => {
      if (event.target === host && event.propertyName === 'transform') end();
    };
    host.addEventListener('transitionend', settle);
    host.addEventListener('transitioncancel', settle);
    return () => {
      host.removeEventListener('transitionend', settle);
      host.removeEventListener('transitioncancel', settle);
    };
  }, [closing, hostRef]);
  return closing;
}

/** The side file tabs' strip chrome (one per mounted editor, keyed by file
 *  key; the setter of a key is stable) and the Problems split (open state +
 *  height). */
export function useSideFileProblems(hasSideFile: boolean) {
  const [fileChromes, setFileChromes] = useState<Readonly<Record<string, SideFileChrome | null>>>({});
  const chromeSetters = useRef(new Map<string, (chrome: SideFileChrome | null) => void>());
  const chromeSetter = useCallback((fileKey: string) => {
    let setter = chromeSetters.current.get(fileKey);
    if (!setter) {
      setter = (chrome) =>
        setFileChromes((current) => {
          if ((current[fileKey] ?? null) === chrome) return current;
          if (chrome === null) {
            const { [fileKey]: _gone, ...rest } = current;
            return rest;
          }
          return { ...current, [fileKey]: chrome };
        });
      chromeSetters.current.set(fileKey, setter);
    }
    return setter;
  }, []);
  const [fileProblemsOpen, setFileProblemsOpen] = useState(false);
  const [fileProblemsHeight, setFileProblemsHeight] = useState(SIDE_FILE_PROBLEMS_DEFAULT_HEIGHT);
  const toggleFileProblems = useCallback(() => setFileProblemsOpen((open) => !open), []);
  useEffect(() => {
    if (!hasSideFile) setFileProblemsOpen(false);
  }, [hasSideFile]);
  return {
    fileChromes,
    chromeSetter,
    fileProblemsOpen,
    setFileProblemsOpen,
    fileProblemsHeight,
    setFileProblemsHeight,
    toggleFileProblems,
  };
}
export type SideFileProblemsState = ReturnType<typeof useSideFileProblems>;

export const commitWidthPref = (key: string, value: number) => {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* session-only */
  }
};

/**
 * Drag-resize of the panel column: every surface (panel, browser/file,
 * terminal) shares one width preference, which a gesture previews and
 * commits. A cancel restores the stored preference as it stood when the
 * gesture began, not the constrained rendered width it reports.
 */
export function usePanelWidthDrag({
  dockPref,
  setDockPref,
  storageKey,
}: {
  dockPref: number;
  setDockPref: (width: number) => void;
  storageKey: string;
}) {
  // The stored preference as it stood when a panel resize gesture began: a
  // cancel restores it rather than the constrained rendered width.
  const panelWidthSnapshot = useRef<number | null>(null);
  return (next: number, phase: 'preview' | 'commit' | 'cancel') => {
    if (phase === 'preview' && panelWidthSnapshot.current === null) panelWidthSnapshot.current = dockPref;
    if (phase === 'cancel') {
      const snapshot = panelWidthSnapshot.current;
      panelWidthSnapshot.current = null;
      if (snapshot !== null) setDockPref(snapshot);
      return;
    }
    if (phase === 'commit') panelWidthSnapshot.current = null;
    setDockPref(next);
    if (phase === 'commit') commitWidthPref(storageKey, next);
  };
}

/**
 * Drag-resize of the diff pair column. A cancel restores the preference as it
 * stood when the gesture began; a commit persists the pending (or rendered)
 * width through `commitWidth`.
 */
export function useDiffColumnResize({
  diffPref,
  setDiffPref,
  getDiffWidth,
  minWidth,
  maxWidth,
  commitWidth,
}: {
  diffPref: number;
  setDiffPref: (width: number) => void;
  getDiffWidth: () => number;
  minWidth: number;
  maxWidth: number;
  commitWidth: (width: number) => void;
}) {
  const diffResizeStart = useRef<{ x: number; width: number; pref: number } | null>(null);
  const diffDragPending = useRef<number | null>(null);
  const diffResizeGesture = useResizeGesture((commit) => {
    const start = diffResizeStart.current;
    if (!start) return;
    diffResizeStart.current = null;
    if (commit) commitWidth(diffDragPending.current ?? getDiffWidth());
    else if (diffDragPending.current !== null) setDiffPref(start.pref);
    diffDragPending.current = null;
  });
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      diffResizeGesture.begin(event);
      diffResizeStart.current = { x: event.clientX, width: getDiffWidth(), pref: diffPref };
      diffDragPending.current = null;
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const start = diffResizeStart.current;
      if (!start || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const next = Math.max(minWidth, Math.min(maxWidth, Math.round(start.width + (start.x - event.clientX))));
      diffDragPending.current = next;
      setDiffPref(next);
    },
    ...diffResizeGesture.handlers,
  };
}

/** The dock measures its own pane cell while open. A resize commits inside
 *  the observer, before paint: the dock's width, overlay and diff stacking
 *  follow a window drag in the frame that moved the cell, never one later. */
export function useDockCellWidth(hostRef: RefObject<HTMLDivElement | null>, openNow: boolean): number {
  const [cellWidth, setCellWidth] = useState(0);
  useEffect(() => {
    if (!openNow) return undefined;
    const cell = hostRef.current?.parentElement;
    if (!cell) return undefined;
    const measure = () => setCellWidth((current) => (current === cell.clientWidth ? current : cell.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(cell);
    return () => observer.disconnect();
  }, [hostRef, openNow]);
  return cellWidth;
}

/** The docks open inline in each workspace column, by claim. The column's
 *  `data-inline-dock` holds while any claim does; the frame rules key on it
 *  (pane-layout.css, pane-side-dock-bottom.css) instead of
 *  `.main-panel:has(.pane-side-dock[data-open="true"]:not([data-overlay="true"]):not([data-expanded="true"]))`,
 *  which re-walked the whole column — a hidden diff panel's ~50k nodes
 *  included — on every composer keystroke (~4ms of style recalc per key). */
const inlineDockClaims = new WeakMap<HTMLElement, Set<object>>();

function claimInlineDock(column: HTMLElement, claim: object): void {
  let claims = inlineDockClaims.get(column);
  if (!claims) {
    claims = new Set();
    inlineDockClaims.set(column, claims);
  }
  claims.add(claim);
  column.dataset.inlineDock = 'true';
}

function releaseInlineDock(column: HTMLElement, claim: object): void {
  const claims = inlineDockClaims.get(column);
  claims?.delete(claim);
  if (!claims?.size) delete column.dataset.inlineDock;
}

/** Marks the `.main-panel` around `hostRef` with `data-inline-dock="true"`
 *  while this dock is inline: `inline.current`, written by the dock's render
 *  as exactly what its own data-open / data-overlay / data-expanded say (open,
 *  not overlaying, not expanded). Several panes each own a dock; the flag
 *  holds while any of them is inline.
 *
 *  Written in an insertion effect: React runs every insertion effect of a
 *  commit (in its mutation phase, release on unmount included) before any
 *  layout effect of that commit, so no layout effect anywhere in the tree —
 *  the dock's own measurements, its children's, a sibling's — can measure the
 *  layout the flag is about to change, just as with the `:has()` it replaces.
 *  The one commit an insertion effect cannot reach the host is the one that
 *  creates it (React attaches refs in the layout phase); there the layout
 *  effect below claims it, so the caller calls this before its measuring
 *  hooks. */
export function useInlineDockFlag(
  hostRef: RefObject<HTMLDivElement | null>,
  inline: { readonly current: boolean }
): void {
  const claim = useRef<object>({});
  const held = useRef<HTMLElement | null>(null);
  const sync = () => {
    const host = hostRef.current;
    // Inline but not attached yet: the commit that creates the host (the layout effect syncs it).
    if (inline.current && !host) return;
    const column = inline.current && host ? host.closest<HTMLElement>('.main-panel') : null;
    if (column === held.current) return;
    if (held.current) releaseInlineDock(held.current, claim.current);
    if (column) claimInlineDock(column, claim.current);
    held.current = column;
  };
  useInsertionEffect(sync);
  // Known limit, the commit that creates the host only: the claim lands here,
  // so layout effects of earlier siblings and of the dock body's children in
  // that one commit can measure the pre-flag layout (their observers measure
  // again); the first paint is still flagged. Every later commit is exact.
  useLayoutEffect(sync);
  useInsertionEffect(
    () => () => {
      if (held.current) releaseInlineDock(held.current, claim.current);
      held.current = null;
    },
    []
  );
}

/** Bottom placement: the dock's own height preference, shared by every pane. */
export const PANE_SIDE_DOCK_HEIGHT_KEY = 'mixdog.desktop.pane-side-dock-height.v1';
export const PANE_SIDE_DOCK_MIN_HEIGHT = 160;
export const PANE_SIDE_DOCK_DEFAULT_HEIGHT = 320;
/** The chat keeps at least this much of the cell above a bottom dock. */
export const PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR = 200;

/** A bottom dock's rendered height: the preference, held between the dock
 *  floor and what leaves the chat its floor. `room` is the height the chat
 *  and the dock share (see paneDockRoom); null = not measured yet. A measured
 *  0 (fixed rows fill a short pane) holds the dock at its floor. */
export function clampPaneDockHeight(pref: number, room: number | null): number {
  const max =
    room === null
      ? Number.POSITIVE_INFINITY
      : Math.max(PANE_SIDE_DOCK_MIN_HEIGHT, room - PANE_SIDE_DOCK_BOTTOM_CHAT_FLOOR);
  const value = Number.isFinite(pref) ? pref : PANE_SIDE_DOCK_DEFAULT_HEIGHT;
  return Math.round(Math.min(max, Math.max(PANE_SIDE_DOCK_MIN_HEIGHT, value)));
}

/** The axis the dock's resize edge drags along: width beside the chat,
 *  height below it. */
export function paneDockResizeAxis(placement: SidePanelPlacement): 'width' | 'height' {
  return placement === 'bottom' ? 'height' : 'width';
}

function subscribeSidePanelPlacement(listener: () => void): () => void {
  const unsubscribe = subscribeSidePanelPosition(listener);
  // Dropped here too: this listener may run before the module's own one.
  const onResize = () => {
    dropPlacementViewport();
    listener();
  };
  window.addEventListener('resize', onResize);
  return () => {
    unsubscribe();
    window.removeEventListener('resize', onResize);
  };
}

/** The viewport the placement was resolved for, dropped on every resize.
 *  React reads the snapshot in each render and again inside the commit, and
 *  reading window.innerWidth lays the page out: every pane render after a DOM
 *  change paid a forced layout for an answer that only a resize can change. */
let placementViewport: { width: number; height: number } | null = null;
let placementViewportWatched = false;
function dropPlacementViewport(): void {
  placementViewport = null;
}
function viewportForPlacement(): { width: number; height: number } {
  if (!placementViewportWatched) {
    placementViewportWatched = true;
    window.addEventListener('resize', dropPlacementViewport);
  }
  placementViewport ??= { width: window.innerWidth, height: window.innerHeight };
  return placementViewport;
}

function sidePanelPlacementSnapshot(): SidePanelPlacement {
  const { width, height } = viewportForPlacement();
  return resolveSidePanelPlacement(getSidePanelPosition(), width, height);
}

/** The desktop placement of the pane docks: the stored position, with Auto
 *  following the window shape (re-renders only when the answer flips). */
export function useSidePanelPlacement(): SidePanelPlacement {
  return useSyncExternalStore(subscribeSidePanelPlacement, sidePanelPlacementSnapshot, () => 'right');
}

/** The cell rows that share the chat's column and never yield to the dock:
 *  everything in flow except the chat stack itself and the dock (or its
 *  expanded spacer) — the tab strip, the Problems panel, the footer slot. */
function isFixedPaneRow(child: Element, host: Element): child is HTMLElement {
  if (child === host || !(child instanceof HTMLElement)) return false;
  if (child.classList.contains('pane-surface-stack') || child.classList.contains('pane-side-dock-spacer')) return false;
  const position = window.getComputedStyle(child).position;
  return position !== 'absolute' && position !== 'fixed';
}

/** The height the chat and a bottom dock share inside the pane cell: the
 *  cell minus its fixed rows (border boxes — the Problems panel's negative
 *  overlay margin is not space it gives back) and the dock's own margins.
 *  Computed from the siblings only, so the dock's height never feeds it. */
export function paneDockRoom(host: HTMLElement): number {
  const cell = host.parentElement;
  if (!cell) return 0;
  let fixed = 0;
  for (const child of Array.from(cell.children)) {
    if (isFixedPaneRow(child, host)) fixed += child.offsetHeight;
  }
  const style = window.getComputedStyle(host);
  const margins = (Number.parseFloat(style.marginTop) || 0) + (Number.parseFloat(style.marginBottom) || 0);
  return Math.max(0, cell.clientHeight - fixed - margins);
}

/** Measures paneDockRoom while docked below the chat: again whenever the cell
 *  resizes (window shrink), a fixed row resizes (Problems drag) or a row
 *  mounts or unmounts (Problems opens or closes). */
export function useDockRoomHeight(hostRef: RefObject<HTMLDivElement | null>, active: boolean): number | null {
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!active) return undefined;
    const host = hostRef.current;
    const cell = host?.parentElement;
    if (!host || !cell) return undefined;
    const measure = () => {
      const next = paneDockRoom(host);
      setRoom((current) => (current === next ? current : next));
    };
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => flushSync(measure));
    const observeRows = () => {
      if (!resizes) return;
      resizes.disconnect();
      resizes.observe(cell);
      for (const child of Array.from(cell.children)) if (isFixedPaneRow(child, host)) resizes.observe(child);
    };
    const rows =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver(() => {
            observeRows();
            measure();
          });
    rows?.observe(cell, { childList: true });
    observeRows();
    measure();
    return () => {
      rows?.disconnect();
      resizes?.disconnect();
    };
  }, [hostRef, active]);
  return room;
}

/**
 * Drag-resize of a bottom dock's top edge. Dragging up grows the dock; a
 * cancel restores the preference as it stood when the gesture began, a
 * commit persists the dragged height.
 */
export function useDockHeightDrag({
  heightPref,
  setHeightPref,
  renderedHeight,
  room,
  storageKey,
}: {
  heightPref: number;
  setHeightPref: (height: number) => void;
  renderedHeight: number;
  /** See paneDockRoom. */
  room: number | null;
  storageKey: string;
}) {
  const start = useRef<{ y: number; height: number; pref: number } | null>(null);
  const pending = useRef<number | null>(null);
  const gesture = useResizeGesture((commit) => {
    const current = start.current;
    if (!current) return;
    start.current = null;
    if (commit) {
      if (pending.current !== null) commitWidthPref(storageKey, pending.current);
    } else if (pending.current !== null) setHeightPref(current.pref);
    pending.current = null;
  });
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      gesture.begin(event);
      start.current = { y: event.clientY, height: renderedHeight, pref: heightPref };
      pending.current = null;
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const current = start.current;
      if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const next = clampPaneDockHeight(current.height + (current.y - event.clientY), room);
      pending.current = next;
      setHeightPref(next);
    },
    ...gesture.handlers,
  };
}

/**
 * Expanded in-flow surfaces (file, diff, Changes): transient dock state, like
 * the browser/terminal roots. The dock sheet then covers the main panel
 * (fixed rect, same box and gaps as an expanded browser/terminal) while a
 * spacer keeps its column, so the conversation never reflows or unmounts.
 */
export function useDockExpansion(
  hostRef: RefObject<HTMLDivElement | null>,
  surface: string,
  view: string | null,
  openNow: boolean
) {
  const [expanded, setExpanded] = useState(false);
  const [expandedRect, setExpandedRect] = useState<ReturnType<typeof expandedDockRect>>(undefined);
  const restWidth = useRef(0);
  const restHeight = useRef(0);
  const toggleExpanded = useCallback(
    () =>
      setExpanded((value) => {
        if (!value) {
          const rect = hostRef.current?.getBoundingClientRect();
          restWidth.current = Math.round(rect?.width ?? 0);
          restHeight.current = Math.round(rect?.height ?? 0);
        }
        return !value;
      }),
    [hostRef]
  );
  // Switching surface/view or closing the dock resets expansion.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys are the reset triggers, not values the body reads
  useEffect(() => {
    setExpanded(false);
  }, [surface, view, openNow]);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!expanded || !openNow || !host) {
      setExpandedRect(undefined);
      return undefined;
    }
    const measure = () => setExpandedRect(expandedDockRect(host));
    measure();
    window.addEventListener('resize', measure);
    const panel = host.closest('.main-panel');
    const observer = panel && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (panel) observer?.observe(panel);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [hostRef, expanded, openNow]);
  return { expanded, expandedRect, restWidth, restHeight, toggleExpanded };
}

/**
 * Surfaces live in their own React roots; their header X asks the dock
 * showing that surface to fold. A session surface (browser, terminal) floats
 * outside the dock, so clicking it never focuses the pane: the session it
 * names picks the dock. Without one, the focused dock takes it.
 */
export function useDockCloseRequest(
  active: boolean,
  surface: string,
  focused: boolean,
  onClose: () => void,
  sessionId = ''
) {
  useEffect(() => {
    if (!active) return undefined;
    const onCloseRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ surface?: string; sessionId?: string }>).detail;
      if (detail?.surface !== surface) return;
      if (detail.sessionId ? detail.sessionId === sessionId : focused) onClose();
    };
    window.addEventListener(PANE_DOCK_CLOSE_EVENT, onCloseRequest);
    return () => window.removeEventListener(PANE_DOCK_CLOSE_EVENT, onCloseRequest);
  }, [active, surface, focused, onClose, sessionId]);
}
