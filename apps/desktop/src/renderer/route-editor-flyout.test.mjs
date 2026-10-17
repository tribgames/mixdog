import assert from 'node:assert/strict';
import test from 'node:test';

import { routeDrillBox, routeFlyoutBox, routeFlyoutFit, routePanelStyle, routeSheetBox } from './route-editor-logic.ts';

const viewport = { left: 0, top: 0, width: 1400, height: 900 };

test('the composer route sheet opens above its pill, left edges aligned', () => {
  const pill = { left: 100, right: 260, top: 800, bottom: 828 };
  const box = routeSheetBox(pill, 120, viewport, 224, 'above', 'start');
  assert.equal(box.placement, 'above');
  assert.equal(box.top, 800 - 6 - 120);
  assert.equal(box.left, 100);
});

test('a dialog field sheet opens below its field, right edges aligned, even with room above', () => {
  const field = { left: 900, right: 1100, top: 400, bottom: 432 };
  const box = routeSheetBox(field, 120, viewport, 224, 'below', 'end');
  assert.equal(box.placement, 'below');
  assert.equal(box.top, 432 + 6);
  assert.equal(box.left + box.width, 1100);
});

test('a dialog field sheet flips above only when below cannot hold it and above is roomier', () => {
  const field = { left: 900, right: 1100, top: 820, bottom: 852 };
  const box = routeSheetBox(field, 120, viewport, 224, 'below', 'end');
  assert.equal(box.placement, 'above');
  assert.equal(box.top + box.height, 820 - 6);
});

test('a flyout is as tall as its content up to the cap, aligned with its row', () => {
  const sheet = { left: 400, top: 200, width: 224, height: 200, maxHeight: 200, placement: 'below' };
  const short = routeFlyoutBox(sheet, 360, viewport, 236, 280, 'right', 90);
  assert.equal(short.placement, 'right');
  assert.equal(short.left, 400 + 224 + 6);
  assert.equal(short.top, 236);
  assert.equal(short.height, 90);
  assert.equal(short.maxHeight, 360);
  // The flyout's height is left to its content; max-height carries the cap.
  assert.deepEqual(routePanelStyle(short), { left: 630, top: 236, width: 280, maxHeight: 360 });
  const long = routeFlyoutBox(sheet, 360, viewport, 236, 280, 'right', 2000);
  assert.equal(long.height, 360);
  assert.equal(long.top, 236);
});

test('a flyout beside an above-opened sheet stays inside the band above the sheet bottom', () => {
  const sheet = { left: 400, top: 8, width: 224, height: 56, maxHeight: 56, placement: 'above' };
  const box = routeFlyoutBox(sheet, 360, viewport, 20, 280, 'right');
  assert.equal(box.top, 8);
  assert.equal(box.height, 56);
  assert.equal(box.maxHeight, 56);
  assert.ok(box.top + box.height <= 64);
});

test('a drilled pane never takes more than the real room, even under one row', () => {
  const tiny = { left: 0, top: 0, width: 400, height: 30 };
  const sheet = { left: 10, top: 8, width: 224, height: 12, maxHeight: 12, placement: 'above' };
  const box = routeDrillBox(sheet, 200, tiny);
  assert.equal(box.height, 12);
  assert.equal(box.top, 8);
});

test('a measured flyout is shifted up only as far as the bounds require', () => {
  const sheet = { left: 400, top: 500, width: 224, height: 300, maxHeight: 300, placement: 'below' };
  // Placed at its cap first: 360px from a row at 700 would cross the bottom inset.
  const capped = routeFlyoutBox(sheet, 360, viewport, 700, 280, 'right');
  assert.equal(capped.top, 900 - 8 - 360);
  // Its content is only 100px tall: it goes back to its row.
  const fitted = routeFlyoutFit(capped, 100);
  assert.equal(fitted.top, 700);
  assert.equal(fitted.height, 100);
  assert.equal(routeFlyoutFit(fitted, 100), fitted, 'a stable measure is a no-op');
  assert.equal(routeFlyoutFit(capped, 250).top, 900 - 8 - 250);
});

test('composer model flyout: the full list ends at the sheet bottom, a filtered list goes back on its row', () => {
  // The composer sheet opened above its pill (as measured in the dev app).
  const sheet = { left: 463, top: 660, width: 224, height: 152, maxHeight: 152, placement: 'above' };
  // Placed while the sheet still runs its opening morph, the row reads low (760).
  const opened = routeFlyoutBox(sheet, 360, viewport, 760, 280, 'right');
  // First measure re-reads the settled row (664): the full list is bottom-constrained.
  const full = routeFlyoutFit(opened, 360, 664);
  assert.equal(full.height, 360);
  assert.equal(full.top + full.height, 812);
  // Filtered down to 124px: it returns to its row instead of hugging the bottom.
  const filtered = routeFlyoutFit(full, 124, 664);
  assert.equal(filtered.top, 664);
  assert.equal(filtered.height, 124);
  // Even without a fresh row read, the corrected anchor is remembered.
  assert.equal(routeFlyoutFit(full, 124).top, 664);
  // Growing again shifts up only as far as the sheet bottom requires.
  assert.equal(routeFlyoutFit(filtered, 229, 664).top, 812 - 229);
});

test('a flyout opens on the left only when the right side lacks room', () => {
  const sheet = { left: 1100, top: 200, width: 224, height: 200, maxHeight: 200, placement: 'below' };
  const box = routeFlyoutBox(sheet, 360, viewport, 236, 280, 'right', 90);
  assert.equal(box.placement, 'left');
  assert.equal(box.left + box.width, 1100 - 6);
});

test('a sized stack fallback keeps its explicit height', () => {
  const box = { left: 0, top: 0, width: 100, height: 50, maxHeight: 50, placement: 'below' };
  assert.equal(routePanelStyle(box).height, 50);
});

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
