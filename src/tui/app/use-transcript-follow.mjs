/**
 * use-transcript-follow.mjs — the transcript's follow/glide state: the smooth
 * scroll animation toward scrollTargetRef, the sticky "follow the tail" arm,
 * and the two explicit transitions (reset to the tail, arm follow on submit).
 * pendingReadbackRowsRef preserves an upward intent that a zero committed
 * max blocked for one frame (applied by the scroll engine's layout effect).
 */
import { useCallback, useRef } from 'react';

export function useTranscriptFollow({
  scrollPositionRef,
  scrollTargetRef,
  followingRef,
  transcriptAnchorRef,
  transcriptAnchorDirtyRef,
  setScrollOffset,
}) {
  const scrollAnimationRef = useRef(null);
  const pendingReadbackRowsRef = useRef(0);

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
        // Landing at the true bottom must NOT drop an armed follow: the glide
        // was toward the live tail, and clearing the arm here left auto-scroll
        // off even though the user ended exactly where follow should resume.
        if (target > 0) followingRef.current = false;
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
    stopSmoothScroll();
    pendingReadbackRowsRef.current = 0;
    scrollPositionRef.current = 0;
    scrollTargetRef.current = 0;
    transcriptAnchorRef.current = null;
    transcriptAnchorDirtyRef.current = false;
    // An explicit "go to the tail" (Ctrl+End, transcript reset/compaction,
    // first item of a session) ARMS follow — it must not cancel it. Mirrors
    // ScrollKeybindingHandler's scroll:bottom, which ends in scrollToBottom()
    // and re-enables sticky. Cancelling here parked the viewport at the tail
    // with follow off, so the next growth commit captured a reading anchor
    // and every new row piled up below the fold.
    followingRef.current = true;
    setScrollOffset(0);
  }, [stopSmoothScroll]);

  const armTranscriptFollow = useCallback(() => {
    // Do not mutate scrollOffset here. During prompt submit the transcript rows
    // have not necessarily been committed yet; resetting immediately makes a
    // long transcript jump to the bottom, then jump again when the new row is
    // appended. Keep the current viewport stable and let the row-delta effect
    // perform the single bottom-follow when the transcript actually grows.
    transcriptAnchorRef.current = null;
    transcriptAnchorDirtyRef.current = false;
    pendingReadbackRowsRef.current = 0;
    followingRef.current = true;
    stopSmoothScroll();
  }, [stopSmoothScroll]);

  return {
    pendingReadbackRowsRef,
    stopSmoothScroll,
    startSmoothScroll,
    cancelTranscriptFollow,
    resetTranscriptScroll,
    armTranscriptFollow,
  };
}
