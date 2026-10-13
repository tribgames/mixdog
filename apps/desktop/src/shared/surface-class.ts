// Remote web surface classification, shared by the classic boot script
// (i18n:sync prepends this file, transpiled, to public/boot.js) and the
// renderer (mobile-surface.ts), so the first paint and the mounted app pick
// the same phone/desktop layout. No imports: it must run as a plain script.

/** What the classifier reads from the browser. */
export interface SurfaceProbe {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** `(pointer: coarse)` matches. */
  coarsePointer: boolean;
}

/** Tablets (iPad, Android tablets) and split-view/slide-over windows below this
 *  layout width use the phone layout; wider ones get the desktop layout. */
export const SURFACE_TABLET_PHONE_MAX_WIDTH = 640;
/** Unidentified coarse-pointer touch devices follow the usual tablet cut-off. */
export const SURFACE_COARSE_TOUCH_PHONE_MAX_WIDTH = 768;

export function readSurfaceProbe(
  nav: { userAgent?: string; platform?: string; maxTouchPoints?: number },
  win: { matchMedia?: (query: string) => { matches: boolean } }
): SurfaceProbe {
  let coarsePointer = false;
  try {
    coarsePointer = win.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    coarsePointer = false;
  }
  return {
    userAgent: String(nav.userAgent || ''),
    platform: String(nav.platform || ''),
    maxTouchPoints: Number(nav.maxTouchPoints) || 0,
    coarsePointer,
  };
}

/** iPhone, iPod and iPad, including the desktop-class MacIntel iPad UA. */
export function isIosDevice(probe: SurfaceProbe): boolean {
  return /iPad|iPhone|iPod/iu.test(probe.userAgent) || (probe.platform === 'MacIntel' && probe.maxTouchPoints > 1);
}

/** Phones keep the phone layout in both orientations. */
export function isPhoneDevice(probe: SurfaceProbe): boolean {
  return (
    /iPhone|iPod/iu.test(probe.userAgent) || (/Android/iu.test(probe.userAgent) && /Mobile/iu.test(probe.userAgent))
  );
}

/** Device class, independent of layout width: phones, tablets and other
 *  coarse-touch devices (install/entry gates key on this). */
export function isTouchDevice(probe: SurfaceProbe): boolean {
  if (/iPhone|iPod|Android/iu.test(probe.userAgent) || isIosDevice(probe)) return true;
  return probe.maxTouchPoints > 0 && probe.coarsePointer;
}

/** Phone LAYOUT for a layout `width` in CSS px: phones always, tablets and
 *  coarse-touch devices below their cut-off. Touch laptops report a fine
 *  primary pointer and never qualify. */
export function usesPhoneLayout(probe: SurfaceProbe, width: number): boolean {
  if (isPhoneDevice(probe)) return true;
  if (probe.maxTouchPoints <= 0 || !width) return false;
  if (isIosDevice(probe) || /Android/iu.test(probe.userAgent)) return width < SURFACE_TABLET_PHONE_MAX_WIDTH;
  if (!probe.coarsePointer) return false;
  return width < SURFACE_COARSE_TOUCH_PHONE_MAX_WIDTH;
}
