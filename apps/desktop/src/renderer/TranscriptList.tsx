import type { VirtualItem } from '@tanstack/react-virtual';
import { type MutableRefObject, type ReactNode, type RefObject, useEffect, useMemo, useRef } from 'react';
import { useAnchorOverride } from './transcript-list-anchor-override';
import { useTranscriptHandles, useRememberVirtualMeasurements, useSelectionDrag } from './transcript-list-handles';
import { useDeferredResizes } from './transcript-list-deferred-resizes';
import { useDockInset } from './transcript-list-dock-inset';
import { useTranscriptEndPin } from './transcript-list-end-pin';
import { logicalScrollOffset, type TranscriptVirtualizer } from './transcript-list-geometry';
import { transcriptRowVariant } from './transcript-list-estimates';
import { useSessionAttentionIndex } from './session-attention-index';
import { useSurfaceActive } from './surface-activity';
import { useMarkdownPrefetch } from './transcript-list-markdown-prefetch';
import { useReaderPlace } from './transcript-list-reader-place';
import { useReadingAnchor } from './transcript-list-reading-anchor';
import { useVirtualizerResizePatch } from './transcript-list-resize-patch';
import { useMountedRowMeasurement } from './transcript-list-row-measure';
import { useTranscriptRowRegistration } from './transcript-list-row-registration';
import { useTranscriptScrollGeometry } from './transcript-list-scroll-geometry';
import { useSelectionPin } from './transcript-list-selection-pin';
import { createTranscriptRowNodes, paintsNothing, type TranscriptRowNodes } from './transcript-list-row-nodes';
import { useTouchScrollDeviation } from './transcript-list-touch-deviation';
import { useActiveRowIndexes, useTranscriptVirtualizer } from './transcript-list-virtualizer';
import { BandDividerContext, isCompactionDivider, isThreadDivider } from './transcript-primitives';
import type { TranscriptRowSurface } from './transcript-row-estimates';
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
  /** `index` and `rows` let a row read its neighbours (agent-mode bubble runs). */
  renderRow: (row: TranscriptRowModel, index: number, rows: readonly TranscriptRowModel[]) => ReactNode;
  /** Every offset this list writes is reported to the follow hook, which
   *  would otherwise read the core's own scrolls as a reader gesture. */
  markProgrammaticScroll?: (top: number, intended?: number) => void;
  /** True from the first wheel/touch/drag intent through its inertial tail. */
  hasScrollGesture: () => boolean;
  /** True while a wheel ramp or a touch scroll owns the viewport:
   *  corrections are held off the native offset until it ends
   *  (transcript-list-touch-deviation). */
  hasTouchScroll?: () => boolean;
  /** True while that hold belongs to a touch scroll: it lands early once the
   *  logical offset reaches the real top. */
  touchHoldsCorrections?: () => boolean;
  /** Claims reader ownership before this list writes selection auto-scroll. */
  onSelectionAutoScroll(delta: number): void;
  /** A selection covers transcript text (true), or no longer does (false): the follow hook writes no end under it. */
  onSelectionHold?(held: boolean): void;
  /** Who paints the rows: an agent chat's rows learn their heights apart. */
  surface?: TranscriptRowSurface;
};

