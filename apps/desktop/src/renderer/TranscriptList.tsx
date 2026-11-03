import type { VirtualItem } from '@tanstack/react-virtual';
import { type MutableRefObject, type ReactNode, type RefObject, useEffect, useMemo, useRef } from 'react';
import { useAnchorOverride } from './transcript-list-anchor-override';
import { useTranscriptHandles, useRememberVirtualMeasurements, useSelectionDrag } from './transcript-list-handles';
import { useDeferredResizes } from './transcript-list-deferred-resizes';
import { useTranscriptEndPin } from './transcript-list-end-pin';
import { logicalScrollOffset, type TranscriptVirtualizer } from './transcript-list-geometry';
import { transcriptRowVariant } from './transcript-list-estimates';
import { useSessionAttentionIndex } from './session-attention-index';
import { useMarkdownPrefetch } from './transcript-list-markdown-prefetch';
import { useReadingAnchor } from './transcript-list-reading-anchor';
import { useVirtualizerResizePatch } from './transcript-list-resize-patch';
import { useMountedRowMeasurement } from './transcript-list-row-measure';
import { useTranscriptRowRegistration } from './transcript-list-row-registration';
import { useTranscriptScrollGeometry } from './transcript-list-scroll-geometry';
import { useSelectionPin } from './transcript-list-selection-pin';
import { useTouchScrollDeviation } from './transcript-list-touch-deviation';
import { useActiveRowIndexes, useTranscriptVirtualizer } from './transcript-list-virtualizer';
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
  /** Who paints the rows: an agent chat's rows learn their heights apart. */
  surface?: TranscriptRowSurface;
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
  touchHoldsCorrections = noTouchScroll,
  onSelectionAutoScroll,
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
    surfaceRef,
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
  // The core's visible range (overscan excluded), current after the read above.
  const visible = virtualizer.range;
  useMarkdownPrefetch(rows, visible?.startIndex ?? -1, visible?.endIndex ?? -1);
  // Each row's node, rendered once per commit: a row's step reads whether the
  // rows above it paint anything.
  const nodes = new Map<number, ReactNode>();
  const nodeAt = (index: number): ReactNode => {
    if (!nodes.has(index)) nodes.set(index, renderRow(rows[index] as TranscriptRowModel, index, rows));
    return nodes.get(index);
  };
  return (
    // directDomUpdates owns this height synchronously through containerRef.
    // A React height prop can commit an older render after a native wheel
    // reaches the bottom and temporarily clip one pane at stale geometry.
    <div className="transcript-virtual-space" ref={bindSpacer}>
      {virtualRows.map((virtualRow) =>
        renderVirtualRow(
          virtualRow,
          rows,
          measureRow,
          nodeAt,
          visible !== null && (virtualRow.index < visible.startIndex || virtualRow.index > visible.endIndex),
          waiting
        )
      )}
    </div>
  );
}

const noTouchScroll = () => false;

const paintsNothing = (node: ReactNode) => node === null || node === undefined || node === false;

/** How a row sits against its neighbours: whether it paints, and the gaps and
 *  bands the stylesheet keys off (12-transcript.css). */
function rowSteps(
  row: TranscriptRowModel,
  index: number,
  rows: readonly TranscriptRowModel[],
  node: ReactNode,
  nodeAt: (index: number) => ReactNode
) {
  // A row that renders nothing (an agent chat's tool round or unfinished
  // reply) takes no room and no step, and the row below it steps from the
  // nearest row above that paints: stepping from the empty rows, every hidden
  // tool round moved the agent's typing bubble 8px and the reply then landed
  // 16px above it, so the thread shook while the reply was generated.
  const blank = paintsNothing(node);
  let above = index - 1;
  while (above >= 0 && paintsNothing(nodeAt(above))) above -= 1;
  // Rows below that paint nothing (a reaction-only turn's tool round) do not
  // keep the turn open: the turn ends at the next painted row.
  let nextIndex = index + 1;
  while (nextIndex < rows.length && paintsNothing(nodeAt(nextIndex))) nextIndex += 1;
  const next = rows[nextIndex];
  const before = rows[above];
  const previous = blank ? undefined : before?._tag;
  // The live band under a reply part or tool card is the same 40px status
  // slot as the completion footer that replaces it (12-transcript.css): the
  // row above it takes no step, the band leads in itself.
  const leadsBand = (tag: TranscriptRowModel['_tag'] | undefined) => tag === 'AssistantPart' || tag === 'ToolActivity';
  // The step after a reply part, tool card or error belongs to the row BELOW
  // it. As the part's own bottom padding, appending the next row resized the
  // settled part above it, and the new row was placed at the old size for a
  // frame before jumping 8px (tool rounds shook the whole thread).
  const part = (tag: TranscriptRowModel['_tag'] | undefined) =>
    tag === 'AssistantPart' || tag === 'ToolActivity' || tag === 'Error';
  const bandLead = row._tag === 'Thinking' && leadsBand(previous);
  const stepBefore = !bandLead && row._tag !== 'TurnGap' && part(previous);
  const turnEnd = !blank && !part(row._tag) && (!next || next._tag === 'TurnGap');
  // A turn's changed-files card closes its stack: a row after it in the same
  // turn takes the turn gap, never the 8px part step (12-transcript.css).
  const afterChanges =
    stepBefore && (before?._tag === 'AssistantPart' || before?._tag === 'Error') && Boolean(before.turnChanges);
  return { blank, bandLead, stepBefore, turnEnd, afterChanges };
}

function renderVirtualRow(
  virtualRow: VirtualItem,
  rows: readonly TranscriptRowModel[],
  measureRow: ReturnType<typeof useTranscriptRowRegistration>['measureRow'],
  nodeAt: (index: number) => ReactNode,
  offscreen: boolean,
  /** Sessions waiting for the user now (a wait report shows only for them). */
  waiting: ReadonlySet<string>
) {
  const row = rows[virtualRow.index];
  if (!row) return null;
  const node = nodeAt(virtualRow.index);
  const { blank, bandLead, stepBefore, turnEnd, afterChanges } = rowSteps(row, virtualRow.index, rows, node, nodeAt);
  // What the row paints from other rows (hand-off lines, a hidden report),
  // from the same rows as its node: its measurements are recorded under it
  // (transcript-list-estimates.ts).
  const variant = transcriptRowVariant(rows, virtualRow.index, waiting);
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
      // Overscan and pinned rows outside the viewport hold their infinite
      // loaders still (12-transcript.css). The core re-renders this list on
      // every visible-range change, so the mark follows the reader's scroll
      // without an IntersectionObserver: any observer in the document made
      // Chromium run a main-thread frame on every vsync for as long as a
      // compositor animation (spinner, shimmer) ran anywhere in the window.
      data-offscreen={offscreen ? 'true' : undefined}
      ref={measureRow}
    >
      <div
        className="transcript-virtual-row-content"
        data-slot="session-turn-message-container"
        data-index={virtualRow.index}
        data-tag={row._tag}
        data-turn-end={turnEnd ? 'true' : undefined}
        data-band-lead={bandLead ? 'true' : undefined}
        data-step-before={stepBefore ? 'true' : undefined}
        data-after-changes={afterChanges ? 'true' : undefined}
        data-blank={blank ? 'true' : undefined}
        data-variant={variant || undefined}
      >
        {node}
      </div>
    </div>
  );
}
