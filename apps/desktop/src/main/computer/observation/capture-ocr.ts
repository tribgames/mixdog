/** OCR budgeting and accessibility/OCR merging for one captured frame. */
import { DEFAULT_OCR_MAX_WORDS, MAX_OCR_WORDS, elapsedMs } from '../shared/common';
import { shouldRunCaptureOcr } from '../input/capability-policy';
import { dedupeOcrWords, framePoint, normalizeOcrWords, screenshotInteger, shouldUseOcrFallback } from './analysis';
import type { captureMode, frameElements } from './analysis';
import type { ComputerCommand, ComputerElementRecord, OcrWordRecord, ScreenshotCapture } from '../shared/types';
import type { CaptureEngineHost } from './capture';

type CaptureFrame = NonNullable<ScreenshotCapture['frame']>;
type OcrResponse = Awaited<ReturnType<CaptureEngineHost['callPowerShell']>>;

// Projects OCR boxes from the OCR image space back into capture-frame pixels,
// then drops the words the accessibility elements already cover.
function projectOcrWords(
  ocr: OcrResponse,
  screenshot: ScreenshotCapture,
  frame: CaptureFrame,
  elements: ReturnType<typeof frameElements>,
  remainingElementBudget: number
) {
  const scaleX =
    frame.captureWidth / Number(ocr.result?.image_width || screenshot.ocrImage?.width || frame.captureWidth);
  const scaleY =
    frame.captureHeight / Number(ocr.result?.image_height || screenshot.ocrImage?.height || frame.captureHeight);
  const frameBounds = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY)),
  });
  const projectedWords = normalizeOcrWords(ocr.result?.words).map((word) => ({
    ...word,
    ...frameBounds(word),
    center_x: Math.round(word.center_x * scaleX),
    center_y: Math.round(word.center_y * scaleY),
  }));
  const ocrWords = dedupeOcrWords(projectedWords, elements).slice(0, remainingElementBudget);
  return { frameBounds, ocrWords };
}

// Set-of-marks and state modes list OCR words as clickable Text elements
// after the accessibility marks.
function ocrElementRecord(
  word: OcrWordRecord,
  mark: number,
  frameId: ScreenshotCapture['frameId'],
  observationWindowId: string
): ComputerElementRecord {
  return {
    mark,
    ref: `ocr:${frameId}:${mark}`,
    source: 'ocr',
    role: 'Text',
    name: word.text,
    value: '',
    state: 'ocr',
    enabled: true,
    x: word.x,
    y: word.y,
    width: Math.max(1, word.width),
    height: Math.max(1, word.height),
    center_x: word.center_x,
    center_y: word.center_y,
    actions: ['click', 'double_click', 'mouse_move', 'drag', 'scroll', 'type'],
    frame_id: frameId,
    window_id: observationWindowId || undefined,
  };
}

// Frame-space view of one OCR element: the state view keeps the identity
// fields only; the full view adds its center and screen bounds.
function ocrFrameElement(
  element: ComputerElementRecord,
  mode: ReturnType<typeof captureMode>,
  frame: CaptureFrame
): Record<string, unknown> {
  const bounds: [number, number, number, number] = [element.x, element.y, element.width, element.height];
  if (mode === 'state') {
    return {
      mark: element.mark,
      ref: element.ref,
      source: element.source,
      role: element.role,
      name: element.name,
      state: element.state,
      enabled: element.enabled,
      bounds,
      actions: element.actions,
    };
  }
  const topLeft = framePoint(frame, element.x, element.y);
  return {
    ...element,
    bounds,
    center: [element.center_x, element.center_y],
    screen_bounds: [
      topLeft.x,
      topLeft.y,
      Math.max(1, Math.round((element.width * frame.physicalWidth) / frame.captureWidth)),
      Math.max(1, Math.round((element.height * frame.physicalHeight) / frame.captureHeight)),
    ],
  };
}

function appendOcrElements(input: {
  mode: ReturnType<typeof captureMode>;
  ocrWords: OcrWordRecord[];
  rawElements: ComputerElementRecord[];
  elements: ReturnType<typeof frameElements>;
  frame: CaptureFrame;
  frameId: ScreenshotCapture['frameId'];
  observationWindowId: string;
}): ComputerElementRecord[] {
  const { mode, ocrWords, rawElements, elements, frame, frameId, observationWindowId } = input;
  let nextMark = rawElements.reduce((maximumMark, element) => Math.max(maximumMark, element.mark), 0) + 1;
  const ocrElements = ocrWords.map((word) => {
    const mark = nextMark++;
    return ocrElementRecord(word, mark, frameId, observationWindowId);
  });
  for (const element of ocrElements) elements.push(ocrFrameElement(element, mode, frame));
  return ocrElements;
}

