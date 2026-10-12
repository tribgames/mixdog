/**
 * components/use-spinner-progress.mjs — time/token bookkeeping for Spinner.
 *
 * Owns the refs behind pause accounting, stall smoothing and the animated token
 * counter. Everything is derived at render time from the caller's `now`/`frame`
 * (the Spinner's single shared tick drives re-renders; no timers here).
 */
import { useRef } from 'react';

// Stall: response must grow within this window or the glyph reddens.
const STALL_TIMEOUT_MS = 3000;
const STALL_FADE_MS = 2000; // fade red over 2s

export function useSpinnerProgress({
  now,
  startedAt,
  rawElapsedMs,
  frame,
  outputTokens = 0,
  tokens = 0,
  paused = false,
  hasActiveTools = false,
  mode = 'responding',
  reducedMotion = false,
}) {
  const lastGrowRef = useRef(now);
  const lastTokensRef = useRef(0);
  const displayedOutputRef = useRef(0);
  // Pause accounting: time spent waiting on the USER (a tool approval prompt)
  // is not turn time. Without this the reported duration counts however long
  // the prompt sat unanswered and the short-turn token gate opens on it.
  const turnAnchorRef = useRef(startedAt);
  const pausedTotalRef = useRef(0);
  const pauseStartRef = useRef(0);
  // Stall smoothing refs (exponential fade)
  const stallSmoothRef = useRef(0);
  const lastStallTickRef = useRef(0);

  if (turnAnchorRef.current !== startedAt) {
    turnAnchorRef.current = startedAt;
    pausedTotalRef.current = 0;
    pauseStartRef.current = 0;
  }
  if (paused && !pauseStartRef.current) {
    pauseStartRef.current = now;
  } else if (!paused && pauseStartRef.current) {
    pausedTotalRef.current += Math.max(0, now - pauseStartRef.current);
    pauseStartRef.current = 0;
  }
  const pausedMs = pausedTotalRef.current + (pauseStartRef.current ? Math.max(0, now - pauseStartRef.current) : 0);
  const elapsedMs = Math.max(0, rawElapsedMs - pausedMs);

  const targetOutputTokens = Math.max(0, Number(outputTokens || tokens || 0));

  // Stall detection — track output growth, because input usually arrives as one
  // usage update while the assistant/tool response is what should keep moving.
  if (targetOutputTokens > lastTokensRef.current) {
    lastTokensRef.current = targetOutputTokens;
    lastGrowRef.current = now;
  }

  // Waiting is not stalling: while a tool runs (no tokens can arrive) or while
  // the user owns an approval prompt, hold the stall clock at zero. Otherwise a
  // 30s shell command or a slow approval reddens a perfectly healthy turn.
  const workBlocked = paused || hasActiveTools || mode === 'tool-use' || mode === 'tool-input';
  if (workBlocked) lastGrowRef.current = now;

  const stallMs = now - lastGrowRef.current;
  const isStalled = !reducedMotion && targetOutputTokens > 0 && stallMs > STALL_TIMEOUT_MS;
  // Stall smoothing: exponential fade toward target
  const rawIntensity = isStalled ? Math.min(1, (stallMs - STALL_TIMEOUT_MS) / STALL_FADE_MS) : 0;
  if (rawIntensity > 0 || stallSmoothRef.current > 0) {
    const dt = frame - lastStallTickRef.current;
    if (dt > 0) {
      let cur = stallSmoothRef.current;
      for (let i = 0; i < dt; i++) {
        const diff = rawIntensity - cur;
        if (Math.abs(diff) < 0.01) {
          cur = rawIntensity;
          break;
        }
        cur += diff * 0.1;
      }
      stallSmoothRef.current = cur;
    }
  }
  lastStallTickRef.current = frame;
  const stalledIntensity = stallSmoothRef.current;

  const advanceCounter = (ref, target) => {
    if (reducedMotion) {
      ref.current = target;
      return Math.round(target);
    }
    if (ref.current > target) {
      ref.current = target;
    } else if (ref.current < target) {
      const gap = target - ref.current;
      let increment;
      if (gap < 70) increment = 3;
      else if (gap < 200) increment = Math.max(8, Math.ceil(gap * 0.15));
      else increment = 50;
      ref.current = Math.min(ref.current + increment, target);
    }
    return Math.round(ref.current);
  };

  // Token counter animation: smoothly incremented toward the current turn's
  // output token count. Input token totals are not shown.
  const displayedOutputTokens = advanceCounter(displayedOutputRef, targetOutputTokens);

  return { elapsedMs, stalledIntensity, displayedOutputTokens };
}
