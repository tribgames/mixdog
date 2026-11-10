/*
 * app/use-transcript-scroll-state.mjs — the transcript scroll/follow state and
 * refs App shares between the scroll engine, the mouse handler and the
 * transcript window. State + refs only; behavior lives in the consuming hooks.
 */
import { useRef, useState } from 'react';

export function useTranscriptScrollState() {
  // scrollOffset = how many transcript ROWS we've scrolled UP from the bottom
  // (0 = pinned to the latest, showing the newest content). Mouse wheel adjusts
  // it; accepted prompts only arm bottom-follow; the snap happens when the
  // transcript actually grows.
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollPositionRef = useRef(0);
  const scrollTargetRef = useRef(0);
  const maxScrollRowsRef = useRef(0);
  const transcriptBottomSlackRowsRef = useRef(0);
  // Absolute reading-anchor lock. While the user reads older transcript, we
  // capture the item id + row offset at the VIEWPORT TOP edge once, then re-
  // derive scrollOffset from that anchor on every commit. Streaming tail growth
  // (or any height change BELOW the anchor) only moves the bottom, so the top
  // item stays pinned — no incremental drift, no jump on newline. `dirty` forces
  // a re-capture after a manual scroll; cleared to null when we follow/pin the
  // bottom so a fresh scroll-up starts a new anchor.
  const transcriptAnchorRef = useRef(null);
  const transcriptAnchorDirtyRef = useRef(false);
  // Latest render's prefix-row table + dimensions, so a manual scroll can
  // capture the reading anchor SYNCHRONOUSLY (in the wheel/key callback) instead
  // of waiting for the post-commit effect — otherwise each scroll notch leaves
  // the anchor "dirty" for one frame, and if streaming grows the transcript on
  // that same frame the lock is not engaged yet and the view lurches.
  const transcriptGeomRef = useRef({ prefixRows: null, totalRows: 0, viewRows: 1 });
  // Bumped by the measured-height harvest (useTranscriptWindow) and the mouse
  // drag-release re-measure (useMouseInput) so the row-index memo recomputes
  // against corrected heights. Owned here because both hooks consume it.
  const [measuredRowsVersion, setMeasuredRowsVersion] = useState(0);
  // Auto-follow is separate from manual scroll. While true, new transcript rows
  // (new items or streaming text wrapping to another line) are folded into the
  // same glide back to the bottom.
  const followingRef = useRef(false);
  const lastItemsCountRef = useRef(0);
  // Head item of the last committed transcript: a bulk swap (session load /
  // clear / compaction trim) changes it, a live append never does.
  const lastFirstItemIdRef = useRef(null);
  return {
    scrollOffset,
    setScrollOffset,
    scrollPositionRef,
    scrollTargetRef,
    maxScrollRowsRef,
    transcriptBottomSlackRowsRef,
    transcriptAnchorRef,
    transcriptAnchorDirtyRef,
    transcriptGeomRef,
    measuredRowsVersion,
    setMeasuredRowsVersion,
    followingRef,
    lastItemsCountRef,
    lastFirstItemIdRef,
  };
}
