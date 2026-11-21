// Overlay scrollbars reserve no column, so the reserve is measured, not assumed, and published as `--mx-scrollbar-gutter`.
const SCROLLBAR_GUTTER_VAR = '--mx-scrollbar-gutter';

/** What the engine actually takes from a scroll container's content box.
 *  0 means overlay scrollbars: nothing is reserved and nothing must be paid. */
function measureScrollbarGutter(): number {
  if (typeof document === 'undefined') return 0;
  const host = document.body ?? document.documentElement;
  if (!host) return 0;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;top:-9999px;left:-9999px;' +
    'width:100px;height:100px;overflow:scroll;visibility:hidden;pointer-events:none';
  probe.setAttribute('aria-hidden', 'true');
  try {
    host.appendChild(probe);
    const gutter = probe.offsetWidth - probe.clientWidth;
    if (!Number.isFinite(gutter) || gutter <= 0) return 0;
    // Fractional device scales produce fractional bars; keep 2 decimals so the
    // compensation lands on the same subpixel the browser used.
    return Math.round(gutter * 100) / 100;
  } catch {
    return 0;
  } finally {
    probe.remove();
  }
}

/** Publishes the measured reserve on the root and keeps it current. */
export function installScrollbarMetrics(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {};
  }
  let frame = 0;
  let applied = '';
  const apply = (): void => {
    const next = `${measureScrollbarGutter()}px`;
    // Writing the variable invalidates layout document-wide, so only a real
    // change is committed.
    if (next === applied) return;
    applied = next;
    document.documentElement.style.setProperty(SCROLLBAR_GUTTER_VAR, next);
  };
  const sync = (): void => {
    if (frame !== 0) return;
    if (typeof window.requestAnimationFrame !== 'function') {
      apply();
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      apply();
    });
  };
  apply();
  // Browser zoom and phone rotation change the reserve; a restored PWA page
  // fires pageshow instead. A plain window resize keeps it: probing on every
  // step of a window drag appended a node to <body> and forced a layout per
  // frame, so a resize re-probes only when the device pixel ratio (zoom)
  // moved.
  let probedRatio = window.devicePixelRatio;
  const onResize = (): void => {
    if (window.devicePixelRatio === probedRatio) return;
    probedRatio = window.devicePixelRatio;
    sync();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', sync);
  window.addEventListener('pageshow', sync);
  return () => {
    if (frame !== 0) window.cancelAnimationFrame?.(frame);
    frame = 0;
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', sync);
    window.removeEventListener('pageshow', sync);
  };
}
