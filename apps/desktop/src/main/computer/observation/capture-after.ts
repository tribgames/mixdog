import {
  DEFAULT_CAPTURE_AFTER_DELAY_MS,
  DEFAULT_CAPTURE_MAX_ELEMENTS,
  MAX_CAPTURE_AFTER_DELAY_MS,
} from '../shared/common';
import { screenshotInteger } from './analysis';
import { createCaptureImageDedupStore } from './capture-image-dedup';
import type { createOcrCapturePreferenceStore } from '../input/capability-policy';
import type { ComputerCommand } from '../shared/types';
import type { CaptureEngineHost } from './capture';

export function createCaptureAfter(
  host: Pick<CaptureEngineHost, 'assertExecutionNotAborted' | 'sessionIdFor'>,
  ocrPreferences: ReturnType<typeof createOcrCapturePreferenceStore>,
  captureComputer: (
    command: ComputerCommand,
    forcedWindowId?: string
  ) => Promise<{
    payload: Record<string, unknown>;
    image?: { mimeType: string; data: string };
  }>
) {
  const imageDedup = createCaptureImageDedupStore();
  return async function captureAfterAction(
    command: ComputerCommand,
    windowId: string,
    delayOverrideMs?: number,
    reportedDelayMs?: number
  ): Promise<{ metadata: Record<string, unknown>; image?: { mimeType: string; data: string } }> {
    const delayMs =
      delayOverrideMs ??
      screenshotInteger(
        command.capture_delay_ms,
        DEFAULT_CAPTURE_AFTER_DELAY_MS,
        0,
        MAX_CAPTURE_AFTER_DELAY_MS,
        'capture_delay_ms'
      );
    if (!windowId) {
      return { metadata: { ok: false, error: 'exact target window is unavailable; no screen fallback was captured' } };
    }
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    host.assertExecutionNotAborted();
    try {
      const ocrPreference = ocrPreferences.resolve(host.sessionIdFor(command), {
        includeOcr: command.capture_after_include_ocr,
        ocrLanguage: command.capture_after_ocr_language,
        maxOcrWords: command.capture_after_max_ocr_words,
      });
      const capture = await captureComputer(
        {
          ...command,
          action: 'capture',
          mode: command.capture_after_mode || 'state',
          max_elements: command.capture_after_max_elements || DEFAULT_CAPTURE_MAX_ELEMENTS,
          include_ocr: ocrPreference.includeOcr,
          ocr_language: ocrPreference.ocrLanguage,
          max_ocr_words: ocrPreference.maxOcrWords,
          image_output: command.capture_after_image_output,
          window: undefined,
          window_id: windowId,
          screen: undefined,
          capture_after: false,
        },
        windowId
      );
      host.assertExecutionNotAborted();
      const repeatedImage = capture.image
        ? imageDedup.isRepeat(`${host.sessionIdFor(command)}:${windowId}`, capture.image.data)
        : false;
      return {
        metadata: {
          ...capture.payload,
          delay_ms: reportedDelayMs ?? delayMs,
          verification: 'not_performed',
          // Same pixels as the frame already delivered for this window: the
          // text below is fresh, and the earlier image still describes it.
          ...(repeatedImage ? { image_unchanged: true } : {}),
        },
        ...(capture.image && !repeatedImage ? { image: capture.image } : {}),
      };
    } catch (error) {
      host.assertExecutionNotAborted();
      return { metadata: { ok: false, window_id: windowId, error: (error as Error).message || String(error) } };
    }
  };
}
