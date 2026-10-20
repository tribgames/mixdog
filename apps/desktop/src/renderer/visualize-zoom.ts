// Content scale of the Visualize panel's active tab, driven by the ZoomPill,
// Ctrl+wheel and Ctrl/Cmd + = / − / 0 while the pointer or focus is over the
// panel. 1 is the pane-fit size; the scale resets when another tab (or
// session) is shown, but survives a reload of the same tab's files.
//
// A page, PDF or Markdown pane is an iframe, which takes the wheel and the
// keyboard for itself: those gestures reach the panel from the main process
// instead (main/visualize/host-zoom-input.ts, as a `zoom` visualize event) or,
// in a remote client, from the page itself (visualize-frame-zoom.ts).
//
// Parity with the editor previews (ZoomFrame): Ctrl+wheel scales
// exponentially by the wheel delta and keeps the content point under the
// pointer fixed; keys step on the 25% grid around the centre. The one
// difference is a wheel main forwarded out of a frame: Chromium reports only
// its direction (`zoom-changed`), so that one steps like a key, anchored at
// the pointer. Which panel a key belongs to is decided centrally (zoom-target.ts).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';

import type { VisualizeZoomInput } from '../shared/visualize';
import { PREVIEW_ZOOM_RANGE, anchoredScroll, clampZoom, stepSnapped, wheelZoomScale } from './zoom-range';
import { dispatchZoomAt, dispatchZoomKey, registerZoomTarget, type ZoomPoint } from './zoom-target';

export const VISUALIZE_ZOOM_RANGE = PREVIEW_ZOOM_RANGE;

const modifierListeners = new Set<(held: boolean) => void>();

/** A zoom gesture seen inside a pane frame (see `VisualizeZoomInput`): the
 *  wheel comes with its `point` in the window, a key without one. */
export function emitVisualizeZoomInput(input: VisualizeZoomInput, point?: ZoomPoint): void {
  if (point) dispatchZoomAt(input, point);
  else dispatchZoomKey(input);
}

/** Main saw Ctrl/Cmd go down or up while a pane frame held focus (the panel's
 *  document gets no key event then). */
export function emitVisualizeZoomModifier(held: boolean): void {
  for (const listener of [...modifierListeners]) listener(held);
}

type TouchPoint = { clientX: number; clientY: number };
type TouchList = { length: number; [index: number]: TouchPoint };