/** The virtualized transcript timeline; one instance per session (the caller keys it). */
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
  touchHoldsCorrections = noTouchScroll,
  onSelectionAutoScroll,
  onSelectionHold = noSelectionHold,
  surface = 'coding',
}: TranscriptListProps) {
  const surfaceRef = useRef(surface);
  surfaceRef.current = surface;
  // The same live decision the rows take (taskReportHidden): data-variant
  // changes exactly when a wait line comes or goes.
  const waiting = useSessionAttentionIndex().needsUser;
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
  const touchHoldsRef = useRef(touchHoldsCorrections);
  touchHoldsRef.current = touchHoldsCorrections;
  const deviation = useTouchScrollDeviation({
    viewport,
    spacer,
    hasTouchScrollRef,
    touchHoldsRef,
    domTop,
    markProgrammaticScrollRef,
  });
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
  const bottomInset = useRef(0);
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
    pinEndNow: () => endPin.now(),
    bottomInset,
    noteScrollOffset,
    domTop,
    markProgrammaticScrollRef,
    deviation,
    surfaceRef,
  });
  // Where the timeline starts inside the scroll content (the thread's top
  // padding). Static CSS, read once on the first frame the pane has a box.
  const scrollInset = useRef(0);
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
  const syncDockInset = useDockInset({
    viewport,
    spacer,
    virtualizerRef,
    bottomInset,
    // Resolved at call time: the reading anchor is built below, from this instance.
    onChange: () => {
      const instance = virtualizerRef.current;
      if (instance.options.anchorTo === 'end' || instance.options.followOnAppend) endPin.now();
      else if (readingAnchorHeld()) restoreReadingAnchor(true);
    },
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
      syncDockInset,
    });
  useReaderPlace({
    sessionKey,
    viewport,
    rowsRef,
    virtualizerRef,
    scrollInset,
    deviation,
    anchorHold,
    restoreReadingAnchor,
    flushDeferredResizes,
    syncDockInset,
  });
  const rowMeasurement = {
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
  };
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
    spacer,
    rowsRef,
    scrollInset,
    indexForPendingKey,
    restoreReadingAnchor,
  });
  const { measureRow, bindSpacer } = useTranscriptRowRegistration({ spacer, content, virtualizerRef });

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
  useSelectionDrag({ viewport, sessionKey, rowsRef, setSelectionPin, onSelectionAutoScroll, onSelectionHold });

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
  const shown = useSurfaceActive();
  // The core's visible range (overscan excluded), current after the read above.
  const visible = virtualizer.range;
  useMarkdownPrefetch(rows, shown && visible ? visible.startIndex : -1, visible?.endIndex ?? -1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibility starts a fresh node cache
  const rowNodes = useMemo(() => createTranscriptRowNodes(rows, renderRow), [rows, renderRow, shown]);
  // A zero-height viewport has no extracted range, even in the commit
  // that reveals the pane. Its full measurement list still has the pins.
  const mounted =
    shown && visible
      ? virtualRows
      : activeIndexesRef.current.flatMap((index) => virtualizer.measurementsCache[index] ?? []);
  return (
    <>
      {/* directDomUpdates owns this height synchronously through containerRef.
        A React height prop can commit an older render after a native wheel
        reaches the bottom and temporarily clip one pane at stale geometry. */}
      <div className="transcript-virtual-space" ref={bindSpacer}>
        {mounted.map((virtualRow) =>
          renderVirtualRow(
            virtualRow,
            rows,
            measureRow,
            rowNodes,
            visible !== null && (virtualRow.index < visible.startIndex || virtualRow.index > visible.endIndex),
            waiting
          )
        )}
      </div>
      <MountedRowMeasurement {...rowMeasurement} />
    </>
  );
}

/** Reads the rows a commit laid out before the list writes that commit's spacer height: a child's layout effects run
 *  after the spacer's ref is bound and before its parent's, where virtual-core writes the spacer. A row that changed
 *  with the rows around it (a live band leaving as the turn's footer folds onto its reply) is applied in the same
 *  pass, so the spacer never shrinks first and clamps the view. */
function MountedRowMeasurement(props: Parameters<typeof useMountedRowMeasurement>[0]) {
  useMountedRowMeasurement(props);
  return null;
}

const noTouchScroll = () => false;
const noSelectionHold = () => {};

/** How a row sits against its neighbours: whether it paints, and the gaps and
 *  bands the stylesheet keys off (12-transcript.css). */
