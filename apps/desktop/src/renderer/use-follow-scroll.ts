import { type RefObject, useCallback, useRef } from 'react';
import {
  chromePressHeld,
  distanceFromBottom,
  judgeScrollEvent,
  keyUpRecent,
  mutationExplainsScroll,
  scrollMetrics,
  touchEndRecent,
  transcriptScrollDeviation,
  wheelUpRecent,
  widthShiftPending,
} from './transcript-follow-rules';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import type { FollowSignals } from './use-follow-signals';

/** What the last scroll event saw: the baselines every direction judgement is
 *  made against. */
export function useScrollBaselines() {
  // Last observed offset, so a release demands an actual UPWARD move.
  const lastTop = useRef(0);
  // Last native scrollTop seen in a scroll event. Direction is judged from
  // native displacement: a correction the timeline holds (or lands) during a
  // touch scroll moves the logical offset while the reader does not move.
  const lastNativeTop = useRef(0);

  /** Re-seeds from the viewport as it is now (or zeroes without one). */
  const reseedBaselines = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      lastNativeTop.current = 0;
      lastTop.current = 0;
      return;
    }
    try {
      const metrics = scrollMetrics(element);
      lastTop.current = metrics.top;
      lastNativeTop.current = metrics.top - transcriptScrollDeviation(element);
    } catch {
      /* layout only */
    }
  }, []);

  return { lastTop, lastNativeTop, reseedBaselines };
}

/**
 * The scroll judgement: one observation of the viewport's offset (a scroll
 * event, or a finger lift) and what it means for follow — see
 * judgeScrollEvent. Returns the observer to call with `true` for a scroll
 * event and `false` for a lift.
 */
export function useFollowScrollJudge({
  viewport,
  followingRef,
  signals,
  lastTop,
  lastNativeTop,
  scheduleScrollState,
  noteScroll,
  attributeScroll,
  settleWrites,
  fingerOnGlass,
  hasReaderScroll,
  markReaderMotion,
  publish,
  stop,
  restore,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  followingRef: RefObject<boolean>;
  signals: RefObject<FollowSignals>;
  lastTop: { current: number };
  lastNativeTop: { current: number };
  scheduleScrollState(element: HTMLDivElement): void;
  noteScroll(): void;
  attributeScroll(top: number): { recent: boolean; exact: boolean };
  settleWrites(): void;
  fingerOnGlass(): boolean;
  hasReaderScroll(): boolean;
  markReaderMotion(): void;
  publish(next: boolean): void;
  stop(reason?: string, previousTop?: number): void;
  /** Put the viewport back at the end (the pinned resnap). */
  restore(): void;
}) {
  return useCallback(
    (scrollEvent: boolean) => {
      const element = viewport.current;
      if (!element) return;
      if (scrollEvent) {
        scheduleScrollState(element);
        // Every frame of a touch scroll — finger-driven or inertial — keeps the
        // latch alive, so the idle fallback can only close it once the native
        // stream has actually stopped delivering.
        noteScroll();
      }
      const now = Date.now();
      const state = signals.current;
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
      const previousTop = top - (nativeTop - lastNativeTop.current);
      lastNativeTop.current = nativeTop;
      lastTop.current = top;
      const write = scrollEvent ? attributeScroll(nativeTop) : { recent: false, exact: false };
      let distance = distanceFromBottom(metrics);
      // A viewport that grew (the dock shrank) is clamped by the browser onto
      // its new end before the timeline observes the new height, so its cached
      // extent still reads far from the end. For a move that could leave, the
      // native extent has the final word.
      if (top < previousTop && followingRef.current && element.clientHeight > 0) {
        distance = Math.min(distance, element.scrollHeight - element.clientHeight - nativeTop);
      }
      if (top !== previousTop) state.direction = top > previousTop ? 1 : -1;
      const zoom = window.devicePixelRatio || 1;
      const zoomChanged = zoom !== state.zoom;
      state.zoom = zoom;
      const touchDown = fingerOnGlass();
      const widthShifted = widthShiftPending(state.width, element.clientWidth);
      const verdict = judgeScrollEvent({
        pinned: followingRef.current,
        previousTop,
        top,
        distance,
        lastDirection: state.direction,
        touchDown,
        wheelUpRecent: wheelUpRecent({ wheelUpAt: state.wheelUpAt, now }),
        inWriteWindow: write.recent,
        atWrittenTop: write.exact,
        pressHeld: chromePressHeld({ pressedAt: state.pressAt, now }),
        keyUpRecent: keyUpRecent({ keyUpAt: state.keyUpAt, now }),
        touchEndRecent: touchEndRecent({ touchEndUpAt: state.touchEndUpAt, now }),
        zoomChanged,
        zoom,
        mutationRecent: mutationExplainsScroll({ mutationAt: state.mutationAt, restoredAt: state.restoredAt, now }),
        widthShifted,
      });
      // A scroll the timeline did not write while a finger is down.
      if (scrollEvent && touchDown && !write.recent && !write.exact) state.touchScrolled = true;
      if (scrollEvent) settleWrites();
      if (transcriptScrollDiagnosticsEnabled() && Math.abs(top - previousTop) >= 8) {
        logTranscriptScroll('viewport-move', {
          from: previousTop,
          to: top,
          delta: top - previousTop,
          programmatic: write.recent || write.exact,
          following: followingRef.current,
          verdict,
        });
      }
      // A native reader ramp may outlive the initial 250ms gesture window.
      // Extend ownership only from real movement, never from a virtual-core
      // correction, so compensation resumes once wheel/inertia actually stops.
      if (top !== previousTop && !write.recent && !write.exact && hasReaderScroll()) markReaderMotion();
      if (verdict === 'pin') {
        if (!followingRef.current) publish(true);
      } else if (verdict === 'unpin') {
        stop('scroll', previousTop);
      } else if (verdict === 'restore') {
        if (widthShifted && state.width) state.width.spent = element.clientWidth;
        state.restoredAt = now;
        restore();
      }
    },
    [
      attributeScroll,
      fingerOnGlass,
      followingRef,
      hasReaderScroll,
      lastNativeTop,
      lastTop,
      markReaderMotion,
      noteScroll,
      publish,
      restore,
      scheduleScrollState,
      settleWrites,
      signals,
      stop,
      viewport,
    ]
  );
}
