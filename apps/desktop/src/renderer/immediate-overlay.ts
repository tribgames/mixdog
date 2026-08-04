import { flushSync } from 'react-dom';
import { useRef } from 'react';

/**
 * Tiny transient surfaces must exist before the originating input event
 * returns. React's default event batching otherwise leaves a menu absent until
 * the following microtask, which becomes a visible frame under renderer load.
 */
export function commitImmediateOverlay(update: () => void): void {
  flushSync(update);
}

/**
 * A primary pointer activation is followed by a click. Tests and assistive
 * bridges may synthesize that click with detail=0, so detail alone cannot
 * distinguish it from a standalone keyboard click.
 */
export function useImmediateOverlayClickGuard() {
  const pointerActivation = useRef(false);
  return {
    markPointerActivation() {
      pointerActivation.current = true;
    },
    consumePointerClick(): boolean {
      if (!pointerActivation.current) return false;
      pointerActivation.current = false;
      return true;
    },
    clearPointerActivation() {
      pointerActivation.current = false;
    },
  };
}
