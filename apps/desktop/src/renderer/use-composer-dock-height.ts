import { useLayoutEffect, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';

/** The dock overlays the scroller. Only its measured footprint becomes bottom
 *  clearance; expanding a floating disclosure never resizes the viewport. */
export function useComposerDockHeight(ref: RefObject<HTMLElement | null>, enabled = true): number {
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = enabled ? ref.current : null;
    if (!element) {
      setHeight(0);
      return undefined;
    }
    let measured = element.offsetHeight;
    setHeight(measured);
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.borderBoxSize[0].blockSize);
      if (next === measured) return;
      measured = next;
      // The virtual spacer and its end pin must accept the new clearance in
      // this pre-paint delivery, not a later React render.
      flushSync(() => setHeight(next));
    });
    observer.observe(element, { box: 'border-box' });
    return () => observer.disconnect();
  }, [enabled, ref]);
  return height;
}
