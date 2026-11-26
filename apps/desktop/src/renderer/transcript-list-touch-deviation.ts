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
  /** Lands any active hold immediately (e.g. on an explicit disclosure click). */
  landNow(): boolean;
  /** A native write that lands a logical target directly supersedes the hold. */
  drop(): void;
  cancel(): void;
};

const DISCLOSURE_CLICK_SELECTOR =
  '.tool-activity-header, .tool-activity-item-header[data-disclosure="true"], .tool-card > .tool-header, .tool-activity-preview-more, [aria-expanded]';

function quantizeToDevicePixel(value: number): number {
  const dpr =
    typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
      ? window.devicePixelRatio
      : 1;
  return Math.round(value * dpr) / dpr;
}

function isDisclosureClickTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const candidate = target as {
    closest?: (selector: string) => unknown;
    parentElement?: { closest?: (selector: string) => unknown } | null;
  };
  const element = typeof candidate.closest === 'function' ? candidate : candidate.parentElement;
  return Boolean(element && typeof element.closest === 'function' && element.closest(DISCLOSURE_CLICK_SELECTOR));
}

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
    const painted = amount ? quantizeToDevicePixel(amount) : 0;
    space.style.transform = painted ? `translateY(${-painted}px)` : '';
    // A transform leaves the in-flow extent unchanged; the negative margin
    // keeps the native end on the lifted rows' end.
    space.style.marginBottom = painted > 0 ? `${-painted}px` : '';
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
  /** A wheel ramp resting at native 0 with history held above it: no scroll is left there for a write to cancel, and no
   *  scroll event will come to end the hold, so the history could never be reached while the wheel keeps turning. */
  const wheelAtTop = (): boolean => {
    const element = getViewport();
    return amount > 0 && !clampAtEdge() && element !== null && element.scrollTop <= TOP_EDGE_PX;
  };
  const settle = () => {
    frame = 0;
    if (!amount) return;
    if ((hasTouchScroll() && !wheelAtTop()) || !land()) frame = window.requestAnimationFrame(settle);
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
    landNow() {
      if (!amount) return true;
      const landed = land();
      if (landed && frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      return landed;
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
  // Explicit disclosure clicks also land any active deviation before the
  // card toggles and starts its height transition.
  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const landForTouch = () => deviation.landForTouch();
    const landForDisclosureClick = (event: MouseEvent) => {
      if (deviation.amount() !== 0 && isDisclosureClickTarget(event.target)) {
        deviation.landNow();
      }
    };
    element.addEventListener('touchstart', landForTouch, { passive: true });
    element.addEventListener('click', landForDisclosureClick, { capture: true });
    return () => {
      element.removeEventListener('touchstart', landForTouch);
      element.removeEventListener('click', landForDisclosureClick, { capture: true });
    };
  }, [viewport, deviation]);
  return deviation;
}
