// Input and chrome behavior of ZoomFrame, one hook per concern: when the pill
// shows, how the scroller's viewport is tracked, wheel/key zoom, and mouse
// drag-pan / click-toggle. ZoomFrame owns the zoom state they act on.
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { clickZoomTarget, stepSnapped, wheelZoomScale, type ZoomMode, type ZoomRange } from './zoom-range';

const REVEAL_ZONE_PX = 72;
const HIDE_DELAY_MS = 400;
const DRAG_SLOP_PX = 4;
export const SAME_SCALE = 0.005;
const INTERACTIVE = 'button, a, input, [role="button"]';

/** The zoom values the event handlers read without re-subscribing. */
export interface ZoomLive {
  scale: number;
  fit: number;
  mode: ZoomMode;
  ready: boolean;
}

/** Where the content starts inside the scroller's scrollable extent. */
export function contentOrigin(node: HTMLElement) {
  const child = node.firstElementChild as HTMLElement | null;
  if (!child) return { x: 0, y: 0 };
  const box = node.getBoundingClientRect();
  const rect = child.getBoundingClientRect();
  return {
    x: rect.left - box.left - node.clientLeft + node.scrollLeft,
    y: rect.top - box.top - node.clientTop + node.scrollTop,
  };
}

/** The pill is hidden until the pointer nears the bottom edge, a zoom gesture
 *  runs, or the pill is hovered / focused / open. `hover` is the pointer being
 *  over the frame, which also scopes the zoom keys. */
export function useZoomPillVisibility() {
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inZone = useRef(false);
  const pillActive = useRef(false);
  const show = useCallback(() => {
    clearTimeout(hideTimer.current);
    setVisible(true);
  }, []);
  const scheduleHide = useCallback(() => {
    clearTimeout(hideTimer.current);
    if (inZone.current || pillActive.current) return;
    hideTimer.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
  }, []);
  const flash = useCallback(() => {
    show();
    scheduleHide();
  }, [scheduleHide, show]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);
  const onPillActive = useCallback(
    (active: boolean) => {
      pillActive.current = active;
      if (active) show();
      else scheduleHide();
    },
    [scheduleHide, show]
  );
  const hover = useRef(false);
  const frameHandlers = {
    onPointerEnter() {
      hover.current = true;
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (event.pointerType !== 'mouse') return;
      const box = event.currentTarget.getBoundingClientRect();
      inZone.current = event.clientY >= box.bottom - REVEAL_ZONE_PX;
      if (inZone.current) show();
      else scheduleHide();
    },
    onPointerLeave() {
      hover.current = false;
      inZone.current = false;
      scheduleHide();
    },
  };
  return { visible, hover, frameHandlers, flash, onPillActive };
}

/** Tracks the scroller's size and the content point at its centre. Fixed mode
 *  keeps that point across a resize; fit refits through the new viewport. */
export function useZoomViewport({
  scroller,
  live,
  centre,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  live: RefObject<ZoomLive>;
  centre: RefObject<{ cx: number; cy: number } | null>;
}) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const node = scroller.current;
    if (!node) return undefined;
    const trackCentre = () => {
      const origin = contentOrigin(node);
      centre.current = {
        cx: node.scrollLeft + node.clientWidth / 2 - origin.x,
        cy: node.scrollTop + node.clientHeight / 2 - origin.y,
      };
    };
    const onResize = () => {
      const width = node.clientWidth;
      const height = node.clientHeight;
      setViewport((current) => (current.width === width && current.height === height ? current : { width, height }));
      const kept = centre.current;
      if (live.current.mode === 'fixed' && kept) {
        const origin = contentOrigin(node);
        node.scrollLeft = kept.cx + origin.x - width / 2;
        node.scrollTop = kept.cy + origin.y - height / 2;
      }
    };
    onResize();
    trackCentre();
    node.addEventListener('scroll', trackCentre, { passive: true });
    if (typeof ResizeObserver !== 'function') return () => node.removeEventListener('scroll', trackCentre);
    const observer = new ResizeObserver(onResize);
    observer.observe(node);
    return () => {
      node.removeEventListener('scroll', trackCentre);
      observer.disconnect();
    };
  }, [scroller, live, centre]);
  return viewport;
}

