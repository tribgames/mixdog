// A phone body that mounts one frame after its placeholder. On a phone's CPU
// Monaco's first mount is a 100ms+ render and layout; the editor's text cover
// (same box, same text) paints first and the editor mounts in a transition
// right after that paint. Desktop mounts at once. Dock sheet bodies do not
// use it: they mount with the sheet so their content slides in with it.
import { startTransition, useEffect, useState, type ReactNode } from 'react';
import { isMobileRemoteSurface } from './mobile-surface';

export function PhoneDeferredMount({ children, placeholder = null }: { children: ReactNode; placeholder?: ReactNode }) {
  const [mounted, setMounted] = useState(() => !isMobileRemoteSurface());
  useEffect(() => {
    if (mounted) return undefined;
    const frame = window.requestAnimationFrame(() => startTransition(() => setMounted(true)));
    return () => window.cancelAnimationFrame(frame);
  }, [mounted]);
  return mounted ? children : placeholder;
}
