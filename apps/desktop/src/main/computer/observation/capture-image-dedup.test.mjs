import assert from 'node:assert/strict';
import test from 'node:test';
import { createCaptureImageDedupStore } from './capture-image-dedup.ts';
import { createCaptureAfter } from './capture-after.ts';

test('only an identical frame for the same target counts as a repeat', () => {
  const store = createCaptureImageDedupStore();
  assert.equal(store.isRepeat('s1:hwnd:0x1', 'AAAA'), false);
  assert.equal(store.isRepeat('s1:hwnd:0x1', 'AAAA'), true);
  assert.equal(store.isRepeat('s1:hwnd:0x1', 'BBBB'), false);
  assert.equal(store.isRepeat('s1:hwnd:0x2', 'BBBB'), false);
  store.forget('s1:hwnd:0x1');
  assert.equal(store.isRepeat('s1:hwnd:0x1', 'BBBB'), false);
});

test('a follow-up capture of an unchanged screen keeps its text and drops the duplicate image', async () => {
  const host = { assertExecutionNotAborted() {}, sessionIdFor: () => 's1' };
  const ocrPreferences = { resolve: () => ({ includeOcr: false }) };
  let captures = 0;
  const captureAfter = createCaptureAfter(host, ocrPreferences, async () => {
    captures += 1;
    return {
      payload: { ok: true, elements: captures },
      image: { mimeType: 'image/jpeg', data: 'SAME-PIXELS' },
    };
  });
  const command = { action: 'click', session_id: 's1' };
  const first = await captureAfter(command, 'hwnd:0x1', 0);
  assert.equal(first.image.data, 'SAME-PIXELS');
  assert.equal(first.metadata.image_unchanged, undefined);

  const second = await captureAfter(command, 'hwnd:0x1', 0);
  assert.equal(second.image, undefined);
  assert.equal(second.metadata.image_unchanged, true);
  // The text metadata is still a fresh read, not a replay.
  assert.equal(second.metadata.elements, 2);
});
