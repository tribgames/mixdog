import type { MutableRefObject } from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { takeParkedGrowthAbove } from './markdown-block-parking';
import type { createTranscriptEndPin } from './transcript-end-pin';
import { createHeldRowShrinks, type HeldRowShrinks } from './transcript-list-held-shrinks';
import {
  captureReadingAnchor,
  rememberRowHeight,
  coreScrollState,
  shouldDeferTranscriptScrollAdjustment,
  type TranscriptVirtualizer,
  viewportSize,
} from './transcript-list-geometry';
import { holdsReaderTop } from './transcript-list-reader-place';
import type { useReadingAnchor } from './transcript-list-reading-anchor';
import type { TranscriptRowModel } from './transcript-rows';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import { useSurfaceActive } from './surface-activity';

type ReadingAnchorState = ReturnType<typeof useReadingAnchor>;

/** Every mounted transcript's width re-measure (see useTranscriptWidthSync). */
const transcriptWidthSyncs = new Set<() => void>();

/** Re-measures, in the caller's task, every mounted transcript whose viewport
 *  width changed. */
export function syncTranscriptWidths(): void {
  for (const sync of transcriptWidthSyncs) sync();
}

/** Adds one list's re-measure to syncTranscriptWidths; returns its removal. */
export function registerTranscriptWidthSync(sync: () => void): () => void {
  transcriptWidthSyncs.add(sync);
  return () => {
    transcriptWidthSyncs.delete(sync);
  };
}

/** Runs `sync` whenever the box of `viewport` is laid out at another size (the sync itself passes over a size whose
 *  width it already holds); returns the end of the watch. */
export function observeTranscriptWidth(viewport: Element | null, sync: () => void): () => void {
  if (!viewport || typeof ResizeObserver !== 'function') return () => {};
  const observer = new ResizeObserver(sync);
  observer.observe(viewport);
  return () => observer.disconnect();
}

/** The width-change re-measure of one list: every mounted row is read in one
 *  layout pass at the new width and applied without per-row scroll
 *  compensation; the end pin (following) or the reading anchor (a reader away
 *  from the end) then sets the offset in the same write. */
export function createTranscriptWidthSync({
  getViewport,
  getSpacer,
  getVirtualizer,
  rows,
  scrollInset,
  indexForPendingKey,
  pendingResizes,
  baseResizeItem,
  suppressAdjustment,
  endPin,
  anchorHold,
  restoreReadingAnchor,
}: {
  getViewport(): HTMLElement | null;
  getSpacer(): HTMLElement | null;
  getVirtualizer(): TranscriptVirtualizer;
  rows(): readonly TranscriptRowModel[];
  scrollInset(): number;
  indexForPendingKey(key: unknown, hint: number): number;
  pendingResizes: { current: Map<unknown, { index: number; size: number }> };
  baseResizeItem: { current: ((index: number, size: number) => void) | null };
  /** True while the batch applies: the core must not compensate each row. */
  suppressAdjustment: { current: boolean };
  /** Pins in the caller's task: a width change lands the end in the pass that saw it. */
  endPin: { now(): void };
  anchorHold: ReadingAnchorState['anchorHold'];
  restoreReadingAnchor(landing?: boolean): void;
}) {
  let syncedWidth = 0;
  return () => {
    const element = getViewport();
    const spacer = getSpacer();
    const apply = baseResizeItem.current;
    if (!element?.isConnected || !spacer || !apply) return;
    const instance = getVirtualizer();
    if (!syncedWidth) syncedWidth = Math.round(instance.scrollRect?.width ?? 0);
    const width = Math.round(element.offsetWidth);
    if (width === syncedWidth) return;
    syncedWidth = width;
    if (width <= 0) return;
    const following = instance.options.anchorTo === 'end' || instance.options.followOnAppend;
    const current = rows();
    const anchor = following ? null : captureReadingAnchor(instance, current, current, scrollInset());
    const mounted = [...spacer.children].filter(
      (row): row is HTMLElement => row instanceof HTMLElement && row.dataset.timelineKey !== undefined
    );
    const sizes = mounted.map((row) => rememberRowHeight(row, Math.round(row.getBoundingClientRect().height)));
    let changed = false;
    suppressAdjustment.current = true;
    try {
      mounted.forEach((row, position) => {
        const size = sizes[position] ?? 0;
        const at = indexForPendingKey(row.dataset.timelineKey, Number(row.dataset.index));
        if (size <= 0 || at < 0) return;
        const key = instance.options.getItemKey(at);
        pendingResizes.current.delete(key);
        if (instance.itemSizeCache.get(key) === size) return;
        apply(at, size);
        changed = true;
      });
    } finally {
      suppressAdjustment.current = false;
    }
    if (!changed) return;
    if (following) {
      endPin.now();
      return;
    }
    if (!anchor) return;
    anchorHold.current = { ...anchor, start: null };
    restoreReadingAnchor(true);
  };
}

