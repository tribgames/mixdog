// A phone sheet body that mounts one frame after the sheet. On a phone's CPU a
// pane's first mount (a Files tree, the Visualize frame, Monaco) is a 100ms+
// render and layout; mounted inside the tap's own commit, it held the sheet's
// first frame back, so the tap looked dead and the slide started late. The
// placeholder (same box as the body) paints with the sheet, and the body
// mounts in a transition right after that paint. Desktop mounts at once.
import { startTransition, useEffect, useState, type ReactNode } from 'react';
import { isMobileRemoteSurface } from './mobile-surface';

/** Phone sheet body gate: false until the sheet has painted and started its
 *  slide (two frames after the open), then true for good. A body that was
 *  already mounted while the dock was closed (prewarm) stays ready. Desktop is
 *  always ready. */
export function usePhoneSheetBodyReady(open: boolean, bodyMounted: boolean): boolean {
  const [ready, setReady] = useState(() => !isMobileRemoteSurface());
  useEffect(() => {
    if (ready) return undefined;
    if (bodyMounted && !open) {
      setReady(true);
      return undefined;
    }
    if (!open) return undefined;
    let inner = 0;
    const outer = window.requestAnimationFrame(() => {
      inner = window.requestAnimationFrame(() => startTransition(() => setReady(true)));
    });
    return () => {
      window.cancelAnimationFrame(outer);
      window.cancelAnimationFrame(inner);
    };
  }, [ready, open, bodyMounted]);
  return ready;
}

export function PhoneDeferredMount({ children, placeholder = null }: { children: ReactNode; placeholder?: ReactNode }) {
  const [mounted, setMounted] = useState(() => !isMobileRemoteSurface());
  useEffect(() => {
    if (mounted) return undefined;
    const frame = window.requestAnimationFrame(() => startTransition(() => setMounted(true)));
    return () => window.cancelAnimationFrame(frame);
  }, [mounted]);
  return mounted ? children : placeholder;
}
