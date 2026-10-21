import { type RefObject, useCallback, useEffect, useRef } from 'react';
import {
  distanceFromBottom,
  readerScrollShouldReleaseFollow,
  scrollExtentClamped,
  scrollMetrics,
  transcriptEndReached,
  transcriptScrollDeviation,
} from './transcript-follow-rules';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

/** What the last scroll event and the last content observation saw: the
 *  baselines every release / re-attach / growth decision is judged against. */
export function useScrollBaselines() {
  // Last observed offset, so a release demands an actual UPWARD move.
  const lastTop = useRef(0);
  // Last native scrollTop seen in a scroll event. Direction is judged from
  // native displacement: a correction the timeline holds (or lands) during a
  // touch scroll moves the logical offset while the reader does not move.
  const lastNativeTop = useRef(0);
  // Last observed content height, so a growth commit can be judged against the
  // bottom it had BEFORE that growth (see grewWhileAtBottom).
  const lastScrollHeight = useRef(0);
  // Distance from the content end as of the last event that was NOT a
  // content mutation — the pre-mutation snapshot a plain listener takes.
  const lastDistance = useRef(0);

  /** Re-seeds from the viewport as it is now (or zeroes without one). */
  const reseedBaselines = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      lastNativeTop.current = 0;
      lastTop.current = 0;
      lastScrollHeight.current = 0;
      lastDistance.current = 0;
      return;
    }
    try {
      const metrics = scrollMetrics(element);
      lastTop.current = metrics.top;
      lastNativeTop.current = metrics.top - transcriptScrollDeviation(element);
      lastScrollHeight.current = metrics.maxScrollTop + metrics.viewportHeight;
      lastDistance.current = distanceFromBottom(metrics);
    } catch {
      /* layout only */
    }
  }, []);

  return { lastTop, lastNativeTop, lastScrollHeight, lastDistance, reseedBaselines };
}

/**
 * Follow re-engages only where the reader stopped THEMSELVES: at the end of
 * the content, once their scroll has settled. Re-attaching mid-scroll handed
 * the viewport to the end pin while the reader was still moving — it snapped
 * the rest of the way down for them and pushed new output up under their hand
 * (wheel, touch and its fling alike). So a reader scroll event only records
 * whether it ended at the end; the decision waits, frame by frame, until the
 * reader's scroll is over, and is then taken from that last reader position.
 * Content that grows meanwhile does not undo the arrival: the reader reached
 * the end, and from then on the end pin keeps it.
 */
