import { type MutableRefObject, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  distanceFromBottom,
  JUMP_PIN_MS,
  JUMP_PIN_SETTLE_FRAMES,
  jumpButtonVisible,
  scrollMetrics,
  transcriptScrollGeometryRegistered,
} from './transcript-follow-rules';

/** Jump-to-latest re-pin loop: frame handle, deadline, settled-frame count.
 *  Chromium's wheel/fling animation keeps writing scrollTop after the click,
 *  and it cannot be cancelled from JS — so the tail is simply re-taken every
 *  frame until the offset holds still or the short deadline expires. A new
 *  reader gesture cancels the loop, so the reader always wins. */
export function useJumpPin({
  viewport,
  followingRef,
  scrollToEndRef,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  followingRef: RefObject<boolean>;
  scrollToEndRef?: MutableRefObject<(behavior?: ScrollBehavior) => void>;
}) {
  const jumpPinFrame = useRef(0);
  const jumpPinUntil = useRef(0);
  const jumpPinSettled = useRef(0);

  const cancelJumpPin = useCallback(() => {
    if (jumpPinFrame.current) window.cancelAnimationFrame(jumpPinFrame.current);
    jumpPinFrame.current = 0;
    jumpPinUntil.current = 0;
    jumpPinSettled.current = 0;
  }, []);

  const startJumpPin = useCallback(() => {
    if (!viewport.current) return;
    jumpPinUntil.current = Date.now() + JUMP_PIN_MS;
    jumpPinSettled.current = 0;
    const step = () => {
      jumpPinFrame.current = 0;
      const root = viewport.current;
      if (!root || !followingRef.current || Date.now() >= jumpPinUntil.current) {
        cancelJumpPin();
        return;
      }
      if (distanceFromBottom(scrollMetrics(root)) < 2) {
        jumpPinSettled.current += 1;
        if (jumpPinSettled.current >= JUMP_PIN_SETTLE_FRAMES) {
          cancelJumpPin();
          return;
        }
      } else {
        jumpPinSettled.current = 0;
        scrollToEndRef?.current?.('auto');
      }
      jumpPinFrame.current = window.requestAnimationFrame(step);
    };
    if (jumpPinFrame.current) window.cancelAnimationFrame(jumpPinFrame.current);
    jumpPinFrame.current = window.requestAnimationFrame(step);
  }, [cancelJumpPin, followingRef, scrollToEndRef, viewport]);

  useEffect(
    () => () => {
      if (jumpPinFrame.current) window.cancelAnimationFrame(jumpPinFrame.current);
    },
    []
  );

  return { cancelJumpPin, startJumpPin };
}

/** Whether the jump-to-latest button shows, refreshed at most once a frame. */
export function useJumpButtonState() {
  const [showJump, setShowJump] = useState(false);
  const scrollStateFrame = useRef(0);
  const scrollStateTarget = useRef<HTMLDivElement | null>(null);

  const updateScrollState = useCallback((element: HTMLDivElement) => {
    // No timeline mounted yet: nothing to jump to, and the DOM fallback would
    // force a layout of the opening pane from this animation frame.
    const jump = transcriptScrollGeometryRegistered(element) && jumpButtonVisible(scrollMetrics(element));
    setShowJump((current) => (current === jump ? current : jump));
  }, []);

  const scheduleScrollState = useCallback(
    (element: HTMLDivElement) => {
      scrollStateTarget.current = element;
      if (scrollStateFrame.current) return;
      scrollStateFrame.current = window.requestAnimationFrame(() => {
        scrollStateFrame.current = 0;
        const target = scrollStateTarget.current;
        scrollStateTarget.current = null;
        if (target) updateScrollState(target);
      });
    },
    [updateScrollState]
  );

  useEffect(
    () => () => {
      if (scrollStateFrame.current) window.cancelAnimationFrame(scrollStateFrame.current);
    },
    []
  );

  return { showJump, scheduleScrollState };
}
