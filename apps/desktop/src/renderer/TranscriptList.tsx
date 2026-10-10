import { defaultRangeExtractor, elementScroll, observeElementRect, useVirtualizer } from '@tanstack/react-virtual';
import {
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { createTranscriptEndPin } from './transcript-end-pin';
import { useTranscriptHandles, useRememberVirtualMeasurements, useSelectionDrag } from './transcript-list-handles';
import { useDeferredResizes } from './transcript-list-deferred-resizes';
import {
  SCROLL_END_THRESHOLD_PX,
  logicalScrollOffset,
  measureTranscriptRow,
  type TranscriptVirtualizer,
  viewportSize,
} from './transcript-list-geometry';
import { useReadingAnchor } from './transcript-list-reading-anchor';
import { useVirtualizerResizePatch } from './transcript-list-resize-patch';
import { useMountedRowMeasurement } from './transcript-list-row-measure';
import { useTranscriptScrollGeometry } from './transcript-list-scroll-geometry';
import { useSelectionPin } from './transcript-list-selection-pin';
import type { TranscriptRowModel } from './transcript-rows';
import { logTranscriptScroll, transcriptScrollDiagnosticsEnabled } from './transcript-scroll-diagnostics';
import {
  readTranscriptVirtualSnapshot,
  TRANSCRIPT_BOTTOM_SPACER,
  TRANSCRIPT_ROW_ESTIMATE,
  TRANSCRIPT_VIRTUAL_OVERSCAN,
} from './transcript-virtual-cache';

export { shouldDeferTranscriptScrollAdjustment } from './transcript-list-geometry';

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
  bottomInset = 0,
  shouldAnchorBottom: anchorBottomProp,
  scrollToEndRef,
  setAnchorBottomRef,
  renderRow,
  markProgrammaticScroll,
  hasScrollGesture,
  onSelectionAutoScroll,
}: {
  sessionKey: string;
  rows: readonly TranscriptRowModel[];
  viewport: RefObject<HTMLDivElement | null>;
  content: MutableRefObject<HTMLDivElement | null>;
  /** Measured overlay footprint, not a reduction of the scroll viewport. */
  bottomInset?: number;
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
  /** Claims reader ownership before this list writes selection auto-scroll. */
  onSelectionAutoScroll(delta: number): void;
}) {
  const spacer = useRef<HTMLDivElement>(null);
  const bottomInsetRef = useRef(bottomInset);
  bottomInsetRef.current = bottomInset;
  // The viewport's scrollTop as last observed in a scroll event or written by
  // this list: every other consumer reads this instead of the DOM.
  const domTop = useRef<number | null>(null);
  // Reader-offset bookkeeping for each observed scroll event (set below, once
  // the reading-anchor state it consults exists).
  const noteScrollOffset = useRef<(top: number) => void>(() => {});
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Reader intent reaches the core in the SAME task it was decided in: the
  // follow hook calls setAnchorBottomRef synchronously, and this override
  // keeps every render until React's own state catches up agreeing with it.
  // While the two disagreed, the core still owned the end anchor and rolled
  // each wheel notch back by the growth of the frame it landed in.
  const anchorOverride = useRef<boolean | null>(null);
  if (anchorOverride.current === anchorBottomProp) anchorOverride.current = null;
  const shouldAnchorBottom = anchorOverride.current ?? anchorBottomProp;
  const markProgrammaticScrollRef = useRef(markProgrammaticScroll);
  markProgrammaticScrollRef.current = markProgrammaticScroll;
  const hasScrollGestureRef = useRef(hasScrollGesture);
  hasScrollGestureRef.current = hasScrollGesture;
  // Rows that changed size by more than a viewport stay in the range for two
  // frames: a rewrap must never unmount the rows the reader is looking at.
  const resizePinned = useRef<number[]>([]);
  const resizePinFrame = useRef(0);
  const { setSelectionPin, selectionPinnedIndexes } = useSelectionPin(rowsRef);
  const activeIndexesRef = useRef<number[]>([]);
  let activeIndex = -1;
  rows.forEach((row, index) => {
    if ('active' in row && row.active) activeIndex = index;
  });
  activeIndexesRef.current = activeIndex < 0 ? [] : [activeIndex];
  // Mount-time only: this component is remounted per session. The real
  // measurements are replayed immediately and corrected by virtual-core if
  // the current width wraps them differently.
  const restored = useMemo(() => readTranscriptVirtualSnapshot(sessionKey), [sessionKey]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => TRANSCRIPT_ROW_ESTIMATE,
    getItemKey: (index) => rowsRef.current[index]?.key ?? `row:${index}`,
    measureElement: measureTranscriptRow,
    overscan: TRANSCRIPT_VIRTUAL_OVERSCAN,
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor({ ...range, overscan: TRANSCRIPT_VIRTUAL_OVERSCAN });
      return [
        ...new Set([...resizePinned.current, ...selectionPinnedIndexes(), ...indexes, ...activeIndexesRef.current]),
      ]
        .filter((index) => index >= 0 && index < rows.length)
        .sort((a, b) => a - b);
    },
    initialOffset: () => (shouldAnchorBottom ? Number.MAX_SAFE_INTEGER : 0),
    initialMeasurementsCache: restored?.measurements,
    // Reader intent wins immediately. Keeping end anchoring active inside the
    // 80px return band let a small upward wheel move get reversed by the next
    // append or row measurement even after the follow hook had detached.
    anchorTo: shouldAnchorBottom ? 'end' : 'start',
    followOnAppend: shouldAnchorBottom,
    // While the tail is owned, every append and measured-size delta is an
    // end pin. An 80px band lost tall rows in a short split and invited a
    // second scrollToEnd writer. Reader release flips followOnAppend off.
    scrollEndThreshold: SCROLL_END_THRESHOLD_PX,
    paddingEnd: bottomInset + TRANSCRIPT_BOTTOM_SPACER,
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
        cb(rect);
        if (rect.height !== previous) endPin.request();
      }),
    // virtual-core's own offset observer reports, once scrolling idles, the
    // offset its LAST scroll event read (a debounced callback over a captured
    // value). A write this list made in between — a landing's anchor restore,
    // an end pin — was overwritten by that stale offset, and every later
    // correction started from it: a page landing within ~150 ms of the last
    // wheel event jumped the reader by the page a frame later, and a phone
    // reader at scrollTop 0 was put back at 0 plus the page. The idle report
    // carries the offset as last observed OR written.
    observeElementOffset: (instance, cb) => {
      const element = instance.scrollElement;
      if (!element) return undefined;
      let idle = 0;
      const onScroll = () => {
        // The one offset read per scroll event.
        const top = element.scrollTop;
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
    },
    // Grow the spacer before a programmatic write so Chrome cannot clamp the
    // requested offset against the previous total height.
    scrollToFn: (offset, options, instance) => {
      if (instance.options.anchorTo === 'end' || instance.options.followOnAppend) {
        // Core measurements can request several opposing offsets while the
        // prompt/Goal/diff commit is still changing geometry. They share the
        // final native pin, never an intermediate elementScroll followed by
        // another corrective write.
        endPin.request();
        return;
      }
      if (spacer.current) spacer.current.style.height = `${instance.getTotalSize()}px`;
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
      const intended = offset + (options?.adjustments ?? 0);
      // The write above already laid out; this read is free.
      const landed = element ? element.scrollTop : intended;
      domTop.current = landed;
      markProgrammaticScrollRef.current?.(landed, intended);
    },
  });
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
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
  // The committed extent: the spacer height virtual-core last wrote (a style
  // read). It is what the DOM scrolls over, also mid-render, when the core's
  // measurement cache may already describe the next row set.
  const contentHeight = useCallback(
    () =>
      scrollInset.current +
      (Number.parseFloat(spacer.current?.style.height ?? '') || virtualizerRef.current.getTotalSize()),
    []
  );
  const maxScrollTop = useCallback(
    () => Math.max(0, contentHeight() - viewportSize(virtualizerRef.current)),
    [contentHeight]
  );
  const endPin = useMemo(
    () =>
      createTranscriptEndPin({
        getVirtualizer: () => virtualizerRef.current,
        getViewport: () => viewport.current,
        getSpacer: () => spacer.current,
        getMaxScrollTop: maxScrollTop,
        hasReaderGesture: () => hasScrollGestureRef.current(),
        markProgrammaticScroll: (top, intended) => {
          domTop.current = top;
          markProgrammaticScrollRef.current?.(top, intended);
        },
      }),
    [maxScrollTop, viewport]
  );
  useLayoutEffect(() => () => endPin.cancel(), [endPin]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bottomInset is the intentional trigger — a padding change re-publishes the extent and re-requests the end pin
  useLayoutEffect(() => {
    // Padding changes do not move any row. Publish the new extent for readers
    // too; only a following timeline is allowed to move to the new end.
    if (spacer.current) spacer.current.style.height = `${virtualizerRef.current.getTotalSize()}px`;
    endPin.request();
  }, [bottomInset, endPin]);
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
  useVirtualizerResizePatch({
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
  const measureRow = useCallback((element: HTMLDivElement | null) => {
    // Registration only: the row's ResizeObserver delivers its box after this
    // frame's layout and before its paint, so no layout is read here.
    if (element?.isConnected) {
      const instance = virtualizerRef.current;
      const key = instance.options.getItemKey(instance.indexFromElement(element));
      const cached = instance.itemSizeCache.get(key);
      if (cached !== undefined) element.style.setProperty('--transcript-measured-height', `${cached}px`);
      instance.measureElement(element);
    }
  }, []);
  const bindSpacer = useCallback(
    (element: HTMLDivElement | null) => {
      spacer.current = element;
      content.current = element;
      // Direct DOM updates keep the spacer height current between React commits.
      virtualizerRef.current.containerRef(element);
    },
    [content]
  );

  useTranscriptScrollGeometry({ viewport, spacer, virtualizerRef, domTop, scrollInset, contentHeight });
  useRememberVirtualMeasurements({ sessionKey, viewport, virtualizerRef, flushDeferredResizes });
  useTranscriptHandles({ endPin, scrollToEndRef, setAnchorBottomRef, virtualizerRef, anchorOverride });
  useSelectionDrag({ viewport, sessionKey, bottomInsetRef, rowsRef, setSelectionPin, onSelectionAutoScroll });

  useEffect(
    () => () => {
      if (resizePinFrame.current) window.cancelAnimationFrame(resizePinFrame.current);
      if (resizeFlushFrame.current) window.cancelAnimationFrame(resizeFlushFrame.current);
    },
    [resizeFlushFrame]
  );

  const virtualRows = virtualizer.getVirtualItems();
  return (
    // directDomUpdates owns this height synchronously through containerRef.
    // A React height prop can commit an older render after a native wheel
    // reaches the bottom and temporarily clip one pane at stale geometry.
    <div className="transcript-virtual-space" ref={bindSpacer}>
      {virtualRows.map((virtualRow) => {
        const row = rows[virtualRow.index];
        if (!row) return null;
        const next = rows[virtualRow.index + 1];
        const turnEnd = !next || next._tag === 'TurnGap';
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
            >
              {renderRow(row)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