export function useSettledReattach({
  followingRef,
  readerSettled,
  publish,
}: {
  followingRef: RefObject<boolean>;
  /** No wheel, touch, fling or touch hold owns the viewport. */
  readerSettled(): boolean;
  publish(next: boolean): void;
}) {
  const atEnd = useRef(false);
  const frame = useRef(0);
  const settle = useCallback(() => {
    frame.current = 0;
    if (followingRef.current || !atEnd.current) return;
    if (!readerSettled()) {
      frame.current = window.requestAnimationFrame(settle);
      return;
    }
    atEnd.current = false;
    publish(true);
  }, [followingRef, publish, readerSettled]);
  /** A reader scroll event, at the content end or not. */
  const noteReaderPosition = useCallback(
    (reached: boolean) => {
      atEnd.current = reached;
      if (reached && !frame.current) settle();
    },
    [settle]
  );
  const cancelReattach = useCallback(() => {
    atEnd.current = false;
    if (frame.current) window.cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);
  useEffect(() => cancelReattach, [cancelReattach]);
  return { noteReaderPosition, cancelReattach };
}

/** The viewport's scroll event: updates the baselines, extends reader motion,
 *  and decides between release, re-attach, or nothing. */
export function useFollowScrollEvent({
  viewport,
  followingRef,
  lastTop,
  lastNativeTop,
  lastScrollHeight,
  lastDistance,
  scheduleScrollState,
  noteScroll,
  isProgrammatic,
  isChromePress,
  fingerOnGlass,
  hasReaderScroll,
  markReaderMotion,
  noteReaderPosition,
  stop,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  followingRef: RefObject<boolean>;
  lastTop: { current: number };
  lastNativeTop: { current: number };
  lastScrollHeight: { current: number };
  lastDistance: { current: number };
  scheduleScrollState(element: HTMLDivElement): void;
  noteScroll(): void;
  isProgrammatic(top: number): boolean;
  isChromePress(): boolean;
  fingerOnGlass(): boolean;
  hasReaderScroll(): boolean;
  markReaderMotion(): void;
  /** useSettledReattach: whether this reader position is the content end. */
  noteReaderPosition(reached: boolean): void;
  stop(reason?: string, previousTop?: number): void;
}) {
  return useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    scheduleScrollState(element);
    // Every frame of a touch scroll — finger-driven or inertial — keeps the
    // latch alive, so the idle fallback can only close it once the native
    // stream has actually stopped delivering.
    noteScroll();
    // The offset is the only layout value read here; the extent comes from the
    // timeline's geometry. Programmatic writes are recorded as the native
    // offsets they landed on; reading position and extent are logical, which
    // includes a correction the timeline holds during a touch scroll. The
    // previous position is the current logical one minus the NATIVE move, so
    // a held correction growing between two events is never read as reader
    // direction.
    const nativeTop = element.scrollTop;
    const metrics = scrollMetrics(element, undefined, nativeTop + transcriptScrollDeviation(element));
    const top = metrics.top;
    const previousNativeTop = lastNativeTop.current;
    const previousTop = top - (nativeTop - previousNativeTop);
    lastNativeTop.current = nativeTop;
    lastTop.current = top;
    const programmaticScroll = isProgrammatic(nativeTop);
    // A content click must not open the gesture window: a stream wobble in
    // the next 250ms would then unlock follow (user: 스크립트 클릭하면
    // 오토스크롤·줄바꿈이 풀린다). Selection autoscroll is the exception —
    // pointerDragging is armed only after a real 4px drag.
    const releaseCandidate =
      followingRef.current &&
      readerScrollShouldReleaseFollow({
        programmatic: programmaticScroll,
        chromePointer: isChromePress(),
        fingerOnGlass: fingerOnGlass(),
        upwardMove: previousTop - top,
      });
    // The dock shrinking grows the viewport, and Chromium clamps an offset
    // past the new end onto it — while a pointer held still on the scrollbar
    // keeps the end pin deferred, so no write of the timeline accounts for
    // that move. It is the extent changing, not the reader. Checked only for
    // a move that would release, and against the native extent: a clamp from
    // a forced layout can arrive before the timeline observes the new height.
    const clamped =
      releaseCandidate &&
      scrollExtentClamped({
        previousTop: previousNativeTop,
        top: nativeTop,
        maxScrollTop: element.scrollHeight - element.clientHeight,
      });
    if (transcriptScrollDiagnosticsEnabled() && Math.abs(top - previousTop) >= 8) {
      logTranscriptScroll('viewport-move', {
        from: previousTop,
        to: top,
        delta: top - previousTop,
        programmatic: programmaticScroll,
        following: followingRef.current,
      });
    }
    // A native reader ramp may outlive the initial 250ms gesture window.
    // Extend ownership only from real movement, never from a virtual-core
    // correction, so compensation resumes once wheel/inertia actually stops.
    if (top !== previousTop && !programmaticScroll && !clamped && hasReaderScroll()) {
      markReaderMotion();
    }
    lastScrollHeight.current = metrics.maxScrollTop + metrics.viewportHeight;
    // A scroll event is the reader's (or the core's) position talking, not a
    // content mutation: it is exactly the snapshot the content observer needs.
    lastDistance.current = distanceFromBottom(metrics);
    // Re-attaching is not gesture-gated: smooth-scroll and inertial tails
    // deliver their last frames well after the 250ms window closes. Every
    // reader position is recorded, and an arrival at the end re-attaches once
    // the reader's scroll settles (useSettledReattach). Only the RELEASE
    // decision needs gesture attribution; a detached viewport cannot release
    // again.
    if (!followingRef.current) {
      // The timeline's own corrective writes are not the reader moving.
      if (programmaticScroll) return;
      noteReaderPosition(transcriptEndReached(metrics));
      return;
    }
    if (releaseCandidate && !clamped) stop('scroll', previousTop);
  }, [
    fingerOnGlass,
    followingRef,
    hasReaderScroll,
    isChromePress,
    isProgrammatic,
    lastDistance,
    lastNativeTop,
    lastScrollHeight,
    lastTop,
    markReaderMotion,
    noteReaderPosition,
    noteScroll,
    scheduleScrollState,
    stop,
    viewport,
  ]);
}
