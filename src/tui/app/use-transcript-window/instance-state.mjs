/**
 * instance-state.mjs — the per-hook-instance caches of one transcript window
 * and their atomic reset when the mounted hook switches session.
 */
import { useLayoutEffect, useRef } from 'react';
import { createMeasureState, resetMeasureState } from '../transcript-measure.mjs';

function freshViewportGeom() {
  return { contentHeight: 0, floatingPanelRows: 0 };
}

export function useTranscriptInstanceState({ sessionKey, scrollOffset, setScrollOffset, refs }) {
  const {
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    scrollTargetRef,
    scrollPositionRef,
    maxScrollRowsRef,
    transcriptGeomRef,
    followingRef,
    selectionLayoutRef,
  } = refs;
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

  return {
    transcriptTotalRowsRef,
    committedMaxScrollRowsRef,
    incrementalRowIndexCacheRef,
    transcriptItemsCacheRef,
    prevViewportGeomRef,
    measureStateRef,
  };
}
