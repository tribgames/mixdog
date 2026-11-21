import {
  defaultRangeExtractor,
  elementScroll,
  observeElementRect,
  useVirtualizer,
  type VirtualItem,
  type VirtualizerOptions,
} from '@tanstack/react-virtual';
import { type MutableRefObject, type RefObject, useMemo, useRef } from 'react';
import { holdsWaitingAskUser } from './ask-user-record';
import { useTranscriptRowEstimates } from './transcript-list-estimates';
import { coreScrollState, SCROLL_END_THRESHOLD_PX, type TranscriptVirtualizer } from './transcript-list-geometry';
import { useProvisionalRowResize } from './transcript-list-provisional-resize';
import type { TouchScrollDeviation } from './transcript-list-touch-deviation';
import type { TranscriptRowSurface } from './transcript-row-estimates';
import type { TranscriptRowModel } from './transcript-rows';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import { TRANSCRIPT_BOTTOM_SPACER, TRANSCRIPT_VIRTUAL_OVERSCAN } from './transcript-virtual-cache';

type TranscriptVirtualizerOptions = VirtualizerOptions<HTMLDivElement, HTMLDivElement>;

export function useActiveRowIndexes(rows: readonly TranscriptRowModel[]) {
  const activeIndexesRef = useRef<number[]>([]);
  const activeIndexes = useMemo(() => {
    const held: number[] = [];
    rows.forEach((row, index) => {
      if (('active' in row && row.active) || (row._tag === 'ToolActivity' && row.items.some(holdsWaitingAskUser))) {
        held.push(index);
      }
    });
    return held;
  }, [rows]);
  activeIndexesRef.current = activeIndexes;
  return activeIndexesRef;
}

/** The transcript's virtual-core instance: its row-size model (learned
 *  estimates, provisional sizes for rows still parsing) and the options that
 *  bind it to the DOM — range pinning, end anchoring, direct pre-paint
 *  geometry commits, and the scroll offset observer/writer this list owns. */
