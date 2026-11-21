import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';

import { BROWSER_ZOOM_STEP, readBrowserZoom, writeBrowserZoom } from './browser-zoom-level';
import { clampPan, zoomRemoteView } from './remote-view-zoom';
import {
  clampView,
  clampViewScale,
  containScale,
  initialView,
  type KeyboardClosing,
  keyboardClosing,
  keyboardEvidence,
  maxViewScale,
  panView,
  relaxView,
  type RemoteView,
  type RemoteViewLayout,
  rescaleView,
  sameAspect,
  sameView,
  type StageTrack,
  trackStage,
  type ViewSize,
  viewReady,
  visibleCenter,
  zoomView,
} from './remote-viewport';
import { BROWSER_ZOOM_RANGE, type ZoomRange } from './zoom-range';
/** Narrow (non-phone) toolbar: the less-used "Open in system browser" moves into the
 *  More menu so the address field keeps the room (same split as the PC pane's
 *  browserNavLayout). */
export function useNarrowToolbar(): boolean {
  const query = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => Boolean(window.matchMedia?.(query).matches));
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return undefined;
    const update = () => setNarrow(list.matches);
    update();
    list.addEventListener?.('change', update);
    return () => list.removeEventListener?.('change', update);
  }, []);
  return narrow;
}

/** The VirtualKeyboard API's part this pane reads (not in every DOM lib). */
type VirtualKeyboardLike = EventTarget & { readonly boundingRect: DOMRectReadOnly };

/** A field that raises the soft keyboard has focus (the typing bar, the
 *  address field, any text input or editable). */
function editableFocused(): boolean {
  const element = document.activeElement as HTMLElement | null;
  if (!element) return false;
  if (element.isContentEditable || element.tagName === 'TEXTAREA') return true;
  if (element.tagName !== 'INPUT') return false;
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(
    (element as HTMLInputElement).type
  );
}

