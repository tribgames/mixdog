import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeCaptureOcr } from './capture-ocr.ts';

test('OCR reads lossless pixels and maps words, lines and click targets into the delivered frame', async () => {
  for (const recognizedWidth of [2000, 1000]) {
    const ratio = recognizedWidth / 2000;
    const elements = [];
    const result = await mergeCaptureOcr(
      {
        sessionIdFor: () => 'ocr-resolution',
        callPowerShell: async (request) => {
          assert.equal(request.image_base64, 'lossless-native-pixels');
          return {
            ok: true,
            result: {
              language: 'ko',
              image_width: recognizedWidth,
              image_height: recognizedWidth / 2,
              words: [
                {
                  text: 'MainCanvas',
                  line: 0,
                  x: 300 * ratio,
                  y: 200 * ratio,
                  width: 100 * ratio,
                  height: 40 * ratio,
                  center_x: 350 * ratio,
                  center_y: 220 * ratio,
                },
              ],
              lines: [
                { text: 'MainCanvas', line: 0, x: 300 * ratio, y: 200 * ratio, width: 100 * ratio, height: 40 * ratio },
              ],
              total_words: 1,
            },
          };
        },
      },
      {
        command: { action: 'capture' },
        mode: 'som',
        rawElements: [],
        elements,
        totalElementBudget: 80,
        semanticAccessibilityAvailable: false,
        observationWindowId: 'hwnd:0x1',
        timings: {},
        screenshot: {
          description: 'fixture',
          image: { mimeType: 'image/jpeg', data: 'compressed-model-image' },
          ocrImage: { data: 'lossless-native-pixels', width: 2000, height: 1000 },
          frameId: 'frame-1',
          frame: {
            captureWidth: 1000,
            captureHeight: 500,
            physicalWidth: 2000,
            physicalHeight: 1000,
            originX: 2560,
            originY: -489,
          },
        },
      }
    );
    assert.deepEqual(elements[0].bounds, [150, 100, 50, 20]);
    assert.deepEqual(elements[0].screen_bounds, [2860, -289, 100, 40]);
    assert.equal(result.ocrElements[0].center_x, 175);
    assert.equal(result.ocrElements[0].center_y, 110);
    assert.deepEqual(result.ocrPayload.lines[0], {
      text: 'MainCanvas',
      line: 0,
      x: 150,
      y: 100,
      width: 50,
      height: 20,
    });
    // A marked word is returned as an element, so the payload never repeats it.
    assert.equal(result.ocrElements[0].name, 'MainCanvas');
    assert.equal(result.ocrPayload.words, undefined);
  }
});

test('a narrowed read of a window without accessibility returns only what it asked for', async () => {
  const host = {
    sessionIdFor: () => 'ocr-filter',
    callPowerShell: async () => ({
      ok: true,
      result: {
        language: 'en',
        image_width: 400,
        image_height: 200,
        words: [
          { text: 'Console', line: 0, x: 0, y: 0, width: 80, height: 20, center_x: 40, center_y: 10 },
          { text: 'Inspector', line: 1, x: 0, y: 40, width: 90, height: 20, center_x: 45, center_y: 50 },
        ],
        lines: [
          { text: 'Console', line: 0, x: 0, y: 0, width: 80, height: 20 },
          { text: 'Inspector', line: 1, x: 0, y: 40, width: 90, height: 20 },
        ],
        total_words: 2,
      },
    }),
  };
  const read = async (command) => {
    const elements = [];
    const result = await mergeCaptureOcr(host, {
      command: { action: 'capture', ...command },
      mode: 'som',
      rawElements: [],
      elements,
      totalElementBudget: 80,
      semanticAccessibilityAvailable: false,
      observationWindowId: 'hwnd:0x1',
      timings: {},
      screenshot: {
        description: 'fixture',
        image: { mimeType: 'image/jpeg', data: 'model-image' },
        ocrImage: { data: 'native-pixels', width: 400, height: 200 },
        frameId: 'frame-1',
        frame: {
          captureWidth: 400,
          captureHeight: 200,
          physicalWidth: 400,
          physicalHeight: 200,
          originX: 0,
          originY: 0,
        },
      },
    });
    return result;
  };
  // Accessibility is unavailable, so the frame is recognized; the query narrows
  // the recognized text instead of handing back the whole window.
  const narrowed = await read({ query: 'console' });
  assert.deepEqual(
    narrowed.ocrElements.map((element) => element.name),
    ['Console']
  );
  assert.deepEqual(
    narrowed.ocrPayload.lines.map((line) => line.text),
    ['Console']
  );
  // Pixels can only answer for static text, never for a control role.
  const byRole = await read({ role: 'Button' });
  assert.deepEqual(byRole.ocrElements, []);
  assert.deepEqual(byRole.ocrPayload.lines, []);
});
