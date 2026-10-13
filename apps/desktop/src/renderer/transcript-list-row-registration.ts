import type { ReactVirtualizer } from '@tanstack/react-virtual';
import { type MutableRefObject, type RefObject, useCallback, useEffect, useRef } from 'react';

/** The ref callbacks this list's elements bind: every mounted row registers
 *  with the core's measurement observer and with the offscreen observer; the
 *  spacer becomes the core's container. */
export function useTranscriptRowRegistration({
  viewport,
  spacer,
  content,
  virtualizerRef,
}: {
  viewport: RefObject<HTMLDivElement | null>;
  spacer: MutableRefObject<HTMLDivElement | null>;
  content: MutableRefObject<HTMLDivElement | null>;
  virtualizerRef: MutableRefObject<ReactVirtualizer<HTMLDivElement, HTMLDivElement>>;
}) {
  // Rows outside the viewport carry data-offscreen, which holds their infinite
  // loaders still (12-transcript.css). The live row stays mounted however far
  // the reader scrolls away, and its logo otherwise repainted every frame.
  const offscreenObserver = useRef<IntersectionObserver | null>(null);
  const observeOffscreen = useCallback(
    (element: HTMLDivElement) => {
      if (typeof IntersectionObserver !== 'function') return undefined;
      let observer = offscreenObserver.current;
      if (!observer) {
        const root = viewport.current;
        if (!root) return undefined;
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) entry.target.removeAttribute('data-offscreen');
              else entry.target.setAttribute('data-offscreen', 'true');
            }
          },
          { root }
        );
        offscreenObserver.current = observer;
      }
      const active = observer;
      active.observe(element);
      return () => active.unobserve(element);
    },
    [viewport]
  );
  useEffect(
    () => () => {
      offscreenObserver.current?.disconnect();
      offscreenObserver.current = null;
    },
    []
  );
  const measureRow = useCallback(
    (element: HTMLDivElement | null) => {
      // Registration only: the row's ResizeObserver delivers its box after this
      // frame's layout and before its paint, so no layout is read here.
      if (!element?.isConnected) return undefined;
      const instance = virtualizerRef.current;
      const key = instance.options.getItemKey(instance.indexFromElement(element));
      const cached = instance.itemSizeCache.get(key);
      if (cached !== undefined) element.style.setProperty('--transcript-measured-height', `${cached}px`);
      instance.measureElement(element);
      return observeOffscreen(element);
    },
    [observeOffscreen, virtualizerRef]
  );
  const bindSpacer = useCallback(
    (element: HTMLDivElement | null) => {
      spacer.current = element;
      content.current = element;
      // Direct DOM updates keep the spacer height current between React commits.
      virtualizerRef.current.containerRef(element);
    },
    [content, spacer, virtualizerRef]
  );
  return { measureRow, bindSpacer };
}
