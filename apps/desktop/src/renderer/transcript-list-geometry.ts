import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual';
import type { TranscriptRowModel } from './transcript-rows';
import { TRANSCRIPT_ROW_ESTIMATE } from './transcript-virtual-cache';

/** No distance band while the tail is owned: the pinned flag alone decides,
 *  so every append and measured-size delta is an end pin wherever the
 *  viewport sits (see the virtualizer options in TranscriptList). */
export const SCROLL_END_THRESHOLD_PX = Number.POSITIVE_INFINITY;

export type TranscriptVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>;

/** Core state the timeline writes around virtual-core's own scroll path. */
export type CoreScrollState = {
  scrollOffset: number | null;
  scrollAdjustments: number;
  _intendedScrollOffset: number | null;
  getSize(): number;
  notify(sync: boolean): void;
};

export const coreScrollState = (instance: TranscriptVirtualizer) => instance as unknown as CoreScrollState;

export function rememberRowHeight(element: HTMLElement, height: number): number {
  // A pending parser/chunk is not a new measurement of the resolved content.
  // CSS holds the last real box until the pending marker leaves the row.
  if (!element.querySelector('[data-transcript-pending]')) {
    element.style.setProperty('--transcript-measured-height', `${height}px`);
  }
  return height;
}

/** The size observed by the ResizeObserver's border box; every other call keeps the size already held. A laid-out row may
 *  observe zero height; a hidden pane (no width) and a row pending its parser keep the held size. */
export function measureTranscriptRow(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: TranscriptVirtualizer
): number {
  const box = entry?.borderBoxSize?.[0];
  const observed = Number(box?.blockSize);
  const collapsed =
    observed === 0 && Number(box?.inlineSize) > 0 && !element.querySelector('[data-transcript-pending]');
  if (Number.isFinite(observed) && (observed > 0 || collapsed)) {
    return rememberRowHeight(element as HTMLElement, Math.round(observed));
  }
  const index = instance.indexFromElement(element as HTMLDivElement);
  const key = instance.options.getItemKey(index);
  return instance.itemSizeCache.get(key) ?? instance.measurementsCache[index]?.size ?? TRANSCRIPT_ROW_ESTIMATE;
}

/** The thread's top padding: the offset between the scroll origin and the spacer-relative row offsets. */
export function transcriptThreadInset(thread: Element): number {
  return Number.parseFloat(window.getComputedStyle(thread).paddingTop) || 0;
}

// Newer virtual cores expose getLogicalScrollOffset(); the resolved core
// predates it, so read the scrollOffset + pending scrollAdjustments pair here.
export function logicalScrollOffset(instance: TranscriptVirtualizer): number {
  const adjustments = Number(coreScrollState(instance).scrollAdjustments) || 0;
  return (instance.scrollOffset ?? 0) + adjustments;
}

/** Viewport height as virtual-core last observed it (ResizeObserver). */
export function viewportSize(instance: TranscriptVirtualizer): number {
  return coreScrollState(instance).getSize();
}

/** A row the reader is looking at and its offset from the viewport's top. */
export type ReadingAnchor = { key: unknown; offset: number; index: number };

function positionalRowKey(row: TranscriptRowModel): boolean {
  const missing = (id: unknown) => id === undefined || id === null;
  if (row._tag === 'UserMessage' || row._tag === 'AssistantPart') return missing(row.item.id);
  if (row._tag === 'ToolActivity') return row.items.every((item) => missing(item.id));
  return false;
}

/** The index of the first of the first `count` (> 0) measured rows whose end lies past `top`; the last one when none does. */
export function firstRowEndingAfter(
  measurements: readonly Pick<VirtualItem, 'end'>[],
  count: number,
  top: number
): number {
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((measurements[middle]?.end ?? 0) <= top) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The first row under the reading offset that `nextRows` still carries, or the next one after it that does. Must run
 *  before the virtualizer resolves `nextRows`: its measurement cache still describes `previousRows`. */
export function captureReadingAnchor(
  instance: TranscriptVirtualizer,
  previousRows: readonly TranscriptRowModel[],
  nextRows: readonly TranscriptRowModel[],
  inset: number
): ReadingAnchor | null {
  const measurements = instance.measurementsCache;
  const count = Math.min(previousRows.length, measurements.length);
  if (count === 0) return null;
  const reading = logicalScrollOffset(instance);
  // The first row VISIBLE at the viewport's top edge: rows start `inset`
  // below the scroll origin, so one ending within that strip is still in view.
  const visibleTop = reading - inset;
  const low = firstRowEndingAfter(measurements, count, visibleTop);
  let survivors: Set<unknown> | null = null;
  for (let index = low; index < count; index += 1) {
    const row = previousRows[index];
    // A key derived from the row's position in the window (an item without
    // an id) names a DIFFERENT row once a page is prepended.
    if (!row || positionalRowKey(row)) continue;
    const key = row.key;
    if (!Object.is(nextRows[index]?.key, key)) {
      survivors ??= new Set<unknown>(nextRows.map((row) => row.key));
      if (!survivors.has(key)) continue;
    }
    return { key, offset: (measurements[index]?.start ?? 0) - reading, index };
  }
  return null;
}

/** Native reader motion is the only scroll authority until idle: virtual-core also sets isScrolling for its own
 *  corrective writes, so the core's scroll flag never decides. */
export function shouldDeferTranscriptScrollAdjustment(hasReaderGesture: boolean): boolean {
  return hasReaderGesture;
}
