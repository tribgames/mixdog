/**
 * transcript-anchor-sync.mjs — post-commit reconciliation of the App-owned
 * scroll refs (target/position/anchor/follow) against the transcript geometry
 * that just rendered. Pure functions over an explicit `refs` bundle; the hook
 * decides when each runs.
 */
import { resolveAnchorScrollOffset } from './transcript-window.mjs';
import { captureTopEdgeAnchor } from './transcript-anchor-lock.mjs';

function rows(value) {
  return Math.max(0, Number(value) || 0);
}

/**
 * Bottom follow: the viewport is already bottom-aligned by flex-end, so keep
 * every scroll ref at zero instead of animating row growth — injecting a
 * temporary positive offset during streaming made the transcript jump and
 * could clip the text being generated. `resumeFollow` re-arms the follow flag
 * when the reading position no longer exists.
 */
export function pinScrollToBottom(refs, { stopSmoothScroll, currentOffset, setScrollOffset, resumeFollow = false }) {
  stopSmoothScroll();
  refs.scrollTargetRef.current = 0;
  refs.scrollPositionRef.current = 0;
  refs.transcriptAnchorRef.current = null;
  refs.transcriptAnchorDirtyRef.current = false;
  if (resumeFollow) refs.followingRef.current = true;
  if (currentOffset !== 0) setScrollOffset(0);
}

/**
 * ABSOLUTE ANCHOR LOCK after a commit. While the user reads older transcript,
 * the item id + row offset at the viewport TOP edge is pinned; every commit
 * looks that item up in the CURRENT prefix table and re-derives the scroll
 * target so the anchored row stays put. Height changes below the anchor only
 * move the bottom; changes above it move the item's prefix start and are
 * absorbed the same way. No per-frame deltas, no drift.
 */
export function syncReadingAnchorAfterCommit({
  refs,
  dragActive,
  totalRows,
  previousTotalRows,
  rowIndex,
  items,
  viewRows,
  maxRows,
  scrollOffset,
  setScrollOffset,
  stopSmoothScroll,
}) {
  const { transcriptAnchorRef, transcriptAnchorDirtyRef, scrollTargetRef, scrollPositionRef, followingRef } = refs;
  const rowDelta = totalRows - previousTotalRows;
  const curPrefix = rowIndex?.prefixRows || null;
  if (previousTotalRows <= 0 || dragActive) return;
  const currentTarget = rows(scrollTargetRef.current);
  const currentPosition = rows(scrollPositionRef.current);
  const currentOffset = rows(scrollOffset);
  const maxScroll = rows(maxRows);
  const pin = (resumeFollow) =>
    pinScrollToBottom(refs, { stopSmoothScroll, currentOffset, setScrollOffset, resumeFollow });
  // ── Positional follow restore ────────────────────────────────────────
  // The follow arm is a FLAG, but the tail position is the truth. Any commit
  // that does not SHRINK content while the viewport sits exactly at the tail
  // means the user is at the bottom, whatever cleared the flag (a wheel tremor
  // that moved nothing, a click, a jump-to-bottom). Mirrors
  // render-node-to-output's `atBottom = sticky || (grew && scrollTop >=
  // prevMaxScroll)`; only a shrink is excluded because it can put the offset
  // at 0 as an artifact.
  if (!followingRef.current && rowDelta >= 0 && currentTarget === 0) {
    followingRef.current = true;
  }
  // Follow ownership is explicit: target=0 can also mean the first manual
  // read-back gesture is waiting for a newly mounted row measurement, so the
  // numeric offset alone never grants permission to chase the tail. While
  // following, both stream growth and viewport-only changes (swapping the text
  // entry for a picker) keep the transcript pinned instead of turning it into a
  // reading-anchor lock.
  if (followingRef.current) {
    pin(false);
    return;
  }
  const itemList = items || [];
  const view = Math.max(1, Number(viewRows) || 1);
  const anchor = transcriptAnchorRef.current;
  // (Re)capture the anchor from the current viewport-top edge when missing or
  // invalidated by a manual scroll; nothing to correct on that frame.
  if (!anchor || transcriptAnchorDirtyRef.current) {
    const captured = captureTopEdgeAnchor({
      prefixRows: curPrefix,
      items: itemList,
      totalRows,
      viewRows: view,
      offset: currentTarget,
    });
    if (captured) transcriptAnchorRef.current = captured;
    transcriptAnchorDirtyRef.current = false;
    return;
  }
  // Resolve with the SAME pure helper the render path uses, so the post-commit
  // state sync can never disagree with the synchronous render correction.
  const desired = resolveAnchorScrollOffset({
    anchor,
    items: itemList,
    curPrefix,
    totalRows,
    viewRows: view,
    maxRows: maxScroll,
  });
  if (desired == null) {
    // Anchor item gone (removal/compaction). On growth this is a transient
    // identity gap — re-capture next frame. When the anchored rows were
    // deleted the reading position no longer exists; leaving the lock in place
    // pinned the target above zero forever and auto-scroll stayed released
    // (user: 컴팩션된 이후로 자동 스크롤이 풀린다). A compaction commit can
    // NET-GROW the frame it lands in, so a bottom-relative target that no
    // longer fits the transcript is the same deletion signal without the sign
    // assumption.
    if (rowDelta < 0 || currentTarget > maxScroll) {
      pin(true);
      return;
    }
    transcriptAnchorDirtyRef.current = true;
    return;
  }
  const appliedDelta = desired - currentTarget;
  if (appliedDelta === 0) return;
  stopSmoothScroll();
  scrollTargetRef.current = desired;
  scrollPositionRef.current = Math.max(0, Math.min(maxScroll, currentPosition + appliedDelta));
  // The render path already applied `desired` synchronously through the anchor
  // lock. The refs stay the committed scroll authority; mirroring the same
  // correction back into React state from a layout effect creates a render →
  // layout update feedback path when transcript and viewport geometry change
  // together (React #185).
}

