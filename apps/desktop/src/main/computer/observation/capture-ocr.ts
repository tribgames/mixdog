/** OCR budgeting and accessibility/OCR merging for one captured frame. */
import { DEFAULT_OCR_MAX_WORDS, MAX_OCR_WORDS, elapsedMs } from '../shared/common';
import { shouldRunCaptureOcr } from '../input/capability-policy';
import { dedupeOcrWords, framePoint, normalizeOcrWords, screenshotInteger, shouldUseOcrFallback } from './analysis';
import type { captureMode, frameElements } from './analysis';
import type { ComputerCommand, ComputerElementRecord, OcrWordRecord, ScreenshotCapture } from '../shared/types';
import type { CaptureEngineHost } from './capture';

export async function mergeCaptureOcr(
  host: Pick<CaptureEngineHost, 'callPowerShell' | 'sessionIdFor'>,
  input: {
    command: ComputerCommand;
    mode: ReturnType<typeof captureMode>;
    screenshot: ScreenshotCapture | null;
    rawElements: ComputerElementRecord[];
    elements: ReturnType<typeof frameElements>;
    totalElementBudget: number;
    semanticAccessibilityAvailable: boolean;
    observationWindowId: string;
    timings: Record<string, number>;
  },
) {
  const { command, mode, screenshot, rawElements, elements, totalElementBudget,
    semanticAccessibilityAvailable, observationWindowId, timings } = input;
  const ocrFallbackEnabled = shouldUseOcrFallback(mode, semanticAccessibilityAvailable, command.include_ocr === true);
  const runOcrForCapture = shouldRunCaptureOcr(ocrFallbackEnabled, semanticAccessibilityAvailable, command.include_ocr === true);
  const requestedOcrLimit = ocrFallbackEnabled
    ? screenshotInteger(command.max_ocr_words, DEFAULT_OCR_MAX_WORDS, 1, MAX_OCR_WORDS, 'max_ocr_words') : 0;
  const reservedOcrBudget = runOcrForCapture && screenshot?.image && screenshot.frame
    ? Math.min(requestedOcrLimit, Math.max(1, Math.floor(totalElementBudget / 2))) : 0;
  if (reservedOcrBudget > 0 && elements.length > totalElementBudget - reservedOcrBudget) {
    elements.splice(totalElementBudget - reservedOcrBudget);
  }
  const returnedAccessibilityElements = elements.length;
  let ocrWords: OcrWordRecord[] = [];
  let ocrPayload: Record<string, unknown> | undefined;
  let ocrElements: ComputerElementRecord[] = [];
  const remainingElementBudget = Math.max(0, totalElementBudget - returnedAccessibilityElements);
  const shouldRunOcr = Boolean(screenshot?.image && screenshot.frame && runOcrForCapture && remainingElementBudget > 0);
  if (shouldRunOcr && screenshot?.image && screenshot.frame) {
    const ocrStartedAt = performance.now();
    try {
      const ocr = await host.callPowerShell({
        action: 'ocr_image', image_base64: screenshot.image.data,
        ocr_language: command.ocr_language ?? null,
        max_ocr_words: Math.min(requestedOcrLimit, remainingElementBudget),
        session_id: host.sessionIdFor(command), read_only: true,
      }, 5_000);
      if (!ocr.ok) throw new Error(ocr.error || 'Windows OCR failed');
      ocrWords = dedupeOcrWords(normalizeOcrWords(ocr.result?.words), elements).slice(0, remainingElementBudget);
      if (mode === 'som' || mode === 'state') {
        let nextMark = rawElements.reduce((maximumMark, element) => Math.max(maximumMark, element.mark), 0) + 1;
        ocrElements = ocrWords.map((word) => {
          const mark = nextMark++;
          return {
            mark, ref: `ocr:${screenshot.frameId}:${mark}`, source: 'ocr', role: 'Text',
            name: word.text, value: '', state: 'ocr', enabled: true,
            x: word.x, y: word.y, width: Math.max(1, word.width), height: Math.max(1, word.height),
            center_x: word.center_x, center_y: word.center_y,
            actions: ['click', 'double_click', 'mouse_move', 'drag', 'scroll', 'type'],
            frame_id: screenshot.frameId, window_id: observationWindowId || undefined,
          };
        });
        for (const element of ocrElements) {
          const topLeft = framePoint(screenshot.frame, element.x, element.y);
          const bottomRight = framePoint(screenshot.frame,
            Math.min(screenshot.frame.captureWidth - 1, element.x + element.width - 1),
            Math.min(screenshot.frame.captureHeight - 1, element.y + element.height - 1));
          const bounds: [number, number, number, number] = [element.x, element.y, element.width, element.height];
          elements.push(mode === 'state' ? {
            mark: element.mark, ref: element.ref, source: element.source,
            role: element.role, name: element.name, state: element.state, enabled: element.enabled,
            bounds, actions: element.actions,
          } : {
            ...element, bounds, center: [element.center_x, element.center_y],
            screen_bounds: [topLeft.x, topLeft.y, Math.max(1, bottomRight.x - topLeft.x + 1),
              Math.max(1, bottomRight.y - topLeft.y + 1)],
          });
        }
      }
      const markedWords = mode === 'som' || mode === 'state'
        ? ocrWords.map((word, index) => ({ ...word, mark: ocrElements[index]?.mark })) : ocrWords;
      ocrPayload = {
        ok: true, mode: 'fallback', automatic: command.include_ocr !== true,
        language: String(ocr.result?.language || ''),
        lines: Array.isArray(ocr.result?.lines) ? ocr.result?.lines : [],
        words: markedWords, total_words: Number(ocr.result?.total_words) || 0,
        truncated_words: Number(ocr.result?.truncated_words) || 0,
      };
    } catch (error) {
      ocrPayload = { ok: false, error: (error as Error).message || String(error) };
    }
    timings.ocr_ms = elapsedMs(ocrStartedAt);
  } else if (ocrFallbackEnabled) {
    ocrPayload = {
      ok: true, mode: 'fallback', automatic: command.include_ocr !== true, skipped: true,
      reason: remainingElementBudget <= 0 ? 'element_budget_exhausted'
        : semanticAccessibilityAvailable ? 'semantic_accessibility_available'
          : screenshot?.pixelUnavailable ? 'pixel_unavailable' : 'screenshot_unavailable',
      lines: [], words: [], total_words: 0, truncated_words: 0,
    };
  }
  return { ocrPayload, ocrElements, returnedAccessibilityElements };
}
