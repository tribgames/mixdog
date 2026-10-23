import type { MutableRefObject } from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';
import type { createTranscriptEndPin } from './transcript-end-pin';
import { createHeldRowShrinks, type HeldRowShrinks } from './transcript-list-held-shrinks';
import {
  captureReadingAnchor,
  READING_ANCHOR_HOLD_MS,
  rememberRowHeight,
  shouldDeferTranscriptScrollAdjustment,
  type TranscriptVirtualizer,
  viewportSize,
} from './transcript-list-geometry';
import type { useReadingAnchor } from './transcript-list-reading-anchor';
import type { TranscriptRowModel } from './transcript-rows';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

type ReadingAnchorState = ReturnType<typeof useReadingAnchor>;

/** Every mounted transcript's width re-measure (see useTranscriptWidthSync). */
const transcriptWidthSyncs = new Set<() => void>();

/** Re-measures, in the caller's task, every mounted transcript whose viewport
 *  width changed. A shell commit that moves a pane's edge (side dock, sidebar)
 *  calls it from the layout effect of that commit, so the rewrapped rows, their
 *  positions and the scroll anchor all land in the frame the width changes —
 *  left to the rows' ResizeObservers, a hover hit-test or a forced paint step
 *  could still present the rewrapped rows at their old offsets first. */
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

