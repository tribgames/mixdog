import { type MutableRefObject, useCallback, useRef } from 'react';
import type { TranscriptVirtualizer } from './transcript-list-geometry';
import type { TranscriptRowModel } from './transcript-rows';

/** Sizes measured DURING a reader gesture for rows fully above the viewport
 *  are deferred here. Applying them mid-gesture shifts the whole timeline
 *  under the reader or competes with native touch motion. Applying them after
 *  the gesture lands the size and its scroll compensation in one pre-paint
 *  transaction instead. */
export function useDeferredResizes({
  rowsRef,
  hasScrollGestureRef,
  virtualizerRef,
  visibleTop,
}: {
  rowsRef: MutableRefObject<readonly TranscriptRowModel[]>;
  hasScrollGestureRef: MutableRefObject<() => boolean>;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  visibleTop: (instance: TranscriptVirtualizer) => number;
}) {
  const pendingResizes = useRef(new Map<unknown, { index: number; size: number }>());
  const resizeFlushFrame = useRef(0);
  const baseResizeItem = useRef<((index: number, size: number) => void) | null>(null);
  const indexForPendingKey = useCallback(
    (key: unknown, hint: number) => {
      if (rowsRef.current[hint]?.key === key) return hint;
      return rowsRef.current.findIndex((row) => row.key === key);
    },
    [rowsRef]
  );
  // A deferred size changed while its row was out of view: applied, it grows
  // upward from the viewport top (see shouldAdjustScrollPositionOnItemSizeChange).
  const applyingDeferred = useRef(false);
  const applyDeferred = useCallback((index: number, size: number) => {
    applyingDeferred.current = true;
    try {
      baseResizeItem.current?.(index, size);
    } finally {
      applyingDeferred.current = false;
    }
  }, []);
  const flushDeferredResizes = useCallback(
    (only?: (index: number) => boolean) => {
      const pending = pendingResizes.current;
      if (!baseResizeItem.current || pending.size === 0) return;
      pending.forEach((entry, key) => {
        const at = indexForPendingKey(key, entry.index);
        if (at >= 0 && only && !only(at)) return;
        pending.delete(key);
        if (at >= 0) applyDeferred(at, entry.size);
      });
    },
    [applyDeferred, indexForPendingKey]
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleTop is a per-render closure over refs only; adding it would recreate the rAF pump every render
  const pumpDeferredResizes = useCallback(() => {
    resizeFlushFrame.current = 0;
    const pending = pendingResizes.current;
    if (pending.size === 0) return;
    // Full flush waits for the gesture window AND the native ramp: the ramp
    // outlives the window, and sizes applied mid-ramp shift content before
    // the (deferred) compensation can land — flushing at true scroll idle
    // keeps size and compensation in one pre-paint transaction.
    if (!hasScrollGestureRef.current() && !virtualizerRef.current.isScrolling) {
      flushDeferredResizes();
      return;
    }
    // A pending row the reader scrolled back INTO must not keep painting at
    // stale geometry. It is no longer fully above the offset, so the resize
    // applies without a compensation write and cannot reverse the gesture.
    const instance = virtualizerRef.current;
    const offset = visibleTop(instance);
    pending.forEach((entry, key) => {
      const at = indexForPendingKey(key, entry.index);
      if (at < 0) {
        pending.delete(key);
        return;
      }
      const measured = instance.measurementsCache[at];
      // Scrolled back into, or its new box reaches into view.
      if (measured && (measured.end > offset || measured.start + entry.size > offset)) {
        pending.delete(key);
        applyDeferred(at, entry.size);
      }
    });
    if (pending.size > 0) {
      resizeFlushFrame.current = window.requestAnimationFrame(pumpDeferredResizes);
    }
  }, [applyDeferred, flushDeferredResizes, indexForPendingKey]);
  const scheduleResizeFlush = useCallback(() => {
    if (resizeFlushFrame.current) return;
    resizeFlushFrame.current = window.requestAnimationFrame(pumpDeferredResizes);
  }, [pumpDeferredResizes]);
  return {
    pendingResizes,
    resizeFlushFrame,
    baseResizeItem,
    applyingDeferred,
    indexForPendingKey,
    flushDeferredResizes,
    scheduleResizeFlush,
  };
}
