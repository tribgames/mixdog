import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const { restore } = installTestDom(null, { html: '<!doctype html><html><body></body></html>' });
after(restore);
const { positionRowMenu } = await import('./row-menu-geometry.ts');

const area = { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
const anchor = (top, extra = {}) => ({
  bounds: { left: 900, right: 924, top, bottom: top + 24, width: 24, height: 24 },
  area,
  rowHeight: 32,
  inset: 6,
  atPointer: false,
  ...extra,
});
const viewportWidth = () => document.documentElement.clientWidth || window.innerWidth;

test('a row ⋯ menu opens below its glyph with the right edges aligned', () => {
  const style = positionRowMenu(anchor(100), 3, 0, 1000, 800);
  assert.equal(style.top, 100 + 24 + 6);
  assert.equal(style.right, viewportWidth() - 924);
  assert.equal(style.left, undefined);
  assert.equal(style.bottom, undefined);
});

test('a row ⋯ menu near the bottom flips above, still right-aligned', () => {
  const style = positionRowMenu(anchor(760), 3, 0, 1000, 800);
  assert.equal(style.top, undefined);
  assert.ok(style.bottom > 0);
  assert.equal(style.right, viewportWidth() - 924);
});

test('a right-pinned row ⋯ menu in a narrow pane may only grow to the pane left inset', () => {
  const narrow = { left: 850, top: 0, right: 1000, bottom: 800, width: 150, height: 800 };
  const style = positionRowMenu(anchor(100, { area: narrow }), 3, 0, 1000, 800);
  assert.equal(style.right, viewportWidth() - 924);
  assert.equal(style.maxWidth, 924 - 850 - 8);
});

test('the dock ⋯ menu may only grow to its pane left inset', async () => {
  const { dockMenuPlacement } = await import('./pane-dock-chrome.tsx');
  const bounds = { left: 850, top: 0, right: 1000, bottom: 800, width: 150, height: 800 };
  const style = dockMenuPlacement(
    { left: 900, right: 924, top: 100, bottom: 124 },
    { width: 1000, height: 800 },
    [],
    bounds
  );
  assert.equal(style.right, viewportWidth() - 924);
  assert.equal(style.maxWidth, 924 - 850 - 8);
});

test('a measured right-pinned menu wider than its room (CSS min-width) yields to the room', async () => {
  const { clampOverlayIntoView } = await import('./anchored-panel.ts');
  const menu = document.createElement('div');
  menu.style.right = '76px';
  menu.style.maxWidth = '66px';
  // min-width: 200px beats max-width in CSS: the box measures 200px wide.
  menu.getBoundingClientRect = () => ({ left: 724, right: 924, top: 130, bottom: 230, width: 200, height: 100 });
  clampOverlayIntoView(menu);
  assert.equal(menu.style.minWidth, '66px');
  assert.equal(menu.style.maxWidth, '66px');
});

test('a right-click menu still opens at the pointer', () => {
  const style = positionRowMenu(
    anchor(0, { atPointer: true, bounds: { left: 300, right: 300, top: 200, bottom: 200, width: 0, height: 0 } }),
    3,
    0,
    1000,
    800
  );
  assert.equal(style.left, 300);
  assert.equal(style.top, 204);
});
