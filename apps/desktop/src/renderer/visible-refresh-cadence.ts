export type VisibleRefreshReason = "interval" | "visible";

/** Presentation-only polling. A hidden document owns no interval; returning
 * refreshes once and resumes the cadence. Explicit user calls are unaffected. */
export function startVisibleRefreshCadence({
  win,
  intervalMs,
  refresh,
  onHidden,
}: {
  win: Window;
  intervalMs?: number;
  refresh(reason: VisibleRefreshReason): void;
  onHidden?(): void;
}): () => void {
  const doc = win.document;
  let timer: number | null = null;
  let disposed = false;
  let visible = doc?.visibilityState !== "hidden";
  const stopTimer = (): void => {
    if (timer !== null) win.clearInterval(timer);
    timer = null;
  };
  const hide = (): void => {
    if (disposed) return;
    stopTimer();
    if (visible) onHidden?.();
    visible = false;
  };
  const sync = (): void => {
    if (disposed) return;
    if (doc?.visibilityState === "hidden") { hide(); return; }
    const resumed = !visible;
    visible = true;
    if (timer === null && intervalMs != null && intervalMs > 0) {
      const handle = win.setInterval(() => {
        if (disposed || timer !== handle) return;
        if (doc?.visibilityState === "hidden") { hide(); return; }
        refresh("interval");
      }, intervalMs);
      timer = handle;
    }
    if (resumed) refresh("visible");
  };
  doc?.addEventListener("visibilitychange", sync);
  win.addEventListener("pagehide", hide);
  win.addEventListener("pageshow", sync);
  win.addEventListener("focus", sync);
  sync();
  return () => {
    if (disposed) return;
    disposed = true;
    stopTimer();
    doc?.removeEventListener("visibilitychange", sync);
    win.removeEventListener("pagehide", hide);
    win.removeEventListener("pageshow", sync);
    win.removeEventListener("focus", sync);
  };
}
