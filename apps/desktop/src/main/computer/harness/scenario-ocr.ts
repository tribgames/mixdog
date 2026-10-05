import assert from 'node:assert/strict';
import type { CommandResult, CapturePayload } from './scenario-types';

export function capturePayload(result: CommandResult): CapturePayload {
  return JSON.parse(result.text) as CapturePayload;
}

export function actionPayload(result: CommandResult): Record<string, unknown> {
  return JSON.parse(result.text) as Record<string, unknown>;
}

export function ocrText(payload: CapturePayload): string {
  return [
    ...(payload.ocr?.lines || []).map((line) => (typeof line === 'string' ? line : String(line.text || ''))),
    ...(payload.ocr?.words || []).map((word) => String(word.text || '')),
  ]
    .join(' ')
    .toLocaleUpperCase();
}

export function ocrConfusableKey(value: string): string {
  return value.toLocaleUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/\s+/g, '');
}

/** A mode that returns marks publishes each OCR word as an element and omits
 *  the duplicate word list, so the mark is read from whichever the capture
 *  actually carried. */
export function ocrMarkCandidates(payload: CapturePayload): Array<{ text: string; mark?: number }> {
  const words = (payload.ocr?.words || []).map((candidate) => ({
    text: String(candidate.text || ''),
    mark: candidate.mark,
  }));
  const elements = (payload.elements || [])
    .filter((element) => String((element as Record<string, unknown>).source || '') === 'ocr')
    .map((element) => ({
      text: String((element as Record<string, unknown>).name || ''),
      mark: Number((element as Record<string, unknown>).mark),
    }));
  return [...words, ...elements];
}

export function ocrMark(payload: CapturePayload, token: string): number {
  const normalized = token.toLocaleUpperCase();
  const candidates = ocrMarkCandidates(payload);
  const word =
    candidates.find((candidate) => candidate.text.toLocaleUpperCase() === normalized) ||
    candidates.find((candidate) => candidate.text.toLocaleUpperCase().includes(normalized));
  assert.ok(
    Number.isInteger(word?.mark),
    // Where the pixels came from is the first question when OCR reads nothing.
    `missing actionable OCR mark for ${token}: ${ocrText(payload)} ` +
      JSON.stringify({
        capture_source: payload.capture_source,
        window_id: payload.window_id,
        size: [payload.width, payload.height],
        pixel_status: payload.pixel_status,
        ocr: payload.ocr,
        elements: payload.elements,
      })
  );
  return Number(word?.mark);
}