/** Keeps the rows on screen in the rendered range for two frames: a row that
 *  changed size by more than a viewport (a rewrap) must never unmount the
 *  rows the reader is looking at. */
function pinVisibleRows(
  viewport: HTMLElement,
  pinned: MutableRefObject<number[]>,
  pinFrame: MutableRefObject<number>
): void {
  const view = viewport.getBoundingClientRect();
  pinned.current = [...viewport.querySelectorAll<HTMLElement>('.transcript-virtual-row')]
    .filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > view.top && rect.top < view.bottom;
    })
    .map((row) => Number(row.dataset.index))
    .filter(Number.isFinite);
  if (pinFrame.current) window.cancelAnimationFrame(pinFrame.current);
  pinFrame.current = window.requestAnimationFrame(() => {
    pinFrame.current = window.requestAnimationFrame(() => {
      pinFrame.current = 0;
      pinned.current = [];
    });
  });
}

/** Registers the list's width re-measure for window resizes and shell width
 *  commits; returns the flag that is set while the batch applies (the core
 *  must not compensate each row). An off-screen transcript is not laid out,
 *  so it re-measures once, in the commit that shows it again. */
function useWidthSyncRegistration({
  virtualizer,
  viewport,
  spacer,
  rowsRef,
  scrollInset,
  endPin,
  pendingResizes,
  baseResizeItem,
  anchorHold,
  indexForPendingKey,
  restoreReadingAnchor,
}: {
  virtualizer: TranscriptVirtualizer;
  viewport: { readonly current: HTMLDivElement | null };
  spacer: { readonly current: HTMLDivElement | null };
  rowsRef: { readonly current: readonly TranscriptRowModel[] };
  scrollInset: { readonly current: number };
  endPin: ReturnType<typeof createTranscriptEndPin>;
  pendingResizes: MutableRefObject<Map<unknown, { index: number; size: number }>>;
  baseResizeItem: MutableRefObject<((index: number, size: number) => void) | null>;
  anchorHold: ReadingAnchorState['anchorHold'];
  indexForPendingKey: (key: unknown, hint: number) => number;
  restoreReadingAnchor: ReadingAnchorState['restoreReadingAnchor'];
}) {
  const widthSyncing = useRef(false);
  const latest = useRef({ virtualizer, endPin, indexForPendingKey, restoreReadingAnchor });
  latest.current = { virtualizer, endPin, indexForPendingKey, restoreReadingAnchor };
  const widthSync = useRef<(() => void) | null>(null);
  widthSync.current ??= createTranscriptWidthSync({
    getViewport: () => viewport.current,
    getSpacer: () => spacer.current,
    getVirtualizer: () => latest.current.virtualizer,
    rows: () => rowsRef.current,
    scrollInset: () => scrollInset.current,
    indexForPendingKey: (key, hint) => latest.current.indexForPendingKey(key, hint),
    pendingResizes,
    baseResizeItem,
    suppressAdjustment: widthSyncing,
    endPin: { now: () => latest.current.endPin.now() },
    anchorHold,
    restoreReadingAnchor: (landing) => latest.current.restoreReadingAnchor(landing),
  });
  const surfaceActive = useSurfaceActive();
  // The viewport's element is set after the commit that mounts the list ran its effects: the render after it sees it.
  const element = viewport.current;
  useLayoutEffect(() => {
    if (!surfaceActive) return undefined;
    const sync = () => widthSync.current?.();
    const unregister = registerTranscriptWidthSync(sync);
    window.addEventListener('resize', sync);
    // Whatever changes the list's width (the sidebar, a split's divider, a panel beside it) is seen on the viewport's
    // own box, in the frame that lays it out: every width change goes through the one pass.
    const unobserve = observeTranscriptWidth(element, sync);
    return () => {
      unregister();
      unobserve();
      window.removeEventListener('resize', sync);
    };
  }, [surfaceActive, element]);
  const shownBefore = useRef(surfaceActive);
  useLayoutEffect(() => {
    const returning = surfaceActive && !shownBefore.current;
    shownBefore.current = surfaceActive;
    if (returning) widthSync.current?.();
  }, [surfaceActive]);
  return widthSyncing;
}

