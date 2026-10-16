import assert from 'node:assert/strict';
import test from 'node:test';

import { routeFlyoutBox } from './route-editor-logic.ts';

const viewport = { left: 0, top: 0, width: 1400, height: 900 };

test('a submenu from a low row of a sheet above the pill grows up from the sheet bottom', () => {
  const sheet = { left: 400, top: 560, width: 224, height: 200, maxHeight: 200, placement: 'above' };
  const box = routeFlyoutBox(sheet, 120, viewport, 704, undefined, 'right');
  assert.equal(box.placement, 'right');
  assert.equal(box.top + box.height, sheet.top + sheet.height);
});

test('a submenu from a high row keeps the row top', () => {
  const sheet = { left: 400, top: 560, width: 224, height: 200, maxHeight: 200, placement: 'above' };
  assert.equal(routeFlyoutBox(sheet, 120, viewport, 570, undefined, 'right').top, 570);
});

test('a sheet below its pill keeps the row-top placement down to the viewport edge', () => {
  const sheet = { left: 400, top: 100, width: 224, height: 200, maxHeight: 200, placement: 'below' };
  assert.equal(routeFlyoutBox(sheet, 120, viewport, 250, undefined, 'right').top, 250);
});
