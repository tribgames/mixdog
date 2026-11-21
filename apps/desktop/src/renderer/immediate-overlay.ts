import { flushSync } from 'react-dom';
import { useRef } from 'react';

/** Commits `update` before the input event returns; React's event batching otherwise defers it to a later microtask. */
export function commitImmediateOverlay(update: () => void): void {
  flushSync(update);
}

/** A pointer activation is followed by a click that assistive bridges may synthesize with detail=0, so `detail` cannot tell it from a keyboard click. */
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
