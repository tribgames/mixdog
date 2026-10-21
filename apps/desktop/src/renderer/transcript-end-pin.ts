import type { Virtualizer } from '@tanstack/react-virtual';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

/** Coalesce append, row measurement, and composer resize into one native end.
 * Intermediate core offsets are estimates of different stages of the same
 * commit; exposing them to Chromium can reverse scrolling before paint. */
export function createTranscriptEndPin({
  getVirtualizer,
  getViewport,
  getSpacer,
  getMaxScrollTop,
  hasReaderGesture,
  markProgrammaticScroll,
  dropDeviation,
  takeArrival,
  onArrival,
}: {
  getVirtualizer(): Virtualizer<HTMLDivElement, HTMLDivElement>;
  getViewport(): HTMLDivElement | null;
  getSpacer(): HTMLDivElement | null;
  /** Largest offset of the committed geometry, derived from the virtual total
   *  size and the observed viewport height — never read back from layout. */
  getMaxScrollTop(): number;
  hasReaderGesture(): boolean;
  markProgrammaticScroll(top: number, intended: number): void;
  /** The end is a native offset: a row offset held from a touch scroll ends
   *  with this write. */
  dropDeviation?(): void;
  /** Where the pin lands instead of `max` (a long reply that arrived whole:
   *  its first line), or null for the end. */
  takeArrival?(max: number): number | null;
  /** Called in the same task after a pin landed on `takeArrival`'s offset:
   *  follow lets go there. */
  onArrival?(): void;
}) {
  let queued = false;
  let generation = 0;
  let idleFrame = 0;
  const pin = {
    request() {
      if (queued) return;
      queued = true;
      const requestedGeneration = generation;
      queueMicrotask(() => {
        if (requestedGeneration !== generation) return;
        queued = false;
        const element = getViewport();
        if (!element?.isConnected) return;
        const instance = getVirtualizer();
        // Follow may have been released after the request but before this
        // microtask, even without a continuing native gesture.
        if (instance.options.anchorTo !== 'end' && !instance.options.followOnAppend) return;
        // A height change during a downward wheel/touch must survive the
        // gesture. Dropping it left the tail detached until another mutation.
        if (hasReaderGesture()) {
          if (!idleFrame && instance.targetWindow) {
            idleFrame = instance.targetWindow.requestAnimationFrame(() => {
              idleFrame = 0;
              if (requestedGeneration === generation) pin.request();
            });
          }
          return;
        }
        const spacer = getSpacer();
        if (spacer) spacer.style.height = `${instance.getTotalSize()}px`;
        // Reading scrollHeight right after that write forced a synchronous
        // layout of the whole list; the virtual geometry already knows it.
        const max = getMaxScrollTop();
        const arrival = takeArrival?.(max) ?? null;
        const target = arrival ?? max;
        // Cancel stale core compensation as well as its pending native timer:
        // this write already includes every measured delta in the commit.
        const core = instance as unknown as {
          scrollOffset: number | null;
          scrollAdjustments: number;
          _intendedScrollOffset: number | null;
          _iosDeferredAdjustment: number;
          _deferredFlushTimerId: number | null;
          targetWindow: (Window & typeof globalThis) | null;
        };
        if (core._deferredFlushTimerId != null && core.targetWindow) {
          core.targetWindow.clearTimeout(core._deferredFlushTimerId);
          core._deferredFlushTimerId = null;
        }
        core._iosDeferredAdjustment = 0;
        core.scrollAdjustments = 0;
        // A replacement can briefly shrink the spacer and Chromium clamps
        // scrollTop before delivering its scroll event. The cached offset
        // still equals `max` then: skipping the write loses the tail. Read the
        // actual offset once per coalesced pin, after committing the spacer.
        const diagnose = transcriptScrollDiagnosticsEnabled();
        dropDeviation?.();
        const before = element.scrollTop;
        if (Math.abs(before - target) >= 0.5) element.scrollTop = target;
        const landed = element.scrollTop;
        core.scrollOffset = landed;
        core._intendedScrollOffset = landed;
        if (diagnose) {
          logTranscriptScroll('end-pin', {
            from: before,
            to: landed,
            delta: landed - before,
            total: instance.getTotalSize(),
            height: element.scrollHeight,
          });
        }
        markProgrammaticScroll(landed, target);
        if (arrival !== null) onArrival?.();
      });
    },
    cancel() {
      generation += 1;
      queued = false;
      if (idleFrame) getVirtualizer().targetWindow?.cancelAnimationFrame(idleFrame);
      idleFrame = 0;
    },
  };
  return pin;
}
