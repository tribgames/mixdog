import { type MutableRefObject, type RefObject, useCallback, useRef } from 'react';
import { coreScrollState, measureTranscriptRow, type TranscriptVirtualizer } from './transcript-list-geometry';
import { transcriptRowHeightStore } from './transcript-row-estimates';
import type { TranscriptRowModel } from './transcript-rows';
import { TRANSCRIPT_ROW_ESTIMATE } from './transcript-virtual-cache';

/** Unmeasured rows start at their remembered or learned height instead of a
 *  flat 60px (transcript-row-estimates.ts). An estimate is held per key until
 *  the row is measured: re-estimating rows the reader never saw, whenever the
 *  learned heights moved, would shift everything below them. */
export function useTranscriptRowEstimates({
  rowsRef,
  viewport,
  hasScrollGestureRef,
}: {
  rowsRef: MutableRefObject<readonly TranscriptRowModel[]>;
  viewport: RefObject<HTMLDivElement | null>;
  hasScrollGestureRef: MutableRefObject<() => boolean>;
}) {
  const timelineWidth = useRef(0);
  const virtualizerRefForEstimates = useRef<TranscriptVirtualizer | null>(null);
  const endPinForEstimates = useRef<(() => void) | null>(null);
  const heldEstimates = useRef(new Map<unknown, number>());
  const fallbackEstimates = useRef(new Set<unknown>());
  const estimateRow = useCallback(
    (index: number) => {
      const row = rowsRef.current[index];
      if (!row) return TRANSCRIPT_ROW_ESTIMATE;
      const held = heldEstimates.current.get(row.key);
      if (held !== undefined) return held;
      // Before the viewport's first observation only: one width read at mount.
      if (!timelineWidth.current) timelineWidth.current = viewport.current?.clientWidth ?? 0;
      if (!timelineWidth.current) return TRANSCRIPT_ROW_ESTIMATE;
      const store = transcriptRowHeightStore();
      // A flat fallback is held too (any re-estimate moves rows), but marked:
      // the session's own first measured rows usually teach its shape a moment
      // later, and relearnEstimates may then replace it.
      if (!store.knows(row, timelineWidth.current)) fallbackEstimates.current.add(row.key);
      const estimate = store.estimate(row, timelineWidth.current);
      heldEstimates.current.set(row.key, estimate);
      return estimate;
    },
    [rowsRef, viewport]
  );
  // A newly learned shape re-estimates the rows still at the flat fallback,
  // but only while the timeline follows its end: the end pin then keeps the
  // reader's view still while every unmeasured row above changes size, in one
  // write instead of one correction per row as each is scrolled into. A
  // reader away from the end is never shifted by it; those rows pick up the
  // learned shape at the next full re-layout (a page landing, a new row).
  const relearnFrame = useRef(0);
  const relearnEstimates = useCallback(() => {
    if (relearnFrame.current) return;
    relearnFrame.current = window.requestAnimationFrame(() => {
      relearnFrame.current = 0;
      const instance = virtualizerRefForEstimates.current;
      if (instance?.options.anchorTo !== 'end' || hasScrollGestureRef.current()) return;
      for (const key of fallbackEstimates.current) heldEstimates.current.delete(key);
      fallbackEstimates.current.clear();
      const core = instance as unknown as { pendingMin: number | null; itemSizeCacheVersion: number };
      core.pendingMin = 0;
      core.itemSizeCacheVersion += 1;
      coreScrollState(instance).notify(false);
      endPinForEstimates.current?.();
    });
  }, [hasScrollGestureRef]);
  const measureRowSize = useCallback(
    (element: Element, entry: ResizeObserverEntry | undefined, instance: TranscriptVirtualizer) => {
      const size = measureTranscriptRow(element, entry, instance);
      // Only the observer's settled boxes teach the store: a streaming reply
      // or a row still waiting for its parser is not its final height.
      const row = entry ? rowsRef.current[instance.indexFromElement(element as HTMLDivElement)] : undefined;
      if (
        row &&
        timelineWidth.current > 0 &&
        row._tag !== 'Thinking' &&
        !('live' in row && row.live) &&
        !('active' in row && row.active) &&
        !element.querySelector('[data-transcript-pending]')
      ) {
        if (transcriptRowHeightStore().record(row, timelineWidth.current, size)) relearnEstimates();
      }
      return size;
    },
    [rowsRef, relearnEstimates]
  );
  return {
    timelineWidth,
    virtualizerRefForEstimates,
    endPinForEstimates,
    heldEstimates,
    fallbackEstimates,
    relearnFrame,
    estimateRow,
    measureRowSize,
  };
}
