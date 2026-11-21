// A CDP client that applies `Emulation.setDeviceMetricsOverride` (clipped
// screenshots do) and dies leaves the renderer frozen at the probe viewport.
// After resize/load the guard compares the inner viewport with the native
// content bounds and, when they stay apart, clears the override and nudges a
// native resize so Chromium re-lays out.
import type { BrowserWindow } from 'electron';

const TOLERANCE_PX = 4;
const CHECK_DELAY_MS = 1_200;
const RECHECK_DELAY_MS = 400;
// A stray override raises no native window event, so a heartbeat re-checks.
const HEARTBEAT_MS = 10_000;

export function installViewportGuard(window: BrowserWindow): void {
  if (process.env.MIXDOG_DISABLE_VIEWPORT_GUARD === '1') return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let repairing = false;

  const mismatch = async (): Promise<boolean> => {
    const [innerWidth, innerHeight] = (await window.webContents.executeJavaScript(
      '[window.innerWidth, window.innerHeight]',
      true
    )) as [number, number];
    const bounds = window.getContentBounds();
    const zoom = window.webContents.getZoomFactor() || 1;
    return (
      Math.abs(innerWidth - bounds.width / zoom) > TOLERANCE_PX ||
      Math.abs(innerHeight - bounds.height / zoom) > TOLERANCE_PX
    );
  };

  const check = async () => {
    timer = null;
    if (repairing || window.isDestroyed()) return;
    try {
      if (!(await mismatch())) return;
      // Debounce transient states (mid-resize, DPI change): only a mismatch
      // that SURVIVES a settle window is a stuck override.
      await new Promise((resolve) => setTimeout(resolve, RECHECK_DELAY_MS));
      if (window.isDestroyed() || !(await mismatch())) return;
      repairing = true;
      const dbg = window.webContents.debugger;
      const attached = dbg.isAttached();
      if (!attached) dbg.attach('1.3');
      try {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride');
      } finally {
        if (!attached) {
          try {
            dbg.detach();
          } catch {
            /* already gone with the page */
          }
        }
      }
      // A 1px native nudge forces a real layout pass even when Chromium
      // believes the size never changed.
      const current = window.getBounds();
      window.setBounds({ ...current, width: current.width - 1 });
      window.setBounds(current);
    } catch {
      // Transient page states (reload, closed devtools target) re-check on
      // the next resize/load signal.
    } finally {
      repairing = false;
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void check(), CHECK_DELAY_MS);
  };
  window.on('resize', schedule);
  window.on('restore', schedule);
  window.on('maximize', schedule);
  window.on('unmaximize', schedule);
  window.webContents.on('did-finish-load', schedule);
  const heartbeat = setInterval(() => void check(), HEARTBEAT_MS);
  window.on('closed', () => {
    if (timer) clearTimeout(timer);
    clearInterval(heartbeat);
  });
  schedule();
}
