import { type MutableRefObject, useCallback, useRef } from 'react';
import {
  captureReadingAnchor,
  coreScrollState,
  logicalScrollOffset,
  READING_ANCHOR_HOLD_MAX_MS,
  READING_ANCHOR_HOLD_MS,
  type ReadingAnchor,
  type TranscriptVirtualizer,
  viewportSize,
} from './transcript-list-geometry';
import type { TouchScrollDeviation } from './transcript-list-touch-deviation';
import type { TranscriptRowModel } from './transcript-rows';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

/** Resolves this render's visible range at the offset the landing commit will
 *  restore, so rows landed above the anchor do not unmount the rows on screen. */
function resolveRangeAtAnchor(
  virtualizer: TranscriptVirtualizer,
  anchor: ReadingAnchor,
  indexForPendingKey: (key: unknown, hint: number) => number
) {
  const at = indexForPendingKey(anchor.key, anchor.index);
  if (at < 0 || at === anchor.index) return;
  virtualizer.getTotalSize();
  const start = virtualizer.measurementsCache[at]?.start;
  if (start !== undefined) coreScrollState(virtualizer).scrollOffset = Math.max(0, start - anchor.offset);
}

/** Keeps what a reader away from the end is reading still when the row set
 *  changes above it. The reading anchor is the first row under the viewport's
 *  top edge that the new row set still carries, with its offset in the
 *  viewport; it is taken before the new geometry resolves, restored in the
 *  commit, and held while the landed rows above it are measured. */
export function useReadingAnchor({
  rows,
  virtualizer,
  virtualizerRef,
  viewport,
  spacer,
  domTop,
  scrollInset,
  markProgrammaticScrollRef,
  maxScrollTop,
  noteScrollOffset,
  flushDeferredResizes,
  indexForPendingKey,
  deviation,
}: {
  rows: readonly TranscriptRowModel[];
  virtualizer: TranscriptVirtualizer;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  viewport: { readonly current: HTMLDivElement | null };
  spacer: MutableRefObject<HTMLDivElement | null>;
  domTop: MutableRefObject<number | null>;
  scrollInset: MutableRefObject<number>;
  markProgrammaticScrollRef: MutableRefObject<((top: number, intended?: number) => void) | undefined>;
  maxScrollTop: () => number;
  noteScrollOffset: MutableRefObject<(top: number) => void>;
  flushDeferredResizes: (only?: (index: number) => boolean) => void;
  indexForPendingKey: (key: unknown, hint: number) => number;
  deviation: TouchScrollDeviation;
}) {
  const writeReadingOffset = useCallback(
    (instance: TranscriptVirtualizer, target: number) => {
      const element = viewport.current;
      if (!element) return;
      if (spacer.current) spacer.current.style.height = `${instance.getTotalSize()}px`;
      const top = Math.max(0, Math.min(target, maxScrollTop()));
      const core = coreScrollState(instance);
      core.scrollAdjustments = 0;
      core.scrollOffset = top;
      if (deviation.hold(top)) {
        core._intendedScrollOffset = null;
      } else {
        deviation.drop();
        core._intendedScrollOffset = top;
        element.scrollTop = top;
        markProgrammaticScrollRef.current?.(top, target);
      }
      domTop.current = top;
      // flushSync cannot run inside a layout effect, so never a sync notify.
      core.notify(false);
    },
    [maxScrollTop, viewport, spacer, domTop, markProgrammaticScrollRef, deviation]
  );
  const laidOutRows = useRef(rows);
  const pendingAnchor = useRef<{ base: readonly TranscriptRowModel[]; anchor: ReadingAnchor | null } | null>(null);
  const anchorHold = useRef<(ReadingAnchor & { until: number; start: number | null; landedAt: number }) | null>(null);
  const anchorRestoreQueued = useRef(false);
  const readingAnchorHeld = useCallback(() => {
    const hold = anchorHold.current;
    if (!hold) return false;
    if (performance.now() > hold.until || virtualizerRef.current.options.anchorTo === 'end') {
      anchorHold.current = null;
      return false;
    }
    return true;
  }, [virtualizerRef]);
  const restoreReadingAnchor = useCallback(
    (landing = false) => {
      const hold = anchorHold.current;
      const instance = virtualizerRef.current;
      if (!hold || (landing ? instance.options.anchorTo === 'end' : !readingAnchorHeld())) return;
      const at = indexForPendingKey(hold.key, hold.index);
      if (at < 0) {
        anchorHold.current = null;
        return;
      }
      hold.index = at;
      flushDeferredResizes((index) => index < at);
      instance.getTotalSize();
      const start = instance.measurementsCache[at]?.start ?? 0;
      const reading = logicalScrollOffset(instance);
      let target = reading;
      if (landing || hold.start === null) target = start - hold.offset;
      else if (Math.abs(start - hold.start) >= 0.5) {
        target = reading + (start - hold.start);
        hold.until = Math.min(hold.landedAt + READING_ANCHOR_HOLD_MAX_MS, performance.now() + READING_ANCHOR_HOLD_MS);
      }
      hold.start = start;
      if (
        Math.abs(target - reading) < 0.5 &&
        (!landing || (domTop.current !== null && Math.abs(domTop.current - target) < 0.5))
      )
        return;
      if (transcriptScrollDiagnosticsEnabled()) {
        logTranscriptScroll('reading-anchor', { from: reading, to: target, index: at, start, landing });
      }
      writeReadingOffset(instance, target);
    },
    [flushDeferredResizes, indexForPendingKey, readingAnchorHeld, writeReadingOffset, virtualizerRef, domTop]
  );
  noteScrollOffset.current = (top: number) => {
    const hold = anchorHold.current;
    if (hold && hold.start !== null && domTop.current !== null && Math.abs(top - domTop.current) >= 1) {
      const offset = hold.start - top;
      const height = viewportSize(virtualizerRef.current);
      if (offset < -height || offset > 2 * height) anchorHold.current = null;
    }
    domTop.current = top;
  };
  const queueAnchorRestore = useCallback(() => {
    if (anchorRestoreQueued.current) return;
    anchorRestoreQueued.current = true;
    queueMicrotask(() => {
      anchorRestoreQueued.current = false;
      restoreReadingAnchor();
    });
  }, [restoreReadingAnchor]);
  if (rows === laidOutRows.current || virtualizer.options.anchorTo === 'end') {
    pendingAnchor.current = null;
  } else if (pendingAnchor.current?.base !== laidOutRows.current) {
    const anchor = captureReadingAnchor(virtualizer, laidOutRows.current, rows, scrollInset.current);
    pendingAnchor.current = { base: laidOutRows.current, anchor };
    if (anchor) resolveRangeAtAnchor(virtualizer, anchor, indexForPendingKey);
  }
  return { laidOutRows, pendingAnchor, anchorHold, readingAnchorHeld, restoreReadingAnchor, queueAnchorRestore };
}
