/**
 * The last phase of a state capture: publish the actionable targets, build the
 * reply payload, attach the image, and remember the OCR preference. It runs only
 * after the observation was judged consistent.
 */
import { elapsedMs } from '../shared/common';
import type { createOcrCapturePreferenceStore } from '../input/capability-policy';
import { captureResultPayload } from './capture-result';
import { type CaptureBaseline, recordCaptureBaseline } from './capture-baseline';
import { applyFrameImage, persistCaptureImage } from './capture-image-output';
import type { CaptureMode } from './capture-target';
import type { CaptureEngineHost } from './capture';
import type {
  ComputerCommand,
  ComputerElementRecord,
  ComputerInputObservation,
  ScreenshotCapture,
} from '../shared/types';

export type FinishCaptureHost = Pick<
  CaptureEngineHost,
  'sessionIdFor' | 'assertExecutionNotAborted' | 'rememberElementTargets' | 'rememberObservedWindowScope'
>;

export async function finishCapture(
  host: FinishCaptureHost,
  stores: {
    lastCaptureBySession: Map<string, CaptureBaseline>;
    ocrPreferences: ReturnType<typeof createOcrCapturePreferenceStore>;
  },
  state: {
    command: ComputerCommand;
    mode: CaptureMode;
    forcedWindowId?: string;
    replacementRead: boolean;
    captureStartedAt: number;
    timings: Record<string, number>;
    totalElementBudget: number;
    screenshot: ScreenshotCapture | null;
    rawElements: ComputerElementRecord[];
    ocrElements: ComputerElementRecord[];
    elements: Record<string, unknown>[];
    ocrPayload: Record<string, unknown> | undefined;
    returnedAccessibilityElements: number;
    observationWindowId: string;
    requestedWindowId: string;
    generation: unknown;
    continuation: unknown;
    totalElements: number;
    visualOnlyCacheHit: boolean;
    cachedAccessibilityError: unknown;
    accessibilityError: string;
    semanticAccessibilityAvailable: boolean;
    accessibilityRetryAt: number | undefined;
    inputObservation: ComputerInputObservation | undefined;
    foregroundReady: boolean;
    foregroundInputReason?: string;
  }
): Promise<{ payload: Record<string, unknown>; image?: { mimeType: string; data: string } }> {
  const { command, mode, timings, screenshot, observationWindowId, inputObservation } = state;
  const sessionId = host.sessionIdFor(command);
  if (mode !== 'vision') {
    host.rememberElementTargets(command, [...state.rawElements, ...state.ocrElements]);
  }
  const captureOk = !screenshot?.pixelUnavailable || state.returnedAccessibilityElements > 0;
  if (captureOk && observationWindowId) {
    host.rememberObservedWindowScope(
      command,
      observationWindowId,
      screenshot?.frame?.relatedWindowIds || [observationWindowId],
      inputObservation
    );
  }
  const changes =
    // A cached visual-only read never asked the provider for elements, so
    // comparing it to a full baseline would report the whole tree removed.
    mode !== 'vision' && captureOk && !state.visualOnlyCacheHit
      ? recordCaptureBaseline(stores.lastCaptureBySession, sessionId, {
          mode,
          command,
          totalElementBudget: state.totalElementBudget,
          rawElements: state.rawElements,
          observationWindowId,
        })
      : undefined;
  const payload = captureResultPayload({
    captureOk,
    mode,
    screenshot,
    observationWindowId,
    requestedWindowId: state.requestedWindowId,
    generation: state.generation,
    totalElements: state.totalElements,
    ocrElementCount: state.ocrElements.length,
    returnedAccessibilityElements: state.returnedAccessibilityElements,
    elements: state.elements,
    visualOnlyCacheHit: state.visualOnlyCacheHit && !state.cachedAccessibilityError,
    accessibilityError: state.accessibilityError,
    semanticAccessibilityAvailable: state.semanticAccessibilityAvailable,
    changes,
    continuation: state.continuation,
    ocrPayload: state.ocrPayload,
  });
  payload.foreground_input_ready = state.foregroundReady;
  if (state.foregroundInputReason) payload.foreground_input_reason = state.foregroundInputReason;
  if (state.accessibilityRetryAt) {
    payload.accessibility_cache = 'timed_out_provider';
    payload.accessibility_retry_after_ms = Math.max(0, state.accessibilityRetryAt - Date.now());
  }
  if (state.replacementRead) payload.observation_fallback = 'replacement_worker_pixels';
  let image = await applyFrameImage(payload, timings, { command, mode, screenshot, elements: state.elements });
  timings.total_ms = elapsedMs(state.captureStartedAt);
  payload.timings_ms = timings;
  host.assertExecutionNotAborted();
  if (!state.forcedWindowId && captureOk) {
    stores.ocrPreferences.remember(sessionId, {
      includeOcr: command.include_ocr === true,
      ocrLanguage: command.ocr_language,
      maxOcrWords: command.max_ocr_words,
    });
  }
  image = persistCaptureImage(payload, image, { command, sessionId });
  return {
    payload,
    ...(image ? { image } : {}),
  };
}