export function useTranscriptVirtualizer({
  count,
  viewport,
  spacer,
  rowsRef,
  hasScrollGestureRef,
  resizePinned,
  selectionPinnedIndexes,
  activeIndexesRef,
  shouldAnchorBottom,
  initialMeasurements,
  requestEndPin,
  noteScrollOffset,
  domTop,
  markProgrammaticScrollRef,
  deviation,
  surfaceRef,
}: {
  surfaceRef: MutableRefObject<TranscriptRowSurface>;
  count: number;
  viewport: RefObject<HTMLDivElement | null>;
  spacer: RefObject<HTMLDivElement | null>;
  rowsRef: MutableRefObject<readonly TranscriptRowModel[]>;
  hasScrollGestureRef: MutableRefObject<() => boolean>;
  resizePinned: MutableRefObject<number[]>;
  selectionPinnedIndexes: () => number[];
  activeIndexesRef: MutableRefObject<number[]>;
  shouldAnchorBottom: boolean;
  initialMeasurements: VirtualItem[] | undefined;
  requestEndPin: () => void;
  noteScrollOffset: MutableRefObject<(top: number) => void>;
  domTop: MutableRefObject<number | null>;
  markProgrammaticScrollRef: MutableRefObject<((top: number, intended?: number) => void) | undefined>;
  deviation: TouchScrollDeviation;
}) {
  const {
    timelineWidth,
    virtualizerRefForEstimates,
    endPinForEstimates,
    heldEstimates,
    fallbackEstimates,
    relearnFrame,
    estimateRow,
    measureRowSize,
  } = useTranscriptRowEstimates({ rowsRef, viewport, hasScrollGestureRef, surfaceRef });
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => viewport.current,
    estimateSize: estimateRow,
    getItemKey: (index) => rowsRef.current[index]?.key ?? `row:${index}`,
    measureElement: measureRowSize,
    overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor({ ...range, overscan: TRANSCRIPT_VIRTUAL_OVERSCAN });
      return [
        ...new Set([...resizePinned.current, ...selectionPinnedIndexes(), ...indexes, ...activeIndexesRef.current]),
      ]
        .filter((index) => index >= 0 && index < count)
        .sort((a, b) => a - b);
    },
    initialOffset: () => (shouldAnchorBottom ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: initialMeasurements,
    // Reader intent wins immediately. Keeping end anchoring active inside the
    // 80px return band let a small upward wheel move get reversed by the next
    // append or row measurement even after the follow hook had detached.
    anchorTo: shouldAnchorBottom ? 'end' : 'start',
    followOnAppend: shouldAnchorBottom,
    // While the tail is owned, every append and measured-size delta is an
    // end pin. An 80px band lost tall rows in a short split and invited a
    // second scrollToEnd writer. Reader release flips followOnAppend off.
    scrollEndThreshold: SCROLL_END_THRESHOLD_PX,
    // The one tail gap: the dock is a layout sibling below the viewport, so
    // no chrome clearance belongs to the scroll content.
    paddingEnd: TRANSCRIPT_BOTTOM_SPACER,
    // React's async rerender lets the core move scrollTop pre-paint while rows
    // still paint at their previous position; direct DOM updates write row
    // positions inside the core transaction.
    directDomUpdates: true,
    // react-virtual's default flushSync reconciles the whole list inside the
    // scroll event.
    useFlushSync: false,
    // Transform mode gives each row its own compositor layer, which Chromium can
    // present from different scroll phases (a horizontal tear).
    directDomUpdatesMode: 'position',
    // The viewport and the rows share one geometry owner. Request the pin
    // AFTER the core accepts the new height, including its first observation;
    // a separate observer could read the previous height and skip the pin.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        const previous = instance.scrollRect?.height;
        if (rect.width > 0) timelineWidth.current = rect.width;
        cb(rect);
        if (rect.height !== previous) requestEndPin();
      }),
    observeElementOffset: observeTranscriptOffset(noteScrollOffset, domTop, deviation),
    scrollToFn: transcriptScrollTo({ viewport, spacer, domTop, markProgrammaticScrollRef, requestEndPin, deviation }),
  });
  if (!handedOver.has(virtualizer)) handOverIOSDeferral(virtualizer);
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  virtualizerRefForEstimates.current = virtualizer;
  // Wrapped before the resize patch captures resizeItem.
  const provisionalFrame = useProvisionalRowResize({ virtualizer, virtualizerRef, heldEstimates, fallbackEstimates });
  endPinForEstimates.current = requestEndPin;
  return { virtualizer, virtualizerRef, relearnFrame, provisionalFrame };
}

const handedOver = new WeakSet<TranscriptVirtualizer>();

/** On iOS WebKit virtual-core defers scroll corrections into its own account
 *  and writes the sum once scrolling settles. This hands every correction to the
 *  list's scroll writer at once, as the core does off iOS. `applyScrollAdjustment`
 *  and `_iosDeferredAdjustment` are virtual-core 3.17.4 internals (pinned in
 *  package.json; transcript-ios-touch-hold.test.mjs fails if the core stops
 *  using them). */
export function handOverIOSDeferral(instance: TranscriptVirtualizer): void {
  handedOver.add(instance);
  const core = coreScrollState(instance) as ReturnType<typeof coreScrollState> & {
    getScrollOffset(): number;
    _scrollToOffset(offset: number, options: { adjustments?: number; behavior?: ScrollBehavior }): void;
    applyScrollAdjustment(delta: number, behavior?: ScrollBehavior): void;
  };
  core.applyScrollAdjustment = (delta, behavior) => {
    if (delta === 0) return;
    core.scrollAdjustments += delta;
    core._scrollToOffset(core.getScrollOffset(), { adjustments: core.scrollAdjustments, behavior });
    if (core.scrollOffset !== null) {
      core.scrollOffset += core.scrollAdjustments;
      core.scrollAdjustments = 0;
    }
  };
  // Only the prepend's anchor sync still reaches the account.
  Object.defineProperty(instance, '_iosDeferredAdjustment', {
    configurable: true,
    get: () => 0,
    set: (anchorDelta: number) => {
      if (!anchorDelta) return;
      core._scrollToOffset(core.getScrollOffset() - anchorDelta, { adjustments: anchorDelta });
    },
  });
}

