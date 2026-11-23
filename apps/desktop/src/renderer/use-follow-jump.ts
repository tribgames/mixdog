import { type MutableRefObject, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  distanceFromBottom,
  JUMP_PIN_MS,
  JUMP_PIN_SETTLE_FRAMES,
  jumpButtonVisible,
  scrollMetrics,
  standsAtEnd,
  transcriptScrollGeometryRegistered,
} from './transcript-follow-rules';

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

/** Whether the jump-to-latest button shows, refreshed at most once a frame, wherever the distance to the end changes
 *  (a scroll, the content or the viewport resizing, follow turning on or off). Standing at the end is following: a view
 *  with follow off that stands there takes it back (`atEnd`). */
export function useJumpButtonState({
  followingRef,
  holds,
  atEnd,
}: {
  followingRef: RefObject<boolean>;
  /** A selection holds follow: the end is not kept while it lasts. */
  holds(): boolean;
  /** Follow is off and the view stands at the end: takes follow back, or answers true while the reader's input still
   *  in flight has to end first. */
  atEnd: RefObject<() => boolean>;
}) {
  const [showJump, setShowJump] = useState(false);
  const scrollStateFrame = useRef(0);
  const scrollStateTarget = useRef<HTMLDivElement | null>(null);

  /** Answers true when the view has to be looked at again next frame. */
  const updateScrollState = useCallback(
    (element: HTMLDivElement): boolean => {
      // No timeline mounted yet: nothing to jump to, and the DOM fallback would
      // force a layout of the opening pane from this animation frame.
      if (!transcriptScrollGeometryRegistered(element)) {
        setShowJump(false);
        return false;
      }
      const metrics = scrollMetrics(element);
      const wait = !followingRef.current && standsAtEnd(metrics) && atEnd.current();
      const jump = jumpButtonVisible(metrics, followingRef.current && !holds());
      setShowJump((current) => (current === jump ? current : jump));
      return wait;
    },
    [atEnd, followingRef, holds]
  );

  const scheduleScrollState = useCallback(
    (element: HTMLDivElement) => {
      scrollStateTarget.current = element;
      if (scrollStateFrame.current) return;
      const frame = (): void => {
        scrollStateFrame.current = 0;
        const target = scrollStateTarget.current;
        scrollStateTarget.current = null;
        if (!target || !updateScrollState(target)) return;
        scrollStateTarget.current ??= target;
        scrollStateFrame.current ||= window.requestAnimationFrame(frame);
      };
      scrollStateFrame.current = window.requestAnimationFrame(frame);
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
