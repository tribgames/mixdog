import { useLayoutEffect, type RefObject, type WheelEvent } from 'react';

/** A tab strip fades an edge only while tabs lie past it (tab-strip.css). */
export function markTabStripFades(strip: HTMLElement): void {
  const rest = strip.scrollWidth - strip.clientWidth - strip.scrollLeft;
  strip.toggleAttribute('data-fade-start', strip.scrollLeft > 1);
  strip.toggleAttribute('data-fade-end', rest > 1);
}

/** The vertical wheel drives the strip's horizontal run, as on the pane strip
 *  (a sideways wheel or trackpad already scrolls it natively). */
export function scrollTabStripByWheel(event: WheelEvent<HTMLElement>): void {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.currentTarget.scrollBy?.({ left: event.deltaY, behavior: 'auto' });
  }
}

/** A strip that scrolls keeps its selected tab (`.is-active`) in view and its
 *  edge fades current as its tabs and selection (`tabsKey`) or widths change. */
export function useTabStripFades(strip: RefObject<HTMLElement | null>, tabsKey: string): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: tabsKey names the tabs and the selection the strip shows
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return undefined;
    const update = () => {
      const tab = element.querySelector<HTMLElement>(':scope > .browser-tab.is-active');
      if (tab) {
        const box = element.getBoundingClientRect();
        const cell = tab.getBoundingClientRect();
        if (cell.left < box.left) element.scrollLeft += cell.left - box.left;
        else if (cell.right > box.right) element.scrollLeft += cell.right - box.right;
      }
      markTabStripFades(element);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [strip, tabsKey]);
}
