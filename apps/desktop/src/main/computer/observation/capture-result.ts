import type { captureMode, frameElements } from './analysis';
import type { ScreenshotCapture } from '../shared/types';

function accessibilityStatus(
  mode: ReturnType<typeof captureMode>,
  visualOnlyCacheHit: boolean,
  accessibilityError: string,
  semanticAccessibilityAvailable: boolean,
  totalElements: number
) {
  if (mode === 'vision') return 'not_requested';
  if (visualOnlyCacheHit) return 'visual_only_cached';
  if (accessibilityError) return 'error';
  if (semanticAccessibilityAvailable) return 'available';
  // Reporting "empty" while handing back a usable tree reads as a provider
  // failure. Chrome without a grounded content surface is its own answer.
  return totalElements > 0 ? 'chrome_only' : 'empty';
}

function pixelStatus(pixelUnavailable: unknown, mode: ReturnType<typeof captureMode>) {
  if (pixelUnavailable) return 'unavailable';
  return mode === 'ax' ? 'not_requested' : 'available';
}

function pixelUnavailableFields(pixelUnavailable: ScreenshotCapture['pixelUnavailable']) {
  if (!pixelUnavailable) return {};
  return {
    pixel_unavailable: pixelUnavailable,
    escalation: pixelUnavailable.reason === 'window_hidden' ? 'focus_window' : 'recapture',
  };
}

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
  const {
    captureOk,
    mode,
    screenshot,
    observationWindowId,
    requestedWindowId,
    generation,
    totalElements,
    ocrElementCount,
    returnedAccessibilityElements,
    elements,
    visualOnlyCacheHit,
    accessibilityError,
    semanticAccessibilityAvailable,
    changes,
    continuation,
    ocrPayload,
  } = input;
  const truncatedAccessibilityElements = Math.max(0, totalElements - returnedAccessibilityElements);
  return {
    ok: captureOk,
    action: 'capture',
    mode,
    coordinate_space: screenshot?.frame ? 'frame' : 'screen',
    ...(screenshot?.route ? { capture_source: screenshot.route } : {}),
    ...(screenshot?.captureAttempts?.length ? { capture_attempts: screenshot.captureAttempts } : {}),
    ...(observationWindowId ? { window_id: observationWindowId } : {}),
    ...(requestedWindowId && requestedWindowId !== observationWindowId
      ? {
          requested_window_id: requestedWindowId,
          capture_target_reason: 'capturable_owner',
        }
      : {}),
    ...(generation !== null ? { generation } : {}),
    total_elements: totalElements + ocrElementCount,
    returned_elements: elements.length,
    accessibility_status: accessibilityStatus(
      mode,
      visualOnlyCacheHit,
      accessibilityError,
      semanticAccessibilityAvailable,
      totalElements
    ),
    ...(visualOnlyCacheHit ? { accessibility_cache: 'visual_only' } : {}),
    ...(accessibilityError ? { accessibility_error: accessibilityError } : {}),
    ...(changes ? { changes } : {}),
    ...(mode !== 'vision' ? { total_accessibility_elements: totalElements } : {}),
    ...(ocrElementCount ? { ocr_elements: ocrElementCount } : {}),
    ...(continuation ? { continuation } : {}),
    ...(truncatedAccessibilityElements ? { truncated_elements: truncatedAccessibilityElements } : {}),
    ...(mode !== 'vision' ? { elements } : {}),
    ...(ocrPayload ? { ocr: ocrPayload } : {}),
    pixel_status: pixelStatus(screenshot?.pixelUnavailable, mode),
    ...pixelUnavailableFields(screenshot?.pixelUnavailable),
  };
}
