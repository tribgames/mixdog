/**
 * How the banner leaves the screen. A command that settles within a few
 * frames would otherwise flash the banner too briefly to read, which the user
 * experiences as never being told at all — so a visible stretch is held to a
 * minimum before the fade begins, and a snapshot that turns visible again
 * cancels the pending hide.
 */
import type { OverlayWindowEntry } from './overlay-windows';

const OVERLAY_FADE_OUT_MS = 180;
const OVERLAY_MIN_VISIBLE_MS = 1_200;

export interface OverlayFadeHost {
  liveEntries(): OverlayWindowEntry[];
  /** Whether the banner should be visible right now. */
  visible(): boolean;
}

export function createOverlayFade(host: OverlayFadeHost) {
  let hideTimer: NodeJS.Timeout | null = null;
  /** When the current visible stretch began; 0 while nothing is shown. */
  let shownAt = 0;

  /** Called when a render will show the banner: cancels a pending hide and
   *  starts the visible stretch if none is running. */
  function keepShown(): void {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (!shownAt) shownAt = Date.now();
  }

  function hideAll(): void {
    if (hideTimer) return;
    const fading = host.liveEntries().filter((entry) => entry.window.isVisible());
    if (fading.length === 0) return;
    const held = shownAt ? Math.max(0, OVERLAY_MIN_VISIBLE_MS - (Date.now() - shownAt)) : 0;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (host.visible()) return;
      shownAt = 0;
      for (const entry of fading) {
        void entry.window.webContents.executeJavaScript('window.mixdogComputerOverlayHide?.()').catch(() => {});
      }
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (host.visible()) return;
        for (const entry of fading) {
          if (!entry.window.isDestroyed()) entry.window.hide();
        }
      }, OVERLAY_FADE_OUT_MS);
    }, held);
  }

  function dispose(): void {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
  }

  return { keepShown, hideAll, dispose };
}
