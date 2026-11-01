import assert from 'node:assert/strict';
import test from 'node:test';
import { createOcrResultCache, mergeCaptureOcr } from './capture-ocr.ts';

const WORD = { text: 'MainCanvas', line: 0, x: 10, y: 10, width: 100, height: 20, center_x: 60, center_y: 20 };

function fixture() {
  const calls = [];
  const host = {
    sessionIdFor: (command) => command.session_id || 's1',
    callPowerShell: async (request) => {
      calls.push(request);
      if (request.image_base64 === 'broken') return { ok: false, error: 'ocr engine unavailable' };
      return {
        ok: true,
        result: {
          language: 'en',
          image_width: 400,
          image_height: 200,
          words: [{ ...WORD, text: `${WORD.text}-${request.image_base64}` }],
          lines: [],
          total_words: 1,
        },
      };
    },
  };
  const read = (ocrCache, pixels, extra = {}) =>
    mergeCaptureOcr(host, {
      command: { action: 'capture', ...extra },
      mode: 'som',
      rawElements: [],
      elements: [],
      totalElementBudget: 80,
      semanticAccessibilityAvailable: false,
      observationWindowId: 'hwnd:0x1',
      timings: {},
      ocrCache,
      screenshot: {
        description: 'fixture',
        image: { mimeType: 'image/jpeg', data: 'model-image' },
        ocrImage: { data: pixels, width: 400, height: 200 },
        frameId: 'frame-1',
        frame: { captureWidth: 400, captureHeight: 200, physicalWidth: 400, physicalHeight: 200, originX: 0, originY: 0 },
      },
    });
  return { calls, read };
}

test('an unchanged frame reuses its recognition, projected afresh for the new read', async () => {
  const { calls, read } = fixture();
  const cache = createOcrResultCache();
  const first = await read(cache, 'pixels-a');
  const second = await read(cache, 'pixels-a', { query: 'maincanvas' });
  assert.equal(calls.length, 1, 'the identical frame is recognized once');
  assert.equal(second.ocrElements[0].name, 'MainCanvas-pixels-a');
  assert.deepEqual(second.ocrElements[0].name, first.ocrElements[0].name);
  // The query narrows the cached words per read, never the cached reply.
  const narrowed = await read(cache, 'pixels-a', { query: 'absent' });
  assert.deepEqual(narrowed.ocrElements, []);
  assert.equal(calls.length, 1);
});

test('a changed frame, language, limit or session is recognized again', async () => {
  const { calls, read } = fixture();
  const cache = createOcrResultCache();
  await read(cache, 'pixels-a');
  await read(cache, 'pixels-b');
  await read(cache, 'pixels-a', { ocr_language: 'ko' });
  await read(cache, 'pixels-a', { max_ocr_words: 5 });
  await read(cache, 'pixels-a', { session_id: 's2' });
  assert.equal(calls.length, 5);
  await read(cache, 'pixels-a');
  assert.equal(calls.length, 5, 'the original request is still cached');
});

test('the cache is bounded, evicting the least recently used frame', async () => {
  const { calls, read } = fixture();
  const cache = createOcrResultCache(2);
  await read(cache, 'pixels-a');
  await read(cache, 'pixels-b');
  await read(cache, 'pixels-a'); // refreshes a, so b is the oldest
  await read(cache, 'pixels-c'); // evicts b
  assert.equal(calls.length, 3);
  await read(cache, 'pixels-a');
  assert.equal(calls.length, 3, 'the recently used frame survived');
  await read(cache, 'pixels-b');
  assert.equal(calls.length, 4, 'the evicted frame is recognized again');
});

test('a failed recognition is reported and never cached, and a released session forgets its frames', async () => {
  const { calls, read } = fixture();
  const cache = createOcrResultCache();
  const failed = await read(cache, 'broken');
  assert.equal(failed.ocrPayload.ok, false);
  await read(cache, 'broken');
  assert.equal(calls.length, 2);

  await read(cache, 'pixels-a');
  cache.releasePrefix('s1\u0000');
  await read(cache, 'pixels-a');
  assert.equal(calls.length, 4);
});

test('without a cache every read recognizes', async () => {
  const { calls, read } = fixture();
  await read(undefined, 'pixels-a');
  await read(undefined, 'pixels-a');
  assert.equal(calls.length, 2);
});
