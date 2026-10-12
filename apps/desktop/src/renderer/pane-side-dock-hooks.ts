// Effect hooks of the per-pane right dock (PaneSideDock): cell measuring,
// expanded sheet geometry, phone outside-press fold and the surface close
// request. Each takes only the values it reads.
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { PANE_DOCK_CLOSE_EVENT } from './pane-dock-chrome';
import { expandedDockRect } from './surface-slots';
import { useMobileRemoteSurface } from './mobile-surface';
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

/** The dock measures its own pane cell while open. */
export function useDockCellWidth(hostRef: RefObject<HTMLDivElement | null>, openNow: boolean): number {
  const [cellWidth, setCellWidth] = useState(0);
  useEffect(() => {
    if (!openNow) return undefined;
    const cell = hostRef.current?.parentElement;
    if (!cell) return undefined;
    const measure = () => setCellWidth((current) => (current === cell.clientWidth ? current : cell.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [hostRef, openNow]);
  return cellWidth;
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
  const toggleExpanded = useCallback(
    () =>
      setExpanded((value) => {
        if (!value) restWidth.current = Math.round(hostRef.current?.getBoundingClientRect().width ?? 0);
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
  return { expanded, expandedRect, restWidth, toggleExpanded };
}

/**
 * Phone sheet: a press OUTSIDE the unit folds it (user: 모바일 프레임 외
 * 영역 터치 시 접힘). This is a document-level hit test, not a backdrop
 * element: a fixed backdrop inside the sliding (transformed) root covered
 * only the sheet's own box, and one portaled to body stacked OVER the
 * sheet and ate its taps (user: 소스컨트롤창 클릭과 드래그가 안 됨). The
 * session surfaces and the strip's own toggles count as inside — the
 * toggle decides the fold itself. The Browser Use and Terminal surfaces are
 * FIXED containers positioned over their slot, not children of the unit,
 * so they are named explicitly (user: 브라우저창 누르면 나가짐).
 */
export function useMobileOutsideFold(hostRef: RefObject<HTMLDivElement | null>, openNow: boolean, onClose: () => void) {
  const mobile = useMobileRemoteSurface();
  useEffect(() => {
    if (!openNow || !mobile) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (hostRef.current?.contains(target)) return;
      // The ⋯ menu is portalled to body; it still belongs to its dock.
      if (
        target instanceof Element &&
        target.closest(
          '.pane-dock-toggles, .session-terminal-surface-container, .session-browser-surface-container, [data-dock-menu-owner]'
        )
      )
        return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [hostRef, openNow, mobile, onClose]);
}

/**
 * Surfaces live in their own React roots; their header X asks the focused
 * dock showing that surface to fold.
 */
export function useDockCloseRequest(active: boolean, surface: string, focused: boolean, onClose: () => void) {
  useEffect(() => {
    if (!active) return undefined;
    const onCloseRequest = (event: Event) => {
      const requested = (event as CustomEvent<{ surface?: string }>).detail?.surface;
      if (focused && requested === surface) onClose();
    };
    window.addEventListener(PANE_DOCK_CLOSE_EVENT, onCloseRequest);
    return () => window.removeEventListener(PANE_DOCK_CLOSE_EVENT, onCloseRequest);
  }, [active, surface, focused, onClose]);
}
