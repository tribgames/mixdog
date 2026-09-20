/**
 * use-transcript-window.mjs — transcript row-index/window memo chain plus the
 * measured-height harvest and reading-anchor lock effects.
 *
 * The render-time anchor arithmetic lives in transcript-anchor-lock.mjs, the
 * Yoga height harvest in transcript-measure.mjs and the post-commit scroll
 * sync in transcript-anchor-sync.mjs. This hook owns the effect ORDER
 * (harvest → anchor sync → clamp → selection shift). Scroll/anchor/drag refs
 * stay App-owned (injected).
 *
 *   use-transcript-window/instance-state.mjs  — per-instance caches + session reset
 *   use-transcript-window/geometry.mjs        — memo chain + published geometry
 *   use-transcript-window/visible-items.mjs   — on-screen slice, overlay hint placement
 *   use-transcript-window/selection-shift.mjs — selection rect follows geometry/theme
 */
import { useCallback, useEffect, useLayoutEffect } from 'react';
import { harvestMeasuredRows, measureRefFor } from './transcript-measure.mjs';
import {
  clampScrollToOverflow,
  resetScrollWhenUnanchored,
  syncReadingAnchorAfterCommit,
} from './transcript-anchor-sync.mjs';
import { useTranscriptInstanceState } from './use-transcript-window/instance-state.mjs';
import { useTranscriptGeometry } from './use-transcript-window/geometry.mjs';
import { overlayHintPlacement, visibleTranscriptItems } from './use-transcript-window/visible-items.mjs';
import { useSelectionLayoutShift } from './use-transcript-window/selection-shift.mjs';

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
  const refs = {
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    scrollTargetRef,
    scrollPositionRef,
    maxScrollRowsRef,
    transcriptGeomRef,
    followingRef,
    selectionLayoutRef,
  };
  const state = useTranscriptInstanceState({ sessionKey, scrollOffset, setScrollOffset, refs });
  const transcriptMeasureRef = useCallback((item) => measureRefFor(state.measureStateRef.current, item), []);
  const { revision, streamingTailItem, transcriptItems, transcriptRowIndex, transcriptWindow } = useTranscriptGeometry(
    state,
    {
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
    }
  );
  const renderedTranscriptItems = visibleTranscriptItems(transcriptItems, transcriptWindow, streamingTailItem);
  const overlayHint = overlayHintPlacement(renderedTranscriptItems, transcriptWindow, {
    overlayHintRequested,
    floatingPanelRows,
    transcriptGuardRows,
  });
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
  const scrollRefs = {
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    scrollTargetRef,
    scrollPositionRef,
    followingRef,
  };
  // ── Measured height harvest (every commit, no deps) ─────────────────────
  useLayoutEffect(() => {
    harvestMeasuredRows(state.measureStateRef.current, {
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
    const previousTotalRows = Math.max(0, Number(state.transcriptTotalRowsRef.current) || 0);
    state.transcriptTotalRowsRef.current = totalRows;
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
  useSelectionLayoutShift({
    transcriptWindow,
    transcriptContentHeight,
    themeEpoch,
    transcriptViewportRef,
    selectionLayoutRef,
    dragRef,
    withSelectionClip,
    paintSelectionRect,
  });
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
    transcriptTailPinned: overlayHint.tailPinned,
    overlayHintAttachItemIndex: overlayHint.attachItemIndex,
    overlayHintOnLastItem: overlayHint.onLastItem,
    overlayHintFallbackRow: overlayHint.fallbackRow,
    transcriptMeasureRef,
  };
}