/** The desktop pane's client-side zoom and pan of the picture (frame image or video), about the fitted picture's centre. */
export function useRemoteFrameZoom(sessionId: string, ownerSessionId: string, imageRef: RefObject<HTMLElement | null>) {
  const [zoomLevel, setZoomLevel] = useState(() => readBrowserZoom(window.localStorage, sessionId));
  const zoomRef = useRef(zoomLevel);
  zoomRef.current = zoomLevel;
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panRef = useRef(pan);
  panRef.current = pan;
  const changeZoomLevel = useCallback(
    (level: number) => {
      const next = writeBrowserZoom(window.localStorage, ownerSessionId, level);
      zoomRef.current = next;
      setZoomLevel(next);
      const image = imageRef.current;
      setPan((current) =>
        next <= 1 || !image
          ? { x: 0, y: 0 }
          : {
              x: clampPan(current.x, image.clientWidth, next),
              y: clampPan(current.y, image.clientHeight, next),
            }
      );
    },
    [ownerSessionId, imageRef]
  );
  /** Pinch: zoom about the fingers, up to `max`; presentation only. The
   *  stored level is the menu's range; a deeper pinch lasts for the view. */
  const pinch = useCallback(
    (scale: number, x: number, y: number, dx: number, dy: number, max: number) => {
      const image = imageRef.current;
      if (!image) return;
      const box = image.getBoundingClientRect();
      const view = { zoom: zoomRef.current, pan: panRef.current };
      const next = zoomRemoteView(view, {
        scale,
        at: { x, y },
        shift: { x: dx, y: dy },
        center: { x: box.left + box.width / 2 - view.pan.x, y: box.top + box.height / 2 - view.pan.y },
        size: { width: image.clientWidth, height: image.clientHeight },
        max,
      });
      zoomRef.current = next.zoom;
      panRef.current = next.pan;
      writeBrowserZoom(window.localStorage, ownerSessionId, next.zoom);
      setZoomLevel(next.zoom);
      setPan(next.pan);
    },
    [ownerSessionId, imageRef]
  );
  /** One-finger pan of a zoomed picture, its edges kept inside the box. */
  const panBy = (dx: number, dy: number) => {
    const image = imageRef.current;
    if (!image) return;
    setPan((current) => ({
      x: clampPan(current.x + dx, image.clientWidth, zoomRef.current),
      y: clampPan(current.y + dy, image.clientHeight, zoomRef.current),
    }));
  };
  const zoom: RemoteZoom = {
    level: zoomLevel,
    range: BROWSER_ZOOM_RANGE,
    initial: zoomLevel === 1,
    set: changeZoomLevel,
    reset: () => changeZoomLevel(1),
  };
  const pictureStyle: CSSProperties | null =
    zoomLevel !== 1 || pan.x || pan.y ? { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoomLevel})` } : null;
  /** Another page: its own stored level, no pan. */
  const forget = (streamId: string) => {
    setPan({ x: 0, y: 0 });
    setZoomLevel(readBrowserZoom(window.localStorage, streamId));
  };
  return { zoom, zoomRef, pinch, panBy, forget, pictureStyle };
}

/** The zoom the pill, the ⋯ menu and the shortcuts work on. On the phone 1
 *  (100%) is the whole page in view, the minimum, and the first view may be
 *  deeper (it fills one axis); on the desktop it is the fitted picture. */
export type RemoteZoom = {
  level: number;
  range: ZoomRange;
  /** The view is the first one (reset has nothing to do). */
  initial: boolean;
  set(level: number): void;
  reset(): void;
};

/** The stage's layout size and the soft keyboard's bottom inset over it. */
function useStageTrack(contentRef: RefObject<HTMLDivElement | null>, enabled: boolean): StageTrack | null {
  const [stage, setStage] = useState<StageTrack | null>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!enabled || !content) return undefined;
    let baseline: ViewSize | null = null;
    let open = false;
    let closing: KeyboardClosing | null = null;
    // Where the VirtualKeyboard API exists (Chromium), the keyboard's own
    // rectangle over the page; empty while the page is resized for it.
    const keyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboardLike }).virtualKeyboard;
    const measure = () => {
      const visual = window.visualViewport;
      const rect = keyboard?.boundingRect;
      let overlay = 0;
      if (rect && rect.height > 0) {
        const box = content.getBoundingClientRect();
        overlay = Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
      }
      if (visual) {
        const seen = keyboardEvidence(baseline, {
          visual: { width: visual.width, height: visual.height },
          focused: editableFocused(),
          closing: closing !== null,
          overlay,
        });
        baseline = seen.baseline;
        open = seen.open;
      } else {
        open = overlay > 0;
      }
      const measured = { width: content.clientWidth, height: content.clientHeight };
      setStage((prev) => {
        const next = trackStage(prev, measured, open, overlay);
        return prev && next.width === prev.width && next.height === prev.height && next.bottom === prev.bottom
          ? prev
          : next;
      });
    };
    const focusIn = () => {
      closing = null;
      measure();
    };
    const focusOut = () => {
      const visual = window.visualViewport;
      closing = open && visual ? { height: visual.height } : null;
      measure();
    };
    const visualResize = () => {
      const visual = window.visualViewport;
      if (closing && visual)
        closing = keyboardClosing(closing, { width: visual.width, height: visual.height }, baseline);
      measure();
    };
    measure();
    const Observer = window.ResizeObserver;
    const observer = typeof Observer === 'function' ? new Observer(measure) : null;
    observer?.observe(content);
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', visualResize);
    keyboard?.addEventListener('geometrychange', measure);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', visualResize);
      keyboard?.removeEventListener('geometrychange', measure);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
    };
  }, [contentRef, enabled]);
  return stage;
}

/** This device's view of the picture (frame image or video) on the shared viewport (remote-viewport.ts): the first view fills one axis, pinch never goes below the whole page, and the soft keyboard is a bottom inset. */
export function useRemoteView(
  contentRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  pictureWidth: number,
  pictureHeight: number
) {
  const [view, setViewState] = useState<RemoteView | null>(null);
  const viewRef = useRef<RemoteView | null>(null);
  const stage = useStageTrack(contentRef, enabled);
  const layout = useMemo<RemoteViewLayout | null>(
    () =>
      enabled && stage && pictureWidth > 0 && pictureHeight > 0
        ? {
            picture: { width: pictureWidth, height: pictureHeight },
            stage: { width: stage.width, height: stage.height },
            insets: { bottom: stage.bottom },
          }
        : null,
    [enabled, stage, pictureWidth, pictureHeight]
  );
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const relaxFrame = useRef(0);
  const setView = useCallback((next: RemoteView | null) => {
    viewRef.current = next;
    setViewState(next);
  }, []);
  const stopRelax = useCallback(() => {
    if (relaxFrame.current) window.cancelAnimationFrame(relaxFrame.current);
    relaxFrame.current = 0;
  }, []);
  /** Ease an overpanned view back inside its bounds, one frame at a time. */
  const relax = useCallback(() => {
    stopRelax();
    const from = viewRef.current;
    const startedAt = Date.now();
    const step = () => {
      relaxFrame.current = 0;
      const shape = layoutRef.current;
      if (!from || !viewReady(shape)) return;
      const result = relaxView({ from, elapsedMs: Date.now() - startedAt }, shape);
      setView(result.view);
      if (!result.settled) relaxFrame.current = window.requestAnimationFrame(step);
    };
    relaxFrame.current = window.requestAnimationFrame(step);
  }, [setView, stopRelax]);
  useEffect(() => stopRelax, [stopRelax]);

  // A new stage size or picture shape fits again; the same picture at another
  // size keeps what is on screen; an inset that went eases the view back.
  // Before paint, so nothing is ever drawn at a stale view.
  const fitted = useRef<RemoteViewLayout | null>(null);
  useLayoutEffect(() => {
    if (!viewReady(layout)) return;
    const before = fitted.current;
    fitted.current = layout;
    const current = viewRef.current;
    if (
      !before ||
      !current ||
      before.stage.width !== layout.stage.width ||
      before.stage.height !== layout.stage.height ||
      !sameAspect(before.picture, layout.picture)
    ) {
      stopRelax();
      setView(initialView(layout));
      return;
    }
    const next =
      before.picture.width === layout.picture.width ? current : rescaleView(current, before.picture, layout.picture);
    if (next !== current) setView(next);
    if (!sameView(next, clampView(next, layout))) relax();
  }, [layout, relax, setView, stopRelax]);

  /** Another page: its first view starts afresh. */
  const forget = useCallback(() => {
    stopRelax();
    fitted.current = null;
    setView(null);
  }, [setView, stopRelax]);
  const ready = (): { view: RemoteView; layout: RemoteViewLayout } | null => {
    const current = viewRef.current;
    const shape = layoutRef.current;
    return current && viewReady(shape) ? { view: current, layout: shape } : null;
  };
  const origin = () => {
    const box = contentRef.current?.getBoundingClientRect();
    return { x: box?.left ?? 0, y: box?.top ?? 0 };
  };
  const pan = (dx: number, dy: number) => {
    const state = ready();
    if (!state) return;
    stopRelax();
    setView(panView(state.view, state.layout, dx, dy));
  };
  /** Pinch about client point (x, y), the fingers moved by (dx, dy). */
  const pinch = (factor: number, x: number, y: number, dx: number, dy: number) => {
    const state = ready();
    if (!state) return;
    stopRelax();
    const at = origin();
    setView(zoomView(state.view, state.layout, factor, { x: x - at.x, y: y - at.y }, { x: dx, y: dy }));
  };
  const contain = viewReady(layout) ? containScale(layout) : 0;
  const level = view && contain > 0 ? view.scale / contain : 1;
  const zoom: RemoteZoom = {
    level,
    range: {
      min: 1,
      max: viewReady(layout) ? Math.floor((maxViewScale(layout) / containScale(layout)) * 100) / 100 : 1,
      step: BROWSER_ZOOM_STEP,
    },
    initial: !view || !viewReady(layout) || sameView(view, initialView(layout)),
    set(next: number) {
      const state = ready();
      if (!state) return;
      stopRelax();
      const scale = clampViewScale(state.layout, next * containScale(state.layout));
      setView(zoomView(state.view, state.layout, scale / state.view.scale, visibleCenter(state.layout)));
    },
    reset() {
      const state = ready();
      if (!state) return;
      stopRelax();
      setView(initialView(state.layout));
    },
  };
  /** The picture element's box and transform; none until the view is known. */
  const pictureStyle: CSSProperties | null =
    view && layout
      ? {
          position: 'absolute',
          left: 0,
          top: 0,
          width: layout.picture.width,
          height: layout.picture.height,
          maxWidth: 'none',
          transformOrigin: '0 0',
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }
      : null;
  return { zoom, pan, pinch, forget, pictureStyle };
}
