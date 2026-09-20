/**
 * use-transcript-scroll.mjs — transcript scroll + ink-grid selection engine.
 *
 * Composes the follow/glide state (use-transcript-follow), the selection
 * stitch buffer (use-selection-stitch), selection painting
 * (use-selection-paint), selection geometry (use-selection-geometry) and
 * keyboard focus movement (use-selection-focus) around the one manual-scroll
 * primitive this file owns: scrollTranscriptRows (history paging, bottom
 * snap, readback preservation, reading-anchor capture, selection tracking)
 * plus its wheel/edge-drag coalescer. Scroll/drag state refs stay App-owned
 * and are injected; the hooks own only their internal timers.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { SCROLL_COALESCE_MS, accumulateDirectionalScrollDelta, shiftSelectionRectY } from './transcript-window.mjs';
import { bottomSnapRows, readingAnchorAt } from './transcript-scroll-anchor.mjs';
import { useSelectionStitchBuffer } from './use-selection-stitch.mjs';
import { useTranscriptFollow } from './use-transcript-follow.mjs';
import { useSelectionPaint } from './use-selection-paint.mjs';
import { useSelectionGeometry } from './use-selection-geometry.mjs';
import { useSelectionFocusMove } from './use-selection-focus.mjs';

// Leading-edge coalescer for edge-drag auto-scroll + wheel deltas: the first
// delta after an idle period flushes immediately (single wheel ticks/short
// drags stay responsive), while a flood of deltas within SCROLL_COALESCE_MS
// accumulates into one scrollTranscriptRows call per tick instead of one per
// mousemove/wheel event.
function useScrollCoalescer(scrollTranscriptRows) {
  const scrollCoalesceRef = useRef({ pendingRows: 0, direction: 0, timer: null });
  useEffect(
    () => () => {
      const state = scrollCoalesceRef.current;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.pendingRows = 0;
      state.direction = 0;
    },
    []
  );
  return useCallback(
    (deltaRows) => {
      const state = scrollCoalesceRef.current;
      const reversed = accumulateDirectionalScrollDelta(state, deltaRows);
      if (reversed && state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      if (state.timer) return;
      const rows = state.pendingRows;
      state.pendingRows = 0;
      scrollTranscriptRows(rows);
      state.timer = setTimeout(() => {
        state.timer = null;
        state.direction = 0;
        if (state.pendingRows !== 0) {
          const remaining = state.pendingRows;
          state.pendingRows = 0;
          scrollTranscriptRows(remaining);
        }
      }, SCROLL_COALESCE_MS);
      state.timer.unref?.();
    },
    [scrollTranscriptRows]
  );
}

export function useTranscriptScroll({
  store,
  frameColumns,
  statuslineBandRows,
  setScrollOffset,
  scrollPositionRef,
  scrollTargetRef,
  maxScrollRowsRef,
  transcriptBottomSlackRowsRef,
  followingRef,
  transcriptAnchorRef,
  transcriptAnchorDirtyRef,
  transcriptGeomRef,
  dragRef,
  frameRowsRef,
  transcriptViewportRef,
  selectionLayoutRef,
  selectionTextRef,
}) {
  const { clearStitchBuffer, harvestStitchRowsSoon, harvestStitchRowsNow, getStitchedSelectionText } =
    useSelectionStitchBuffer({ store, dragRef, scrollTargetRef });
  const {
    pendingReadbackRowsRef,
    stopSmoothScroll,
    startSmoothScroll,
    cancelTranscriptFollow,
    resetTranscriptScroll,
    armTranscriptFollow,
  } = useTranscriptFollow({
    scrollPositionRef,
    scrollTargetRef,
    followingRef,
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    setScrollOffset,
  });
  const {
    withSelectionClip,
    paintSelectionRect,
    cancelPendingSelectionPaint,
    flushPendingSelectionPaint,
    applySelectionRect,
    applySelectionRectThrottled,
  } = useSelectionPaint({
    store,
    statuslineBandRows,
    dragRef,
    frameRowsRef,
    transcriptViewportRef,
    selectionTextRef,
    harvestStitchRowsSoon,
    clearStitchBuffer,
  });
  const {
    selectionPointAtCurrentScroll,
    buildSpanRect,
    transcriptViewportRows,
    statusBandRows,
    selectionMaxColAtRow,
    gridSelectionActiveRef,
  } = useSelectionGeometry({
    store,
    frameColumns,
    statuslineBandRows,
    scrollTargetRef,
    frameRowsRef,
    transcriptViewportRef,
    dragRef,
  });

  // Reading anchor for the row currently at the top of the viewport, from the
  // latest published geometry. A miss leaves the existing anchor untouched.
  const captureRestoreAnchor = useCallback(() => {
    const anchor = readingAnchorAt(transcriptGeomRef.current || {}, scrollTargetRef.current);
    if (!anchor) return;
    transcriptAnchorRef.current = anchor;
    transcriptAnchorDirtyRef.current = false;
  }, []);

  // A manual scroll moves the reading position. Capture the new anchor
  // SYNCHRONOUSLY from the latest published geometry so the very next render
  // already locks to it — no one-frame "dirty" window where concurrent
  // streaming growth could lurch the view. Only at the true bottom drop the
  // anchor so the bottom-follow path owns the viewport again: a positive
  // wheel offset is an explicit reading position, even inside the old slack.
  const captureReadingAnchor = useCallback((target) => {
    if (target === 0) {
      transcriptAnchorRef.current = null;
      transcriptAnchorDirtyRef.current = false;
      return;
    }
    const anchor = readingAnchorAt(transcriptGeomRef.current || {}, target);
    if (anchor) {
      transcriptAnchorRef.current = anchor;
      transcriptAnchorDirtyRef.current = false;
    } else {
      transcriptAnchorDirtyRef.current = true;
    }
  }, []);

  // Scrolling past the oldest/newest loaded edge pages transcript history
  // instead of moving the target. Returns true when the edge owned the
  // gesture (whether or not a page was restored).
  const pageTranscriptHistory = useCallback(
    (deltaRows, maxTarget) => {
      const historyState = store.getState?.() || {};
      const pastOldest = deltaRows > 0 && scrollTargetRef.current >= maxTarget && historyState.transcriptHistoryBefore;
      const pastNewest = deltaRows < 0 && scrollTargetRef.current <= 0 && historyState.transcriptHistoryAfter;
      if (!pastOldest && !pastNewest) return false;
      captureRestoreAnchor();
      const restored = pastOldest ? store.restoreOlderTranscript?.() : store.restoreNewerTranscript?.();
      if (!restored) return true;
      stopSmoothScroll();
      cancelTranscriptFollow();
      if (pastNewest) {
        // The shared overlap now sits at the OLDEST edge of the newer page.
        // Keep a positive target so the render-time absolute anchor lock
        // remains active and resolves that row instead of treating target=0
        // as tail-pin.
        const anchoredTarget = Math.max(1, maxTarget);
        scrollTargetRef.current = anchoredTarget;
        scrollPositionRef.current = anchoredTarget;
        setScrollOffset(anchoredTarget);
      }
      return true;
    },
    [store, captureRestoreAnchor, stopSmoothScroll, cancelTranscriptFollow]
  );

  // Keep a live selection on its content after the viewport moved. An active
  // drag rebuilds from its anchor (span-aware: a word/line multi-click drag
  // that reached the edge keeps extending by whole words/lines, NOT collapsing
  // to a char {anchor->last} rect, mirroring the motion path); a released
  // selection simply shifts with the delta.
  const rebuildSelectionAfterScroll = useCallback(
    (appliedDelta) => {
      let rect;
      if (dragRef.current.active) {
        const { anchor, anchorScroll, last, anchorSpan, region } = dragRef.current;
        if (anchorSpan && last) {
          rect = buildSpanRect(anchorSpan, last.x, last.y, region, anchorScroll);
        } else {
          const currentAnchor = selectionPointAtCurrentScroll(anchor, anchorScroll);
          rect =
            currentAnchor && last
              ? { mode: 'linear', x1: currentAnchor.x, y1: currentAnchor.y, x2: last.x, y2: last.y }
              : null;
        }
      } else {
        rect = shiftSelectionRectY(dragRef.current.rect, appliedDelta);
      }
      // Active-drag rebuild paints directly, so route through the themed clip
      // (captureText:false, matching rememberText:false below) — a bare rect
      // without selectionBackground falls back to a near-white full-width block
      // with vanishing text in Ink's output renderer. Also cancel any armed
      // throttled repaint first: it would fire the pre-scroll rect AFTER this
      // one, leaving two coexisting highlights.
      const clippedRect = dragRef.current.active
        ? withSelectionClip(rect, { captureText: false })
        : withSelectionClip(rect);
      dragRef.current = { ...dragRef.current, rect: clippedRect };
      cancelPendingSelectionPaint();
      // Never re-harvest selection text from a scroll-shifted rect: the shift
      // clips the rect to the viewport, so a harvest here would OVERWRITE the
      // full text remembered at drag-release with only the still-visible rows
      // (Ctrl+C after scrolling then copied just that fragment).
      paintSelectionRect(clippedRect, { rememberText: false });
    },
    [buildSpanRect, selectionPointAtCurrentScroll, withSelectionClip, cancelPendingSelectionPaint, paintSelectionRect]
  );

  const scrollTranscriptRows = useCallback(
    (deltaRows, options = {}) => {
      const maxTarget = Math.max(0, Number(maxScrollRowsRef.current) || 0);
      const publishedGeometry = transcriptGeomRef.current || {};
      const geometryMax = Math.max(
        0,
        (Number(publishedGeometry.totalRows) || 0) - Math.max(1, Number(publishedGeometry.viewRows) || 1)
      );
      if (pageTranscriptHistory(deltaRows, maxTarget)) return;
      let target = Math.max(0, Math.min(maxTarget, scrollTargetRef.current + deltaRows));
      if (deltaRows < 0 && target > 0 && target <= bottomSnapRows(publishedGeometry.viewRows)) target = 0;
      const appliedDelta = target - scrollTargetRef.current;
      const blockedReadbackIntent = deltaRows > 0 && appliedDelta === 0 && maxTarget === 0 && geometryMax > 0;
      if (blockedReadbackIntent) {
        // A newly mounted row can hold the committed max at zero for one frame.
        // Preserve the first upward wheel/keyboard intent instead of letting the
        // next item/measurement commit infer bottom-follow from target=0 and yank
        // the viewport back. The layout effect below applies it before paint as
        // soon as the committed range becomes available.
        pendingReadbackRowsRef.current += deltaRows;
      } else if (deltaRows < 0 || appliedDelta !== 0) {
        pendingReadbackRowsRef.current = 0;
      }
      // Before the scroll moves selected rows out of view, snapshot the rows
      // currently under the selection into the stitch buffer keyed by the
      // PRE-scroll offset. Runs for BOTH an active drag and a wheel-shift of a
      // released selection, so Ctrl+C reconstructs the full text no matter how
      // far it scrolled off-screen. Commit any pending throttled rect first so
      // the harvest reads the newest rendered selection.
      if (appliedDelta !== 0 && dragRef.current.region === 'transcript' && dragRef.current.rect) {
        flushPendingSelectionPaint();
        harvestStitchRowsNow(Number(scrollTargetRef.current) || 0);
      }
      // Any manual wheel/keyboard scroll takes precedence over an in-flight
      // transcript follow: drop the glide so the user's intent wins.
      if (appliedDelta !== 0 || blockedReadbackIntent) cancelTranscriptFollow();
      scrollTargetRef.current = target;
      // A downward gesture that ENDS at the tail re-arms follow even when it
      // moved nothing (appliedDelta === 0). "Wheel/PageDown while already at the
      // bottom" is the most common way a user asks to resume following, and an
      // appliedDelta gate made it a no-op: follow stayed off, the next growth
      // commit captured a reading anchor, and new output piled up below the
      // fold with no way back except submitting a prompt.
      if (deltaRows < 0 && target === 0) {
        transcriptAnchorRef.current = null;
        transcriptAnchorDirtyRef.current = false;
        followingRef.current = true;
      }
      if (appliedDelta !== 0) captureReadingAnchor(target);
      if (appliedDelta !== 0 && selectionLayoutRef.current) {
        selectionLayoutRef.current = { ...selectionLayoutRef.current, scrollOffset: target };
      }
      if (appliedDelta !== 0 && dragRef.current.rect) rebuildSelectionAfterScroll(appliedDelta);
      if (options.smooth) {
        startSmoothScroll();
        return;
      }
      stopSmoothScroll();
      scrollPositionRef.current = target;
      setScrollOffset(Math.round(target));
    },
    [
      pageTranscriptHistory,
      captureReadingAnchor,
      rebuildSelectionAfterScroll,
      startSmoothScroll,
      stopSmoothScroll,
      cancelTranscriptFollow,
      harvestStitchRowsNow,
      flushPendingSelectionPaint,
    ]
  );

  useLayoutEffect(() => {
    const pendingRows = Math.max(0, Number(pendingReadbackRowsRef.current) || 0);
    if (pendingRows <= 0 || Math.max(0, Number(maxScrollRowsRef.current) || 0) <= 0) return;
    pendingReadbackRowsRef.current = 0;
    scrollTranscriptRows(pendingRows);
  });

  const queueScrollCoalesced = useScrollCoalescer(scrollTranscriptRows);

  const moveSelectionFocus = useSelectionFocusMove({
    dragRef,
    scrollTargetRef,
    transcriptBottomSlackRowsRef,
    statusBandRows,
    transcriptViewportRows,
    selectionMaxColAtRow,
    scrollTranscriptRows,
    applySelectionRect,
  });

  return {
    stopSmoothScroll,
    resetTranscriptScroll,
    armTranscriptFollow,
    withSelectionClip,
    paintSelectionRect,
    applySelectionRect,
    applySelectionRectThrottled,
    selectionPointAtCurrentScroll,
    buildSpanRect,
    gridSelectionActiveRef,
    scrollTranscriptRows,
    queueScrollCoalesced,
    moveSelectionFocus,
    getStitchedSelectionText,
    clearStitchBuffer,
  };
}
