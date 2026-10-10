import { type MutableRefObject, useCallback, useLayoutEffect, useRef } from 'react';
import { READING_ANCHOR_HOLD_MS, rememberRowHeight, type TranscriptVirtualizer } from './transcript-list-geometry';
import type { useReadingAnchor } from './transcript-list-reading-anchor';
import type { TranscriptRowModel } from './transcript-rows';

type ReadingAnchorState = ReturnType<typeof useReadingAnchor>;

/** Rows are measured in their own commits, before paint: left to their
 *  ResizeObserver, a mounted row painted at the flat estimate for a frame or
 *  more — a landing's older rows over the viewport, and every appended row
 *  (a submitted prompt, a reply opening, a tool card) bounced the rows below
 *  it by estimate-vs-real before settling. A landing re-reads every mounted
 *  row (and applies directly: its anchor restore owns the offset); any other
 *  commit reads only the rows without a size yet, through the list's own
 *  resize path so the end pin, deferral, and anchor rules still apply. */
export function useMountedRowMeasurement({
  rows,
  spacer,
  virtualizerRef,
  baseResizeItem,
  pendingResizes,
  indexForPendingKey,
  laidOutRows,
  pendingAnchor,
  anchorHold,
  restoreReadingAnchor,
}: {
  rows: readonly TranscriptRowModel[];
  spacer: MutableRefObject<HTMLDivElement | null>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  baseResizeItem: MutableRefObject<((index: number, size: number) => void) | null>;
  pendingResizes: MutableRefObject<Map<unknown, { index: number; size: number }>>;
  indexForPendingKey: (key: unknown, hint: number) => number;
  laidOutRows: ReadingAnchorState['laidOutRows'];
  pendingAnchor: ReadingAnchorState['pendingAnchor'];
  anchorHold: ReadingAnchorState['anchorHold'];
  restoreReadingAnchor: ReadingAnchorState['restoreReadingAnchor'];
}) {
  const landingMeasure = useRef(false);
  const measureMountedRows = useCallback(
    (landing: boolean) => {
      const root = spacer.current;
      const apply = landing ? baseResizeItem.current : virtualizerRef.current.resizeItem;
      if (!root || !apply) return false;
      const instance = virtualizerRef.current;
      const mounted = [...root.children].filter(
        (row): row is HTMLElement =>
          row instanceof HTMLElement &&
          row.dataset.timelineKey !== undefined &&
          (landing ||
            (!instance.itemSizeCache.has(row.dataset.timelineKey) &&
              !pendingResizes.current.has(row.dataset.timelineKey)))
      );
      if (mounted.length === 0) return false;
      // One batched read: the first lays out what this commit needs anyway,
      // every later one is free. New rows and rows whose content the page
      // changed (a group that gained its head, a reply that took its
      // completion) both land here; the observer's later delivery of the same
      // box is then a no-op, so each size still lands exactly once.
      const sizes = mounted.map((row) => rememberRowHeight(row, Math.round(row.getBoundingClientRect().height)));
      let measured = false;
      mounted.forEach((row, position) => {
        const size = sizes[position] ?? 0;
        const key = row.dataset.timelineKey as string;
        const at = indexForPendingKey(key, Number(row.dataset.index));
        if (size <= 0 || at < 0 || instance.itemSizeCache.get(key) === size) return;
        pendingResizes.current.delete(key);
        apply(at, size);
        measured = true;
      });
      return measured;
    },
    [indexForPendingKey, spacer, baseResizeItem, virtualizerRef, pendingResizes]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: must run only when the row set changes; every other input is read through refs or stable callbacks
  useLayoutEffect(() => {
    laidOutRows.current = rows;
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!pending?.anchor || virtualizerRef.current.options.anchorTo === 'end') return;
    const landedAt = performance.now();
    anchorHold.current = { ...pending.anchor, until: landedAt + READING_ANCHOR_HOLD_MS, start: null, landedAt };
    // Only a row set that moved the anchor (rows landed or left above it) is
    // a landing; a streamed append below the reader reads no layout. The
    // restore re-renders the range at the reading offset in this same task;
    // the effect below measures the rows that commit mounts.
    if (indexForPendingKey(pending.anchor.key, pending.anchor.index) !== pending.anchor.index) {
      landingMeasure.current = true;
      window.requestAnimationFrame(() => {
        landingMeasure.current = false;
      });
      measureMountedRows(true);
    }
    restoreReadingAnchor(true);
  }, [rows]);
  useLayoutEffect(() => {
    if (!landingMeasure.current) measureMountedRows(false);
    else if (measureMountedRows(true)) restoreReadingAnchor();
  });
}