/** The width-change re-measure of one list: every mounted row is read in ONE
 *  layout pass at the new width and applied without per-row scroll
 *  compensation; the end pin (following) or the reading anchor (a reader away
 *  from the end) then sets the offset in the same write. Late sizes of rows
 *  above the anchor stay compensated while it is held. */
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
  endPin: { request(): void };
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
    // The width the rows were last measured at: the core's own observation
    // until this list syncs once.
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
    // One batched read: the first lays the list out at the new width, every
    // later one is free.
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
      endPin.request();
      return;
    }
    if (!anchor) return;
    const now = performance.now();
    anchorHold.current = { ...anchor, until: now + READING_ANCHOR_HOLD_MS, start: null, landedAt: now };
    restoreReadingAnchor(true);
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
  // A width change is re-measured in ONE pass (createTranscriptWidthSync)
  // whose offset write covers every row; the core must not compensate each.
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
    endPin: { request: () => latest.current.endPin.request() },
    anchorHold,
    restoreReadingAnchor: (landing) => latest.current.restoreReadingAnchor(landing),
  });
  // A window resize re-lays the list out before this frame's observers run:
  // the resize event is dispatched ahead of layout, so the re-measure lands in
  // the frame of the new width, once per frame however fast the drag.
  useLayoutEffect(() => {
    const sync = () => widthSync.current?.();
    const unregister = registerTranscriptWidthSync(sync);
    window.addEventListener('resize', sync);
    return () => {
      unregister();
      window.removeEventListener('resize', sync);
    };
  }, []);
  // React re-renders reuse one virtualizer instance. Patch resizeItem exactly
  // once instead of wrapping the previous wrapper again on every render.
  const patchedVirtualizer = useRef<TranscriptVirtualizer | null>(null);
  // Streaming rows whose shorter reflow is held at their tallest slot.
  const heldShrinks = useRef<HeldRowShrinks | null>(null);
  heldShrinks.current ??= createHeldRowShrinks();
  const held = heldShrinks.current;
  // A held row that stopped streaming may never be observed again if its box
  // no longer changes: its real size lands in the commit that ends it. The
  // reader's release and the measurement snapshot land holds imperatively
  // (settleHeldShrinks), without waiting for a render.
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
    // The core reads scrollHeight/clientHeight here, and setOptions asks it
    // (isAtEnd) during every render that changes the row count: a forced
    // layout inside render while the transcript grows. The committed spacer
    // height and the observed viewport height give the same answer.
    (virtualizer as unknown as { getMaxScrollOffset(): number }).getMaxScrollOffset = maxScrollTop;
    virtualizer.resizeItem = (index, size) => {
      const element = viewport.current;
      const measured = virtualizer.measurementsCache[index];
      // Reader gesture + row fully above the reading offset: DEFER. Never
      // drop — a dropped delta leaves the reader displaced by exactly that
      // delta once the geometry it saw is recomputed.
      // Rows above a held reading anchor are never deferred: the anchor's
      // relative re-apply compensates them in the same pre-paint write, and a
      // deferred one would draw over the reader until motion stops.
      const anchoredAbove = readingAnchorHeld() && index < (anchorHold.current?.index ?? -1);
      if (
        measured &&
        !anchoredAbove &&
        shouldDeferTranscriptScrollAdjustment(hasScrollGestureRef.current()) &&
        // Its NEW box must stay above the visible top too: a deferred row
        // that already reaches into view is drawn over the reader's rows at
        // its stale slot, and a landing then anchors on stale geometry.
        measured.start + size <= visibleTop(virtualizer)
      ) {
        pendingResizes.current.set(measured.key, { index, size });
        scheduleResizeFlush();
        return;
      }
      pendingResizes.current.delete(measured?.key ?? index);
      const previous = measured ? (virtualizer.itemSizeCache.get(measured.key) ?? measured.size) : undefined;
      // A followed streaming row's momentary reflow dip keeps its slot.
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
        const view = element.getBoundingClientRect();
        resizePinned.current = [...element.querySelectorAll<HTMLElement>('.transcript-virtual-row')]
          .filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.bottom > view.top && rect.top < view.bottom;
          })
          .map((row) => Number(row.dataset.index))
          .filter(Number.isFinite);
        if (resizePinFrame.current) window.cancelAnimationFrame(resizePinFrame.current);
        resizePinFrame.current = window.requestAnimationFrame(() => {
          resizePinFrame.current = window.requestAnimationFrame(() => {
            resizePinFrame.current = 0;
            resizePinned.current = [];
          });
        });
      }
      resizeItem(index, size);
      // A pending row's learned estimate may have replaced `size` (provisional
      // resize): only an observed slot may later be held.
      if (measured) held.measured(virtualizer, measured.key, size);
      if (virtualizer.options.followOnAppend || virtualizer.options.anchorTo === 'end') {
        endPin.request();
      } else if (anchoredAbove) {
        // Late sizes of landed rows: one coalesced re-apply per delivery.
        queueAnchorRestore();
      }
    };
  }
  // Rows measured above the reading offset keep the reader's content still.
  // During wheel/touch/scrollbar motion a row that stays wholly above the
  // viewport is deferred instead (resizeItem above): its correction would add
  // to Chromium's wheel ramp and briefly reverse the visible direction near
  // the history boundary. Only a row whose new box reaches into view is
  // corrected mid-motion. The follow hook tracks only non-programmatic reader
  // motion, so virtual-core's own corrective scroll does not block the next
  // idle measurement in a settling burst.
  // The end-anchor (wasAtEnd) total-size delta bypasses this predicate by
  // design. The vendored core also consulted a shouldDeferScrollAdjustment
  // hook to hold THAT write until motion was idle; upstream virtual-core has
  // no such hook and never reads it, so only the core's own isScrolling
  // deferral guards the bottom pin now. Watch for the "tears and snaps back at
  // the bottom" symptom if the end anchor starts fighting a live wheel ramp.
  // A row set in flight or a held reading anchor resolves every size above
  // the reader in one absolute write instead (see restoreReadingAnchor).
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (widthSyncing.current) return false;
    if (instance.options.anchorTo !== 'end') {
      if (pendingAnchor.current) return false;
      if (readingAnchorHeld() && item.index < (anchorHold.current?.index ?? -1)) return false;
    }
    // A size deferred while its row was above the reader grows upward wherever
    // the row is when it lands. An upward fling carries a short row from
    // wholly above to wholly in view between two frames (an Android fling
    // moves 100+ px a frame), so the row is often already below the visible
    // top when the pump applies it. Left uncompensated there, every row under
    // it jumped by the row's estimate error against the fling (Android: 위로
    // 스크롤하면 턱턱 막히거나 튄다).
    if (applyingDeferred.current) return true;
    // A row wholly above the visible top keeps the reader's content still.
    // During reader motion such a row only gets here once its new box
    // reaches into view (smaller changes are deferred above); left
    // uncompensated it was drawn over the rows the reader is looking at.
    const top = visibleTop(instance);
    if (item.end <= top) return true;
    // A row crossing the visible top grows upward instead when the size is
    // its FIRST measurement (mounted at the estimate while scrolling toward
    // older rows): uncompensated, the rows in view jumped by the difference
    // (18/40 px and more) against the finger.
    return item.start < top && !instance.itemSizeCache.has(item.key);
  };
  return { settleHeldShrinks };
}
