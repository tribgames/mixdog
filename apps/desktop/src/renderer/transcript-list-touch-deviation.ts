import { type MutableRefObject, type RefObject, useEffect, useMemo } from 'react';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

/** Measured-size corrections held while a touch scroll owns the viewport.
 *
 *  A scrollTop write during a native touch fling cuts the fling short, and the
 *  offset the fling and the list each believe in drift apart until the next
 *  touch reconciles them in one jump toward older rows (Android: 위로 빠르게
 *  넘기면 멈추고, 다시 터치하면 훨씬 위로 순간이동). While the touch latch is
 *  open, a correction moves the row space instead (a translateY of the
 *  spacer): the reader's rows stay put and the native offset is never written.
 *  The logical offset is the native one plus the held amount. Once the touch
 *  scroll is over, the held amount lands as one scroll write in the same task
 *  that drops the row offset. */
export type TouchScrollDeviation = {
  /** Logical offset minus the native scrollTop. */
  amount(): number;
  /** Holds a logical target as a row offset; false when no touch scroll owns
   *  the viewport and the caller must write it natively. */
  hold(target: number): boolean;
  /** A native write that lands a logical target directly supersedes the hold. */
  drop(): void;
  cancel(): void;
};

export function createTouchScrollDeviation({
  getViewport,
  getSpacer,
  hasTouchScroll,
  markProgrammaticScroll,
}: {
  getViewport(): HTMLDivElement | null;
  getSpacer(): HTMLDivElement | null;
  hasTouchScroll(): boolean;
  markProgrammaticScroll(top: number, intended: number): void;
}): TouchScrollDeviation {
  let amount = 0;
  let frame = 0;
  const paint = () => {
    const space = getSpacer();
    if (space) space.style.transform = amount ? `translateY(${-amount}px)` : '';
  };
  const settle = () => {
    frame = 0;
    if (!amount) return;
    if (hasTouchScroll()) {
      frame = window.requestAnimationFrame(settle);
      return;
    }
    const element = getViewport();
    const held = amount;
    // The native offset is read while the row offset still stands: a held
    // negative amount extends the scrollable overflow, and dropping it first
    // could clamp the native offset before it is read.
    const before = element ? element.scrollTop : 0;
    amount = 0;
    paint();
    if (!element) return;
    const target = before + held;
    element.scrollTop = target;
    const landed = element.scrollTop;
    if (transcriptScrollDiagnosticsEnabled()) {
      logTranscriptScroll('touch-hold-settle', { from: before, to: landed, held });
    }
    markProgrammaticScroll(landed, target);
  };
  return {
    amount: () => amount,
    hold(target) {
      const element = getViewport();
      if (!element || !hasTouchScroll()) return false;
      const next = target - element.scrollTop;
      amount = Math.abs(next) < 0.5 ? 0 : next;
      paint();
      if (amount && !frame) frame = window.requestAnimationFrame(settle);
      return true;
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
  domTop,
  markProgrammaticScrollRef,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  spacer: RefObject<HTMLDivElement | null>;
  hasTouchScrollRef: MutableRefObject<() => boolean>;
  domTop: MutableRefObject<number | null>;
  markProgrammaticScrollRef: MutableRefObject<((top: number, intended?: number) => void) | undefined>;
}): TouchScrollDeviation {
  const deviation = useMemo(
    () =>
      createTouchScrollDeviation({
        getViewport: () => viewport.current,
        getSpacer: () => spacer.current,
        hasTouchScroll: () => hasTouchScrollRef.current(),
        markProgrammaticScroll: (top, intended) => {
          domTop.current = top;
          markProgrammaticScrollRef.current?.(top, intended);
        },
      }),
    [viewport, spacer, hasTouchScrollRef, domTop, markProgrammaticScrollRef]
  );
  useEffect(() => () => deviation.cancel(), [deviation]);
  return deviation;
}
