// Effect hooks of the per-pane right dock (PaneSideDock): cell measuring,
// expanded sheet geometry and the surface close request. Each takes only the values it reads.
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
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
 * A cold dock commits the correctly sized shell first, then attaches the
 * heavy body on the next frame; warmed and previously visited docks keep
 * their live body and reopen without this hand-off.
 */
export function useDockMounting(openNow: boolean, prewarm: boolean) {
  const everOpened = useRef(openNow);
  if (openNow) everOpened.current = true;
  const panelMounted = openNow || everOpened.current || prewarm;
  const [dockBodyMounted, setDockBodyMounted] = useState(openNow);
  useEffect(() => {
    if (dockBodyMounted || (!openNow && !prewarm)) return undefined;
    const frame = window.requestAnimationFrame(() => setDockBodyMounted(true));
    return () => window.cancelAnimationFrame(frame);
  }, [dockBodyMounted, openNow, prewarm]);
  return { panelMounted, dockBodyMounted };
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
 * Drag-resize of the panel column: the showing surface picks which width
 * preference (terminal, browser — file/Files included — or panel) a gesture
 * previews and commits. A cancel restores the stored preference as it stood
 * when the gesture began, not the constrained rendered width it reports.
 */
export function usePanelWidthDrag({
  terminalShowing,
  sessionSurfaceShowing,
  terminalPref,
  setTerminalPref,
  browserPref,
  setBrowserPref,
  panelPref,
  setPanelPref,
  storageKeys,
}: {
  terminalShowing: boolean;
  sessionSurfaceShowing: boolean;
  terminalPref: number;
  setTerminalPref: (width: number) => void;
  browserPref: number;
  setBrowserPref: (width: number) => void;
  panelPref: number;
  setPanelPref: (width: number) => void;
  storageKeys: { terminal: string; browser: string; panel: string };
}) {
  // The stored preference as it stood when a panel resize gesture began: a
  // cancel restores it rather than the constrained rendered width.
  const panelWidthSnapshot = useRef<{ kind: 'terminal' | 'browser' | 'panel'; pref: number } | null>(null);
  return (next: number, phase: 'preview' | 'commit' | 'cancel') => {
    const kind = terminalShowing ? 'terminal' : sessionSurfaceShowing ? 'browser' : 'panel';
    if (phase === 'preview' && !panelWidthSnapshot.current) {
      const pref = kind === 'terminal' ? terminalPref : kind === 'browser' ? browserPref : panelPref;
      panelWidthSnapshot.current = { kind, pref };
    }
    if (phase === 'cancel') {
      const snapshot = panelWidthSnapshot.current;
      panelWidthSnapshot.current = null;
      if (!snapshot) return;
      if (snapshot.kind === 'terminal') setTerminalPref(snapshot.pref);
      else if (snapshot.kind === 'browser') setBrowserPref(snapshot.pref);
      else setPanelPref(snapshot.pref);
      return;
    }
    if (phase === 'commit') panelWidthSnapshot.current = null;
    if (kind === 'terminal') {
      setTerminalPref(next);
      if (phase === 'commit') commitWidthPref(storageKeys.terminal, next);
    } else if (kind === 'browser') {
      setBrowserPref(next);
      if (phase === 'commit') commitWidthPref(storageKeys.browser, next);
    } else {
      setPanelPref(next);
      if (phase === 'commit') commitWidthPref(storageKeys.panel, next);
    }
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
  window.addEventListener('resize', listener);
  return () => {
    unsubscribe();
    window.removeEventListener('resize', listener);
  };
}

function sidePanelPlacementSnapshot(): SidePanelPlacement {
  return resolveSidePanelPlacement(getSidePanelPosition(), window.innerWidth, window.innerHeight);
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
