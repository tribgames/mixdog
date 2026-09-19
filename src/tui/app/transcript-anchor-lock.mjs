/**
 * transcript-anchor-lock.mjs — pure reading-anchor arithmetic for the
 * transcript window: which item sits at the viewport's top edge, and the
 * render-time scroll offset that keeps it there while the row table changes.
 */
import { resolveAnchorScrollOffset, transcriptRowAt, upperBound } from './transcript-window.mjs';

/**
 * The item id + row offset sitting at the viewport TOP edge for a
 * bottom-relative `offset` (same window math as transcriptRenderWindow: the top
 * edge sits `offset + viewRows` rows up from the total). Null when the prefix
 * table is empty or the item at that row has no id.
 */
export function captureTopEdgeAnchor({ prefixRows, items, totalRows, viewRows, offset }) {
  if (!prefixRows || prefixRows.length < 2) return null;
  const total = Math.max(0, Number(totalRows) || 0);
  const view = Math.max(1, Number(viewRows) || 1);
  const scrolled = Math.max(0, Number(offset) || 0);
  const anchorRow = Math.max(0, Math.min(total, total - scrolled - view));
  let index = upperBound(prefixRows, anchorRow) - 1;
  if (index < 0) index = 0;
  if (index > prefixRows.length - 2) index = prefixRows.length - 2;
  const anchorItem = (items || [])[index];
  if (!anchorItem || anchorItem.id == null) return null;
  return { id: anchorItem.id, offset: Math.max(0, anchorRow - transcriptRowAt(prefixRows, index)) };
}

/**
 * Reconstruct the row that was on screen at the top edge of the PREVIOUSLY
 * published geometry and resolve the offset that keeps it there against the
 * current prefix table. `prevViewRows` overrides the previous viewport height
 * when only the viewport changed (a floating panel opened or closed).
 */
function lockToPreviousTopEdge({ geom, prevViewRows, current }) {
  const anchor = captureTopEdgeAnchor({
    prefixRows: geom.prefixRows,
    items: geom.items,
    totalRows: geom.totalRows,
    viewRows: prevViewRows,
    offset: geom.renderOffset,
  });
  if (!anchor) return null;
  const offset = resolveAnchorScrollOffset({ anchor, ...current });
  return offset == null ? null : { anchor, offset };
}

/**
 * Same-frame anchor lock. While the user reads older transcript, resolve the
 * scroll offset that keeps the anchored viewport-top row fixed for THIS
 * frame's prefix table — synchronously, before windowing uses it. Doing it
 * only in the post-commit effect rendered the frame that grew the streaming
 * tail with the stale offset first (a blank band at the top) and snapped it
 * shut a frame later. Falls back to the live scrollOffset state when there is
 * no active anchor (bottom-follow / pinned) or it cannot be aligned.
 *
 * Writes the captured anchor back into `anchorRef`/`anchorDirtyRef` when it
 * had to reconstruct one, and records this frame's viewport in
 * `prevViewportRef`.
 */
export function resolveRenderScrollOffset({
  scrollOffset,
  items,
  rowIndex,
  viewRows,
  floatingPanelRows,
  anchorRef,
  anchorDirtyRef,
  followingRef,
  scrollTargetRef,
  geomRef,
  prevViewportRef,
}) {
  const hasReadingAnchor = !!anchorRef.current && !anchorDirtyRef.current;
  // Any positive offset is a user reading position. Only the true bottom is
  // pinned, so a wheel notch inside the former slack band cannot re-enable
  // follow while a stream is appending rows.
  const scrolledUp = Math.max(0, Number(scrollTargetRef.current) || 0) > 0;
  // A genuine reading anchor wins even if followingRef is stale-true while the
  // user is scrolled up; the plain !following gate covers the anchor-less case.
  const anchorLockActive = hasReadingAnchor && !followingRef.current && scrolledUp;
  const targetNearBottom = followingRef.current || !scrolledUp;
  const nearBottomWithoutAnchor = !anchorRef.current && !anchorDirtyRef.current && targetNearBottom;
  const readingWithoutLock = !followingRef.current && !nearBottomWithoutAnchor && scrolledUp;
  let renderScrollOffset = targetNearBottom ? 0 : scrollOffset;
  const lockViewRows = Math.max(1, Number(viewRows) || 1);
  const lockTotalRows = Math.max(0, Number(rowIndex?.totalRows) || 0);
  const current = {
    items,
    curPrefix: rowIndex?.prefixRows || null,
    totalRows: lockTotalRows,
    viewRows: lockViewRows,
    maxRows: Math.max(0, lockTotalRows - lockViewRows),
  };
  const adopt = (lock) => {
    if (!lock) return;
    renderScrollOffset = lock.offset;
    // Persist so the post-commit effect keeps this exact anchor stable instead
    // of re-deriving one from the already-shifted geometry.
    anchorRef.current = lock.anchor;
    anchorDirtyRef.current = false;
  };
  if (anchorLockActive) {
    const locked = resolveAnchorScrollOffset({ anchor: anchorRef.current, ...current });
    if (locked != null) renderScrollOffset = locked;
  } else if (readingWithoutLock) {
    // Scrolled up with NO usable anchor (missing, dirtied by a manual scroll
    // whose synchronous capture failed, or dropped by a stale follow arm).
    // Rendering with the stale bottom-relative offset would let any row growth
    // this frame shift the visible top before the post-commit effect could
    // capture — the confirmed one-frame jump. Capture from the previous
    // published geometry instead (geomRef still holds the prior frame here).
    const geom = geomRef.current || {};
    adopt(lockToPreviousTopEdge({ geom, prevViewRows: geom.viewRows, current }));
  }
  // Viewport-only transition freeze: a floating panel / view open-close changes
  // the viewport height without changing `items`, so the bottom-relative offset
  // would re-slice against the new height while the on-screen top edge still
  // reflects the old one. Restricted to the scrolled-up, no-active-lock case;
  // bottom-pinned views are already stable under flex-end.
  const prevViewport = prevViewportRef.current || {};
  const viewportOnlyChanged =
    (Number(prevViewport.contentHeight) || 0) !== lockViewRows ||
    (Number(prevViewport.floatingPanelRows) || 0) !== (Number(floatingPanelRows) || 0);
  if (viewportOnlyChanged && !anchorLockActive && readingWithoutLock) {
    const geom = geomRef.current || {};
    adopt(
      lockToPreviousTopEdge({ geom, prevViewRows: Number(prevViewport.contentHeight) || geom.viewRows, current })
    );
  }
  prevViewportRef.current = { contentHeight: lockViewRows, floatingPanelRows: Number(floatingPanelRows) || 0 };
  return renderScrollOffset;
}
