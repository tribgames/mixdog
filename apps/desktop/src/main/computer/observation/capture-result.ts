import type { captureMode, frameElements } from './analysis';
import type { ScreenshotCapture } from '../shared/types';

export function captureResultPayload(input: {
  captureOk: boolean;
  mode: ReturnType<typeof captureMode>;
  screenshot: ScreenshotCapture | null;
  observationWindowId: string;
  requestedWindowId: string;
  generation: unknown;
  totalElements: number;
  ocrElementCount: number;
  returnedAccessibilityElements: number;
  elements: ReturnType<typeof frameElements>;
  visualOnlyCacheHit: boolean;
  accessibilityError: string;
  semanticAccessibilityAvailable: boolean;
  changes?: Record<string, unknown>;
  continuation: unknown;
  ocrPayload?: Record<string, unknown>;
}): Record<string, unknown> {
  const { captureOk, mode, screenshot, observationWindowId, requestedWindowId,
    generation, totalElements, ocrElementCount, returnedAccessibilityElements, elements,
    visualOnlyCacheHit, accessibilityError, semanticAccessibilityAvailable,
    changes, continuation, ocrPayload } = input;
  const truncatedAccessibilityElements = Math.max(0, totalElements - returnedAccessibilityElements);
  return {
    ok: captureOk, action: 'capture', mode,
    coordinate_space: screenshot?.frame ? 'frame' : 'screen',
    ...(screenshot?.route ? { capture_source: screenshot.route } : {}),
    ...(observationWindowId ? { window_id: observationWindowId } : {}),
    ...(requestedWindowId && requestedWindowId !== observationWindowId ? {
      requested_window_id: requestedWindowId, capture_target_reason: 'capturable_owner',
    } : {}),
    ...(generation !== null ? { generation } : {}),
    total_elements: totalElements + ocrElementCount,
    returned_elements: elements.length,
    accessibility_status: mode === 'vision' ? 'not_requested' : visualOnlyCacheHit ? 'visual_only_cached'
      : accessibilityError ? 'error' : semanticAccessibilityAvailable ? 'available' : 'empty',
    ...(visualOnlyCacheHit ? { accessibility_cache: 'visual_only' } : {}),
    ...(accessibilityError ? { accessibility_error: accessibilityError } : {}),
    ...(changes ? { changes } : {}),
    ...(mode !== 'vision' ? { total_accessibility_elements: totalElements } : {}),
    ...(ocrElementCount ? { ocr_elements: ocrElementCount } : {}),
    ...(continuation ? { continuation } : {}),
    ...(truncatedAccessibilityElements ? { truncated_elements: truncatedAccessibilityElements } : {}),
    ...(mode !== 'vision' ? { elements } : {}),
    ...(ocrPayload ? { ocr: ocrPayload } : {}),
    pixel_status: screenshot?.pixelUnavailable ? 'unavailable' : mode === 'ax' ? 'not_requested' : 'available',
    ...(screenshot?.pixelUnavailable ? { pixel_unavailable: screenshot.pixelUnavailable, escalation: 'recapture' } : {}),
  };
}