/** Unanchored and not following with target 0: the scroll refs/state must all
 *  read zero, so a stale position or offset is cleared. */
export function resetScrollWhenUnanchored(refs, { scrollOffset, setScrollOffset, stopSmoothScroll }) {
  const { transcriptAnchorRef, transcriptAnchorDirtyRef, scrollTargetRef, scrollPositionRef, followingRef } = refs;
  if (transcriptAnchorRef.current || transcriptAnchorDirtyRef.current || followingRef.current) return;
  const currentTarget = rows(scrollTargetRef.current);
  if (currentTarget !== 0) return;
  if (Math.max(currentTarget, rows(scrollPositionRef.current), rows(scrollOffset)) === 0) return;
  stopSmoothScroll();
  scrollTargetRef.current = 0;
  scrollPositionRef.current = 0;
  setScrollOffset(0);
}

/**
 * Auto-scroll rule (`if (!canScroll(el)) userScrolled = false`, applied on
 * scroll and on content resize): a transcript that no longer OVERFLOWS holds no
 * reading position, so a compaction or clear that shrinks it inside the
 * viewport re-arms follow. Otherwise clamp every scroll ref to the new max.
 */
export function clampScrollToOverflow(refs, { maxRows, scrollOffset, setScrollOffset, stopSmoothScroll }) {
  const { transcriptAnchorRef, transcriptAnchorDirtyRef, scrollTargetRef, scrollPositionRef, followingRef } = refs;
  const maxScroll = rows(maxRows);
  if (maxScroll === 0 && !followingRef.current) {
    transcriptAnchorRef.current = null;
    transcriptAnchorDirtyRef.current = false;
    followingRef.current = true;
  }
  if (scrollTargetRef.current <= maxScroll && scrollPositionRef.current <= maxScroll && scrollOffset <= maxScroll)
    return;
  stopSmoothScroll();
  const next = Math.max(0, Math.min(maxScroll, scrollTargetRef.current));
  scrollTargetRef.current = next;
  scrollPositionRef.current = next;
  setScrollOffset(Math.round(next));
}
