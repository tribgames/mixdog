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

/** The live row's index, and any row holding a question that waits for its
 *  answer (its card keeps its picks), stay in the
 *  rendered range however far the reader scrolls away (see rangeExtractor). */
export function useActiveRowIndexes(rows: readonly TranscriptRowModel[]) {
  const activeIndexesRef = useRef<number[]>([]);
  const activeIndexes = useMemo(() => {
    let live = -1;
    const held: number[] = [];
    rows.forEach((row, index) => {
      if ('active' in row && row.active) live = index;
      if (row._tag === 'ToolActivity' && row.items.some(holdsWaitingAskUser)) held.push(index);
    });
    return live < 0 || held.includes(live) ? held : [...held, live].sort((a, b) => a - b);
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
    // The virtual core commits its state to the DOM in the same task as every
    // notify. React's default async rerender let the core
    // move scrollTop pre-paint while rows still painted at their previous
    // translateY — the width-drag shake/ghosting. Direct DOM updates restore
    // that commit timing: row transforms and the container height are
    // written inside the core transaction, and React reconciles on range
    // changes only. Every React commit (including a web snapshot that mounts
    // new rows) re-applies positions in a layout effect, so no row paints
    // unpositioned. The web browser renderer uses this path too: React-owned
    // positions there moved scrollTop synchronously while rows kept their
    // stale top until the async rerender, so every row measurement painted
    // one shifted frame (user: 웹앱에서 트랜스크립트가 튄다).
    directDomUpdates: true,
    // A range change seen in a scroll event re-renders the list, but never
    // synchronously inside that event: react-virtual's default flushSync ran
    // the whole TranscriptList reconcile in the scroll event, ahead of the
    // frame the scroll belongs to — the largest script cost of every scroll on
    // a phone. Scroll-only updates never needed React at all (row positions
    // and the spacer are written directly), and the overscan keeps rows ready
    // beyond each edge, so the range render lands right after the frame as one
    // batched update while the compositor keeps scrolling.
    useFlushSync: false,
    // Keep every row in the transcript's ONE paint layer. Transform mode
    // promotes each row independently; when a deferred measurement and the
    // final native wheel frame land together at the bottom, Chromium can
    // present those compositor layers from different scroll phases and draw
    // the visible horizontal tear. Top-position writes still land in the same
    // direct pre-paint transaction, without per-row compositor surfaces.
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

/** On iOS WebKit virtual-core keeps every correction it makes while scrolling
 *  (a measured size above the reader, a prepend's anchor sync) in its own
 *  deferral account and writes the sum once the scroll settles. The rows
 *  above move meanwhile, so the reader's content shifts by the correction and
 *  back again at the write, and nothing lands at the top edge: a fling toward
 *  older history could stop at native 0 short of the corrected rows. This
 *  list owns that hold (scrollToFn → transcript-list-touch-deviation, landed
 *  early at the top edge), so every correction reaches the list's scroll
 *  writer at once, as the core writes it off iOS:
 *  - a measured size takes the core's off-iOS adjustment (its target and the
 *    core offset both move by the delta);
 *  - a prepend already moved the core offset by its anchor delta when the
 *    page rendered, so its sync writes that offset, never the delta again.
 *    The delta goes as the write's adjustment, so a touch fling holds it like
 *    any other correction.
 *  Both names are virtual-core 3.17.4 internals (pinned in package.json;
 *  transcript-ios-touch-hold.test.mjs fails if the core stops using them). */
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

/** virtual-core's own offset observer reports, once scrolling idles, the
 *  offset its LAST scroll event read (a debounced callback over a captured
 *  value). A write this list made in between — a landing's anchor restore,
 *  an end pin — was overwritten by that stale offset, and every later
 *  correction started from it: a page landing within ~150 ms of the last
 *  wheel event jumped the reader by the page a frame later, and a phone
 *  reader at scrollTop 0 was put back at 0 plus the page. The idle report
 *  carries the offset as last observed OR written. */
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
      // A touch hold reaching the top edge lands first (see
      // transcript-list-touch-deviation), so this read sees the landed offset.
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
    // Reading scrollTop right after the spacer write — and again after the
    // core write — forces a synchronous layout of the whole virtual list on
    // every programmatic scroll. Resolve those reads only when diagnostics
    // are on, so the probe keeps its "free while off" contract.
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
    // Report the offset that actually landed (and the requested one, which a
    // smooth write only reaches later) so the follow hook can tell this
    // write apart from a reader scroll.
    const element = viewport.current;
    // The write above already laid out; this read is free.
    const landed = element ? element.scrollTop : intended;
    domTop.current = landed;
    markProgrammaticScrollRef.current?.(landed, intended);
  };
}
