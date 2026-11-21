import { type MutableRefObject, useRef } from 'react';
import type { TranscriptVirtualizer } from './transcript-list-geometry';
import { rowIsStreaming } from './transcript-list-held-shrinks';

const PENDING_SELECTOR = '[data-transcript-pending]';

/** Keeps a row's learned estimate while its markdown is pending
 *  (data-transcript-pending) and takes the settled box once the marker leaves.
 *  Must run before the resize patch captures resizeItem. */
export function useProvisionalRowResize({
  virtualizer,
  virtualizerRef,
  heldEstimates,
  fallbackEstimates,
}: {
  virtualizer: TranscriptVirtualizer;
  virtualizerRef: MutableRefObject<TranscriptVirtualizer>;
  heldEstimates: MutableRefObject<Map<unknown, number>>;
  fallbackEstimates: MutableRefObject<Set<unknown>>;
}) {
  const provisionalRows = useRef(new Set<HTMLElement>());
  const provisionalFrame = useRef(0);
  const wrappedResizeFor = useRef<TranscriptVirtualizer | null>(null);
  if (wrappedResizeFor.current !== virtualizer) {
    wrappedResizeFor.current = virtualizer;
    const coreResizeItem = virtualizer.resizeItem;
    const settleProvisional = () => {
      provisionalFrame.current = 0;
      const instance = virtualizerRef.current;
      for (const element of provisionalRows.current) {
        if (!element.isConnected) {
          provisionalRows.current.delete(element);
          continue;
        }
        if (element.querySelector(PENDING_SELECTOR)) continue;
        provisionalRows.current.delete(element);
        const index = instance.indexFromElement(element as HTMLDivElement);
        if (index >= 0 && index < instance.options.count) {
          instance.resizeItem(index, Math.round(element.getBoundingClientRect().height));
        }
      }
      if (provisionalRows.current.size > 0) {
        provisionalFrame.current = window.requestAnimationFrame(settleProvisional);
      }
    };
    virtualizer.resizeItem = (index, size) => {
      const key = virtualizer.options.getItemKey(index);
      const element = virtualizer.elementsCache.get(key);
      const held = heldEstimates.current.get(key);
      const following = virtualizer.options.anchorTo === 'end' || virtualizer.options.followOnAppend;
      const takesPendingBox = element ? following && !rowIsStreaming(element) : false;
      if (
        element &&
        held !== undefined &&
        !takesPendingBox &&
        !fallbackEstimates.current.has(key) &&
        (provisionalRows.current.has(element) || !virtualizer.itemSizeCache.has(key)) &&
        element.querySelector(PENDING_SELECTOR)
      ) {
        provisionalRows.current.add(element);
        if (!provisionalFrame.current) provisionalFrame.current = window.requestAnimationFrame(settleProvisional);
        coreResizeItem(index, following ? Math.max(held, size) : held);
        return;
      }
      coreResizeItem(index, size);
    };
  }
  return provisionalFrame;
}
