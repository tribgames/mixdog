import { type RefObject, useCallback, useEffect, useRef } from 'react';
import { mutationIsOwnRestore } from './transcript-follow-rules';

/** What the reader and the page did lately, as the scroll judgement needs it.
 *  Timestamps are Date.now() values; 0 is "never" except mutationAt, whose
 *  "never" is -Infinity so a fresh value is always newer than a restore. */
export type FollowSignals = {
  wheelUpAt: number;
  keyUpAt: number;
  /** A mouse press inside the transcript is held (scrollbar, selection drag). */
  pressAt: number;
  /** A finger lifted from above the end. */
  touchEndUpAt: number;
  /** The last DOM mutation or width change not caused by a restore. */
  mutationAt: number;
  /** The last time a scroll was put back at the end. */
  restoredAt: number;
  /** The scroller's content width and the client width it had then. */
  width: { box: number; client: number; spent: number | null } | null;
  zoom: number;
  /** Direction of the last offset change: 1 down, -1 up, 0 unknown. */
  direction: number;
  touchStartTop: number;
  touchStartY: number;
  touchStartWriteAt: number;
  touchMoved: boolean;
  touchScrolled: boolean;
};

function freshSignals(): FollowSignals {
  return {
    wheelUpAt: 0,
    keyUpAt: 0,
    pressAt: 0,
    touchEndUpAt: 0,
    mutationAt: Number.NEGATIVE_INFINITY,
    restoredAt: Number.NEGATIVE_INFINITY,
    width: null,
    zoom: (typeof window === 'undefined' ? 1 : window.devicePixelRatio) || 1,
    direction: 0,
    touchStartTop: 0,
    touchStartY: 0,
    touchStartWriteAt: 0,
    touchMoved: false,
    touchScrolled: false,
  };
}

/** The signals, the observers that feed them, and the press release. */
export function useFollowSignals(viewport: RefObject<HTMLDivElement | null>) {
  const signals = useRef<FollowSignals>(freshSignals());

  /** A reader gesture explains the scroll by itself: no layout change need. */
  const clearMutation = useCallback(() => {
    signals.current.mutationAt = Number.NEGATIVE_INFINITY;
  }, []);

  const reset = useCallback(() => {
    signals.current = freshSignals();
  }, []);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return undefined;
    const view = element.ownerDocument.defaultView;
    const mutations =
      typeof MutationObserver === 'function'
        ? new MutationObserver(() => {
            const now = Date.now();
            if (!mutationIsOwnRestore({ restoredAt: signals.current.restoredAt, now })) {
              signals.current.mutationAt = now;
            }
          })
        : null;
    mutations?.observe(element, { childList: true, subtree: true, characterData: true });
    const widths =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver((entries) => {
            const entry = entries.find((candidate) => candidate.target === element);
            if (!entry) return;
            const width = entry.contentRect.width;
            const seen = signals.current.width;
            if (seen !== null && seen.box === width) return;
            if (seen !== null) signals.current.mutationAt = Date.now();
            signals.current.width = { box: width, client: element.clientWidth, spent: null };
          })
        : null;
    widths?.observe(element);
    const endPress = () => {
      signals.current.pressAt = 0;
    };
    const document = element.ownerDocument;
    document.addEventListener('mouseup', endPress, { passive: true });
    document.addEventListener('contextmenu', endPress, { passive: true });
    document.addEventListener('dragend', endPress, { passive: true });
    view?.addEventListener('blur', endPress, { passive: true });
    return () => {
      mutations?.disconnect();
      widths?.disconnect();
      document.removeEventListener('mouseup', endPress);
      document.removeEventListener('contextmenu', endPress);
      document.removeEventListener('dragend', endPress);
      view?.removeEventListener('blur', endPress);
      signals.current.pressAt = 0;
    };
  }, [viewport]);

  return { signals, clearMutation, reset };
}
