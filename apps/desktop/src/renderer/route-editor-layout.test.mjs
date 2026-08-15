import assert from 'node:assert/strict';
import test from 'node:test';

import { routeFlyoutBox, routeSheetBox } from './route-editor-logic.ts';

test('route sheet aligns its right edge with the trigger', () => {
  const box = routeSheetBox(
    { left: 420, right: 520, top: 700, bottom: 732 },
    116,
    { width: 800, height: 800 },
  );

  assert.equal(box.left + box.width, 520);
});

test('route flyout prefers the right and aligns to the selected row', () => {
  const sheet = { left: 200, top: 100, width: 264, height: 116, maxHeight: 116 };
  const box = routeFlyoutBox(sheet, 1, 80, { width: 1000, height: 800 });

  assert.equal(box.left, 470);
  assert.equal(box.top, 140);
});

test('route flyout falls back to the left only when the right side is too narrow', () => {
  const sheet = { left: 700, top: 100, width: 264, height: 116, maxHeight: 116 };
  const box = routeFlyoutBox(sheet, 0, 380, { width: 1000, height: 800 });

  assert.equal(box.left + box.width, 694);
  assert.equal(box.top, 104);
});

test('route flyout stacks above the sheet when both sides are too narrow', () => {
  const sheet = { left: 8, top: 400, width: 264, height: 116, maxHeight: 116 };
  const box = routeFlyoutBox(sheet, 0, 380, { width: 280, height: 800 });

  assert.equal(box.left, 8);
  assert.equal(box.top, 14);
  assert.equal(box.height, 380);
});
