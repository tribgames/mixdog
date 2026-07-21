/**
 * use-transcript-window.mjs — transcript row-index/window memo chain + the
 * measured-height harvest and reading-anchor lock effects.
 *
 * Extracted verbatim from App.jsx: structure-signature/row-index/render-window
 * memos, the same-frame anchor lock + capture, the per-commit Yoga height
 * harvest, bottom-follow/anchor post-commit sync, selection layout shift and
 * the scroll clamp. Scroll/anchor/drag refs stay App-owned (injected); this
 * hook owns the measurement maps, measuredRowsVersion and totalRows bookkeeping.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  TRANSCRIPT_MEASURED_ROWS,
  transcriptMeasuredRowsCache,
  streamingMeasuredRowsById,
  pruneStreamingMeasuredRowsById,
  hasStreamingRowStateToPrune,
  transcriptItemVariantKey,
  transcriptStructureSignature,
  transcriptItemsWithStableTail,
  transcriptRowAt,
  buildTranscriptRowIndexIncremental,
  estimateTranscriptItemRowsCached,
  setStreamingBottomPinned,
  transcriptRenderWindow,
  resolveAnchorScrollOffset,
  streamingTailMountedGrowth,
  streamingEstimateRows,
  TRANSCRIPT_WINDOW_OVERSCAN_ROWS,
  upperBound,
  shiftSelectionRectY,
} from './transcript-window.mjs';
import { shouldSuppressFullyFailedToolItem } from '../transcript-tool-failures.mjs';

// ── Harvest circuit breaker ────────────────────────────────────────────────
// The measured-height harvest is a deps-less layout effect: every
// setMeasuredRowsVersion bump re-renders SYNCHRONOUSLY and re-runs the
// harvest in the same task. If a measurement fails to converge (Yoga height
// oscillating with the window/offset it just changed), `changed` stays true
// on every pass and React kills the process at >50 nested sync updates
// (minified error #185, Maximum update depth exceeded). Cap consecutive
// same-task bumps well above the normal 1-2-frame settle; past the cap, skip
// the bump (the caches keep the latest heights, the next external render
// consumes them) and trace the culprits for diagnosis.
const HARVEST_BUMP_STREAK_LIMIT = 10;
const TUI_DEBUG = /^(1|true|yes|on)$/i.test(String(process.env.MIXDOG_TUI_DEBUG || ''));
let harvestBreakerLogged = false;
function traceHarvestBreaker(changedKeys) {
  // Always report the FIRST trip per process (one stderr line beats a crash);
  // repeat trips only under MIXDOG_TUI_DEBUG=1 to avoid tearing the screen.
  if (harvestBreakerLogged && !TUI_DEBUG) return;
  harvestBreakerLogged = true;
  try {
    process.stderr.write(`[tui] measured-rows harvest breaker tripped (oscillating heights): ${changedKeys.slice(0, 8).join(' ')}\n`);
  } catch {}
}

export function useTranscriptWindow({
  items: settledItems,
  structureRevision,
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
  // Consecutive same-task harvest bumps (see HARVEST_BUMP_STREAK_LIMIT). The
  // reset is a 0ms macrotask: it can never fire inside the synchronous
  // layout-effect cascade, so the count is a faithful cascade depth.
  const harvestBumpStreakRef = useRef({ count: 0, timer: null });
  // Pessimistic "committed" max-scroll for the IMMEDIATE wheel/keyboard clamp.
  // transcriptWindow.maxScrollRows is derived from the row index, which uses
  // ESTIMATED heights for rows in the mounted slice. On the frame a scroll-up
  // FIRST mounts a new row, its estimate may overshoot the real Yoga height, so
  // that frame's maxScrollRows is inflated and a wheel offset clamped only
  // against it scrolls past committed geometry — opening a one-frame blank band
  // at the top until the post-commit harvest corrects it. We hold this cap only
  // while a row IN the mounted slice is still unmeasured; the harvest measures
  // it on the next commit and the estimate is adopted. Expansion can never be
  // blocked longer than that frame (and is bypassed entirely when measured-rows
  // mode is off — no harvest ever runs, so the estimate is the only geometry).
  const committedMaxScrollRowsRef = useRef(0);
  // Per-hook-instance settled-prefix row-index cache for the incremental
  // builder. Was module-level (leaked across hook instances); now local so
  // each transcript window owns its own tail-flush cache.
  const incrementalRowIndexCacheRef = useRef(null);
  const transcriptItemsCacheRef = useRef(null);
  // Previous frame's viewport-only geometry (content height + floating-panel
  // reservation). A floating panel / view (picker/context/usage/text-entry)
  // open-close changes transcriptContentHeight WITHOUT changing `items`, so the
  // transcript window would re-slice against the new viewport height while the
  // scroll offset still reflects the old one — the visible top row jumps, then
  // the post-commit anchor effect snaps it back a frame later (the 2-frame
  // re-settle). We detect that viewport-only change at render time and freeze
  // the visible top anchor from the PREVIOUS geometry, resolving the scroll
  // offset for THIS render so the anchored row stays put in a single frame.
  const prevViewportGeomRef = useRef({ contentHeight: 0, floatingPanelRows: 0 });
  // App-level measured row heights (real per-item height cache). The map of
  // mounted item id → ink DOM element is read every commit to harvest each
  // row's REAL Yoga height into transcriptMeasuredRowsCache. measuredRowsVersion
  // is bumped whenever a height actually changes so the row-index/window memos
  // recompute against the corrected heights (one-frame lag, absorbed by the
  // overscan band).
  const transcriptItemElsRef = useRef(new Map());
  const transcriptMeasureRefCache = useRef(new Map());
  // id → latest item object for this render. The callback ref reads from here so
  // a reused (stable) callback never captures a stale item across patches.
  const transcriptMeasureItemsRef = useRef(new Map());
  // Stable per-item callback-ref factory: storing the element under the item id
  // (and reading the live item object from transcriptMeasureItemsRef) avoids the
  // ref-swap churn React would otherwise cause with an inline closure each
  // render, while never serving a stale item: the callback resolves the current
  // item by id at call time. The ref(null) path drops the element; the harvest
  // reads getComputedHeight from whatever is mounted, so an unmount simply stops
  // contributing (its last measurement stays cached on the item object).
  const transcriptMeasureRef = useCallback((item) => {
    if (!TRANSCRIPT_MEASURED_ROWS || !item || item.id == null) return undefined;
    if (shouldSuppressFullyFailedToolItem(item)) {
      transcriptMeasuredRowsCache.delete(item);
      transcriptItemElsRef.current.delete(item.id);
      transcriptMeasureItemsRef.current.delete(item.id);
      return undefined;
    }
    const key = item.id;
    transcriptMeasureItemsRef.current.set(key, item);
    let fn = transcriptMeasureRefCache.current.get(key);
    if (!fn) {
      fn = (el) => {
        if (el) {
          transcriptItemElsRef.current.set(key, el);
        } else {
          transcriptItemElsRef.current.delete(key);
        }
      };
      transcriptMeasureRefCache.current.set(key, fn);
    }
    return fn;
  }, []);

  // The settled array no longer changes during streaming. Geometry is keyed by
  // the engine revision plus the live tail's resolved height, so same-height
  // text flushes do not copy/walk the settled prefix or rerun heavy memos.
  const streamingTailItem = streamingTail?.kind === 'assistant' && streamingTail.streaming
    ? streamingTail
    : null;
  const scrolledUpRowsForPin = Math.max(0, Number(scrollTargetRef.current) || 0);
  const transcriptPinnedForStreaming = followingRef.current
    || scrolledUpRowsForPin === 0;
  // Publish the pinned state to the streaming-tail estimator BEFORE resolving
  // tailSig / the row-index memo this render, so max(measuredFloor, liveEstimate)
  // applies while bottom-pinned (right geometry on first commit, no judder) and
  // every tail-resolving path reads the same height (no sig/geometry divergence).
  setStreamingBottomPinned(transcriptPinnedForStreaming);
  const tailRows = streamingTailItem
    ? estimateTranscriptItemRowsCached(streamingTailItem, frameColumns, toolOutputExpanded)
    : 0;
  const tailSig = streamingTailItem ? `${streamingTailItem.id}:${tailRows}` : '_';
  const revision = Math.max(0, Number(structureRevision) || 0);
  const transcriptItems = transcriptItemsWithStableTail(
    settledItems,
    streamingTailItem,
    transcriptItemsCacheRef,
  );
  const transcriptStructureSig = transcriptStructureSignature(
    transcriptItems,
    frameColumns,
    toolOutputExpanded,
    revision,
    streamingTailItem,
  );
  const transcriptStreamingActive = !!streamingTailItem;
  const scrolledUpForStreamingMeasure = scrolledUpRowsForPin > 0;
  const prevEstimateGeometry = transcriptGeomRef.current?.suppressMeasuredRowHeights === true;
  const hasStreamingReadingAnchor = !!transcriptAnchorRef.current
    || transcriptAnchorDirtyRef.current;
  const bottomPinnedForMeasure = transcriptPinnedForStreaming;
  const suppressMeasuredRowHeights = bottomPinnedForMeasure
    || (transcriptStreamingActive && (
      (scrolledUpForStreamingMeasure && hasStreamingReadingAnchor)
      || (scrolledUpForStreamingMeasure && prevEstimateGeometry && !transcriptPinnedForStreaming)
    ));
  // Incremental builder: on a streaming flush where only the trailing assistant
  // item's text grew, it recomputes just the tail row and appends to a cached
  // settled-prefix row-index (O(1) prefix) instead of re-walking all N items.
  // Any structural change (item count, non-tail change, columns, expanded,
  // suppress, measuredRowsVersion) misses the cache and falls back to a full
  // buildTranscriptRowIndex — so the prefix table is byte-identical to a full
  // rebuild for the settled prefix. All those invalidators are folded into the
  // memo deps below (sig captures item/column/expanded structure; the rest are
  // listed explicitly), so the memo only recomputes when one of them changes.
  const transcriptRowIndex = useMemo(() => buildTranscriptRowIndexIncremental(transcriptItems, {
    columns: frameColumns,
    toolOutputExpanded,
    suppressMeasuredRowHeights,
    measuredRowsVersion,
    cacheRef: incrementalRowIndexCacheRef,
    prefixRevision: revision,
    streamingTailItem,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- revision/tail height capture structural geometry; measuredRowsVersion folds in measured corrections
  }), [revision, tailSig, frameColumns, toolOutputExpanded, measuredRowsVersion, suppressMeasuredRowHeights]);
  // ── Same-frame anchor lock ───────────────────────────────────────────────
  // While the user reads older transcript (anchor captured, not dirty), resolve
  // the scroll offset that keeps the anchored viewport-top row fixed for THIS
  // frame's prefix table — SYNCHRONOUSLY, before windowing/marginBottom use it.
  // Previously this correction lived only in the post-commit layout effect, so
  // the frame that grew the streaming tail rendered with the STALE offset first
  // (a blank band opened at the top) and only the NEXT frame snapped it shut.
  // Computing it here folds the new totalRows and the corrected offset into the
  // SAME render, so the completed line fills its space with no one-frame gap.
  // Falls back to the live scrollOffset state when there is no active anchor
  // (bottom-follow / pinned) or it cannot be aligned (anchor item gone).
  const hasReadingAnchor = !!transcriptAnchorRef.current && !transcriptAnchorDirtyRef.current;
  const scrolledUpRows = Math.max(0, Number(scrollTargetRef.current) || 0);
  // Any positive offset is a user reading position. Only the true bottom is
  // pinned, so a wheel notch inside the former slack band cannot re-enable
  // follow while a stream is appending rows.
  const scrolledUp = scrolledUpRows > 0;
  // A genuine reading anchor wins even if followingRef is stale-true while the
  // user is scrolled up. The follow-arm SHOULD have been cleared when the anchor
  // was captured, but if it lingers true we must not fall through to the stale-
  // offset render path (that is one half of the newline-jump bug). Keep the
  // plain !following gate for the anchor-less follow case.
  const anchorLockActive = hasReadingAnchor && !followingRef.current && scrolledUp;
  const targetNearBottom = followingRef.current || !scrolledUp;
  const nearBottomWithoutAnchor = !transcriptAnchorRef.current
    && !transcriptAnchorDirtyRef.current
    && targetNearBottom;
  let renderScrollOffset = targetNearBottom ? 0 : scrollOffset;
  const lockViewRows = Math.max(1, Number(transcriptContentHeight) || 1);
  const lockTotalRows = Math.max(0, Number(transcriptRowIndex?.totalRows) || 0);
  const lockMaxRows = Math.max(0, lockTotalRows - lockViewRows);
  const curPrefixForLock = transcriptRowIndex?.prefixRows || null;
  if (anchorLockActive) {
    const locked = resolveAnchorScrollOffset({
      anchor: transcriptAnchorRef.current,
      items: transcriptItems,
      curPrefix: curPrefixForLock,
      totalRows: lockTotalRows,
      viewRows: lockViewRows,
      maxRows: lockMaxRows,
    });
    if (locked != null) renderScrollOffset = locked;
  } else if (!followingRef.current && !nearBottomWithoutAnchor && scrolledUp) {
    // ── Same-frame anchor CAPTURE for the missing/dirty-anchor case ─────────
    // The viewport is genuinely scrolled up but there is NO usable same-frame
    // anchor: it is missing, or dirtied by a manual scroll whose synchronous
    // capture failed, or a stale-true follow-arm already dropped it. Without an
    // anchor this frame would render with the STALE bottom-relative
    // scrollOffset, so any row growth THIS frame (a streaming newline
    // completing a line, a transcript row expanding) shifts the visible top by
    // the delta BEFORE the post-commit rowDelta effect can capture/correct — and
    // that effect would then capture from the ALREADY-shifted totalRows. That is
    // the confirmed one-frame jump/jitter.
    //
    // Fix it at render time: capture an anchor from the PREVIOUS published
    // geometry (transcriptGeomRef still holds the prior frame here — THIS
    // frame's geom is published a few lines below), identifying the item id +
    // row offset that sat at the previous visible-TOP edge, then resolve the
    // offset against the CURRENT prefix table with the same pure helper so that
    // exact top row stays put THIS frame. Persist the captured anchor so the
    // post-commit effect keeps the identical anchor stable instead of
    // re-deriving one from the already-shifted totalRows.
    const geom = transcriptGeomRef.current || {};
    const prevPrefix = geom.prefixRows;
    if (prevPrefix && prevPrefix.length > 1) {
      const prevTotal = Math.max(0, Number(geom.totalRows) || 0);
      const prevView = Math.max(1, Number(geom.viewRows) || 1);
      const prevOffset = Math.max(0, Number(geom.renderOffset) || 0);
      const prevItems = geom.items || [];
      // Bottom-relative window math (same as transcriptRenderWindow): the top
      // edge sits `offset + viewRows` rows up from the previous total.
      const prevTopRow = Math.max(0, Math.min(prevTotal, prevTotal - prevOffset - prevView));
      let idx = upperBound(prevPrefix, prevTopRow) - 1;
      if (idx < 0) idx = 0;
      if (idx > prevPrefix.length - 2) idx = prevPrefix.length - 2;
      const anchorItem = prevItems[idx];
      if (anchorItem && anchorItem.id != null) {
        const captured = { id: anchorItem.id, offset: Math.max(0, prevTopRow - transcriptRowAt(prevPrefix, idx)) };
        const locked = resolveAnchorScrollOffset({
          anchor: captured,
          items: transcriptItems,
          curPrefix: curPrefixForLock,
          totalRows: lockTotalRows,
          viewRows: lockViewRows,
          maxRows: lockMaxRows,
        });
        if (locked != null) {
          renderScrollOffset = locked;
          transcriptAnchorRef.current = captured;
          transcriptAnchorDirtyRef.current = false;
        }
      }
    }
  }
  // ── Viewport-only transition freeze (floating panel / view open-close) ─────
  // When a picker/context/usage/text-entry panel opens or closes, only the
  // transcript viewport height changes (transcriptContentHeight and/or the
  // floating-panel reservation) — `items` and the row-index are unchanged. The
  // bottom-follow / anchor-lock paths above only fire when the user is reading
  // older transcript; a bottom-pinned transcript falls through with
  // renderScrollOffset resolved against the NEW viewport while the on-screen
  // top edge still reflects the OLD one, producing the visible jump that the
  // post-commit effect then corrects one frame later. Freeze it here: when the
  // ONLY thing that changed is the viewport (not the anchor state, not items),
  // reconstruct the previous visible-top row from the prior published geometry
  // and resolve the offset against the current prefix table so the same top row
  // renders THIS frame. Bottom-pinned/following views are already stable
  // (flex-end owns them), so restrict the freeze to the scrolled-up, no-active-
  // lock case that the branches above did not already resolve.
  const prevViewport = prevViewportGeomRef.current || {};
  const viewportOnlyChanged = (Number(prevViewport.contentHeight) || 0) !== lockViewRows
    || (Number(prevViewport.floatingPanelRows) || 0) !== (Number(floatingPanelRows) || 0);
  if (viewportOnlyChanged
    && !anchorLockActive
    && !followingRef.current
    && !nearBottomWithoutAnchor
    && scrolledUp) {
    const geom = transcriptGeomRef.current || {};
    const prevPrefix = geom.prefixRows;
    if (prevPrefix && prevPrefix.length > 1) {
      const prevTotal = Math.max(0, Number(geom.totalRows) || 0);
      // Use the PREVIOUS viewport rows to reconstruct where the top edge sat on
      // screen before the panel changed the height.
      const prevView = Math.max(1, Number(prevViewport.contentHeight) || Number(geom.viewRows) || 1);
      const prevOffset = Math.max(0, Number(geom.renderOffset) || 0);
      const prevItems = geom.items || [];
      const prevTopRow = Math.max(0, Math.min(prevTotal, prevTotal - prevOffset - prevView));
      let idx = upperBound(prevPrefix, prevTopRow) - 1;
      if (idx < 0) idx = 0;
      if (idx > prevPrefix.length - 2) idx = prevPrefix.length - 2;
      const anchorItem = prevItems[idx];
      if (anchorItem && anchorItem.id != null) {
        const captured = { id: anchorItem.id, offset: Math.max(0, prevTopRow - transcriptRowAt(prevPrefix, idx)) };
        const locked = resolveAnchorScrollOffset({
          anchor: captured,
          items: transcriptItems,
          curPrefix: curPrefixForLock,
          totalRows: lockTotalRows,
          viewRows: lockViewRows,
          maxRows: lockMaxRows,
        });
        if (locked != null) {
          renderScrollOffset = locked;
          // Persist so the post-commit effect keeps this exact anchor stable
          // rather than re-deriving one from the already-resized geometry.
          transcriptAnchorRef.current = captured;
          transcriptAnchorDirtyRef.current = false;
        }
      }
    }
  }
  prevViewportGeomRef.current = {
    contentHeight: lockViewRows,
    floatingPanelRows: Number(floatingPanelRows) || 0,
  };
  // ── Same-frame streaming-tail growth compensation (scrolled-up only) ───────
  // When the user reads older transcript, the row index freezes the trailing
  // streaming item at its last Yoga-confirmed height (defer-growth), but the
  // mounted Box lays out at the live-grown height THIS frame. renderScrollOffset
  // was just resolved against that frozen row index, so the extra physical rows
  // are unaccounted-for and the visible window jumps up one frame until the
  // harvest bumps measuredRowsVersion. Fold the mounted growth delta into the
  // offset NOW so marginBottom slides those extra rows off the bottom and the
  // window holds still. Bottom-pinned/following is stable (flex-end owns it) and
  // is excluded by the scrolledUp gate. No double-compensation next frame: once
  // measuredRowsVersion bumps, the row index absorbs the growth (idEntry.rows ==
  // the new measured height) and the live estimate matches it, so delta → 0.
  if (scrolledUp && !followingRef.current) {
    const growth = streamingTailMountedGrowth(
      streamingTailItem ? [streamingTailItem] : transcriptItems,
      frameColumns,
      toolOutputExpanded,
    );
    // Only compensate when the tail is actually mounted in the rendered slice
    // (viewport + overscan). Off-slice it is represented by a row-index-sized
    // bottom spacer that does NOT physically grow this frame, so shifting the
    // offset there would itself introduce a jump. In-slice its Box grows now.
    // Gate/clamp on the POST-compensation offset: transcriptRenderWindow drops
    // the tail once effectiveScrollOffset >= tailRows + overscan, so adding the
    // full delta could push the offset past that edge and unmount the very row
    // we are compensating for (a reverse jump at the boundary). Cap the applied
    // delta so the final offset keeps the tail mounted; any residual growth left
    // uncompensated sits in the overscan below the viewport (not visible).
    if (growth && growth.delta > 0) {
      const maxOffsetKeepingTailMounted = growth.tailRows + TRANSCRIPT_WINDOW_OVERSCAN_ROWS - 1;
      if (renderScrollOffset <= maxOffsetKeepingTailMounted) {
        renderScrollOffset += Math.min(growth.delta, maxOffsetKeepingTailMounted - renderScrollOffset);
      }
    }
  }
  const transcriptWindow = useMemo(() => transcriptRenderWindow(transcriptItems, {
    scrollOffset: renderScrollOffset,
    viewportHeight: transcriptContentHeight,
    columns: frameColumns,
    toolOutputExpanded,
    rowIndex: transcriptRowIndex,
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: sig+scroll/viewport capture the relevant changes
  }), [transcriptStructureSig, renderScrollOffset, transcriptContentHeight, transcriptRowIndex]);
  // Publish the max for the immediate wheel/keyboard clamp (see the
  // committedMaxScrollRowsRef note above). Adopt the estimate-based max unless a
  // row in THIS frame's mounted slice is still unmeasured — that is the only
  // case where an over-estimated freshly-mounted row can inflate maxScrollRows
  // ahead of committed Yoga geometry. Off-slice appended rows (bottom spacer,
  // never mounted) don't trigger the hold, so scroll can always reach the true
  // oldest rows; and with measured-rows mode off, no harvest ever runs, so the
  // raw estimate is published unconditionally.
  const estimateMaxScrollRows = Math.max(0, Number(transcriptWindow.maxScrollRows) || 0);
  let holdCommittedMax = false;
  if (TRANSCRIPT_MEASURED_ROWS && estimateMaxScrollRows > committedMaxScrollRowsRef.current) {
    // Expansion requested: only trust it once every mounted-slice row has a
    // committed measurement that is VALID FOR THIS geometry. A just-mounted row
    // lacks a cache entry until the post-commit harvest records its real height;
    // and a cache entry left over from a prior columns/tool-expanded/variant is
    // stale (the harvest re-measures it against these same fields), so it must
    // also count as unmeasured — otherwise the pre-harvest estimate for the new
    // geometry could re-open the overshoot right after such a change.
    const toolExpandedFlag = toolOutputExpanded ? 1 : 0;
    const mountedSlice = transcriptWindow.items || [];
    for (let i = 0; i < mountedSlice.length; i++) {
      const it = mountedSlice[i];
      if (!it || shouldSuppressFullyFailedToolItem(it)) continue;
      if (it.kind === 'assistant' && it.streaming) {
        const idPrev = streamingMeasuredRowsById.get(it.id);
        if (!idPrev || idPrev.columns !== frameColumns || idPrev.toolExpanded !== toolExpandedFlag) {
          holdCommittedMax = true;
          break;
        }
      } else {
        const prev = transcriptMeasuredRowsCache.get(it);
        if (!prev
          || prev.columns !== frameColumns
          || prev.toolExpanded !== toolExpandedFlag
          || prev.variantKey !== transcriptItemVariantKey(it)) {
          holdCommittedMax = true;
          break;
        }
      }
    }
  }
  if (!holdCommittedMax) committedMaxScrollRowsRef.current = estimateMaxScrollRows;
  maxScrollRowsRef.current = committedMaxScrollRowsRef.current;
  // Publish this frame's geometry so a manual scroll can capture the reading
  // anchor synchronously (see captureTranscriptAnchorAt).
  transcriptGeomRef.current = {
    prefixRows: transcriptRowIndex?.prefixRows || null,
    totalRows: Math.max(0, Number(transcriptWindow.totalRows) || 0),
    viewRows: Math.max(1, Number(transcriptContentHeight) || 1),
    items: transcriptItems || null,
    // The offset THIS frame actually rendered with. The same-frame anchor
    // CAPTURE for a missing/dirty anchor (above) reads this from the PREVIOUS
    // frame to reconstruct the exact top-edge row that was on screen, so the
    // capture matches what the user saw rather than the stale scrollOffset
    // state. Publish the CLAMPED effective offset (transcriptRenderWindow clamps
    // renderScrollOffset to maxScrollRows internally) so the reconstruction uses
    // the value the window math actually rendered with, not the raw compensated
    // offset. Bottom-relative, matching transcriptRenderWindow's window math.
    renderOffset: Math.max(0, Number(transcriptWindow.effectiveScrollOffset) || 0),
    suppressMeasuredRowHeights,
  };
  // The window memo is keyed on a structure signature that intentionally
  // ignores per-character growth of the streaming assistant text, so its
  // `items` slice can hold a STALE reference to the streaming item between
  // height changes. Re-slice the live `items` over the memo's stable
  // [startIndex, endIndex) bounds so the on-screen text is always current
  // while the expensive indexing/windowing stays warm.
  const transcriptVisibleItems = (transcriptItems || []).slice(
    transcriptWindow.startIndex,
    transcriptWindow.endIndex,
  );
  if (streamingTailItem && transcriptVisibleItems.length > 0) {
    const last = transcriptVisibleItems.length - 1;
    if (transcriptVisibleItems[last]?.id === streamingTailItem.id) {
      transcriptVisibleItems[last] = streamingTailItem;
    }
  }
  // The bottom meta band is spinner-only, so nothing is pulled out of the
  // transcript for it. A finished turn's done row (turndone/statusdone) renders
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
  const overlayHintOnLastItem = overlayHintRequested
    && floatingPanelRows <= 0
    && transcriptWindow.bottomSpacerRows === 0
    && transcriptTailPinned
    && overlayHintAttachItemIndex >= 0;
  const overlayHintFallbackRow = overlayHintRequested
    && floatingPanelRows <= 0
    && transcriptGuardRows > 0
    && !overlayHintOnLastItem;
  // ── App-level measured height harvest ───────────────────────────────────
  // Runs after EVERY commit (no deps): Yoga has just laid out the mounted rows,
  // so each tracked item Box's getComputedHeight() is its REAL terminal height.
  // Fold those into transcriptMeasuredRowsCache (validated on the same variant
  // key the estimate caches use) and bump measuredRowsVersion only when a height
  // actually changed — that re-runs the row-index/window memos against corrected
  // heights, then the harvest finds nothing new and the loop settles (one frame,
  // overscan-absorbed). Streaming
  // assistant rows are skipped: their height churns every flush and the bottom-
  // follow path already keeps them visually stable.
  useLayoutEffect(() => {
    if (!TRANSCRIPT_MEASURED_ROWS) return;
    // Skip the per-row Yoga harvest while a drag is in progress. Edge auto-
    // scroll commits setScrollOffset on every pointer motion, but the mounted
    // rows' real heights do not change during a drag — only their scroll
    // position does. Re-measuring every motion ran this O(mounted) loop (plus a
    // variantKey check per row) for no height change, which is pure drag
    // overhead on a tall transcript. The cached measurements stay authoritative
    // for the row-index math; a single re-measure is forced on release below.
    if (dragRef.current.active) return;
    const els = transcriptItemElsRef.current;
    if (!els || els.size === 0) return;
    const liveItems = transcriptMeasureItemsRef.current;
    const toolExpandedFlag = toolOutputExpanded ? 1 : 0;
    let changed = false;
    const changedKeys = [];
    for (const [key, el] of els.entries()) {
      const item = liveItems.get(key);
      const yoga = el?.yogaNode;
      if (!item || !yoga) continue;
      if (shouldSuppressFullyFailedToolItem(item)) {
        if (transcriptMeasuredRowsCache.delete(item)) { changed = true; changedKeys.push(`${key}=del`); }
        continue;
      }
      // Streaming assistant rows are now harvested too: their height churns
      // every flush, but skipping them entirely meant the measured cache
      // never observed live re-slice growth, so anchor-lock signatures
      // (transcriptStructureSignature) could not react to it. Since streaming
      // items are replaced per-token, their WeakMap entry is orphaned every
      // frame; the id-keyed streamingMeasuredRowsById store (transcript-
      // window.mjs) is written below to survive that swap. The drag guard
      // above keeps this from fighting drag scroll.
      // Width 0 = Yoga has not laid this node out yet this frame; skip so a
      // transient 0 never poisons the cache (guard on a real positive width).
      if (typeof yoga.getComputedWidth === 'function' && yoga.getComputedWidth() <= 0) continue;
      const rawMeasured = Math.round(Number(yoga.getComputedHeight?.()) || 0);
      if (rawMeasured <= 0) {
        if (transcriptMeasuredRowsCache.delete(item)) { changed = true; changedKeys.push(`${key}=del`); }
        continue;
      }
      const isStreamingAssistant = item.kind === 'assistant' && !!item.streaming;
      const measured = Math.max(1, rawMeasured);
      const variantKey = transcriptItemVariantKey(item);
      if (isStreamingAssistant) {
        const idPrev = streamingMeasuredRowsById.get(item.id);
        // Baseline = the estimate for the text at THIS commit's measured state.
        // Refresh it on EVERY harvest pass (not only on an id-store change): if
        // the estimator's row count drifts while the Yoga height is unchanged
        // (or a same-id text reset), a stale baseline would make
        // streamingTailMountedGrowth compensate with no physical growth.
        const estimateAtMeasure = streamingEstimateRows(item, frameColumns, toolOutputExpanded);
        if (!idPrev || idPrev.rows !== measured || idPrev.columns !== frameColumns || idPrev.toolExpanded !== toolExpandedFlag) {
          // Record the estimate for the EXACT text just measured alongside the
          // real Yoga height, so streamingTailMountedGrowth can measure later
          // growth in the estimate metric (live_now − estimateAtMeasure) and the
          // estimator's steady bias cancels instead of leaking into a permanent
          // over-compensation once measuredRowsVersion has absorbed this height.
          streamingMeasuredRowsById.set(item.id, {
            rows: measured,
            columns: frameColumns,
            toolExpanded: toolExpandedFlag,
            estimateRows: estimateAtMeasure,
          });
          // ALWAYS bump on a real id-store change, bottom-pinned or not.
          // estimateTranscriptItemRowsCached (transcript-window.mjs) now
          // returns ONLY this id-store floor for a streaming item (defer-
          // growth: no live-estimate blend), so it is the SOLE path that ever
          // feeds this item's grown height into transcriptStructureSig /
          // buildTranscriptRowIndex. Skipping the bump while bottom-pinned
          // used to be safe because the blended estimate kept the signature
          // moving on its own each flush; with the blend gone, skipping it
          // here would freeze totalRows/prefixRows for this item until the
          // stream settles — invisible growth for anything reading rowIndex
          // (windowing, maxScrollRows, an anchor captured mid-stream).
          changed = true;
          changedKeys.push(`${key}=${measured}s`);
        } else {
          idPrev.estimateRows = estimateAtMeasure;
        }
      }
      const prev = transcriptMeasuredRowsCache.get(item);
      if (!isStreamingAssistant && prev
        && prev.rows === measured
        && prev.columns === frameColumns
        && prev.toolExpanded === toolExpandedFlag
        && prev.variantKey === variantKey) {
        continue;
      }
      transcriptMeasuredRowsCache.set(item, {
        rows: measured,
        columns: frameColumns,
        toolExpanded: toolExpandedFlag,
        variantKey,
      });
      if (!isStreamingAssistant) {
        // First mount (no prior entry): this frame's row index already used the
        // ESTIMATE for this item (measuredTranscriptRows returned null). If Yoga
        // measured exactly what the estimate predicted, the geometry is already
        // correct — bumping measuredRowsVersion would re-run the row-index/window
        // memos for a no-op and repaint the card one frame later (the "settle"
        // jump). Only bump when the measurement actually corrects the estimate.
        // A CHANGED height (prev existed but differs) always bumps.
        const estimateRows = prev
          ? -1
          : estimateTranscriptItemRowsCached(item, frameColumns, toolOutputExpanded);
        if (prev || measured !== estimateRows) { changed = true; changedKeys.push(`${key}=${measured}`); }
      }
    }
    if (changed) {
      // `changed` only flips true when a height actually differs from the
      // last-seen value, so a re-harvest of IDENTICAL rows is a no-op. But a
      // measurement that OSCILLATES with the geometry this bump itself changes
      // never settles, and the sync cascade would crash with React #185 — the
      // streak breaker caps that. Pinned (bottom-follow / near-bottom) renders
      // must still consume new measurements, or streaming re-slice growth
      // never reaches the row-index/window memos while following — which is
      // exactly the newline-jump bug.
      const streak = harvestBumpStreakRef.current;
      if (streak.count >= HARVEST_BUMP_STREAK_LIMIT) {
        traceHarvestBreaker(changedKeys);
      } else {
        streak.count += 1;
        if (!streak.timer) {
          streak.timer = setTimeout(() => {
            streak.timer = null;
            streak.count = 0;
          }, 0);
          if (typeof streak.timer?.unref === 'function') streak.timer.unref();
        }
        setMeasuredRowsVersion((v) => (v + 1) % 1000000);
      }
    }
    // Prune the id→item / id→callback maps to the currently-mounted set so they
    // do not grow unbounded over a long session. `els` is the live mounted set
    // (ref(null) deletes on unmount), so anything not in it is gone.
    if (liveItems.size > els.size) {
      for (const key of liveItems.keys()) {
        if (!els.has(key)) liveItems.delete(key);
      }
    }
    const refCache = transcriptMeasureRefCache.current;
    if (refCache.size > els.size) {
      for (const key of refCache.keys()) {
        if (!els.has(key)) refCache.delete(key);
      }
    }
    if (hasStreamingRowStateToPrune()) {
      pruneStreamingMeasuredRowsById(new Set(liveItems.keys()));
    }
  });
  useLayoutEffect(() => {
    const totalRows = Math.max(0, Number(transcriptWindow.totalRows) || 0);
    const previousTotalRows = Math.max(0, Number(transcriptTotalRowsRef.current) || 0);
    transcriptTotalRowsRef.current = totalRows;
    const rowDelta = totalRows - previousTotalRows;
    const curPrefix = transcriptRowIndex?.prefixRows || null;
    if (previousTotalRows <= 0 || dragRef.current.active) return;

    const currentTarget = Math.max(0, Number(scrollTargetRef.current) || 0);
    const currentPosition = Math.max(0, Number(scrollPositionRef.current) || 0);
    const currentOffset = Math.max(0, Number(scrollOffset) || 0);
    const maxRows = Math.max(0, Number(transcriptWindow.maxScrollRows) || 0);
    const nearBottom = followingRef.current || currentTarget === 0;
    const pinnedToBottom = nearBottom;
    // A genuine reading anchor must win over ordinary stream growth, but an
    // explicit follow arm (prompt submit / pinned bottom) must win over stale
    // anchor state. Manual scroll cancels followingRef before anchor capture, so
    // deliberate reading still stays anchored while automatic bottom-follow
    // stays armed across spinner/tool/stream height corrections.
    const activeReadingAnchor = !!transcriptAnchorRef.current
      && !transcriptAnchorDirtyRef.current
      && !followingRef.current
      && !nearBottom;
    const followOnGrowth = followingRef.current && rowDelta > 0 && !activeReadingAnchor;
    const shouldFollowBottom = rowDelta > 0 && (followOnGrowth || pinnedToBottom);
    if (shouldFollowBottom) {
      // Bottom follow: while pinned to the newest output,
      // do NOT animate row growth. The viewport is already bottom-aligned by
      // justifyContent:flex-end; injecting a temporary positive scroll offset
      // during streaming makes the transcript jump down/up and can clip the
      // currently generated assistant text. Keep all scroll refs at zero so
      // character generation stays visually stable.
      stopSmoothScroll();
      scrollTargetRef.current = 0;
      scrollPositionRef.current = 0;
      transcriptAnchorRef.current = null;
      transcriptAnchorDirtyRef.current = false;
      if (currentOffset !== 0) setScrollOffset(0);
      return;
    }

    // Viewport-only changes, such as swapping TextEntryPanel for a picker, must
    // not turn a bottom-pinned transcript into a reading-anchor lock.
    if (rowDelta <= 0 && nearBottom) {
      stopSmoothScroll();
      scrollTargetRef.current = 0;
      scrollPositionRef.current = 0;
      transcriptAnchorRef.current = null;
      transcriptAnchorDirtyRef.current = false;
      if (currentOffset !== 0) setScrollOffset(0);
      return;
    }

    // ── ABSOLUTE ANCHOR LOCK ──────────────────────────────────────────────
    // User is reading older transcript. Instead of folding the per-frame row
    // DELTA into scrollOffset (which accumulated streaming-tail estimate jitter
    // and could fall back to the whole-total delta on a misalignment — the
    // "newline makes the screen jump" bug), we pin an ABSOLUTE anchor: the item
    // id + row offset sitting at the viewport TOP edge. Every commit we look that
    // item up in the CURRENT prefix table and re-derive scrollOffset so the
    // anchored row stays at the same screen position. Any height change BELOW the
    // anchor (streaming tail growth, a result landing under the reading position)
    // only moves the bottom — the top is rock-stable. Changes ABOVE the anchor
    // move the item's prefix start and are absorbed the same way. No deltas, no
    // fallback, no drift.
    const viewRows = Math.max(1, Number(transcriptContentHeight) || 1);
    const itemList = transcriptItems || [];
    let anchor = transcriptAnchorRef.current;
    // (Re)capture the anchor from the current viewport-top edge when missing or
    // invalidated by a manual scroll. anchorRow = absolute row at the top edge.
    if (!followingRef.current && (!anchor || transcriptAnchorDirtyRef.current)) {
      if (curPrefix && curPrefix.length > 1) {
        const anchorRow = Math.max(0, Math.min(totalRows, totalRows - currentTarget - viewRows));
        let idx = upperBound(curPrefix, anchorRow) - 1;
        if (idx < 0) idx = 0;
        if (idx > itemList.length - 1) idx = itemList.length - 1;
        const anchorItem = itemList[idx];
        if (anchorItem && anchorItem.id != null) {
          anchor = { id: anchorItem.id, offset: Math.max(0, anchorRow - transcriptRowAt(curPrefix, idx)) };
          transcriptAnchorRef.current = anchor;
        }
      }
      transcriptAnchorDirtyRef.current = false;
      // Just captured at the current offset; nothing to correct this frame.
      return;
    }
    // Resolve the anchored item's CURRENT position with the SAME pure helper the
    // render path uses, so the post-commit state sync can never disagree with the
    // synchronous render correction (which already fixed the screen this frame).
    const desired = resolveAnchorScrollOffset({
      anchor,
      items: itemList,
      curPrefix,
      totalRows,
      viewRows,
      maxRows,
    });
    if (desired == null) {
      // Anchor item gone (rare: removal/compaction). Re-capture next frame.
      transcriptAnchorDirtyRef.current = true;
      return;
    }
    const appliedDelta = desired - currentTarget;
    if (appliedDelta === 0) return;

    stopSmoothScroll();
    scrollTargetRef.current = desired;
    scrollPositionRef.current = Math.max(0, Math.min(maxRows, currentPosition + appliedDelta));
    setScrollOffset(Math.max(0, Math.round(desired)));
  }, [transcriptWindow.totalRows, transcriptWindow.maxScrollRows, transcriptRowIndex, transcriptContentHeight, scrollOffset, stopSmoothScroll]);
  useLayoutEffect(() => {
    if (transcriptAnchorRef.current || transcriptAnchorDirtyRef.current || followingRef.current) return;
    const currentTarget = Math.max(0, Number(scrollTargetRef.current) || 0);
    const currentPosition = Math.max(0, Number(scrollPositionRef.current) || 0);
    const currentOffset = Math.max(0, Number(scrollOffset) || 0);
    if (currentTarget !== 0) return;
    if (Math.max(currentTarget, currentPosition, currentOffset) === 0) return;
    stopSmoothScroll();
    scrollTargetRef.current = 0;
    scrollPositionRef.current = 0;
    setScrollOffset(0);
  }, [scrollOffset, stopSmoothScroll]);
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
    const deltaY = (next.top - previous.top)
      + (next.height - previous.height)
      - (next.totalRows - previous.totalRows)
      + (next.scrollOffset - previous.scrollOffset);
    if (deltaY === 0) return;
    const clippedRect = withSelectionClip(shiftSelectionRectY(dragRef.current.rect, deltaY));
    dragRef.current = { ...dragRef.current, rect: clippedRect };
    // rememberText:false — the shifted rect is viewport-clipped, so harvesting
    // here would replace the full selection text remembered at drag-release
    // with only the still-visible fragment (partial Ctrl+C after scrolling).
    paintSelectionRect(clippedRect, { rememberText: false, immediate: true });
  }, [transcriptContentHeight, transcriptWindow.totalRows, transcriptWindow.effectiveScrollOffset, withSelectionClip, paintSelectionRect]);
  useEffect(() => {
    if (!dragRef.current.rect) return;
    const clippedRect = withSelectionClip(dragRef.current.rect);
    dragRef.current = { ...dragRef.current, rect: clippedRect };
    // Theme repaint: same cells, same text — no need to re-harvest (and a
    // clipped rect would clobber the remembered full text with a fragment).
    paintSelectionRect(clippedRect, { rememberText: false, immediate: true });
  }, [themeEpoch, withSelectionClip, paintSelectionRect]);
  useEffect(() => {
    const maxRows = Math.max(0, Number(transcriptWindow.maxScrollRows) || 0);
    if (scrollTargetRef.current <= maxRows && scrollPositionRef.current <= maxRows && scrollOffset <= maxRows) return;
    stopSmoothScroll();
    const next = Math.max(0, Math.min(maxRows, scrollTargetRef.current));
    scrollTargetRef.current = next;
    scrollPositionRef.current = next;
    setScrollOffset(Math.round(next));
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
