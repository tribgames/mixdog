import type { VirtualItem } from '@tanstack/react-virtual';
import { type MutableRefObject, type ReactNode, type RefObject, useEffect, useMemo, useRef } from 'react';
import { useAnchorOverride } from './transcript-list-anchor-override';
import { useTranscriptHandles, useRememberVirtualMeasurements, useSelectionDrag } from './transcript-list-handles';
import { useDeferredResizes } from './transcript-list-deferred-resizes';
import { useTranscriptEndPin } from './transcript-list-end-pin';
import { logicalScrollOffset, type TranscriptVirtualizer } from './transcript-list-geometry';
import { useReadingAnchor } from './transcript-list-reading-anchor';
import { useVirtualizerResizePatch } from './transcript-list-resize-patch';
import { useMountedRowMeasurement } from './transcript-list-row-measure';
import { useTranscriptRowRegistration } from './transcript-list-row-registration';
import { useTranscriptScrollGeometry } from './transcript-list-scroll-geometry';
import { useSelectionPin } from './transcript-list-selection-pin';
import { useTouchScrollDeviation } from './transcript-list-touch-deviation';
import { useActiveRowIndexes, useTranscriptVirtualizer } from './transcript-list-virtualizer';
import type { TranscriptRowModel } from './transcript-rows';
import { readTranscriptVirtualSnapshot } from './transcript-virtual-cache';

export { shouldDeferTranscriptScrollAdjustment } from './transcript-list-geometry';

type TranscriptListProps = {
  sessionKey: string;
  rows: readonly TranscriptRowModel[];
  viewport: RefObject<HTMLDivElement | null>;
  content: MutableRefObject<HTMLDivElement | null>;
  shouldAnchorBottom: boolean;
  scrollToEndRef: MutableRefObject<(behavior?: ScrollBehavior) => void>;
  /** The follow hook flips the anchor here the instant it decides, without
   *  waiting for the render that carries `shouldAnchorBottom`. */
  setAnchorBottomRef?: MutableRefObject<(bottom: boolean) => void>;
  renderRow: (row: TranscriptRowModel) => ReactNode;
  /** Every offset this list writes is reported to the follow hook, which
   *  would otherwise read the core's own scrolls as a reader gesture. */
  markProgrammaticScroll?: (top: number, intended?: number) => void;
  /** True from the first wheel/touch/drag intent through its inertial tail. */
  hasScrollGesture: () => boolean;
  /** True while a touch scroll (finger down, then its fling) owns the
   *  viewport: corrections are held off the native offset until it ends. */
  hasTouchScroll?: () => boolean;
  /** Claims reader ownership before this list writes selection auto-scroll. */
  onSelectionAutoScroll(delta: number): void;
};

/**
 * The virtualized transcript timeline.
 *
 * ONE instance per session (the caller keys it): entry geometry, measurement
 * cache, and scroll offset are all resolved at construction, so a session
 * paints at its final position on the first frame. Settled, live, pending, and
 * thinking rows share this list; bottom anchoring and reflow compensation are
 * owned by virtual-core.
 */
