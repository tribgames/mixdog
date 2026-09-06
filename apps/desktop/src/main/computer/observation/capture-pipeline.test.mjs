import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCaptureOcr } from './capture-ocr.ts';
import { createCaptureAfter } from './capture-after.ts';
import { createOcrCapturePreferenceStore } from '../input/capability-policy.ts';

test('OCR merging preserves frame-bound marks while sharing the total element budget', async () => {
  const requests = [];
  const elements = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  const result = await mergeCaptureOcr({
    sessionIdFor: () => 'test',
    callPowerShell: async (request) => {
      requests.push(request);
      return { ok: true, result: {
        language: 'ko', words: [
          { text: 'alpha', x: 50, y: 50, width: 10, height: 10, center_x: 55, center_y: 55 },
          { text: 'beta', x: 70, y: 70, width: 10, height: 10, center_x: 75, center_y: 75 },
        ], lines: ['alpha beta'], total_words: 2,
      } };
    },
  }, {
    command: { action: 'capture', include_ocr: true, ocr_language: 'ko' }, mode: 'state',
    screenshot: {
      frameId: 'frame-1', image: { mimeType: 'image/png', data: 'fixture' },
      frame: { originX: 0, originY: 0, physicalWidth: 200, physicalHeight: 200, captureWidth: 100, captureHeight: 100 },
    },
    rawElements: [{ mark: 3 }], elements, totalElementBudget: 4,
    semanticAccessibilityAvailable: true, observationWindowId: 'hwnd:0x1', timings: {},
  });
  assert.equal(requests[0].max_ocr_words, 2);
  assert.equal(requests[0].ocr_language, 'ko');
  assert.equal(result.returnedAccessibilityElements, 2);
  assert.equal(elements.length, 4);
  assert.deepEqual(result.ocrElements.map((element) => [element.mark, element.ref, element.window_id]),
    [[4, 'ocr:frame-1:4', 'hwnd:0x1'], [5, 'ocr:frame-1:5', 'hwnd:0x1']]);
});

test('post-action observation preserves target, OCR preference, and failure recovery', async () => {
  const preferences = createOcrCapturePreferenceStore();
  preferences.remember('test', { includeOcr: true, ocrLanguage: 'ko' });
  const requests = [];
  const captureAfter = createCaptureAfter({
    sessionIdFor: () => 'test', assertExecutionNotAborted() {},
  }, preferences, async (command, target) => {
    requests.push({ command, target });
    throw new Error('fixture capture unavailable');
  });
  const result = await captureAfter({ action: 'key', screen: 1 }, 'hwnd:0x1', 0, 120);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].target, 'hwnd:0x1');
  assert.equal(requests[0].command.screen, undefined);
  assert.equal(requests[0].command.include_ocr, true);
  assert.equal(requests[0].command.ocr_language, 'ko');
  assert.equal(result.metadata.ok, false);
  assert.equal(result.metadata.window_id, 'hwnd:0x1');
  assert.match(result.metadata.error, /fixture capture unavailable/);
});
