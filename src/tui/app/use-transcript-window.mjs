/**
 * use-transcript-window.mjs — transcript row-index/window memo chain plus the
 * measured-height harvest and reading-anchor lock effects.
 *
 * The render-time anchor arithmetic lives in transcript-anchor-lock.mjs, the
 * Yoga height harvest in transcript-measure.mjs and the post-commit scroll
 * sync in transcript-anchor-sync.mjs. This hook owns the per-instance caches,
 * the memo chain, this frame's published geometry and the effect ORDER
 * (harvest → anchor sync → clamp → selection shift). Scroll/anchor/drag refs
 * stay App-owned (injected).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import {
  TRANSCRIPT_MEASURED_ROWS,
  transcriptStructureSignature,
  transcriptItemsWithStableTail,
  buildTranscriptRowIndexIncremental,
  estimateTranscriptItemRowsCached,
  transcriptRenderWindow,
  shiftSelectionRectY,
} from './transcript-window.mjs';
import { shouldSuppressFullyFailedToolItem } from '../transcript-tool-failures.mjs';
import { resolveRenderScrollOffset } from './transcript-anchor-lock.mjs';
import {
  createMeasureState,
  harvestMeasuredRows,
  measureRefFor,
  mountedSliceAwaitingMeasure,
  resetMeasureState,
} from './transcript-measure.mjs';
import {
  clampScrollToOverflow,
  resetScrollWhenUnanchored,
  syncReadingAnchorAfterCommit,
} from './transcript-anchor-sync.mjs';

function freshViewportGeom() {
  return { contentHeight: 0, floatingPanelRows: 0 };
}

export function useTranscriptWindow({
  items: settledItems,
  structureRevision,
  sessionKey = '',
  streamingTail,
  themeEpoch,
  frameColumns,
  toolOutputExpanded,
  transcriptContentHeight,
  transcriptBottomSlackRows,
  transcriptGuardRows,
  floatingPanelRows,
  overlayHintRequested,
  scrollOffset,
  setScrollOffset,
  transcriptAnchorRef,
  transcriptAnchorDirtyRef,
  scrollTargetRef,
  scrollPositionRef,
  maxScrollRowsRef,
  transcriptGeomRef,
  followingRef,
  dragRef,
  transcriptViewportRef,
  selectionLayoutRef,
  withSelectionClip,
  paintSelectionRect,
  stopSmoothScroll,
  measuredRowsVersion,
  setMeasuredRowsVersion,
}) {
  const transcriptTotalRowsRef = useRef(0);
  // Pessimistic "committed" max-scroll for the IMMEDIATE wheel/keyboard clamp.
  // transcriptWindow.maxScrollRows is derived from the row index, which uses
  // ESTIMATED heights for rows in the mounted slice. On the frame a scroll-up
  // FIRST mounts a new row, its estimate may overshoot the real Yoga height, so
  // a wheel offset clamped only against it scrolls past committed geometry —
  // a one-frame blank band at the top. Hold this cap only while a row IN the
  // mounted slice is still unmeasured; the harvest measures it on the next
  // commit and the estimate is adopted.
  const committedMaxScrollRowsRef = useRef(0);
  // Per-hook-instance settled-prefix caches for the incremental builder, so
  // each transcript window owns its own tail-flush cache.
  const incrementalRowIndexCacheRef = useRef(null);
  const transcriptItemsCacheRef = useRef(null);
  // Previous frame's viewport-only geometry, so a floating panel open-close
  // (which changes the viewport without changing `items`) can freeze the
  // visible top row for a single frame — see resolveRenderScrollOffset.
  const prevViewportGeomRef = useRef(freshViewportGeom());
  const measureStateRef = useRef(null);
  if (!measureStateRef.current) measureStateRef.current = createMeasureState();
  const normalizedSessionKey = String(sessionKey ?? '');
  const transcriptSessionKeyRef = useRef(normalizedSessionKey);
  if (transcriptSessionKeyRef.current !== normalizedSessionKey) {
    // A resumed session replaces the transcript atomically, but this hook
    // remains mounted. Never let the outgoing session's row index, reading
    // anchor, measured-element map, or bottom-relative offset participate in
    // the incoming session's first frame. Reset synchronously during render so
    // the new transcript paints at its final bottom-pinned position; the layout
    // effect below only reconciles the App-owned scroll state afterward.
    transcriptSessionKeyRef.current = normalizedSessionKey;
    transcriptTotalRowsRef.current = 0;
    committedMaxScrollRowsRef.current = 0;
    incrementalRowIndexCacheRef.current = null;
    transcriptItemsCacheRef.current = null;
    prevViewportGeomRef.current = freshViewportGeom();
    resetMeasureState(measureStateRef.current);
    transcriptAnchorRef.current = null;
    transcriptAnchorDirtyRef.current = false;
    scrollTargetRef.current = 0;
    scrollPositionRef.current = 0;
    maxScrollRowsRef.current = 0;
    transcriptGeomRef.current = {};
    followingRef.current = true;
    selectionLayoutRef.current = null;
  }
  useLayoutEffect(() => {
    if (scrollOffset !== 0) setScrollOffset(0);
  }, [normalizedSessionKey, setScrollOffset]);

  const transcriptMeasureRef = useCallback((item) => measureRefFor(measureStateRef.current, item), []);

  // The settled array no longer changes during streaming. Geometry is keyed by
  // the engine revision plus the live tail's resolved height, so same-height
  // text flushes do not copy/walk the settled prefix or rerun heavy memos.
  const streamingTailItem = streamingTail?.kind === 'assistant' && streamingTail.streaming ? streamingTail : null;
  const tailRows = streamingTailItem
    ? estimateTranscriptItemRowsCached(streamingTailItem, frameColumns, toolOutputExpanded)
    : 0;
  const tailSig = streamingTailItem ? `${streamingTailItem.id}:${tailRows}` : '_';
  const revision = Math.max(0, Number(structureRevision) || 0);
  const transcriptItems = transcriptItemsWithStableTail(settledItems, streamingTailItem, transcriptItemsCacheRef);
  const transcriptStructureSig = transcriptStructureSignature(
    transcriptItems,
    frameColumns,
    toolOutputExpanded,
    revision,
    streamingTailItem
  );
  // The live assistant already has one deterministic geometry authority in
  // estimateTranscriptItemRowsCached. Settled rows always keep their measured
  // geometry; switching the prefix back to estimates on the first upward wheel
  // changed the row table mid-gesture and caused rollback/jitter.
  const suppressMeasuredRowHeights = false;
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
        suppressMeasuredRowHeights,
        measuredRowsVersion,
        cacheRef: incrementalRowIndexCacheRef,
        prefixRevision: revision,
        streamingTailItem,
        // eslint-disable-next-line react-hooks/exhaustive-deps -- revision/tail height capture structural geometry; measuredRowsVersion folds in measured corrections
      }),
    [revision, tailSig, frameColumns, toolOutputExpanded, measuredRowsVersion, suppressMeasuredRowHeights]
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
    prevViewportRef: prevViewportGeomRef,
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
  // Publish the max for the immediate wheel/keyboard clamp (see the
  // committedMaxScrollRowsRef note). Adopt the estimate-based max unless a row
  // in THIS frame's mounted slice is still unmeasured; off-slice appended rows
  // never trigger the hold, so scroll can always reach the true oldest rows.
  // With measured-rows mode off no harvest ever runs, so the raw estimate is
  // published unconditionally.
  const estimateMaxScrollRows = Math.max(0, Number(transcriptWindow.maxScrollRows) || 0);
  const holdCommittedMax =
    TRANSCRIPT_MEASURED_ROWS &&
    estimateMaxScrollRows > committedMaxScrollRowsRef.current &&
    mountedSliceAwaitingMeasure(transcriptWindow.items || [], frameColumns, toolOutputExpanded);
  if (!holdCommittedMax) committedMaxScrollRowsRef.current = estimateMaxScrollRows;
  maxScrollRowsRef.current = committedMaxScrollRowsRef.current;
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
    suppressMeasuredRowHeights,
  };
  // The window memo is keyed on a structure signature that intentionally
  // ignores per-character growth of the streaming assistant text, so its
  // `items` slice can hold a STALE reference to the streaming item between
  // height changes. Re-slice the live `items` over the memo's stable bounds so
  // the on-screen text is always current while the windowing stays warm.
  const transcriptVisibleItems = (transcriptItems || []).slice(transcriptWindow.startIndex, transcriptWindow.endIndex);
  if (streamingTailItem && transcriptVisibleItems.length > 0) {
    const last = transcriptVisibleItems.length - 1;
    if (transcriptVisibleItems[last]?.id === streamingTailItem.id) {
      transcriptVisibleItems[last] = streamingTailItem;
    }
  }
  // The bottom meta band is spinner-only; a finished turn's done row renders
  // inline in scrollback like any other item — no filtering, no double-paint.
  const renderedTranscriptItems = transcriptVisibleItems;
  let overlayHintAttachItemIndex = -1;
  for (let i = renderedTranscriptItems.length - 1; i >= 0; i--) {
    const item = renderedTranscriptItems[i];
    if (item?.kind === 'tool' && shouldSuppressFullyFailedToolItem(item)) continue;
    overlayHintAttachItemIndex = i;
    break;
  }
  const transcriptTailPinned = Math.max(0, Number(transcriptWindow.effectiveScrollOffset) || 0) === 0;
  const overlayHintOnLastItem =
    overlayHintRequested &&
    floatingPanelRows <= 0 &&
    transcriptWindow.bottomSpacerRows === 0 &&
    transcriptTailPinned &&
    overlayHintAttachItemIndex >= 0;
  const overlayHintFallbackRow =
    overlayHintRequested && floatingPanelRows <= 0 && transcriptGuardRows > 0 && !overlayHintOnLastItem;
  const harvestInputs = {
    revision,
    settledItems,
    streamingTailItem,
    startIndex: transcriptWindow.startIndex,
    endIndex: transcriptWindow.endIndex,
    frameColumns,
    toolOutputExpanded,
    transcriptContentHeight,
    floatingPanelRows,
    overlayHintRequested,
    transcriptGuardRows,
    themeEpoch,
  };
  const scrollRefs = { transcriptAnchorRef, transcriptAnchorDirtyRef, scrollTargetRef, scrollPositionRef, followingRef };
  // ── Measured height harvest (every commit, no deps) ─────────────────────
  useLayoutEffect(() => {
    harvestMeasuredRows(measureStateRef.current, {
      dragActive: dragRef.current.active,
      inputs: harvestInputs,
      frameColumns,
      toolOutputExpanded,
      bumpMeasuredRowsVersion: () => setMeasuredRowsVersion((v) => (v + 1) % 1000000),
    });
  });
  // ── Bottom-follow / anchor post-commit sync ─────────────────────────────
  useLayoutEffect(() => {
    const totalRows = Math.max(0, Number(transcriptWindow.totalRows) || 0);
    const previousTotalRows = Math.max(0, Number(transcriptTotalRowsRef.current) || 0);
    transcriptTotalRowsRef.current = totalRows;
    syncReadingAnchorAfterCommit({
      refs: scrollRefs,
      dragActive: dragRef.current.active,
      totalRows,
      previousTotalRows,
      rowIndex: transcriptRowIndex,
      items: transcriptItems,
      viewRows: transcriptContentHeight,
      maxRows: transcriptWindow.maxScrollRows,
      scrollOffset,
      setScrollOffset,
      stopSmoothScroll,
    });
  }, [
    transcriptWindow.totalRows,
    transcriptWindow.maxScrollRows,
    transcriptRowIndex,
    transcriptContentHeight,
    scrollOffset,
    stopSmoothScroll,
  ]);
  useLayoutEffect(() => {
    resetScrollWhenUnanchored(scrollRefs, { scrollOffset, setScrollOffset, stopSmoothScroll });
  }, [scrollOffset, stopSmoothScroll]);
  // ── Selection layout shift ──────────────────────────────────────────────
  useLayoutEffect(() => {
    const top = Math.max(0, Number(transcriptViewportRef.current?.top) || 0);
    const next = {
      top,
      height: Math.max(1, Number(transcriptContentHeight) || 1),
      totalRows: Math.max(0, Number(transcriptWindow.totalRows) || 0),
      scrollOffset: Math.max(0, Number(transcriptWindow.effectiveScrollOffset) || 0),
    };
    const previous = selectionLayoutRef.current;
    selectionLayoutRef.current = next;
    if (!previous || !dragRef.current.rect || dragRef.current.active) return;
    const deltaY =
      next.top -
      previous.top +
      (next.height - previous.height) -
      (next.totalRows - previous.totalRows) +
      (next.scrollOffset - previous.scrollOffset);
    if (deltaY === 0) return;
    const clippedRect = withSelectionClip(shiftSelectionRectY(dragRef.current.rect, deltaY));
    dragRef.current = { ...dragRef.current, rect: clippedRect };
    // rememberText:false — the shifted rect is viewport-clipped, so harvesting
    // here would replace the full selection text remembered at drag-release
    // with only the still-visible fragment (partial Ctrl+C after scrolling).
    paintSelectionRect(clippedRect, { rememberText: false, immediate: true });
  }, [
    transcriptContentHeight,
    transcriptWindow.totalRows,
    transcriptWindow.effectiveScrollOffset,
    withSelectionClip,
    paintSelectionRect,
  ]);
  useEffect(() => {
    if (!dragRef.current.rect) return;
    const clippedRect = withSelectionClip(dragRef.current.rect);
    dragRef.current = { ...dragRef.current, rect: clippedRect };
    // Theme repaint: same cells, same text — no need to re-harvest (and a
    // clipped rect would clobber the remembered full text with a fragment).
    paintSelectionRect(clippedRect, { rememberText: false, immediate: true });
  }, [themeEpoch, withSelectionClip, paintSelectionRect]);
  useEffect(() => {
    clampScrollToOverflow(scrollRefs, {
      maxRows: transcriptWindow.maxScrollRows,
      scrollOffset,
      setScrollOffset,
      stopSmoothScroll,
    });
  }, [transcriptWindow.maxScrollRows, scrollOffset, stopSmoothScroll]);

  return {
    transcriptWindow,
    renderedTranscriptItems,
    transcriptTailPinned,
    overlayHintAttachItemIndex,
    overlayHintOnLastItem,
    overlayHintFallbackRow,
    transcriptMeasureRef,
  };
}
