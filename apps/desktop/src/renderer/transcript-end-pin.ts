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
  getScrollTop,
  hasReaderGesture,
  markProgrammaticScroll,
}: {
  getVirtualizer(): Virtualizer<HTMLDivElement, HTMLDivElement>;
  getViewport(): HTMLDivElement | null;
  getSpacer(): HTMLDivElement | null;
  /** Largest offset of the committed geometry, derived from the virtual total
   *  size and the observed viewport height — never read back from layout. */
  getMaxScrollTop(): number;
  /** The viewport offset as last observed or written, or null if unknown. */
  getScrollTop(): number | null;
  hasReaderGesture(): boolean;
  markProgrammaticScroll(top: number, intended: number): void;
}) {
  let queued = false;
  let generation = 0;
  return {
    request() {
      if (queued || hasReaderGesture()) return;
      queued = true;
      const requestedGeneration = generation;
      queueMicrotask(() => {
        if (requestedGeneration !== generation) return;
        queued = false;
        if (hasReaderGesture()) return;
        const element = getViewport();
        if (!element?.isConnected) return;
        const instance = getVirtualizer();
        // Follow may have been released after the request but before this
        // microtask, even without a continuing native gesture.
        if (instance.options.anchorTo !== 'end' && !instance.options.followOnAppend) return;
        const spacer = getSpacer();
        if (spacer) spacer.style.height = `${instance.getTotalSize()}px`;
        // Reading scrollHeight right after that write forced a synchronous
        // layout of the whole list; the virtual geometry already knows it.
        const max = getMaxScrollTop();
        // Cancel stale core compensation as well as its pending native timer:
        // this write already includes every measured delta in the commit.
        const core = instance as unknown as {
          scrollOffset: number | null;
          scrollAdjustments: number;
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
        core.scrollOffset = max;
        // scrollHeight/scrollTop read back AFTER the write forces a synchronous
        // layout, so the probe only resolves its fields when diagnostics are on.
        // Writing scrollTop lays out too: a pin whose end is already held (a
        // second request in the same frame, a resize that left the end in
        // place) skips it.
        const diagnose = transcriptScrollDiagnosticsEnabled();
        const before = diagnose ? element.scrollTop : 0;
        const known = getScrollTop();
        if (known === null || Math.abs(known - max) >= 0.5) element.scrollTop = max;
        if (diagnose) {
          logTranscriptScroll('end-pin', {
            from: before,
            to: element.scrollTop,
            delta: element.scrollTop - before,
            total: instance.getTotalSize(),
            height: element.scrollHeight,
          });
        }
        markProgrammaticScroll(max, max);
      });
    },
    cancel() {
      generation += 1;
      queued = false;
    },
  };
}