/** Decides whether the core compensates the reader's offset for a row's size
 *  change. The end-anchor total-size delta bypasses it by design: upstream
 *  virtual-core has no hook to hold that write, only its own isScrolling
 *  deferral guards the bottom pin. */
function createScrollAdjustmentRule({
  widthSyncing,
  pendingAnchor,
  anchorHold,
  readingAnchorHeld,
  applyingDeferred,
  visibleTop,
}: {
  widthSyncing: MutableRefObject<boolean>;
  pendingAnchor: ReadingAnchorState['pendingAnchor'];
  anchorHold: ReadingAnchorState['anchorHold'];
  readingAnchorHeld: ReadingAnchorState['readingAnchorHeld'];
  applyingDeferred: MutableRefObject<boolean>;
  visibleTop: (instance: TranscriptVirtualizer) => number;
}): TranscriptVirtualizer['shouldAdjustScrollPositionOnItemSizeChange'] {
  return (item, _delta, instance) => {
    const grownAbove = takeParkedGrowthAbove(instance.elementsCache.get(item.key));
    if (widthSyncing.current) return false;
    if (instance.options.anchorTo !== 'end') {
      if (pendingAnchor.current) return false;
      if (readingAnchorHeld() && item.index < (anchorHold.current?.index ?? -1)) return false;
    }
    if (applyingDeferred.current) return true;
    if (grownAbove !== 0 && instance.options.anchorTo !== 'end') {
      (coreScrollState(instance) as unknown as { applyScrollAdjustment(delta: number): void }).applyScrollAdjustment(
        grownAbove
      );
      return false;
    }
    const top = visibleTop(instance);
    if (instance.options.anchorTo !== 'end' && holdsReaderTop(instance, item, top)) return false;
    if (item.end <= top) return true;
    return item.start < top && !instance.itemSizeCache.has(item.key);
  };
}

/** Patches the virtualizer instance's resize path and scroll-compensation
 *  predicate with this list's deferral, reading-anchor and end-pin rules. */
