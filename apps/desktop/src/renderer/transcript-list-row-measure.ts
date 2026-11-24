import { type MutableRefObject, useCallback, useLayoutEffect, useRef } from 'react';
import { rememberRowHeight, type TranscriptVirtualizer } from './transcript-list-geometry';
import type { useReadingAnchor } from './transcript-list-reading-anchor';
import type { TranscriptRowModel } from './transcript-rows';

type ReadingAnchorState = ReturnType<typeof useReadingAnchor>;

type PendingResizes = MutableRefObject<Map<unknown, { index: number; size: number }>>;

/** The row elements read once since they mounted, with the spacing they took from the rows around them then. A size
 *  the list holds for a row from an earlier mount (a session shown before, a row scrolled away and back) is what the
 *  row measured then: a row that mounts is read in its own commit all the same, so it is never drawn for a frame at a
 *  size it no longer has. A row whose neighbours changed its spacing (a tool card arriving above a streaming reply
 *  gives it the part step) is read in that commit too. */
const readRows = new WeakMap<HTMLElement, string>();

/** The marks a row's content takes from the rows around it (TranscriptList.tsx `renderVirtualRow`). */
function neighbourMarks(row: HTMLElement): string {
  const content = row.firstElementChild;
  if (!(content instanceof HTMLElement)) return '';
  const marks = content.dataset;
  return [
    marks.turnEnd,
    marks.bandSeat,
    marks.bandLead,
    marks.stepBefore,
    marks.afterChanges,
    marks.dividerStep,
    marks.dividerGap,
    marks.blank,
    marks.variant,
  ].join('|');
}

function mountedRowsToMeasure(
  root: HTMLElement,
  instance: TranscriptVirtualizer,
  pendingResizes: PendingResizes,
  handoff: ReadonlySet<string>,
  landing: boolean
) {
  return [...root.children].filter((row): row is HTMLElement => {
    if (!(row instanceof HTMLElement) || row.dataset.timelineKey === undefined) return false;
    const marks = neighbourMarks(row);
    const changed = readRows.get(row) !== marks;
    readRows.set(row, marks);
    return (
      landing ||
      changed ||
      handoff.has(row.dataset.timelineKey) ||
      (!instance.itemSizeCache.has(row.dataset.timelineKey) && !pendingResizes.current.has(row.dataset.timelineKey))
    );
  });
}

/** Reads every row's box before any held height is written (a write between
 *  reads invalidates layout for each next read), then applies the sizes that
 *  differ from what the timeline holds. Returns whether any size was applied. */
function applyMountedRowSizes(
  mounted: readonly HTMLElement[],
  instance: TranscriptVirtualizer,
  pendingResizes: PendingResizes,
  indexForPendingKey: (key: unknown, hint: number) => number,
  apply: (index: number, size: number) => void
) {
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
    const collapsed = size === 0 && Number(boxes[position]?.width) > 0;
    if ((size <= 0 && !collapsed) || at < 0 || instance.itemSizeCache.get(key) === size) return;
    pendingResizes.current.delete(key);
    // virtual-core's resize records no size for a zero delta.
    if (!instance.itemSizeCache.has(key) && instance.measurementsCache[at]?.size === size) {
      instance.itemSizeCache.set(key, size);
      return;
    }
    apply(at, size);
    measured = true;
  });
  return measured;
}

/** Marks the rows whose live band (a Thinking row) left in this row set. */
function noteBandHandoffs(
  before: readonly TranscriptRowModel[],
  rows: readonly TranscriptRowModel[],
  handoff: Set<string>
) {
  const kept = new Set(rows.map((row) => String(row.key)));
  before.forEach((row, index) => {
    const lead = before[index - 1];
    if (row._tag === 'Thinking' && lead && !kept.has(String(row.key)) && kept.has(String(lead.key))) {
      handoff.add(String(lead.key));
    }
  });
}

/** Rows are measured in their own commits, before paint. A landing re-reads
 *  every mounted row (and applies directly: its anchor restore owns the
 *  offset); any other commit reads the rows that mounted in it and those without a size yet, through
 *  the list's own resize path so the end pin, deferral, and anchor rules
 *  still apply. */
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
  pendingResizes: PendingResizes;
  indexForPendingKey: (key: unknown, hint: number) => number;
  laidOutRows: ReadingAnchorState['laidOutRows'];
  pendingAnchor: ReadingAnchorState['pendingAnchor'];
  anchorHold: ReadingAnchorState['anchorHold'];
  restoreReadingAnchor: ReadingAnchorState['restoreReadingAnchor'];
}) {
  const landingMeasure = useRef(false);
  const measuredInLanding = useRef(false);
  const previousRows = useRef(rows);
  const bandHandoff = useRef(new Set<string>());
  const measureMountedRows = useCallback(
    (landing: boolean) => {
      const root = spacer.current;
      const apply = landing ? baseResizeItem.current : virtualizerRef.current.resizeItem;
      if (!root || !apply) return false;
      const instance = virtualizerRef.current;
      const mounted = mountedRowsToMeasure(root, instance, pendingResizes, bandHandoff.current, landing);
      bandHandoff.current.clear();
      if (mounted.length === 0) return false;
      return applyMountedRowSizes(mounted, instance, pendingResizes, indexForPendingKey, apply);
    },
    [indexForPendingKey, spacer, baseResizeItem, virtualizerRef, pendingResizes]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: must run only when the row set changes; every other input is read through refs or stable callbacks
  useLayoutEffect(() => {
    laidOutRows.current = rows;
    const before = previousRows.current;
    previousRows.current = rows;
    noteBandHandoffs(before, rows, bandHandoff.current);
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    if (!pending?.anchor || virtualizerRef.current.options.anchorTo === 'end') return;
    anchorHold.current = { ...pending.anchor, start: null };
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
