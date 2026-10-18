import type { ReactVirtualizer } from '@tanstack/react-virtual';
import { type MutableRefObject, useCallback } from 'react';

/** The ref callbacks this list's elements bind: every mounted row registers
 *  with the core's measurement observer; the spacer becomes the core's
 *  container. (Offscreen rows are marked from the core's range at render.) */
export function useTranscriptRowRegistration({
  spacer,
  content,
  virtualizerRef,
}: {
  spacer: MutableRefObject<HTMLDivElement | null>;
  content: MutableRefObject<HTMLDivElement | null>;
  virtualizerRef: MutableRefObject<ReactVirtualizer<HTMLDivElement, HTMLDivElement>>;
}) {
  const measureRow = useCallback(
    (element: HTMLDivElement | null) => {
      // Registration only: the row's ResizeObserver delivers its box after this
      // frame's layout and before its paint, so no layout is read here.
      if (!element?.isConnected) return;
      const instance = virtualizerRef.current;
      const key = instance.options.getItemKey(instance.indexFromElement(element));
      const cached = instance.itemSizeCache.get(key);
      if (cached !== undefined) element.style.setProperty('--transcript-measured-height', `${cached}px`);
      instance.measureElement(element);
    },
    [virtualizerRef]
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
