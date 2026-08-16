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

test('route flyout opens on the left side of the sheet aligned to its row', () => {
  const sheet = { left: 700, top: 300, width: 264, height: 116, maxHeight: 116 };
  const box = routeFlyoutBox(sheet, 200, { width: 1000, height: 800 }, 336);

  assert.equal(box.left, 700 - 6 - 264);
  assert.equal(box.width, sheet.width);
  assert.equal(box.top, 336);
  assert.equal(box.height, 200);
  assert.equal(box.placement, 'left');
});

test('route flyout falls to the right side when the left has no room', () => {
  const sheet = { left: 20, top: 300, width: 264, height: 116, maxHeight: 116 };
  const box = routeFlyoutBox(sheet, 200, { width: 1000, height: 800 }, 330);

  assert.equal(box.left, 20 + 264 + 6);
  assert.equal(box.width, sheet.width);
  assert.equal(box.placement, 'right');
});

test('route flyout honors a right-side preference when both sides fit', () => {
  const sheet = { left: 360, top: 300, width: 264, height: 116, maxHeight: 116 };
  const box = routeFlyoutBox(sheet, 200, { width: 1000, height: 800 }, 330, undefined, 'right');

  assert.equal(box.left, 360 + 264 + 6);
  assert.equal(box.placement, 'right');
});

test('route flyout stacks above the sheet when neither side fits', () => {
  const sheet = { left: 8, top: 500, width: 264, height: 116, maxHeight: 116 };
  const box = routeFlyoutBox(sheet, 200, { width: 280, height: 800 }, 520);

  assert.equal(box.left, sheet.left);
  assert.equal(box.width, sheet.width);
  assert.equal(box.top, 294);
  assert.equal(box.placement, 'above');
});

test('route panels stay inside an offset pane instead of using the whole window', () => {
  const viewport = { left: 600, top: 200, width: 520, height: 560 };
  const sheet = routeSheetBox(
    { left: 900, right: 1040, top: 680, bottom: 712 },
    116,
    viewport,
  );
  const flyout = routeFlyoutBox(sheet, 380, viewport);

  assert.ok(sheet.left >= 608);
  assert.ok(sheet.left + sheet.width <= 1112);
  assert.ok(flyout.left >= 608);
  assert.ok(flyout.left + flyout.width <= 1112);
  assert.equal(flyout.width, sheet.width);
  assert.ok(flyout.top >= 208);
  assert.ok(flyout.top + flyout.height <= 752);
});
