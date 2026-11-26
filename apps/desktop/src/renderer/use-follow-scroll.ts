import { type RefObject, useCallback, useRef } from 'react';
import { takeScrollWrite } from './own-scroll-writes';
import {
  chromePressHeld,
  distanceFromBottom,
  END_TOLERANCE_PX,
  judgeScrollEvent,
  keyUpRecent,
  moveArrivesNearEnd,
  type ReleaseObservation,
  reportRearm,
  scrollMetrics,
  touchEndRecent,
  transcriptScrollDeviation,
  wheelUpRecent,
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
  // The native scroll extent when a press on the scrollbar began or last moved the view: the press's next move up is
  // the reader's only while the extent under it did not shrink since (a shrink clamps the offset up by itself).
  const lastExtent = useRef(0);

  /** Re-seeds from the viewport as it is now (or zeroes without one). */
  const reseedBaselines = useCallback((element: HTMLDivElement | null) => {
    lastExtent.current = 0;
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

  return { lastTop, lastNativeTop, lastExtent, reseedBaselines };
}

export function useFollowScrollJudge({
  viewport,
  followingRef,
  signals,
  lastTop,
  lastNativeTop,
  lastExtent,
  scheduleScrollState,
  noteScroll,
  attributeScroll,
  settleWrites,
  fingerOnGlass,
  hasTouchScroll,
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
  lastExtent: { current: number };
  scheduleScrollState(element: HTMLDivElement): void;
  noteScroll(): void;
  attributeScroll(top: number, own?: { at: number; top: number }): boolean;
  settleWrites(): void;
  fingerOnGlass(): boolean;
  /** A drag moving the transcript, or its fling, is in progress. */
  hasTouchScroll(): boolean;
  hasReaderScroll(): boolean;
  markReaderMotion(): void;
  publish(next: boolean): void;
  stop(reason?: string, previousTop?: number, observed?: ReleaseObservation): void;
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
      const nativeTop = element.scrollTop;
      const metrics = scrollMetrics(element, undefined, nativeTop + transcriptScrollDeviation(element));
      const top = metrics.top;
      const previousTop = top - (nativeTop - lastNativeTop.current);
      lastNativeTop.current = nativeTop;
      lastTop.current = top;
      const told = scrollEvent ? takeScrollWrite(element) : undefined;
      const written = scrollEvent && attributeScroll(nativeTop, told && !told.reader ? told : undefined);
      let distance = distanceFromBottom(metrics);
      const movedUp = top < previousTop;
      const barHeld = chromePressHeld({ pressedAt: state.barAt, now });
      // A viewport that grew is clamped by the browser onto its new end before
      // the timeline observes the new height, so its cached extent still reads
      // far from the end. For a move that could leave, the native extent has
      // the final word; under a held press it also says whether the move is the press's own.
      const extent = (movedUp || barHeld) && element.clientHeight > 0 ? element.scrollHeight - element.clientHeight : 0;
      if (movedUp && followingRef.current && extent > 0) distance = Math.min(distance, extent - nativeTop);
      const touchDown = fingerOnGlass();
      const inFlight = touchDown || barHeld;
      // A followed view arrives nowhere: its moves are the end kept. Keep an
      // in-flight bottom arrival intact across subpixel clamps and downward
      // nudges while streaming appends height before release.
      if (top !== previousTop) {
        if (followingRef.current) {
          state.arrived = false;
          state.heldArrival = false;
          state.arrivedTop = null;
        } else if (moveArrivesNearEnd({ previousTop, top, distance, written })) {
          state.arrived = true;
          state.heldArrival = inFlight;
          state.arrivedTop = top;
        } else if (inFlight && state.heldArrival && !written && top > previousTop) {
          state.arrived = true;
          state.arrivedTop = Math.max(state.arrivedTop ?? top, top);
        } else {
          const subpixelTremor =
            state.arrived &&
            !written &&
            previousTop > top &&
            previousTop - top <= END_TOLERANCE_PX &&
            (distance <= END_TOLERANCE_PX ||
              (state.heldArrival && state.arrivedTop !== null && top >= state.arrivedTop - END_TOLERANCE_PX));
          if (!subpixelTremor) {
            state.arrived = false;
            state.heldArrival = false;
            state.arrivedTop = null;
          }
        }
      }
      // The upward input of the reader's behind this move, named for the release it may make.
      const upwardInput =
        (wheelUpRecent({ wheelUpAt: state.wheelUpAt, now }) && 'wheel') ||
        (keyUpRecent({ keyUpAt: state.keyUpAt, now }) && 'key') ||
        // A focus a reader's key moved (own-scroll-writes.ts `readerKeyFocus`) vouches for this move as a scroll key does.
        (told?.reader === true && 'focus') ||
        // A finger that travelled toward older rows, on the glass or dragging on from a row that has since left the
        // document.
        ((touchDown || hasTouchScroll()) && state.touchMoved && state.touchDragsUp && 'touch') ||
        (touchEndRecent({ touchEndUpAt: state.touchEndUpAt, now }) && 'fling') ||
        (chromePressHeld({ pressedAt: state.selectUpAt, now }) && 'selection') ||
        (barHeld && movedUp && extent >= lastExtent.current && 'scrollbar') ||
        '';
      const upward = upwardInput !== '';
      if (scrollEvent && barHeld) lastExtent.current = extent;
      const verdict = judgeScrollEvent({
        pinned: followingRef.current,
        previousTop,
        top,
        distance,
        arrived: state.arrived,
        heldArrival: state.heldArrival,
        upward,
        inFlight,
        atWrittenTop: written,
      });
      // A scroll the timeline did not write while a finger is down.
      if (scrollEvent && touchDown && !written) state.touchScrolled = true;
      if (scrollEvent) settleWrites();
      if (transcriptScrollDiagnosticsEnabled() && Math.abs(top - previousTop) >= 8) {
        logTranscriptScroll('viewport-move', {
          from: previousTop,
          to: top,
          delta: top - previousTop,
          programmatic: written,
          following: followingRef.current,
          verdict,
        });
      }
      if (top !== previousTop && !written && hasReaderScroll() && (!followingRef.current || upward)) {
        markReaderMotion();
      }
      if (verdict === 'pin') {
        reportRearm('scroll', metrics);
        publish(true);
        // The end pin waits out the reader's gesture before it writes.
        restore();
      } else if (verdict === 'unpin') {
        stop('scroll', previousTop, { top, distance, input: upwardInput });
      } else if (verdict === 'restore') {
        restore();
      }
    },
    [
      attributeScroll,
      fingerOnGlass,
      followingRef,
      hasReaderScroll,
      hasTouchScroll,
      lastExtent,
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
