import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveElementAliases } from './element-aliases.ts';
import { elementTargetsFromRecords } from './element-records.ts';

function ocrTargets(frameId) {
  return elementTargetsFromRecords([
    {
      mark: 7,
      ref: `ocr:${frameId}:7`,
      source: 'ocr',
      role: 'Text',
      name: 'ServerManager',
      frame_id: frameId,
      window_id: 'hwnd:0x1',
      center_x: 424,
      center_y: 161,
    },
  ]);
}

test('an OCR ref resolves to the frame point its capture published', () => {
  const resolved = resolveElementAliases(
    { action: 'click', window_id: 'hwnd:0x1', ref: 'ocr:frame-3:7' },
    ocrTargets('frame-3')
  );
  assert.equal(resolved.ref, undefined);
  assert.equal(resolved.frame_id, 'frame-3');
  assert.equal(resolved.window_id, 'hwnd:0x1');
  assert.equal(resolved.x, 424);
  assert.equal(resolved.y, 161);
});

test('an OCR ref from an older frame is refused instead of reusing the mark number', () => {
  assert.throws(
    () => resolveElementAliases({ action: 'click', window_id: 'hwnd:0x1', ref: 'ocr:frame-2:7' }, ocrTargets('frame-3')),
    /stale_element/
  );
});

test('a semantic ref is left untouched', () => {
  const resolved = resolveElementAliases({ action: 'click', window_id: 'hwnd:0x1', ref: 's1:e4' }, ocrTargets('frame-3'));
  assert.equal(resolved.ref, 's1:e4');
  assert.equal(resolved.x, undefined);
});
