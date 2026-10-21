import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * One end-of-gesture path for pointer-captured resize handles. `finish(true)`
 * runs on pointerup (commit); `finish(false)` runs on pointercancel, lost
 * pointer capture, window blur, Escape, a superseding gesture or unmount
 * (revert to the last committed width). `finish` runs at most once per gesture.
 */
export function useResizeGesture(finish: (commit: boolean) => void) {
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const session = useRef<{
    target: Element;
    pointerId: number;
    onBlur(): void;
    onKeyDown(event: KeyboardEvent): void;
  } | null>(null);
  const end = useCallback((commit: boolean) => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    window.removeEventListener('blur', current.onBlur);
    window.removeEventListener('keydown', current.onKeyDown, true);
    try {
      current.target.releasePointerCapture(current.pointerId);
    } catch {
      // The pointer was already released (cancelled or element detached).
    }
    finishRef.current(commit);
  }, []);
  useEffect(() => () => end(false), [end]);
  const begin = (event: ReactPointerEvent<HTMLElement>) => {
    end(false);
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const onBlur = () => end(false);
    window.addEventListener('blur', onBlur);
    // The handle is pointer-captured, not focused: Escape is heard on the
    // window, in the capture phase so no inner handler can swallow it.
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === 'Escape') end(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    session.current = { target, pointerId: event.pointerId, onBlur, onKeyDown };
  };
  return {
    begin,
    handlers: {
      onPointerUp: () => end(true),
      onPointerCancel: () => end(false),
      onLostPointerCapture: () => end(false),
    },
  };
}
