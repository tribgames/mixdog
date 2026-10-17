import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

interface TabStripRevealOptions {
  stripRef: RefObject<HTMLElement | null>;
  tabNodes: RefObject<Map<string, HTMLDivElement>>;
  activeKey: string;
  signature: string;
  availableWidth: number;
  targetWidth: number | null;
}

/** Decide overflow from the destination layout, never a half-grown tab.
 *  Intermediate content/width overflow must not pan a run that will fit. */
export function useTabStripReveal({
  stripRef,
  tabNodes,
  activeKey,
  signature,
  availableWidth,
  targetWidth,
}: TabStripRevealOptions): void {
  // The strip may have been panned (an overflowing run, revealed or scrolled
  // by the user). A run that has fitted ever since has nothing to reset.
  const panned = useRef(false);
  const reveal = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || targetWidth === null || availableWidth <= 0) return;
    if (targetWidth <= availableWidth) {
      if (strip.scrollLeft !== 0) strip.scrollLeft = 0;
      panned.current = false;
      return;
    }

    panned.current = true;
    const node = tabNodes.current.get(activeKey);
    if (!node || strip.clientWidth <= 0) return;
    const viewport = strip.getBoundingClientRect();
    const tab = node.getBoundingClientRect();
    // Viewport-relative bounds also work when the strip is offset within
    // its pane. offsetLeft can instead be relative to a positioned ancestor.
    if (tab.right > viewport.right) {
      strip.scrollLeft += tab.right - viewport.right;
    } else if (tab.left < viewport.left) {
      strip.scrollLeft -= viewport.left - tab.left;
    }
  }, [activeKey, availableWidth, stripRef, tabNodes, targetWidth]);

  // The geometry reads run in the frame callback, not the commit: a layout
  // effect forced a synchronous layout of the incoming pane inside the
  // session-switch commit. The frame callback still precedes that frame's
  // paint, so the revealed scroll position lands in the same frame, and its
  // read reuses the layout the frame performs anyway.
  // biome-ignore lint/correctness/useExhaustiveDependencies: signature is the trigger that re-reveals when the tab set changes
  useLayoutEffect(() => {
    if (targetWidth === null || availableWidth <= 0) return undefined;
    if (targetWidth <= availableWidth && !panned.current) return undefined;
    const frame = window.requestAnimationFrame(reveal);
    return () => window.cancelAnimationFrame(frame);
  }, [availableWidth, reveal, signature, targetWidth]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    // Only genuinely overflowing runs need DOM geometry. When the selected
    // tab finishes growing, reveal its final edge even if the viewport's
    // width did not change (and therefore no ResizeObserver would fire).
    if (targetWidth === null || targetWidth <= availableWidth) return undefined;
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === tabNodes.current.get(activeKey) && event.propertyName === 'min-width') reveal();
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    observer?.observe(strip);
    strip.addEventListener('transitionend', onTransitionEnd);
    return () => {
      observer?.disconnect();
      strip.removeEventListener('transitionend', onTransitionEnd);
    };
  }, [activeKey, availableWidth, reveal, stripRef, tabNodes, targetWidth]);
}
