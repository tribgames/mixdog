/**
 * The per-session caches captures learn from — the visual-only capability of a
 * window, the OCR preference, and the last frame delivered per target — and how
 * a released session forgets all of them.
 */
import { createOcrCapturePreferenceStore } from '../input/capability-policy';
import { createCaptureImageDedupStore } from './capture-image-dedup';
import { createVisualOnlyCache } from './capture-visual-only';

export function createCaptureSessionStores() {
  const visualOnly = createVisualOnlyCache();
  const ocrPreferences = createOcrCapturePreferenceStore();
  const imageDedup = createCaptureImageDedupStore();

  function releaseCaptureSession(sessionId: string): void {
    ocrPreferences.release(sessionId);
    visualOnly.releasePrefix(`${sessionId}\u0000`);
    imageDedup.releasePrefix(`${sessionId}\u0000`);
  }

  return { visualOnly, ocrPreferences, imageDedup, releaseCaptureSession };
}
