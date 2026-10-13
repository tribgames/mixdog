import { useLayoutEffect, type RefObject } from 'react';

/** Frames (~0.75s) the slot rect is watched after a layout event — longer than
 *  the phone sheet's slide. */
const SETTLE_FRAMES = 45;

/** Re-measures a persistent surface's slot (resize, layout, finished
 *  transitions) through `controller.refresh`, coalesced to one per frame.
 *  `observeWorkspace` also watches the enclosing `.main-panel`, which an
 *  expanded surface follows instead of its slot. */
export function useSlotRemeasure(
  slotRef: RefObject<HTMLDivElement | null>,
  active: boolean,
  controller: { refresh(sessionId: string): void },
  sessionId: string,
  observeWorkspace = false
): void {
  useLayoutEffect(() => {
    const node = slotRef.current;
    if (!node || !active) return undefined;
    let frame = 0;
    let trackFrame = 0;
    let trackFramesLeft = 0;
    let appliedRect = '';
    const slotRect = () => {
      const rect = node.getBoundingClientRect();
      return `${rect.left}|${rect.top}|${rect.width}|${rect.height}`;
    };
    const refresh = () => {
      appliedRect = slotRect();
      controller.refresh(sessionId);
    };
    // A slot that only MOVES (the phone sheet slides in via transform) fires
    // neither a ResizeObserver nor, until the very end, a transitionend. Poll
    // its rect per frame through the settle window after any layout event and
    // re-measure whenever it differs from the last applied one.
    const track = () => {
      trackFrame = 0;
      if (slotRect() !== appliedRect) refresh();
      trackFramesLeft -= 1;
      if (trackFramesLeft > 0) trackFrame = window.requestAnimationFrame(track);
    };
    const settle = () => {
      if (typeof window.requestAnimationFrame !== 'function') return;
      trackFramesLeft = SETTLE_FRAMES;
      if (!trackFrame) trackFrame = window.requestAnimationFrame(track);
    };
    const schedule = () => {
      settle();
      if (typeof window.requestAnimationFrame !== 'function') {
        refresh();
        return;
      }
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        refresh();
      });
    };
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    observer?.observe(node);
    const workspace = observeWorkspace ? node.closest('.main-panel') : null;
    if (workspace) observer?.observe(workspace);
    window.addEventListener('resize', schedule);
    // The phone dock SLIDES in: only the slot's position changes during the
    // transform, so a mid-slide rect would pin the surface off-screen. Any
    // finished transition re-measures.
    window.addEventListener('transitionend', schedule, true);
    window.addEventListener('transitionrun', settle, true);
    window.addEventListener('transitioncancel', schedule, true);
    schedule();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (trackFrame) window.cancelAnimationFrame(trackFrame);
      window.removeEventListener('transitionrun', settle, true);
      window.removeEventListener('transitioncancel', schedule, true);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('transitionend', schedule, true);
    };
  }, [active, controller, observeWorkspace, sessionId, slotRef]);
}