/** virtual-core's own offset observer reports the offset its last scroll event
 *  read once scrolling idles, overwriting writes made in between; this idle
 *  report carries the offset as last observed or written. */
function observeTranscriptOffset(
  noteScrollOffset: MutableRefObject<(top: number) => void>,
  domTop: MutableRefObject<number | null>,
  deviation: TouchScrollDeviation
): TranscriptVirtualizerOptions['observeElementOffset'] {
  return (instance, cb) => {
    const element = instance.scrollElement;
    if (!element) return undefined;
    let idle = 0;
    const onScroll = () => {
      // A touch hold whose logical offset reached the real top lands first
      // (see transcript-list-touch-deviation), so this read sees the landed offset.
      deviation.landAtEdge();
      // The one offset read per scroll event. A correction held during a
      // wheel ramp or a touch fling shifts the rows, so the logical offset
      // carries it.
      const top = element.scrollTop + deviation.amount();
      noteScrollOffset.current(top);
      cb(top, true);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => cb(domTop.current ?? top, false), instance.options.isScrollingResetDelay);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      window.clearTimeout(idle);
    };
  };
}

/** Grow the spacer before a programmatic write so Chrome cannot clamp the
 *  requested offset against the previous total height. */
function transcriptScrollTo({
  viewport,
  spacer,
  domTop,
  markProgrammaticScrollRef,
  requestEndPin,
  deviation,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  spacer: RefObject<HTMLDivElement | null>;
  domTop: MutableRefObject<number | null>;
  markProgrammaticScrollRef: MutableRefObject<((top: number, intended?: number) => void) | undefined>;
  requestEndPin: () => void;
  deviation: TouchScrollDeviation;
}): TranscriptVirtualizerOptions['scrollToFn'] {
  return (offset, options, instance: TranscriptVirtualizer) => {
    if (instance.options.anchorTo === 'end' || instance.options.followOnAppend) {
      // Core measurements can request several opposing offsets while the
      // prompt/Goal/diff commit is still changing geometry. They share the
      // final native pin, never an intermediate elementScroll followed by
      // another corrective write.
      requestEndPin();
      return;
    }
    if (spacer.current) spacer.current.style.height = `${instance.getTotalSize()}px`;
    const intended = offset + (options?.adjustments ?? 0);
    // A measured-size correction during a wheel ramp or a touch scroll moves
    // the rows, never the native offset (see transcript-list-touch-deviation).
    // Navigation writes carry no adjustment and always land natively.
    if (options?.adjustments && options.behavior !== 'smooth' && deviation.hold(intended)) {
      coreScrollState(instance)._intendedScrollOffset = null;
      domTop.current = intended;
      if (transcriptScrollDiagnosticsEnabled()) {
        logTranscriptScroll('touch-hold', { offset, adjust: options.adjustments, held: deviation.amount() });
      }
      return;
    }
    deviation.drop();
    const diagnose = transcriptScrollDiagnosticsEnabled();
    const beforeCoreWrite = diagnose ? (viewport.current?.scrollTop ?? 0) : 0;
    elementScroll(offset, options, instance);
    if (diagnose) {
      logTranscriptScroll('core-scroll', {
        offset,
        adjust: options?.adjustments ?? 0,
        from: beforeCoreWrite,
        to: viewport.current?.scrollTop ?? 0,
      });
    }
    const element = viewport.current;
    // The write above already laid out; this read is free.
    const landed = element ? element.scrollTop : intended;
    domTop.current = landed;
    markProgrammaticScrollRef.current?.(landed, intended);
  };
}
