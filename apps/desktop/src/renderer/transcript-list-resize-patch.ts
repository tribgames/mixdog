import type { MutableRefObject } from 'react';
import { useRef } from 'react';
import type { createTranscriptEndPin } from './transcript-end-pin';
import {
  shouldDeferTranscriptScrollAdjustment,
  type TranscriptVirtualizer,
  viewportSize,
} from './transcript-list-geometry';
import type { useReadingAnchor } from './transcript-list-reading-anchor';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

type ReadingAnchorState = ReturnType<typeof useReadingAnchor>;

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
}) {
  // React re-renders reuse one virtualizer instance. Patch resizeItem exactly
  // once instead of wrapping the previous wrapper again on every render.
  const patchedVirtualizer = useRef<TranscriptVirtualizer | null>(null);
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
    if (instance.options.anchorTo !== 'end') {
      if (pendingAnchor.current) return false;
      if (readingAnchorHeld() && item.index < (anchorHold.current?.index ?? -1)) return false;
    }
    // A row wholly above the visible top keeps the reader's content still.
    // During reader motion such a row only gets here once its new box
    // reaches into view (smaller changes are deferred above); left
    // uncompensated it was drawn over the rows the reader is looking at.
    const top = visibleTop(instance);
    if (item.end <= top) return true;
    // A row crossing the visible top grows upward instead when the size is
    // its FIRST measurement (mounted at the estimate while scrolling toward
    // older rows) or was deferred while it was out of view: uncompensated,
    // the rows in view jumped by the difference (18/40 px and more) against
    // the finger.
    return item.start < top && (applyingDeferred.current || !instance.itemSizeCache.has(item.key));
  };
}
