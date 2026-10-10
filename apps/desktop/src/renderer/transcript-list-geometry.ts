import type { Virtualizer } from '@tanstack/react-virtual';
import type { TranscriptRowModel } from './transcript-rows';
import { TRANSCRIPT_ROW_ESTIMATE } from './transcript-virtual-cache';

/** End band while the tail is owned: every append and measured-size delta is
 *  an end pin (see the virtualizer options in TranscriptList). */
export const SCROLL_END_THRESHOLD_PX = 80;

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

/** Row sizes come from the ResizeObserver's border box only. Every other call
 *  (ref registration, a detached node, a headless layout reporting no box)
 *  keeps the size the timeline already holds: a synchronous rect read per
 *  mounted row forced a layout of the whole list inside every commit. */
export function measureTranscriptRow(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: TranscriptVirtualizer
): number {
  const observed = Number(entry?.borderBoxSize?.[0]?.blockSize);
  if (Number.isFinite(observed) && observed > 0) {
    return rememberRowHeight(element as HTMLElement, Math.round(observed));
  }
  const index = instance.indexFromElement(element as HTMLDivElement);
  const key = instance.options.getItemKey(index);
  return instance.itemSizeCache.get(key) ?? instance.measurementsCache[index]?.size ?? TRANSCRIPT_ROW_ESTIMATE;
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

/** How long landed rows may keep re-measuring above a held reading anchor:
 *  from the landing, extended by each late size, never past the maximum. */
export const READING_ANCHOR_HOLD_MS = 2_000;
export const READING_ANCHOR_HOLD_MAX_MS = 6_000;

/** A row the reader is looking at and its offset from the viewport's top. */
export type ReadingAnchor = { key: unknown; offset: number; index: number };

function positionalRowKey(row: TranscriptRowModel): boolean {
  const missing = (id: unknown) => id === undefined || id === null;
  if (row._tag === 'UserMessage' || row._tag === 'AssistantPart') return missing(row.item.id);
  if (row._tag === 'ToolActivity') return row.items.every((item) => missing(item.id));
  return false;
}

/** The first row under the reading offset that `nextRows` still carries, or
 *  the next one after it that does. Must run before the virtualizer resolves
 *  `nextRows`: its measurement cache still describes `previousRows`, whose
 *  keys are read from the rows themselves (the cache resolves keys lazily
 *  through the CURRENT rows). */
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
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((measurements[middle]?.end ?? 0) <= visibleTop) low = middle + 1;
    else high = middle;
  }
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

/** Native reader motion is the only scroll authority until it becomes idle.
 *
 *  Ownership means READER ownership, never "the core happens to be moving".
 *  The core sets isScrolling for its OWN corrective writes too, and those can
 *  carry a backward direction with nobody touching the transcript, so deferring
 *  on that flag withheld compensation from an idle reader: rows above the
 *  viewport grew uncompensated, their deltas queued, and the flush then landed
 *  the whole batch in one step — the desktop transcript bounced while no one
 *  was scrolling (user: 가만히 있는데 위아래로 투둑 튄다).
 *
 *  An Android fling that outlives the gesture window is held by the touch latch
 *  in use-transcript-follow (touchScrollLatchOpen). That IS reader ownership and
 *  already arrives through this argument, so no core-direction probe is needed
 *  for the "items jump while scrolling up" shake it was added for. */
export function shouldDeferTranscriptScrollAdjustment(hasReaderGesture: boolean): boolean {
  return hasReaderGesture;
}
