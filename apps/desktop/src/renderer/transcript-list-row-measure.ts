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
  // The landing commit's rows were just read by the row-set effect below: the
  // every-commit effect after it in the SAME commit would read the same boxes
  // again, after the anchor restore's scroll and spacer writes invalidated
  // layout — a second full layout of the landed page per landing (the 240ms
  // tasks of a phone's flick into older history). The rows the restore mounts
  // land in its own commit, which measures them.
  const measuredInLanding = useRef(false);
  const previousRows = useRef(rows);
  // Rows whose live band left in this row set: the band's row is gone from
  // the virtual total in this commit, while the reply above it took the
  // band's slot (its completion footer) in the same commit. Left to its
  // ResizeObserver, that growth landed a frame after the shrink, and the
  // followed tail painted one frame 40px low at every turn end.
  const bandHandoff = useRef(new Set<string>());
  const measureMountedRows = useCallback(
    (landing: boolean) => {
      const root = spacer.current;
      const apply = landing ? baseResizeItem.current : virtualizerRef.current.resizeItem;
      if (!root || !apply) return false;
      const instance = virtualizerRef.current;
      const handoff = bandHandoff.current;
      const mounted = [...root.children].filter(
        (row): row is HTMLElement =>
          row instanceof HTMLElement &&
          row.dataset.timelineKey !== undefined &&
          (landing ||
            handoff.has(row.dataset.timelineKey) ||
            (!instance.itemSizeCache.has(row.dataset.timelineKey) &&
              !pendingResizes.current.has(row.dataset.timelineKey)))
      );
      handoff.clear();
      if (mounted.length === 0) return false;
      // One batched read: the first lays out what this commit needs anyway,
      // every later one is free. New rows and rows whose content the page
      // changed (a group that gained its head, a reply that took its
      // completion) both land here; the observer's later delivery of the same
      // box is then a no-op, so each size still lands exactly once.
      // All rects are read before any row's held height is written: writing
      // inside the read loop invalidated style, so every next read forced
      // another style/layout pass (one per mounted row).
      const boxes = mounted.map((row) => row.getBoundingClientRect());
      const sizes = boxes.map((box) => Math.round(box.height));
      mounted.forEach((row, position) => {
        rememberRowHeight(row, sizes[position] ?? 0);
      });
      let measured = false;
      mounted.forEach((row, position) => {
        const size = sizes[position] ?? 0;
        const key = row.dataset.timelineKey as string;
        const at = indexForPendingKey(key, Number(row.dataset.index));
        // A laid-out row (it has a width) that paints nothing is 0px: an
        // agent chat's reaction-only reply renders null below its row div.
        // Its ResizeObserver never reports that box (a row that mounts at
        // zero height has no size change to deliver), so skipping it here
        // left the row at its estimate for good: a 60px blank gap under the
        // reacted prompt. That holds while it is pending too (its turn's
        // changes card unread): the card resolves to nothing without
        // changing the box, so nothing would measure it again, and one that
        // does paint is a box change its observer reports. Only a hidden
        // pane (no width) keeps the size the timeline holds.
        const collapsed = size === 0 && Number(boxes[position]?.width) > 0;
        if ((size <= 0 && !collapsed) || at < 0 || instance.itemSizeCache.get(key) === size) return;
        // A row whose height its estimate already had (the learned shape is
        // often exact) changes no geometry, and virtual-core's resize records
        // no size for a zero delta: the row stayed unmeasured, so every later
        // commit read every such row again (a forced layout per commit) and
        // the snapshot a revisit restores left them out. Recorded here, the
        // row counts as measured with nothing moved.
        if (!instance.itemSizeCache.has(key) && instance.measurementsCache[at]?.size === size) {
          pendingResizes.current.delete(key);
          instance.itemSizeCache.set(key, size);
          return;
        }
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
    const before = previousRows.current;
    previousRows.current = rows;
    const kept = new Set(rows.map((row) => String(row.key)));
    before.forEach((row, index) => {
      const lead = before[index - 1];
      if (row._tag === 'Thinking' && lead && !kept.has(String(row.key)) && kept.has(String(lead.key))) {
        bandHandoff.current.add(String(lead.key));
      }
    });
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
      measuredInLanding.current = true;
    }
    restoreReadingAnchor(true);
  }, [rows]);
  useLayoutEffect(() => {
    if (measuredInLanding.current) {
      measuredInLanding.current = false;
      return;
    }
    if (!landingMeasure.current) measureMountedRows(false);
    else if (measureMountedRows(true)) restoreReadingAnchor();
  });
}
