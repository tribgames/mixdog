import {
  DEFAULT_CAPTURE_AFTER_DELAY_MS,
  DEFAULT_CAPTURE_MAX_ELEMENTS,
  MAX_CAPTURE_AFTER_DELAY_MS,
  sleep,
} from '../shared/common';
import { screenshotInteger } from './analysis';
import { createCaptureImageDedupStore } from './capture-image-dedup';
import { awaitSettledLayout } from './capture-launch-layout';
import type { createOcrCapturePreferenceStore } from '../input/capability-policy';
import type { ComputerCommand } from '../shared/types';
import type { CaptureEngineHost } from './capture';
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

/** An input addressed through a semantic ref is answered by the accessibility
 *  tree it acted through; pixel-targeted or untargeted input and OCR keep the
 *  frame, which is their only evidence. */
function defaultCaptureAfterMode(command: ComputerCommand, includeOcr: boolean): 'ax' | 'state' {
  const first = Array.isArray(command.steps) ? command.steps[0] : command;
  return first?.ref && !includeOcr ? 'ax' : 'state';
}

export function createCaptureAfter(
  host: Pick<CaptureEngineHost, 'assertExecutionNotAborted' | 'sessionIdFor'> &
    Partial<Pick<CaptureEngineHost, 'callPowerShell'>>,
  ocrPreferences: ReturnType<typeof createOcrCapturePreferenceStore>,
  captureComputer: (
    command: ComputerCommand,
    forcedWindowId?: string
  ) => Promise<{
    payload: Record<string, unknown>;
    image?: { mimeType: string; data: string };
  }>,
  /** Owned by the capture engine, which releases a session's entries with the session. */
  imageDedup = createCaptureImageDedupStore()
) {
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
    if (delayMs > 0) await sleep(delayMs);
    host.assertExecutionNotAborted();
    if (command.action === 'launch') await awaitSettledLayout(host, command, windowId);
    try {
      const ocrPreference = ocrPreferences.resolve(host.sessionIdFor(command), {
        includeOcr: command.capture_after_include_ocr,
        ocrLanguage: command.capture_after_ocr_language,
        maxOcrWords: command.capture_after_max_ocr_words,
      });
      const requestedMode = command.capture_after_mode;
      const mode = requestedMode || defaultCaptureAfterMode(command, ocrPreference.includeOcr === true);
      const captureIn = (captureMode: NonNullable<ComputerCommand['capture_after_mode']>) =>
        captureComputer(
          {
            ...command,
            action: 'capture',
            mode: captureMode,
            max_elements: command.capture_after_max_elements || DEFAULT_CAPTURE_MAX_ELEMENTS,
            include_ocr: captureMode === 'ax' ? false : ocrPreference.includeOcr,
            ocr_language: captureMode === 'ax' ? undefined : ocrPreference.ocrLanguage,
            max_ocr_words: captureMode === 'ax' ? undefined : ocrPreference.maxOcrWords,
            image_output: command.capture_after_image_output,
            window: undefined,
            window_id: windowId,
            screen: undefined,
            capture_after: false,
            observation_after: true,
          },
          windowId
        );
      let capture = await captureIn(mode);
      host.assertExecutionNotAborted();
      // A tree that is not usable cannot stand in for pixels the caller never
      // declined, so the default read takes the full observation instead.
      if (!requestedMode && mode === 'ax' && capture.payload.accessibility_status !== 'available') {
        capture = await captureIn('state');
        host.assertExecutionNotAborted();
      }
      const repeatedImage = capture.image
        ? imageDedup.isRepeat(`${host.sessionIdFor(command)}\u0000${windowId}`, capture.image.data)
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
      // User takeover belongs to the command queue, not the ordinary
      // observation-retry path. The input may already have been delivered.
      if (computerErrorCode(error) === 'user_input_active') throw error;
      return { metadata: { ok: false, window_id: windowId, error: (error as Error).message || String(error) } };
    }
  };
}