/** Ctrl+wheel zooms at the cursor; Ctrl/Cmd +, -, 0 zoom at the centre while
 *  the pointer is over the frame or focus is inside it. */
export function useZoomWheelAndKeys({
  scroller,
  frameRef,
  live,
  hover,
  range,
  setFixed,
  setFit,
  flash,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  frameRef: RefObject<HTMLDivElement | null>;
  live: RefObject<ZoomLive>;
  hover: RefObject<boolean>;
  range: ZoomRange;
  setFixed(value: number, px?: number, py?: number): void;
  setFit(px?: number, py?: number): void;
  flash(): void;
}) {
  useEffect(() => {
    const node = scroller.current;
    if (!node) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (!live.current.ready) return;
      const box = node.getBoundingClientRect();
      setFixed(
        wheelZoomScale(live.current.scale, event.deltaY, event.deltaMode, node.clientHeight),
        event.clientX - box.left - node.clientLeft,
        event.clientY - box.top - node.clientTop
      );
      flash();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!live.current.ready) return;
      if (!hover.current && !frameRef.current?.contains(document.activeElement)) return;
      if (event.key === '=' || event.key === '+') setFixed(stepSnapped(live.current.scale, 1, range));
      else if (event.key === '-' || event.key === '_') setFixed(stepSnapped(live.current.scale, -1, range));
      else if (event.key === '0') setFit();
      else return;
      event.preventDefault();
      flash();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('wheel', onWheel);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [flash, frameRef, hover, live, range, scroller, setFit, setFixed]);
}

/** A mouse can drag-pan overflow, and (clickToggle) a click on an image toggles
 *  fit ↔ 100%. Returns the scroller's pointer handlers. */
export function useZoomPointerGesture({
  clickToggle,
  live,
  setFixed,
  setFit,
}: {
  clickToggle: boolean;
  live: RefObject<ZoomLive>;
  setFixed(value: number, px?: number, py?: number): void;
  setFit(px?: number, py?: number): void;
}) {
  const gesture = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
    pan: boolean;
    onImage: boolean;
  } | null>(null);
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      const node = event.currentTarget;
      if (event.button !== 0 || event.pointerType !== 'mouse') return;
      // Capture would retarget the click away from buttons and links.
      if ((event.target as HTMLElement).closest?.(INTERACTIVE)) return;
      const pan = node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight;
      gesture.current = {
        x: event.clientX,
        y: event.clientY,
        left: node.scrollLeft,
        top: node.scrollTop,
        moved: false,
        pan,
        onImage: (event.target as HTMLElement).tagName === 'IMG',
      };
      if (pan) node.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const drag = gesture.current;
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > DRAG_SLOP_PX) drag.moved = true;
      if (drag.moved && drag.pan) {
        event.currentTarget.scrollLeft = drag.left - dx;
        event.currentTarget.scrollTop = drag.top - dy;
      }
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      const drag = gesture.current;
      gesture.current = null;
      if (!drag || drag.moved || !drag.onImage || !clickToggle || !live.current.ready) return;
      const box = event.currentTarget.getBoundingClientRect();
      const target = clickZoomTarget(
        live.current.mode === 'fit' || Math.abs(live.current.scale - live.current.fit) < SAME_SCALE,
        live.current.fit
      );
      const px = event.clientX - box.left - event.currentTarget.clientLeft;
      const py = event.clientY - box.top - event.currentTarget.clientTop;
      if (target.mode === 'fit') setFit(px, py);
      else setFixed(target.scale, px, py);
    },
    onPointerCancel() {
      gesture.current = null;
    },
  };
}
