// The PC picture's view on the pane's stage, kept outside React state: the
// transform is written straight to the picture element so a finger drag or a
// fling never re-renders the pane. Measures the stage and the soft keyboard
// (visual viewport) and gives the touch layer its `ViewportStore`.
import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';

import { nextScreenViewport, screenViewportLayout, type ScreenViewportState } from './remote-screen-viewport';
import {
  clampView,
  keyboardClosing,
  keyboardEvidence,
  relaxView,
  viewReady,
  type KeyboardClosing,
  type RemoteView,
  type ViewSize,
} from './remote-viewport';
import type { ViewportStore } from './remote-touch-gestures';

export function useScreenViewport({
  stageRef,
  pictureRef,
  picture,
  mounted,
}: {
  stageRef: RefObject<HTMLElement | null>;
  pictureRef: RefObject<HTMLElement | null>;
  picture: ViewSize;
  /** False while the pane shows no stage (a stopped card); true again re-measures. */
  mounted: boolean;
}): ViewportStore {
  const stateRef = useRef<ScreenViewportState | null>(null);
  const baselineRef = useRef<ViewSize | null>(null);
  const openRef = useRef(false);
  /** The keyboard sliding away after a blur, followed resize by resize. */
  const closingRef = useRef<KeyboardClosing | null>(null);
  const pictureSizeRef = useRef(picture);
  pictureSizeRef.current = picture;
  const relaxRef = useRef<number | null>(null);

  const paint = useCallback(
    (view: RemoteView | null) => {
      const element = pictureRef.current;
      if (!element) return;
      if (!view) {
        delete element.dataset.ready;
        return;
      }
      element.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
      element.dataset.ready = 'true';
    },
    [pictureRef]
  );
  const stopRelax = useCallback(() => {
    if (relaxRef.current !== null) cancelAnimationFrame(relaxRef.current);
    relaxRef.current = null;
  }, []);
  const apply = useCallback(
    (next: ScreenViewportState) => {
      stateRef.current = next;
      paint(next.view);
    },
    [paint]
  );
  /** Measured again: the stage, the keyboard or the picture changed. */
  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measured = { width: stage.clientWidth, height: stage.clientHeight };
    const visual = window.visualViewport;
    // Where the VirtualKeyboard API exists (Chromium), the keyboard's own
    // rectangle over the stage; empty while the page is resized for it.
    const rect = (navigator as Navigator & { virtualKeyboard?: { boundingRect: DOMRectReadOnly } }).virtualKeyboard
      ?.boundingRect;
    let overlay = 0;
    if (rect && rect.height > 0) {
      const box = stage.getBoundingClientRect();
      overlay = Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
    }
    let keyboardOpen = overlay > 0;
    if (visual) {
      const active = document.activeElement;
      const seen = keyboardEvidence(baselineRef.current, {
        visual: { width: visual.width, height: visual.height },
        focused: active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement,
        closing: closingRef.current !== null,
        overlay,
      });
      baselineRef.current = seen.baseline;
      keyboardOpen = seen.open;
      openRef.current = seen.open;
    }
    const prev = stateRef.current;
    const next = nextScreenViewport(prev, measured, keyboardOpen, pictureSizeRef.current, overlay);
    apply(next);
    // The keyboard went away: ease the overpanned view back inside the stage.
    if (prev && prev.track.bottom > 0 && next.track.bottom === 0 && next.view) {
      stopRelax();
      const layout = screenViewportLayout(next);
      const from = next.view;
      const startedAt = performance.now();
      const frame = (now: number) => {
        const state = stateRef.current;
        if (!state?.view) return;
        const eased = relaxView({ from, elapsedMs: now - startedAt }, layout);
        apply({ ...state, view: eased.view });
        relaxRef.current = eased.settled ? null : requestAnimationFrame(frame);
      };
      relaxRef.current = requestAnimationFrame(frame);
    }
  }, [apply, stageRef, stopRelax]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the picture's size is read through a ref; a new size (or a stage mounted again) re-measures.
  useEffect(() => {
    measure();
  }, [measure, picture.width, picture.height, mounted]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `mounted` is the stage element coming back.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(stage);
    // Focus moving is what tells a keyboard from a resize.
    const focusIn = () => {
      closingRef.current = null;
      measure();
    };
    // The field let go: a keyboard that was up slides away, and the visual
    // viewport's resizes say when it is gone (keyboardClosing).
    const focusOut = () => {
      const visual = window.visualViewport;
      closingRef.current = openRef.current && visual ? { height: visual.height } : null;
      measure();
    };
    const visualResize = () => {
      const visual = window.visualViewport;
      if (closingRef.current && visual) {
        closingRef.current = keyboardClosing(
          closingRef.current,
          { width: visual.width, height: visual.height },
          baselineRef.current
        );
      }
      measure();
    };
    window.visualViewport?.addEventListener('resize', visualResize);
    const virtualKeyboard = (navigator as Navigator & { virtualKeyboard?: EventTarget }).virtualKeyboard;
    virtualKeyboard?.addEventListener('geometrychange', measure);
    document.addEventListener('focusin', focusIn);
    document.addEventListener('focusout', focusOut);
    return () => {
      observer?.disconnect();
      window.visualViewport?.removeEventListener('resize', visualResize);
      virtualKeyboard?.removeEventListener('geometrychange', measure);
      document.removeEventListener('focusin', focusIn);
      document.removeEventListener('focusout', focusOut);
      stopRelax();
    };
  }, [measure, stageRef, stopRelax, mounted]);

  return useMemo<ViewportStore>(
    () => ({
      layout: () => {
        const state = stateRef.current;
        return state ? screenViewportLayout(state) : null;
      },
      view: () => stateRef.current?.view ?? null,
      setView(view) {
        const state = stateRef.current;
        if (!state) return;
        const layout = screenViewportLayout(state);
        if (!viewReady(layout)) return;
        stopRelax();
        apply({ ...state, view: clampView(view, layout) });
      },
      origin: () => {
        const box = stageRef.current?.getBoundingClientRect();
        return { x: box?.left ?? 0, y: box?.top ?? 0 };
      },
    }),
    [apply, stageRef, stopRelax]
  );
}
