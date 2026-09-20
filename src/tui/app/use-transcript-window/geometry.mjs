/**
 * geometry.mjs — the row-index / render-window memo chain of one frame and
 * the geometry it publishes for the synchronous scroll handlers.
 */
import { useMemo } from 'react';
import {
  TRANSCRIPT_MEASURED_ROWS,
  transcriptStructureSignature,
  transcriptItemsWithStableTail,
  buildTranscriptRowIndexIncremental,
  estimateTranscriptItemRowsCached,
  transcriptRenderWindow,
} from '../transcript-window.mjs';
import { resolveRenderScrollOffset } from '../transcript-anchor-lock.mjs';
import { mountedSliceAwaitingMeasure } from '../transcript-measure.mjs';

// The live assistant already has one deterministic geometry authority in
// estimateTranscriptItemRowsCached. Settled rows always keep their measured
// geometry; switching the prefix back to estimates on the first upward wheel
// changed the row table mid-gesture and caused rollback/jitter.
const SUPPRESS_MEASURED_ROW_HEIGHTS = false;

/**
 * Publish the max for the immediate wheel/keyboard clamp (see the
 * committedMaxScrollRowsRef note). Adopt the estimate-based max unless a row
 * in THIS frame's mounted slice is still unmeasured; off-slice appended rows
 * never trigger the hold, so scroll can always reach the true oldest rows.
 * With measured-rows mode off no harvest ever runs, so the raw estimate is
 * published unconditionally.
 */
function publishMaxScrollRows(state, transcriptWindow, { maxScrollRowsRef, frameColumns, toolOutputExpanded }) {
  const estimateMaxScrollRows = Math.max(0, Number(transcriptWindow.maxScrollRows) || 0);
  const holdCommittedMax =
    TRANSCRIPT_MEASURED_ROWS &&
    estimateMaxScrollRows > state.committedMaxScrollRowsRef.current &&
    mountedSliceAwaitingMeasure(transcriptWindow.items || [], frameColumns, toolOutputExpanded);
  if (!holdCommittedMax) state.committedMaxScrollRowsRef.current = estimateMaxScrollRows;
  maxScrollRowsRef.current = state.committedMaxScrollRowsRef.current;
}

export function useTranscriptGeometry(state, props) {
  const {
    settledItems,
    structureRevision,
    streamingTail,
    frameColumns,
    toolOutputExpanded,
    transcriptContentHeight,
    floatingPanelRows,
    scrollOffset,
    measuredRowsVersion,
    refs,
  } = props;
  const {
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    followingRef,
    scrollTargetRef,
    transcriptGeomRef,
    maxScrollRowsRef,
  } = refs;
  // The settled array no longer changes during streaming. Geometry is keyed by
  // the engine revision plus the live tail's resolved height, so same-height
  // text flushes do not copy/walk the settled prefix or rerun heavy memos.
  const streamingTailItem = streamingTail?.kind === 'assistant' && streamingTail.streaming ? streamingTail : null;
  const tailRows = streamingTailItem
    ? estimateTranscriptItemRowsCached(streamingTailItem, frameColumns, toolOutputExpanded)
    : 0;
  const tailSig = streamingTailItem ? `${streamingTailItem.id}:${tailRows}` : '_';
  const revision = Math.max(0, Number(structureRevision) || 0);
  const transcriptItems = transcriptItemsWithStableTail(settledItems, streamingTailItem, state.transcriptItemsCacheRef);
  const transcriptStructureSig = transcriptStructureSignature(
    transcriptItems,
    frameColumns,
    toolOutputExpanded,
    revision,
    streamingTailItem
  );
  // Incremental builder: on a streaming flush where only the trailing assistant
  // item's text grew, it recomputes just the tail row and appends to a cached
  // settled-prefix row-index instead of re-walking all N items. Any structural
  // change misses the cache and falls back to a full rebuild, so the prefix
  // table is byte-identical to a full rebuild for the settled prefix. All those
  // invalidators are folded into the memo deps.
  const transcriptRowIndex = useMemo(
    () =>
      buildTranscriptRowIndexIncremental(transcriptItems, {
        columns: frameColumns,
        toolOutputExpanded,
        suppressMeasuredRowHeights: SUPPRESS_MEASURED_ROW_HEIGHTS,
        measuredRowsVersion,
        cacheRef: state.incrementalRowIndexCacheRef,
        prefixRevision: revision,
        streamingTailItem,
        // eslint-disable-next-line react-hooks/exhaustive-deps -- revision/tail height capture structural geometry; measuredRowsVersion folds in measured corrections
      }),
    [revision, tailSig, frameColumns, toolOutputExpanded, measuredRowsVersion]
  );
  const renderScrollOffset = resolveRenderScrollOffset({
    scrollOffset,
    items: transcriptItems,
    rowIndex: transcriptRowIndex,
    viewRows: transcriptContentHeight,
    floatingPanelRows,
    anchorRef: transcriptAnchorRef,
    anchorDirtyRef: transcriptAnchorDirtyRef,
    followingRef,
    scrollTargetRef,
    geomRef: transcriptGeomRef,
    prevViewportRef: state.prevViewportGeomRef,
  });
  const transcriptWindow = useMemo(
    () =>
      transcriptRenderWindow(transcriptItems, {
        scrollOffset: renderScrollOffset,
        viewportHeight: transcriptContentHeight,
        columns: frameColumns,
        toolOutputExpanded,
        rowIndex: transcriptRowIndex,
        // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: sig+scroll/viewport capture the relevant changes
      }),
    [transcriptStructureSig, renderScrollOffset, transcriptContentHeight, transcriptRowIndex]
  );
  publishMaxScrollRows(state, transcriptWindow, { maxScrollRowsRef, frameColumns, toolOutputExpanded });
  // Publish this frame's geometry so a manual scroll can capture the reading
  // anchor synchronously (use-transcript-scroll), and so the next render's
  // same-frame capture can reconstruct the exact top-edge row that was on
  // screen. renderOffset is the CLAMPED effective offset the window math
  // actually rendered with (bottom-relative, matching transcriptRenderWindow).
  transcriptGeomRef.current = {
    prefixRows: transcriptRowIndex?.prefixRows || null,
    totalRows: Math.max(0, Number(transcriptWindow.totalRows) || 0),
    viewRows: Math.max(1, Number(transcriptContentHeight) || 1),
    items: transcriptItems || null,
    renderOffset: Math.max(0, Number(transcriptWindow.effectiveScrollOffset) || 0),
    suppressMeasuredRowHeights: SUPPRESS_MEASURED_ROW_HEIGHTS,
  };
  return { revision, streamingTailItem, transcriptItems, transcriptRowIndex, transcriptWindow };
}
