import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { flushSync } from 'react-dom';

import type { VisualizeZoomInput } from '../shared/visualize';
import { watchTouchZoom } from './touch-zoom';
import {
  PREVIEW_ZOOM_RANGE,
  anchoredScroll,
  clampZoom,
  clickZoomTarget,
  stepSnapped,
  wheelZoomScale,
} from './zoom-range';
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

/** Where a point in `frame`'s own document lands in this window (the panel
 *  may draw the frame scaled, by its zoom). */
export function framePointInWindow(frame: HTMLIFrameElement, point: ZoomPoint): ZoomPoint {
  const box = frame.getBoundingClientRect();
  const scaleX = frame.clientWidth > 0 ? box.width / frame.clientWidth : 1;
  const scaleY = frame.clientHeight > 0 ? box.height / frame.clientHeight : 1;
  return { x: box.left + point.x * scaleX, y: box.top + point.y * scaleY };
}

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
  // Chromium counts a flex item's untransformed 1/scale box as scrollable overflow; out of flow, only the scaled box sets the scroll range.
  return {
    position: 'absolute',
    top: 0,
    left: 0,
    width: `${100 / scale}%`,
    height: `${100 / scale}%`,
    transform: `scale(${scale})`,
  };
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

  const exact = useRef(1);
  /** Multiplies the scale by a pinch step's `ratio` about `at`. */
  const pinchBy = useCallback(
    (ratio: number, at?: ZoomPoint) => {
      const from =
        clampZoom(exact.current, VISUALIZE_ZOOM_RANGE) === live.current.scale ? exact.current : live.current.scale;
      const next = Math.min(VISUALIZE_ZOOM_RANGE.max, Math.max(VISUALIZE_ZOOM_RANGE.min, from * ratio));
      setScale(next, at);
      exact.current = next;
    },
    [setScale]
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
    return watchPanelZoom(panel, { scale: () => live.current.scale, setScale, pinchBy });
  }, [panel, enabled, setScale, pinchBy]);

  return { scale, setScale, pinchBy };
}

/** Routes the panel's zoom input (commands, Ctrl+wheel, pinch, the Ctrl/Cmd
 *  modifier a document frame needs) to the zoom; returns the teardown. */
function watchPanelZoom(
  panel: HTMLElement,
  zoom: {
    scale(): number;
    setScale(value: number, at?: ZoomPoint): void;
    pinchBy(ratio: number, at?: ZoomPoint): void;
  }
): () => void {
  const { setScale, pinchBy } = zoom;
  let over = false;
  const unregister = registerZoomTarget({
    element: panel,
    enabled: () => true,
    hovered: () => over || panel.matches(':hover'),
    command(input, point, wheel, pinch) {
      if (input === 'reset') setScale(1, point);
      else if (pinch) pinchBy(pinch, point);
      else if (wheel) setScale(wheelZoomScale(zoom.scale(), wheel.deltaY, wheel.deltaMode, panel.clientHeight), point);
      else setScale(stepSnapped(zoom.scale(), input === 'in' ? 1 : -1, VISUALIZE_ZOOM_RANGE), point);
    },
  });
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setScale(wheelZoomScale(zoom.scale(), event.deltaY, event.deltaMode, panel.clientHeight), {
      x: event.clientX,
      y: event.clientY,
    });
  };
  // A non-passive wheel listener makes Chromium hold every wheel over the element, frames included, until this main thread answers; it is attached only over the panel's own content or while Ctrl/Cmd is held.
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
  // Chromium's PDF viewer zooms itself on Ctrl+wheel and cannot be told not to; while Ctrl/Cmd is held it lets the wheel through to the panel (visualize.css).
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
  // A pinch over the panel itself (a remote document's pages, an inline
  // render); an image pane takes its own touches (VisualizePane), and one
  // inside a pane frame arrives through dispatchZoomAt instead.
  const unpinch = watchTouchZoom(panel, { pinch: pinchBy });
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
}

export function useImagePaneTouch(
  content: HTMLElement | null,
  enabled: boolean,
  zoom: Pick<ReturnType<typeof useVisualizeZoom>, 'scale' | 'setScale' | 'pinchBy'>
): void {
  const latest = useRef(zoom);
  latest.current = zoom;
  useEffect(() => {
    if (!content || !enabled) return undefined;
    return watchTouchZoom(content, {
      pinch: (ratio, at) => latest.current.pinchBy(ratio, at),
      pan: (dx, dy) => {
        content.scrollLeft -= dx;
        content.scrollTop -= dy;
      },
      doubleTap: (at) => {
        const { scale, setScale } = latest.current;
        const image = content.querySelector('img');
        if (scale !== 1 || !image?.naturalWidth) {
          setScale(1, at);
          return;
        }
        // Drawn CSS px per natural image px, at fit.
        const fit = image.getBoundingClientRect().width / image.naturalWidth;
        const target = clickZoomTarget(true, fit);
        if (target.mode === 'fixed' && fit > 0) setScale(target.scale / fit, at);
      },
    });
  }, [content, enabled]);
}
