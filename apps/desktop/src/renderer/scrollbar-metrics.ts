// Measured scrollbar RESERVE, published as `--mx-scrollbar-gutter`.
//
// `--mx-scrollbar-size` (8px) is what we PAINT the bar at. Every layout that
// pays for a scrollbar column — the session rail's negative margin, the
// transcript reading column, the settings/studio right padding, the SCM dock
// gutter — used that same static token as if the engine always reserved it.
// It does not: overlay scrollbars (phone browsers, and any engine that ignores
// ::-webkit-scrollbar sizing) reserve NOTHING, so each of those compensations
// shifted its scroller content by a full 8px while the chrome outside the
// scroller stayed put. In the session rail that split the "+" button from the
// unread dots and spinners directly under it (user: 세션 리스트 + 버튼이랑
// 아래 닷이 가로로 틀어짐).
//
// So the reserve is measured instead of assumed, once before the first paint
// and again whenever zoom/rotation could change it.
const SCROLLBAR_GUTTER_VAR = "--mx-scrollbar-gutter";

/** What the engine actually takes from a scroll container's content box.
 *  0 means overlay scrollbars: nothing is reserved and nothing must be paid. */
export function measureScrollbarGutter(): number {
  if (typeof document === "undefined") return 0;
  const host = document.body ?? document.documentElement;
  if (!host) return 0;
  const probe = document.createElement("div");
  // `overflow: scroll` (not auto) forces the decision even with no content:
  // a classic bar takes its column, an overlay bar leaves clientWidth alone.
  // The probe inherits the shared ::-webkit-scrollbar sizing, so it measures
  // OUR bar, not the platform default.
  probe.style.cssText = "position:absolute;top:-9999px;left:-9999px;"
    + "width:100px;height:100px;overflow:scroll;visibility:hidden;pointer-events:none";
  probe.setAttribute("aria-hidden", "true");
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
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  let frame = 0;
  let applied = "";
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
    if (typeof window.requestAnimationFrame !== "function") {
      apply();
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      apply();
    });
  };
  apply();
  // Browser zoom, phone rotation, and OS scrollbar-preference changes all
  // surface as a resize; a restored PWA page fires pageshow instead.
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  window.addEventListener("pageshow", sync);
  return () => {
    if (frame !== 0) window.cancelAnimationFrame?.(frame);
    frame = 0;
    window.removeEventListener("resize", sync);
    window.removeEventListener("orientationchange", sync);
    window.removeEventListener("pageshow", sync);
  };
}
