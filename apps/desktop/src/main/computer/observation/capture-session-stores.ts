/**
 * The per-session caches captures learn from — the visual-only capability of a
 * window, the OCR preference, the last frame delivered per target, the last
 * working capture backend per window, and OCR results per frame — and how a
 * released session forgets all of them.
 */
import { createOcrCapturePreferenceStore } from '../input/capability-policy';
import { createCaptureBackendMemory } from './capture-backend-memory';
import { createCaptureImageDedupStore } from './capture-image-dedup';
import { createOcrResultCache } from './capture-ocr';
import { createVisualOnlyCache } from './capture-visual-only';

export function createCaptureSessionStores() {
  const visualOnly = createVisualOnlyCache();
  const ocrPreferences = createOcrCapturePreferenceStore();
  const imageDedup = createCaptureImageDedupStore();
  const backendMemory = createCaptureBackendMemory();
  const ocrCache = createOcrResultCache();

  function releaseCaptureSession(sessionId: string): void {
    ocrPreferences.release(sessionId);
    visualOnly.releasePrefix(`${sessionId}\u0000`);
    imageDedup.releasePrefix(`${sessionId}\u0000`);
    backendMemory.releasePrefix(`${sessionId}\u0000`);
    ocrCache.releasePrefix(`${sessionId}\u0000`);
  }

  return { visualOnly, ocrPreferences, imageDedup, backendMemory, ocrCache, releaseCaptureSession };
}
