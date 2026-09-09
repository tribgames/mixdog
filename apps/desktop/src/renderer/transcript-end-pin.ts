import type { Virtualizer } from "@tanstack/react-virtual";

/** Coalesce append, row measurement, and composer resize into one native end.
 * Intermediate core offsets are estimates of different stages of the same
 * commit; exposing them to Chromium can reverse scrolling before paint. */
export function createTranscriptEndPin({
  getVirtualizer,
  getViewport,
  getSpacer,
  hasReaderGesture,
  markProgrammaticScroll,
}: {
  getVirtualizer(): Virtualizer<HTMLDivElement, HTMLDivElement>;
  getViewport(): HTMLDivElement | null;
  getSpacer(): HTMLDivElement | null;
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
        if (instance.options.anchorTo !== "end" && !instance.options.followOnAppend) return;
        const spacer = getSpacer();
        if (spacer) spacer.style.height = `${instance.getTotalSize()}px`;
        const max = Math.max(0, element.scrollHeight - element.clientHeight);
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
        if (Math.abs(element.scrollTop - max) >= 1) element.scrollTop = max;
        markProgrammaticScroll(element.scrollTop, max);
      });
    },
    cancel() {
      generation += 1;
      queued = false;
    },
  };
}
