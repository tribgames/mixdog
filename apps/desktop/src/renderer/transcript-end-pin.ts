import type { Virtualizer } from '@tanstack/react-virtual';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';

type VirtualizerCore = {
  scrollOffset: number | null;
  scrollAdjustments: number;
  _intendedScrollOffset: number | null;
  _iosDeferredAdjustment: number;
  _deferredFlushTimerId: number | null;
  targetWindow: (Window & typeof globalThis) | null;
};

/** The pin's write already includes every measured delta in the commit, so the
 *  core's pending compensation and its native timer are stale. */
function dropCoreCompensation(instance: Virtualizer<HTMLDivElement, HTMLDivElement>): VirtualizerCore {
  const core = instance as unknown as VirtualizerCore;
  if (core._deferredFlushTimerId != null && core.targetWindow) {
    core.targetWindow.clearTimeout(core._deferredFlushTimerId);
    core._deferredFlushTimerId = null;
  }
  core._iosDeferredAdjustment = 0;
  core.scrollAdjustments = 0;
  return core;
}
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
  noteOffset,
  dropDeviation,
}: {
  getVirtualizer(): Virtualizer<HTMLDivElement, HTMLDivElement>;
  getViewport(): HTMLDivElement | null;
  getSpacer(): HTMLDivElement | null;
  /** Largest offset of the committed geometry, derived from the virtual total
   *  size and the observed viewport height — never read back from layout. */
  getMaxScrollTop(): number;
  hasReaderGesture(): boolean;
  /** A write moved the offset: the scroll event it makes is the pin's. */
  markProgrammaticScroll(top: number, intended: number): void;
  /** Where every pin, a write or none, leaves the offset. */
  noteOffset?(top: number): void;
  /** The end is a native offset: a row offset held from a touch scroll ends
   *  with this write. */
  dropDeviation?(): void;
}) {
  let queued = false;
  let generation = 0;
  let idleFrame = 0;
  let lastTarget: number | null = null;
  const AT_BOTTOM_EPSILON = 2;
  const write = () => {
    queued = false;
    const element = getViewport();
    if (!element?.isConnected) return;
    const instance = getVirtualizer();
    // Follow may have been released after the request but before this
    // write, even without a continuing native gesture.
    if (instance.options.anchorTo !== 'end' && !instance.options.followOnAppend) {
      lastTarget = null;
      return;
    }
    // Defer only while the reader is actively gesturing away from the bottom;
    // passive pointer or at-bottom wheel activity must not stall end-pinning.
    const previousTarget = getMaxScrollTop();
    const referenceBottom = lastTarget === null ? previousTarget : Math.min(lastTarget, previousTarget);
    if (hasReaderGesture() && element.scrollTop < referenceBottom - AT_BOTTOM_EPSILON) {
      if (!idleFrame && instance.targetWindow) {
        const requestedGeneration = generation;
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
    const target = getMaxScrollTop();
    lastTarget = target;
    const core = dropCoreCompensation(instance);
    // Chromium clamps scrollTop before delivering its scroll event when a replacement shrinks the spacer,
    // so the cached offset can still equal the target: read the actual offset after committing the spacer.
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
    noteOffset?.(landed);
    // A pin that moved nothing makes no scroll event: there is no write to record.
    if (landed !== before) markProgrammaticScroll(landed, target);
  };
  const pin = {
    request() {
      if (queued) return;
      queued = true;
      const requestedGeneration = generation;
      queueMicrotask(() => {
        if (requestedGeneration === generation && queued) write();
      });
    },
    /** Pins in the caller's task: a resize observer's pass lands the end before the frame paints. */
    now() {
      write();
    },
    cancel() {
      generation += 1;
      queued = false;
      lastTarget = null;
      if (idleFrame) getVirtualizer().targetWindow?.cancelAnimationFrame(idleFrame);
      idleFrame = 0;
    },
  };
  return pin;
}