function rowSteps(
  row: TranscriptRowModel,
  index: number,
  rows: readonly TranscriptRowModel[],
  node: ReactNode,
  rowNodes: TranscriptRowNodes
) {
  const blank = paintsNothing(node);
  const above = rowNodes.paintedAbove(index);
  // Rows below that paint nothing (a reaction-only turn's tool round) do not
  // keep the turn open: the turn ends at the next painted row.
  const nextIndex = rowNodes.paintedBelow(index);
  const next = rows[nextIndex];
  const before = rows[above];
  const previous = blank ? undefined : before?._tag;
  // The live band under a reply part or tool card is the same 40px status
  // slot as the completion footer that replaces it (12-transcript.css): the
  // row above it takes no step, the band leads in itself.
  const leadsBand = (tag: TranscriptRowModel['_tag'] | undefined) => tag === 'AssistantPart' || tag === 'ToolActivity';
  const part = (tag: TranscriptRowModel['_tag'] | undefined) =>
    tag === 'AssistantPart' || tag === 'ToolActivity' || tag === 'Error';
  // A turn's end standing on its own (no reply to close) or the error that ended it takes the band's place: it has the
  // band's height wherever the band stood (data-band-seat) and leads in as the band did, so the band going for it moves
  // nothing.
  const endsTurn = (row._tag === 'AssistantPart' && row.item.kind === 'turndone') || row._tag === 'Error';
  // A divider takes the band's place the same way, whether the band then goes on under it or not.
  const divides = row._tag === 'AssistantPart' && isThreadDivider(row.item);
  const dividedAbove = !blank && before?._tag === 'AssistantPart' && isThreadDivider(before.item);
  const seated = endsTurn || divides;
  // A divider stands apart from the rows around it (12-transcript.css). Above, it stands as the band stood (its
  // lead, a prompt's own room or a turn gap), so the band's compacting state ending for it moves nothing. Below,
  // the row carries a full step, or the turn gap grows to it; the band alone leads in under a divider as it does
  // under any part.
  const dividerStep =
    !blank &&
    row._tag !== 'TurnGap' &&
    ((dividedAbove && row._tag !== 'Thinking') ||
      (divides &&
        before !== undefined &&
        before._tag !== 'UserMessage' &&
        before._tag !== 'TurnGap' &&
        !leadsBand(previous)));
  const dividerGap = row._tag === 'TurnGap' && dividedAbove;
  const bandLead = !dividerStep && (row._tag === 'Thinking' || seated) && leadsBand(previous);
  const dividerAbove =
    row._tag === 'Thinking' && before?._tag === 'AssistantPart' && isCompactionDivider(before.item)
      ? String(before.item.id ?? before.key)
      : '';
  const stepBefore = !dividerStep && !bandLead && row._tag !== 'TurnGap' && part(previous);
  // A message sent while the turn runs stands under the turn's rows so far, and the turn's answer lands above it: the
  // row it stands under has not ended its turn.
  const opened = next?._tag === 'TurnGap' ? rows[rowNodes.paintedBelow(nextIndex)] : undefined;
  const sentMeanwhile = opened?._tag === 'UserMessage' && Boolean(opened.item.steer);
  const turnEnd = !blank && !part(row._tag) && (!next || (next._tag === 'TurnGap' && !sentMeanwhile));
  // A turn's changed-files card closes its stack: a row after it in the same
  // turn takes the turn gap, never the 8px part step (12-transcript.css).
  const afterChanges =
    stepBefore && (before?._tag === 'AssistantPart' || before?._tag === 'Error') && Boolean(before.turnChanges);
  return {
    blank,
    bandSeat: seated && !blank,
    bandLead,
    stepBefore,
    turnEnd,
    afterChanges,
    dividerAbove,
    dividerStep,
    dividerGap,
  };
}

function renderVirtualRow(
  virtualRow: VirtualItem,
  rows: readonly TranscriptRowModel[],
  measureRow: ReturnType<typeof useTranscriptRowRegistration>['measureRow'],
  rowNodes: TranscriptRowNodes,
  offscreen: boolean,
  /** Sessions waiting for the user now (a wait report shows only for them). */
  waiting: ReadonlySet<string>
) {
  const row = rows[virtualRow.index];
  if (!row) return null;
  const node = rowNodes.nodeAt(virtualRow.index);
  const { blank, bandSeat, bandLead, stepBefore, turnEnd, afterChanges, dividerAbove, dividerStep, dividerGap } =
    rowSteps(row, virtualRow.index, rows, node, rowNodes);
  // What the row paints from other rows (hand-off lines, a hidden report),
  // from the same rows as its node: its measurements are recorded under it
  // (transcript-list-estimates.ts).
  const variant = transcriptRowVariant(rows, virtualRow.index, waiting);
  return (
    <div
      className="transcript-virtual-row"
      key={virtualRow.key}
      data-index={virtualRow.index}
      data-timeline-key={String(virtualRow.key)}
      // No IntersectionObserver: any observer in the document makes Chromium run a main-thread frame per vsync while a compositor animation runs.
      data-offscreen={offscreen ? 'true' : undefined}
      ref={measureRow}
    >
      <div
        className="transcript-virtual-row-content"
        data-slot="session-turn-message-container"
        data-index={virtualRow.index}
        data-tag={row._tag}
        data-turn-end={turnEnd ? 'true' : undefined}
        data-band-seat={bandSeat ? 'true' : undefined}
        data-band-lead={bandLead ? 'true' : undefined}
        data-step-before={stepBefore ? 'true' : undefined}
        data-after-changes={afterChanges ? 'true' : undefined}
        data-divider-step={dividerStep ? 'true' : undefined}
        data-divider-gap={dividerGap ? 'true' : undefined}
        data-blank={blank ? 'true' : undefined}
        data-variant={variant || undefined}
      >
        {row._tag === 'Thinking' ? (
          <BandDividerContext.Provider value={dividerAbove}>{node}</BandDividerContext.Provider>
        ) : (
          node
        )}
      </div>
    </div>
  );
}
