import { type RefObject, useCallback, useEffect, useRef } from 'react';

/** What the reader did lately, as the scroll judgement needs it. Timestamps are Date.now() values; 0 is "never". */
export type FollowSignals = {
  wheelUpAt: number;
  keyUpAt: number;
  /** A press on the scrollbar's track is held. */
  barAt: number;
  /** A selection drag is autoscrolling the transcript up. */
  selectUpAt: number;
  /** A finger lifted from above the end. */
  touchEndUpAt: number;
  /** The last offset change was the reader's way back near the end (`moveArrivesNearEnd`). */
  arrived: boolean;
  /** Bottom arrival happened while holding a scrollbar/touch gesture so streaming growth before release still pins. */
  heldArrival: boolean;
  /** The scrollTop where the reader arrived at the bottom. */
  arrivedTop: number | null;
  touchStartTop: number;
  touchStartX: number;
  touchStartY: number;
  touchStartWriteAt: number;
  /** The finger travelled up or down beyond a tap. */
  touchMoved: boolean;
  /** The finger's last move dragged the transcript toward older rows. */
  touchDragsUp: boolean;
  touchScrolled: boolean;
};

function freshSignals(): FollowSignals {
  return {
    wheelUpAt: 0,
    keyUpAt: 0,
    barAt: 0,
    selectUpAt: 0,
    touchEndUpAt: 0,
    arrived: false,
    heldArrival: false,
    arrivedTop: null,
    touchStartTop: 0,
    touchStartX: 0,
    touchStartY: 0,
    touchStartWriteAt: 0,
    touchMoved: false,
    touchDragsUp: false,
    touchScrolled: false,
  };
}

/** The signals and the press release that ends their presses. */
export function useFollowSignals(viewport: RefObject<HTMLDivElement | null>) {
  const signals = useRef<FollowSignals>(freshSignals());

  const reset = useCallback(() => {
    signals.current = freshSignals();
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const view = element.ownerDocument.defaultView;
    const endPress = () => {
      signals.current.barAt = 0;
      signals.current.selectUpAt = 0;
    };
    const document = element.ownerDocument;
    document.addEventListener('mouseup', endPress, { passive: true });
    document.addEventListener('contextmenu', endPress, { passive: true });
    document.addEventListener('dragend', endPress, { passive: true });
    view?.addEventListener('blur', endPress, { passive: true });
    return () => {
      document.removeEventListener('mouseup', endPress);
      document.removeEventListener('contextmenu', endPress);
      document.removeEventListener('dragend', endPress);
      view?.removeEventListener('blur', endPress);
      endPress();
    };
  }, [viewport]);

  return { signals, reset };
}
