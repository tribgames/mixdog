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

/** Older history paged in above a reader who scrolled up must not move what
 *  they read. Compensating size deltas failed whenever a row above changed
 *  identity: a page that supplies a reply folds its "Worked for…" row into
 *  it, a cut tool group or mid-turn window re-keys its head. The reading
 *  ANCHOR is instead the first row under the viewport's top edge that the
 *  new row set still carries (else the next one that does) and its offset in
 *  the viewport. It is taken before the new geometry resolves, restored in
 *  the commit, and held while the landed rows above it are measured, until
 *  the reader scrolls. */
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
  // One pre-paint write of a corrected reading offset. The spacer grows FIRST:
  // virtualizer.scrollToOffset clamped the target against the previous
  // scrollHeight, and older pages then dropped the reader a whole page.
  // During a wheel ramp or a touch fling a page landing and the late sizes of
  // landed rows are held as a row offset, and one settle write lands after
  // the scroll stops (see transcript-list-touch-deviation), never under the
  // fling's momentum, at native 0 included.
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
      // The range on screen was resolved at the previous offset. Never a sync
      // notify: flushSync cannot run inside a layout effect.
      core.notify(false);
    },
    [maxScrollTop, viewport, spacer, domTop, markProgrammaticScrollRef, deviation]
  );
  const laidOutRows = useRef(rows);
  const pendingAnchor = useRef<{ base: readonly TranscriptRowModel[]; anchor: ReadingAnchor | null } | null>(null);
  // `start`: where the anchor sat when last applied. `landedAt` bounds how
  // long late sizes may extend the hold.
  const anchorHold = useRef<(ReadingAnchor & { until: number; start: number | null; landedAt: number }) | null>(null);
  const anchorRestoreQueued = useRef(false);
  // The hold is NOT a reader-gesture decision. A page lands when the reader
  // reaches the top — inside the wheel/touch window by construction — and the
  // landed rows (lazy Markdown above all) keep growing for frames after it.
  // Releasing on the gesture left the row just above the anchor, which still
  // intersects the viewport top and so is never deferred, free to push the
  // reader down by its full growth (+2.7k px on desktop, the phone reader
  // at scrollTop 0 lost to a screen of older rows).
  const readingAnchorHeld = useCallback(() => {
    const hold = anchorHold.current;
    if (!hold) return false;
    if (performance.now() > hold.until || virtualizerRef.current.options.anchorTo === 'end') {
      anchorHold.current = null;
      return false;
    }
    return true;
  }, [virtualizerRef]);
  // `landing` (the commit that changed the rows): restore the anchor's
  // recorded viewport offset, whatever the reader is doing — skipping it drops
  // the reader by the whole page. Afterwards only the anchor's own movement is
  // applied, RELATIVE to the live offset, so reader motion between two writes
  // (a wheel ramp, a fling) is never rolled back.
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
      // Sizes deferred for rows above the anchor belong to this write.
      flushDeferredResizes((index) => index < at);
      instance.getTotalSize();
      const start = instance.measurementsCache[at]?.start ?? 0;
      const reading = logicalScrollOffset(instance);
      let target = reading;
      if (landing || hold.start === null) target = start - hold.offset;
      else if (Math.abs(start - hold.start) >= 0.5) {
        target = reading + (start - hold.start);
        // Sizes still arriving: stay held a little longer, within a bound.
        hold.until = Math.min(hold.landedAt + READING_ANCHOR_HOLD_MAX_MS, performance.now() + READING_ANCHOR_HOLD_MS);
      }
      hold.start = start;
      // A landing's render already resolved the core at this offset (see the
      // capture below); the native offset still has to follow, unless it is
      // already there: every rows commit under a hold restores as a landing,
      // and rewriting the same scrollTop forced a layout in each (49 on a
      // phone resuming mid-reply).
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
    // The held anchor is applied relative to the reader's offset, so reader
    // motion never fights it; it only ends once the reader has left it a
    // viewport behind, where it no longer describes what they read.
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
    // Before this render resolves the new geometry: the cache still
    // describes the rows on screen.
    const anchor = captureReadingAnchor(virtualizer, laidOutRows.current, rows, scrollInset.current);
    pendingAnchor.current = { base: laidOutRows.current, anchor };
    // Rows landed above the anchor: this render's range resolves at the
    // offset the landing commit restores (restoreReadingAnchor, the same
    // `start - offset`). Resolved at the pre-landing offset, its indexes named
    // the page's oldest rows: the commit unmounted every row on screen,
    // mounted rows nobody saw, and the restore rebuilt the reader's rows from
    // scratch in the same task (a phone: two full row sets per page, most of
    // an upward fling's 200-300 ms landing task). The restore still writes
    // the native offset; its re-render then finds the same rows mounted.
    if (anchor) {
      const at = indexForPendingKey(anchor.key, anchor.index);
      if (at >= 0 && at !== anchor.index) {
        virtualizer.getTotalSize();
        const start = virtualizer.measurementsCache[at]?.start;
        if (start !== undefined) coreScrollState(virtualizer).scrollOffset = Math.max(0, start - anchor.offset);
      }
    }
  }
  return { laidOutRows, pendingAnchor, anchorHold, readingAnchorHeld, restoreReadingAnchor, queueAnchorRestore };
}
