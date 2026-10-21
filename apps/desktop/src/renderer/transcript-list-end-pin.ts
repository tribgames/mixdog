import { type MutableRefObject, type RefObject, useCallback, useLayoutEffect, useMemo } from 'react';
import { createTranscriptEndPin } from './transcript-end-pin';
import { type TranscriptVirtualizer, viewportSize } from './transcript-list-geometry';
import type { TouchScrollDeviation } from './transcript-list-touch-deviation';
import type { TranscriptRowModel } from './transcript-rows';
import { createWholeReplyAnchor } from './transcript-whole-reply-anchor';

/** The list's committed scroll extent and the end pin that keeps a following
 *  timeline at it. */
export function useTranscriptEndPin({
  viewport,
  spacer,
  scrollInset,
  virtualizerRef,
  hasScrollGestureRef,
  domTop,
  markProgrammaticScrollRef,
  deviation,
  rowsRef,
  pauseFollowRef,
}: {
  rowsRef: MutableRefObject<readonly TranscriptRowModel[]>;
  /** Lets go of follow (the follow hook's pause): a long reply that arrived
   *  whole is read from its first line. */
  pauseFollowRef: MutableRefObject<(() => void) | undefined>;
  viewport: RefObject<HTMLDivElement | null>;
  spacer: RefObject<HTMLDivElement | null>;
  scrollInset: MutableRefObject<number>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  hasScrollGestureRef: MutableRefObject<() => boolean>;
  domTop: MutableRefObject<number | null>;
  markProgrammaticScrollRef: MutableRefObject<((top: number, intended?: number) => void) | undefined>;
  deviation: TouchScrollDeviation;
}) {
  // The committed extent: the spacer height virtual-core last wrote (a style
  // read). It is what the DOM scrolls over, also mid-render, when the core's
  // measurement cache may already describe the next row set.
  const contentHeight = useCallback(
    () =>
      scrollInset.current +
      (Number.parseFloat(spacer.current?.style.height ?? '') || virtualizerRef.current.getTotalSize()),
    [scrollInset, spacer, virtualizerRef]
  );
  const maxScrollTop = useCallback(
    () => Math.max(0, contentHeight() - viewportSize(virtualizerRef.current)),
    [contentHeight, virtualizerRef]
  );
  const wholeReply = useMemo(
    () =>
      createWholeReplyAnchor({
        getRows: () => rowsRef.current,
        getVirtualizer: () => virtualizerRef.current,
        getScrollInset: () => scrollInset.current,
      }),
    [rowsRef, virtualizerRef, scrollInset]
  );
  const endPin = useMemo(
    () =>
      createTranscriptEndPin({
        getVirtualizer: () => virtualizerRef.current,
        getViewport: () => viewport.current,
        getSpacer: () => spacer.current,
        getMaxScrollTop: maxScrollTop,
        hasReaderGesture: () => hasScrollGestureRef.current(),
        markProgrammaticScroll: (top, intended) => {
          domTop.current = top;
          markProgrammaticScrollRef.current?.(top, intended);
        },
        dropDeviation: () => deviation.drop(),
        // Landing on a reply's first line is only half of the rule: follow
        // has to let go there. A list that cannot release follow keeps the
        // end — a followed viewport parked on an arrival is stranded above
        // the tail with nothing left to re-pin it.
        takeArrival: (max) => (pauseFollowRef.current ? wholeReply.take(max) : null),
        onArrival: () => pauseFollowRef.current?.(),
      }),
    [
      maxScrollTop,
      viewport,
      virtualizerRef,
      spacer,
      hasScrollGestureRef,
      domTop,
      markProgrammaticScrollRef,
      deviation,
      wholeReply,
      pauseFollowRef,
    ]
  );
  useLayoutEffect(() => () => endPin.cancel(), [endPin]);
  return { contentHeight, maxScrollTop, endPin, wholeReply };
}
