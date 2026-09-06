import { useCallback, useLayoutEffect, type RefObject } from "react";

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
  const reveal = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || targetWidth === null || availableWidth <= 0) return;
    if (targetWidth <= availableWidth) {
      if (strip.scrollLeft !== 0) strip.scrollLeft = 0;
      return;
    }

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

  useLayoutEffect(() => {
    reveal();
  }, [reveal, signature]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return undefined;
    // Only genuinely overflowing runs need DOM geometry. When the selected
    // tab finishes growing, reveal its final edge even if the viewport's
    // width did not change (and therefore no ResizeObserver would fire).
    if (targetWidth === null || targetWidth <= availableWidth) return undefined;
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === tabNodes.current.get(activeKey)
        && event.propertyName === "min-width") reveal();
    };
    const observer = typeof ResizeObserver === "undefined"
      ? null : new ResizeObserver(reveal);
    observer?.observe(strip);
    strip.addEventListener("transitionend", onTransitionEnd);
    return () => {
      observer?.disconnect();
      strip.removeEventListener("transitionend", onTransitionEnd);
    };
  }, [activeKey, availableWidth, reveal, stripRef, tabNodes, targetWidth]);
}
