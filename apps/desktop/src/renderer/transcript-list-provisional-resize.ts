import { type MutableRefObject, useRef } from 'react';
import type { TranscriptVirtualizer } from './transcript-list-geometry';
import { rowIsStreaming } from './transcript-list-held-shrinks';

/** A row whose markdown is still parsing (data-transcript-pending) renders a
 *  source fallback whose box is not its settled height (a reply measured
 *  272px pending, then 264px), so every reply first met above the reader was
 *  corrected twice. When the row already has a learned estimate (and is a
 *  streaming reply, or the timeline is away from its end), the core
 *  keeps that estimate while the row is pending — the clipped row box is the
 *  geometry, so at most a few pixels of fallback overlap the next row — and
 *  takes the settled box once the marker leaves. Must run before the resize
 *  patch captures resizeItem, so landings and deferrals see it too. */
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
        if (element.querySelector('[data-transcript-pending]')) continue;
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
      // A followed timeline takes a settled row's pending box as it is: the
      // source fallback of a finished reply is (nearly) its parsed height,
      // while a learned estimate can be far off (a shape median). Held at
      // that estimate, the end pin moved every row above it by the error for
      // the frames until the parse landed, then back: opening a chat painted
      // its upper rows 40px high, then dropped them (user: 들어갈 때 위로
      // 튀었다가 내려온다). Only a streaming reply's fallback is transient.
      if (
        element &&
        held !== undefined &&
        !(following && !rowIsStreaming(element)) &&
        !fallbackEstimates.current.has(key) &&
        (provisionalRows.current.has(element) || !virtualizer.itemSizeCache.has(key)) &&
        element.querySelector('[data-transcript-pending]')
      ) {
        provisionalRows.current.add(element);
        if (!provisionalFrame.current) provisionalFrame.current = window.requestAnimationFrame(settleProvisional);
        // A followed timeline is pinned to its end: a fallback that outgrows
        // the estimate (a streaming reply's next line) takes its box in this
        // frame. Held at the estimate, the row grew below the pinned end with
        // the spacer and offset stale, and the tail jumped into place a frame
        // later, when the parse settled.
        coreResizeItem(index, following ? Math.max(held, size) : held);
        return;
      }
      coreResizeItem(index, size);
    };
  }
  return provisionalFrame;
}
