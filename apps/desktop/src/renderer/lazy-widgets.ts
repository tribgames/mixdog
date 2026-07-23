import { lazy } from "react";

const importDiffView = () => import("./DiffView.lazy");
const importTerminalPane = () => import("./TerminalPane");

export const DiffView = lazy(importDiffView);
export const TerminalPane = lazy(importTerminalPane);

// First-scroll hitch fix: the DiffView chunk is ~1.7MB — when the first
// edit/diff tool card mounted mid-scroll, the on-demand chunk load+compile
// stalled the main thread for the whole hitch (user: scrolling to the top of
// a session always lags the FIRST time). Warm both lazy chunks during idle
// so scroll-time mounts only pay the render.
let prefetched = false;
export function prefetchLazyWidgets(): void {
  if (prefetched) return;
  prefetched = true;
  const warm = () => {
    void importDiffView().catch(() => { prefetched = false; });
    void importTerminalPane().catch(() => { /* retried on real mount */ });
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => warm(), { timeout: 4_000 });
  } else {
    window.setTimeout(warm, 1_500);
  }
}