export function useVirtualizerResizePatch({
  virtualizer,
  viewport,
  hasScrollGestureRef,
  visibleTop,
  maxScrollTop,
  endPin,
  resizePinned,
  resizePinFrame,
  pendingResizes,
  baseResizeItem,
  applyingDeferred,
  scheduleResizeFlush,
  pendingAnchor,
  anchorHold,
  readingAnchorHeld,
  queueAnchorRestore,
  spacer,
  rowsRef,
  scrollInset,
  indexForPendingKey,
  restoreReadingAnchor,
}: {
  virtualizer: TranscriptVirtualizer;
  viewport: { readonly current: HTMLDivElement | null };
  hasScrollGestureRef: MutableRefObject<() => boolean>;
  visibleTop: (instance: TranscriptVirtualizer) => number;
  maxScrollTop: () => number;
  endPin: ReturnType<typeof createTranscriptEndPin>;
  resizePinned: MutableRefObject<number[]>;
  resizePinFrame: MutableRefObject<number>;
  pendingResizes: MutableRefObject<Map<unknown, { index: number; size: number }>>;
  baseResizeItem: MutableRefObject<((index: number, size: number) => void) | null>;
  applyingDeferred: MutableRefObject<boolean>;
  scheduleResizeFlush: () => void;
  pendingAnchor: ReadingAnchorState['pendingAnchor'];
  anchorHold: ReadingAnchorState['anchorHold'];
  readingAnchorHeld: ReadingAnchorState['readingAnchorHeld'];
  queueAnchorRestore: ReadingAnchorState['queueAnchorRestore'];
  spacer: { readonly current: HTMLDivElement | null };
  rowsRef: { readonly current: readonly TranscriptRowModel[] };
  scrollInset: { readonly current: number };
  indexForPendingKey: (key: unknown, hint: number) => number;
  restoreReadingAnchor: ReadingAnchorState['restoreReadingAnchor'];
}) {
  const widthSyncing = useWidthSyncRegistration({
    virtualizer,
    viewport,
    spacer,
    rowsRef,
    scrollInset,
    endPin,
    pendingResizes,
    baseResizeItem,
    anchorHold,
    indexForPendingKey,
    restoreReadingAnchor,
  });
  const patchedVirtualizer = useRef<TranscriptVirtualizer | null>(null);
  const heldShrinks = useRef<HeldRowShrinks | null>(null);
  heldShrinks.current ??= createHeldRowShrinks();
  const held = heldShrinks.current;
  const settleHeldShrinks = useCallback(
    (force = false) => {
      const instance = patchedVirtualizer.current;
      if (instance) held.settle(instance, instance.resizeItem, force);
    },
    [held]
  );
  useLayoutEffect(() => {
    settleHeldShrinks();
  });
  if (patchedVirtualizer.current !== virtualizer) {
    patchedVirtualizer.current = virtualizer;
    const resizeItem = virtualizer.resizeItem;
    baseResizeItem.current = resizeItem;
    virtualizer.scrollToEnd = () => {
      endPin.request();
    };
    (virtualizer as unknown as { getMaxScrollOffset(): number }).getMaxScrollOffset = maxScrollTop;
    virtualizer.resizeItem = (index, size) => {
      const element = viewport.current;
      const measured = virtualizer.measurementsCache[index];
      const anchoredAbove = readingAnchorHeld() && index < (anchorHold.current?.index ?? -1);
      if (
        measured &&
        !anchoredAbove &&
        shouldDeferTranscriptScrollAdjustment(hasScrollGestureRef.current()) &&
        // Above the reader at both sizes: a row whose old box still reached
        // into view is folding on screen and lands now, its top edge kept.
        Math.max(measured.end, measured.start + size) <= visibleTop(virtualizer)
      ) {
        pendingResizes.current.set(measured.key, { index, size });
        scheduleResizeFlush();
        return;
      }
      pendingResizes.current.delete(measured?.key ?? index);
      const previous = measured ? (virtualizer.itemSizeCache.get(measured.key) ?? measured.size) : undefined;
      if (measured && held.hold(virtualizer, measured.key, size)) return;
      if (transcriptScrollDiagnosticsEnabled() && previous !== undefined && Math.abs(size - previous) >= 4) {
        logTranscriptScroll('row-resize', {
          index,
          prev: previous,
          next: size,
          delta: size - previous,
          above: measured ? measured.end <= visibleTop(virtualizer) : false,
          top: element ? element.scrollTop : -1,
        });
      }
      if (element && previous !== undefined && Math.abs(size - previous) > viewportSize(virtualizer)) {
        pinVisibleRows(element, resizePinned, resizePinFrame);
      }
      resizeItem(index, size);
      if (measured) held.measured(virtualizer, measured.key, size);
      if (virtualizer.options.followOnAppend || virtualizer.options.anchorTo === 'end') {
        endPin.request();
      } else if (anchoredAbove) {
        queueAnchorRestore();
      }
    };
  }
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = createScrollAdjustmentRule({
    widthSyncing,
    pendingAnchor,
    anchorHold,
    readingAnchorHeld,
    applyingDeferred,
    visibleTop,
  });
  return { settleHeldShrinks };
}
