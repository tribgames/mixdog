/**
 * use-transcript-scroll.mjs — transcript scroll + ink-grid selection engine.
 *
 * Extracted verbatim from App.jsx: smooth scroll animation, reading-anchor
 * capture, selection painting/throttling/clipping, word-line span extension,
 * keyboard selection focus movement and the wheel/edge-drag coalescer.
 * Scroll/drag state refs stay App-owned and are injected; this hook owns only
 * its internal timers (animation interval, selection paint throttle, text
 * capture defer, scroll coalescer).
 */
import { useCallback, useEffect, useRef } from 'react';
import { theme } from '../theme.mjs';
import {
  SELECTION_PAINT_INTERVAL_MS,
  SCROLL_COALESCE_MS,
  selectionRectsEqual,
  shiftSelectionRectY,
  comparePoints,
  upperBound,
} from './transcript-window.mjs';

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
  const scrollAnimationRef = useRef(null);
  const selectionPaintRef = useRef({ t: 0, rect: null, pending: null, timer: null });
  // Coalescer for edge-drag auto-scroll + wheel scroll deltas (see
  // SCROLL_COALESCE_MS). Both call sites accumulate into pendingRows.
  const scrollCoalesceRef = useRef({ pendingRows: 0, timer: null });
  const selectionTextTimerRef = useRef(null);
  // Stitch buffer: accumulates harvested transcript selection rows across scroll
  // positions so Ctrl+C copies the FULL drag even after it auto-scrolled past the
  // viewport. Keyed by scroll-invariant content row = screenY - scrollTarget at
  // harvest time; value = row text. Only transcript-region drags accumulate.
  const stitchBufferRef = useRef(new Map());
  const stitchHarvestTimerRef = useRef(null);
  // Scroll offset captured at the SCHEDULE (paint) time of the pending harvest —
  // the deferred timer must key rows by the frame's scroll, not by whatever
  // scrollTargetRef holds when the timer eventually fires (a scroll in between
  // would mis-key the rows). Latest schedule wins (latest paint = latest frame).
  const stitchHarvestScrollRef = useRef(0);

  const clearStitchBuffer = useCallback(() => {
    stitchBufferRef.current.clear();
    if (stitchHarvestTimerRef.current) {
      clearTimeout(stitchHarvestTimerRef.current);
      stitchHarvestTimerRef.current = null;
    }
  }, []);

  // Deferred (like rememberSelectionTextSoon) harvest of the currently visible
  // selection rows into the stitch buffer. Runs on EVERY transcript selection
  // paint AND on scroll-shift repaints (the rememberText:false path) so rows
  // revealed only mid-scroll are captured. Later harvest of a key overwrites,
  // handling partial↔full endpoint rows on retraction.
  const harvestStitchRowsSoon = useCallback(() => {
    if (dragRef.current.region !== 'transcript') return;
    // Capture the scroll offset for THIS paint (schedule time). If a timer is
    // already pending, only refresh the captured offset to the latest frame and
    // reuse the existing timer.
    stitchHarvestScrollRef.current = Number(scrollTargetRef.current) || 0;
    if (stitchHarvestTimerRef.current) return;
    stitchHarvestTimerRef.current = setTimeout(() => {
      stitchHarvestTimerRef.current = null;
      if (dragRef.current.region !== 'transcript') return;
      const rows = store.getRenderSelectionRows?.();
      if (!Array.isArray(rows)) return;
      const scroll = stitchHarvestScrollRef.current;
      for (const row of rows) {
        if (!row || typeof row.y !== 'number') continue;
        // Store text AND the soft-wrap continuation flag so the stitch join can
        // rejoin word-wrapped rows into their logical line (mirrors output.js).
        stitchBufferRef.current.set(row.y - scroll, {
          text: typeof row.text === 'string' ? row.text : '',
          sw: row.sw === true,
        });
      }
    }, 0);
  }, [store]);

  // Synchronous sibling of harvestStitchRowsSoon: snapshot the rows CURRENTLY
  // under the selection into the stitch buffer immediately, keyed by the given
  // (pre-scroll) offset. Called right before a scroll shifts those rows out of
  // view — mirrors selection.ts captureScrolledRows, which grabs the outgoing
  // rows BEFORE scrollBy overwrites them. The deferred harvest could never see
  // rows that a fast drag/wheel scrolled past between paint and its setTimeout.
  // selectionRows is harvested by the renderer UNCONDITIONALLY (even on the
  // captureText:false motion paints, output.js), so this works mid-drag.
  const harvestStitchRowsNow = useCallback((scroll) => {
    if (dragRef.current.region !== 'transcript') return;
    const rows = store.getRenderSelectionRows?.();
    if (!Array.isArray(rows)) return;
    const s = Number(scroll) || 0;
    for (const row of rows) {
      if (!row || typeof row.y !== 'number') continue;
      stitchBufferRef.current.set(row.y - s, {
        text: typeof row.text === 'string' ? row.text : '',
        sw: row.sw === true,
      });
    }
  }, [store]);

  // Map the CURRENT rect + current scrollTarget onto the content-key range and
  // join buffered rows sorted by key with '\n'. Returns { text, complete }:
  // `complete` is true only when the harvested keys covering the selection form
  // a CONTIGUOUS run (no interior gap). The old code silently skipped missing
  // keys and returned only the string, so a gap (a scrolled-off row that was
  // never harvested) produced a stitched copy with a line dropped in the middle
  // — a mangled, shorter-than-real result the caller then preferred purely on
  // length. Callers must gate on `complete` before preferring the stitch.
  // Returns { text: '', complete: false } when unusable so callers fall back to
  // render/remembered text.
  const getStitchedSelectionText = useCallback(() => {
    const empty = { text: '', complete: false };
    const buf = stitchBufferRef.current;
    if (!buf.size) return empty;
    if (dragRef.current.region !== 'transcript') return empty;
    const rect = dragRef.current.rect;
    if (!rect) return empty;
    const y1 = Number(rect.y1);
    const y2 = Number(rect.y2);
    if (!Number.isFinite(y1) || !Number.isFinite(y2)) return empty;
    const scroll = Number(scrollTargetRef.current) || 0;
    const lo = Math.min(y1, y2) - scroll;
    const hi = Math.max(y1, y2) - scroll;
    const keys = [...buf.keys()].filter((k) => k >= lo && k <= hi).sort((a, b) => a - b);
    if (!keys.length) return empty;
    // FULL coverage of the selection's [lo..hi] row range with no hole. Keys are
    // already filtered to [lo..hi] and unique, so a count equal to the range
    // size means every selected row is present (interior AND both endpoints).
    // Internal contiguity alone was not enough: an endpoint-missing stitch (e.g.
    // the top/bottom selected row never harvested) is internally contiguous yet
    // drops a boundary line, so it must NOT be marked complete and win in copy.
    const complete = keys.length === hi - lo + 1;
    // SOFT-WRAP JOIN (same rule as output.js getSelectedText): a row whose sw
    // flag is set is a word-wrap continuation — concatenate it onto the prior
    // logical line WITHOUT a newline; only source/hard breaks emit '\n'. Blank
    // inner rows ('' text) survive as empty logical lines (paragraph gaps).
    // Trailing whitespace is trimmed once per logical-line end.
    const logical = [];
    for (const k of keys) {
      const entry = buf.get(k);
      if (entry == null) continue;
      const t = typeof entry === 'string' ? entry : (entry.text ?? '');
      const sw = typeof entry === 'string' ? false : entry.sw === true;
      if (sw && logical.length > 0) logical[logical.length - 1] += t;
      else logical.push(t);
    }
    const text = logical.map((l) => l.replace(/\s+$/u, '')).join('\n');
    return text.trim() ? { text, complete } : empty;
  }, []);

  const stopSmoothScroll = useCallback(() => {
    if (!scrollAnimationRef.current) return;
    clearInterval(scrollAnimationRef.current);
    scrollAnimationRef.current = null;
  }, []);

  const startSmoothScroll = useCallback(() => {
    if (scrollAnimationRef.current) return;
    scrollAnimationRef.current = setInterval(() => {
      const current = scrollPositionRef.current;
      const target = scrollTargetRef.current;
      const next = current + (target - current) * 0.32;
      if (Math.abs(target - next) < 0.12) {
        scrollPositionRef.current = target;
        setScrollOffset(Math.max(0, Math.round(target)));
        followingRef.current = false;
        stopSmoothScroll();
        return;
      }
      scrollPositionRef.current = Math.max(0, next);
      setScrollOffset(Math.max(0, Math.round(scrollPositionRef.current)));
    }, 16);
    scrollAnimationRef.current.unref?.();
  }, [stopSmoothScroll]);

  const cancelTranscriptFollow = useCallback(() => {
    followingRef.current = false;
  }, []);

  const resetTranscriptScroll = useCallback(() => {
    cancelTranscriptFollow();
    stopSmoothScroll();
    scrollPositionRef.current = 0;
    scrollTargetRef.current = 0;
    transcriptAnchorRef.current = null;
    transcriptAnchorDirtyRef.current = false;
    setScrollOffset(0);
  }, [stopSmoothScroll, cancelTranscriptFollow]);

  const armTranscriptFollow = useCallback(() => {
    // Do not mutate scrollOffset here. During prompt submit the transcript rows
    // have not necessarily been committed yet; resetting immediately makes a
    // long transcript jump to the bottom, then jump again when the new row is
    // appended. Keep the current viewport stable and let the row-delta effect
    // perform the single bottom-follow when the transcript actually grows.
    transcriptAnchorRef.current = null;
    transcriptAnchorDirtyRef.current = false;
    followingRef.current = true;
    stopSmoothScroll();
  }, [stopSmoothScroll]);

  const rememberSelectionTextSoon = useCallback(() => {
    if (selectionTextTimerRef.current) return;
    selectionTextTimerRef.current = setTimeout(() => {
      selectionTextTimerRef.current = null;
      const text = store.getRenderSelectionText?.();
      if (text && text.trim()) selectionTextRef.current = text;
    }, 0);
  }, [store]);

  const selectionClip = useCallback(() => {
    // The status-bar grid selection lives in the bottom statusline band, not the
    // transcript viewport — clip there so the highlight cannot spill into the
    // prompt/transcript rows. Everything else (transcript, word-select) keeps the
    // transcript-viewport clip.
    if (dragRef.current.region === 'status') {
      const rows = Math.max(1, Number(frameRowsRef.current) || 24);
      const top = Math.max(0, rows - statuslineBandRows);
      return { y1: top, y2: Math.max(top, rows - 1) };
    }
    return {
      y1: Math.max(0, Number(transcriptViewportRef.current?.top) || 0),
      y2: Math.max(0, Number(transcriptViewportRef.current?.bottom) || 0),
    };
  }, []);

  const withSelectionClip = useCallback((rect, options = {}) => {
    if (!rect) return null;
    const clip = selectionClip();
    const clipped = {
      ...rect,
      clipY1: clip.y1,
      clipY2: Math.max(clip.y1, clip.y2),
      selectionForeground: theme.selectionHighlightText || theme.selectionText,
      selectionBackground: theme.selectionHighlightBackground || theme.selectionBackground,
    };
    if (options.captureText === false) clipped.captureText = false;
    return clipped;
  }, [selectionClip]);

  const paintSelectionRect = useCallback((clippedRect, { rememberText = true, immediate = false } = {}) => {
    const nextRect = clippedRect || null;
    const state = selectionPaintRef.current;
    if (selectionRectsEqual(state.rect, nextRect)) {
      const needsCapture = nextRect && rememberText && nextRect.captureText !== false;
      if (!immediate && !needsCapture) return false;
      if (immediate || needsCapture) {
        store.setRenderSelection?.(nextRect, { immediate: true });
      }
      if (needsCapture) rememberSelectionTextSoon();
      if (nextRect) harvestStitchRowsSoon();
      return true;
    }
    state.rect = nextRect;
    state.t = Date.now();
    store.setRenderSelection?.(nextRect, immediate ? { immediate: true } : undefined);
    if (nextRect && rememberText && nextRect.captureText !== false) rememberSelectionTextSoon();
    if (nextRect) harvestStitchRowsSoon();
    return true;
  }, [store, rememberSelectionTextSoon, harvestStitchRowsSoon]);

  // Shared guard for EVERY direct (non-throttled) paint path: a pending
  // throttled repaint (state.timer/state.pending, armed by
  // applySelectionRectThrottled) would fire AFTER a direct paint and stamp a
  // stale pre-scroll/pre-direction rect over the current one — surfacing as two
  // coexisting highlights. Cancel it before any direct paint.
  const cancelPendingSelectionPaint = useCallback(() => {
    const state = selectionPaintRef.current;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pending = null;
  }, []);

  // Commit an armed-but-unpainted throttled rect NOW, so paths that read the
  // rendered selection (the pre-scroll stitch harvest) see the newest fast-drag
  // rect rather than the previous rendered one. Cancel-only would drop the
  // pending rect and lose rows it covered that scroll off before the rebuild.
  const flushPendingSelectionPaint = useCallback(() => {
    const state = selectionPaintRef.current;
    if (!state.timer && !state.pending) return;
    const pending = state.pending;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pending = null;
    if (pending) paintSelectionRect(pending, { rememberText: false, immediate: true });
  }, [paintSelectionRect]);

  const applySelectionRect = useCallback((rect) => {
    const clippedRect = withSelectionClip(rect);
    dragRef.current.rect = clippedRect || null;
    if (!clippedRect) {
      selectionTextRef.current = '';
      clearStitchBuffer();
    }
    cancelPendingSelectionPaint();
    paintSelectionRect(clippedRect, { rememberText: true, immediate: true });
  }, [paintSelectionRect, withSelectionClip, clearStitchBuffer, cancelPendingSelectionPaint]);

  const applySelectionRectThrottled = useCallback((rect) => {
    const clippedRect = withSelectionClip(rect, { captureText: false });
    if (selectionRectsEqual(dragRef.current.rect, clippedRect)) return;
    dragRef.current.rect = clippedRect || null;
    const state = selectionPaintRef.current;
    if (selectionRectsEqual(state.rect, clippedRect)) return;
    const now = Date.now();
    const elapsed = now - state.t;
    if (elapsed >= SELECTION_PAINT_INTERVAL_MS) {
      cancelPendingSelectionPaint();
      paintSelectionRect(clippedRect, { rememberText: false });
      return;
    }
    state.pending = clippedRect || null;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        const current = selectionPaintRef.current;
        const pending = current.pending;
        current.timer = null;
        current.pending = null;
        paintSelectionRect(pending, { rememberText: false });
      }, Math.max(1, SELECTION_PAINT_INTERVAL_MS - elapsed));
      state.timer.unref?.();
    }
  }, [paintSelectionRect, withSelectionClip, cancelPendingSelectionPaint]);

  const selectionPointAtCurrentScroll = useCallback((point, pointScroll = 0) => {
    if (!point) return null;
    return {
      x: point.x,
      y: point.y + (Number(scrollTargetRef.current) || 0) - (Number(pointScroll) || 0),
    };
  }, []);

  // Port of selection.ts extendSelection onto the linear-rect model, hoisted to
  // component scope so BOTH the mouse handler (motion/release) AND the
  // auto-scroll path (scrollTranscriptRows) can rebuild a span-aware rect. Grows
  // a word/line multi-click selection from its anchor span to the word/line under
  // the cursor: target ends before the span → extend backward (span.hi→targetLo);
  // target starts after → extend forward (span.lo→targetHi); overlapping → the
  // span. The moving end snaps to the word (getWordRectAt) or line (getLineRectAt)
  // at the cursor; a miss (blank/gutter) falls back to the raw cell. spanScroll
  // re-anchors the span to the current transcript scroll (status never scrolls) so
  // the original word/line tracks the content while dragging/auto-scrolling.
  const buildSpanRect = useCallback((span, x, y, region, spanScroll = 0) => {
    const conv = (pt) => (region === 'status' ? pt : selectionPointAtCurrentScroll(pt, spanScroll));
    const spanLo = conv(span.lo);
    const spanHi = conv(span.hi);
    let mLo;
    let mHi;
    if (span.kind === 'word') {
      const wr = store.getWordRectAt?.(x, y);
      if (wr) { mLo = { x: wr.x1, y: wr.y1 }; mHi = { x: wr.x2, y: wr.y2 }; }
      else { mLo = { x, y }; mHi = { x, y }; }
    } else {
      const lr = store.getLineRectAt?.(y);
      if (lr) { mLo = { x: lr.x1, y: lr.y1 }; mHi = { x: lr.x2, y: lr.y2 }; }
      else { mLo = { x: 0, y }; mHi = { x: Math.max(0, frameColumns - 1), y }; }
    }
    const rect = (a, b) => ({ mode: 'linear', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    if (comparePoints(mHi, spanLo) < 0) return rect(spanHi, mLo);
    if (comparePoints(mLo, spanHi) > 0) return rect(spanLo, mHi);
    return rect(spanLo, spanHi);
  }, [store, frameColumns, selectionPointAtCurrentScroll]);

  const transcriptViewportRows = useCallback(() => {
    const top = Math.max(0, Number(transcriptViewportRef.current?.top) || 0);
    const bottom = Math.max(top, Number(transcriptViewportRef.current?.bottom) || top);
    return { top, bottom };
  }, []);

  const statusBandRows = useCallback(() => {
    const rows = Math.max(1, Number(frameRowsRef.current) || 24);
    const top = Math.max(0, rows - statuslineBandRows);
    return { top, bottom: Math.max(top, rows - 1) };
  }, []);

  const selectionMaxColAtRow = useCallback((row) => {
    const lr = store.getLineRectAt?.(row);
    if (lr != null && Number.isFinite(lr.x2)) return Math.max(0, lr.x2);
    return Math.max(0, frameColumns - 1);
  }, [store, frameColumns]);

  // Synchronous predicate: is a transcript/status ink-grid selection live? Used
  // both by App (to consume Shift+Arrow even when focus clamps at an edge) and
  // by PromptInput (via prop) to gate its own Shift+Arrow at event time — a flag
  // set inside App's parent handler would be one event stale (parent handler
  // runs AFTER the child prompt handler for the same key).
  const gridSelectionActiveRef = useRef(() => {
    const drag = dragRef.current;
    if (!drag || drag.active) return false;
    if (drag.region !== 'transcript' && drag.region !== 'status') return false;
    const rect = drag.rect;
    return Boolean(rect) && !(rect.x1 === rect.x2 && rect.y1 === rect.y2);
  });

  useEffect(() => () => {
    const paintState = selectionPaintRef.current;
    if (paintState.timer) clearTimeout(paintState.timer);
    paintState.timer = null;
    paintState.pending = null;
    if (selectionTextTimerRef.current) clearTimeout(selectionTextTimerRef.current);
    selectionTextTimerRef.current = null;
    if (stitchHarvestTimerRef.current) clearTimeout(stitchHarvestTimerRef.current);
    stitchHarvestTimerRef.current = null;
    const coalesceState = scrollCoalesceRef.current;
    if (coalesceState.timer) clearTimeout(coalesceState.timer);
    coalesceState.timer = null;
    coalesceState.pendingRows = 0;
  }, []);

  const scrollTranscriptRows = useCallback((deltaRows, options = {}) => {
    const maxTarget = Math.max(0, Number(maxScrollRowsRef.current) || 0);
    const target = Math.max(0, Math.min(maxTarget, scrollTargetRef.current + deltaRows));
    const appliedDelta = target - scrollTargetRef.current;
    // Before the scroll moves selected rows out of view, snapshot the rows
    // currently under the selection into the stitch buffer keyed by the
    // PRE-scroll offset (ref selection.ts captureScrolledRows). Runs for BOTH
    // an active drag and a wheel-shift of a released selection, so Ctrl+C
    // reconstructs the full text no matter how far it scrolled off-screen.
    if (appliedDelta !== 0 && dragRef.current.region === 'transcript' && dragRef.current.rect) {
      // Commit any pending throttled rect first so the harvest reads the newest
      // rendered selection (not the previous rect) before those rows scroll off.
      flushPendingSelectionPaint();
      harvestStitchRowsNow(Number(scrollTargetRef.current) || 0);
    }
    // Any manual wheel/keyboard scroll takes precedence over an in-flight
    // transcript follow: drop the glide so the user's intent wins.
    if (appliedDelta !== 0) cancelTranscriptFollow();
    scrollTargetRef.current = target;
    // A manual scroll moves the reading position. Capture the new reading anchor
    // SYNCHRONOUSLY from the latest published geometry so the very next render
    // already locks to it — no one-frame "dirty" window where concurrent
    // streaming growth could lurch the view. At/over the bottom, drop the anchor
    // so the bottom-follow path owns the viewport again.
    if (appliedDelta !== 0) {
      if (target <= Math.max(0, Number(transcriptBottomSlackRowsRef.current) || 0)) {
        transcriptAnchorRef.current = null;
        transcriptAnchorDirtyRef.current = false;
      } else {
        const geom = transcriptGeomRef.current || {};
        const prefixRows = geom.prefixRows;
        if (Array.isArray(prefixRows) && prefixRows.length > 1) {
          const gTotal = Math.max(0, Number(geom.totalRows) || 0);
          const gView = Math.max(1, Number(geom.viewRows) || 1);
          const anchorRow = Math.max(0, Math.min(gTotal, gTotal - target - gView));
          let idx = upperBound(prefixRows, anchorRow) - 1;
          if (idx < 0) idx = 0;
          if (idx > prefixRows.length - 2) idx = prefixRows.length - 2;
          const items = geom.items || [];
          const anchorItem = items[idx];
          if (anchorItem && anchorItem.id != null) {
            transcriptAnchorRef.current = { id: anchorItem.id, offset: Math.max(0, anchorRow - (prefixRows[idx] || 0)) };
            transcriptAnchorDirtyRef.current = false;
          } else {
            transcriptAnchorDirtyRef.current = true;
          }
        } else {
          transcriptAnchorDirtyRef.current = true;
        }
      }
    }
    if (appliedDelta !== 0 && selectionLayoutRef.current) {
      selectionLayoutRef.current = { ...selectionLayoutRef.current, scrollOffset: target };
    }
    if (appliedDelta !== 0 && dragRef.current.rect) {
      let rect;
      if (dragRef.current.active) {
        const { anchor, anchorScroll, last, anchorSpan, region } = dragRef.current;
        if (anchorSpan && last) {
          // Word/line multi-click drag that reached the edge: keep extending by
          // whole words/lines from the span to the word/line at the current cell,
          // NOT collapsing to a char {anchor->last} rect. Mirrors the motion path.
          rect = buildSpanRect(anchorSpan, last.x, last.y, region, anchorScroll);
        } else {
          const currentAnchor = selectionPointAtCurrentScroll(anchor, anchorScroll);
          rect = currentAnchor && last ? { mode: 'linear', x1: currentAnchor.x, y1: currentAnchor.y, x2: last.x, y2: last.y } : null;
        }
      } else {
        rect = shiftSelectionRectY(dragRef.current.rect, appliedDelta);
      }
      // Active-drag rebuild paints directly, so route through the themed clip
      // (captureText:false, matching rememberText:false below) — a bare rect
      // without selectionBackground falls back to a near-white full-width block
      // with vanishing text (vendor/ink output.js). Also cancel any armed
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
    }
    if (options.smooth) {
      startSmoothScroll();
      return;
    }
    stopSmoothScroll();
    scrollPositionRef.current = target;
    setScrollOffset(Math.round(target));
  }, [startSmoothScroll, stopSmoothScroll, paintSelectionRect, selectionPointAtCurrentScroll, withSelectionClip, cancelTranscriptFollow, buildSpanRect, harvestStitchRowsNow, cancelPendingSelectionPaint, flushPendingSelectionPaint]);

  // Leading-edge coalescer for edge-drag auto-scroll + wheel deltas: the first
  // delta after an idle period flushes immediately (single wheel ticks/short
  // drags stay responsive), while a flood of deltas within SCROLL_COALESCE_MS
  // accumulates into one scrollTranscriptRows call per tick instead of one per
  // mousemove/wheel event. Both call sites below route through this instead of
  // calling scrollTranscriptRows directly.
  const queueScrollCoalesced = useCallback((deltaRows) => {
    const state = scrollCoalesceRef.current;
    state.pendingRows += deltaRows;
    if (state.timer) return;
    const rows = state.pendingRows;
    state.pendingRows = 0;
    scrollTranscriptRows(rows);
    state.timer = setTimeout(() => {
      state.timer = null;
      if (state.pendingRows !== 0) {
        const remaining = state.pendingRows;
        state.pendingRows = 0;
        scrollTranscriptRows(remaining);
      }
    }, SCROLL_COALESCE_MS);
    state.timer.unref?.();
  }, [scrollTranscriptRows]);

  // NOTE: declared AFTER scrollTranscriptRows — it appears in the deps array
  // below, and useCallback deps are evaluated at render time, so referencing
  // it before its const initializer would throw a TDZ ReferenceError.
  const moveSelectionFocus = useCallback((move) => {
    const drag = dragRef.current;
    if (drag.active) return false;
    const region = drag.region;
    if (region !== 'transcript' && region !== 'status') return false;
    const rect = drag.rect;
    if (!rect) return false;
    if (rect.x1 === rect.x2 && rect.y1 === rect.y2) return false;

    let anchor = { x: rect.x1, y: rect.y1 };
    let col = rect.x2;
    let row = rect.y2;
    const beforeCol = col;
    const beforeRow = row;
    // Set when Shift+Up/Down hits the viewport edge and we scroll the
    // transcript to reveal a new row rather than moving within the current
    // viewport (mirrors the mouse edge-drag auto-scroll at the drag-motion
    // handler). In that case row/col numerically equal their "before" values
    // (both clamp to the same viewport edge index) even though the
    // underlying content changed, so the generic before/after guard below
    // must not treat it as a no-op.
    let scrolledEdge = false;

    const { top, bottom } = region === 'status' ? statusBandRows() : transcriptViewportRows();

    switch (move) {
      case 'left':
        if (col > 0) col -= 1;
        else if (row > top) {
          row -= 1;
          col = selectionMaxColAtRow(row);
        }
        break;
      case 'right': {
        const maxCol = selectionMaxColAtRow(row);
        if (col < maxCol) col += 1;
        else if (row < bottom) {
          row += 1;
          col = 0;
        }
        break;
      }
      case 'up':
        if (row > top) {
          row -= 1;
        } else if (region === 'transcript') {
          // Already at the top visible row: scroll the transcript up by one
          // row (same direction as the mouse edge-drag auto-scroll at the
          // top edge, App.jsx ~3060) instead of clamping the selection in
          // place, then extend the focus onto the newly revealed top row.
          const beforeTarget = scrollTargetRef.current;
          const slack = Math.max(0, Number(transcriptBottomSlackRowsRef.current) || 0);
          const deltaRows = beforeTarget <= slack ? (slack + 1 - beforeTarget) : 1;
          scrollTranscriptRows(deltaRows);
          if (scrollTargetRef.current !== beforeTarget) {
            scrolledEdge = true;
            // scrollTranscriptRows REPLACES dragRef.current with a shifted
            // copy — re-read it; the local `drag` binding is stale here.
            const shiftedRect = dragRef.current.rect;
            if (shiftedRect) anchor = { x: shiftedRect.x1, y: shiftedRect.y1 };
            row = top;
          }
        }
        break;
      case 'down':
        if (row < bottom) {
          row += 1;
        } else if (region === 'transcript') {
          // Already at the bottom visible row: scroll down by one row (mirrors
          // the mouse edge-drag auto-scroll at the bottom edge, App.jsx
          // ~3062) instead of clamping, then extend the focus onto the newly
          // revealed bottom row.
          const beforeTarget = scrollTargetRef.current;
          scrollTranscriptRows(-1);
          if (scrollTargetRef.current !== beforeTarget) {
            scrolledEdge = true;
            // Re-read post-scroll dragRef.current (see 'up' case).
            const shiftedRect = dragRef.current.rect;
            if (shiftedRect) anchor = { x: shiftedRect.x1, y: shiftedRect.y1 };
            row = bottom;
          }
        }
        break;
      case 'lineStart':
        col = 0;
        break;
      case 'lineEnd':
        col = selectionMaxColAtRow(row);
        break;
      default:
        return false;
    }

    row = Math.max(top, Math.min(bottom, row));
    col = Math.max(0, Math.min(selectionMaxColAtRow(row), col));

    if (!scrolledEdge && col === beforeCol && row === beforeRow) return false;

    // After an edge scroll dragRef.current is a NEW object; mutate the live
    // one, not the stale entry binding.
    const dragNow = dragRef.current;
    if (dragNow.anchorSpan) dragNow.anchorSpan = null;

    const focus = { x: col, y: row };
    applySelectionRect({
      mode: 'linear',
      x1: anchor.x,
      y1: anchor.y,
      x2: focus.x,
      y2: focus.y,
    });
    dragNow.last = { x: focus.x, y: focus.y };
    return true;
  }, [applySelectionRect, statusBandRows, transcriptViewportRows, selectionMaxColAtRow, scrollTranscriptRows]);

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