function ocrSkipReason(
  remainingElementBudget: number,
  semanticAccessibilityAvailable: boolean,
  screenshot: ScreenshotCapture | null
): string {
  if (remainingElementBudget <= 0) return 'element_budget_exhausted';
  if (semanticAccessibilityAvailable) return 'semantic_accessibility_available';
  if (screenshot?.pixelUnavailable) return 'pixel_unavailable';
  return 'screenshot_unavailable';
}

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
  }
) {
  const {
    command,
    mode,
    screenshot,
    rawElements,
    elements,
    totalElementBudget,
    semanticAccessibilityAvailable,
    observationWindowId,
    timings,
  } = input;
  const ocrFallbackEnabled = shouldUseOcrFallback(mode, semanticAccessibilityAvailable, command.include_ocr === true);
  const runOcrForCapture = shouldRunCaptureOcr(
    ocrFallbackEnabled,
    semanticAccessibilityAvailable,
    command.include_ocr === true
  );
  const requestedOcrLimit = ocrFallbackEnabled
    ? screenshotInteger(command.max_ocr_words, DEFAULT_OCR_MAX_WORDS, 1, MAX_OCR_WORDS, 'max_ocr_words')
    : 0;
  const reservedOcrBudget =
    runOcrForCapture && screenshot?.image && screenshot.frame
      ? Math.min(requestedOcrLimit, Math.max(1, Math.floor(totalElementBudget / 2)))
      : 0;
  if (reservedOcrBudget > 0 && elements.length > totalElementBudget - reservedOcrBudget) {
    elements.splice(totalElementBudget - reservedOcrBudget);
  }
  const returnedAccessibilityElements = elements.length;
  let ocrPayload: Record<string, unknown> | undefined;
  let ocrElements: ComputerElementRecord[] = [];
  const remainingElementBudget = Math.max(0, totalElementBudget - returnedAccessibilityElements);
  const shouldRunOcr = Boolean(screenshot?.image && screenshot.frame && runOcrForCapture && remainingElementBudget > 0);
  const marksOcr = mode === 'som' || mode === 'state';
  if (shouldRunOcr && screenshot?.image && screenshot.frame) {
    const frame = screenshot.frame;
    const ocrStartedAt = performance.now();
    try {
      const ocr = await host.callPowerShell(
        {
          action: 'ocr_image',
          image_base64: screenshot.ocrImage?.data || screenshot.image.data,
          ocr_language: command.ocr_language ?? null,
          max_ocr_words: Math.min(requestedOcrLimit, remainingElementBudget),
          session_id: host.sessionIdFor(command),
          read_only: true,
        },
        5_000
      );
      if (!ocr.ok) throw new Error(ocr.error || 'Windows OCR failed');
      const { frameBounds, ocrWords } = projectOcrWords(ocr, screenshot, frame, elements, remainingElementBudget);
      if (marksOcr) {
        ocrElements = appendOcrElements({
          mode,
          ocrWords,
          rawElements,
          elements,
          frame,
          frameId: screenshot.frameId,
          observationWindowId,
        });
      }
      const markedWords = marksOcr
        ? ocrWords.map((word, index) => ({ ...word, mark: ocrElements[index]?.mark }))
        : ocrWords;
      ocrPayload = {
        ok: true,
        mode: 'fallback',
        automatic: command.include_ocr !== true,
        language: String(ocr.result?.language || ''),
        lines: Array.isArray(ocr.result?.lines)
          ? ocr.result.lines.map((line) => ({ ...line, ...frameBounds(line) }))
          : [],
        words: markedWords,
        total_words: Number(ocr.result?.total_words) || 0,
        truncated_words: Number(ocr.result?.truncated_words) || 0,
      };
    } catch (error) {
      ocrPayload = { ok: false, error: (error as Error).message || String(error) };
    }
    timings.ocr_ms = elapsedMs(ocrStartedAt);
  } else if (ocrFallbackEnabled) {
    ocrPayload = {
      ok: true,
      mode: 'fallback',
      automatic: command.include_ocr !== true,
      skipped: true,
      reason: ocrSkipReason(remainingElementBudget, semanticAccessibilityAvailable, screenshot),
      lines: [],
      words: [],
      total_words: 0,
      truncated_words: 0,
    };
  }
  return { ocrPayload, ocrElements, returnedAccessibilityElements };
}
