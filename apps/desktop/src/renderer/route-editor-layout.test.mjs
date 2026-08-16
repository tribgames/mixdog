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

test('route panels stay inside an offset pane instead of using the whole window', () => {
  const viewport = { left: 600, top: 200, width: 520, height: 560 };
  const sheet = routeSheetBox(
    { left: 900, right: 1040, top: 680, bottom: 712 },
    116,
    viewport,
  );
  const flyout = routeFlyoutBox(sheet, 0, 380, viewport, 296);

  assert.ok(sheet.left >= 608);
  assert.ok(sheet.left + sheet.width <= 1112);
  assert.ok(flyout.left >= 608);
  assert.ok(flyout.left + flyout.width <= 1112);
  assert.ok(flyout.top >= 208);
  assert.ok(flyout.top + flyout.height <= 752);
});
