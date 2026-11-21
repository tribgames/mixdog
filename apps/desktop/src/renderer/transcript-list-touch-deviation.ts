import { type MutableRefObject, type RefObject, useEffect, useMemo } from 'react';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

/** Measured-size corrections held while a wheel ramp or a touch scroll owns
 *  the viewport. A scrollTop write cancels Chromium's animated wheel scroll and
 *  iOS WebKit's touch fling, so a correction translates the spacer instead and
 *  lands as one scroll write once the scroll is over. The logical offset is the
 *  native one plus the held amount. A write landed under native 0 mid-fling is
 *  cancelled by WebKit, so a positive hold waits there for the scroll to settle;
 *  an iOS rubber-band overscroll puts native outside [0, max] and a landing
 *  waits for the bounce. */
export type TouchScrollDeviation = {
  /** Logical offset minus the native scrollTop. */
  amount(): number;
  /** Holds a logical target as a row offset; false when no held scroll owns
   *  the viewport (or the target is at the top edge) and the caller must
   *  write it natively. */
  hold(target: number): boolean;
  /** Lands the hold now if the logical offset reached the top (each scroll). */
  landAtEdge(): void;
  /** A finger lands while the native offset rests at 0 with history held
   *  above it: lands the hold, so the drag that follows can reach it. */
  landForTouch(): void;
  /** A native write that lands a logical target directly supersedes the hold. */
  drop(): void;
  cancel(): void;
};

/** The logical offset is at the real top: a hold must not stand. Native 0
 *  with history held above it is not: the momentum is still on it. */
function atTopEdge(logical: number): boolean {
  return logical <= 0;
}

const TOP_EDGE_PX = 1;

/** Overscrolled past either end (a rubber band still bouncing). */
function overscrolled(element: HTMLDivElement): boolean {
  const native = element.scrollTop;
  return native < 0 || native > element.scrollHeight - element.clientHeight + TOP_EDGE_PX;
}

export function createTouchScrollDeviation({
  getViewport,
  getSpacer,
  hasTouchScroll,
  clampAtEdge,
  markProgrammaticScroll,
}: {
  getViewport(): HTMLDivElement | null;
  getSpacer(): HTMLDivElement | null;
  hasTouchScroll(): boolean;
  /** The hold belongs to a touch scroll: it lands early at the top edge. */
  clampAtEdge(): boolean;
  markProgrammaticScroll(top: number, intended: number): void;
}): TouchScrollDeviation {
  let amount = 0;
  let frame = 0;
  const paint = () => {
    const space = getSpacer();
    if (!space) return;
    space.style.transform = amount ? `translateY(${-amount}px)` : '';
    // A transform leaves the in-flow extent unchanged; the negative margin
    // keeps the native end on the lifted rows' end.
    space.style.marginBottom = amount > 0 ? `${-amount}px` : '';
  };
  /** False (nothing written) while the viewport is overscrolled. */
  const land = (): boolean => {
    const element = getViewport();
    if (element && overscrolled(element)) return false;
    const held = amount;
    // The native offset is read while the row offset still stands: a held
    // negative amount extends the scrollable overflow, and dropping it first
    // could clamp the native offset before it is read.
    const before = element ? element.scrollTop : 0;
    amount = 0;
    paint();
    if (!element) return true;
    const target = Math.max(0, before + held);
    element.scrollTop = target;
    const landed = element.scrollTop;
    if (transcriptScrollDiagnosticsEnabled()) {
      logTranscriptScroll('touch-hold-settle', { from: before, to: landed, held });
    }
    markProgrammaticScroll(landed, target);
    return true;
  };
  const settle = () => {
    frame = 0;
    if (!amount) return;
    if (hasTouchScroll() || !land()) frame = window.requestAnimationFrame(settle);
  };
  return {
    amount: () => amount,
    hold(target) {
      const element = getViewport();
      if (!element || !hasTouchScroll()) return false;
      const native = element.scrollTop;
      if (clampAtEdge() && atTopEdge(target)) return false;
      const next = target - native;
      amount = Math.abs(next) < 0.5 ? 0 : next;
      paint();
      if (amount && !frame) frame = window.requestAnimationFrame(settle);
      return true;
    },
    landAtEdge() {
      if (!amount || !clampAtEdge()) return;
      const element = getViewport();
      if (!element) return;
      if (atTopEdge(element.scrollTop + amount)) land();
    },
    landForTouch() {
      if (amount <= 0) return;
      const element = getViewport();
      if (element && element.scrollTop <= TOP_EDGE_PX) land();
    },
    drop() {
      if (!amount) return;
      amount = 0;
      paint();
    },
    cancel() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

export function useTouchScrollDeviation({
  viewport,
  spacer,
  hasTouchScrollRef,
  touchHoldsRef,
  domTop,
  markProgrammaticScrollRef,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  spacer: RefObject<HTMLDivElement | null>;
  hasTouchScrollRef: MutableRefObject<() => boolean>;
  touchHoldsRef: MutableRefObject<() => boolean>;
  domTop: MutableRefObject<number | null>;
  markProgrammaticScrollRef: MutableRefObject<((top: number, intended?: number) => void) | undefined>;
}): TouchScrollDeviation {
  const deviation = useMemo(
    () =>
      createTouchScrollDeviation({
        getViewport: () => viewport.current,
        getSpacer: () => spacer.current,
        hasTouchScroll: () => hasTouchScrollRef.current(),
        clampAtEdge: () => touchHoldsRef.current(),
        markProgrammaticScroll: (top, intended) => {
          domTop.current = top;
          markProgrammaticScrollRef.current?.(top, intended);
        },
      }),
    [viewport, spacer, hasTouchScrollRef, touchHoldsRef, domTop, markProgrammaticScrollRef]
  );
  useEffect(() => () => deviation.cancel(), [deviation]);
  // On the viewport itself, so the landing precedes the follow hook's
  // touchstart (delegated from the root), which reads the offset it starts at.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const landForTouch = () => deviation.landForTouch();
    element.addEventListener('touchstart', landForTouch, { passive: true });
    return () => element.removeEventListener('touchstart', landForTouch);
  }, [viewport, deviation]);
  return deviation;
}
