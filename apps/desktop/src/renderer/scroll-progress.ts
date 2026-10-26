// Scroll position as CSS numbers, for the phone layout only.
//
// The desktop edge fades ride CSS scroll-driven animations (`scroll-timeline`
// / `animation-timeline`). Android WebView 153-156 freezes a touch fling after
// finger lift whenever ANY scroll timeline is alive on the page and lands the
// rest of the distance in one jump (Chromium 572898003, fixed in M157). On the
// phone layout the CSS drops every timeline (`html[data-mixdog-mobile-tabs]`
// rules next to each one) and reads these two registered numbers instead
// (font-faces.css): the scroller's `scrollTop`, and its scrollable distance
// (0 = the list cannot scroll, where the timeline was inactive). The CSS
// applies the same ranges the timelines used.
import { type RefObject, useEffect } from 'react';
import { usePhoneSurfaceMarked } from './mobile-surface';

const TOP = '--mx-scroll-top';
const MAX = '--mx-scroll-max';

/** Mirrors `scroller`'s scroll position onto itself and onto `hosts` (a
 *  selector matched among the scroller's parent's descendants: sibling
 *  elements whose fades follow this scroller). One passive listener, one write
 *  per frame; returns the unbind. */
export function bindScrollProgress(scroller: HTMLElement, hosts?: string): () => void {
  const targets = [scroller, ...(hosts ? (scroller.parentElement?.querySelectorAll<HTMLElement>(hosts) ?? []) : [])];
  let frame = 0;
  let top = Number.NaN;
  let max = Number.NaN;
  const write = (): void => {
    const nextTop = scroller.scrollTop;
    const nextMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    if (nextTop === top && nextMax === max) return;
    top = nextTop;
    max = nextMax;
    for (const target of targets) {
      target.style.setProperty(TOP, String(top));
      target.style.setProperty(MAX, String(max));
    }
  };
  // Only the frame callback clears `frame`: a direct write (resize) must not
  // orphan a pending frame that the unbind could then no longer cancel.
  const onFrame = (): void => {
    frame = 0;
    write();
  };
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(onFrame);
  };
  // Content growing without a scroll event (rows arriving, a palette
  // filtering) changes the scrollable distance: watch the scroller and the
  // boxes it holds.
  const resize = new ResizeObserver(write);
  const watched = new Set<Element>();
  const watch = (): void => {
    for (const child of scroller.children) {
      if (watched.has(child)) continue;
      watched.add(child);
      resize.observe(child);
    }
  };
  // The document's own realm, like mobile-surface's marker observer.
  const children = new (scroller.ownerDocument.defaultView as Window & typeof globalThis).MutationObserver(
    (records) => {
      // Rows that left the list are released, not kept observed until unmount.
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (!watched.delete(node as Element)) continue;
          resize.unobserve(node as Element);
        }
      }
      watch();
      schedule();
    }
  );
  scroller.addEventListener('scroll', schedule, { passive: true });
  resize.observe(scroller);
  children.observe(scroller, { childList: true });
  watch();
  write();
  return () => {
    scroller.removeEventListener('scroll', schedule);
    resize.disconnect();
    children.disconnect();
    if (frame !== 0) cancelAnimationFrame(frame);
    for (const target of targets) {
      target.style.removeProperty(TOP);
      target.style.removeProperty(MAX);
    }
  };
}

/** Binds the scroller in `ref` while the phone layout is on; follows
 *  phone <-> desktop switches. `remount` re-binds when the element behind the
 *  ref was replaced. */
export function useScrollProgress(ref: RefObject<HTMLElement | null>, hosts?: string, remount?: unknown): void {
  const phone = usePhoneSurfaceMarked();
  useEffect(() => {
    const scroller = ref.current;
    if (!phone || !scroller) return;
    return bindScrollProgress(scroller, hosts);
  }, [phone, ref, hosts, remount]);
}
