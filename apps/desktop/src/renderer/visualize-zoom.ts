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
      command(input, point, wheel) {
        if (input === 'reset') setScale(1, point);
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
    // While Ctrl/Cmd is held a document frame (Chromium's PDF viewer, which
    // zooms by itself on Ctrl+wheel and cannot be told not to) lets the wheel
    // through to the panel (visualize.css), which zooms for it. Keys the
    // panel's document sees update this; with focus in a frame main reports it.
    const hold = (held: boolean) => {
      if (held) panel.setAttribute('data-zoom-modifier', '');
      else panel.removeAttribute('data-zoom-modifier');
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
    panel.addEventListener('wheel', onWheel, { passive: false });
    panel.addEventListener('pointerenter', enter);
    panel.addEventListener('pointerleave', leave);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      unregister();
      hold(false);
      modifierListeners.delete(hold);
      panel.removeEventListener('wheel', onWheel);
      panel.removeEventListener('pointerenter', enter);
      panel.removeEventListener('pointerleave', leave);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [panel, enabled, setScale]);

  return { scale, setScale };
}