/** Two fingers' spread and midpoint, both in window CSS px. */
export function pinchGeometry(
  toWindow: (point: ZoomPoint) => ZoomPoint,
  first: TouchPoint,
  second: TouchPoint
): { spread: number; at: ZoomPoint } {
  const a = toWindow({ x: first.clientX, y: first.clientY });
  const b = toWindow({ x: second.clientX, y: second.clientY });
  return { spread: Math.hypot(a.x - b.x, a.y - b.y), at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

/** Two-finger pinches on `target` (a panel, or a pane frame's document): each
 *  move reports how much the spread grew since the last one (`ratio`) and its
 *  midpoint (mapped to window CSS px by `toWindow`). One finger is left alone,
 *  so it keeps scrolling at any scale; a pinch move is taken (preventDefault),
 *  so the second finger does not also pan. Returns the cleanup. */
export function watchPinch(
  target: EventTarget,
  toWindow: (point: ZoomPoint) => ZoomPoint,
  onPinch: (ratio: number, at: ZoomPoint) => void
): () => void {
  let spread = 0;
  // Measured in window px: a frame drawn scaled by the zoom itself would
  // otherwise shrink the spread as the zoom grows, cancelling the pinch.
  const measure = (touches: TouchList) => pinchGeometry(toWindow, touches[0], touches[1]);
  const onStart = (event: Event) => {
    const touches = (event as TouchEvent).touches as unknown as TouchList;
    spread = touches.length === 2 ? measure(touches).spread : 0;
  };
  const onMove = (event: Event) => {
    const touches = (event as TouchEvent).touches as unknown as TouchList;
    if (touches.length !== 2 || spread <= 0) return;
    event.preventDefault();
    const next = measure(touches);
    if (next.spread <= 0) return;
    const ratio = next.spread / spread;
    spread = next.spread;
    if (Math.abs(ratio - 1) > 0.002) onPinch(ratio, next.at);
  };
  const onEnd = (event: Event) => {
    const touches = (event as TouchEvent).touches as unknown as TouchList;
    spread = touches.length === 2 ? measure(touches).spread : 0;
  };
  target.addEventListener('touchstart', onStart, { passive: true });
  target.addEventListener('touchmove', onMove, { passive: false });
  target.addEventListener('touchend', onEnd, { passive: true });
  target.addEventListener('touchcancel', onEnd, { passive: true });
  return () => {
    target.removeEventListener('touchstart', onStart);
    target.removeEventListener('touchmove', onMove);
    target.removeEventListener('touchend', onEnd);
    target.removeEventListener('touchcancel', onEnd);
  };
}

/** Where a point in `frame`'s own document lands in this window (the panel
 *  may draw the frame scaled, by its zoom). */
export function framePointInWindow(frame: HTMLIFrameElement, point: ZoomPoint): ZoomPoint {
  const box = frame.getBoundingClientRect();
  const scaleX = frame.clientWidth > 0 ? box.width / frame.clientWidth : 1;
  const scaleY = frame.clientHeight > 0 ? box.height / frame.clientHeight : 1;
  return { x: box.left + point.x * scaleX, y: box.top + point.y * scaleY };
}

/** Style of the layer that holds a pane's content at `scale`. An image is
 *  fitted to its layer, so the layer itself grows (the pane scrolls when it
 *  overflows) and the image is drawn at `scale` times its fitted size
 *  (`--visualize-zoom`, see visualize.css: an image smaller than the pane
 *  would otherwise not change). Pages and documents lay out at 1/scale of the
 *  pane and are scaled back up, like browser zoom, so they always fill the pane. */
export function visualizeZoomStyle(scale: number, kind: string): CSSProperties | undefined {
  if (scale === 1) return undefined;
  if (kind === 'image') {
    return {
      width: `${scale * 100}%`,
      height: `${scale * 100}%`,
      margin: 'auto',
      '--visualize-zoom': scale,
    } as CSSProperties;
  }
  return { width: `${100 / scale}%`, height: `${100 / scale}%`, transform: `scale(${scale})` };
}

interface ScrollAnchor {
  content: HTMLElement;
  px: number;
  py: number;
  left: number;
  top: number;
  ratio: number;
}

export function useVisualizeZoom({
  panel,
  scopeKey,
  enabled,
}: {
  panel: HTMLElement | null;
  /** Another key (session, tab) starts again at 1. */
  scopeKey: string;
  enabled: boolean;
}) {
  const [choice, setChoice] = useState({ key: scopeKey, scale: 1 });
  const scale = choice.key === scopeKey ? choice.scale : 1;
  const live = useRef({ scale, scopeKey });
  live.current = { scale, scopeKey };
  const anchors = useRef<ScrollAnchor[]>([]);

  /** Sets the scale keeping the content point under `at` (window CSS px; the
   *  centre of each pane when omitted) fixed. Synchronous, so a burst of wheel
   *  events chains from the scale the previous one produced. */
  const setScale = useCallback(
    (value: number, at?: ZoomPoint) => {
      const next = clampZoom(value, VISUALIZE_ZOOM_RANGE);
      const ratio = next / live.current.scale;
      anchors.current =
        panel && Math.abs(ratio - 1) > 1e-9
          ? [...panel.querySelectorAll<HTMLElement>('.visualize-pane-content')].map((content) => {
              const box = content.getBoundingClientRect();
              const within = (offset: number, size: number) => Math.min(size, Math.max(0, offset));
              return {
                content,
                px: within(at ? at.x - box.left - content.clientLeft : content.clientWidth / 2, content.clientWidth),
                py: within(at ? at.y - box.top - content.clientTop : content.clientHeight / 2, content.clientHeight),
                left: content.scrollLeft,
                top: content.scrollTop,
                ratio,
              };
            })
          : [];
      live.current = { ...live.current, scale: next };
      flushSync(() => setChoice({ key: live.current.scopeKey, scale: next }));
    },
    [panel]
  );

  // Once the new scale has laid out, put the anchored point back under the pointer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scale is the trigger; the anchors ride in a ref
  useLayoutEffect(() => {
    for (const { content, px, py, left, top, ratio } of anchors.current) {
      content.scrollLeft = anchoredScroll(left, px, ratio);
      content.scrollTop = anchoredScroll(top, py, ratio);
    }
    anchors.current = [];
  }, [scale]);

  useEffect(() => {
    if (!panel || !enabled) return undefined;
    let over = false;
    const unregister = registerZoomTarget({
      element: panel,
      enabled: () => true,
      hovered: () => over || panel.matches(':hover'),
      command(input, point, wheel, pinch) {
        if (input === 'reset') setScale(1, point);
        else if (pinch) setScale(live.current.scale * pinch, point);
        else if (wheel)
          setScale(wheelZoomScale(live.current.scale, wheel.deltaY, wheel.deltaMode, panel.clientHeight), point);
        else setScale(stepSnapped(live.current.scale, input === 'in' ? 1 : -1, VISUALIZE_ZOOM_RANGE), point);
      },
    });
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setScale(wheelZoomScale(live.current.scale, event.deltaY, event.deltaMode, panel.clientHeight), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    // A non-passive wheel listener makes Chromium hold every wheel over its
    // element, pane frames included, until this document's main thread
    // answered: a page then scrolled only once the busy shell was free. A
    // wheel over a frame belongs to the frame's document (its Ctrl+wheel comes
    // through main), so the listener is held only while the pointer is over
    // the panel's own content, or while Ctrl/Cmd lets a document frame's
    // wheel through to the panel.
    let overFrame = false;
    let modifier = false;
    let listening = false;
    const listen = () => {
      const wanted = !overFrame || modifier;
      if (wanted === listening) return;
      listening = wanted;
      if (wanted) panel.addEventListener('wheel', onWheel, { passive: false });
      else panel.removeEventListener('wheel', onWheel);
    };
    const onOver = (event: Event) => {
      overFrame = (event.target as Node | null)?.nodeName === 'IFRAME';
      listen();
    };
    // While Ctrl/Cmd is held a document frame (Chromium's PDF viewer, which
    // zooms by itself on Ctrl+wheel and cannot be told not to) lets the wheel
    // through to the panel (visualize.css), which zooms for it. Keys the
    // panel's document sees update this; with focus in a frame main reports it.
    const hold = (held: boolean) => {
      if (held) panel.setAttribute('data-zoom-modifier', '');
      else panel.removeAttribute('data-zoom-modifier');
      modifier = held;
      listen();
    };
    const onKey = (event: KeyboardEvent) => hold(event.ctrlKey || event.metaKey);
    const onBlur = () => hold(false);
    const enter = () => {
      over = true;
    };
    const leave = () => {
      over = false;
    };
    modifierListeners.add(hold);
    // A pinch over the panel itself (an image, a remote document's pages);
    // one inside a pane frame arrives through dispatchZoomAt instead.
    const unpinch = watchPinch(
      panel,
      (point) => point,
      (ratio, at) => setScale(live.current.scale * ratio, at)
    );
    listen();
    panel.addEventListener('pointerover', onOver);
    panel.addEventListener('pointerenter', enter);
    panel.addEventListener('pointerleave', leave);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      unregister();
      unpinch();
      hold(false);
      modifierListeners.delete(hold);
      panel.removeEventListener('wheel', onWheel);
      panel.removeEventListener('pointerover', onOver);
      panel.removeEventListener('pointerenter', enter);
      panel.removeEventListener('pointerleave', leave);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [panel, enabled, setScale]);

  return { scale, setScale };
}