export function TranscriptList({
  sessionKey,
  rows,
  viewport,
  content,
  shouldAnchorBottom: anchorBottomProp,
  scrollToEndRef,
  setAnchorBottomRef,
  renderRow,
  markProgrammaticScroll,
  hasScrollGesture,
  hasTouchScroll = noTouchScroll,
  onSelectionAutoScroll,
}: TranscriptListProps) {
  const spacer = useRef<HTMLDivElement>(null);
  // The viewport's scrollTop as last observed in a scroll event or written by
  // this list: every other consumer reads this instead of the DOM.
  const domTop = useRef<number | null>(null);
  // Reader-offset bookkeeping for each observed scroll event (set below, once
  // the reading-anchor state it consults exists).
  const noteScrollOffset = useRef<(top: number) => void>(() => {});
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const { anchorOverride, shouldAnchorBottom } = useAnchorOverride(anchorBottomProp);
  const markProgrammaticScrollRef = useRef(markProgrammaticScroll);
  markProgrammaticScrollRef.current = markProgrammaticScroll;
  const hasScrollGestureRef = useRef(hasScrollGesture);
  hasScrollGestureRef.current = hasScrollGesture;
  const hasTouchScrollRef = useRef(hasTouchScroll);
  hasTouchScrollRef.current = hasTouchScroll;
  const deviation = useTouchScrollDeviation({ viewport, spacer, hasTouchScrollRef, domTop, markProgrammaticScrollRef });
  // Rows that changed size by more than a viewport stay in the range for two
  // frames: a rewrap must never unmount the rows the reader is looking at.
  const resizePinned = useRef<number[]>([]);
  const resizePinFrame = useRef(0);
  const { setSelectionPin, selectionPinnedIndexes } = useSelectionPin(rowsRef);
  const activeIndexesRef = useActiveRowIndexes(rows);
  // Mount-time only: this component is remounted per session. The real
  // measurements are replayed immediately and corrected by virtual-core if
  // the current width wraps them differently.
  const restored = useMemo(() => readTranscriptVirtualSnapshot(sessionKey), [sessionKey]);
  const { virtualizer, virtualizerRef, relearnFrame, provisionalFrame } = useTranscriptVirtualizer({
    count: rows.length,
    viewport,
    spacer,
    rowsRef,
    hasScrollGestureRef,
    resizePinned,
    selectionPinnedIndexes,
    activeIndexesRef,
    shouldAnchorBottom,
    initialMeasurements: restored?.measurements,
    // Resolved at call time: the end pin is built below, from this instance.
    requestEndPin: () => endPin.request(),
    noteScrollOffset,
    domTop,
    markProgrammaticScrollRef,
    deviation,
  });
  // Where the timeline starts inside the scroll content (the thread's top
  // padding). Static CSS, read once on the first frame the pane has a box.
  const scrollInset = useRef(0);
  // The virtual offset at the viewport's VISIBLE top: rows start `inset`
  // below the scroll origin, so a row whose end lies within that strip is
  // still on screen — never "above the reader" (deferred, left uncompensated
  // as if unseen, or skipped as the reading anchor).
  const visibleTop = (instance: TranscriptVirtualizer) => logicalScrollOffset(instance) - scrollInset.current;
  const {
    pendingResizes,
    resizeFlushFrame,
    baseResizeItem,
    applyingDeferred,
    indexForPendingKey,
    flushDeferredResizes,
    scheduleResizeFlush,
  } = useDeferredResizes({ rowsRef, hasScrollGestureRef, virtualizerRef, visibleTop });
  const { contentHeight, maxScrollTop, endPin } = useTranscriptEndPin({
    viewport,
    spacer,
    scrollInset,
    virtualizerRef,
    hasScrollGestureRef,
    domTop,
    markProgrammaticScrollRef,
    deviation,
  });
  const { laidOutRows, pendingAnchor, anchorHold, readingAnchorHeld, restoreReadingAnchor, queueAnchorRestore } =
    useReadingAnchor({
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
    });
  useMountedRowMeasurement({
    rows,
    spacer,
    virtualizerRef,
    baseResizeItem,
    pendingResizes,
    indexForPendingKey,
    laidOutRows,
    pendingAnchor,
    anchorHold,
    restoreReadingAnchor,
  });
  const { settleHeldShrinks } = useVirtualizerResizePatch({
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
  });
  const { measureRow, bindSpacer } = useTranscriptRowRegistration({ viewport, spacer, content, virtualizerRef });

  useTranscriptScrollGeometry({ viewport, spacer, virtualizerRef, domTop, scrollInset, contentHeight, deviation });
  useRememberVirtualMeasurements({ sessionKey, viewport, virtualizerRef, flushDeferredResizes, settleHeldShrinks });
  useTranscriptHandles({
    endPin,
    scrollToEndRef,
    setAnchorBottomRef,
    virtualizerRef,
    anchorOverride,
    settleHeldShrinks,
  });
  useSelectionDrag({ viewport, sessionKey, rowsRef, setSelectionPin, onSelectionAutoScroll });

  useEffect(
    () => () => {
      if (resizePinFrame.current) window.cancelAnimationFrame(resizePinFrame.current);
      if (resizeFlushFrame.current) window.cancelAnimationFrame(resizeFlushFrame.current);
      if (relearnFrame.current) window.cancelAnimationFrame(relearnFrame.current);
      if (provisionalFrame.current) window.cancelAnimationFrame(provisionalFrame.current);
    },
    [resizeFlushFrame, relearnFrame, provisionalFrame]
  );

  const virtualRows = virtualizer.getVirtualItems();
  return (
    // directDomUpdates owns this height synchronously through containerRef.
    // A React height prop can commit an older render after a native wheel
    // reaches the bottom and temporarily clip one pane at stale geometry.
    <div className="transcript-virtual-space" ref={bindSpacer}>
      {virtualRows.map((virtualRow) => renderVirtualRow(virtualRow, rows, measureRow, renderRow))}
    </div>
  );
}

const noTouchScroll = () => false;

function renderVirtualRow(
  virtualRow: VirtualItem,
  rows: readonly TranscriptRowModel[],
  measureRow: ReturnType<typeof useTranscriptRowRegistration>['measureRow'],
  renderRow: (row: TranscriptRowModel) => ReactNode
) {
  const row = rows[virtualRow.index];
  if (!row) return null;
  const next = rows[virtualRow.index + 1];
  const turnEnd = !next || next._tag === 'TurnGap';
  // The live band under a reply part stands where that reply's completion
  // footer lands (12-transcript.css).
  const bandUnderPart = row._tag === 'Thinking' && rows[virtualRow.index - 1]?._tag === 'AssistantPart';
  return (
    // A row binds position AND measurement to one element.
    // Position and measurement therefore share the
    // OUTER box here, so applyDirectStyles (elementsCache) moves exactly
    // the element the ResizeObserver measures — in the same pre-paint
    // transaction. The row keeps its natural content height; geometry
    // corrections land before paint, so nothing is clipped a frame late.
    <div
      className="transcript-virtual-row"
      key={virtualRow.key}
      data-index={virtualRow.index}
      data-timeline-key={String(virtualRow.key)}
      ref={measureRow}
    >
      <div
        className="transcript-virtual-row-content"
        data-slot="session-turn-message-container"
        data-index={virtualRow.index}
        data-tag={row._tag}
        data-turn-end={turnEnd ? 'true' : undefined}
        data-under-part={bandUnderPart ? 'true' : undefined}
      >
        {renderRow(row)}
      </div>
    </div>
  );
}
